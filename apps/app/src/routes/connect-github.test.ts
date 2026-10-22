// GitHub の接続（18 §3.6）。偽の GitHub（認可コードの交換・利用者・インストール・トークンの取り消し）と、偽の gateway（github のツールを入れる）で試す
import type { Db } from "@open-team/db";
import { useTestDb } from "@open-team/db/testing";
import type { GatewayClient } from "@open-team/gateway-client";
import { GITHUB_CONNECTOR, GITHUB_MCP_PATH, GITHUB_TOOL_DESCRIPTIONS, GITHUB_TOOL_INPUT_SCHEMAS, type GithubToolName } from "@open-team/github-core";
import { toolHashOf, type Json } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import { chooseInstallation } from "../connectors/github.ts";
import type { AppEnv, GithubConnectEnv } from "../env.ts";
import { ensureOwnerWorkspace } from "../owner-setup.ts";
import { fakeGatewayClient, makeTestApp, ORIGIN, send, signInOwner, type TestApp } from "../test-helpers.ts";

const T = useTestDb();

const GITHUB: GithubConnectEnv = {
  clientId: "Iv1.testclientid0001",
  clientSecret: "github-client-secret-test-value-0123",
  appSlug: "makase-test",
  githubUrl: "http://github-adapter.test",
  appBaseUrl: ORIGIN,
  webBase: "https://github.test",
  apiBase: "https://api.github.test",
};
const USER_TOKEN = "ghu_usertokensecretvalue0123456789";
const CALLBACK = `${ORIGIN}/api/v1/connect/github/callback`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const one = async <R extends object>(db: Db, sql: string, params: unknown[] = []): Promise<R | undefined> => (await db.query<R>(sql, params)).rows[0];

interface FakeGithub {
  fetch: typeof fetch;
  calls: Array<{ url: string; method: string; body: string }>;
  next: { tokenOk: boolean; installations: Array<{ id: number; app_slug: string; account: { login: string } }> };
}

function fakeGithub(): FakeGithub {
  const g: FakeGithub = {
    calls: [],
    next: { tokenOk: true, installations: [{ id: 777, app_slug: "makase-test", account: { login: "octocat" } }] },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      g.calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
      if (url === `${GITHUB.webBase}/login/oauth/access_token`) return g.next.tokenOk ? json({ access_token: USER_TOKEN, token_type: "bearer" }) : json({ error: "bad_verification_code" });
      if (url === `${GITHUB.apiBase}/user`) return json({ id: 583231, login: "octocat" });
      if (url.startsWith(`${GITHUB.apiBase}/user/installations`)) return json({ total_count: g.next.installations.length, installations: g.next.installations });
      if (url === `${GITHUB.apiBase}/applications/${GITHUB.clientId}/token`) return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch,
  };
  return g;
}

function githubGateway(db: Db, base: GatewayClient, dropped: string[] = []): GatewayClient {
  return {
    ...base,
    async revokeCredential(connectorId) {
      dropped.push(connectorId);
    },
    async syncTools(connectorId) {
      const c = (await db.query<{ id: string; workspace_id: string; slug: string }>("SELECT id, workspace_id, slug FROM connectors WHERE id = $1", [connectorId])).rows[0];
      if (!c || c.slug !== GITHUB_CONNECTOR.slug) return base.syncTools(connectorId);
      for (const t of GITHUB_CONNECTOR.tools) {
        const name = t.name as GithubToolName;
        const schema = GITHUB_TOOL_INPUT_SCHEMAS[name] as unknown as Json;
        const description = GITHUB_TOOL_DESCRIPTIONS[name];
        await db.query(
          `INSERT INTO connector_tools (workspace_id, connector_id, name, description, input_schema, classification, status, arg_roles, tool_hash)
           VALUES ($1, $2, $3, $4, $5, 'unclassified', 'ok', '{}', $6) ON CONFLICT (connector_id, name) DO NOTHING`,
          [c.workspace_id, c.id, name, description, schema, toolHashOf({ description, inputSchema: schema, argRoles: {} })],
        );
      }
      return { tools: GITHUB_CONNECTOR.tools.map((t) => ({ name: t.name, toolHash: `sha256:${"0".repeat(64)}` as const, status: "ok" as const })) };
    },
  };
}

