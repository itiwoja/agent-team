// MCP のクライアント（@modelcontextprotocol/sdk の Client ＋ StreamableHTTPClientTransport。MT D-43）。
// 1回の処理（読み取り・実行・同期）ごとにつないで（initialize）、tools/list・tools/call をして閉じる。
// HTTP は差し込める fetch を包み、要求ごとに「送ったか・どの状態コードが返ったか・ネットワークのどの段で失敗したか」を記録する。
// 書き込みの結果の分け方（IA §3.12 の4 の表、BR-59・D-18）はこの記録から決める：
// - tools/call を送る前の失敗（つなげない・initialize・tools/list の失敗、tools/call の名前解決・接続拒否・TLS）→ 送信前（再試行してよい）
// - tools/call を送ったあとのタイムアウト・接続断・5xx（sim-world の 504・503 も）→ 結果不明（再試行しない）
// - 401・403 → 認証の失敗、JSON-RPC のエラー・3xx・ほかの 4xx（応答が返った）→ ツールのエラー（IA §8-12）
// リダイレクトは追わない（redirect: "manual"。許可した URL から別のホストへ飛ばされない：MT D-11・BD-12）

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Json } from "@open-team/kernel";

/** tools/call の上限（A-86） */
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** initialize・tools/list の上限（文書にない。送信前の確認なので短くする） */
export const MCP_LIST_TIMEOUT_MS = 15_000;
/** tools/list のページの上限（nextCursor が終わらないサーバーで止まらないように） */
const MAX_LIST_PAGES = 20;

export const MCP_CLIENT_INFO = { name: "open-team-gateway", version: "0.1.0" } as const;

export interface McpTarget {
  url: string;
  /** 呼び出し元の証明（ID トークン・共有トークン）と sim-world の X-OT-* */
  headers: Record<string, string>;
  /** この呼び出しだけの秘密（Google のアクセストークン）。応答の結果のマスクに足す（ログには出さない） */
  secrets?: readonly string[];
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Json;
  annotations: Json | null;
}

/** HTTP の1回の記録 */
interface FetchRecord {
  /** JSON-RPC の method（GET の SSE などは null） */
  method: string | null;
  status: number | null;
  /** fetch が投げた（応答が来なかった） */
  error: unknown;
  /** application/json の応答の中身が result か error か */
  rpc: "result" | "error" | null;
}

/** ネットワークの失敗のうち「まだ送っていない」と言えるもの（名前解決・接続拒否・届かない・接続の時間切れ・TLS） */
const PRESEND_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENETDOWN",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** 投げられた値（undici の TypeError('fetch failed', { cause })）からエラーコードを掘る */
export function networkCodeOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur !== null && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    const errors = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      cur = errors[0];
      continue;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** 送信前の失敗か（TLS の失敗は ERR_SSL_・ERR_TLS_ も）。分からないものは送信後に倒す（二重送信を避ける：BR-59） */
export function isPresendNetworkError(e: unknown): boolean {
  const code = networkCodeOf(e);
  if (code !== null) return PRESEND_CODES.has(code) || code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_");
  // fetch の仕様で接続の前に断る URL（危ないポートなど）
  const cause = (e as { cause?: { message?: unknown } } | null)?.cause;
  return typeof cause?.message === "string" && cause.message === "bad port";
}

function rpcMethodOf(body: unknown): string | null {
  if (typeof body !== "string") return null;
  try {
    const m = JSON.parse(body) as { method?: unknown };
    return typeof m.method === "string" ? m.method : null;
  } catch {
    return null;
  }
}

