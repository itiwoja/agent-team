// edgeCallTool・edgePostEvents・finishTaskRun・haltQueuedTask の試験
// （packages/edge/src/tools.test.ts・events.test.ts の WorkspaceDO 版と、apps/app/src/asks/run.ts の executeTask の前後の処理）。
// mcp_call の読み取り（gateway）は 4e、Web・連絡板は 4f 以降なので、その試験は「まだ使えない」ことだけを確かめる
import type { ProgressEvent } from "@open-team/runner";
import { describe, expect, it } from "vitest";
import { insertAgentSkill } from "../../src/db/repo/sandbox.ts";
import { all, one, run, type WsDb } from "../../src/db/sqlite.ts";
import { MCP_READ_NOT_AVAILABLE_TEXT } from "../../src/edge/tools.ts";
import { edgeCallTool, edgePostEvents, edgeTaskContext, finishTaskRun, haltQueuedTask } from "../../src/edge/task-edge.ts";
import { inWorkspace, type FxWorkspace } from "../db/fixtures.ts";
import { ORDER, T0, USAGE, buildEdge, call, expectEdgeError, llmRequest, mcp, report, seedAgent, seedChainAsk, seedConnectors, seedTask, supplierDefinition } from "./seed.ts";

function setup(db: WsDb, ws: FxWorkspace, o: { script?: NonNullable<Parameters<typeof buildEdge>[1]>["script"]; spokesperson?: boolean; knownSecrets?: string[]; status?: "queued" | "running" } = {}) {
  seedConnectors(db);
  const agent = seedAgent(db, supplierDefinition());
  const ask = o.spokesperson === undefined ? undefined : seedChainAsk(db, ws, [{ agent, jobSlug: "reorder", position: 1, spokesperson: o.spokesperson }]);
  const taskId = seedTask(db, ws, agent, "reorder", ask ? { ask, memberName: agent.name } : {});
  const env = buildEdge(db, { ...(o.script ? { script: o.script } : {}), ...(o.knownSecrets ? { knownSecrets: o.knownSecrets } : {}) });
  const ctx = edgeTaskContext(db, env.rt, taskId, T0);
  return { agent, ask, taskId, env, ctx };
}

const taskOf = (db: WsDb, taskId: string) =>
  one<{ status: string; status_detail: string | null; report: string | null; report_kind: string | null; report_sources: string | null; fail_reason: string | null; halt_reason: string | null; tainted: number; finished_at: string | null }>(
    db,
    {},
    "SELECT * FROM tasks WHERE id = ?",
    taskId,
  )!;

