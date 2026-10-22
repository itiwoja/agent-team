// ON DELETE CASCADE の試験（db-schema.md §7.2 の T-30・T-31、15:375「ゲストの掃除はワークスペースの行を1つ消すだけ」）
import { describe, expect, it } from "vitest";
import { appendAuditLog } from "./audit.ts";
import type { Db } from "./client.ts";
import { insertGoogleCredential, upsertOAuthConnector } from "./repo/credentials.ts";
import { issueSession } from "./session.ts";
import { hashIp, recordEntryAttempt } from "./system/entry.ts";
import {
  fxAgent,
  fxApproval,
  fxAsk,
  fxAskMember,
  fxAskRun,
  fxConnector,
  fxHash,
  fxIntent,
  fxRehearsalCase,
  fxRehearsalRun,
  fxRehearsalScenario,
  fxSimExecution,
  fxSimSnapshot,
  fxTask,
  fxToolHash,
  fxUsage,
  fxWorkspace,
  openRoleDb,
  useTestDb,
  type FxWorkspace,
} from "./testing.ts";
import { WORKSPACE_TABLES } from "./types.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");

/** 全部の表（sim を含む）に行を入れたワークスペース */
export async function fullWorkspace(db: Db, kind: "guest" | "owner"): Promise<FxWorkspace> {
  const ws = await fxWorkspace(db, { kind, audit: true });
  const W = ws.workspaceId;
  await issueSession(db, { workspaceId: W, userId: ws.userId, ipHash: null, userAgent: "UA", now: NOW });
  await recordEntryAttempt(db, { ipHash: hashIp("203.0.113.7", "test-secret-0123456789"), outcome: "guest_created", workspaceId: W, now: NOW });
  await db.query("INSERT INTO workspace_policies (workspace_id, version, policy, policy_hash) VALUES ($1, 1, $2, $3)", [W, { version: 1 }, fxHash("wp")]);
  const conn = await fxConnector(db, ws);
  // Google カレンダーのコネクタと資格情報（connector_credentials。コネクタ経由で CASCADE する）
  const gcal = await db.transaction((tx) => upsertOAuthConnector(tx, ws.ctx, { slug: "gcal", displayName: "Google カレンダー", url: "https://gcal.test/mcp/gcal", now: NOW }));
  await db.transaction((tx) =>
    insertGoogleCredential(tx, ws.ctx, {
      connectorId: gcal.id,
      subject: "sub-1",
      email: "owner@example.test",
      scopes: ["openid", "email"],
      refreshTokenEnc: "v1.aXY.Y3Q",
      calendarId: "cal@group.calendar.google.test",
      timeZone: "Asia/Tokyo",
      now: NOW,
    }),
  );
  const inbox = await fxAgent(db, ws, { name: "受信箱係", jobSlug: "inbox", template: "researcher" });
  const buyer = await fxAgent(db, ws, { name: "仕入れ係", jobSlug: "purchase" });
  const { askId } = await fxAsk(db, ws, { seedKey: "prepared-purchasing" });
  const { askRunId } = await fxAskRun(db, ws, askId);
  const m1 = await fxAskMember(db, ws, { askId, agent: inbox, position: 1 });
  const m2 = await fxAskMember(db, ws, { askId, agent: buyer, position: 2, isSpokesperson: true });
  await db.query("UPDATE ask_members SET depends_on = '{1}' WHERE id = $1", [m2.memberId]);
  await db.query("INSERT INTO agent_messages (workspace_id, agent_id, ask_id, author, kind, body) VALUES ($1, $2, $3, 'system', 'text', 'こんにちは')", [
    W,
    inbox.agentId,
    askId,
  ]);
  const live = await fxSimExecution(db, ws);
  const t1 = await fxTask(db, ws, inbox, { askId, askRunId, status: "completed", tainted: true });
  await db.query("UPDATE tasks SET report = '新しいメール3通', report_kind = 'normal', report_sources = $2 WHERE id = $1", [
    t1.taskId,
    [{ kind: "mcp", connector: "mail", tool: "list_inbox" }],
  ]);
  const snap = await fxSimSnapshot(db, ws, { executionId: live.executionId, sourceTaskId: t1.taskId });
  const t2 = await fxTask(db, ws, buyer, { askId, askRunId, status: "awaiting_approval", simSnapshotId: snap.snapshotId, tainted: true });
  await db.query("UPDATE tasks SET input_task_ids = ARRAY[$2]::uuid[] WHERE id = $1", [t2.taskId, t1.taskId]);
  await db.query("UPDATE ask_runs SET answer_task_id = $2, answered_at = $3, answer = $4 WHERE id = $1", [askRunId, t2.taskId, NOW, { text: "回答" }]);
  await db.query("INSERT INTO task_events (workspace_id, task_id, type, payload) VALUES ($1, $2, 'status_changed', '{}')", [W, t2.taskId]);
  const { intentId } = await fxIntent(db, ws, { taskId: t2.taskId, jobId: buyer.jobId, connectorId: conn.connectorId });
  await fxApproval(db, ws, { taskId: t2.taskId, intentId });
  await db.query(
    `INSERT INTO policy_decisions (workspace_id, task_id, intent_id, subject_kind, subject, counters, flags, decision, reason_code, inputs_hash, kernel_version)
     VALUES ($1, $2, $3, 'tool_call', '{}', '{}', '{}', 'approve', 'approval_required', $4, '0.1.0')`,
    [W, t2.taskId, intentId, fxHash("inputs")],
  );
  await fxUsage(db, ws, { taskId: t2.taskId });
  await fxUsage(db, ws, { askId });
  await db.query(
    `INSERT INTO ask_messages (workspace_id, ask_id, ask_run_id, from_member, to_member, kind, body, tainted, from_task_id)
     VALUES ($1, $2, $3, $4, $5, 'share', '共有', true, $6)`,
    [W, askId, askRunId, m1.memberId, m2.memberId, t1.taskId],
  );
  await db.query(
    `INSERT INTO agent_questions (workspace_id, ask_id, ask_run_id, task_id, agent_id, agent_name, question, choices)
     SELECT $1, $2, $3, t.id, t.agent_id, '担当', 'どちらにしますか', '[{"id":"c1","label":"A"}]' FROM tasks t WHERE t.id = $4`,
    [W, askId, askRunId, t1.taskId],
  );
  await db.query("INSERT INTO ask_pending_replies (workspace_id, ask_id, text, requester_id) VALUES ($1, $2, '順番待ちの返事', $3)", [W, askId, ws.userId]);
  await db.query("INSERT INTO workspace_events (workspace_id, type, data) VALUES ($1, 'check.upsert', '{}')", [W]);
  await db.query("INSERT INTO check_marks (workspace_id, item_key) VALUES ($1, $2)", [W, `answer:${askRunId}`]);
  // タスクが見た URL の集合（0016。SG-04）
  await db.query("INSERT INTO task_web_urls (workspace_id, task_id, url_hash) VALUES ($1, $2, sha256('https://example.com/'::bytea))", [W, t1.taskId]);
  // 作業場・ファイルの控え・スキル・パック（0012）
  const sess = (
    await db.query<{ id: string }>(
      `INSERT INTO sandbox_sessions (workspace_id, task_id, agent_id, token_hash, provider)
       SELECT $1, t.id, t.agent_id, sha256(gen_random_uuid()::text::bytea), 'inprocess' FROM tasks t WHERE t.id = $2 RETURNING id`,
      [W, t1.taskId],
    )
  ).rows[0]!.id;
  await db.query("INSERT INTO sandbox_commands (workspace_id, session_id, task_id, tool, args) VALUES ($1, $2, $3, 'list_files', '{}')", [W, sess, t1.taskId]);
  await db.query(
    "INSERT INTO agent_workspace_snapshots (workspace_id, agent_id, task_id, source, archive, files, bytes) SELECT $1, agent_id, id, 'task', '\\x1f8b', 1, 2 FROM tasks WHERE id = $2",
    [W, t1.taskId],
  );
  await db.query("INSERT INTO agent_skills (workspace_id, agent_id, name, description, body) SELECT $1, agent_id, '採点', '採点の手順', '# 採点' FROM tasks WHERE id = $2", [W, t1.taskId]);
  // スキルの案・整理の記録（0022）
  await db.query("INSERT INTO skill_proposals (workspace_id, agent_id, status) SELECT $1, agent_id, 'skipped' FROM tasks WHERE id = $2", [W, t1.taskId]);
  await db.query("INSERT INTO agent_evolution_events (workspace_id, agent_id, kind, items) SELECT $1, agent_id, 'pruned', '[]' FROM tasks WHERE id = $2", [W, t1.taskId]);
  await db.query("INSERT INTO pack_installs (workspace_id, pack_id, pack_version) VALUES ($1, 'teacher', 1)", [W]);
  await db.query(
    "INSERT INTO idempotency_keys (workspace_id, key, method, path, request_hash, response_status, response_body) VALUES ($1, gen_random_uuid(), 'POST', '/x', $2, 200, '{}')",
    [W, fxHash("req")],
  );
  // リハーサル（順番の依頼全体）・試験・状況・リハーサルのタスク・sim の走行と事象・合格証・自分の言葉の悪い日
  const run = await fxRehearsalRun(db, ws, { askId, status: "done", trigger: "seed" });
  const gen = await fxRehearsalCase(db, ws, { askId });
  await fxRehearsalCase(db, ws, { askId, source: "incident", simSnapshotId: snap.snapshotId, sourceTaskId: t2.taskId });
  await fxRehearsalCase(db, ws, { askId, source: "user" });
  const sc = await fxRehearsalScenario(db, ws, { runId: run.runId, caseId: gen.caseId });
  const governed = await fxSimExecution(db, ws, { rehearsalRunId: run.runId, variant: "governed" });
  const shadow = await fxSimExecution(db, ws, { rehearsalRunId: run.runId, variant: "shadow" });
  const fork = await db.query<{ id: string }>(
    `INSERT INTO sim.executions (workspace_id, world, rehearsal_run_id, parent_execution_id, variant, seed, seed_version, initial_state, state)
     VALUES ($1, 'shop', $2, $3, 'governed_approve', 7, '2026-10-12.1', '{}', '{}') RETURNING id`,
    [W, run.runId, governed.executionId],
  );
  await db.query("UPDATE rehearsal_scenarios SET governed_execution_id = $2, shadow_execution_id = $3, approve_execution_id = $4 WHERE id = $1", [
    sc.scenarioId,
    governed.executionId,
    shadow.executionId,
    fork.rows[0]?.id,
  ]);
  await db.query("INSERT INTO sim.events (execution_id, seq, workspace_id, event) VALUES ($1, 1, $2, $3)", [
    governed.executionId,
    W,
    { seq: 1, at: "2026-10-12T18:00:00+09:00", kind: "tool_call", caller: "sa-gateway" },
  ]);
  await fxTask(db, ws, buyer, {
    status: "completed",
    rehearsalRunId: run.runId,
    rehearsalScenarioId: sc.scenarioId,
    simExecutionId: governed.executionId,
  });
  await fxTask(db, ws, buyer, {
    status: "completed",
    rehearsalRunId: run.runId,
    rehearsalScenarioId: sc.scenarioId,
    simExecutionId: shadow.executionId,
    shadow: true,
  });
  await fxUsage(db, ws, { rehearsalRunId: run.runId });
  await db.query(
    `INSERT INTO agent_config_changes (workspace_id, agent_id, job_id, origin, rehearsal_run_id, patch, classification, status, snapshot_id, decided_at)
     VALUES ($1, $2, $3, 'rehearsal_tighten', $4, '[]', 'narrow', 'applied', $5, now())`,
    [W, buyer.agentId, buyer.jobId, run.runId, buyer.snapshotId],
  );
  const cert = await db.transaction(async (tx) => {
    const log = await appendAuditLog(
      tx,
      W,
      { eventType: "rehearsal.certificate_issued", actorType: "system", actorId: "app", payload: { jobId: buyer.jobId } },
      NOW,
    );
    return tx.query<{ id: string }>(
      `INSERT INTO rehearsal_certificates (workspace_id, job_id, ask_id, rehearsal_run_id, policy_hash, tool_hashes, model_id, case_set_hash,
                                           case_count, summary, cost_usd, certificate_hash, audit_seq)
       VALUES ($1, $2, $3, $4, $5, $6, 'm', $7, 3, '{}', '0.100000', $8, $9) RETURNING id`,
      [W, buyer.jobId, askId, run.runId, fxHash("p"), [{ action: "mcp.supplier.place_order", toolHash: fxToolHash("t") }], fxHash("cs"), fxHash("cert"), log.seq],
    );
  });
  await db.query("UPDATE rehearsal_runs SET certificate_id = $2 WHERE id = $1", [run.runId, cert.rows[0]?.id]);
  await db.query("INSERT INTO rehearsal_user_inputs (workspace_id, ask_id, text, status, nearest_fault_id, created_by) VALUES ($1, $2, '店長の名前で', 'no_match', 'F-06', $3)", [
    W,
    askId,
    ws.userId,
  ]);
  return ws;
}

