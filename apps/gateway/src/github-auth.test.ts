// GitHub のコネクタの証明（18 §3.5、D-119、ADR-002）：GitHub App の JWT でインストールのトークンを作り、キャッシュする・
// 保護したブランチへの許可は実行のときの行の値・アンインストール（404）は auth_required・同期では GitHub の頭を送らない・
// リハーサル・影は模擬がないので拒否される
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { useTestDb, type FxWorkspace } from "@open-team/db/testing";
import { insertGithubCredential, setGithubProtectedWrite, upsertOAuthConnector, type ConnectorRow, type Db } from "@open-team/db";
import {
  GITHUB_CONNECTOR,
  GITHUB_DISPLAY_NAME,
  GITHUB_HEADER,
  GITHUB_SLUG,
  GITHUB_TOOL_DESCRIPTIONS,
  GITHUB_TOOL_INPUT_SCHEMAS,
  type GithubToolName,
} from "@open-team/github-core";
import { toolHashOf, type ArgRoleMap, type Json } from "@open-team/kernel";
import { connectorBoundary, isOwnConnector, isOwnGithubConnector } from "./boundary.ts";
import { ConnectorAuthRequired, ConnectorAuthUnsupported, ConnectorTokenUnavailable, defaultConnectorAuth, githubAppJwt } from "./context.ts";
import { normalizePrivateKey, type GithubConfig } from "./env.ts";
import { NOW, gatewayEnv, insertIntent, intentRow, rpcResponse, startGateway, taskWithToken, workspace, type FetchHook } from "./test-helpers.ts";

const T = useTestDb();

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const GH_BASE = "http://localhost:8084";
const GH_URL = `${GH_BASE}/mcp/github`;
const API = "https://api.github.test";
const SHARED = "github-shared-token-for-gateway-tests-0123";
const INSTALL_TOKEN = "ghs_installationtokenforgatewaytests0123";
const INSTALLATION = 42424242;
const GH_CFG: GithubConfig = { url: GH_BASE, origin: GH_BASE, appId: "123456", privateKey: PRIVATE_PEM, apiBase: API, sharedToken: SHARED };

interface GithubFake {
  status: number;
  /** 発行の依頼に付いた Authorization（JWT） */
  issued: Array<{ url: string; authorization: string }>;
  expiresAt: string;
}
const okFake = (): GithubFake => ({ status: 201, issued: [], expiresAt: new Date(NOW.getTime() + 3600_000).toISOString() });

function issueResponse(f: GithubFake): Response {
  return new Response(f.status === 201 ? JSON.stringify({ token: INSTALL_TOKEN, expires_at: f.expiresAt }) : "{}", {
    status: f.status,
    headers: { "content-type": "application/json" },
  });
}

function tokenFetch(f: GithubFake): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(`${API}/app/installations/`)) throw new Error(`想定外の宛先：${url}`);
    f.issued.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    return issueResponse(f);
  }) as typeof fetch;
}

function githubHook(f: GithubFake): FetchHook {
  return (req) => {
    if (req.url.startsWith(`${API}/app/installations/`)) {
      f.issued.push({ url: req.url, authorization: String(req.headers.authorization ?? "") });
      return issueResponse(f);
    }
    if (!req.url.startsWith(GH_BASE)) return null;
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.rpc === "notifications/initialized") return new Response(null, { status: 202 });
    if (req.rpc === "initialize") {
      return rpcResponse(req, { result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "github-fake", version: "0.0.0" } } });
    }
    if (req.rpc === "tools/list") {
      const tools = GITHUB_CONNECTOR.tools.map((t) => ({
        name: t.name,
        description: GITHUB_TOOL_DESCRIPTIONS[t.name as GithubToolName],
        inputSchema: GITHUB_TOOL_INPUT_SCHEMAS[t.name as GithubToolName],
      }));
      return rpcResponse(req, { result: { tools } });
    }
    if (req.rpc === "tools/call") {
      const payload = { repo: "octo/app", branch: "makase/x", commit_sha: "abc", created_branch: true };
      return rpcResponse(req, { result: { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload } });
    }
    return null;
  };
}

