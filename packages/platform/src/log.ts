// 構造化ログ（security-ops-deploy.md §2.10・§3.17、NFR-032）。Cloud Run の標準出力に1行1JSON（Cloud Logging が jsonPayload にする）。
// 必須のキー（severity・message・service・event・requestId・workspaceId・taskId）は値がなくても null で出す。
// 出す前にすべての値をマスクする（mask.ts）。プロンプト・応答・リクエストの本文・トークンは呼び出し側も渡さない（SO §3.17 の 3・4）。
// リクエスト ID のミドルウェアもここ（X-Request-Id。09_api/common.md:52、SO §3.3 の 2）

import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { RequestVariables } from "./context.ts";
import { SESSION_COOKIE, knownSecretsFromEnv, redact } from "./mask.ts";

export type LogSeverity = "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL" | "ALERT" | "EMERGENCY";

/** ログを出すサービス（SO §2.1 の ServiceName） */
export type ServiceName = "app" | "gateway" | "sim-world" | "gcal" | "github";

/** Cloud Logging の相関 ID のキー（Should。15:533） */
export const TRACE_KEY = "logging.googleapis.com/trace";

/** 呼び出し側が渡す1件。event は機械で数える名前（例 internal_auth.denied） */
export interface LogInput {
  severity: LogSeverity;
  event: string;
  message: string;
  requestId?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  /** 15:459「タスク ID・Intent ID で横断検索」 */
  intentId?: string | null;
  rehearsalRunId?: string | null;
  [k: string]: unknown;
}

/** 実際に出る1行（マスク済み） */
export interface LogRecord {
  severity: LogSeverity;
  message: string;
  service: ServiceName;
  event: string;
  requestId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  intentId?: string | null;
  rehearsalRunId?: string | null;
  commit?: string;
  [TRACE_KEY]?: string;
  [k: string]: unknown;
}

/** child で全部の行に足す文脈 */
export interface LogContext {
  requestId?: string | null;
  workspaceId?: string | null;
  taskId?: string | null;
  intentId?: string | null;
  rehearsalRunId?: string | null;
  /** `projects/<PROJECT_ID>/traces/<TRACE_ID>` */
  trace?: string | null;
}

export interface Logger {
  log(entry: LogInput): void;
  debug(event: string, message: string, fields?: LogFields): void;
  info(event: string, message: string, fields?: LogFields): void;
  warn(event: string, message: string, fields?: LogFields): void;
  error(event: string, message: string, fields?: LogFields): void;
  /** 文脈（requestId など）と、マスクする既知の値（リクエストのトークンなど）を足した Logger */
  child(context: LogContext, secrets?: readonly string[]): Logger;
}

export type LogFields = Omit<LogInput, "severity" | "event" | "message">;

export interface LoggerOptions {
  service: ServiceName;
  /** COMMIT_SHA（デプロイ版と main の照合：15:67） */
  commit?: string;
  /** マスクする既知の値。省くと knownSecretsFromEnv(process.env)（環境変数の秘密を自動で隠す：NFR-032） */
  secrets?: readonly string[];
  /** 1行を書く先（既定は標準出力） */
  write?: (line: string) => void;
}

const STANDARD_KEYS = new Set(["severity", "message", "service", "event", "requestId", "workspaceId", "taskId", "intentId", "rehearsalRunId", "commit", TRACE_KEY]);

const SEVERITIES: ReadonlySet<string> = new Set<LogSeverity>(["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"]);

