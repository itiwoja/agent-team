// ゲストの掃除の試験（db-schema.md §7.2 の T-32〜T-38、SO §7.10）。ot_retention の権限で流す
import { describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { fxAgent, fxConnector, fxIntent, fxTask, fxWorkspace, openRoleDb, useTestDb } from "../testing.ts";
import { cleanupGuestWorkspaces, CLEANUP_DEFAULTS, KILL_SWITCH_CHANNEL, stopWorkspaceForCleanup } from "./cleanup.ts";
import { recordEntryAttempt } from "./entry.ts";

const T = useTestDb();
const NOW = new Date("2026-10-20T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function withMaint<R>(fn: (maint: Db) => Promise<R>): Promise<R> {
  const maint = await openRoleDb(T().url, "ot_retention");
  try {
    return await fn(maint);
  } finally {
    await maint.close();
  }
}
async function exists(db: Db, id: string): Promise<boolean> {
  return ((await db.query<{ n: number }>("SELECT count(*) AS n FROM workspaces WHERE id = $1", [id])).rows[0]?.n ?? 0) > 0;
}

describe("消す候補（7日・削除予約）", () => {
  it("T-32 last_seen_at = now − 7日ちょうどは消さない。T-33 1ms 過ぎたら消し、ゲストの利用者も消す", async () => {
    const { db } = T();
    const edge = await fxWorkspace(db, { lastSeenAt: ago(7 * DAY), audit: true });
    const over = await fxWorkspace(db, { lastSeenAt: ago(7 * DAY + 1), audit: true });
    const r = await withMaint((m) => cleanupGuestWorkspaces(m, NOW));
    expect(r.deleted).toEqual([over.workspaceId]);
    expect(r.deletedUsers).toEqual([over.userId]);
    expect(await exists(db, edge.workspaceId)).toBe(true);
    expect(await exists(db, over.workspaceId)).toBe(false);
    const users = await db.query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1::uuid[])", [[edge.userId, over.userId]]);
    expect(users.rows.map((u) => u.id)).toEqual([edge.userId]);
  });

  it("T-34 オーナーは last_seen_at が30日前でも消さない", async () => {
    const { db } = T();
    const owner = await fxWorkspace(db, { kind: "owner", lastSeenAt: ago(30 * DAY), audit: true });
    const r = await withMaint((m) => cleanupGuestWorkspaces(m, NOW));
    expect(r.scanned).toBe(0);
    expect(await exists(db, owner.workspaceId)).toBe(true);
  });

  it("削除予約のゲストは7日以内でも消す（[最初からやり直す]・ログアウト）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { lastSeenAt: NOW, deleteRequestedAt: ago(MIN), audit: true });
    const r = await withMaint((m) => cleanupGuestWorkspaces(m, NOW));
    expect(r.deleted).toEqual([ws.workspaceId]);
  });
});

