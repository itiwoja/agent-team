// MCP のクライアント（SDK の Streamable HTTP）と失敗の分け方（IA §3.12 の McpCallOutcome・§8-12、BR-59・D-18、MT D-11・BD-12）
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SHOP_TOOL_DESCRIPTIONS } from "@open-team/sim-core";
import { isPresendNetworkError, networkCodeOf, openMcpSession, type McpTarget } from "./mcp.ts";
import { simHeadersOf } from "./context.ts";
import {
  BEANS_20,
  SIM_TOKEN,
  connectionRefused,
  connectionReset,
  hangUntilAborted,
  recordingFetch,
  rpcResponse,
  startSimWorld,
  type FetchHook,
  type SentRequest,
  type SimWorldHandle,
} from "./test-helpers.ts";

let sim: SimWorldHandle;
beforeAll(async () => {
  sim = await startSimWorld();
});
afterAll(async () => {
  await sim.close();
});

const auth = { authorization: `Bearer ${SIM_TOKEN}`, "x-ot-caller": "sa-gateway" };

async function demoTarget(service: string): Promise<{ target: McpTarget; workspaceId: string; demoId: string }> {
  const workspaceId = randomUUID();
  const { id } = await sim.createDemoStore(workspaceId);
  const headers = { ...auth, ...simHeadersOf({ workspaceId, rehearsalRunId: null, simExecutionId: null, taskId: null, intentId: null, shadow: false }) };
  return { target: { url: `${sim.url}/mcp/shop/${service}`, headers }, workspaceId, demoId: id };
}

function hooked(hook: FetchHook): { fetch: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  return { fetch: recordingFetch(sent, hook), sent };
}

describe("openMcpSession（本物の sim-world）", () => {
  it("initialize → tools/list → tools/call。注釈は無し、説明は manifest の固定の文", async () => {
    const { target, workspaceId, demoId } = await demoTarget("supplier");
    const { fetch: f, sent } = hooked(() => null);
    const opened = await openMcpSession(target, { fetch: f });
    if (!opened.ok) throw new Error(JSON.stringify(opened.failure));
    const listed = await opened.session.listTools();
    expect(listed.ok && listed.tools.map((t) => t.name)).toEqual(["list_products", "place_order"]);
    if (listed.ok) {
      expect(listed.tools[1]!.description).toBe(SHOP_TOOL_DESCRIPTIONS["supplier.place_order"]);
      expect(listed.tools[1]!.annotations).toBeNull();
    }
    const out = await opened.session.callTool("place_order", BEANS_20);
    expect(out.kind).toBe("ok");
    await opened.session.close();
    expect((await sim.getState(workspaceId, demoId)).state.orders).toHaveLength(1);
    // 頭：呼び出し元の証明と X-OT-*（M-43）が tools/call に付いている
    const call = sent.find((s) => s.rpc === "tools/call")!;
    expect(call.headers).toMatchObject({ authorization: `Bearer ${SIM_TOKEN}`, "x-ot-caller": "sa-gateway", "x-ot-workspace-id": workspaceId, "x-ot-shadow": "false" });
    expect(call.headers["x-ot-rehearsal-run-id"]).toBeUndefined();
  });

  it("isError（引数の誤り）は is_error（応答が返った）", async () => {
    const { target } = await demoTarget("supplier");
    const opened = await openMcpSession(target);
    if (!opened.ok) throw new Error("つながらない");
    const out = await opened.session.callTool("place_order", { supplier_id: "supplier-01", items: [], extra: 1 });
    expect(out.kind).toBe("is_error");
    await opened.session.close();
  });

  it("SW-05 X-OT-Workspace-Id のない tools/list は拒否される（JSON-RPC のエラー → rpc_error）", async () => {
    const opened = await openMcpSession({ url: `${sim.url}/mcp/shop/store`, headers: auth });
    if (!opened.ok) throw new Error("initialize は頭なしで通る");
    const listed = await opened.session.listTools();
    expect(listed).toEqual({ ok: false, failure: { kind: "rpc_error", code: expect.any(Number) } });
    await opened.session.close();
  });

  it("呼び出し元の証明がない → initialize が 403（auth）", async () => {
    const opened = await openMcpSession({ url: `${sim.url}/mcp/shop/store`, headers: {} });
    expect(opened).toEqual({ ok: false, failure: { kind: "auth", status: 403 } });
  });

  it("つなげない（ECONNREFUSED）→ network・送信前", async () => {
    const { target } = await demoTarget("store");
    const { fetch: f } = hooked(() => connectionRefused());
    const opened = await openMcpSession(target, { fetch: f });
    expect(opened).toEqual({ ok: false, failure: { kind: "network", presend: true, code: "ECONNREFUSED" } });
  });

  it("BD-12 MCP サーバーが 302 で別のホストに飛ばす → 追わない（http 302。飛び先には送らない）", async () => {
    const { target } = await demoTarget("store");
    const { fetch: f, sent } = hooked((req) =>
      req.rpc === "initialize" ? new Response(null, { status: 302, headers: { location: "https://evil.example/mcp" } }) : null,
    );
    const opened = await openMcpSession(target, { fetch: f });
    expect(opened).toEqual({ ok: false, failure: { kind: "http", status: 302 } });
    expect(sent.every((s) => !s.url.includes("evil.example"))).toBe(true);
  });
});

