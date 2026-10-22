// 利用者・ワークスペース・セッション（D1）。Cookie の値は保存せず SHA-256 だけを持つ
// 期限は作ってから SESSION_TTL_MS（延長しない）。ログアウトは revoked_at を入れる

import { randomToken } from "./google.ts";
import type { GoogleIdentity } from "./google.ts";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionCtx {
  userId: string;
  workspaceId: string;
  csrfToken: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Google の利用者を引く（なければ作る）。所属がなければワークスペースの ID を新しく作って所属を足す。
 * created は今回ワークスペースを作ったか（呼び出し側が WorkspaceDO を用意する）
 */
export async function ensureUser(db: D1Database, who: GoogleIdentity, now: Date): Promise<{ userId: string; workspaceId: string; created: boolean }> {
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (google_sub) DO UPDATE SET email = excluded.email, name = excluded.name`,
    )
    .bind(crypto.randomUUID(), who.sub, who.email, who.name, at)
    .run();
  const user = await db.prepare("SELECT id FROM users WHERE google_sub = ?1").bind(who.sub).first<{ id: string }>();
  if (user === null) throw new Error("利用者を読めなかった");
  const existing = await db.prepare("SELECT workspace_id FROM memberships WHERE user_id = ?1").bind(user.id).first<{ workspace_id: string }>();
  if (existing !== null) return { userId: user.id, workspaceId: existing.workspace_id, created: false };
  const workspaceId = crypto.randomUUID();
  // 同時に2回ログインしても所属は1つ（memberships_one_per_user）。負けた側は勝った側のワークスペースを使う
  await db
    .prepare("INSERT INTO memberships (user_id, workspace_id, role, created_at) VALUES (?1, ?2, 'owner', ?3) ON CONFLICT (user_id) DO NOTHING")
    .bind(user.id, workspaceId, at)
    .run();
  const m = await db.prepare("SELECT workspace_id FROM memberships WHERE user_id = ?1").bind(user.id).first<{ workspace_id: string }>();
  if (m === null) throw new Error("所属を読めなかった");
  return { userId: user.id, workspaceId: m.workspace_id, created: m.workspace_id === workspaceId };
}

/** セッションを作る。cookieValue は Cookie に入れる値（ここでしか分からない） */
export async function issueSession(db: D1Database, i: { userId: string; workspaceId: string; now: Date }): Promise<{ cookieValue: string; csrfToken: string }> {
  const cookieValue = randomToken();
  const csrfToken = randomToken();
  await db
    .prepare("INSERT INTO sessions (token_hash, user_id, workspace_id, csrf_token, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(await sha256Hex(cookieValue), i.userId, i.workspaceId, csrfToken, i.now.toISOString(), new Date(i.now.getTime() + SESSION_TTL_MS).toISOString())
    .run();
  return { cookieValue, csrfToken };
}

/** Cookie の値からセッションを引く。知らない・期限切れ・失効は null */
export async function resolveSession(db: D1Database, cookieValue: string | undefined, now: Date): Promise<SessionCtx | null> {
  if (!cookieValue || cookieValue.length > 128) return null;
  const row = await db
    .prepare("SELECT user_id, workspace_id, csrf_token FROM sessions WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2")
    .bind(await sha256Hex(cookieValue), now.toISOString())
    .first<{ user_id: string; workspace_id: string; csrf_token: string }>();
  return row === null ? null : { userId: row.user_id, workspaceId: row.workspace_id, csrfToken: row.csrf_token };
}

export async function revokeSession(db: D1Database, cookieValue: string, now: Date): Promise<void> {
  await db.prepare("UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL").bind(await sha256Hex(cookieValue), now.toISOString()).run();
}