async function ownerApp(db: Db, github: FakeGithub, env: Partial<AppEnv> = { githubConnect: GITHUB }, dropped: string[] = []) {
  const t = makeTestApp(db, { env, deps: { gatewayClient: githubGateway(db, fakeGatewayClient(db), dropped), githubFetch: github.fetch } });
  await ensureOwnerWorkspace(t.deps);
  return { t, s: await signInOwner(t) };
}

async function startFlow(t: TestApp, cookie: string, mode?: string) {
  const res = await send(t, "GET", `/api/v1/connect/github/start${mode ? `?mode=${mode}` : ""}`, { headers: { cookie: `ot_session=${cookie}` } });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const stateCookie = decodeURIComponent(/ot_github_state=([^;]*)/.exec(setCookie)?.[1] ?? "");
  const loc = new URL(res.headers.get("location") ?? "/", "https://example.invalid");
  return { res, setCookie, stateCookie, loc, state: loc.searchParams.get("state") ?? "" };
}

async function callbackFlow(t: TestApp, cookie: string, stateCookie: string, query: Record<string, string>) {
  return send(t, "GET", `/api/v1/connect/github/callback?${new URLSearchParams(query).toString()}`, {
    headers: { cookie: `ot_session=${cookie}; ot_github_state=${encodeURIComponent(stateCookie)}` },
  });
}

async function connect(t: TestApp, s: { cookie: string }, query: Record<string, string> = {}) {
  const { stateCookie, state } = await startFlow(t, s.cookie);
  return callbackFlow(t, s.cookie, stateCookie, { code: "gh-code-1", state, installation_id: "777", setup_action: "install", ...query });
}

