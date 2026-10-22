// エラー応答（09_api/common.md:57-81 の共通の形 { error: { code, message, details?, requestId } }。SO §2.11、AS §2.1・§4.1）
// コードは cross-check §4.4 の表（使わない別名 WRONG_TOKEN・BAD_ORIGIN・BAD_CONTENT_TYPE・CASE_ALREADY_REMOVED・
// GUEST_CAPACITY・GUEST_IP_LIMIT・USER_CASE_LIMIT・USER_BAD_DAY_LIMIT・422 の BUDGET_EXCEEDED は持たない）。
// §4.4 は観点どうしで割れたものを1つにした表で、割れていない 500 INTERNAL_ERROR（09:123・AS §3.0 の 14）と、
// AS §4.1 の ASK_ALREADY_FINISHED・CHECK_ITEM_NOT_CHECKABLE（AS T-59・UI が使う。§4.4 に別名として挙がっていない）は行がないので足した【決定：platform】
// HTTP の状態はコードから決まる（09:72-81「競合 409・業務前提 422・停止中 423・回数上限 429」）。スタック・理由の内訳は応答に出さない

import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { REQUEST_ID_HEADER, loggerOf, requestIdOf, silentLogger, type Logger } from "./log.ts";

/** コード → HTTP の状態 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401, // 入口のトークン違いも（M-55）
  CSRF_TOKEN_INVALID: 403,
  ORIGIN_MISMATCH: 403,
  FORBIDDEN: 403, // 内部の呼び出し元の拒否も（理由は返さない：SO §3.9、I-20）
  NOT_FOUND: 404, // 別のワークスペースのものも
  APPROVAL_NOT_PENDING: 409,
  INTENT_CHANGED: 409,
  TASK_ALREADY_TERMINATED: 409,
  TASK_HALTED: 409, // details { haltReason }
  INTENT_NOT_UNKNOWN: 409,
  ASK_NOT_WAITING: 409,
  ASK_ALREADY_FINISHED: 409,
  CHECK_ITEM_NOT_CHECKABLE: 409,
  PROPOSAL_NOT_PENDING: 409,
  CHANGE_NOT_PENDING: 409,
  TASK_NOT_RUNNABLE: 409, // details { requeued? }
  TOOL_CHANGED: 409,
  PACK_ALREADY_INSTALLED: 409, // パック（D-116）は1つのワークスペースに1回だけ
  WORKSPACE_IN_USE: 409, // 担当の作業場を最初に戻す操作：その担当の動いているタスクが作業場を開いている
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RULE_NOT_ALLOWED: 422, // details { failedConditions?, reason? }
  NOT_IN_CATALOG: 422, // details { nearest, line, candidateId }
  PROPOSAL_NOT_NARROW: 422, // details { classification }
  AGENT_SCHEMA_INVALID: 422,
  AGENT_EXCEEDS_POLICY: 422,
  AGENT_LIMIT_REACHED: 422, // details { limit }（エージェントは20体まで：A-81）
  KILL_SWITCH_ENGAGED: 423,
  RATE_LIMITED: 429, // LLM Proxy の毎分60回だけ（§4.4）
  DAILY_BUDGET_EXCEEDED: 429, // details { scope: "global" } ＋ Retry-After
  USER_CASE_DAILY_LIMIT: 429, // details { limit: 5 }
  INTERNAL_ERROR: 500,
  LLM_UPSTREAM_ERROR: 502,
  SETUP_REQUIRED: 503, // details { missing: string[] }（名前だけ：D-47）
} as const;

export type ApiErrorCode = keyof typeof ERROR_STATUS;
export type ErrorStatus = (typeof ERROR_STATUS)[ApiErrorCode];

export const API_ERROR_CODES = Object.keys(ERROR_STATUS) as ApiErrorCode[];

export function isApiErrorCode(v: unknown): v is ApiErrorCode {
  return typeof v === "string" && Object.hasOwn(ERROR_STATUS, v);
}

/** 既定の文（開発者向け。画面は code ごとの文を出す：09:70） */
export const DEFAULT_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  VALIDATION_ERROR: "入力内容に誤りがあります",
  UNAUTHORIZED: "認証されていません",
  CSRF_TOKEN_INVALID: "CSRF トークンがないか、一致しません",
  ORIGIN_MISMATCH: "別のオリジンからの要求は受け付けません",
  FORBIDDEN: "この操作は許可されていません",
  NOT_FOUND: "見つかりません",
  APPROVAL_NOT_PENDING: "承認はすでに決定済みか、期限切れです",
  INTENT_CHANGED: "Intent の内容が変わりました",
  TASK_ALREADY_TERMINATED: "タスクはすでに終了しています",
  TASK_HALTED: "タスクは停止・終了しました",
  INTENT_NOT_UNKNOWN: "結果が不明な Intent ではありません",
  ASK_NOT_WAITING: "依頼は答えを待っていません",
  ASK_ALREADY_FINISHED: "依頼はすでに終わっています",
  CHECK_ITEM_NOT_CHECKABLE: "この行はチェックできません",
  PROPOSAL_NOT_PENDING: "提案はすでに適用済みか、古くなっています",
  CHANGE_NOT_PENDING: "設定の変更は確認待ちではありません",
  TASK_NOT_RUNNABLE: "タスクを実行できる状態ではありません",
  TOOL_CHANGED: "ツールの定義が変わりました",
  PACK_ALREADY_INSTALLED: "このパックはもう入っています",
  WORKSPACE_IN_USE: "この担当の作業場は動いているタスクが使っています",
  PAYLOAD_TOO_LARGE: "本文が大きすぎます",
  UNSUPPORTED_MEDIA_TYPE: "本文は application/json で送ってください",
  RULE_NOT_ALLOWED: "このルールは作れません",
  NOT_IN_CATALOG: "障害のカタログに当てはまりません",
  PROPOSAL_NOT_NARROW: "狭める変更ではありません",
  AGENT_SCHEMA_INVALID: "エージェントの定義がスキーマに合いません",
  AGENT_EXCEEDS_POLICY: "エージェントの定義がポリシーより緩いです",
  AGENT_LIMIT_REACHED: "エージェントの数が上限に達しています",
  KILL_SWITCH_ENGAGED: "Kill Switch が発動中です",
  RATE_LIMITED: "回数の上限を超えました",
  DAILY_BUDGET_EXCEEDED: "今日の予算を使い切りました",
  USER_CASE_DAILY_LIMIT: "今日の追加の上限に達しました",
  INTERNAL_ERROR: "内部エラーが発生しました",
  LLM_UPSTREAM_ERROR: "LLM の呼び出しに失敗しました",
  SETUP_REQUIRED: "準備中です（必要な設定が足りません）",
};

