// ワークスペースの分離の試験（db-schema.md §7.4 の T-60・T-61、DB I-41 の複合 FK）。
// 別のワークスペースの行は DB の FK でも指せない（リポジトリ層が workspace_id で絞り忘れても、つなぎ間違いは入らない）
import { describe, expect, it } from "vitest";
import { isForeignKeyViolation, type Db } from "./client.ts";
import { issueSession, resolveSession } from "./session.ts";
import { stopWorkspaceForCleanup } from "./system/cleanup.ts";
import {
  fxAgent,
  fxAsk,
  fxConnector,
  fxIntent,
  fxTask,
  fxWorkspace,
  useTestDb,
} from "./testing.ts";
import { getWorkspace } from "./workspace.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");

async function twoWorkspaces(db: Db) {
  const a = await fxWorkspace(db);
  const b = await fxWorkspace(db);
  const agentA = await fxAgent(db, a, { name: "A係" });
  const agentB = await fxAgent(db, b, { name: "B係" });
  const connA = await fxConnector(db, a);
  const connB = await fxConnector(db, b);
  return { a, b, agentA, agentB, connA, connB };
}

async function expectFk(p: Promise<unknown>, name: string): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(isForeignKeyViolation(e, name), `${name} で止まるはず：${String((e as Error | null)?.message)}`).toBe(true);
}

describe("別のワークスペースの行を指せない（複合 FK）", () => {
  it("A のタスクに B のエージェント・スナップショット・仕事・依頼は付けられない", async () => {
    const { db } = T();
    const { a, b, agentA, agentB } = await twoWorkspaces(db);
    await expectFk(fxTask(db, a, { ...agentA, agentId: agentB.agentId }), "tasks_agent_fk");
    await expectFk(fxTask(db, a, { ...agentA, snapshotId: agentB.snapshotId }), "tasks_agent_snapshot_fk");
    await expectFk(fxTask(db, a, { ...agentA, jobId: agentB.jobId }), "tasks_job_fk");
    const { askId } = await fxAsk(db, b);
    await expectFk(fxTask(db, a, agentA, { askId }), "tasks_ask_fk");
    await fxTask(db, a, agentA);
  });

  it("A の Intent に B のタスク・コネクタ、A の承認に B の Intent は付けられない", async () => {
    const { db } = T();
    const { a, b, agentA, agentB, connA, connB } = await twoWorkspaces(db);
    const taskA = await fxTask(db, a, agentA);
    const taskB = await fxTask(db, b, agentB);
    await expectFk(fxIntent(db, a, { taskId: taskB.taskId, jobId: agentA.jobId, connectorId: connA.connectorId }), "action_intents_task_fk");
    await expectFk(fxIntent(db, a, { taskId: taskA.taskId, jobId: agentA.jobId, connectorId: connB.connectorId }), "action_intents_connector_fk");
    const intentB = await fxIntent(db, b, { taskId: taskB.taskId, jobId: agentB.jobId, connectorId: connB.connectorId });
    await expectFk(
      db.query(
        "INSERT INTO approvals (workspace_id, task_id, intent_id, risk_level, risk_score, approver_ids, expires_at) VALUES ($1, $2, $3, 'low', 1, $4, now())",
        [a.workspaceId, taskA.taskId, intentB.intentId, [a.userId]],
      ),
      "approvals_intent_fk",
    );
  });
});

describe("T-60・T-61（DB の範囲）", () => {
  it("T-60 セッションは自分のワークスペースの文脈だけを返し、その文脈では別のワークスペースの行は「ない」", async () => {
    const { db } = T();
    const { a, b } = await twoWorkspaces(db);
    const sA = await issueSession(db, { workspaceId: a.workspaceId, userId: a.userId, ipHash: null, userAgent: null, now: NOW });
    const ctxA = await resolveSession(db, sA.cookieValue, NOW);
    expect(ctxA?.workspaceId).toBe(a.workspaceId);
    if (!ctxA) return;
    // リポジトリ層の書き方（README）：ID で引くときも workspace_id で絞る → 別のワークスペースの ID は null（404）
    const agentOfB = await db.query("SELECT id FROM agents WHERE id = $2 AND workspace_id = $1", [
      ctxA.workspaceId,
      (await db.query<{ id: string }>("SELECT id FROM agents WHERE workspace_id = $1", [b.workspaceId])).rows[0]?.id,
    ]);
    expect(agentOfB.rows).toEqual([]);
    expect((await getWorkspace(db, ctxA))?.id).toBe(a.workspaceId);
  });

  it("T-61 A を止めても（Kill Switch）、B の kill_switch_engaged・タスクは変わらない", async () => {
    const { db } = T();
    const { a, b, agentA, agentB } = await twoWorkspaces(db);
    const tA = await fxTask(db, a, agentA);
    const tB = await fxTask(db, b, agentB);
    await db.transaction((tx) => stopWorkspaceForCleanup(tx, a.ctx, NOW));
    const ws = await db.query<{ id: string; kill_switch_engaged: boolean }>("SELECT id, kill_switch_engaged FROM workspaces WHERE id = ANY($1::uuid[])", [
      [a.workspaceId, b.workspaceId],
    ]);
    expect(Object.fromEntries(ws.rows.map((r) => [r.id, r.kill_switch_engaged]))).toEqual({ [a.workspaceId]: true, [b.workspaceId]: false });
    const tasks = await db.query<{ id: string; status: string }>("SELECT id, status FROM tasks WHERE id = ANY($1::uuid[])", [[tA.taskId, tB.taskId]]);
    expect(Object.fromEntries(tasks.rows.map((r) => [r.id, r.status]))).toEqual({ [tA.taskId]: "halted", [tB.taskId]: "running" });
  });
});
