// ワークスペースをまたぐ走査（毎分の起こし EP-47 の材料。DB §4.1 の2・§4.12、IA §3.13・3.15、G-02）。
// どれもロックを取らずに候補（ワークスペースと ID）を返すだけ。処理は呼ぶ側が1件ずつ、wsCtxOf で文脈を作り、
// ワークスペース → タスク → 承認 → Intent の順にロックを取り直して状態を確かめてから行う
// （M-21。走査で行のロックを先に取ると、Kill Switch とロックの順が逆になる）

import type { Queryable } from "../client.ts";
import type { AskStatus, Uuid, WorkspaceKind } from "../types.ts";
import { BUDGET_TIME_ZONE } from "./costs.ts";

export interface ScanHit {
  workspaceId: Uuid;
  workspaceKind: WorkspaceKind;
  id: Uuid;
}

/** next_run_at が来た定期の依頼（古い順）。状態での絞り込み・次の時刻の計算は呼ぶ側。削除予約のワークスペースは除く */
export async function scanDueAsks(q: Queryable, now: Date, limit = 50): Promise<Array<ScanHit & { nextRunAt: Date; status: AskStatus }>> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid; next_run_at: Date; status: AskStatus }>(
    `SELECT a.workspace_id, w.kind, a.id, a.next_run_at, a.status
       FROM asks a JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.next_run_at <= $1 AND w.delete_requested_at IS NULL
      ORDER BY a.next_run_at, a.id LIMIT $2`,
    [now, limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, id: x.id, nextRunAt: x.next_run_at, status: x.status }));
}

/** 期限の来た承認待ち（expires_at <= now。kernel の isApprovalExpired と同じ境界：ちょうどで期限切れ） */
export async function scanExpiredApprovals(
  q: Queryable,
  now: Date,
  limit = 100,
): Promise<Array<ScanHit & { intentId: Uuid; taskId: Uuid; expiryCause: "ttl" | "next_run" }>> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid; intent_id: Uuid; task_id: Uuid; expiry_cause: "ttl" | "next_run" }>(
    `SELECT a.workspace_id, w.kind, a.id, a.intent_id, a.task_id, a.expiry_cause
       FROM approvals a JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.status = 'pending' AND a.expires_at <= $1
      ORDER BY a.expires_at, a.id LIMIT $2`,
    [now, limit],
  );
  return r.rows.map((x) => ({
    workspaceId: x.workspace_id,
    workspaceKind: x.kind,
    id: x.id,
    intentId: x.intent_id,
    taskId: x.task_id,
    expiryCause: x.expiry_cause,
  }));
}

/** executing のまま updated_at が updatedBefore 以前の Intent（D-18 の取り残し。しきい値は呼ぶ側：IA §8-11） */
export async function scanStuckExecutingIntents(q: Queryable, updatedBefore: Date, limit = 100): Promise<Array<ScanHit & { taskId: Uuid }>> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid; task_id: Uuid }>(
    `SELECT i.workspace_id, w.kind, i.id, i.task_id
       FROM action_intents i JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.status = 'executing' AND i.updated_at <= $1
      ORDER BY i.updated_at, i.id LIMIT $2`,
    [updatedBefore, limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, id: x.id, taskId: x.task_id }));
}

/** queued のタスク（古い順）。同時実行数（BR-08）・canStartWork は呼ぶ側。Kill Switch・削除予約のワークスペースは除く */
export async function scanQueuedTasks(q: Queryable, limit = 100): Promise<Array<ScanHit & { queuedAt: Date; rehearsalRunId: Uuid | null }>> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid; queued_at: Date; rehearsal_run_id: Uuid | null }>(
    `SELECT t.workspace_id, w.kind, t.id, t.queued_at, t.rehearsal_run_id
       FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.status = 'queued' AND NOT w.kill_switch_engaged AND w.delete_requested_at IS NULL
      ORDER BY t.queued_at, t.id LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, id: x.id, queuedAt: x.queued_at, rehearsalRunId: x.rehearsal_run_id }));
}

/** queued の走行（再リハーサルの待ち。G-02）。Kill Switch・削除予約のワークスペースは除く */
export async function scanQueuedRehearsalRuns(q: Queryable, limit = 50): Promise<Array<ScanHit & { createdAt: Date }>> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid; created_at: Date }>(
    `SELECT r.workspace_id, w.kind, r.id, r.created_at
       FROM rehearsal_runs r JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.status = 'queued' AND NOT w.kill_switch_engaged AND w.delete_requested_at IS NULL
      ORDER BY r.created_at, r.id LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, id: x.id, createdAt: x.created_at }));
}

