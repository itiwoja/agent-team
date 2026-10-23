// edgeTaskContext（API-036）の試験：running への遷移・本番どおりの文脈・taskId の引き直し・4c で外す道具
// （packages/edge/src/context.test.ts の WorkspaceDO 版。トークンの期限・別のワークスペースの試験は taskId と DO に置き換えた）
import { taintFromInputs } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import { all, one, run, type WsDb } from "../../src/db/sqlite.ts";
import { edgeTaskContext } from "../../src/edge/task-edge.ts";
import { inWorkspace, type FxWorkspace } from "../db/fixtures.ts";
import { T0, buildEdge, expectEdgeError, inboxDefinition, seedAgent, seedChainAsk, seedConnectors, seedTask, supplierDefinition } from "./seed.ts";

function chain(db: WsDb, ws: FxWorkspace) {
  seedConnectors(db);
  const inbox = seedAgent(db, inboxDefinition());
  const supplier = seedAgent(db, supplierDefinition());
  const ask = seedChainAsk(db, ws, [
    { agent: inbox, jobSlug: "read-supplier-mail", position: 1, spokesperson: false },
    { agent: supplier, jobSlug: "reorder", position: 2, spokesperson: true },
  ]);
  return { inbox, supplier, ask };
}

describe("edgeTaskContext（API-036）", () => {
  it("si:43 最初の呼び出しで queued → running（started_at・ハートビート・監査ログ task.status_changed・task_events）。2回目は変えない", async () => {
    await inWorkspace((db, ws) => {
      const { inbox, ask } = chain(db, ws);
      const taskId = seedTask(db, ws, inbox, "read-supplier-mail", { ask, memberName: "受信箱係" });
      const { rt } = buildEdge(db);
      const at = new Date(T0.getTime() + 5_000);
      expect(edgeTaskContext(db, rt, taskId, at).taskId).toBe(taskId);
      const row = one<{ status: string; started_at: string; last_heartbeat_at: string }>(db, {}, "SELECT * FROM tasks WHERE id = ?", taskId)!;
      expect(row).toMatchObject({ status: "running", started_at: at.toISOString(), last_heartbeat_at: at.toISOString() });
      const audit = all<{ payload: string }>(db, {}, "SELECT payload FROM audit_logs WHERE event_type = 'task.status_changed'").map((r) => JSON.parse(r.payload));
      expect(audit).toEqual([expect.objectContaining({ from: "queued", to: "running", taskId })]);
      const ev = all<{ payload: string }>(db, {}, "SELECT payload FROM task_events WHERE task_id = ? AND type = 'status_changed'", taskId).map((r) => JSON.parse(r.payload));
      expect(ev).toEqual([{ from: "queued", to: "running" }]);
      edgeTaskContext(db, rt, taskId, new Date(at.getTime() + 1_000));
      expect(one<{ started_at: string }>(db, {}, "SELECT started_at FROM tasks WHERE id = ?", taskId)!.started_at).toBe(at.toISOString());
    });
  });

  it("PR-04 受信箱係（researcher）：テンプレート・フェーズ・付与した MCP のツール。連絡板・利用者への質問は 4c では外す", async () => {
    await inWorkspace((db, ws) => {
      const { inbox, ask } = chain(db, ws);
      const taskId = seedTask(db, ws, inbox, "read-supplier-mail", { ask, memberName: "受信箱係" });
      const { rt } = buildEdge(db);
      const ctx = edgeTaskContext(db, rt, taskId, T0);
      expect(ctx.template).toBe("researcher");
      expect(ctx.phases.map((p) => p.llmPhase)).toEqual(["investigate", "plan", "report"]);
      // Node 版はこれに team_post・team_wait・ask_user が続く（DEFERRED_TOOLS で外した）
      expect(ctx.tools.map((t) => t.name)).toEqual(["mcp_call", "notify", "submit_report", "finish"]);
      expect(ctx.mcpTools.map((t) => `${t.connector}.${t.tool}:${t.classification}`)).toEqual(["mail.list_inbox:read"]);
      expect(ctx.runKind).toBe("live");
      expect(ctx.agent.name).toBe("受信箱係");
      expect(ctx.input.prompt).toBe("仕入れ先のメールを読んで、在庫を見て、必要なら発注して");
      expect(ctx.input.teamMessages).toEqual([]);
      expect(ctx.limits.maxTokens).toBe(4096);
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
          { name: "受信箱係", position: 1, isAggregator: false, dependsOn: [] },
          { name: "仕入れ係", position: 2, isAggregator: false, dependsOn: [1] },
        ],
      });
    });
  });

  it("PR-05 仕入れ係（窓口）：MCP は読み書き。無効のコネクタ・確認待ちのツールは見せない。書き込みは確認のあと、の要約", async () => {
    await inWorkspace((db, ws) => {
      const { supplier, ask } = chain(db, ws);
      run(db, "UPDATE connector_tools SET status = 'needs_review' WHERE name = 'list_products'");
      const taskId = seedTask(db, ws, supplier, "reorder", { ask, memberName: "仕入れ係" });
      const ctx = edgeTaskContext(db, buildEdge(db).rt, taskId, T0);
      expect(ctx.template).toBe("assistant");
      expect(ctx.mcpTools.map((t) => `${t.connector}.${t.tool}`)).toEqual(["bank.register_payee", "store.get_inventory", "supplier.place_order"]);
      expect(ctx.policySummary[1]).toBe("bank.register_payee・supplier.place_order は、利用者の確認のあとで実行されます");
      expect(ctx.formation?.isSpokesperson).toBe(true);
    });
  });

  it("CH-02・BR-71 受け渡し：前の段の報告を渡し、汚染の印を付ける。秘密情報のパターンはマスクする（BD-08）", async () => {
    await inWorkspace((db, ws) => {
      const { inbox, supplier, ask } = chain(db, ws);
      const inboxTask = seedTask(db, ws, inbox, "read-supplier-mail", { ask, memberName: "受信箱係", status: "running" });
      const sources = [{ kind: "mcp_read", connectorId: "c1", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: T0.toISOString() }];
      run(
        db,
        `UPDATE tasks SET status = 'completed', status_detail = 'report', finished_at = ?, report = ?, report_title = 'メールの要約', report_kind = 'normal',
                tainted = 1, taint_sources = ? WHERE id = ?`,
        T0,
        "新しいメール3通。キー sk-abcdefghijklmnopqrstuvwx",
        sources,
        inboxTask,
      );
      const taint = taintFromInputs([{ taskId: inboxTask, agentName: "受信箱係", taint: { tainted: true, sources: sources as never } }], T0.toISOString());
      const taskId = seedTask(db, ws, supplier, "reorder", { ask, memberName: "仕入れ係", inputTaskIds: [inboxTask], taint });
      const ctx = edgeTaskContext(db, buildEdge(db).rt, taskId, T0);
      expect(ctx.input.handoffs).toEqual([{ fromAgentName: "受信箱係", fromTaskId: inboxTask, tainted: true, body: "新しいメール3通。キー [REDACTED]" }]);
    });
  });

  it("SO §3.10：見つからない・空の taskId → UNAUTHORIZED、終了状態 → TASK_HALTED（状態は変えない）", async () => {
    await inWorkspace(async (db, ws) => {
      const { inbox } = chain(db, ws);
      const taskId = seedTask(db, ws, inbox, "read-supplier-mail");
      const { rt } = buildEdge(db);
      await expectEdgeError(() => edgeTaskContext(db, rt, "no-such-task", T0), "UNAUTHORIZED");
      await expectEdgeError(() => edgeTaskContext(db, rt, "", T0), "UNAUTHORIZED");
      run(db, "UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = ?", T0, taskId);
      const e = await expectEdgeError(() => edgeTaskContext(db, rt, taskId, T0), "TASK_HALTED");
      expect(e.details).toMatchObject({ haltReason: "task_terminated" });
      expect(one<{ status: string }>(db, {}, "SELECT status FROM tasks WHERE id = ?", taskId)!.status).toBe("cancelled");
    });
  });
});
