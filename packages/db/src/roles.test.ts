// DB のロールの権限の試験（SO §4.6、DB I-31、roles.sql）。ロールのメンバーのログイン用の利用者でつないで確かめる
import { describe, expect, it } from "vitest";
import { appendAuditLog } from "./audit.ts";
import { PG_ERROR, pgErrorInfo, type Db } from "./client.ts";
import { getApprovalOfIntent, listKernelDecisionsOfIntent, listKillSwitchEngagedSeqs, listTaskAuditEvents } from "./repo/gateway.ts";
import { fxAgent, fxApproval, fxConnector, fxIntent, fxTask, fxWorkspace, openRoleDb, useTestDb, type AppRole } from "./testing.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");

async function asRole<R>(role: AppRole, fn: (db: Db) => Promise<R>): Promise<R> {
  const db = await openRoleDb(T().url, role);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}
async function expectDenied(p: Promise<unknown>): Promise<void> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(pgErrorInfo(e)?.code, String((e as Error | null)?.message)).toBe(PG_ERROR.insufficientPrivilege);
}

describe("ot_app（app）", () => {
  it("業務の表は読み書きでき、監査ログは追記だけ。ワークスペース・利用者は消せない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    const agent = await fxAgent(db, ws);
    await asRole("ot_app", async (app) => {
      const { taskId } = await fxTask(app, ws, agent);
      await app.query("UPDATE tasks SET steps_used = 1 WHERE id = $1", [taskId]);
      const row = await app.transaction((tx) =>
        appendAuditLog(tx, ws.workspaceId, { eventType: "task.created", actorType: "user", actorId: ws.userId, taskId, payload: { taskId } }, NOW),
      );
      expect(row.seq).toBe(2);
      await expectDenied(app.query("UPDATE audit_logs SET actor_id = 'x' WHERE workspace_id = $1", [ws.workspaceId]));
      await expectDenied(app.query("DELETE FROM audit_logs WHERE workspace_id = $1", [ws.workspaceId]));
      await expectDenied(app.query("DELETE FROM workspaces WHERE id = $1", [ws.workspaceId]));
      await expectDenied(app.query("DELETE FROM users WHERE id = $1", [ws.userId]));
      await expectDenied(app.query("UPDATE agent_snapshots SET warnings = '[]' WHERE id = $1", [agent.snapshotId]));
      await expectDenied(app.query("SELECT * FROM schema_migrations"));
      await expectDenied(app.query("DELETE FROM entry_attempts"));
    });
  });
});

describe("ot_gateway（gateway）", () => {
  it("Intent・承認・タスクを更新し、監査ログ・判定を足せる。DELETE・タスクの作成・セッションの読み取りはできない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    const agent = await fxAgent(db, ws);
    const conn = await fxConnector(db, ws);
    const { taskId } = await fxTask(db, ws, agent, { status: "awaiting_approval" });
    const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "approved" });
    await asRole("ot_gateway", async (gw) => {
      await gw.transaction(async (tx) => {
        // ロックの順：ワークスペース → タスク → Intent（M-21）
        await tx.query("SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [ws.workspaceId]);
        await tx.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [taskId]);
        await tx.query("SELECT id FROM action_intents WHERE id = $1 FOR UPDATE", [intentId]);
        await tx.query("UPDATE action_intents SET status = 'executing', updated_at = now() WHERE id = $1", [intentId]);
        await appendAuditLog(tx, ws.workspaceId, { eventType: "action.executed", actorType: "system", actorId: "gateway", taskId, payload: { intentId } }, NOW);
      });
      await gw.query(
        `INSERT INTO policy_decisions (workspace_id, task_id, intent_id, subject_kind, subject, counters, flags, decision, reason_code, inputs_hash, kernel_version)
         VALUES ($1, $2, $3, 'tool_call', '{}', '{}', '{}', 'allow', 'rule_matched', $4, '0.1.0')`,
        [ws.workspaceId, taskId, intentId, "c".repeat(64)],
      );
      await gw.query("UPDATE connector_tools SET status = 'needs_review', pending = NULL WHERE connector_id = $1", [conn.connectorId]);
      await expectDenied(gw.query("DELETE FROM action_intents WHERE id = $1", [intentId]));
      await expectDenied(fxTask(gw, ws, agent));
      await expectDenied(gw.query("SELECT * FROM sessions"));
      await expectDenied(gw.query("UPDATE workspaces SET kill_switch_engaged = false WHERE id = $1", [ws.workspaceId]));
      await expectDenied(gw.query("UPDATE audit_logs SET actor_id = 'x'"));
    });
  });
});