/**
 * 再リハーサルの待ち：切れた合格証（広げる変更・ツールの変化・モデル・試験の追加。superseded は除く）が仕事の最新で、有効な合格証も、切れたあとの再リハーサル・最初・再試験の走行もなく（自分の言葉の悪い日 user_case の走行では外さない）、外されていない試験がある仕事（FR-067）。切れた古い順。
 * 例外（D-107）：切れたあとの走行が費用の上限で止まった（failed で、状況に abort_reason = budget がある）もので、今日（Asia/Tokyo の0時から）より前に作られたものは
 * 「走った」に数えない。費用の上限（1日の上限・リハーサル1回の上限）で止まった再リハーサルは、同じ日には拾い直さず（毎分同じ上限に当たるだけ）、翌日に1日1回やり直す
 */
export async function scanPendingRecertifications(
  q: Queryable,
  limit = 20,
  now: Date = new Date(),
  timeZone: string = BUDGET_TIME_ZONE,
): Promise<Array<ScanHit & { jobId: Uuid; reason: "widen" | "tool_hash" | "model" | "case_added"; revokedAt: Date; seed: number | null; requestedBy: Uuid | null }>> {
  const r = await q.query<{
    workspace_id: Uuid;
    kind: WorkspaceKind;
    id: Uuid;
    job_id: Uuid;
    revoke_reason: "widen" | "tool_hash" | "model" | "case_added";
    revoked_at: Date;
    seed: number | null;
    requested_by: Uuid | null;
  }>(
    `SELECT c.workspace_id, w.kind, c.id, c.job_id, c.revoke_reason, c.revoked_at, r0.seed, r0.requested_by
       FROM rehearsal_certificates c
       JOIN workspaces w ON w.id = c.workspace_id
       LEFT JOIN rehearsal_runs r0 ON r0.workspace_id = c.workspace_id AND r0.id = c.rehearsal_run_id
      WHERE c.revoked_at IS NOT NULL AND c.revoke_reason <> 'superseded'
        AND NOT w.kill_switch_engaged AND w.delete_requested_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM rehearsal_certificates n WHERE n.workspace_id = c.workspace_id AND n.job_id = c.job_id AND (n.issued_at > c.issued_at OR n.revoked_at IS NULL))
        AND NOT EXISTS (SELECT 1 FROM rehearsal_runs x WHERE x.workspace_id = c.workspace_id AND x.job_id = c.job_id AND x.trigger IN ('recertify','initial','retest') AND x.created_at >= c.revoked_at
                          AND NOT (x.status = 'failed'
                                   AND x.created_at < (date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3)
                                   AND EXISTS (SELECT 1 FROM rehearsal_scenarios s WHERE s.workspace_id = x.workspace_id AND s.rehearsal_run_id = x.id AND s.abort_reason = 'budget')))
        AND EXISTS (SELECT 1 FROM rehearsal_cases k WHERE k.workspace_id = c.workspace_id AND k.job_id = c.job_id AND k.removed_at IS NULL)
      ORDER BY c.revoked_at, c.id LIMIT $1`,
    [limit, now, timeZone],
  );
  return r.rows.map((x) => ({
    workspaceId: x.workspace_id,
    workspaceKind: x.kind,
    id: x.id,
    jobId: x.job_id,
    reason: x.revoke_reason,
    revokedAt: x.revoked_at,
    seed: x.seed,
    requestedBy: x.requested_by,
  }));
}

