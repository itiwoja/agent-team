// MCP の入口（16 §3.2、sim-world の mcp.ts と同じ作り）。POST /mcp/gcal を Streamable HTTP の状態を持たないモードで受ける。
// リクエストごとにサーバーを作る。tools/list はヘッダーなしで答える（gateway の同期）。tools/call は GCAL_HEADER.* が要る（無ければ HTTP 401）。
// Google の 401/403 → HTTP 401、429・5xx・届かない → 同じ状態コード（gateway が unknown_outcome を判定する）。ヘッダーの値はログに出さない。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GCAL_CONNECTOR, GCAL_HEADER, GCAL_TOOL_DESCRIPTIONS, GCAL_TOOL_INPUT_SCHEMAS, eventIdOf } from "@open-team/gcal-core";
import { GoogleAuthError, GoogleUpstreamError, createCalendarClient } from "./calendar.ts";
import type { Logger } from "@open-team/platform";
import { GCAL_TOOL_NAMES, callGcalTool, type GcalToolName } from "./tools.ts";
import { isValidTimeZone } from "./slots.ts";

export const MCP_SERVER_INFO = { name: "open-team-gcal", version: "0.1.0" } as const;

export interface McpDeps {
  /** Google の fetch（試験は偽物を渡す） */
  fetch: typeof fetch;
  /** Calendar API の基底 URL */
  apiBase: string;
  /** そのリクエストの Logger（requestId つき。アクセストークンはマスク済み） */
  log: Logger;
}

type JsonRpcId = string | number | null;

/** HTTP のエラーで返す応答の文 */
function failureText(status: number): string {
  return status === 401 ? "Unauthorized" : `Upstream ${status}`;
}

export function jsonRpcErrorResponse(
  status: number,
  id: JsonRpcId,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** GET（SSE の待ち受け）・DELETE（セッションの終わり）は持たない */
export function mcpMethodNotAllowed(): Response {
  return jsonRpcErrorResponse(405, null, -32000, "Method not allowed.", { allow: "POST" });
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** ツールの呼び出しに要るヘッダー（tools/call だけ） */
export interface GcalCallHeaders {
  accessToken: string;
  calendarId: string;
  timeZone: string;
  idempotencyKey: string | null;
}

/** ヘッダーを読む。無い・空・不正（時間帯が IANA でない、予定の ID を作れない）なら null。値は返すだけでログには出さない */
export function readCallHeaders(headers: Headers, needsIdempotencyKey: boolean): GcalCallHeaders | null {
  const accessToken = headers.get(GCAL_HEADER.accessToken)?.trim() ?? "";
  const calendarId = headers.get(GCAL_HEADER.calendarId)?.trim() ?? "";
  const timeZone = headers.get(GCAL_HEADER.timeZone)?.trim() ?? "";
  const idempotencyKey = headers.get(GCAL_HEADER.idempotencyKey)?.trim() ?? null;
  if (accessToken === "" || calendarId === "" || calendarId.length > 1024) return null;
  if (timeZone === "" || !isValidTimeZone(timeZone)) return null;
  if (needsIdempotencyKey && !isEventSeed(idempotencyKey)) return null;
  return { accessToken, calendarId, timeZone, idempotencyKey: idempotencyKey === "" ? null : idempotencyKey };
}

/** Intent の ID（UUID）から予定の ID を作れるか（eventIdOf の規則） */
function isEventSeed(v: string | null): v is string {
  if (v === null) return false;
  try {
    eventIdOf(v);
    return true;
  } catch {
    return false;
  }
}

const TOOLS: Tool[] = GCAL_TOOL_NAMES.map((name) => {
  const manifest = GCAL_CONNECTOR.tools.find((t) => t.name === name);
  return {
    name,
    description: GCAL_TOOL_DESCRIPTIONS[name],
    inputSchema: GCAL_TOOL_INPUT_SCHEMAS[name] as Tool["inputSchema"],
    ...(manifest?.classification === "read" ? { annotations: { readOnlyHint: true } } : {}),
  };
});

function toolNameOf(name: string): GcalToolName | null {
  return (GCAL_TOOL_NAMES as readonly string[]).includes(name) ? (name as GcalToolName) : null;
}

export async function handleMcpPost(req: Request, deps: McpDeps, requestId: string): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonRpcErrorResponse(400, null, ErrorCode.ParseError, "Parse error: Invalid JSON");
  }
  // 1つの HTTP の応答に1つの結果だけ（HTTP の状態コードで結果を返すため）
  if (Array.isArray(body)) {
    return jsonRpcErrorResponse(400, null, ErrorCode.InvalidRequest, "Invalid Request: バッチは受け付けない（1つずつ送る）");
  }
  const rpcId: JsonRpcId = isRecord(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;

  // HTTP の状態コードで返す失敗（401・429・5xx）。設定されたら JSON-RPC の応答を置き換える
  const failure: { status: number | null } = { status: null };
  const markFailure = (status: number): never => {
    failure.status = status;
    throw new McpError(ErrorCode.InternalError, failureText(status));
  };

  // 想定外の例外は中身を返さず InternalError にする（ログにだけ、マスク済みで残す）
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof McpError) throw e;
      if (e instanceof GoogleAuthError) {
        deps.log.warn("gcal.upstream_auth", "Google の認証に失敗", { requestId, status: e.status });
        return markFailure(401);
      }
      if (e instanceof GoogleUpstreamError) {
        deps.log.warn("gcal.upstream_failure", "Google Calendar の一時的な失敗", { requestId, status: e.status });
        return markFailure(e.status);
      }
      deps.log.error("gcal.mcp_error", e instanceof Error ? e.message : String(e), { requestId });
      throw new McpError(ErrorCode.InternalError, "gcal の内部エラー");
    }
  };

  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });

  // tools/list：ヘッダーなしで答える（gateway の同期）
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  // tools/call：ヘッダーを確かめ（無ければ 401）→ 名前 → Google を呼ぶ（その1回だけ）
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    guard(async (): Promise<CallToolResult> => {
      const name = request.params.name;
      const tool = toolNameOf(name);
      const headers = readCallHeaders(req.headers, tool === "create_event");
      if (!headers) return markFailure(401);
      if (tool === null) throw new McpError(ErrorCode.InvalidParams, `ツールがありません：gcal.${name}`);

      const calendar = createCalendarClient(deps.fetch, deps.apiBase, headers.accessToken);
      const result = await callGcalTool(tool, request.params.arguments, {
        calendar,
        calendarId: headers.calendarId,
        timeZone: headers.timeZone,
        idempotencyKey: headers.idempotencyKey,
      });
      deps.log.info("gcal.tool_call", `gcal.${tool}`, { requestId, outcome: result.isError ? "tool_error" : "ok" });
      return result;
    }),
  );

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, { parsedBody: body });
    const status = failure.status;
    if (status !== null) {
      await res.body?.cancel().catch(() => {});
      return jsonRpcErrorResponse(status, rpcId, -32000, failureText(status));
    }
    return res;
  } finally {
    await server.close().catch(() => {});
  }
}