describe("ot_gateway の出どころの照合（SG-03）", () => {
  it("判定の行・承認の行・監査ログ（タスク・Kill Switch・合格証）・合格証を gateway のロールで読める（gateway 自身の判定の記録は Kernel の判定に入れない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    const agent = await fxAgent(db, ws);
    const conn = await fxConnector(db, ws);
    const { taskId } = await fxTask(db, ws, agent, { status: "awaiting_approval" });
    const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "approved" });
    const { approvalId } = await fxApproval(db, ws, { taskId, intentId, status: "approved" });
    for (const gate of [null, "gateway"]) {
      await db.query(
        `INSERT INTO policy_decisions (workspace_id, task_id, intent_id, subject_kind, subject, counters, flags, decision, reason_code, inputs_hash, kernel_version)
         VALUES ($1, $2, $3, 'tool_call', $4, '{}', '{}', 'approve', 'approval_required', $5, '0.1.0')`,
        [ws.workspaceId, taskId, intentId, gate === null ? {} : { gate }, "c".repeat(64)],
      );
    }
    await db.transaction((tx) =>
      appendAuditLog(tx, ws.workspaceId, { eventType: "approval.decided", actorType: "user", actorId: ws.userId, taskId, payload: { approvalId, intentId, decision: "approve" } }, NOW),
    );
    await db.transaction((tx) => appendAuditLog(tx, ws.workspaceId, { eventType: "killswitch.engaged", actorType: "user", actorId: ws.userId, payload: {} }, NOW));
    await asRole("ot_gateway", async (gw) => {
      const decisions = await listKernelDecisionsOfIntent(gw, ws.ctx, { id: intentId, task_id: taskId });
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.subject).toEqual({});
      expect((await getApprovalOfIntent(gw, ws.ctx, intentId))?.id).toBe(approvalId);
      const audits = await listTaskAuditEvents(gw, ws.ctx, taskId);
      expect(audits.map((a) => [a.event_type, a.payload])).toEqual([["approval.decided", { approvalId, intentId, decision: "approve" }]]);
      expect(await listKillSwitchEngagedSeqs(gw, ws.ctx)).toEqual([audits[0]!.seq + 1]);
    });
  });
});

describe("ot_retention（掃除）", () => {
  it("古い入口の試行・冪等性のキー・SSE の事象だけを消せる。ワークスペース・利用者・業務の表は消せない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const agent = await fxAgent(db, ws);
    await asRole("ot_retention", async (m) => {
      await m.query("DELETE FROM entry_attempts WHERE created_at < now() - interval '1 day'");
      await m.query("DELETE FROM idempotency_keys WHERE created_at < now() - interval '1 day'");
      await m.query("DELETE FROM workspace_events WHERE created_at < now() - interval '1 day'");
      await expectDenied(m.query("DELETE FROM agents WHERE id = $1", [agent.agentId]));
      await expectDenied(m.query("INSERT INTO users (login) VALUES ('x')"));
      await expectDenied(m.query("DELETE FROM workspaces WHERE id = $1", [ws.workspaceId]));
      await expectDenied(m.query("DELETE FROM users WHERE id = $1", [ws.userId]));
      await expectDenied(m.query("SELECT * FROM audit_logs"));
    });
  });
});
