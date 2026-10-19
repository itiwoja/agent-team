// Google カレンダーの接続（16 §3.6・§5 増分1）。偽の Google（token・カレンダー・revoke）と、偽の gateway（gcal のツールを入れる）で試す。
// オーナー（owner-setup の投入のあと）とゲスト（入口のたびに作るワークスペース）の両方
import { randomBytes } from "node:crypto";
import type { Db } from "@open-team/db";
import { useTestDb } from "@open-team/db/testing";
import type { GatewayClient } from "@open-team/gateway-client";
import { GCAL_CONNECTOR, GCAL_MCP_PATH, GCAL_SCOPES, GCAL_TOOL_DESCRIPTIONS, GCAL_TOOL_INPUT_SCHEMAS, type GcalToolName } from "@open-team/gcal-core";
import { toolHashOf, type Json } from "@open-team/kernel";
import { openSecret } from "@open-team/platform";
import { inProcessSimWorld, fakeGatewayClient, makeTestApp, ORIGIN, send, signInOwner, type TestApp } from "../test-helpers.ts";
import { ensureOwnerWorkspace } from "../owner-setup.ts";
import { enterGuest, guestHarness } from "../check/test-helpers.ts";
import { GOOGLE_CALENDAR_API_URL, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from "../connectors/google.ts";
import type { AppEnv, GoogleConnectEnv } from "../env.ts";
import { describe, expect, it } from "vitest";

const T = useTestDb();

const GOOGLE: GoogleConnectEnv = {
  clientId: "client-id-test.apps.googleusercontent.com",
  clientSecret: "client-secret-test-value",
  tokenKey: randomBytes(32).toString("base64"),
  gcalUrl: "http://gcal.test",
  appBaseUrl: ORIGIN,
};
const EMAIL = "Taro.Test@Gmail.com";
const CALENDAR_ID = "makase-cal-1@group.calendar.google.com";
const REFRESH = "1//refresh-token-secret-value";
const CALLBACK = `${ORIGIN}/api/v1/connect/google/callback`;

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.signature-not-checked`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface FakeGoogle {
  fetch: typeof fetch;
  calls: Array<{ url: string; method: string }>;
  /** 次の token 交換の応答を変える */
  next: { tokenStatus: number; scope: string; refresh: boolean };
}

/** Google の偽物（token・カレンダー・revoke）。既定は全部そろう成功 */
function fakeGoogle(): FakeGoogle {
  const calls: FakeGoogle["calls"] = [];
  const g: FakeGoogle = {
    calls,
    next: { tokenStatus: 200, scope: GCAL_SCOPES.join(" "), refresh: true },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === GOOGLE_TOKEN_URL) {
        if (g.next.tokenStatus !== 200) return new Response("denied by test", { status: g.next.tokenStatus });
        return json({
          access_token: "ya29.access-token-secret",
          expires_in: 3599,
          token_type: "Bearer",
          scope: g.next.scope,
          ...(g.next.refresh ? { refresh_token: REFRESH } : {}),
          id_token: idToken({ sub: "google-sub-123", email: EMAIL }),
        });
      }
      if (url === `${GOOGLE_CALENDAR_API_URL}/calendars`) return json({ id: CALENDAR_ID });
      if (url === GOOGLE_REVOKE_URL) return new Response("", { status: 200 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch,
  };
  return g;
}

/** gcal のツールを connector_tools に入れる gateway（tools/list の代わり。ほかのコネクタは元の偽物に任せる） */
function gcalGateway(db: Db, base: GatewayClient): GatewayClient {
  return {
    ...base,
    async revokeCredential(connectorId, workspaceId) {
      const row = await one<{ id: string; workspace_id: string }>(db, "SELECT id, workspace_id FROM connectors WHERE id = $1", [connectorId]);
      if (row && row.workspace_id !== workspaceId) throw new Error("workspace mismatch");
    },
    async syncTools(connectorId) {
      const c = (await db.query<{ id: string; workspace_id: string; slug: string }>("SELECT id, workspace_id, slug FROM connectors WHERE id = $1", [connectorId])).rows[0];
      if (!c || c.slug !== GCAL_CONNECTOR.slug) return base.syncTools(connectorId);
      for (const t of GCAL_CONNECTOR.tools) {
        const name = t.name as GcalToolName;
        const schema = GCAL_TOOL_INPUT_SCHEMAS[name] as unknown as Json;
        const description = GCAL_TOOL_DESCRIPTIONS[name];
        await db.query(
          `INSERT INTO connector_tools (workspace_id, connector_id, name, description, input_schema, classification, status, arg_roles, tool_hash)
           VALUES ($1, $2, $3, $4, $5, 'unclassified', 'ok', '{}', $6) ON CONFLICT (connector_id, name) DO NOTHING`,
          [c.workspace_id, c.id, name, description, schema, toolHashOf({ description, inputSchema: schema, argRoles: {} })],
        );
      }
      return { tools: GCAL_CONNECTOR.tools.map((t) => ({ name: t.name, toolHash: `sha256:${"0".repeat(64)}` as const, status: "ok" as const })) };
    },
  };
}

/** オーナーの世界（owner-setup の投入のあと、オーナーで入る） */
async function ownerApp(db: Db, google: FakeGoogle, env: Partial<AppEnv> = { googleConnect: GOOGLE, cookieSecure: false }) {
  const base = fakeGatewayClient(db);
  const sim = inProcessSimWorld();
  const t = makeTestApp(db, { env, deps: { gatewayClient: gcalGateway(db, base), simClient: sim.simClient, googleFetch: google.fetch } });
  await ensureOwnerWorkspace(t.deps);
  return { t, s: await signInOwner(t) };
}

/** ゲストの世界（入口で作る） */
async function guestApp(db: Db, google: FakeGoogle) {
  const { t } = guestHarness(db, { env: { googleConnect: GOOGLE } });
  t.deps.googleFetch = google.fetch;
  t.deps.gatewayClient = gcalGateway(db, t.deps.gatewayClient);
  return { t, s: await enterGuest(t) };
}

/** 同意画面へ行く（start）。state を返す */
async function startFlow(t: TestApp, cookie: string, tz?: string) {
  const res = await send(t, "GET", `/api/v1/connect/google/start${tz === undefined ? "" : `?tz=${encodeURIComponent(tz)}`}`, { headers: { cookie: `ot_session=${cookie}` } });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = /ot_gcal_state=([^;]*)/.exec(setCookie);
  // Cookie の値は URL エンコードされて出る（":" と "/" など）
  const stateCookie = decodeURIComponent(m?.[1] ?? "");
  const loc = new URL(res.headers.get("location") ?? "/", "https://accounts.google.com");
  return { res, setCookie, stateCookie, loc, state: loc.searchParams.get("state") ?? "" };
}

/** Google から戻ってくる（callback） */
async function callbackFlow(t: TestApp, cookie: string, stateCookie: string, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return send(t, "GET", `/api/v1/connect/google/callback?${qs}`, {
    headers: { cookie: `ot_session=${cookie}; ot_gcal_state=${encodeURIComponent(stateCookie)}` },
  });
}

const one = async <R extends object>(db: Db, sql: string, params: unknown[] = []): Promise<R | undefined> => (await db.query<R>(sql, params)).rows[0];

describe("start（16 §3.6）", () => {
  it("302 で Google の同意画面へ。scope・access_type・prompt・redirect_uri・state が入り、state の Cookie は10分・path を絞る", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google);
    const { res, setCookie, stateCookie, loc, state } = await startFlow(t, s.cookie, "Europe/Paris");
    expect(res.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("client_id")).toBe(GOOGLE.clientId);
    expect(loc.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("scope")).toBe(GCAL_SCOPES.join(" "));
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toBe("consent");
    expect(loc.searchParams.get("include_granted_scopes")).toBe("false");
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(stateCookie).toMatch(new RegExp(`^${state}:Europe/Paris:[A-Za-z0-9_-]{40,}$`));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=600/);
    expect(setCookie).toMatch(/Path=\/api\/v1\/connect\/google(;|$)/);
    expect(setCookie).not.toMatch(/Secure/i); // COOKIE_SECURE=false は Secure を付けない
    expect(google.calls).toEqual([]); // start は Google を呼ばない
  });

  it("cookieSecure のときは Cookie に Secure", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google, { googleConnect: GOOGLE, cookieSecure: true });
    const { setCookie } = await startFlow(t, s.cookie, "Asia/Tokyo");
    expect(setCookie).toMatch(/Secure/i);
  });

  it("tz が不正（Intl が知らない名前）なら Asia/Tokyo。セッションがなければ 401", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google);
    const { stateCookie } = await startFlow(t, s.cookie, "Mars/Olympus");
    expect(stateCookie.split(":")[1]).toBe("Asia/Tokyo");
    const anon = await send(t, "GET", "/api/v1/connect/google/start");
    expect(anon.status).toBe(401);
  });

  it("連携の env がないときは /?connect_error=unavailable（同意画面へ行かない）", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google, { googleConnect: undefined });
    const { res } = await startFlow(t, s.cookie);
    expect(res.headers.get("location")).toBe("/?connect_error=unavailable");
    expect(google.calls).toEqual([]);
  });
});

describe("callback の拒否（state・error・scope）", () => {
  it("開始時と別のセッションで戻った state は拒否する", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await guestApp(db, google);
    const { stateCookie, state } = await startFlow(t, s.cookie);
    // 別のゲスト（同じ DB の別の入口から入った別のセッション・ワークスペース）
    const other = await guestApp(db, google);
    const res = await callbackFlow(t, other.s.cookie, stateCookie, { code: "auth-code-1", state });
    expect(res.headers.get("location")).toBe("/?connect_error=state");
    expect(google.calls.filter((call) => call.url === GOOGLE_TOKEN_URL)).toEqual([]);
  });
  it("state が合わない → 拒否（/?connect_error=state）。token 交換もコネクタも作らない。Cookie は消す", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google);
    const { stateCookie } = await startFlow(t, s.cookie);
    const res = await callbackFlow(t, s.cookie, stateCookie, { code: "auth-code-1", state: "attacker-state" });
    expect(res.headers.get("location")).toBe("/?connect_error=state");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/ot_gcal_state=;/);
    expect(google.calls.filter((c) => c.url === GOOGLE_TOKEN_URL)).toEqual([]);
    expect(await one(db, "SELECT id FROM connectors WHERE slug = 'gcal'")).toBeUndefined();
  });

  it("state の Cookie がない → 拒否", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google);
    const res = await send(t, "GET", "/api/v1/connect/google/callback?code=x&state=y", { headers: { cookie: `ot_session=${s.cookie}` } });
    expect(res.headers.get("location")).toBe("/?connect_error=state");
  });

  it("error（同意しなかった）→ /?connect_error=denied", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google);
    const { stateCookie, state } = await startFlow(t, s.cookie);
    const res = await callbackFlow(t, s.cookie, stateCookie, { error: "access_denied", state });
    expect(res.headers.get("location")).toBe("/?connect_error=denied");
    expect(google.calls).toEqual([]);
  });

  it("必要な scope が1つ足りない → /?connect_error=scope。許可を取り消し、コネクタは作らない", async () => {
    const { db } = T();
    const google = fakeGoogle();
    google.next.scope = "openid email https://www.googleapis.com/auth/calendar.app.created";
    const { t, s } = await ownerApp(db, google);
    const { stateCookie, state } = await startFlow(t, s.cookie);
    const res = await callbackFlow(t, s.cookie, stateCookie, { code: "auth-code-1", state });
    expect(res.headers.get("location")).toBe("/?connect_error=scope");
    expect(google.calls.some((c) => c.url === GOOGLE_REVOKE_URL)).toBe(true);
    expect(google.calls.some((c) => c.url.endsWith("/calendars"))).toBe(false);
    expect(await one(db, "SELECT id FROM connectors WHERE slug = 'gcal'")).toBeUndefined();
  });

  it("refresh_token がない → /?connect_error=scope", async () => {
    const { db } = T();
    const google = fakeGoogle();
    google.next.refresh = false;
    const { t, s } = await ownerApp(db, google);
    const { stateCookie, state } = await startFlow(t, s.cookie);
    const res = await callbackFlow(t, s.cookie, stateCookie, { code: "auth-code-1", state });
    expect(res.headers.get("location")).toBe("/?connect_error=scope");
  });

  it("token 交換が失敗 → /?connect_error=failed。何も残らない", async () => {
    const { db } = T();
    const google = fakeGoogle();
    google.next.tokenStatus = 400;
    const { t, s } = await ownerApp(db, google);
    const { stateCookie, state } = await startFlow(t, s.cookie);
    const res = await callbackFlow(t, s.cookie, stateCookie, { code: "auth-code-1", state });
    expect(res.headers.get("location")).toBe("/?connect_error=failed");
    expect(await one(db, "SELECT id FROM connector_credentials")).toBeUndefined();
  });
});

describe("接続（happy path）と切断", () => {
  it("オーナー：コネクタ・暗号化した資格情報（AAD つき）・監査・ポリシーの新しい版・分類・同期まで入り、/?connected=gcal へ", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google);
    const versionBefore = (await one<{ v: number }>(db, "SELECT max(version) AS v FROM workspace_policies WHERE workspace_id = $1", [s.workspaceId]))?.v;
    const { stateCookie, state } = await startFlow(t, s.cookie, "Asia/Tokyo");
    const res = await callbackFlow(t, s.cookie, stateCookie, { code: "auth-code-1", state });
    expect(res.headers.get("location")).toBe("/?connected=gcal");
    // Cookie の state は消す（次は使えない）
    expect(res.headers.get("set-cookie") ?? "").toMatch(/ot_gcal_state=;/);
    // 資格情報を入れるのは私の calendar の作成の前ではなく、作ったあと。カレンダーの作成は1回
    const calendarCalls = google.calls.filter((c) => c.url.endsWith("/calendars"));
    expect(calendarCalls).toHaveLength(1);

    const conn = await one<{ id: string; kind: string; url: string; enabled: boolean; auth: { type: string; provider: string } }>(
      db,
      "SELECT id, kind, url, enabled, auth FROM connectors WHERE slug = 'gcal'",
    );
    expect(conn).toMatchObject({ kind: "mcp_remote", url: `${GOOGLE.gcalUrl}${GCAL_MCP_PATH}`, enabled: true, auth: { type: "oauth", provider: "google" } });
    const cred = await one<{ refresh_token_enc: string; email: string; calendar_id: string; time_zone: string; subject: string; scopes: string[]; revoked_at: Date | null }>(
      db,
      "SELECT refresh_token_enc, email, calendar_id, time_zone, subject, scopes, revoked_at FROM connector_credentials WHERE connector_id = $1",
      [conn!.id],
    );
    expect(cred).toMatchObject({ email: "taro.test@gmail.com", calendar_id: CALENDAR_ID, time_zone: "Asia/Tokyo", subject: "google-sub-123", revoked_at: null });
    expect(cred!.scopes).toEqual([...GCAL_SCOPES]);
    // 暗号文は平文を含まず、AAD（ワークスペース:コネクタ）で開ける。別の AAD では開けない
    expect(cred!.refresh_token_enc).not.toContain(REFRESH);
    expect(openSecret(GOOGLE.tokenKey, cred!.refresh_token_enc, `${s.workspaceId}:${conn!.id}`)).toBe(REFRESH);
    expect(() => openSecret(GOOGLE.tokenKey, cred!.refresh_token_enc, `${s.workspaceId}:00000000-0000-0000-0000-000000000000`)).toThrow();

    // 監査：接続・ポリシーの版（トークンは入らない）
    const audits = (await db.query<{ event_type: string; payload: Record<string, unknown> }>("SELECT event_type, payload FROM audit_logs WHERE workspace_id = $1 ORDER BY seq", [s.workspaceId])).rows;
    const connected = audits.find((a) => a.event_type === "connector.oauth.connected");
    expect(connected?.payload).toMatchObject({ slug: "gcal", email: "taro.test@gmail.com" });
    expect(audits.some((a) => a.event_type === "policy.snapshot_created" && a.payload.reason === "connector.oauth.connected")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(REFRESH);
    expect(JSON.stringify(audits)).not.toContain("ya29.");

    // ポリシーの版は1つ上がり、connectors.enabled に gcal が入る（同じ版の中身は変えない）
    const latest = await one<{ version: number; policy: { connectors: { enabled: string[] } } }>(
      db,
      "SELECT version, policy FROM workspace_policies WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1",
      [s.workspaceId],
    );
    expect(latest!.version).toBe(versionBefore! + 1);
    expect(latest!.policy.connectors.enabled).toContain("gcal");

    // gateway の同期と分類（create_event は write・ 宛先は attendees）
    const create = await one<{ classification: string; arg_roles: Record<string, string>; status: string }>(
      db,
      "SELECT classification, arg_roles, status FROM connector_tools WHERE connector_id = $1 AND name = 'create_event'",
      [conn!.id],
    );
    expect(create).toMatchObject({ classification: "write", status: "ok" });
    expect(create!.arg_roles).toMatchObject({ attendees: "destination", start: "option" });

    // 画面の表示
    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: s.cookie })).json()) as { workspace: { google: unknown } };
    expect(me.workspace.google).toEqual({ available: true, connected: true, email: "taro.test@gmail.com" });
  });

  it("切断（DELETE）：資格情報は取り消し（revoked_at）、コネクタは無効、ポリシーから外れ、監査が残る。2回目は何もしない", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google);
    const { stateCookie, state } = await startFlow(t, s.cookie);
    await callbackFlow(t, s.cookie, stateCookie, { code: "auth-code-1", state });

    const del = await send(t, "DELETE", "/api/v1/connect/google", { cookie: s.cookie, csrf: s.csrf });
    expect(del.status).toBe(204);
    const conn = await one<{ enabled: boolean }>(db, "SELECT enabled FROM connectors WHERE slug = 'gcal'");
    expect(conn?.enabled).toBe(false);
    expect(await one(db, "SELECT id FROM connector_credentials WHERE revoked_at IS NULL")).toBeUndefined();
    const latest = await one<{ policy: { connectors: { enabled: string[] } } }>(db, "SELECT policy FROM workspace_policies WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1", [s.workspaceId]);
    expect(latest!.policy.connectors.enabled).not.toContain("gcal");
    expect(await one(db, "SELECT event_type FROM audit_logs WHERE workspace_id = $1 AND event_type = 'connector.oauth.disconnected'", [s.workspaceId])).toBeDefined();
    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: s.cookie })).json()) as { workspace: { google: unknown } };
    expect(me.workspace.google).toEqual({ available: true, connected: false, email: null });

    const again = await send(t, "DELETE", "/api/v1/connect/google", { cookie: s.cookie, csrf: s.csrf });
    expect(again.status).toBe(204);
    expect(await one(db, "SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND event_type = 'connector.oauth.disconnected'", [s.workspaceId])).toEqual({ n: 1 });
  });

  it("ゲストのワークスペースでも同じく接続・切断できる", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await guestApp(db, google);
    const { stateCookie, state } = await startFlow(t, s.cookie, "Asia/Tokyo");
    const res = await callbackFlow(t, s.cookie, stateCookie, { code: "auth-code-1", state });
    expect(res.headers.get("location")).toBe("/?connected=gcal");
    const row = await one<{ workspace_id: string }>(db, "SELECT workspace_id FROM connector_credentials");
    expect(row?.workspace_id).toBe(s.workspaceId);
    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: s.cookie })).json()) as { workspace: { kind: string; google: unknown } };
    expect(me.workspace.kind).toBe("guest");
    expect(me.workspace.google).toEqual({ available: true, connected: true, email: "taro.test@gmail.com" });
    expect((await send(t, "DELETE", "/api/v1/connect/google", { cookie: s.cookie, csrf: s.csrf })).status).toBe(204);
  });
});

describe("workspace view の google（連携の env がないとき）", () => {
  it("available は false・connected は false・email は null", async () => {
    const { db } = T();
    const google = fakeGoogle();
    const { t, s } = await ownerApp(db, google, { googleConnect: undefined });
    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: s.cookie })).json()) as { workspace: { google: unknown } };
    expect(me.workspace.google).toEqual({ available: false, connected: false, email: null });
  });
});
