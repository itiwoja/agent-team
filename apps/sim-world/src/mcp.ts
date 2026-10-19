// MCP の入口（sim-world-rehearsal.md §4.1.2、mcp-taint.md §2.10・§3.14、M-43・M-44・M-52）
// POST /mcp/<world>/<service> を Streamable HTTP の状態を持たないモードで受ける。リクエストごとにサーバーを作り、
// X-OT-* で引いた走行に対して sim-core の handleTool を呼ぶ。gateway からは普通のコネクタに見える（15:272）。
// sim-core の http_error（429・503・504）は HTTP の状態コードで返す（gateway が「送信後の 5xx」を見分けて unknown_outcome にする）

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
import type { CallCtx, SimToolListing, ToolOutcome } from "@open-team/sim-core";
import { errorBody } from "./errors.ts";
import { executionKeyOf, executionMismatch, parseSimHeaders, type SimCallHeaders } from "./headers.ts";
import type { LogInput, Logger } from "./log.ts";
import type { ExecutionChange, SimStore } from "./store.ts";
import { baseStateOf, connectorOf, implementedWorld, type WorldRegistry } from "./worlds.ts";

export const MCP_SERVER_INFO = { name: "open-team-sim-world", version: "0.1.0" } as const;

export interface McpDeps {
  store: SimStore;
  worlds: WorldRegistry;
  now: () => Date;
  /** そのリクエストの Logger（requestId つき。app.ts が platform の requestContext から渡す） */
  log: Logger;
}

type JsonRpcId = string | number | null;

/** HTTP のエラーで返す応答（F-01 の 504・F-07 の 503 など）の文 */
const HTTP_FAILURE_TEXT: Record<429 | 503 | 504, string> = {
  429: "Too Many Requests",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

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

/** GET（SSE の待ち受け）・DELETE（セッションの終わり）は持たない。クライアントは 405 を「SSE なし」と読む */
export function mcpMethodNotAllowed(): Response {
  return jsonRpcErrorResponse(405, null, -32000, "Method not allowed.", { allow: "POST" });
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** tools/list の1件。注釈・title は返さない（分類の根拠はコードの manifest。MT D-04・D-19）。模擬のカレンダーだけ readOnlyHint を返す（apps/gcal と同じ） */
function toMcpTool(t: SimToolListing): Tool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Tool["inputSchema"],
    ...(t.annotations ? { annotations: t.annotations } : {}),
  };
}

/** 正常な応答：content に JSON テキスト、structuredContent に同じ値（オブジェクトのときだけ） */
function okResult(result: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    ...(isRecord(result) ? { structuredContent: result } : {}),
  };
}

type CallValue = { kind: "mismatch"; message: string } | { kind: "outcome"; outcome: ToolOutcome<unknown> };