function buildRecord(service: ServiceName, commit: string | undefined, ctx: LogContext, entry: LogInput): Record<string, unknown> {
  const pick = <K extends keyof LogContext & keyof LogInput>(k: K): string | null | undefined => {
    const v = entry[k];
    return v !== undefined ? (v as string | null) : ctx[k];
  };
  const record: Record<string, unknown> = {
    severity: SEVERITIES.has(entry.severity) ? entry.severity : "DEFAULT",
    message: typeof entry.message === "string" ? entry.message : String(entry.message),
    service,
    event: entry.event,
    requestId: pick("requestId") ?? null,
    workspaceId: pick("workspaceId") ?? null,
    taskId: pick("taskId") ?? null,
  };
  const intentId = pick("intentId");
  if (intentId !== undefined) record.intentId = intentId;
  const rehearsalRunId = pick("rehearsalRunId");
  if (rehearsalRunId !== undefined) record.rehearsalRunId = rehearsalRunId;
  if (commit) record.commit = commit;
  if (ctx.trace) record[TRACE_KEY] = ctx.trace;
  for (const [k, v] of Object.entries(entry)) {
    if (!STANDARD_KEYS.has(k) && v !== undefined) record[k] = v;
  }
  return record;
}

function makeLogger(opts: Required<Pick<LoggerOptions, "service" | "write">> & { commit: string | undefined; secrets: readonly string[] }, ctx: LogContext): Logger {
  const log = (entry: LogInput): void => {
    // ログは処理を止めない（書けなければ最小の1行に落とす）
    let line: string;
    try {
      line = JSON.stringify(redact(buildRecord(opts.service, opts.commit, ctx, entry), opts.secrets));
    } catch {
      line = JSON.stringify({ severity: "ERROR", message: "ログを組み立てられなかった", service: opts.service, event: "log.failed", requestId: null, workspaceId: null, taskId: null });
    }
    try {
      opts.write(line);
    } catch {
      // 書き先が壊れていても呼び出し側には投げない
    }
  };
  const at =
    (severity: LogSeverity) =>
    (event: string, message: string, fields: LogFields = {}): void =>
      log({ ...fields, severity, event, message });
  return {
    log,
    debug: at("DEBUG"),
    info: at("INFO"),
    warn: at("WARNING"),
    error: at("ERROR"),
    child: (context, secrets = []) => {
      const merged: LogContext = { ...ctx };
      for (const [k, v] of Object.entries(context) as Array<[keyof LogContext, string | null | undefined]>) {
        if (v !== undefined) merged[k] = v;
      }
      return makeLogger({ ...opts, secrets: [...opts.secrets, ...secrets] }, merged);
    },
  };
}

export function createLogger(options: LoggerOptions): Logger {
  return makeLogger(
    {
      service: options.service,
      commit: options.commit,
      secrets: options.secrets ?? knownSecretsFromEnv(process.env),
      write: options.write ?? ((line) => void process.stdout.write(`${line}\n`)),
    },
    {},
  );
}

/** 何も出さない（試験・既定） */
export const silentLogger: Logger = (() => {
  const noop = (): void => {};
  const self: Logger = { log: noop, debug: noop, info: noop, warn: noop, error: noop, child: () => self };
  return self;
})();

/** 出した行をためる Logger（試験用。records は JSON を読み直したもの＝マスク済みの実際の出力） */
export function memoryLogger(options: { service?: ServiceName; commit?: string; secrets?: readonly string[] } = {}): {
  logger: Logger;
  lines: string[];
  records: LogRecord[];
} {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  const logger = createLogger({
    service: options.service ?? "app",
    secrets: options.secrets ?? [],
    ...(options.commit !== undefined ? { commit: options.commit } : {}),
    write: (line) => {
      lines.push(line);
      records.push(JSON.parse(line) as LogRecord);
    },
  });
  return { logger, lines, records };
}

// ---- リクエスト ID ----

export const REQUEST_ID_HEADER = "x-request-id";

/** 受け入れる X-Request-Id の形（内部のサービスで引き継ぐとき。ログに出すので記号を絞る） */
export const REQUEST_ID_PATTERN = /^[\w.:-]{1,128}$/;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "req_" ＋ ULID（時刻48ビット＋乱数80ビット。api-surface.md §2.1 のおすすめ） */
export function newRequestId(nowMs: number = Date.now()): string {
  let t = Math.max(0, Math.floor(nowMs));
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (const b of bytes) rand += CROCKFORD.charAt(b & 31);
  return `req_${time}${rand}`;
}

