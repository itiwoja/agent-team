// セッション（DB §4.3、SO §3.6。DB のセッション）
// Cookie の値は32バイトの乱数（base64url 43文字）。DB には SHA-256 だけを入れ、生の値は残さない（08ws:202）。
// CSRF トークンも32バイトの乱数で、セッションの間は変えない（SO §3.8）。期限は最後のアクセスから7日（15:383）

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Queryable } from "./client.ts";
import type { MemberRole, Uuid, WorkspaceKind } from "./types.ts";
import type { WsCtx } from "./workspace.ts";

export const SESSION_LIMITS = {
  /** 最後のアクセスから7日（15:383。08 の30日ではない：DB C-02） */
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  /** last_seen_at の更新は1分に1回まで（15:383） */
  touchIntervalMs: 60_000,
  userAgentMaxChars: 512,
} as const;

/** セッションから引いたワークスペースの文脈（SO §2.4 の SessionContext） */
export interface SessionCtx extends WsCtx {
  readonly userId: Uuid;
  readonly role: MemberRole;
  readonly sessionId: Uuid;
  readonly csrfToken: string;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
}

export interface IssuedSession {
  sessionId: Uuid;
  /** Cookie ot_session に入れる値（DB には残らない） */
  cookieValue: string;
  csrfToken: string;
  expiresAt: Date;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 32バイトの乱数の base64url（43文字） */
export function newSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Cookie の値の SHA-256（32バイト） */
export function hashSessionToken(cookieValue: string): Buffer {
  return createHash("sha256").update(cookieValue, "utf8").digest();
}

/**
 * タスク単位の Bearer トークン（SO §3.10。32バイトの乱数）の SHA-256。tasks.task_token_hash に入れ、gateway・edge は
 * `WHERE task_token_hash = $1 AND task_token_expires_at > $now` で引き直す（DB §4.1 の3。期限ちょうどは無効）
 */
export function hashTaskToken(rawToken: string): Buffer {
  return createHash("sha256").update(rawToken, "utf8").digest();
}

/** CSRF トークンを定数時間で比べる（SO §3.8。長さの違いも時間から漏らさないよう SHA-256 にしてから比べる） */
export function csrfTokenMatches(expected: string, given: string | null | undefined): boolean {
  if (typeof given !== "string" || given.length === 0) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(given, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** セッションを作る（所属のないワークスペースには作れない：sessions_membership_fk） */
export async function issueSession(
  q: Queryable,
  i: { workspaceId: Uuid; userId: Uuid; ipHash: string | null; userAgent: string | null; now: Date },
): Promise<IssuedSession> {
  const cookieValue = newSecretToken();
  const csrfToken = newSecretToken();
  const expiresAt = new Date(i.now.getTime() + SESSION_LIMITS.ttlMs);
  const userAgent = i.userAgent === null ? null : i.userAgent.slice(0, SESSION_LIMITS.userAgentMaxChars);
  const r = await q.query<{ id: Uuid }>(
    `INSERT INTO sessions (workspace_id, user_id, token_hash, csrf_token, user_agent, ip_hash, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)
     RETURNING id`,
    [i.workspaceId, i.userId, hashSessionToken(cookieValue), csrfToken, userAgent, i.ipHash, i.now, expiresAt],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("セッションを作れなかった");
  return { sessionId: id, cookieValue, csrfToken, expiresAt };
}

/**
 * Cookie の値からセッションを引く。なし・失効・期限切れ（expires_at = now ちょうども無効）・
 * 所属がない・消した利用者は null（→ 401 か入口へ）
 */
export async function resolveSession(q: Queryable, cookieValue: string | null | undefined, now: Date): Promise<SessionCtx | null> {
  if (typeof cookieValue !== "string" || !TOKEN_RE.test(cookieValue)) return null;
  const r = await q.query<{
    session_id: Uuid;
    workspace_id: Uuid;
    user_id: Uuid;
    csrf_token: string;
    last_seen_at: Date;
    expires_at: Date;
    kind: WorkspaceKind;
    role: MemberRole;
  }>(
    `SELECT s.id AS session_id, s.workspace_id, s.user_id, s.csrf_token, s.last_seen_at, s.expires_at, w.kind, m.role
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > $2
        AND u.deleted_at IS NULL`,
    [hashSessionToken(cookieValue), now],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    kind: row.kind,
    userId: row.user_id,
    role: row.role,
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

/**
 * アクセスのたびに呼ぶ（SO §3.6）。前の更新から60秒以上たっていれば、セッションの last_seen_at と expires_at（now＋7日）、
 * ワークスペースの last_seen_at を更新する（59秒なら何もしない）。touched なら Cookie の Max-Age を出し直す
 */
export async function touchSession(q: Queryable, s: SessionCtx, now: Date): Promise<{ touched: boolean; expiresAt: Date }> {
  if (now.getTime() - s.lastSeenAt.getTime() < SESSION_LIMITS.touchIntervalMs) return { touched: false, expiresAt: s.expiresAt };
  const expiresAt = new Date(now.getTime() + SESSION_LIMITS.ttlMs);
  const threshold = new Date(now.getTime() - SESSION_LIMITS.touchIntervalMs);
  const r = await q.query(
    `UPDATE sessions SET last_seen_at = $3, expires_at = $4
      WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL AND last_seen_at <= $5`,
    [s.sessionId, s.workspaceId, now, expiresAt, threshold],
  );
  if (r.rowCount === 0) return { touched: false, expiresAt: s.expiresAt };
  await q.query("UPDATE workspaces SET last_seen_at = $2 WHERE id = $1 AND last_seen_at <= $3", [s.workspaceId, now, threshold]);
  return { touched: true, expiresAt };
}

/** セッションを失効させる（ログアウト・入口でトークンを入れ直したとき） */
export async function revokeSession(q: Queryable, s: Pick<SessionCtx, "sessionId" | "workspaceId">, now: Date): Promise<boolean> {
  const r = await q.query("UPDATE sessions SET revoked_at = $3 WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL", [
    s.sessionId,
    s.workspaceId,
    now,
  ]);
  return r.rowCount > 0;
}

/** ワークスペースのセッションをすべて失効させる（SO §3.6・3.7） */
export async function revokeWorkspaceSessions(q: Queryable, ctx: WsCtx, now: Date): Promise<number> {
  const r = await q.query("UPDATE sessions SET revoked_at = $2 WHERE workspace_id = $1 AND revoked_at IS NULL", [ctx.workspaceId, now]);
  return r.rowCount;
}
