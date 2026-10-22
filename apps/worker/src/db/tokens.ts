// タスクのトークン（packages/db/src/session.ts の hashTaskToken の WorkspaceDO 版）。
// 生のトークンは持たず、SHA-256 を tasks.task_token_hash に入れ、task_token_expires_at > now で引き直す（期限ちょうどは無効）

import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export function hashTaskToken(rawToken: string): Buffer {
  return createHash("sha256").update(rawToken, "utf8").digest();
}
