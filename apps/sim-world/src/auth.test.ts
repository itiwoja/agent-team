import { describe, expect, it } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServiceAuth, memoryLogger } from "@open-team/platform";
import { createApp } from "./app.ts";
import { CALLER_HEADER, SIM_OPERATIONS, allowedCallersOf, authorizeSimCaller, serviceAuthConfigOf } from "./auth.ts";
import { APP, BEANS_20, GATEWAY, LOCAL_ENV, TOKEN, adminApi, connectMcp, createDemoStore, getExecution, newId, setup, simHeaders, type AppLike } from "./test-helpers.ts";

/** MCP の初期化が通るか（通れば 200、HTTP のエラーならその状態） */
async function mcpStatus(app: AppLike, headers: Record<string, string>): Promise<number> {
  try {
    const c = await connectMcp(app, "/mcp/shop/supplier", headers);
    await c.close();
    return 200;
  } catch (e) {
    if (e instanceof StreamableHTTPError) return e.code ?? -1;
    throw e;
  }
}

describe("authorizeSimCaller・allowedCallersOf（SO §3.11 の表、M-44）", () => {
  it("mcp は sa-gateway だけ、管理の操作は sa-app だけ", () => {
    for (const op of SIM_OPERATIONS) {
      expect(authorizeSimCaller(op, "sa-gateway")).toBe(op === "mcp");
      expect(authorizeSimCaller(op, "sa-app")).toBe(op !== "mcp");
      expect(allowedCallersOf(op)).toEqual(op === "mcp" ? ["sa-gateway"] : ["sa-app"]);
    }
  });

  it("serviceAuthConfigOf：共有トークンだけ", () => {
    expect(serviceAuthConfigOf(LOCAL_ENV)).toEqual({ sharedToken: TOKEN });
  });
});

describe("呼び出し元の確認（platform の共有トークン＋x-ot-caller）", () => {
  it("SW-04・BD-11・SO-SIM-01・T-160 sa-app で MCP（place_order）を呼ぶと 403。デモ店舗は変わらない", async () => {
    const { app } = setup();
    const ws = newId();
    const demo = await createDemoStore(app, ws);
    expect(await mcpStatus(app, { ...APP, ...simHeaders({ workspaceId: ws }) })).toBe(403);
    // 生の tools/call でも同じ（初期化を飛ばしても入口で止まる）
    const res = await app.request("http://sim.test/mcp/shop/supplier", {
      method: "POST",
      headers: { ...APP, ...simHeaders({ workspaceId: ws }), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "place_order", arguments: BEANS_20 } }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN", requestId: expect.any(String) } });
    expect((await getExecution(app, ws, demo.id)).state.orders).toEqual([]);
  });

  it("SO-SIM-02 sa-gateway（X-OT-* あり）なら通る", async () => {
    const { app } = setup();
    const ws = newId();
    await createDemoStore(app, ws);
    expect(await mcpStatus(app, { ...GATEWAY, ...simHeaders({ workspaceId: ws }) })).toBe(200);
  });

  it("SO-SIM-03 sa-gateway で管理 API（作成・取得・削除）は 403", async () => {
    const { app } = setup();
    const ws = newId();
    const api = adminApi(app, GATEWAY);
    expect((await api.post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(403);
    expect((await api.get(`/executions/${newId()}?workspaceId=${ws}`)).status).toBe(403);
    expect((await api.del(`/workspaces/${ws}`)).status).toBe(403);
  });

  it.each([
    ["Authorization なし", { [CALLER_HEADER]: "sa-gateway" }],
    ["違うトークン", { authorization: "Bearer wrong-token", [CALLER_HEADER]: "sa-gateway" }],
    ["1文字だけ違うトークン", { authorization: `Bearer ${TOKEN.slice(0, -1)}x`, [CALLER_HEADER]: "sa-gateway" }],
    ["Bearer でない", { authorization: TOKEN, [CALLER_HEADER]: "sa-gateway" }],
    ["呼び出し元の名前なし", { authorization: `Bearer ${TOKEN}` }],
    ["知らない呼び出し元（sa-sim）", { authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-sim" }],
  ])("%s → MCP も管理 API も 403", async (_label, auth) => {
    const { app } = setup();
    expect(await mcpStatus(app, { ...auth, ...simHeaders({ workspaceId: newId() }) })).toBe(403);
    expect((await adminApi(app, auth).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(403);
  });

  it("呼ぶ側（gateway・app）が platform の serviceAuthHeaders で作ったヘッダーがそのまま通る（gateway は MCP、app は管理 API）", async () => {
    const { app } = setup();
    const callers = createServiceAuth({ sharedToken: TOKEN });
    const ws = newId();
    const asApp = await callers.serviceAuthHeaders("sa-app", "http://sim.test");
    expect((await adminApi(app, asApp).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(201);
    const asGateway = await callers.serviceAuthHeaders("sa-gateway", "http://sim.test");
    expect(await mcpStatus(app, { ...asGateway, ...simHeaders({ workspaceId: ws }) })).toBe(200);
    expect(await mcpStatus(app, { ...asApp, ...simHeaders({ workspaceId: ws }) })).toBe(403);
    expect((await adminApi(app, asGateway).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(403);
    // 別の共有トークンの呼び出し元は通らない
    const stranger = await createServiceAuth({ sharedToken: "z".repeat(40) }).serviceAuthHeaders("sa-app", "http://sim.test");
    expect((await adminApi(app, stranger).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(403);
  });

  it("拒否の理由はログ internal_auth.denied にだけ出し（トークンはマスク）、応答には出さない", async () => {
    const { logger, records, lines } = memoryLogger({ service: "sim-world" });
    const { app } = setup({ log: logger });
    const r = await adminApi(app, { authorization: "Bearer secret-wrong-token-0123456789", [CALLER_HEADER]: "sa-app" }).post("/demo-store", {
      workspaceId: newId(),
      world: "shop",
    });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).not.toContain("bad_token");
    const denied = records.find((e) => e.event === "internal_auth.denied");
    expect(denied).toMatchObject({ severity: "WARNING", service: "sim-world", reason: "bad_token", path: "/admin/v1/demo-store" });
    expect(denied?.requestId).toBe(r.json!.error.requestId);
    expect(lines.join("\n")).not.toContain("secret-wrong-token-0123456789");
    // 呼び出しの拒否（名前は正しいが許されない）は caller も残す
    await mcpStatus(app, { ...APP, ...simHeaders({ workspaceId: newId() }) });
    expect(records.filter((e) => e.event === "internal_auth.denied").at(-1)).toMatchObject({ reason: "caller_not_allowed", caller: "sa-app", path: "/mcp/shop/supplier" });
  });

  it("共有トークンが設定されていない・短いと全部 403（閉じる）", async () => {
    for (const sharedToken of [undefined, "short"]) {
      const app = createApp({ ...LOCAL_ENV, sharedToken });
      expect((await adminApi(app, { authorization: `Bearer ${sharedToken ?? ""}`, [CALLER_HEADER]: "sa-app" }).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(403);
    }
  });

  it("/healthz・/api/health は呼び出し元を見ない（commit を返す）", async () => {
    const { app } = setup();
    for (const path of ["/healthz", "/api/health"]) {
      const res = await app.request(`http://sim.test${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", service: "sim-world", commit: "0123abc" });
    }
  });
});