/** 09 の共通の形 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** 形は code ごと（AS §4.1）。VALIDATION_ERROR は Array<{ field, reason }>。無ければキーごと省く */
    details?: unknown;
    requestId: string;
  };
}

/** VALIDATION_ERROR の details の1件（AS §2.1） */
export interface ValidationIssue {
  field: string;
  reason: string;
}

export interface AppErrorOptions {
  details?: unknown;
  /** 応答に足すヘッダー（例：429 の Retry-After） */
  headers?: Record<string, string>;
  cause?: unknown;
}

/** 処理の中で投げ、errorHandler が共通の形の応答にする */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: ErrorStatus;
  readonly details: unknown;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(code: ApiErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? DEFAULT_ERROR_MESSAGES[code], options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorBody(code: ApiErrorCode, message: string, requestId: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details !== undefined ? { details } : {}), requestId } };
}

/**
 * 共通の形の JSON 応答を作る（ミドルウェアから return する用。bodyLimit の onError など）。
 * requestId は文脈から（なければ作る）。X-Request-Id も付ける
 */
export function errorResponse(c: Context, error: AppError | ApiErrorCode, options: Omit<AppErrorOptions, "cause"> & { message?: string } = {}): Response {
  const err = typeof error === "string" ? new AppError(error, options.message, options) : error;
  const requestId = requestIdOf(c);
  const headers: Record<string, string> = { ...(err.headers ?? {}), [REQUEST_ID_HEADER]: requestId };
  return c.json(errorBody(err.code, err.message, requestId, err.details), err.status, headers);
}

