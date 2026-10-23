// WorkspaceDO が Workflow を起動できなかったときと、TaskRunWorkflow の finish のやり直し（レビューの指摘）：
// - 編成の Workflow を起動できなければ、依頼を generating のまま残さず failed（planner_error）にする
// - 担当の Workflow を起動できなければ、そのタスクを閉じたうえで、残りの queued のタスクももう一度見る
// - taskFinished を2回呼んでも、段の終わりの事象（ask.step.finished）は1回だけ
// Workflow の binding は DO の env を差し替えて失敗させる（runInDurableObject の instance）
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, count, run, wsDbOf } from "../src/db/sqlite.ts";
import type { WorkspaceDO } from "../src/workspace-do.ts";
import { fxAgent, fxAsk, fxAskMember, fxAskRun, fxTask, fxWorkspace } from "./db/fixtures.ts";
import { fxPolicy } from "./asks/helpers.ts";

const NOW = new Date("2026-10-22T09:00:00.000Z");
const failing = { create: async () => Promise.reject(new Error("Workflows が一時的に使えない")) };

/** DO の env の Workflow の binding を差し替える（試験だけ。env は DurableObject の protected） */
function breakWorkflows(instance: WorkspaceDO, names: ReadonlyArray<"PLAN_ASK" | "TASK_RUN">): void {
  const e = (instance as unknown as { env: Record<string, unknown> }).env;
  for (const n of names) e[n] = failing;
}

describe("Workflow を起動できなかったとき", () => {
  it("編成の Workflow を起動できなければ、依頼は failed（planner_error）で閉じる", async () => {
    const stub = env.WORKSPACE.get(env.WORKSPACE.newUniqueId());
    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const db = wsDbOf(state.storage);
      const ws = fxWorkspace(db);
      fxPolicy(db, NOW);
      breakWorkflows(instance, ["PLAN_ASK"]);
      const r = await instance.acceptAsk({ userId: ws.userId, body: { text: "在庫を見て" }, idem: null, now: NOW });
      expect(r.ok).toBe(true);
      const askId = r.ok ? r.body.ask.id : "";
      expect(all<{ status: string; failure_reason: string }>(db, {}, "SELECT status, failure_reason FROM asks WHERE id = ?", askId)).toEqual([
        { status: "failed", failure_reason: "planner_error" },
      ]);
      expect(count(db, "SELECT count(*) FROM workspace_events WHERE type = 'ask.failed'")).toBe(1);
    });
  });

  it("担当の Workflow を起動できなければ、そのタスクを閉じ、空いた枠で次の queued のタスクも見る（同時に1件まで）", async () => {
    const stub = env.WORKSPACE.get(env.WORKSPACE.newUniqueId());
    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const db = wsDbOf(state.storage);
      const ws = fxWorkspace(db, { maxConcurrentTasks: 1 });
      const a = fxAgent(db, { name: "受信箱係" });
      const b = fxAgent(db, { name: "仕入れ係" });
      const { askId } = fxAsk(db, ws, { status: "running", shape: "parallel" });
      const m1 = fxAskMember(db, { askId, agent: a, position: 1 }).memberId;
      const m2 = fxAskMember(db, { askId, agent: b, position: 2 }).memberId;
      const { askRunId } = fxAskRun(db, askId);
      const t1 = fxTask(db, ws, a, { status: "queued", askId, askRunId, now: NOW }).taskId;
      const t2 = fxTask(db, ws, b, { status: "queued", askId, askRunId, now: new Date(NOW.getTime() + 1000) }).taskId;
      run(db, "UPDATE tasks SET ask_member_id = ? WHERE id = ?", m1, t1);
      run(db, "UPDATE tasks SET ask_member_id = ? WHERE id = ?", m2, t2);
      breakWorkflows(instance, ["TASK_RUN"]);
      await (instance as unknown as { startTasks(): Promise<void> }).startTasks();
      // 1件目の起動の失敗のあと、もう一度見て2件目も取る（どちらも起動できないので閉じる）。queued のまま残さない
      expect(count(db, "SELECT count(*) FROM tasks WHERE status = 'queued'")).toBe(0);
      expect(all<{ status: string }>(db, {}, "SELECT status FROM tasks ORDER BY queued_at").map((t) => t.status)).toEqual(["failed", "failed"]);
    });
  });
});

describe("taskFinished のやり直し", () => {
  it("2回呼んでも、段の終わりの事象は1回だけ", async () => {
    const stub = env.WORKSPACE.get(env.WORKSPACE.newUniqueId());
    await runInDurableObject(stub, async (instance: WorkspaceDO, state) => {
      const db = wsDbOf(state.storage);
      const ws = fxWorkspace(db);
      const a = fxAgent(db, { name: "受信箱係" });
      const { askId } = fxAsk(db, ws, { status: "running", shape: "single" });
      const m = fxAskMember(db, { askId, agent: a, position: 1, isSpokesperson: true }).memberId;
      const { askRunId } = fxAskRun(db, askId);
      const taskId = fxTask(db, ws, a, { status: "running", askId, askRunId, now: NOW }).taskId;
      run(db, "UPDATE tasks SET ask_member_id = ? WHERE id = ?", m, taskId);
      await instance.taskFinished(taskId, "finished");
      await instance.taskFinished(taskId, "finished");
      expect(count(db, "SELECT count(*) FROM workspace_events WHERE type = 'ask.step.finished'")).toBe(1);
    });
  });
});