describe("edgeCallTool：実行してよい呼び出しだけ（§3.11-2）", () => {
  it("HL-18 判定の記録がない・allow でない・Intent にした書き込み・実行済み → TOOL_CALL_NOT_ALLOWED。mcp_call の読み取りは「まだ使えない」文（汚染しない）", async () => {
    await inWorkspace(async (db, ws) => {
      const w = setup(db, ws, { script: [{ parts: [mcp("r1", "store", "get_inventory", {}), call("d1", "remember", { content: "x" }), mcp("w1", "supplier", "place_order", ORDER)], usage: USAGE }] });
      await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      for (const id of ["nope", "d1", "w1"]) await expectEdgeError(() => edgeCallTool(db, w.env.rt, w.taskId, id, T0), "TOOL_CALL_NOT_ALLOWED");
      expect(edgeCallTool(db, w.env.rt, w.taskId, "r1", T0)).toEqual({ kind: "text", text: MCP_READ_NOT_AVAILABLE_TEXT });
      expect(taskOf(db, w.taskId).tainted).toBe(0);
      const again = await expectEdgeError(() => edgeCallTool(db, w.env.rt, w.taskId, "r1", T0), "TOOL_CALL_NOT_ALLOWED");
      expect(again.details).toMatchObject({ reason: "already_executed" });
    });
  });

  it("4c で動かさない道具（team_post・web_search）は判定が allow でも TOOL_CALL_NOT_ALLOWED", async () => {
    await inWorkspace(async (db, ws) => {
      const w = setup(db, ws, {
        spokesperson: true,
        script: [{ parts: [call("t1", "team_post", { to: "all", kind: "share", body: "x" }), call("s1", "web_search", { query: "豆", max_results: 3 })], usage: USAGE }],
      });
      await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      await expectEdgeError(() => edgeCallTool(db, w.env.rt, w.taskId, "t1", T0), "TOOL_CALL_NOT_ALLOWED");
      await expectEdgeError(() => edgeCallTool(db, w.env.rt, w.taskId, "s1", T0), "TOOL_CALL_NOT_ALLOWED");
    });
  });

  it("notify はアプリ内に残す（task_events の message。マスク・上限）", async () => {
    await inWorkspace(async (db, ws) => {
      const w = setup(db, ws, { script: [{ parts: [call("n1", "notify", { title: "在庫が少ない".repeat(20), body: "豆が残り2kg", priority: "high" })], usage: USAGE }] });
      await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      expect(edgeCallTool(db, w.env.rt, w.taskId, "n1", T0)).toEqual({ kind: "text", text: "通知を送りました。" });
      const ev = JSON.parse(one<{ payload: string }>(db, {}, "SELECT payload FROM task_events WHERE task_id = ? AND type = 'message'", w.taskId)!.payload);
      expect(ev).toMatchObject({ via: "notify", body: "豆が残り2kg", priority: "high" });
      expect([...(ev.title as string)].length).toBe(60);
    });
  });

  it("load_skill：信頼の表にないスキルは <untrusted> で包み、タスクを skill で汚染する", async () => {
    await inWorkspace(async (db, ws) => {
      seedConnectors(db);
      const agent = seedAgent(db, supplierDefinition());
      insertAgentSkill(db, { agentId: agent.agentId, name: "発注の手順", description: "発注のしかた", body: "まず在庫を見る", packId: "cafe-pack", now: T0 });
      const taskId = seedTask(db, ws, agent, "reorder");
      const env = buildEdge(db, { script: [{ parts: [call("k1", "load_skill", { name: "発注の手順" })], usage: USAGE }] });
      const ctx = edgeTaskContext(db, env.rt, taskId, T0);
      expect(ctx.tools.map((t) => t.name)).toContain("load_skill");
      // 信頼の表が空なので、システムプロンプトの「使えるスキル」には出さない
      expect(ctx.agent.skills).toEqual([]);
      await env.llmMessages(taskId, llmRequest(ctx.tools));
      const w = { env, taskId };
      const out = edgeCallTool(db, w.env.rt, w.taskId, "k1", T0);
      expect(out.kind === "text" ? out.text : "").toContain('<untrusted source="skill:発注の手順">');
      expect(taskOf(db, w.taskId).tainted).toBe(1);
    });
  });
});

describe("edgeCallTool：submit_report（API-056・§3.12）", () => {
  it("報告を保存（マスク・出典）、監査ログ task.report_submitted、Intent がなければ completed(report)。以後の呼び出しは UNAUTHORIZED（BD-06）", async () => {
    await inWorkspace(async (db, ws) => {
      const sources = [
        { kind: "mcp", connector: "store", tool: "get_inventory", label: "在庫" },
        { kind: "url", url: "https://example.com/beans", title: "相場" },
      ];
      const w = setup(db, ws, {
        spokesperson: false,
        knownSecrets: ["super-secret-value-123"],
        script: [{ parts: [report("s1", { title: "在庫の報告", body: "在庫は十分です。super-secret-value-123", sources, kind: "answer" })], usage: USAGE }],
      });
      await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      expect(edgeCallTool(db, w.env.rt, w.taskId, "s1", T0)).toEqual({ kind: "report_accepted", taskId: w.taskId });
      const t = taskOf(db, w.taskId);
      // 窓口でない担当は LLM が kind: answer を付けても normal（§8-13）
      expect(t).toMatchObject({ status: "completed", status_detail: "report", report: "在庫は十分です。[REDACTED]", report_kind: "normal" });
      expect(JSON.parse(t.report_sources!)).toEqual(sources);
      const audit = all<{ payload: string }>(db, {}, "SELECT payload FROM audit_logs WHERE event_type = 'task.report_submitted'");
      expect(JSON.parse(audit[0]!.payload)).toMatchObject({ taskId: w.taskId, kind: "normal", sourcesCount: 2 });
      expect(audit[0]!.payload).not.toContain("在庫は十分です");
      await expectEdgeError(() => w.env.llmMessages(w.taskId, llmRequest([])), "UNAUTHORIZED");
    });
  });

  it("AN-04 窓口の報告は answer。承認待ちの Intent があれば awaiting_approval", async () => {
    await inWorkspace(async (db, ws) => {
      const w = setup(db, ws, { spokesperson: true, script: [{ parts: [mcp("w1", "supplier", "place_order", ORDER), report("s1")], usage: USAGE }] });
      await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      edgeCallTool(db, w.env.rt, w.taskId, "s1", T0);
      expect(taskOf(db, w.taskId)).toMatchObject({ status: "awaiting_approval", report_kind: "answer", finished_at: null });
    });
  });

  it("引数が正しくない（title が空）→ VALIDATION_ERROR、報告は保存しない", async () => {
    await inWorkspace(async (db, ws) => {
      const w = setup(db, ws, { script: [{ parts: [report("s1", { title: "  " })], usage: USAGE }] });
      await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      await expectEdgeError(() => edgeCallTool(db, w.env.rt, w.taskId, "s1", T0), "VALIDATION_ERROR");
      expect(taskOf(db, w.taskId)).toMatchObject({ report: null, status: "running" });
    });
  });
});

