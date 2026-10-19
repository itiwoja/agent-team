// getTaskContext（API-036）の試験：running への遷移・本番どおりの文脈・トークンの引き直し（formation-runtime.md §2.5・2.6・§6.7・§6.8、SO §3.10）
import { describe, expect, it } from "vitest";
import { taintFromInputs } from "@open-team/kernel";
import { EdgeError } from "@open-team/runner";
import { useTestDb } from "@open-team/db/testing";
import type { Db } from "@open-team/db";
import { buildEdge } from "./__fixtures__/env.ts";
import {
  T0,
  fxWorkspace,
  inboxDefinition,
  seedAgent,
  seedChainAsk,
  seedShopConnectors,
  seedTask,
  supplierDefinition,
  tokenFor,
} from "./__fixtures__/shop.ts";

const T = useTestDb();

async function chain(db: Db, kind: "guest" | "owner" = "guest") {
  const ws = await fxWorkspace(db, { kind, audit: true });
  await seedShopConnectors(db, ws);
  const inbox = await seedAgent(db, ws, inboxDefinition());
  const supplier = await seedAgent(db, ws, supplierDefinition());
  const ask = await seedChainAsk(db, ws, [
    { agent: inbox, jobSlug: "read-supplier-mail", position: 1, spokesperson: false },
    { agent: supplier, jobSlug: "reorder", position: 2, spokesperson: true },
  ]);
  return { ws, inbox, supplier, ask };
}

async function expectEdgeError(p: Promise<unknown>, code: string): Promise<EdgeError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EdgeError);
  expect((e as EdgeError).code).toBe(code);
  return e as EdgeError;
}