export async function handleMcpPost(
  req: Request,
  params: { world: string; service: string },
  deps: McpDeps,
  requestId: string,
): Promise<Response> {
  const world = implementedWorld(deps.worlds, params.world);
  const connector = world ? connectorOf(world, params.service) : null;
  if (!world || !connector) {
    return Response.json(errorBody("NOT_FOUND", "その世界・サービスの MCP はありません", requestId), { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonRpcErrorResponse(400, null, ErrorCode.ParseError, "Parse error: Invalid JSON");
  }
  // 1つの HTTP の応答に1つの結果だけを載せる（HTTP の状態コードで結果を返すため。MCP 2025-06-18 もバッチを外した）
  if (Array.isArray(body)) {
    return jsonRpcErrorResponse(400, null, ErrorCode.InvalidRequest, "Invalid Request: バッチは受け付けない（1つずつ送る）");
  }
  const rpcId: JsonRpcId = isRecord(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;

  // ヘッダーは tools/list・tools/call のときだけ要る（initialize・通知・ping は走行に触れない）
  const headers = parseSimHeaders(req.headers);
  const requireHeaders = (): SimCallHeaders => {
    if (!headers.ok) throw new McpError(ErrorCode.InvalidRequest, headers.message);
    return headers.value;
  };
  // platform の Logger は投げない（書けなければ最小の1行に落とす）ので、ログで応答（保存済みの書き込みの結果）は変わらない
  const logSafe = (entry: LogInput) => deps.log.log(entry);
  // 想定外の例外は中身を返さず InternalError にする（ログにだけ残す）
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof McpError) throw e;
      logSafe({
        severity: "ERROR",
        event: "sim.mcp_error",
        message: e instanceof Error ? e.message : String(e),
        requestId,
        workspaceId: headers.ok ? headers.value.workspaceId : null,
        taskId: headers.ok ? headers.value.taskId : null,
      });
      throw new McpError(ErrorCode.InternalError, "sim-world の内部エラー");
    }
  };

  const failure: { status: 429 | 503 | 504 | null } = { status: null };
  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} } });

  // tools/list：その走行の今の説明（F-08 で替わっていればそれ）。デモ店舗がまだなければ固定の説明
  server.setRequestHandler(ListToolsRequestSchema, () =>
    guard(async () => {
      const h = requireHeaders();
      const exec = await deps.store.getExecution(executionKeyOf(world.id, h));
      let state: unknown;
      if (exec) {
        const mismatch = executionMismatch(exec, world.id, h);
        if (mismatch) throw new McpError(ErrorCode.InvalidRequest, mismatch);
        state = exec.state;
      } else if (h.executionId === null) {
        state = baseStateOf(world);
      } else {
        throw new McpError(ErrorCode.InvalidRequest, "走行が見つかりません");
      }
      return { tools: world.listTools(state, connector.slug).map(toMcpTool) };
    }),
  );

  // tools/call：SW §4.1.2 の3〜8（走行を行ロックで引く → sim-core の handleTool → 事象を足して保存 → 応答）
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    guard(async () => {
      const h = requireHeaders();
      const name = request.params.name;
      // そのサービスのツールでなければプロトコルのエラー（状態に触れない）
      if (!connector.tools.some((t) => t.name === name)) {
        throw new McpError(ErrorCode.InvalidParams, `ツールがありません：${connector.slug}.${name}`);
      }
      const ctx: CallCtx = { caller: "sa-gateway", taskId: h.taskId, intentId: h.intentId, shadow: h.shadow };
      const updatedAt = deps.now().toISOString();
      const res = await deps.store.updateExecution(executionKeyOf(world.id, h), (exec): ExecutionChange<CallValue> => {
        const mismatch = executionMismatch(exec, world.id, h);
        if (mismatch) return { kind: "keep", value: { kind: "mismatch", message: mismatch } };
        const outcome = world.handleTool(exec.state, { connector: connector.slug, tool: name, args: request.params.arguments }, ctx);
        // 引数の誤り・429 の isError も事象と通しの番号を残す（SW-06：outcome = tool_error）
        return { kind: "write", state: outcome.state, events: outcome.events, updatedAt, value: { kind: "outcome", outcome } };
      });
      if (!res) throw new McpError(ErrorCode.InvalidRequest, "走行が見つかりません");
      if (res.value.kind === "mismatch") throw new McpError(ErrorCode.InvalidRequest, res.value.message);
      const out = res.value.outcome;
      logSafe({
        severity: "INFO",
        event: "sim.tool_call",
        message: `${connector.slug}.${name}`,
        requestId,
        workspaceId: h.workspaceId,
        taskId: h.taskId,
        intentId: h.intentId,
        executionId: res.execution.id,
        outcome: out.kind === "http_error" ? `http_${out.status}` : out.kind,
      });
      switch (out.kind) {
        case "ok":
          return okResult(out.result);
        case "tool_error":
          return { content: [{ type: "text", text: out.message }], isError: true };
        case "http_error":
          // 状態は保存済み（F-01 は注文を反映したうえで 504：M-52）。応答は下で HTTP のエラーに置き換える
          failure.status = out.status;
          return { content: [{ type: "text", text: `${out.status} ${HTTP_FAILURE_TEXT[out.status]}` }], isError: true };
      }
    }),
  );

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, { parsedBody: body });
    const status = failure.status;
    if (status !== null) {
      await res.body?.cancel();
      return jsonRpcErrorResponse(status, rpcId, -32000, `${status} ${HTTP_FAILURE_TEXT[status]}`);
    }
    return res;
  } finally {
    await server.close().catch(() => {});
  }
}
