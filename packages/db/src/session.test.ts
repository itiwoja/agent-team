// セッションの試験（db-schema.md §7.3 の T-49〜T-54、SO §7.5 の SO-SES-01〜05）
import { describe, expect, it } from "vitest";
import { isForeignKeyViolation } from "./client.ts";
import {
  csrfTokenMatches,
  hashSessionToken,
  issueSession,
  newSecretToken,
  resolveSession,
  revokeSession,
  revokeWorkspaceSessions,
  SESSION_LIMITS,
  touchSession,
} from "./session.ts";
import { fxWorkspace, useTestDb } from "./testing.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");
const plus = (ms: number) => new Date(NOW.getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;

describe("発行と解決", () => {
  it("Cookie の値は DB に残らず SHA-256 だけ。解決するとワークスペースの文脈（kind・role）を返す", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const s = await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: "a".repeat(64), userAgent: "UA", now: NOW });
    expect(s.cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.expiresAt).toEqual(plus(7 * DAY));
    const raw = await db.query<{ token_hash: Buffer; csrf_token: string; ip_hash: string }>("SELECT token_hash, csrf_token, ip_hash FROM sessions");
    expect(raw.rows[0]?.token_hash.equals(hashSessionToken(s.cookieValue))).toBe(true);
    const dump = JSON.stringify(await db.query("SELECT * FROM sessions"));
    expect(dump).not.toContain(s.cookieValue);
    const ctx = await resolveSession(db, s.cookieValue, plus(1000));
    expect(ctx).toEqual({
      workspaceId: ws.workspaceId,
      kind: "owner",
      userId: ws.userId,
      role: "owner",
      sessionId: s.sessionId,
      csrfToken: s.csrfToken,
      lastSeenAt: NOW,
      expiresAt: plus(7 * DAY),
    });
  });

  it("T-49・T-50 expires_at = now ちょうどは無効、now の1ms前までは有効（SO-SES-01）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const s = await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: NOW });
    expect(await resolveSession(db, s.cookieValue, plus(7 * DAY))).toBeNull();
    expect(await resolveSession(db, s.cookieValue, plus(7 * DAY - 1))).not.toBeNull();
  });

  it("失効・Cookie を1文字変えた・形が違う・空は無効（SO-SES-02）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const s = await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: NOW });
    const flipped = (s.cookieValue[0] === "A" ? "B" : "A") + s.cookieValue.slice(1);
    expect(await resolveSession(db, flipped, NOW)).toBeNull();
    expect(await resolveSession(db, `${s.cookieValue}x`, NOW)).toBeNull();
    expect(await resolveSession(db, "", NOW)).toBeNull();
    expect(await resolveSession(db, undefined, NOW)).toBeNull();
    expect(await revokeSession(db, { sessionId: s.sessionId, workspaceId: ws.workspaceId }, NOW)).toBe(true);
    expect(await revokeSession(db, { sessionId: s.sessionId, workspaceId: ws.workspaceId }, NOW)).toBe(false);
    expect(await resolveSession(db, s.cookieValue, NOW)).toBeNull();
  });


  it("所属を外した・利用者を消した（deleted_at）セッションは無効。所属のないワークスペースには作れない", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    const s = await issueSession(db, { workspaceId: a.workspaceId, userId: a.userId, ipHash: null, userAgent: null, now: NOW });
    await db.query("UPDATE users SET deleted_at = now() WHERE id = $1", [a.userId]);
    expect(await resolveSession(db, s.cookieValue, NOW)).toBeNull();
    const e = await issueSession(db, { workspaceId: b.workspaceId, userId: a.userId, ipHash: null, userAgent: null, now: NOW }).catch((x: unknown) => x);
    expect(isForeignKeyViolation(e, "sessions_membership_fk")).toBe(true);
  });

  it("User-Agent は512文字で切る", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: "u".repeat(600), now: NOW });
    const r = await db.query<{ n: number }>("SELECT char_length(user_agent) AS n FROM sessions");
    expect(r.rows[0]?.n).toBe(SESSION_LIMITS.userAgentMaxChars);
  });
});

