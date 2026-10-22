// 毎分の起こし（EP-47。DO の alarm）の材料の走査（packages/db/src/system/scans.ts の WorkspaceDO 版。DB §4.1 の2・§4.12、IA §3.13・3.15、G-02）。
// Postgres 版はワークスペースをまたいで候補（ワークスペースと ID）を返したが、DO の中では自分のワークスペースだけを走査する。
// だから ScanHit に workspaceId・kind はない。候補を返すだけで、処理は呼ぶ側が1件ずつ、状態を確かめ直してから行う
// （DO の中は1本の流れなので、ロックの順（M-21）は要らない）。Kill Switch を除く走査は、発動中なら何も返さない

import { CODECS } from "../codecs.ts";
import { all, run, type WsDb } from "../sqlite.ts";
import type { AskStatus, Uuid } from "../types.ts";

export interface ScanHit {
  id: Uuid;
}

/** Kill Switch が発動していない（WHERE に足す） */
const NOT_KILLED = "NOT (SELECT kill_switch_engaged FROM workspace WHERE id = 1)";

/** next_run_at が来た定期の依頼（古い順）。状態での絞り込み・次の時刻の計算は呼ぶ側 */
export function scanDueAsks(db: WsDb, now: Date, limit = 50): Array<ScanHit & { nextRunAt: Date; status: AskStatus }> {
  const rows = all<{ id: Uuid; next_run_at: Date; status: AskStatus }>(
    db,
    CODECS.asks,
    "SELECT id, next_run_at, status FROM asks WHERE next_run_at <= ? ORDER BY next_run_at, id LIMIT ?",
    now,
    limit,
  );
  return rows.map((x) => ({ id: x.id, nextRunAt: x.next_run_at, status: x.status }));
}

/** 期限の来た承認待ち（expires_at <= now。kernel の isApprovalExpired と同じ境界：ちょうどで期限切れ） */
export function scanExpiredApprovals(
  db: WsDb,
  now: Date,
  limit = 100,
): Array<ScanHit & { intentId: Uuid; taskId: Uuid; expiryCause: "ttl" | "next_run" }> {
  const rows = all<{ id: Uuid; intent_id: Uuid; task_id: Uuid; expiry_cause: "ttl" | "next_run" }>(
    db,
    {},
    `SELECT id, intent_id, task_id, expiry_cause FROM approvals
      WHERE status = 'pending' AND expires_at <= ?
      ORDER BY expires_at, id LIMIT ?`,
    now,
    limit,
  );
  return rows.map((x) => ({ id: x.id, intentId: x.intent_id, taskId: x.task_id, expiryCause: x.expiry_cause }));
}

/** executing のまま updated_at が updatedBefore 以前の Intent（D-18 の取り残し。しきい値は呼ぶ側：IA §8-11） */
export function scanStuckExecutingIntents(db: WsDb, updatedBefore: Date, limit = 100): Array<ScanHit & { taskId: Uuid }> {
  const rows = all<{ id: Uuid; task_id: Uuid }>(
    db,
    {},
    `SELECT id, task_id FROM action_intents
      WHERE status = 'executing' AND updated_at <= ?
      ORDER BY updated_at, id LIMIT ?`,
    updatedBefore,
    limit,
  );
  return rows.map((x) => ({ id: x.id, taskId: x.task_id }));
}

/** queued のタスク（古い順）。同時実行数（BR-08）・canStartWork は呼ぶ側。Kill Switch の発動中は何も返さない */
export function scanQueuedTasks(db: WsDb, limit = 100): Array<ScanHit & { queuedAt: Date }> {
  const rows = all<{ id: Uuid; queued_at: Date }>(
    db,
    CODECS.tasks,
    `SELECT id, queued_at FROM tasks WHERE status = 'queued' AND ${NOT_KILLED} ORDER BY queued_at, id LIMIT ?`,
    limit,
  );
  return rows.map((x) => ({ id: x.id, queuedAt: x.queued_at }));
}

/**
 * 動いている依頼の実行（running。止まった担当の拾い直し・queued のタスクを動かす・まとめ役の待ち時間：G-02）。Kill Switch の発動中は何も返さない。
 * 拾った順は last_scanned_at の古い順（まだ拾っていないものが先）。拾ったものは markAskRunsScanned で印を付けて回す
 */