describe("tools/call の結果の分け方（IA §3.12 の表・§8-12）", () => {
  async function callWith(hook: FetchHook, timeoutMs?: number) {
    const { target, workspaceId, demoId } = await demoTarget("supplier");
    const { fetch: f, sent } = hooked((req, real, init) => (req.rpc === "tools/call" ? hook(req, real, init) : null));
    const opened = await openMcpSession(target, { fetch: f });
    if (!opened.ok) throw new Error("つながらない");
    const out = await opened.session.callTool("place_order", BEANS_20, timeoutMs);
    await opened.session.close();
    const orders = (await sim.getState(workspaceId, demoId)).state.orders as unknown[];
    return { out, sent, orders };
  }

  it("名前解決・接続拒否（ECONNREFUSED）→ presend_failure（送っていない）", async () => {
    const { out, orders } = await callWith(() => connectionRefused());
    expect(out).toEqual({ kind: "presend_failure", detail: "network_ECONNREFUSED" });
    expect(orders).toHaveLength(0);
  });
  it("送ったあとに接続が切れた（ECONNRESET）→ postsend_unknown（注文は反映済み。再試行しない）", async () => {
    const { out, orders } = await callWith(async (_req, real) => {
      await real();
      throw connectionReset();
    });
    expect(out).toEqual({ kind: "postsend_unknown", detail: "disconnect_ECONNRESET" });
    expect(orders).toHaveLength(1);
  });
  it("G-11 応答が返らない → タイムアウトで postsend_unknown（timeout）", async () => {
    const { out } = await callWith((_req, _real, init) => hangUntilAborted(init), 200);
    expect(out).toEqual({ kind: "postsend_unknown", detail: "timeout" });
  });
  it("5xx（504・503）→ postsend_unknown", async () => {
    expect((await callWith(() => new Response("gateway timeout", { status: 504 }))).out).toEqual({ kind: "postsend_unknown", detail: "http_504" });
    expect((await callWith(() => new Response("unavailable", { status: 503 }))).out).toEqual({ kind: "postsend_unknown", detail: "http_503" });
  });
  it("G-10 401・403 → auth_error", async () => {
    expect((await callWith(() => new Response("no", { status: 401 }))).out).toEqual({ kind: "auth_error", status: 401 });
    expect((await callWith(() => new Response("no", { status: 403 }))).out).toEqual({ kind: "auth_error", status: 403 });
  });
  it("IA §8-12 ほかの 4xx（400・404・429）と 3xx → tool_error（応答が返った。再試行しない）", async () => {
    for (const status of [400, 404, 409, 422, 429, 302]) {
      expect((await callWith(() => new Response("x", { status }))).out, String(status)).toEqual({ kind: "tool_error", detail: `http_${status}` });
    }
  });
  it("IA §8-12 JSON-RPC のエラー応答 → tool_error", async () => {
    const { out } = await callWith((req) => rpcResponse(req, { error: { code: -32602, message: "bad params" } }));
    expect(out).toEqual({ kind: "tool_error", detail: "rpc_error_-32602" });
  });
  it("結果の形が読めない（2xx の JSON だが CallToolResult でない）→ 届いたか分からない（postsend_unknown）", async () => {
    const { out } = await callWith((req) => rpcResponse(req, { result: { content: "not-an-array" } }));
    expect(out).toEqual({ kind: "postsend_unknown", detail: "invalid_result" });
  });
});

describe("ネットワークの失敗の分け方", () => {
  it("名前解決・接続拒否・TLS は送信前、接続断・分からないものは送信後", () => {
    const err = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
    for (const c of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"]) {
      expect(isPresendNetworkError(err(c)), c).toBe(true);
    }
    for (const c of ["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"]) {
      expect(isPresendNetworkError(err(c)), c).toBe(false);
    }
    expect(isPresendNetworkError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isPresendNetworkError(new TypeError("fetch failed", { cause: new Error("bad port") }))).toBe(true);
  });
  it("AggregateError（二つの IP に順に試した）の中のコードも読む", () => {
    const agg = new TypeError("fetch failed", {
      cause: Object.assign(new AggregateError([Object.assign(new Error("x"), { code: "ECONNREFUSED" })]), {}),
    });
    expect(networkCodeOf(agg)).toBe("ECONNREFUSED");
    expect(networkCodeOf(new Error("none"))).toBeNull();
  });
});