describe("edgePostEvents（API-038）", () => {
  const msg = (i: number): ProgressEvent => ({ type: "message", payload: { text: `m${i}` } });

  it("rt:152 毎秒10件まで、超えた分は dropped。1回20件まで。マスク・上限・by: runner・ハートビート", async () => {
    await inWorkspace((db, ws) => {
      const w = setup(db, ws);
      expect(edgePostEvents(db, w.env.rt, w.taskId, Array.from({ length: 8 }, (_, i) => msg(i)), T0)).toEqual({ accepted: 8, dropped: 0 });
      expect(edgePostEvents(db, w.env.rt, w.taskId, Array.from({ length: 5 }, (_, i) => msg(i)), T0)).toEqual({ accepted: 2, dropped: 3 });
      const later = new Date(T0.getTime() + 1_000);
      expect(edgePostEvents(db, w.env.rt, w.taskId, Array.from({ length: 25 }, (_, i) => msg(i)), later)).toEqual({ accepted: 10, dropped: 15 });
      const at = new Date(T0.getTime() + 30_000);
      edgePostEvents(
        db,
        w.env.rt,
        w.taskId,
        [
          { type: "tool_called", payload: { toolCallId: "c1", name: "mcp_call", resultSummary: "あ".repeat(600) } },
          { type: "message", payload: { text: "鍵は sk-abcdefghijklmnopqrstuv です" } },
        ],
        at,
      );
      const rows = all<{ type: string; payload: string }>(db, {}, "SELECT type, payload FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 2", w.taskId).map((r) => JSON.parse(r.payload));
      expect(rows[0]).toEqual({ text: "鍵は [REDACTED] です", by: "runner" });
      expect([...(rows[1].resultSummary as string)].length).toBe(500);
      expect(one<{ last_heartbeat_at: string }>(db, {}, "SELECT last_heartbeat_at FROM tasks WHERE id = ?", w.taskId)!.last_heartbeat_at).toBe(at.toISOString());
    });
  });

  it("形が違う進捗は VALIDATION_ERROR", async () => {
    await inWorkspace(async (db, ws) => {
      const w = setup(db, ws);
      await expectEdgeError(() => edgePostEvents(db, w.env.rt, w.taskId, [{ type: "unknown", payload: {} }], T0), "VALIDATION_ERROR");
    });
  });

  it("HL-03 finished(no_change) → failed(agent_no_change)、承認待ちの Intent は expired(task_ended)。finished は毎秒の上限に数えない", async () => {
    await inWorkspace(async (db, ws) => {
      const w = setup(db, ws, { script: [{ parts: [mcp("w1", "supplier", "place_order", { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 2, unit_price: 1800 }] })], usage: USAGE }] });
      await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      edgePostEvents(db, w.env.rt, w.taskId, Array.from({ length: 10 }, (_, i) => msg(i)), T0);
      expect(edgePostEvents(db, w.env.rt, w.taskId, [{ type: "finished", payload: { outcome: "no_change", reason: "発注は要りません" } }], T0)).toEqual({ accepted: 1, dropped: 0 });
      expect(taskOf(db, w.taskId)).toMatchObject({ status: "failed", fail_reason: "agent_no_change" });
      expect(all(db, {}, "SELECT status, expire_reason FROM action_intents WHERE task_id = ?", w.taskId)).toEqual([{ status: "expired", expire_reason: "task_ended" }]);
      expect(all(db, {}, "SELECT status FROM approvals WHERE task_id = ?", w.taskId)).toEqual([{ status: "expired" }]);
      await expectEdgeError(() => w.env.llmMessages(w.taskId, llmRequest([])), "TASK_HALTED");
    });
  });
});