describe("getTaskContext（API-036）", () => {
  it("si:43 最初の呼び出しで queued → running（started_at・ハートビート・監査ログ task.status_changed）", async () => {
    const { db } = T();
    const { ws, inbox, ask } = await chain(db);
    const taskId = await seedTask(db, ws, inbox, "read-supplier-mail", { ask, memberName: "受信箱係" });
    const token = await tokenFor(db, ws, taskId);
    const { edge, clock } = buildEdge(db);
    clock.set(T0.getTime() + 5_000);
    const ctx = await edge.getTaskContext(token);
    expect(ctx.taskId).toBe(taskId);
    const row = (await db.query<{ status: string; started_at: Date; last_heartbeat_at: Date }>("SELECT * FROM tasks WHERE id = $1", [taskId])).rows[0]!;
    expect(row.status).toBe("running");
    expect(row.started_at.getTime()).toBe(T0.getTime() + 5_000);
    expect(row.last_heartbeat_at.getTime()).toBe(T0.getTime() + 5_000);
    const audit = await db.query<{ event_type: string; payload: { from: string; to: string } }>(
      "SELECT event_type, payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'task.status_changed'",
      [ws.workspaceId],
    );
    expect(audit.rows.map((r) => r.payload)).toEqual([expect.objectContaining({ from: "queued", to: "running", taskId })]);
    // 2回目は状態を変えない（running のまま文脈を返す）
    clock.advance(1_000);
    await edge.getTaskContext(token);
    const again = (await db.query<{ started_at: Date }>("SELECT started_at FROM tasks WHERE id = $1", [taskId])).rows[0]!;
    expect(again.started_at.getTime()).toBe(T0.getTime() + 5_000);
  });

  it("PR-04 受信箱係（ゲスト・researcher）：テンプレート・フェーズ・ツール（mcp_call・notify・submit_report・finish と、2体の編成の連絡板 team_post・team_wait、本番の依頼なので利用者への質問 ask_user）・付与した MCP のツールだけ", async () => {
    const { db } = T();
    const { ws, inbox, ask } = await chain(db);
    const taskId = await seedTask(db, ws, inbox, "read-supplier-mail", { ask, memberName: "受信箱係" });
    const { edge } = buildEdge(db);
    const ctx = await edge.getTaskContext(await tokenFor(db, ws, taskId));
    expect(ctx.template).toBe("researcher");
    expect(ctx.phases.map((p) => p.llmPhase)).toEqual(["investigate", "plan", "report"]);
    expect(ctx.tools.map((t) => t.name)).toEqual(["mcp_call", "notify", "submit_report", "finish", "team_post", "team_wait", "ask_user"]);
    expect(ctx.mcpTools.map((t) => `${t.connector}.${t.tool}:${t.classification}`)).toEqual(["mail.list_inbox:read"]);
    expect(ctx.runKind).toBe("live");
    expect(ctx.isDryRun).toBe(false);
    expect(ctx.agent.name).toBe("受信箱係");
    expect(ctx.agent.jobInstructions).toContain("仕入れ先から届いた新しいメール");
    expect(ctx.input.prompt).toBe("仕入れ先のメールを読んで、在庫を見て、必要なら発注して");
    expect(ctx.limits.maxTokens).toBe(4096); // D-106（8,000 から下げた）
    // 仮想の時計がなければ実時間の JST（18:00 JST）
    expect(ctx.now).toBe("2026-10-12T18:00:00+09:00");
    expect(ctx.policySummary).toEqual(["mail.list_inbox で読み取りができます", "外部のサービスには書き込めません", "1回あたり最大 $0.20、1日 $1.00 まで"]);
    expect(ctx.formation).toEqual({
      askId: ask.askId,
      shape: "chain",
      position: 1,
      stageCount: 2,
      isSpokesperson: false,
      isAggregator: false,
      members: [
        { name: "受信箱係", position: 1, isAggregator: false },
        { name: "仕入れ係", position: 2, isAggregator: false },
      ],
    });
  });

  it("PR-05 仕入れ係（assistant・窓口）：MCP は読み書き、remember は含まない（連絡板は2体の編成なので入る）。書き込みは確認のあと、の要約", async () => {
    const { db } = T();
    const { ws, supplier, ask } = await chain(db);
    const taskId = await seedTask(db, ws, supplier, "reorder", { ask, memberName: "仕入れ係" });
    const { edge } = buildEdge(db);
    const ctx = await edge.getTaskContext(await tokenFor(db, ws, taskId));
    expect(ctx.template).toBe("assistant");
    expect(ctx.tools.map((t) => t.name)).toEqual(["mcp_call", "notify", "submit_report", "finish", "team_post", "team_wait", "ask_user"]);
    expect(ctx.mcpTools.map((t) => `${t.connector}.${t.tool}:${t.classification}`)).toEqual([
      "bank.register_payee:write",
      "store.get_inventory:read",
      "supplier.list_products:read",
      "supplier.place_order:write",
    ]);
    expect(ctx.policySummary[1]).toBe("bank.register_payee・supplier.place_order は、利用者の確認のあとで実行されます");
    expect(ctx.formation?.isSpokesperson).toBe(true);
    expect(ctx.formation?.position).toBe(2);
  });

  it("オーナーの owner は web の付与がなければ web_* を渡さない／無効のコネクタ・確認待ちのツールは見せない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { kind: "owner" });
    await seedShopConnectors(db, ws, { disabled: ["bank"] });
    await db.query("UPDATE connector_tools SET status = 'needs_review' WHERE workspace_id = $1 AND name = 'list_products'", [ws.workspaceId]);
    const supplier = await seedAgent(db, ws, supplierDefinition());
    const taskId = await seedTask(db, ws, supplier, "reorder");
    const { edge } = buildEdge(db);
    const ctx = await edge.getTaskContext(await tokenFor(db, ws, taskId));
    expect(ctx.mcpTools.map((t) => `${t.connector}.${t.tool}`)).toEqual(["store.get_inventory", "supplier.place_order"]);
    expect(ctx.formation).toBeNull();
    expect(ctx.tools.map((t) => t.name)).not.toContain("web_search");
  });

  it("CH-02・BR-71 受け渡し：前の段の報告を渡し、汚染の印を付ける", async () => {
    const { db } = T();
    const { ws, inbox, supplier, ask } = await chain(db);
    const inboxTask = await seedTask(db, ws, inbox, "read-supplier-mail", { ask, memberName: "受信箱係", status: "running" });
    const inboxTaint = {
      tainted: true,
      sources: [{ kind: "mcp_read" as const, connectorId: "c1", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: T0.toISOString() }],
    };
    await db.query(
      `UPDATE tasks SET status = 'completed', status_detail = 'report', finished_at = $2, report = $3, report_title = 'メールの要約', report_kind = 'normal',
              tainted = true, taint_sources = $4 WHERE id = $1`,
      [inboxTask, T0, "新しいメール3通。うち1通は値上げの知らせ。", inboxTaint.sources],
    );
    const taint = taintFromInputs([{ taskId: inboxTask, agentName: "受信箱係", taint: inboxTaint }], T0.toISOString());
    const taskId = await seedTask(db, ws, supplier, "reorder", { ask, memberName: "仕入れ係", inputTaskIds: [inboxTask], taint });
    const { edge } = buildEdge(db);
    const ctx = await edge.getTaskContext(await tokenFor(db, ws, taskId));
    expect(ctx.input.handoffs).toEqual([{ fromAgentName: "受信箱係", fromTaskId: inboxTask, tainted: true, body: "新しいメール3通。うち1通は値上げの知らせ。" }]);
  });

  it("BD-08 runner に渡る値（依頼の本文・受け渡し）に秘密情報のパターンを入れない", async () => {
    const { db } = T();
    const { ws, inbox, ask } = await chain(db);
    const taskId = await seedTask(db, ws, inbox, "read-supplier-mail", {
      ask,
      memberName: "受信箱係",
      prompt: "このキー sk-abcdefghijklmnopqrstuvwx を使って",
    });
    const { edge } = buildEdge(db);
    const ctx = await edge.getTaskContext(await tokenFor(db, ws, taskId));
    expect(ctx.input.prompt).toBe("このキー [REDACTED] を使って");
  });

  it("仮想の時計（virtualNow）があればその時刻を「今」にする", async () => {
    const { db } = T();
    const { ws, inbox } = await chain(db);
    const taskId = await seedTask(db, ws, inbox, "read-supplier-mail");
    const { edge } = buildEdge(db, { extra: { virtualNow: async () => "2026-10-07T18:00:00+09:00" } });
    const ctx = await edge.getTaskContext(await tokenFor(db, ws, taskId));
    expect(ctx.now).toBe("2026-10-07T18:00:00+09:00");
  });

  it("SO §3.10：トークンが違う・空・期限切れ（ちょうど）→ UNAUTHORIZED、終了・Kill Switch → TASK_HALTED", async () => {
    const { db } = T();
    const { ws, inbox } = await chain(db);
    const taskId = await seedTask(db, ws, inbox, "read-supplier-mail");
    const token = await tokenFor(db, ws, taskId);
    const { edge, clock } = buildEdge(db);
    await expectEdgeError(edge.getTaskContext("not-a-token"), "UNAUTHORIZED");
    await expectEdgeError(edge.getTaskContext(""), "UNAUTHORIZED");
    // 期限は max_minutes（15）＋5分。ちょうどは無効
    clock.set(T0.getTime() + 20 * 60_000);
    await expectEdgeError(edge.getTaskContext(token), "UNAUTHORIZED");
    clock.set(T0.getTime() + 20 * 60_000 - 1);
    await edge.getTaskContext(token);
    await db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2 WHERE id = $1", [ws.workspaceId, T0]);
    const e = await expectEdgeError(edge.getTaskContext(token), "TASK_HALTED");
    expect(e.details).toMatchObject({ haltReason: "kill_switch" });
  });

  it("15:486 別のワークスペースのタスクはトークンからしか引けない（トークンが自分のタスクとワークスペースを決める）", async () => {
    const { db } = T();
    const a = await chain(db);
    const b = await chain(db);
    const taskA = await seedTask(db, a.ws, a.inbox, "read-supplier-mail");
    const taskB = await seedTask(db, b.ws, b.inbox, "read-supplier-mail");
    const { edge } = buildEdge(db);
    const ctxA = await edge.getTaskContext(await tokenFor(db, a.ws, taskA));
    const ctxB = await edge.getTaskContext(await tokenFor(db, b.ws, taskB));
    expect(ctxA.taskId).toBe(taskA);
    expect(ctxB.taskId).toBe(taskB);
  });
});