async function counts(db: Db, workspaceId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of WORKSPACE_TABLES) {
    out[t] = (await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${t} WHERE workspace_id = $1`, [workspaceId])).rows[0]?.n ?? -1;
  }
  return out;
}

describe("ゲストのワークスペースの削除（T-30・T-31）", () => {
  it("T-30 全部の表と sim.* に行のあるゲストを、GUC をそのワークスペースにして消すと全部0件、オーナーは残る（ot_retention の権限で）", async () => {
    const { db, url } = T();
    const owner = await fullWorkspace(db, "owner");
    const guest = await fullWorkspace(db, "guest");
    const before = await counts(db, guest.workspaceId);
    for (const [table, n] of Object.entries(before)) expect(n, `${table} に行がある`).toBeGreaterThan(0);
    const ownerBefore = await counts(db, owner.workspaceId);

    const maint = await openRoleDb(url, "ot_retention");
    try {
      await maint.transaction(async (tx) => {
        await tx.query("SELECT set_config('ot.audit_purge_workspace', $1, true)", [guest.workspaceId]);
        const r = await tx.query("DELETE FROM workspaces WHERE id = $1 AND kind = 'guest'", [guest.workspaceId]);
        expect(r.rowCount).toBe(1);
      });
    } finally {
      await maint.close();
    }
    const after = await counts(db, guest.workspaceId);
    for (const [table, n] of Object.entries(after)) expect(n, `${table} が消える`).toBe(0);
    expect(await counts(db, owner.workspaceId)).toEqual(ownerBefore);
    // 入口の試行はワークスペースが消えても残る（IP の数え方。workspace_id は NULL に）
    const ea = await db.query<{ n: number }>("SELECT count(*) AS n FROM entry_attempts WHERE workspace_id IS NULL");
    expect(ea.rows[0]?.n).toBe(1);
    // GUC はトランザクションの中だけ（終わったら監査ログは消せない）
    await expect(db.query("DELETE FROM audit_logs WHERE workspace_id = $1", [owner.workspaceId])).rejects.toThrow(/append-only/);
  });

  it("T-31 GUC を別のワークスペースの ID にして消すと、監査ログを消せず全部が戻る", async () => {
    const { db } = T();
    const a = await fullWorkspace(db, "guest");
    const b = await fxWorkspace(db, { audit: true });
    const before = await counts(db, a.workspaceId);
    await expect(
      db.transaction(async (tx) => {
        await tx.query("SELECT set_config('ot.audit_purge_workspace', $1, true)", [b.workspaceId]);
        await tx.query("DELETE FROM workspaces WHERE id = $1", [a.workspaceId]);
      }),
    ).rejects.toThrow(/append-only/);
    expect(await counts(db, a.workspaceId)).toEqual(before);
  });
});