describe("start（18 §3.6）", () => {
  it("既定は GitHub App のインストールの画面へ、mode=authorize は認可の画面へ。state の Cookie は10分・path を絞る", async () => {
    const { db } = T();
    const github = fakeGithub();
    const { t, s } = await ownerApp(db, github);
    const a = await startFlow(t, s.cookie);
    expect(a.res.status).toBe(302);
    expect(a.loc.origin + a.loc.pathname).toBe("https://github.test/apps/makase-test/installations/new");
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(a.stateCookie.startsWith(`${a.state}:`)).toBe(true);
    expect(a.setCookie).toMatch(/HttpOnly/i);
    expect(a.setCookie).toMatch(/Max-Age=600/);
    expect(a.setCookie).toMatch(/Path=\/api\/v1\/connect\/github(;|$)/);

    const b = await startFlow(t, s.cookie, "authorize");
    expect(b.loc.origin + b.loc.pathname).toBe("https://github.test/login/oauth/authorize");
    expect(b.loc.searchParams.get("client_id")).toBe(GITHUB.clientId);
    expect(b.loc.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(github.calls).toEqual([]);
  });

  it("連携の env がないときは /?connect_error=github_unavailable", async () => {
    const { db } = T();
    const { t, s } = await ownerApp(db, fakeGithub(), { githubConnect: undefined });
    const { res } = await startFlow(t, s.cookie);
    expect(res.headers.get("location")).toBe("/?connect_error=github_unavailable");
  });
});

describe("callback", () => {
  it("つなぐ：本人とインストールを確かめ、秘密なしの資格情報・監査・ポリシーの版・分類まで入る。利用者のトークンは取り消す", async () => {
    const { db } = T();
    const github = fakeGithub();
    const { t, s } = await ownerApp(db, github);
    const versionBefore = (await one<{ v: number }>(db, "SELECT max(version) AS v FROM workspace_policies WHERE workspace_id = $1", [s.workspaceId]))?.v;
    const res = await connect(t, s);
    expect(res.headers.get("location")).toBe("/?connected=github");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/ot_github_state=;/);

    const exchange = github.calls.find((c) => c.url.endsWith("/login/oauth/access_token"))!;
    expect(new URLSearchParams(exchange.body).get("redirect_uri")).toBe(CALLBACK);
    expect(github.calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/applications/${GITHUB.clientId}/token`))).toBe(true);

    const conn = await one<{ id: string; url: string; auth: unknown; enabled: boolean }>(db, "SELECT id, url, auth, enabled FROM connectors WHERE slug = 'github'");
    expect(conn).toMatchObject({ url: `${GITHUB.githubUrl}${GITHUB_MCP_PATH}`, auth: { type: "oauth", provider: "github" }, enabled: true });
    const cred = await one<Record<string, unknown>>(db, "SELECT provider, subject, account_login, installation_id::text AS installation_id, refresh_token_enc, allow_protected_write FROM connector_credentials");
    expect(cred).toEqual({ provider: "github", subject: "583231", account_login: "octocat", installation_id: "777", refresh_token_enc: null, allow_protected_write: false });

    const audits = (await db.query<{ event_type: string; payload: Record<string, unknown> }>("SELECT event_type, payload FROM audit_logs WHERE workspace_id = $1 ORDER BY seq", [s.workspaceId])).rows;
    expect(audits.find((a) => a.event_type === "connector.oauth.connected")?.payload).toMatchObject({ slug: "github", login: "octocat", installationId: "777" });
    expect(JSON.stringify(audits)).not.toContain(USER_TOKEN);
    const latest = await one<{ version: number; policy: { connectors: { enabled: string[] } } }>(db, "SELECT version, policy FROM workspace_policies WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1", [s.workspaceId]);
    expect(latest!.version).toBe(versionBefore! + 1);
    expect(latest!.policy.connectors.enabled).toContain("github");

    const push = await one<{ classification: string; arg_roles: Record<string, string> }>(db, "SELECT classification, arg_roles FROM connector_tools WHERE connector_id = $1 AND name = 'push_commit'", [conn!.id]);
    expect(push).toMatchObject({ classification: "write", arg_roles: { repo: "destination", branch: "destination" } });

    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: s.cookie })).json()) as { workspace: { github: unknown } };
    expect(me.workspace.github).toEqual({ available: true, connected: true, login: "octocat", allowProtectedWrite: false, settingsUrl: "https://github.test/settings/installations/777" });
  });

  it("URL の installation_id が本人のものでなければ使わない（本人のインストールを選ぶ）", async () => {
    const { db } = T();
    const github = fakeGithub();
    const { t, s } = await ownerApp(db, github);
    await connect(t, s, { installation_id: "999999" });
    expect((await one<{ i: string }>(db, "SELECT installation_id::text AS i FROM connector_credentials"))?.i).toBe("777");
  });

  it("本人が使えるインストールがない → github_not_installed。何も残らず、利用者のトークンは取り消す", async () => {
    const { db } = T();
    const github = fakeGithub();
    github.next.installations = [];
    const { t, s } = await ownerApp(db, github);
    const res = await connect(t, s);
    expect(res.headers.get("location")).toBe("/?connect_error=github_not_installed");
    expect(await one(db, "SELECT id FROM connector_credentials")).toBeUndefined();
    expect(github.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("state が合わない → github_state（GitHub は呼ばない）。error → github_denied。code の交換の失敗 → github_failed", async () => {
    const { db } = T();
    const github = fakeGithub();
    const { t, s } = await ownerApp(db, github);
    const { stateCookie } = await startFlow(t, s.cookie);
    expect((await callbackFlow(t, s.cookie, stateCookie, { code: "x", state: "attacker" })).headers.get("location")).toBe("/?connect_error=github_state");
    expect(github.calls).toEqual([]);
    const f2 = await startFlow(t, s.cookie);
    expect((await callbackFlow(t, s.cookie, f2.stateCookie, { error: "access_denied", state: f2.state })).headers.get("location")).toBe("/?connect_error=github_denied");
    github.next.tokenOk = false;
    expect((await connect(t, s)).headers.get("location")).toBe("/?connect_error=github_failed");
    expect(await one(db, "SELECT id FROM connector_credentials")).toBeUndefined();
  });

  it("インストールだけで code がない（App が認可を求めていない）→ 認可の画面へ回す", async () => {
    const { db } = T();
    const { t, s } = await ownerApp(db, fakeGithub());
    const { stateCookie, state } = await startFlow(t, s.cookie);
    const res = await callbackFlow(t, s.cookie, stateCookie, { state, installation_id: "777", setup_action: "install" });
    expect(res.headers.get("location")).toBe("/api/v1/connect/github/start?mode=authorize");
  });
});

describe("main への書き込みの許可・切断", () => {
  it("許可を切り替えると行と画面の表示が変わり、変えたときだけ監査が残る。つながっていなければ 404", async () => {
    const { db } = T();
    const { t, s } = await ownerApp(db, fakeGithub());
    const before = await send(t, "PUT", "/api/v1/connect/github/protected-write", { cookie: s.cookie, csrf: s.csrf, body: { allow: true } });
    expect(before.status).toBe(404);
    await connect(t, s);
    const on = await send(t, "PUT", "/api/v1/connect/github/protected-write", { cookie: s.cookie, csrf: s.csrf, body: { allow: true } });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ allowProtectedWrite: true });
    await send(t, "PUT", "/api/v1/connect/github/protected-write", { cookie: s.cookie, csrf: s.csrf, body: { allow: true } });
    expect((await one<{ a: boolean }>(db, "SELECT allow_protected_write AS a FROM connector_credentials WHERE revoked_at IS NULL"))?.a).toBe(true);
    const n = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND event_type = 'connector.github.protected_write_changed'", [s.workspaceId]);
    expect(n).toEqual({ n: 1 });
    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: s.cookie })).json()) as { workspace: { github: { allowProtectedWrite: boolean } } };
    expect(me.workspace.github.allowProtectedWrite).toBe(true);
  });

  it("CSRF のトークンが無い切り替えは通らない。本文の形が違えば 400", async () => {
    const { db } = T();
    const { t, s } = await ownerApp(db, fakeGithub());
    await connect(t, s);
    expect((await send(t, "PUT", "/api/v1/connect/github/protected-write", { cookie: s.cookie, body: { allow: true } })).status).toBe(403);
    expect((await send(t, "PUT", "/api/v1/connect/github/protected-write", { cookie: s.cookie, csrf: s.csrf, body: { allow: "yes" } })).status).toBe(400);
    expect((await one<{ a: boolean }>(db, "SELECT allow_protected_write AS a FROM connector_credentials"))?.a).toBe(false);
  });

  it("切断：資格情報は取り消し、コネクタは無効、ポリシーから外れ、gateway のキャッシュを捨てる。再接続では許可は戻る（false）", async () => {
    const { db } = T();
    const dropped: string[] = [];
    const { t, s } = await ownerApp(db, fakeGithub(), { githubConnect: GITHUB }, dropped);
    await connect(t, s);
    await send(t, "PUT", "/api/v1/connect/github/protected-write", { cookie: s.cookie, csrf: s.csrf, body: { allow: true } });
    expect((await send(t, "DELETE", "/api/v1/connect/github", { cookie: s.cookie, csrf: s.csrf })).status).toBe(204);
    expect(dropped).toHaveLength(1);
    expect(await one(db, "SELECT id FROM connector_credentials WHERE revoked_at IS NULL")).toBeUndefined();
    const latest = await one<{ policy: { connectors: { enabled: string[] } } }>(db, "SELECT policy FROM workspace_policies WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1", [s.workspaceId]);
    expect(latest!.policy.connectors.enabled).not.toContain("github");
    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: s.cookie })).json()) as { workspace: { github: unknown } };
    expect(me.workspace.github).toEqual({ available: true, connected: false, login: null, allowProtectedWrite: false, settingsUrl: null });

    await connect(t, s);
    expect((await one<{ a: boolean }>(db, "SELECT allow_protected_write AS a FROM connector_credentials WHERE revoked_at IS NULL"))?.a).toBe(false);
  });
});

describe("chooseInstallation", () => {
  const user = { id: "1", login: "octocat" };
  const installs = [
    { id: 1, accountLogin: "some-org" },
    { id: 2, accountLogin: "OctoCat" },
  ];
  it("求めた ID が本人のものならそれ、なければ本人のアカウントのもの", () => {
    expect(chooseInstallation(installs, "1", user).id).toBe(1);
    expect(chooseInstallation(installs, "3", user).id).toBe(2);
    expect(chooseInstallation(installs, undefined, user).id).toBe(2);
    expect(chooseInstallation([{ id: 5, accountLogin: "x" }], undefined, user).id).toBe(5);
    expect(() => chooseInstallation([], "1", user)).toThrow();
  });
});
