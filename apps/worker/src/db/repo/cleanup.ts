// 古い行の掃除（packages/db/src/system/cleanup.ts の WorkspaceDO 版。db-schema.md §4.4 の4）。
// 自分の DO の中の、24時間より古い idempotency_keys・workspace_events を消す（alarm から呼ぶ）。
// entry_attempts は D1（全体）の表なので、ここでは消さない（全体の掃除は Cron Triggers の側）。
// Kill Switch の LISTEN/NOTIFY のチャンネル（KILL_SWITCH_CHANNEL）は要らない（Kill Switch は DO の中で発動し、その場で止める）

import { run, type WsDb } from "../sqlite.ts";

export const CLEANUP_DEFAULTS = {
  /** idempotency_keys・workspace_events を残す時間 */
  retentionMs: 24 * 60 * 60 * 1000,
} as const;

export interface PurgeResult {
  idempotencyKeys: number;
  workspaceEvents: number;
}

/** 24時間より古い冪等性のキー・SSE の事象を消す（DB §4.4 の4、AS 8-4） */
export function purgeExpiredRows(db: WsDb, now: Date, retentionMs: number = CLEANUP_DEFAULTS.retentionMs): PurgeResult {
  const before = new Date(now.getTime() - retentionMs);
  return db.transaction(() => ({
    idempotencyKeys: run(db, "DELETE FROM idempotency_keys WHERE created_at < ?", before),
    workspaceEvents: run(db, "DELETE FROM workspace_events WHERE created_at < ?", before),
  }));
}