describe("延長（T-51・T-52、SO-SES-03）", () => {
  it("T-51 最後の更新から59秒では sessions・workspaces を更新しない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { lastSeenAt: NOW });
    const s = await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: NOW });
    const ctx = await resolveSession(db, s.cookieValue, plus(59_000));
    expect(ctx).not.toBeNull();
    if (!ctx) return;
    expect(await touchSession(db, ctx, plus(59_000))).toEqual({ touched: false, expiresAt: plus(7 * DAY) });
    const r = await db.query<{ s_seen: Date; w_seen: Date }>(
      "SELECT s.last_seen_at AS s_seen, w.last_seen_at AS w_seen FROM sessions s JOIN workspaces w ON w.id = s.workspace_id",
    );
    expect(r.rows[0]).toEqual({ s_seen: NOW, w_seen: NOW });
  });

  it("T-52 60秒で expires_at = now + 7日、workspaces.last_seen_at = now（Cookie を出し直す）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { lastSeenAt: NOW });
    const s = await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: NOW });
    const at = plus(60_000);
    const ctx = await resolveSession(db, s.cookieValue, at);
    if (!ctx) throw new Error("解決できない");
    expect(await touchSession(db, ctx, at)).toEqual({ touched: true, expiresAt: new Date(at.getTime() + 7 * DAY) });
    const r = await db.query<{ s_seen: Date; exp: Date; w_seen: Date }>(
      "SELECT s.last_seen_at AS s_seen, s.expires_at AS exp, w.last_seen_at AS w_seen FROM sessions s JOIN workspaces w ON w.id = s.workspace_id",
    );
    expect(r.rows[0]).toEqual({ s_seen: at, exp: new Date(at.getTime() + 7 * DAY), w_seen: at });
    // 同じ時刻にもう一度（別のリクエスト）→ 更新しない
    expect((await touchSession(db, ctx, at)).touched).toBe(false);
  });

  it("延長したセッションは元の期限を過ぎても有効（最後のアクセスから7日）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const s = await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: NOW });
    const ctx = await resolveSession(db, s.cookieValue, plus(6 * DAY));
    if (!ctx) throw new Error("解決できない");
    await touchSession(db, ctx, plus(6 * DAY));
    expect(await resolveSession(db, s.cookieValue, plus(8 * DAY))).not.toBeNull();
    expect(await resolveSession(db, s.cookieValue, plus(13 * DAY))).toBeNull();
  });

  it("ワークスペースのセッションをすべて失効させる", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const other = await fxWorkspace(db, { second: true });
    await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: NOW });
    await issueSession(db, { workspaceId: ws.workspaceId, userId: ws.userId, ipHash: null, userAgent: null, now: NOW });
    const keep = await issueSession(db, { workspaceId: other.workspaceId, userId: other.userId, ipHash: null, userAgent: null, now: NOW });
    expect(await revokeWorkspaceSessions(db, ws.ctx, NOW)).toBe(2);
    expect(await resolveSession(db, keep.cookieValue, NOW)).not.toBeNull();
  });
});

describe("CSRF（SO-SES-05）", () => {
  it("同じ値だけ通す（なし・違う値・別のセッションの値は通さない）", () => {
    const a = newSecretToken();
    const b = newSecretToken();
    expect(csrfTokenMatches(a, a)).toBe(true);
    expect(csrfTokenMatches(a, b)).toBe(false);
    expect(csrfTokenMatches(a, "")).toBe(false);
    expect(csrfTokenMatches(a, null)).toBe(false);
    expect(csrfTokenMatches(a, undefined)).toBe(false);
    expect(csrfTokenMatches(a, `${a}x`)).toBe(false);
    expect(a).not.toBe(b);
  });
});
