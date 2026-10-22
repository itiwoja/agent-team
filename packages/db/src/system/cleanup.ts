// 古い行の掃除（毎時。db-schema.md §4.4 の4）。ot_retention のロールの接続で呼ぶ。
// 24時間より古い entry_attempts・idempotency_keys・workspace_events を消す

import type { Db } from "../client.ts";

export const CLEANUP_DEFAULTS = {
  /** entry_attempts・idempotency_keys・workspace_events を残す時間 */
  retentionMs: 24 * 60 * 60 * 1000,
} as const;

/** Kill Switch の LISTEN/NOTIFY のチャンネル（SO §2.8）。payload はワークスペースの ID */
export const KILL_SWITCH_CHANNEL = "ot_kill_switch";

export interface PurgeResult {
  entryAttempts: number;
  idempotencyKeys: number;
  workspaceEvents: number;
}

/** 24時間より古い入口の試行・冪等性のキー・SSE の事象を消す（DB §4.4 の4、AS 8-4） */
export async function purgeExpiredRows(maint: Db, now: Date, retentionMs: number = CLEANUP_DEFAULTS.retentionMs): Promise<PurgeResult> {
  const before = new Date(now.getTime() - retentionMs);
  const a = await maint.query("DELETE FROM entry_attempts WHERE created_at < $1", [before]);
  const b = await maint.query("DELETE FROM idempotency_keys WHERE created_at < $1", [before]);
  const c = await maint.query("DELETE FROM workspace_events WHERE created_at < $1", [before]);
  return { entryAttempts: a.rowCount, idempotencyKeys: b.rowCount, workspaceEvents: c.rowCount };
}
