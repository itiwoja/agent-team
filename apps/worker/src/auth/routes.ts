// ログインの API（docs/cloudflare-design.md の「ログイン」）
// - GET  /api/auth/google/start     … state と PKCE の verifier を短い Cookie に入れて Google へ
// - GET  /api/auth/google/callback  … state を確かめ、コードを交換し、許可したメールアドレスだけ通してセッションを作る
// - POST /api/auth/logout           … セッションを失効させる（CSRF の確認つき）
// - GET  /api/session               … ログインしているか・CSRF トークン
// 失敗は画面（/）に ?login=<理由> を付けて戻す（理由の内訳は出さない）

import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { buildGoogleAuthUrl, exchangeGoogleCode, GoogleLoginError, isAllowedEmail, randomToken, type GoogleLoginConfig } from "./google.ts";
import { ensureUser, issueSession, resolveSession, revokeSession, SESSION_TTL_MS, type SessionCtx } from "./session.ts";

export const SESSION_COOKIE = "__Host-makase_session";
export const LOGIN_STATE_COOKIE = "makase_login_state";
const LOGIN_STATE_PATH = "/api/auth/google";
const LOGIN_STATE_MAX_AGE_SEC = 10 * 60;

export interface AuthDeps {
  fetch: typeof fetch;
  now: () => Date;
}

export type AppEnv = { Bindings: Env; Variables: { session: SessionCtx | null } };

function googleConfig(env: Env): GoogleLoginConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.APP_BASE_URL) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.APP_BASE_URL.replace(/\/+$/, "")}${LOGIN_STATE_PATH}/callback`,
  };
}

/** 定数時間で比べる（長さが違えば false） */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Cookie からセッションを読んで c.var.session に入れる（ないときは null） */
export function sessionMiddleware(deps: AuthDeps) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    c.set("session", await resolveSession(c.env.DB, getCookie(c, SESSION_COOKIE), deps.now()));
    await next();
  };
}

/** 状態を変えるメソッドの CSRF（X-CSRF-Token をセッションの csrf_token と比べる） */
export function csrfOk(c: Context<AppEnv>): boolean {
  const s = c.var.session;
  const given = c.req.header("x-csrf-token");
  return s !== null && given !== undefined && sameText(s.csrfToken, given);
}

export function authRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  app.get(`${LOGIN_STATE_PATH}/start`, async (c) => {
    const cfg = googleConfig(c.env);
    if (cfg === null) return c.json({ error: "SETUP_REQUIRED" }, 503);
    const state = randomToken();
    const verifier = randomToken();
    setCookie(c, LOGIN_STATE_COOKIE, `${state}.${verifier}`, {
      path: LOGIN_STATE_PATH,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: LOGIN_STATE_MAX_AGE_SEC,
    });
    return c.redirect(await buildGoogleAuthUrl(cfg, state, verifier), 302);
  });

  app.get(`${LOGIN_STATE_PATH}/callback`, async (c) => {
    const cfg = googleConfig(c.env);
    if (cfg === null) return c.json({ error: "SETUP_REQUIRED" }, 503);
    const saved = getCookie(c, LOGIN_STATE_COOKIE) ?? "";
    deleteCookie(c, LOGIN_STATE_COOKIE, { path: LOGIN_STATE_PATH, secure: true });
    const [state, verifier] = saved.split(".");
    const code = c.req.query("code");
    const given = c.req.query("state");
    if (!state || !verifier || !code || !given || !sameText(state, given)) return c.redirect("/?login=failed", 302);

    let who;
    try {
      who = await exchangeGoogleCode(deps.fetch, cfg, code, verifier);
    } catch (e) {
      return c.redirect(`/?login=${e instanceof GoogleLoginError ? e.code : "failed"}`, 302);
    }
    if (!isAllowedEmail(c.env.ALLOWED_EMAILS, who.email)) return c.redirect("/?login=not_allowed", 302);

    const now = deps.now();
    const u = await ensureUser(c.env.DB, who, now);
    // ワークスペースの DO は名前（ID）で引く。初めてならオーナーを入れる（2回目以降も同じ値なので何も変わらない）
    await c.env.WORKSPACE.get(c.env.WORKSPACE.idFromName(u.workspaceId)).init(u.workspaceId, u.userId);
    const s = await issueSession(c.env.DB, { userId: u.userId, workspaceId: u.workspaceId, now });
    setCookie(c, SESSION_COOKIE, s.cookieValue, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: Math.floor(SESSION_TTL_MS / 1000) });
    return c.redirect("/", 302);
  });

  app.post("/api/auth/logout", async (c) => {
    if (!csrfOk(c)) return c.json({ error: "CSRF_TOKEN_INVALID" }, 403);
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) await revokeSession(c.env.DB, cookie, deps.now());
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    return c.json({ ok: true });
  });

  app.get("/api/session", (c) => {
    const s = c.var.session;
    return c.json(s === null ? { state: "signed_out" } : { state: "signed_in", csrfToken: s.csrfToken });
  });
}