export function scanActiveAskRuns(db: WsDb, limit = 50): Array<ScanHit & { askId: Uuid; createdBy: Uuid }> {
  const rows = all<{ id: Uuid; ask_id: Uuid; created_by: Uuid }>(
    db,
    {},
    `SELECT r.id, r.ask_id, a.created_by
       FROM ask_runs r JOIN asks a ON a.id = r.ask_id
      WHERE r.status = 'running' AND ${NOT_KILLED}
      ORDER BY r.last_scanned_at ASC NULLS FIRST, r.started_at, r.id LIMIT ?`,
    limit,
  );
  return rows.map((x) => ({ id: x.id, askId: x.ask_id, createdBy: x.created_by }));
}

/**
 * 順番待ちの返事があって、動いている実行がない依頼（実行が終わったあとの取りこぼし・再起動の後の拾い直し）。
 * 依頼が running・done のものだけ。Kill Switch の発動中は何も返さない。古い返事が先
 */
export function scanAsksWithPendingReplies(db: WsDb, limit = 50): Array<ScanHit & { askId: Uuid }> {
  const rows = all<{ ask_id: Uuid }>(
    db,
    {},
    `SELECT p.ask_id
       FROM ask_pending_replies p JOIN asks a ON a.id = p.ask_id
      WHERE p.consumed_at IS NULL AND a.status IN ('running','done') AND ${NOT_KILLED}
        AND NOT EXISTS (SELECT 1 FROM ask_runs r WHERE r.ask_id = p.ask_id AND r.status IN ('running','waiting_input'))
      GROUP BY p.ask_id
      ORDER BY min(p.created_at), p.ask_id LIMIT ?`,
    limit,
  );
  return rows.map((x) => ({ id: x.ask_id, askId: x.ask_id }));
}

/** alarm が拾った依頼の実行に、拾った時刻を付ける（次の走査で後回しにするため：scanActiveAskRuns） */
export function markAskRunsScanned(db: WsDb, runIds: readonly Uuid[], now: Date): void {
  if (runIds.length === 0) return;
  run(db, "UPDATE ask_runs SET last_scanned_at = ? WHERE id IN (SELECT value FROM json_each(?))", now, runIds);
}

/**
 * ハートビートが途絶えた本番のタスク（provisioning・running のまま、last_heartbeat_at（なければ更新の時刻）が staleBefore 以前）。
 * 動かしているプロセスが落ちた・止まったタスク。awaiting_approval・executing は除く（承認の待ち・実行の完了の待ちは別の流れ）。
 * Kill Switch の発動中は何も返さない。候補だけを返す。呼ぶ側が状態を確かめてから止める
 */
export function scanStaleLiveTasks(db: WsDb, staleBefore: Date, limit = 50): Array<ScanHit & { askId: Uuid | null }> {
  const rows = all<{ id: Uuid; ask_id: Uuid | null }>(
    db,
    {},
    `SELECT id, ask_id FROM tasks
      WHERE status IN ('provisioning', 'running') AND ${NOT_KILLED}
        AND COALESCE(last_heartbeat_at, updated_at) <= ?
      ORDER BY COALESCE(last_heartbeat_at, updated_at), id LIMIT ?`,
    staleBefore,
    limit,
  );
  return rows.map((x) => ({ id: x.id, askId: x.ask_id }));
}

/** 生成中のまま止まった依頼（質問を待っているものは除く。updatedBefore より前に更新が止まったもの：プロセスが落ちた・時間切れの取りこぼし） */
export function scanStuckGeneratingAsks(db: WsDb, updatedBefore: Date, limit = 50): ScanHit[] {
  return all<{ id: Uuid }>(
    db,
    {},
    `SELECT id FROM asks
      WHERE status = 'generating' AND (question IS NULL OR question_answer IS NOT NULL)
        AND updated_at <= ?
      ORDER BY updated_at, id LIMIT ?`,
    updatedBefore,
    limit,
  ).map((x) => ({ id: x.id }));
}
