// 一周の試験：sim-world を同じプロセスで起こし、本物の MCP（Streamable HTTP）で EP-51 → EP-49 → EP-50 を通す
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestDb } from "@open-team/db/testing";
import { SHOP_CONNECTORS, SHOP_TOOL_DESCRIPTIONS } from "@open-team/sim-core";
import {
  BEANS_20,
  auditEvents,
  gatewayEnv,
  insertIntent,
  intentRow,
  seedShop,
  startGateway,
  startSimWorld,
  taskRow,
  taskWithToken,
  workspace,
  type SimWorldHandle,
} from "./test-helpers.ts";

const T = useTestDb();
let sim: SimWorldHandle;
beforeAll(async () => {
  sim = await startSimWorld();
});
afterAll(async () => {
  await sim.close();
});

describe("一周（MT SW-01・§3.14、EP-49〜51）", () => {
  it("MT SW-01 EP-51 で sim-world を普通のコネクタとして登録し（unclassified で入る）、manifest で確定したあと、読み取りと書き込みが sim-world に届く", async () => {
    const { db } = T();
    const ws = await workspace(db);
    const demo = await sim.createDemoStore(ws.workspaceId);
    const gw = startGateway(db, gatewayEnv(sim.url));

    // EP-51 の直後は unclassified・ok・役割なし（MT §3.12.4 の3）
    const first = await db.query<{ id: string }>(
      "INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth) VALUES ($1, 'store', '店舗の在庫', 'sim', $2, $3) RETURNING id",
      [ws.workspaceId, `${sim.url}/mcp/shop/store`, { type: "none" }],
    );
    const synced = await gw.client.syncTools(first.rows[0]!.id);
    expect(synced.tools).toEqual([{ name: "get_inventory", toolHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), status: "ok" }]);
    const raw = (await db.query("SELECT * FROM connector_tools WHERE connector_id = $1", [first.rows[0]!.id])).rows[0] as Record<string, any>;
    expect(raw).toMatchObject({ classification: "unclassified", status: "ok", arg_roles: {}, scope: null, verify: "none", annotations: null });
    expect(raw.description).toBe(SHOP_TOOL_DESCRIPTIONS["store.get_inventory"]);
    await db.query("DELETE FROM connectors WHERE id = $1", [first.rows[0]!.id]);

    // コネクタ4件・ツール6件（manifest どおり）
    const shop = await seedShop(db, gw.client, ws, sim.url);
    expect(Object.keys(shop).sort()).toEqual(["bank", "mail", "store", "supplier"]);
    const tools = await db.query<{ name: string; classification: string }>("SELECT name, classification FROM connector_tools WHERE workspace_id = $1 ORDER BY name", [
      ws.workspaceId,
    ]);
    expect(tools.rows).toHaveLength(SHOP_CONNECTORS.flatMap((c) => c.tools).length);

    // 監査ログに connector.tool.added
    const added = (await auditEvents(db, ws.workspaceId)).filter((e) => e.event_type === "connector.tool.added");
    expect(added.map((e) => e.payload.tool).sort()).toEqual(["get_inventory", "get_inventory", "list_inbox", "list_products", "place_order", "register_payee", "send"].sort());

    // EP-49：店舗の在庫を読む
    const { agent, taskId, token } = await taskWithToken(db, ws);
    const read = await gw.client.callReadTool(token, { connectorId: shop.store!.id, tool: "get_inventory", arguments: {}, toolCallId: "call-1" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.isError).toBe(false);
      expect(JSON.parse(read.content)).toHaveProperty("items");
    }

    // EP-50：承認済みの発注を実行する
    const { intentId } = await insertIntent(db, ws, {
      taskId,
      jobId: agent.jobId,
      connector: shop.supplier!,
      tool: shop.supplier!.tools.place_order!,
      args: BEANS_20,
    });
    const res = await gw.client.executeIntent(intentId);
    expect(res).toEqual({ intentId, status: "executed", failReason: null, expiredReason: null });
    const row = await intentRow(db, intentId);
    expect(row.status).toBe("executed");
    expect(row.executed_at).toBeInstanceOf(Date);
    expect(row.result).toMatchObject({ isError: false, truncated: false });
    expect(JSON.parse(row.result.content)).toHaveProperty("order_id");
    // sim-world のデモ店舗に注文が1件（gateway が書いた）
    const state = await sim.getState(ws.workspaceId, demo.id);
    expect(state.state.orders).toHaveLength(1);
    expect(state.state.orders[0]).toMatchObject({ supplierId: "supplier-01", intentId, taskId });
    // 監査ログ action.executed、タスクはループが終わっていないので running のまま
    const ev = (await auditEvents(db, ws.workspaceId)).filter((e) => e.event_type === "action.executed");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ intentId, taskId, action: "mcp.supplier.place_order", enforced: true, shadow: false });
    expect((await taskRow(db, taskId)).status).toBe("running");

    // 2回目の実行は何もしない（G-2：executed を返すだけ。tools/call は1回）
    const again = await gw.client.executeIntent(intentId);
    expect(again.status).toBe("executed");
    expect(gw.sent.filter((s) => s.rpc === "tools/call" && s.url.endsWith("/supplier"))).toHaveLength(1);
  });
});