describe("止めてから消す（T-35・T-36）", () => {
  async function busyGuest(db: Db, deleteRequestedAt: Date | null) {
    const ws = await fxWorkspace(db, { lastSeenAt: ago(8 * DAY), deleteRequestedAt, audit: true });
    const agent = await fxAgent(db, ws);
    const conn = await fxConnector(db, ws);
    const running = await fxTask(db, ws, agent, { status: "running" });
    const waiting = await fxTask(db, ws, agent, { status: "awaiting_approval" });
    const pending = await fxIntent(db, ws, { taskId: waiting.taskId, jobId: agent.jobId, connectorId: conn.connectorId });
    return { ws, running, waiting, pending };
  }

  it("T-35 削除予約から5分・running のタスクあり → Kill Switch を発動して今回は消さない（タスクは halted、承認待ちは expired）", async () => {
    const { db } = T();
    const { ws, running, pending } = await busyGuest(db, ago(5 * MIN));
    const notified: string[] = [];
    const l = await db.listen(KILL_SWITCH_CHANNEL, (p) => notified.push(p));
    const r = await withMaint((m) => cleanupGuestWorkspaces(m, NOW));
    expect(r.deleted).toEqual([]);
    expect(r.deferred).toEqual([{ workspaceId: ws.workspaceId, reason: "tasks_still_running" }]);
    const w = await db.query<{ kill_switch_engaged: boolean; kill_switch_reason: string; delete_requested_at: Date }>(
      "SELECT kill_switch_engaged, kill_switch_reason, delete_requested_at FROM workspaces WHERE id = $1",
      [ws.workspaceId],
    );
    expect(w.rows[0]).toEqual({ kill_switch_engaged: true, kill_switch_reason: "cleanup", delete_requested_at: ago(5 * MIN) });
    const t = await db.query<{ status: string; halt_reason: string; task_token_hash: Buffer | null }>(
      "SELECT status, halt_reason, task_token_hash FROM tasks WHERE id = $1",
      [running.taskId],
    );
    expect(t.rows[0]).toEqual({ status: "halted", halt_reason: "kill_switch", task_token_hash: null });
    const i = await db.query<{ status: string; expire_reason: string }>("SELECT status, expire_reason FROM action_intents WHERE id = $1", [pending.intentId]);
    expect(i.rows[0]).toEqual({ status: "expired", expire_reason: "kill_switch" });
    const log = await db.query<{ event_type: string; payload: { reason: string; affectedTaskIds: string[] } }>(
      "SELECT event_type, payload FROM audit_logs WHERE workspace_id = $1 AND seq = 2",
      [ws.workspaceId],
    );
    expect(log.rows[0]?.event_type).toBe("killswitch.engaged");
    expect(log.rows[0]?.payload.reason).toBe("cleanup");
    expect(log.rows[0]?.payload.affectedTaskIds).toHaveLength(2);
    for (let k = 0; k < 50 && notified.length === 0; k++) await new Promise((res) => setTimeout(res, 20));
    expect(notified).toEqual([ws.workspaceId]);
    await l.unlisten();
    // 次の回はタスクが止まっているので消す
    const again = await withMaint((m) => cleanupGuestWorkspaces(m, NOW));
    expect(again.deleted).toEqual([ws.workspaceId]);
  });

  it("T-36 同じ状態で削除予約から11分（grace 10分）なら止まらないタスクがあっても消す。10分ちょうどは消さない", async () => {
    const { db } = T();
    const late = await busyGuest(db, ago(11 * MIN));
    const edge = await busyGuest(db, ago(CLEANUP_DEFAULTS.graceMs));
    // executing の Intent は止められない（完了を待つ）ので、Kill Switch のあとも残る
    const r = await withMaint((m) => cleanupGuestWorkspaces(m, NOW, { stopWorkspace: async () => {} }));
    expect(r.deleted).toEqual([late.ws.workspaceId]);
    expect(r.deferred.map((d) => d.workspaceId)).toEqual([edge.ws.workspaceId]);
  });

  it("予約のない7日過ぎのゲストに走っているタスクがあれば、止めて削除予約を入れる。executing の Intent も「走っている」に数える", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { lastSeenAt: ago(8 * DAY), audit: true });
    const agent = await fxAgent(db, ws);
    const conn = await fxConnector(db, ws);
    const done = await fxTask(db, ws, agent, { status: "completed" });
    await fxIntent(db, ws, { taskId: done.taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "executing" });
    const calls: string[] = [];
    const r = await withMaint((m) =>
      cleanupGuestWorkspaces(m, NOW, {
        stopWorkspace: async (tx, ctx, now) => {
          calls.push(ctx.workspaceId);
          await stopWorkspaceForCleanup(tx, ctx, now);
        },
      }),
    );
    expect(calls).toEqual([ws.workspaceId]);
    expect(r.deferred).toHaveLength(1);
    const w = await db.query<{ delete_requested_at: Date | null }>("SELECT delete_requested_at FROM workspaces WHERE id = $1", [ws.workspaceId]);
    expect(w.rows[0]?.delete_requested_at).toEqual(NOW);
    const i = await db.query<{ status: string }>("SELECT status FROM action_intents");
    expect(i.rows.map((x) => x.status)).toEqual(["executing"]);
  });

  it("Kill Switch の発動は2回目は何もしない（監査ログを重ねない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    await db.transaction((tx) => stopWorkspaceForCleanup(tx, ws.ctx, NOW));
    await db.transaction((tx) => stopWorkspaceForCleanup(tx, ws.ctx, NOW));
    const n = await db.query<{ n: number }>("SELECT count(*) AS n FROM audit_logs WHERE workspace_id = $1", [ws.workspaceId]);
    expect(n.rows[0]?.n).toBe(2);
  });
});

describe("回数と古い行（T-37・T-38）", () => {
  it("T-37 25件の候補・batch 20 → 1回目に20件、2回目に5件", async () => {
    const { db } = T();
    await db.query(
      `INSERT INTO workspaces (kind, max_concurrent_tasks, seed_version, last_seen_at)
       SELECT 'guest', 2, 'v', $1::timestamptz - make_interval(secs => g) FROM generate_series(1, 25) g`,
      [ago(8 * DAY)],
    );
    const first = await withMaint((m) => cleanupGuestWorkspaces(m, NOW, { batch: 20 }));
    expect(first.deleted).toHaveLength(20);
    const second = await withMaint((m) => cleanupGuestWorkspaces(m, NOW, { batch: 20 }));
    expect(second.deleted).toHaveLength(5);
    const third = await withMaint((m) => cleanupGuestWorkspaces(m, NOW, { batch: 20 }));
    expect(third.scanned).toBe(0);
  });

  it("T-38 24時間より古い entry_attempts・idempotency_keys・workspace_events を消す", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { lastSeenAt: NOW });
    const ip = "a".repeat(64);
    await recordEntryAttempt(db, { ipHash: ip, outcome: "wrong_token", now: ago(25 * 60 * MIN) });
    await recordEntryAttempt(db, { ipHash: ip, outcome: "wrong_token", now: ago(23 * 60 * MIN) });
    await db.query(
      "INSERT INTO idempotency_keys (workspace_id, key, method, path, request_hash, response_status, response_body, created_at) VALUES ($1, gen_random_uuid(), 'POST', '/x', $2, 200, '{}', $3)",
      [ws.workspaceId, "b".repeat(64), ago(25 * 60 * MIN)],
    );
    await db.query("INSERT INTO workspace_events (workspace_id, type, data, created_at) VALUES ($1, 'counts', '{}', $2), ($1, 'counts', '{}', $3)", [
      ws.workspaceId,
      ago(25 * 60 * MIN),
      ago(MIN),
    ]);
    const r = await withMaint((m) => cleanupGuestWorkspaces(m, NOW));
    expect(r.purged).toEqual({ entryAttempts: 1, idempotencyKeys: 1, workspaceEvents: 1 });
    const left = await db.query<{ n: number }>("SELECT count(*) AS n FROM entry_attempts");
    expect(left.rows[0]?.n).toBe(1);
  });
});
