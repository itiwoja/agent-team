// Google のログイン（auth/routes.ts）。Google の token エンドポイントは偽物（fetch を差し替える）
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GOOGLE_TOKEN_URL } from "../src/auth/google.ts";
import { LOGIN_STATE_COOKIE, SESSION_COOKIE } from "../src/auth/routes.ts";
import { createApp } from "../src/index.ts";

const NOW = new Date("2026-10-22T09:00:00.000Z");
const ORIGIN = "https://makase.test";

function b64url(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function idToken(claims: Record<string, unknown>): string {
  const base = { iss: "https://accounts.google.com", aud: "client-id.test", sub: "google-sub-1", email: "owner@example.com", email_verified: true, name: "オーナー" };
  return `${b64url({ alg: "RS256" })}.${b64url({ ...base, ...claims })}.sig`;
}

/** Google の token エンドポイントの偽物。受けた本文を calls に残す */
function fakeGoogle(claims: Record<string, unknown> = {}, status = 200) {
  const calls: URLSearchParams[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    expect(String(input)).toBe(GOOGLE_TOKEN_URL);
    calls.push(new URLSearchParams(String(init?.body)));
    return Response.json(status === 200 ? { id_token: idToken(claims), access_token: "at" } : { error: "invalid_grant" }, { status });
  };
  return { fetchFn, calls };
}

function cookieOf(res: Response, name: string): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const m = new RegExp(`^${name.replace(/[$]/g, "\\$&")}=([^;]*)`).exec(raw);
    if (m) return m[1] ?? "";
  }
  return null;
}

/** start → callback まで進める。戻り値は callback の応答 */
async function login(app: ReturnType<typeof createApp>, o: { tamperState?: boolean } = {}): Promise<Response> {
  const start = await app.request(`${ORIGIN}/api/auth/google/start`, {}, env);
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get("location")!);
  expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(to.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
  expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  const stateCookie = cookieOf(start, LOGIN_STATE_COOKIE)!;
  const state = o.tamperState ? "other" : to.searchParams.get("state")!;
  return app.request(`${ORIGIN}/api/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: `${LOGIN_STATE_COOKIE}=${stateCookie}` } }, env);
}

describe("Google のログイン", () => {
  it("許可したメールアドレスなら利用者・ワークスペース・セッションを作り、2回目は同じワークスペース", async () => {
    const g = fakeGoogle();
    const app = createApp({ fetch: g.fetchFn, now: () => NOW });
    const res = await login(app);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = cookieOf(res, SESSION_COOKIE)!;
    expect(cookie.length).toBeGreaterThan(20);
    // PKCE の verifier を Google に渡している
    expect(g.calls[0]?.get("code_verifier")?.length).toBeGreaterThan(20);
    expect(g.calls[0]?.get("code")).toBe("abc");

    const session = await app.request(`${ORIGIN}/api/session`, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }, env);
    expect(await session.json()).toMatchObject({ state: "signed_in" });

    const first = await env.DB.prepare("SELECT u.email, m.workspace_id FROM users u JOIN memberships m ON m.user_id = u.id").all<{ email: string; workspace_id: string }>();
    expect(first.results).toHaveLength(1);
    expect(first.results[0]?.email).toBe("owner@example.com");
    const ws = env.WORKSPACE.get(env.WORKSPACE.idFromName(first.results[0]!.workspace_id));
    expect(await ws.schemaVersion()).toBeGreaterThan(0);

    await login(app);
    const again = await env.DB.prepare("SELECT workspace_id FROM memberships").all<{ workspace_id: string }>();
    expect(again.results).toEqual(first.results.map((r) => ({ workspace_id: r.workspace_id })));
  });

  it("許可していないメールアドレス・未確認のメールアドレス・別のクライアント向けの id_token は断る", async () => {
    // 保存は試験のファイルごとなので、前の試験のセッションを数に入れない
    const before = (await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>())?.n;
    for (const [claims, reason] of [
      [{ email: "someone@example.com" }, "not_allowed"],
      [{ email_verified: false }, "unverified"],
      [{ aud: "other-client" }, "failed"],
    ] as const) {
      const app = createApp({ fetch: fakeGoogle(claims).fetchFn, now: () => NOW });
      const res = await login(app);
      expect(res.headers.get("location")).toBe(`/?login=${reason}`);
      expect(cookieOf(res, SESSION_COOKIE)).toBeNull();
    }
    expect((await env.DB.prepare("SELECT count(*) AS n FROM sessions").first<{ n: number }>())?.n).toBe(before);
  });

  it("state が違う・Google が失敗を返したら断る", async () => {
    const tampered = await login(createApp({ fetch: fakeGoogle().fetchFn, now: () => NOW }), { tamperState: true });
    expect(tampered.headers.get("location")).toBe("/?login=failed");
    const failed = await login(createApp({ fetch: fakeGoogle({}, 400).fetchFn, now: () => NOW }));
    expect(failed.headers.get("location")).toBe("/?login=failed");
  });

  it("ログアウトは CSRF トークンが要り、そのあとセッションは使えない", async () => {
    const app = createApp({ fetch: fakeGoogle().fetchFn, now: () => NOW });
    const cookie = cookieOf(await login(app), SESSION_COOKIE)!;
    const headers = { cookie: `${SESSION_COOKIE}=${cookie}` };
    const { csrfToken } = (await (await app.request(`${ORIGIN}/api/session`, { headers }, env)).json()) as { csrfToken: string };
    expect((await app.request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers }, env)).status).toBe(403);
    expect((await app.request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { ...headers, "x-csrf-token": csrfToken } }, env)).status).toBe(200);
    expect(await (await app.request(`${ORIGIN}/api/session`, { headers }, env)).json()).toEqual({ state: "signed_out" });
  });
});