/** 有効な合格証のうち、モデルが今のモデルと違うもの（モデルの変更で切れる：FR-067）。削除予約のワークスペースは除く */
export async function scanModelDriftedCertificates(q: Queryable, currentModelId: string, limit = 50): Promise<Array<ScanHit & { jobId: Uuid }>> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid; job_id: Uuid }>(
    `SELECT c.workspace_id, w.kind, c.id, c.job_id
       FROM rehearsal_certificates c JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.revoked_at IS NULL AND c.model_id <> $1 AND w.delete_requested_at IS NULL
      ORDER BY c.issued_at, c.id LIMIT $2`,
    [currentModelId, limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, id: x.id, jobId: x.job_id }));
}

/**
 * 動いている本番の依頼の実行（running。止まった担当の拾い直し・queued のタスクを動かす・まとめ役の待ち時間：G-02）。Kill Switch・削除予約は除く。
 * 拾った順は last_scanned_at の古い順（まだ拾っていないものが先）。拾ったものは markAskRunsScanned で印を付けて回す
 */
export async function scanActiveAskRuns(q: Queryable, limit = 50): Promise<Array<ScanHit & { askId: Uuid; createdBy: Uuid }>> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid; ask_id: Uuid; created_by: Uuid }>(
    `SELECT r.workspace_id, w.kind, r.id, r.ask_id, a.created_by
       FROM ask_runs r
       JOIN asks a ON a.workspace_id = r.workspace_id AND a.id = r.ask_id
       JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.mode = 'live' AND r.status = 'running' AND NOT w.kill_switch_engaged AND w.delete_requested_at IS NULL
      ORDER BY r.last_scanned_at ASC NULLS FIRST, r.started_at, r.id LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, id: x.id, askId: x.ask_id, createdBy: x.created_by }));
}

/** tick が拾った依頼の実行に、拾った時刻を付ける（次の走査で後回しにするため：scanActiveAskRuns） */
export async function markAskRunsScanned(q: Queryable, runIds: readonly Uuid[], now: Date): Promise<void> {
  if (runIds.length === 0) return;
  await q.query("UPDATE ask_runs SET last_scanned_at = $2 WHERE id = ANY($1::uuid[])", [[...runIds], now]);
}

/**
 * ハートビートが途絶えた本番のタスク（provisioning・running のまま、last_heartbeat_at（なければ更新の時刻）が staleBefore 以前）。
 * 動かしているプロセスが落ちた・止まったタスク。awaiting_approval・executing は除く（承認の待ち・実行の完了の待ちは別の流れ）。リハーサルは除く。
 * 候補だけを返す（ロックを取らない）。呼ぶ側がロックの中で確かめてから止める
 */
export async function scanStaleLiveTasks(q: Queryable, staleBefore: Date, limit = 50): Promise<Array<ScanHit & { askId: Uuid | null }>> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid; ask_id: Uuid | null }>(
    `SELECT t.workspace_id, w.kind, t.id, t.ask_id
       FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.status IN ('provisioning', 'running') AND t.rehearsal_run_id IS NULL
        AND NOT w.kill_switch_engaged AND w.delete_requested_at IS NULL
        AND COALESCE(t.last_heartbeat_at, t.updated_at) <= $1
      ORDER BY COALESCE(t.last_heartbeat_at, t.updated_at), t.id LIMIT $2`,
    [staleBefore, limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, id: x.id, askId: x.ask_id }));
}

/** 生成中のまま止まった依頼（質問を待っているものは除く。updatedBefore より前に更新が止まったもの：プロセスが落ちた・時間切れの取りこぼし） */
export async function scanStuckGeneratingAsks(q: Queryable, updatedBefore: Date, limit = 50): Promise<ScanHit[]> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; id: Uuid }>(
    `SELECT a.workspace_id, w.kind, a.id
       FROM asks a JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.status = 'generating' AND (a.question IS NULL OR a.question_answer IS NOT NULL)
        AND a.updated_at <= $1 AND w.delete_requested_at IS NULL
      ORDER BY a.updated_at, a.id LIMIT $2`,
    [updatedBefore, limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, id: x.id }));
}