/**
 * Cloud Logging の trace（Should：SO §3.17 の 5）。X-Cloud-Trace-Context（TRACE_ID/SPAN_ID;o=1）か traceparent から読む。
 * 読めなければ null
 */
export function traceOf(headers: Headers, projectId: string): string | null {
  const fromCloud = /^([0-9a-f]{32})(?:\/|;|$)/i.exec(headers.get("x-cloud-trace-context") ?? "")?.[1];
  const fromW3c = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(headers.get("traceparent") ?? "")?.[1];
  const id = fromCloud ?? fromW3c;
  if (!id || /^0+$/.test(id)) return null;
  return `projects/${projectId}/traces/${id.toLowerCase()}`;
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** そのリクエストでマスクする値（Cookie ot_session・X-Task-Token・X-CSRF-Token・Bearer。SO §3.17 の 2） */
export function requestSecretsOf(headers: Headers): string[] {
  const values = [
    cookieValue(headers.get("cookie"), SESSION_COOKIE),
    headers.get("x-task-token"),
    headers.get("x-csrf-token"),
    /^Bearer[ ]+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1] ?? null,
  ];
  return values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
}

export interface RequestContextOptions {
  logger: Logger;
  /**
   * 来た X-Request-Id を使う（形が合うときだけ）。内部のサービス（gateway・sim-world）で呼び出し元とログをつなぐとき。
   * 既定は false：毎回サーバーで作る（app の公開の入口：SO §3.3 の 2）
   */
  acceptIncoming?: boolean;
  newRequestId?: () => string;
  /** Cloud Logging の trace を付けるときのプロジェクト ID（GOOGLE_CLOUD_PROJECT） */
  traceProjectId?: string;
  /** 1リクエスト1行の http.request（メソッド・パス・状態・時間。クエリは出さない） */
  accessLog?: boolean;
}

/**
 * リクエスト ID とリクエストの Logger を文脈に載せ、応答に X-Request-Id を付けるミドルウェア。
 * Logger には requestId（と trace）を付け、Cookie・タスクのトークン・CSRF・Bearer の値をマスクの既知の値に足す
 */
export function requestContext(options: RequestContextOptions): MiddlewareHandler<{ Variables: RequestVariables }> {
  const makeId = options.newRequestId ?? (() => newRequestId());
  return async (c, next) => {
    const given = c.req.header(REQUEST_ID_HEADER);
    const requestId = options.acceptIncoming && given !== undefined && REQUEST_ID_PATTERN.test(given) ? given : makeId();
    const trace = options.traceProjectId ? traceOf(c.req.raw.headers, options.traceProjectId) : null;
    const log = options.logger.child({ requestId, ...(trace ? { trace } : {}) }, requestSecretsOf(c.req.raw.headers));
    c.set("requestId", requestId);
    c.set("log", log);
    const started = performance.now();
    try {
      await next();
    } finally {
      try {
        c.res.headers.set(REQUEST_ID_HEADER, requestId);
      } catch {
        // 変えられない応答の頭はそのまま
      }
      if (options.accessLog) {
        const status = c.res.status;
        log.log({
          severity: status >= 500 ? "WARNING" : "INFO",
          event: "http.request",
          message: `${c.req.method} ${c.req.path} ${status}`,
          method: c.req.method,
          path: c.req.path,
          status,
          latencyMs: Math.round(performance.now() - started),
        });
      }
    }
  };
}

/** 文脈のリクエスト ID（ミドルウェアがなければ作って載せる） */
export function requestIdOf(c: Context): string {
  const v = (c as Context<{ Variables: Partial<RequestVariables> }>).get("requestId");
  if (typeof v === "string" && v !== "") return v;
  const id = newRequestId();
  (c as Context<{ Variables: Partial<RequestVariables> }>).set("requestId", id);
  return id;
}

/** 文脈の Logger（なければ fallback） */
export function loggerOf(c: Context, fallback: Logger = silentLogger): Logger {
  const v = (c as Context<{ Variables: Partial<RequestVariables> }>).get("log");
  return v ?? fallback;
}