/** 400 VALIDATION_ERROR（details = [{ field, reason }]） */
export function validationError(issues: readonly ValidationIssue[], message?: string): AppError {
  return new AppError("VALIDATION_ERROR", message, { details: issues });
}

/** 503 SETUP_REQUIRED（details.missing は名前だけ。D-47） */
export function setupRequired(missing: readonly string[]): AppError {
  return new AppError("SETUP_REQUIRED", undefined, { details: { missing: [...missing] } });
}

const pathText = (path: readonly PropertyKey[]): string => path.map((p) => (typeof p === "symbol" ? String(p.description ?? "") : String(p))).join(".");

/**
 * Zod の issue を VALIDATION_ERROR の details にする。field は「a.b.0」の形（根は ""）。
 * 知らないキー（z.strictObject）はキーごとに1件。値（input）は入れない（秘密が混ざりうるため）
 */
export function zodIssuesToDetails(issues: readonly z.core.$ZodIssue[]): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) out.push({ field: pathText([...issue.path, key]), reason: "unrecognized_key" });
    } else {
      out.push({ field: pathText(issue.path), reason: issue.message });
    }
  }
  return out;
}

/** スキーマで検証し、外れたら AppError(VALIDATION_ERROR) を投げる（AS §3.0 の 10） */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw validationError(zodIssuesToDetails(r.error.issues));
}

/** 本文を JSON として読む。読めなければ AppError(VALIDATION_ERROR) */
export async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw validationError([{ field: "", reason: "本文を JSON として読めません" }]);
  }
}

// Hono の HTTPException（bodyLimit の既定の 413 など）の状態 → コード
const STATUS_TO_CODE: Readonly<Record<number, ApiErrorCode>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "RATE_LIMITED",
};

export interface ErrorHandlerOptions {
  /** 文脈に Logger がないときに使う */
  logger?: Logger;
  /** apps の独自の例外を AppError に直す（返さなければ 500） */
  mapError?: (err: unknown) => AppError | undefined;
}

/**
 * app.onError に渡す。AppError はそのまま、HTTPException は状態からコードへ、それ以外は 500 INTERNAL_ERROR
 * （スタック・メッセージは応答に出さず、マスクしたログにだけ出す。AS §3.0 の 14）
 */
export function errorHandler(options: ErrorHandlerOptions = {}): ErrorHandler {
  return (err, c) => {
    const log = loggerOf(c, options.logger ?? silentLogger);
    let appError: AppError | undefined = err instanceof AppError ? err : options.mapError?.(err);
    if (appError === undefined && err instanceof HTTPException) {
      const code = STATUS_TO_CODE[err.status];
      if (code !== undefined) appError = new AppError(code);
    }
    if (appError !== undefined) {
      if (appError.status >= 500) {
        log.warn("http.error", appError.message, { code: appError.code, status: appError.status, method: c.req.method, path: c.req.path });
      }
      return errorResponse(c, appError);
    }
    log.error("http.error", "処理されなかった例外", { code: "INTERNAL_ERROR", status: 500, method: c.req.method, path: c.req.path, error: err });
    return errorResponse(c, "INTERNAL_ERROR");
  };
}

/** app.notFound に渡す（index.html ではなく 404 の JSON：SO §3.3、E2E SO-INT-06） */
export function notFoundHandler(): NotFoundHandler {
  return (c) => errorResponse(c, "NOT_FOUND");
}