async function seedGithub(db: Db, ws: FxWorkspace, withCredential = true, installationId = INSTALLATION): Promise<{ conn: ConnectorRow; credentialId: string | null }> {
  return db.transaction(async (tx) => {
    const conn = await upsertOAuthConnector(tx, ws.ctx, { slug: GITHUB_SLUG, displayName: GITHUB_DISPLAY_NAME, url: GH_URL, now: NOW, provider: "github" });
    const credentialId = withCredential
      ? await insertGithubCredential(tx, ws.ctx, { connectorId: conn.id, subject: "583231", accountLogin: "octocat", installationId, now: NOW })
      : null;
    return { conn, credentialId };
  });
}

const providerEnv = () => gatewayEnv(null, { allowedConnectorUrls: [GH_BASE], github: GH_CFG });

function verifyJwt(jwt: string): Record<string, unknown> {
  const [h, b, sig] = jwt.split(".");
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${b}`);
  expect(v.verify(createPublicKey(publicKey.export({ type: "pkcs1", format: "pem" })), Buffer.from(sig!, "base64url"))).toBe(true);
  expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  return JSON.parse(Buffer.from(b!, "base64url").toString()) as Record<string, unknown>;
}

describe("GitHub App の JWT と環境変数の鍵", () => {
  it("RS256 で署名し、iss は App の ID・iat は60秒前・exp は9分後", () => {
    const claims = verifyJwt(githubAppJwt("123456", PRIVATE_PEM, NOW.getTime()));
    const now = Math.floor(NOW.getTime() / 1000);
    expect(claims).toEqual({ iss: "123456", iat: now - 60, exp: now + 540 });
  });

  it("改行を \\n で書いた鍵も受け、PEM でなければ null", () => {
    expect(normalizePrivateKey(PRIVATE_PEM.replace(/\n/g, "\\n"))).toBe(PRIVATE_PEM);
    expect(normalizePrivateKey("not a key")).toBeNull();
  });
});

describe("既定の証明（defaultConnectorAuth。18 §3.5）", () => {
  it("インストールのトークンを1回だけ作り、期限（expires_at−60秒）までキャッシュする", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const { conn } = await seedGithub(db, ws);
    const fake = okFake();
    let t = NOW.getTime();
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => new Date(t) } });

    const h1 = await provider({ connector: conn, simWorld: false, intentId: null, purpose: "call" });
    expect(h1[GITHUB_HEADER.token]).toBe(INSTALL_TOKEN);
    expect(h1[GITHUB_HEADER.allowProtectedWrite]).toBe("false");
    expect(h1[GITHUB_HEADER.idempotencyKey]).toBeUndefined();
    expect(fake.issued).toHaveLength(1);
    expect(fake.issued[0]!.url).toBe(`${API}/app/installations/${INSTALLATION}/access_tokens`);
    expect(verifyJwt(fake.issued[0]!.authorization.replace(/^Bearer /, "")).iss).toBe("123456");

    await provider({ connector: conn, simWorld: false, intentId: null, purpose: "call" });
    expect(fake.issued).toHaveLength(1);
    t += 3541_000;
    await provider({ connector: conn, simWorld: false, intentId: null, purpose: "call" });
    expect(fake.issued).toHaveLength(2);
  });

  it("保護したブランチへの許可は、呼ぶときの行の値（切り替えたらすぐ効く）", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const { conn, credentialId } = await seedGithub(db, ws);
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(okFake()), clock: { now: () => NOW } });
    await db.transaction((tx) => setGithubProtectedWrite(tx, ws.ctx, credentialId!, true));
    expect((await provider({ connector: conn, simWorld: false, intentId: null, purpose: "call" }))[GITHUB_HEADER.allowProtectedWrite]).toBe("true");
    await db.transaction((tx) => setGithubProtectedWrite(tx, ws.ctx, credentialId!, false));
    expect((await provider({ connector: conn, simWorld: false, intentId: null, purpose: "call" }))[GITHUB_HEADER.allowProtectedWrite]).toBe("false");
  });

  it("アンインストール（404）・一時停止（403）は ConnectorAuthRequired、5xx は ConnectorTokenUnavailable", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const { conn } = await seedGithub(db, ws);
    for (const [status, cls, reason] of [
      [404, ConnectorAuthRequired, "installation_gone"],
      [403, ConnectorAuthRequired, "installation_suspended"],
      [502, ConnectorTokenUnavailable, "http_502"],
    ] as const) {
      const fake = { ...okFake(), status };
      // キャッシュに当たらないよう、時計を毎回ずらす
      const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => new Date(NOW.getTime() + status * 3600_000) } });
      const e = await provider({ connector: conn, simWorld: false, intentId: null, purpose: "call" }).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(cls);
      expect((e as { reason: string }).reason).toBe(reason);
    }
  });

  it("資格情報がない → ConnectorAuthRequired（no_credential）。トークンは作らない", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const { conn } = await seedGithub(db, ws, false);
    const fake = okFake();
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => NOW } });
    await expect(provider({ connector: conn, simWorld: false, intentId: null, purpose: "call" })).rejects.toMatchObject({ reason: "no_credential" });
    expect(fake.issued).toHaveLength(0);
  });

  it("同期（list）はトークンを作らず、URL が GITHUB_URL と違えば証明しない", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const { conn } = await seedGithub(db, ws);
    const fake = okFake();
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => NOW } });
    const h = await provider({ connector: conn, simWorld: false, intentId: null, purpose: "list" });
    expect(h[GITHUB_HEADER.token]).toBeUndefined();
    expect(h.authorization).toBe(`Bearer ${SHARED}`);
    expect(fake.issued).toHaveLength(0);
    await expect(provider({ connector: { ...conn, url: "https://evil.example/mcp/github" }, simWorld: false, intentId: null, purpose: "call" })).rejects.toBeInstanceOf(
      ConnectorAuthUnsupported,
    );
  });
});

describe("境界（18 §3.5）", () => {
  const conn = { url: GH_URL, auth: { type: "oauth", provider: "github" } as const };
  it("本人の GitHub のコネクタはゲストでも通し、リハーサル・影は拒否する（模擬の GitHub はない）", () => {
    expect(isOwnGithubConnector(conn, GH_BASE)).toBe(true);
    expect(isOwnGithubConnector({ ...conn, auth: { type: "oauth", provider: "google" } }, GH_BASE)).toBe(false);
    expect(isOwnConnector({ gcalOrigin: null, githubOrigin: GH_BASE }, conn)).toBe(true);
    const base = { simWorldOrigin: null, connectorUrl: GH_URL, ownOAuthConnector: true };
    expect(connectorBoundary({ ...base, workspaceKind: "guest", rehearsalRunId: null, shadow: false })).toEqual({ ok: true });
    expect(connectorBoundary({ ...base, workspaceKind: "owner", rehearsalRunId: "r1", shadow: false })).toEqual({ ok: false, reasonCode: "rehearsal_real_connector" });
    expect(connectorBoundary({ ...base, workspaceKind: "owner", rehearsalRunId: null, shadow: true })).toEqual({ ok: false, reasonCode: "shadow_real_connector" });
  });
});

describe("実行（executeIntent）", () => {
  /** インストールのトークンのキャッシュはプロセスの中で共有なので、試験ごとに別のインストールにする */
  async function setupFlow(installationId: number) {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const fake = okFake();
    const gw = startGateway(db, providerEnv(), { hook: githubHook(fake) });
    const { conn, credentialId } = await seedGithub(db, ws, true, installationId);
    await gw.client.syncTools(conn.id);
    const tools: Record<string, { name: string; toolHash: ReturnType<typeof toolHashOf>; inputSchema: Json; argRoles: ArgRoleMap }> = {};
    for (const t of GITHUB_CONNECTOR.tools) {
      const row = (
        await db.query<{ id: string; description: string; input_schema: Json }>("SELECT id, description, input_schema FROM connector_tools WHERE connector_id = $1 AND name = $2", [conn.id, t.name])
      ).rows[0]!;
      const toolHash = toolHashOf({ description: row.description, inputSchema: row.input_schema, argRoles: t.argRoles });
      await db.query(
        `UPDATE connector_tools SET classification = $2, arg_roles = $3, scope = $4, verify = $5, tool_hash = $6,
                classified_by = 'system:seed', classified_at = $7 WHERE id = $1`,
        [row.id, t.classification, t.argRoles, t.scope, t.verify, toolHash, NOW],
      );
      tools[t.name] = { name: t.name, toolHash, inputSchema: row.input_schema, argRoles: t.argRoles };
    }
    gw.sent.length = 0;
    expect(fake.issued).toHaveLength(0);
    const task = await taskWithToken(db, ws, { status: "executing" });
    const { intentId } = await insertIntent(db, ws, {
      taskId: task.taskId,
      jobId: task.agent.jobId,
      connector: { id: conn.id, slug: GITHUB_SLUG },
      tool: tools.push_commit!,
      args: { repo: "octo/app", branch: "makase/x", message: "直す", files: [{ path: "README.md", content: "x" }] },
    });
    return { db, ws, gw, fake, intentId, credentialId: credentialId! };
  }

  it("tools/call に冪等キー（intentId）・トークン・許可（既定 false）。結果・ログにトークンは残らない", async () => {
    const { db, gw, intentId } = await setupFlow(5001);
    const r = await gw.client.executeIntent(intentId);
    expect(r).toMatchObject({ intentId, status: "executed", failReason: null });
    const calls = gw.sent.filter((s) => s.rpc === "tools/call");
    expect(calls).toHaveLength(1);
    const h = calls[0]!.headers;
    expect(h[GITHUB_HEADER.idempotencyKey]).toBe(intentId);
    expect(h[GITHUB_HEADER.token]).toBe(INSTALL_TOKEN);
    expect(h[GITHUB_HEADER.allowProtectedWrite]).toBe("false");
    const row = await intentRow(db, intentId);
    expect(JSON.stringify(row.result)).not.toContain(INSTALL_TOKEN);
    expect(gw.logs.lines.join("\n")).not.toContain(INSTALL_TOKEN);
    expect(gw.logs.lines.join("\n")).not.toContain("PRIVATE KEY");
  });

  it("Intent を作ったあとに再接続したら実行しない（credential_changed → auth_required）", async () => {
    const { db, ws, gw, intentId } = await setupFlow(5002);
    const conn = (await db.query<{ id: string }>("SELECT id FROM connectors WHERE workspace_id = $1 AND slug = 'github'", [ws.workspaceId])).rows[0]!;
    await db.transaction((tx) => insertGithubCredential(tx, ws.ctx, { connectorId: conn.id, subject: "583231", accountLogin: "octocat", installationId: 1, now: NOW }));
    const r = await gw.client.executeIntent(intentId);
    expect(r).toMatchObject({ status: "failed", failReason: "auth_required" });
    expect(gw.sent.filter((s) => s.rpc === "tools/call")).toHaveLength(0);
  });

  it("アンインストールされていたら failed(auth_required)。tools/call は送らない", async () => {
    const { gw, fake, intentId } = await setupFlow(5003);
    fake.status = 404;
    const r = await gw.client.executeIntent(intentId);
    expect(r).toMatchObject({ status: "failed", failReason: "auth_required" });
    expect(gw.sent.filter((s) => s.rpc === "tools/call")).toHaveLength(0);
  });
});