/** 記録つきの fetch（SDK の transport に渡す） */
function tracingFetch(base: typeof fetch, records: FetchRecord[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const rec: FetchRecord = { method: rpcMethodOf(init?.body), status: null, error: null, rpc: null };
    records.push(rec);
    let res: Response;
    try {
      res = await base(input, { ...init, redirect: "manual" });
    } catch (e) {
      rec.error = e ?? new Error("fetch failed");
      throw e;
    }
    rec.status = res.status;
    if (rec.method !== null && res.ok && (res.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      try {
        const body = (await res.clone().json()) as { error?: unknown; result?: unknown };
        rec.rpc = body !== null && typeof body === "object" && "error" in body ? "error" : "result";
      } catch {
        // 読めない応答は SDK が投げる
      }
    }
    return res;
  }) as typeof fetch;
}

/** つなぐ・tools/list の失敗 */
export type McpFailure =
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "timeout" }
  | { kind: "network"; presend: boolean; code: string | null }
  | { kind: "http"; status: number }
  | { kind: "rpc_error"; code: number | null }
  | { kind: "protocol"; message: string };

/** tools/call の結果（IA §3.12 の McpCallOutcome） */
export type CallOutcome =
  | { kind: "ok"; result: CallToolResult }
  | { kind: "is_error"; result: CallToolResult }
  /** 名前解決・接続拒否・TLS（tools/call を送っていない） */
  | { kind: "presend_failure"; detail: string }
  | { kind: "auth_error"; status: 401 | 403 }
  /** 送信後のタイムアウト・接続断・5xx */
  | { kind: "postsend_unknown"; detail: string }
  /** 応答は返ったがツールの結果でない（JSON-RPC のエラー・3xx・ほかの 4xx） */
  | { kind: "tool_error"; detail: string };

/** 失敗の短い名前（ログ・result に入れる。サーバーの文字列は入れない） */
export function describeFailure(f: McpFailure): string {
  switch (f.kind) {
    case "auth":
      return `http_${f.status}`;
    case "timeout":
      return "timeout";
    case "network":
      return f.code ? `network_${f.code}` : "network";
    case "http":
      return `http_${f.status}`;
    case "rpc_error":
      return f.code === null ? "rpc_error" : `rpc_error_${f.code}`;
    case "protocol":
      return "protocol_error";
  }
}


function lastRecord(records: readonly FetchRecord[], from: number, ...methods: string[]): FetchRecord | undefined {
  for (let i = records.length - 1; i >= from; i--) {
    const r = records[i];
    if (r && r.method !== null && methods.includes(r.method)) return r;
  }
  return undefined;
}

/** つなぐ・tools/list の例外を失敗に直す（どれも書き込みはまだ送っていない） */
function failureOf(e: unknown, rec: FetchRecord | undefined): McpFailure {
  if (rec?.status === 401 || rec?.status === 403) return { kind: "auth", status: rec.status };
  if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) return { kind: "timeout" };
  if (rec && rec.error !== null) return { kind: "network", presend: isPresendNetworkError(rec.error), code: networkCodeOf(rec.error) };
  if (rec && rec.status !== null && (rec.status < 200 || rec.status >= 300)) return { kind: "http", status: rec.status };
  if (rec?.rpc === "error" && e instanceof McpError) return { kind: "rpc_error", code: e.code };
  return { kind: "protocol", message: e instanceof Error ? e.message : String(e) };
}

/** tools/call の例外を結果に直す（IA §3.12 の表・§8-12） */
function callOutcomeOf(e: unknown, rec: FetchRecord | undefined): CallOutcome {
  // tools/call の要求を送る前に失敗した（記録がない）
  if (!rec) return { kind: "presend_failure", detail: e instanceof Error ? e.message : "not_sent" };
  if (rec.error !== null) {
    if (isPresendNetworkError(rec.error)) return { kind: "presend_failure", detail: `network_${networkCodeOf(rec.error) ?? "unknown"}` };
    // タイムアウトで閉じたときの中断も「送ったあと」
    if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) return { kind: "postsend_unknown", detail: "timeout" };
    return { kind: "postsend_unknown", detail: `disconnect${networkCodeOf(rec.error) ? `_${networkCodeOf(rec.error)}` : ""}` };
  }
  if (rec.status === null) {
    // 応答の頭がまだ来ていない（SDK のタイムアウト）
    return { kind: "postsend_unknown", detail: e instanceof McpError && e.code === ErrorCode.RequestTimeout ? "timeout" : "no_response" };
  }
  if (rec.status === 401 || rec.status === 403) return { kind: "auth_error", status: rec.status };
  if (rec.status >= 500) return { kind: "postsend_unknown", detail: `http_${rec.status}` };
  if (rec.status < 200 || rec.status >= 300) return { kind: "tool_error", detail: `http_${rec.status}` };
  // 2xx が返った
  if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) return { kind: "postsend_unknown", detail: "timeout" };
  if (rec.rpc === "error") return { kind: "tool_error", detail: e instanceof McpError ? `rpc_error_${e.code}` : "rpc_error" };
  // 結果は返ったが SDK が読めなかった（出力のスキーマの外れ・SSE の途中の切断など）：届いたかどうか分からない
  return { kind: "postsend_unknown", detail: "invalid_result" };
}