describe("TaskWorkflow の前後（finishTaskRun・haltQueuedTask）", () => {
  it("finishTaskRun：running で残ったタスクは failed（ended が llm_unavailable なら llm_unavailable、ほかは agent_unable）、ask.step.finished を出す", async () => {
    await inWorkspace((db, ws) => {
      const a = setup(db, ws, { spokesperson: true });
      const after = finishTaskRun(db, a.taskId, "halted", T0);
      expect(after).toMatchObject({ status: "failed", fail_reason: "agent_unable" });
      const ev = all<{ data: string }>(db, {}, "SELECT data FROM workspace_events WHERE type = 'ask.step.finished'").map((r) => JSON.parse(r.data));
      expect(ev).toEqual([expect.objectContaining({ askId: a.ask!.askId, taskId: a.taskId, memberId: a.ask!.members["仕入れ係"], agentName: "仕入れ係" })]);
      const b = seedTask(db, ws, a.agent, "reorder", { status: "running" });
      expect(finishTaskRun(db, b, "llm_unavailable", T0)).toMatchObject({ status: "failed", fail_reason: "llm_unavailable" });
    });
  });

  it("finishTaskRun：aborted・終了状態・awaiting_approval は状態を変えない。見つからなければ null", async () => {
    await inWorkspace((db, ws) => {
      const a = setup(db, ws);
      expect(finishTaskRun(db, a.taskId, "aborted", T0)).toMatchObject({ status: "running" });
      run(db, "UPDATE tasks SET status = 'awaiting_approval' WHERE id = ?", a.taskId);
      expect(finishTaskRun(db, a.taskId, "error", T0)).toMatchObject({ status: "awaiting_approval" });
      expect(finishTaskRun(db, "no-such-task", "error", T0)).toBeNull();
    });
  });

  it("haltQueuedTask：queued のときだけ halted（kill_switch／budget_exceeded／timeout）。ほかは触らない", async () => {
    await inWorkspace((db, ws) => {
      seedConnectors(db);
      const agent = seedAgent(db, supplierDefinition());
      const k = seedTask(db, ws, agent, "reorder");
      const b = seedTask(db, ws, agent, "reorder");
      const t = seedTask(db, ws, agent, "reorder");
      const r = seedTask(db, ws, agent, "reorder", { status: "running" });
      haltQueuedTask(db, k, "kill_switch", T0);
      haltQueuedTask(db, b, "budget", T0);
      haltQueuedTask(db, t, "timeout", T0);
      haltQueuedTask(db, r, "kill_switch", T0);
      expect([k, b, t, r].map((id) => taskOf(db, id).halt_reason)).toEqual(["kill_switch", "budget_exceeded", "timeout", null]);
      expect(taskOf(db, r).status).toBe("running");
      const budget = all<{ payload: string }>(db, {}, "SELECT payload FROM audit_logs WHERE event_type = 'budget.exceeded'").map((x) => JSON.parse(x.payload));
      expect(budget).toEqual([expect.objectContaining({ taskId: b, scope: "ask_start", gate: "budget" }), expect.objectContaining({ taskId: t, scope: "ask_start", gate: "timeout" })]);
    });
  });
});
