// 一周の試験：偽の MCP サーバーを同じプロセスで起こし、本物の MCP（Streamable HTTP）で EP-51 → EP-49 → EP-50 を通す
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTestDb } from "@open-team/db/testing";
import {
  BEANS_20,
  FAKE_CONNECTORS,
  auditEvents,
  gatewayEnv,
  insertIntent,
  intentRow,
  seedConnectors,
  startFakeMcp,
  startGateway,
  taskRow,
  taskWithToken,
  workspace,
  type FakeMcpHandle,
} from "./test-helpers.ts";

const T = useTestDb();
let fake: FakeMcpHandle;
beforeAll(async () => {
  fake = await startFakeMcp();
});
afterAll(async () => {
  await fake.close();
});

describe("一周（MT SW-01・§3.14、EP-49〜51）", () => {
  it("EP-51 でコネクタを登録し（unclassified で入る）、manifest で確定したあと、読み取りと書き込みがコネクタに届く", async () => {
    const { db } = T();
    const ws = await workspace(db);
    const gw = startGateway(db, gatewayEnv(fake.url));

    // EP-51 の直後は unclassified・ok・役割なし（MT §3.12.4 の3）
    const first = await db.query<{ id: string }>(
      "INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth) VALUES ($1, 'store', '店舗の在庫', 'mcp_remote', $2, $3) RETURNING id",
      [ws.workspaceId, `${fake.url}/mcp/store`, { type: "none" }],
    );
    const synced = await gw.client.syncTools(first.rows[0]!.id);
    expect(synced.tools).toEqual([{ name: "get_inventory", toolHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), status: "ok" }]);
    const raw = (await db.query("SELECT * FROM connector_tools WHERE connector_id = $1", [first.rows[0]!.id])).rows[0] as Record<string, any>;
    expect(raw).toMatchObject({ classification: "unclassified", status: "ok", arg_roles: {}, scope: null, verify: "none", annotations: null });
    expect(raw.description).toBe(FAKE_CONNECTORS.find((c) => c.slug === "store")!.tools[0]!.description);
    await db.query("DELETE FROM connectors WHERE id = $1", [first.rows[0]!.id]);

    // コネクタ4件・ツールは manifest どおり
    const shop = await seedConnectors(db, gw.client, ws, fake.url);
    expect(Object.keys(shop).sort()).toEqual(["bank", "mail", "store", "supplier"]);
    const tools = await db.query<{ name: string; classification: string }>("SELECT name, classification FROM connector_tools WHERE workspace_id = $1 ORDER BY name", [
      ws.workspaceId,
    ]);
    expect(tools.rows).toHaveLength(FAKE_CONNECTORS.flatMap((c) => c.tools).length);

    // 監査ログに connector.tool.added
    const added = (await auditEvents(db, ws.workspaceId)).filter((e) => e.event_type === "connector.tool.added");
    expect(added.map((e) => e.payload.tool).sort()).toEqual(["get_inventory", "get_inventory", "list_inbox", "list_products", "place_order", "register_payee"].sort());

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
    // コネクタに発注が1件届いた（引数はそのまま）
    const orders = fake.calls.filter((c) => c.tool === "place_order");
    expect(orders).toHaveLength(1);
    expect(orders[0]!.arguments).toEqual(BEANS_20);
    // 監査ログ action.executed、タスクはループが終わっていないので running のまま
    const ev = (await auditEvents(db, ws.workspaceId)).filter((e) => e.event_type === "action.executed");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ intentId, taskId, action: "mcp.supplier.place_order" });
    expect((await taskRow(db, taskId)).status).toBe("running");

    // 2回目の実行は何もしない（G-2：executed を返すだけ。tools/call は1回）
    const again = await gw.client.executeIntent(intentId);
    expect(again.status).toBe("executed");
    expect(gw.sent.filter((s) => s.rpc === "tools/call" && s.url.endsWith("/supplier"))).toHaveLength(1);
  });
});