export interface McpSessionOptions {
  fetch?: typeof fetch;
  /** initialize・tools/list の上限 */
  listTimeoutMs?: number;
}

export interface McpSession {
  listTools(): Promise<{ ok: true; tools: McpToolDef[] } | { ok: false; failure: McpFailure }>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<CallOutcome>;
  close(): Promise<void>;
}

function toJson(v: unknown): Json | null {
  return v === undefined ? null : (JSON.parse(JSON.stringify(v)) as Json);
}

/**
 * つなぐ（initialize）。失敗は McpFailure（書き込みはまだ送っていないので、実行では送信前の失敗として数える）。
 * 開いたら必ず close する
 */
export async function openMcpSession(
  target: McpTarget,
  opts: McpSessionOptions = {},
): Promise<{ ok: true; session: McpSession } | { ok: false; failure: McpFailure }> {
  const records: FetchRecord[] = [];
  const listTimeoutMs = opts.listTimeoutMs ?? MCP_LIST_TIMEOUT_MS;
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    return { ok: false, failure: { kind: "protocol", message: "コネクタの URL を読めない" } };
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: target.headers },
    fetch: tracingFetch(opts.fetch ?? fetch, records),
  });
  const client = new Client(MCP_CLIENT_INFO, { capabilities: {} });
  // SDK が投げずに onerror へ流す失敗（SSE の待ち受けなど）は無視する（結果は記録と例外で決める）
  client.onerror = () => {};
  const close = async () => {
    try {
      await client.close();
    } catch {
      // 閉じる失敗は結果に影響しない
    }
  };
  try {
    await client.connect(transport, { timeout: listTimeoutMs });
  } catch (e) {
    await close();
    return { ok: false, failure: failureOf(e, lastRecord(records, 0, "initialize", "notifications/initialized")) };
  }

  const session: McpSession = {
    async listTools() {
      const tools: McpToolDef[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const from = records.length;
        try {
          const r = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: listTimeoutMs });
          for (const t of r.tools) {
            tools.push({
              name: t.name,
              description: typeof t.description === "string" ? t.description : "",
              inputSchema: toJson(t.inputSchema) ?? {},
              annotations: toJson(t.annotations),
            });
          }
          if (typeof r.nextCursor !== "string" || r.nextCursor === "") return { ok: true, tools };
          cursor = r.nextCursor;
        } catch (e) {
          return { ok: false, failure: failureOf(e, lastRecord(records, from, "tools/list")) };
        }
      }
      return { ok: false, failure: { kind: "protocol", message: "tools/list のページが終わらない" } };
    },

    async callTool(name, args, timeoutMs = MCP_CALL_TIMEOUT_MS) {
      const from = records.length;
      try {
        const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult;
        return result.isError === true ? { kind: "is_error", result } : { kind: "ok", result };
      } catch (e) {
        // タイムアウトのあとも中の fetch は残るので、呼び出し側が close して止める
        return callOutcomeOf(e, lastRecord(records, from, "tools/call"));
      }
    },

    close,
  };
  return { ok: true, session };
}
