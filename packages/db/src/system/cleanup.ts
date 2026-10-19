// ゲストの掃除（毎時。db-schema.md §4.4、security-ops-deploy.md §3.16。15:373-376）。ot_retention のロールの接続で呼ぶ。
// 1. 候補：kind = 'guest' かつ（削除予約あり か last_seen_at < now − 7日）。7日ちょうどは消さない。オーナーは条件で除く
// 2. 終わっていないタスクか executing の Intent が残っていれば、止めて（Kill Switch と同じ停止）削除予約を入れ、今回は消さない。
//    ただし削除予約から graceMs（既定10分）を過ぎていれば消す（止まらないタスクで掃除が終わらないのを防ぐ）
// 3. 消すときは1ワークスペース1トランザクション：GUC ot.audit_purge_workspace（M-56）→ ワークスペースを DELETE（全表と sim.* へ
//    カスケード。監査ログも消える）→ 所属のなくなったゲストの利用者を DELETE
// 4. 24時間より古い entry_attempts・idempotency_keys・workspace_events を消す

import { appendAuditLog } from "../audit.ts";
import type { Db, Tx } from "../client.ts";
import { TASK_TERMINAL, type Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";

export const CLEANUP_DEFAULTS = {
  batch: 20,
  graceMs: 10 * 60 * 1000,
  /** 最後のアクセスから7日を「過ぎた」ら消す（BR-65） */
  idleMs: 7 * 24 * 60 * 60 * 1000,
  /** entry_attempts・idempotency_keys・workspace_events を残す時間 */
  retentionMs: 24 * 60 * 60 * 1000,
} as const;

/** Kill Switch の LISTEN/NOTIFY のチャンネル（SO §2.8）。payload はワークスペースの ID */
export const KILL_SWITCH_CHANNEL = "ot_kill_switch";

/** 掃除で使う停止の手順。既定は stopWorkspaceForCleanup。app の Kill Switch の手順を渡してもよい */
export type StopWorkspace = (tx: Tx, ctx: WsCtx, now: Date) => Promise<void>;

export interface CleanupOptions {
  batch?: number;
  graceMs?: number;
  stopWorkspace?: StopWorkspace;
}

export interface CleanupResult {
  scanned: number;
  deleted: Uuid[];
  /** 止めて、次の回に回したもの */
  deferred: Array<{ workspaceId: Uuid; reason: "tasks_still_running" }>;
  failed: Array<{ workspaceId: Uuid; error: string }>;
  deletedUsers: Uuid[];
  purged: { entryAttempts: number; idempotencyKeys: number; workspaceEvents: number };
}

/**
 * 掃除の既定の停止（SO §3.15 の3〜7・9・10 の DB の部分。理由 cleanup）：Kill Switch を発動し、終わっていないタスクを
 * halted（kill_switch）、承認待ちを expired、proposed・pending_approval・approved の Intent を expired（kill_switch）にして、
 * 監査ログ killswitch.engaged と NOTIFY を出す。executing の Intent は触らない（完了を待つ）。すでに発動していれば何もしない
 */
export async function stopWorkspaceForCleanup(tx: Tx, ctx: WsCtx, now: Date): Promise<void> {
  const engaged = await tx.query(
    `UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2, kill_switch_engaged_by = NULL,
            kill_switch_reason = 'cleanup', updated_at = $2
      WHERE id = $1 AND NOT kill_switch_engaged`,
    [ctx.workspaceId, now],
  );
  if (engaged.rowCount === 0) return;
  const halted = await tx.query<{ id: Uuid }>(
    `UPDATE tasks SET status = 'halted', halt_reason = 'kill_switch', finished_at = $2, updated_at = $2,
            task_token_hash = NULL, task_token_expires_at = NULL
      WHERE workspace_id = $1 AND status <> ALL($3::text[])
      RETURNING id`,
    [ctx.workspaceId, now, [...TASK_TERMINAL]],
  );
  await tx.query("UPDATE approvals SET status = 'expired', updated_at = $2 WHERE workspace_id = $1 AND status = 'pending'", [
    ctx.workspaceId,
    now,
  ]);
  await tx.query(
    `UPDATE action_intents SET status = 'expired', expire_reason = 'kill_switch', updated_at = $2
      WHERE workspace_id = $1 AND status IN ('proposed', 'pending_approval', 'approved')`,
    [ctx.workspaceId, now],
  );
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "killswitch.engaged",
      actorType: "system",
      actorId: "cleanup",
      payload: { reason: "cleanup", affectedTaskIds: halted.rows.map((r) => r.id).sort() },
    },
    now,
  );
  await tx.query("SELECT pg_notify($1, $2)", [KILL_SWITCH_CHANNEL, ctx.workspaceId]);
}

type Outcome = { kind: "gone" } | { kind: "deferred" } | { kind: "deleted"; users: Uuid[] };

async function cleanupOne(maint: Db, id: Uuid, now: Date, idleBefore: Date, graceMs: number, stop: StopWorkspace): Promise<Outcome> {
  return maint.transaction(async (tx): Promise<Outcome> => {
    const ws = (
      await tx.query<{ delete_requested_at: Date | null; last_seen_at: Date }>(
        "SELECT delete_requested_at, last_seen_at FROM workspaces WHERE id = $1 AND kind = 'guest' FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!ws) return { kind: "gone" };
    // 候補を選んだあとにアクセスされた（予約なし・7日以内）なら消さない
    if (ws.delete_requested_at === null && !(ws.last_seen_at.getTime() < idleBefore.getTime())) return { kind: "gone" };
    const busy = (
      await tx.query<{ busy: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM tasks WHERE workspace_id = $1 AND status <> ALL($2::text[]))
             OR EXISTS (SELECT 1 FROM action_intents WHERE workspace_id = $1 AND status = 'executing') AS busy`,
        [id, [...TASK_TERMINAL]],
      )
    ).rows[0]?.busy;
    const overdue = ws.delete_requested_at !== null && now.getTime() - ws.delete_requested_at.getTime() > graceMs;
    if (busy && !overdue) {
      await stop(tx, { workspaceId: id, kind: "guest", userId: null }, now);
      await tx.query("UPDATE workspaces SET delete_requested_at = $2, updated_at = $2 WHERE id = $1 AND delete_requested_at IS NULL", [
        id,
        now,
      ]);
      return { kind: "deferred" };
    }
    // このワークスペースの監査ログの削除だけをトリガーに通させる（トランザクションの中だけ有効）
    await tx.query("SELECT set_config('ot.audit_purge_workspace', $1, true)", [id]);
    const members = await tx.query<{ user_id: Uuid }>("SELECT user_id FROM memberships WHERE workspace_id = $1", [id]);
    await tx.query("DELETE FROM workspaces WHERE id = $1 AND kind = 'guest'", [id]);
    const users = await tx.query<{ id: Uuid }>(
      `DELETE FROM users u WHERE u.id = ANY($1::uuid[]) AND u.github_user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
        RETURNING u.id`,
      [members.rows.map((r) => r.user_id)],
    );
    return { kind: "deleted", users: users.rows.map((r) => r.id) };
  });
}

/** ゲストの掃除を1回（batch 件まで）行う。残りは次の回（Cloud Scheduler の試行の期限に収める） */
export async function cleanupGuestWorkspaces(maint: Db, now: Date, opts: CleanupOptions = {}): Promise<CleanupResult> {
  const batch = opts.batch ?? CLEANUP_DEFAULTS.batch;
  const graceMs = opts.graceMs ?? CLEANUP_DEFAULTS.graceMs;
  const stop = opts.stopWorkspace ?? stopWorkspaceForCleanup;
  const idleBefore = new Date(now.getTime() - CLEANUP_DEFAULTS.idleMs);
  const candidates = await maint.query<{ id: Uuid }>(
    `SELECT id FROM workspaces
      WHERE kind = 'guest' AND (delete_requested_at IS NOT NULL OR last_seen_at < $1)
      ORDER BY COALESCE(delete_requested_at, last_seen_at), id
      LIMIT $2`,
    [idleBefore, batch],
  );
  const result: CleanupResult = {
    scanned: candidates.rows.length,
    deleted: [],
    deferred: [],
    failed: [],
    deletedUsers: [],
    purged: { entryAttempts: 0, idempotencyKeys: 0, workspaceEvents: 0 },
  };
  for (const { id } of candidates.rows) {
    try {
      const out = await cleanupOne(maint, id, now, idleBefore, graceMs, stop);
      if (out.kind === "deleted") {
        result.deleted.push(id);
        result.deletedUsers.push(...out.users);
      } else if (out.kind === "deferred") {
        result.deferred.push({ workspaceId: id, reason: "tasks_still_running" });
      }
    } catch (e) {
      result.failed.push({ workspaceId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  result.purged = await purgeExpiredRows(maint, now);
  return result;
}

/** 24時間より古い入口の試行・冪等性のキー・SSE の事象を消す（DB §4.4 の4、AS 8-4） */
export async function purgeExpiredRows(maint: Db, now: Date, retentionMs: number = CLEANUP_DEFAULTS.retentionMs): Promise<CleanupResult["purged"]> {
  const before = new Date(now.getTime() - retentionMs);
  const a = await maint.query("DELETE FROM entry_attempts WHERE created_at < $1", [before]);
  const b = await maint.query("DELETE FROM idempotency_keys WHERE created_at < $1", [before]);
  const c = await maint.query("DELETE FROM workspace_events WHERE created_at < $1", [before]);
  return { entryAttempts: a.rowCount, idempotencyKeys: b.rowCount, workspaceEvents: c.rowCount };
}
