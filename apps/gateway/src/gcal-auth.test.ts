// Google カレンダーのコネクタの証明（16 §3.5、ADR-040）：資格情報の読み出し・アクセストークンの更新とキャッシュ・
// 失敗の分類（auth_required）・冪等キー（intentId）・同期では Google の頭を送らないこと
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { useTestDb } from "@open-team/db/testing";
import { insertGoogleCredential, revokeCredential, upsertOAuthConnector, type ConnectorRow, type Db } from "@open-team/db";
import {
  GCAL_CONNECTOR,
  GCAL_DISPLAY_NAME,
  GCAL_HEADER,
  GCAL_SCOPES,
  GCAL_SLUG,
  GCAL_TOOL_DESCRIPTIONS,
  GCAL_TOOL_INPUT_SCHEMAS,
  type GcalToolName,
} from "@open-team/gcal-core";
import { toolHashOf, type ArgRoleMap, type Json } from "@open-team/kernel";
import { sealSecret } from "@open-team/platform";
import { ConnectorAuthRequired, ConnectorAuthUnsupported, ConnectorTokenUnavailable, GOOGLE_TOKEN_URL, defaultConnectorAuth } from "./context.ts";
import type { GcalConfig } from "./env.ts";
import { NOW, gatewayEnv, insertIntent, intentRow, rpcResponse, startGateway, taskWithToken, workspace, type FetchHook } from "./test-helpers.ts";
import type { FxWorkspace } from "@open-team/db/testing";

const T = useTestDb();

const GCAL_BASE = "http://localhost:8083";
const GCAL_URL = `${GCAL_BASE}/mcp/gcal`;
const SHARED = "gcal-shared-token-for-gateway-tests-0123456";
const TOKEN_KEY = Buffer.alloc(32, 9).toString("base64");
const REFRESH = "1//refresh-token-secret-for-gateway-tests";
const ACCESS = "ya29.access-token-secret-for-gateway-tests";
const CAL_ID = "makase-test@group.calendar.google.com";
const GCAL_CFG: GcalConfig = {
  url: GCAL_BASE,
  origin: GCAL_BASE,
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "GOCSPX-test-client-secret-0123456789",
  tokenKey: TOKEN_KEY,
  sharedToken: SHARED,
};
const OK_TOKEN = { access_token: ACCESS, expires_in: 3600, token_type: "Bearer" };

/** Google の token の宛先への応答（試験ごとに差し替える）と、受けた交換の本文 */
interface GoogleFake {
  status: number;
  body: unknown;
  /** token の交換に届いた本文（form 形式の文字列） */
  exchanges: string[];
}
const okGoogle = (): GoogleFake => ({ status: 200, body: OK_TOKEN, exchanges: [] });

function tokenResponse(f: GoogleFake): Response {
  return new Response(JSON.stringify(f.body), { status: f.status, headers: { "content-type": "application/json" } });
}

/** 直接呼ぶ試験の fetch（token の宛先だけに答える） */
function tokenFetch(f: GoogleFake): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== GOOGLE_TOKEN_URL) throw new Error(`想定外の宛先：${url}`);
    f.exchanges.push(String(init?.body));
    return tokenResponse(f);
  }) as typeof fetch;
}

/** gateway の試験の差し込み（Google の token・gcal の MCP）。bases の宛先以外は本物へ流さず null（試験では起きない） */
function gcalHook(f: GoogleFake, bases: readonly string[] = [GCAL_BASE]): FetchHook {
  return (req) => {
    if (req.url === GOOGLE_TOKEN_URL) {
      f.exchanges.push(String(req.body));
      return tokenResponse(f);
    }
    if (!bases.some((b) => req.url.startsWith(b))) return null;
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.rpc === "notifications/initialized") return new Response(null, { status: 202 });
    if (req.rpc === "initialize") {
      return rpcResponse(req, { result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "gcal-fake", version: "0.0.0" } } });
    }
    if (req.rpc === "tools/list") {
      const tools = GCAL_CONNECTOR.tools.map((t) => ({
        name: t.name,
        description: GCAL_TOOL_DESCRIPTIONS[t.name as GcalToolName],
        inputSchema: GCAL_TOOL_INPUT_SCHEMAS[t.name as GcalToolName],
      }));
      return rpcResponse(req, { result: { tools } });
    }
    if (req.rpc === "tools/call") {
      const payload = { event_id: "fake", html_link: "https://calendar.example/event", title: "勉強会", start: "", end: "" };
      return rpcResponse(req, { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
    }
    return null;
  };
}

type Mode = "ok" | "none" | "revoked" | "other_workspace";

/** Google のコネクタと資格情報（AAD は既定で <workspace_id>:<connector_id>） */
async function seedGoogle(db: Db, ws: FxWorkspace, mode: Mode): Promise<ConnectorRow> {
  return db.transaction(async (tx) => {
    const conn = await upsertOAuthConnector(tx, ws.ctx, { slug: GCAL_SLUG, displayName: GCAL_DISPLAY_NAME, url: GCAL_URL, now: NOW });
    if (mode !== "none") {
      const aadWorkspace = mode === "other_workspace" ? randomUUID() : ws.workspaceId;
      await insertGoogleCredential(tx, ws.ctx, {
        connectorId: conn.id,
        subject: "google-sub-test",
        email: "me@example.com",
        scopes: GCAL_SCOPES,
        refreshTokenEnc: sealSecret(TOKEN_KEY, REFRESH, `${aadWorkspace}:${conn.id}`),
        calendarId: CAL_ID,
        timeZone: "Asia/Tokyo",
        now: NOW,
      });
      if (mode === "revoked") await revokeCredential(tx, ws.ctx, conn.id, NOW);
    }
    return conn;
  });
}

function providerEnv() {
  return gatewayEnv(null, { allowedConnectorUrls: [GCAL_BASE], gcal: GCAL_CFG });
}

/** 書き込みの試験の準備：Google のコネクタを同期し、create_event を確定する（seedShop と同じ手順） */
async function seedWriteFlow(db: Db, ws: FxWorkspace, conn: ConnectorRow) {
  const tools: Record<string, { name: string; toolHash: ReturnType<typeof toolHashOf>; inputSchema: Json; argRoles: ArgRoleMap }> = {};
  for (const t of GCAL_CONNECTOR.tools) {
    const row = (
      await db.query<{ id: string; description: string; input_schema: Json }>(
        "SELECT id, description, input_schema FROM connector_tools WHERE connector_id = $1 AND name = $2",
        [conn.id, t.name],
      )
    ).rows[0]!;
    const toolHash = toolHashOf({ description: row.description, inputSchema: row.input_schema, argRoles: t.argRoles });
    await db.query(
      `UPDATE connector_tools SET classification = $2, arg_roles = $3, scope = $4, verify = $5, tool_hash = $6,
              classified_by = 'system:seed', classified_at = $7 WHERE id = $1`,
      [row.id, t.classification, t.argRoles, t.scope, t.verify, toolHash, NOW],
    );
    tools[t.name] = { name: t.name, toolHash, inputSchema: row.input_schema, argRoles: t.argRoles };
  }
  return tools;
}

async function setupFlow(mode: Mode) {
  const { db } = T();
  const ws = await workspace(db, "owner");
  const fake = okGoogle();
  const gw = startGateway(db, providerEnv(), { hook: gcalHook(fake) });
  const conn = await seedGoogle(db, ws, mode);
  // 同期は資格情報が要らない（tools/list に Google の頭を付けない）。資格情報の有無にかかわらず通る
  await gw.client.syncTools(conn.id);
  const tools = await seedWriteFlow(db, ws, conn);
  gw.sent.length = 0;
  fake.exchanges.length = 0;
  const task = await taskWithToken(db, ws, { status: "executing" });
  const createEvent = {
    title: "勉強会",
    start: "2026-10-12T10:00:00+09:00",
    end: "2026-10-12T11:00:00+09:00",
  };
  const { intentId } = await insertIntent(db, ws, {
    taskId: task.taskId,
    jobId: task.agent.jobId,
    connector: { id: conn.id, slug: GCAL_SLUG },
    tool: tools.create_event!,
    args: createEvent,
  });
  return { db, ws, gw, fake, conn, intentId };
}

describe("既定の証明（defaultConnectorAuth。16 §3.5）", () => {
  it("アクセストークンは1回だけ取り、キャッシュする。期限（expires_in−60秒）を過ぎたら取り直す。資格情報の値は頭の値に入るだけ", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const conn = await seedGoogle(db, ws, "ok");
    const fake = okGoogle();
    let t = NOW.getTime();
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => new Date(t) } });

    const h1 = await provider({ connector: conn, intentId: null, purpose: "call" });
    expect(h1[GCAL_HEADER.accessToken]).toBe(ACCESS);
    expect(h1[GCAL_HEADER.calendarId]).toBe(CAL_ID);
    expect(h1[GCAL_HEADER.timeZone]).toBe("Asia/Tokyo");
    expect(h1[GCAL_HEADER.idempotencyKey]).toBeUndefined();
    expect(fake.exchanges).toHaveLength(1);
    const form = new URLSearchParams(fake.exchanges[0]);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(REFRESH);
    expect(form.get("client_id")).toBe(GCAL_CFG.clientId);

    const h2 = await provider({ connector: conn, intentId: null, purpose: "call" });
    expect(h2[GCAL_HEADER.accessToken]).toBe(ACCESS);
    expect(fake.exchanges).toHaveLength(1);

    t += 3539_000;
    await provider({ connector: conn, intentId: null, purpose: "call" });
    expect(fake.exchanges).toHaveLength(1);
    t += 2_000;
    await provider({ connector: conn, intentId: null, purpose: "call" });
    expect(fake.exchanges).toHaveLength(2);
  });

  it("冪等キーは intentId（execute のときだけ）", async () => {
    const { db, ws, conn, intentId } = await setupFlow("ok");
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(okGoogle()), clock: { now: () => NOW } });
    const h = await provider({ connector: conn, intentId, purpose: "call" });
    expect(h[GCAL_HEADER.idempotencyKey]).toBe(intentId);
  });

  it("Intent の作成後に再接続した資格情報では承認済み書き込みを実行しない", async () => {
    const { db, ws, conn, intentId } = await setupFlow("ok");
    await db.transaction((tx) => insertGoogleCredential(tx, ws.ctx, {
      connectorId: conn.id, subject: "new-sub", email: "new@example.com", scopes: GCAL_SCOPES,
      refreshTokenEnc: sealSecret(TOKEN_KEY, "new-refresh-token", `${ws.workspaceId}:${conn.id}`),
      // Intent 後に再接続が直列化待ちして先に採番された場合、created_at は Intent より古くても ID で拒否する。
      calendarId: "new-calendar@group.calendar.google.com", timeZone: "Asia/Tokyo", now: new Date(NOW.getTime() - 1000),
    }));
    const fake = okGoogle();
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => NOW } });
    await expect(provider({ connector: conn, intentId, purpose: "call" })).rejects.toMatchObject({ reason: "credential_changed" });
    expect(fake.exchanges).toHaveLength(0);
  });

  it("invalid_grant（同意の取り消し）→ ConnectorAuthRequired（invalid_grant）", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const conn = await seedGoogle(db, ws, "ok");
    const fake: GoogleFake = { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." }, exchanges: [] };
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => NOW } });
    await expect(provider({ connector: conn, intentId: null, purpose: "call" })).rejects.toMatchObject({ reason: "invalid_grant" });
    await expect(provider({ connector: conn, intentId: null, purpose: "call" })).rejects.toBeInstanceOf(ConnectorAuthRequired);
  });

  for (const mode of ["none", "revoked"] as const) {
    it(`資格情報がない（${mode}）→ ConnectorAuthRequired（no_credential）。token は取りに行かない`, async () => {
      const { db } = T();
      const ws = await workspace(db, "owner");
      const conn = await seedGoogle(db, ws, mode);
      const fake = okGoogle();
      const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => NOW } });
      await expect(provider({ connector: conn, intentId: null, purpose: "call" })).rejects.toMatchObject({ reason: "no_credential" });
      expect(fake.exchanges).toHaveLength(0);
    });
  }

  it("AAD が違う（別のワークスペースの行に写した暗号文）→ 開かない（credential_unreadable）。token は取らない", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const conn = await seedGoogle(db, ws, "other_workspace");
    const fake = okGoogle();
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => NOW } });
    await expect(provider({ connector: conn, intentId: null, purpose: "call" })).rejects.toMatchObject({ reason: "credential_unreadable" });
    expect(fake.exchanges).toHaveLength(0);
  });

  it("token の交換が失敗（503）→ ConnectorTokenUnavailable。届いたのは送信前の扱い", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const conn = await seedGoogle(db, ws, "ok");
    const fake: GoogleFake = { status: 503, body: { error: "backendError" }, exchanges: [] };
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => NOW } });
    await expect(provider({ connector: conn, intentId: null, purpose: "call" })).rejects.toBeInstanceOf(ConnectorTokenUnavailable);
  });

  it("同期（list）は資格情報を開かず、呼び出しの証明だけ返す", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const conn = await seedGoogle(db, ws, "none");
    const fake = okGoogle();
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(fake), clock: { now: () => NOW } });
    const h = await provider({ connector: conn, intentId: null, purpose: "list" });
    expect(h[GCAL_HEADER.accessToken]).toBeUndefined();
    expect(h[GCAL_HEADER.calendarId]).toBeUndefined();
    expect(h.authorization).toBeDefined();
    expect(fake.exchanges).toHaveLength(0);
  });

  it("URL の origin が GCAL_URL と違う Google のコネクタは証明しない（ConnectorAuthUnsupported）", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const conn = await seedGoogle(db, ws, "ok");
    const provider = defaultConnectorAuth(providerEnv(), { db, fetch: tokenFetch(okGoogle()), clock: { now: () => NOW } });
    await expect(provider({ connector: { ...conn, url: "https://other.example/mcp/gcal" }, intentId: null, purpose: "call" })).rejects.toBeInstanceOf(
      ConnectorAuthUnsupported,
    );
  });
});

describe("gateway の流れ（gcal の MCP を差し込む）", () => {
  it("同期（tools/list）に Google の頭は付かず、token も取らない", async () => {
    const { db } = T();
    const ws = await workspace(db, "owner");
    const fake = okGoogle();
    const gw = startGateway(db, providerEnv(), { hook: gcalHook(fake) });
    const conn = await seedGoogle(db, ws, "ok");
    const r = await gw.client.syncTools(conn.id);
    expect(r.tools.map((t) => t.name).sort()).toEqual(GCAL_CONNECTOR.tools.map((t) => t.name).sort());
    const lists = gw.sent.filter((s) => s.rpc === "tools/list");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.headers[GCAL_HEADER.accessToken]).toBeUndefined();
    expect(lists[0]!.headers[GCAL_HEADER.calendarId]).toBeUndefined();
    expect(lists[0]!.headers.authorization).toBeDefined();
    expect(fake.exchanges).toHaveLength(0);
  });

  it("実行：tools/call に冪等キー（intentId）と Google の頭。結果・ログにトークンは残らない", async () => {
    const { db, gw, fake, intentId } = await setupFlow("ok");
    const r = await gw.client.executeIntent(intentId);
    expect(r).toMatchObject({ intentId, status: "executed", failReason: null });

    const calls = gw.sent.filter((s) => s.rpc === "tools/call");
    expect(calls).toHaveLength(1);
    const h = calls[0]!.headers;
    expect(h[GCAL_HEADER.idempotencyKey]).toBe(intentId);
    expect(h[GCAL_HEADER.accessToken]).toBe(ACCESS);
    expect(h[GCAL_HEADER.calendarId]).toBe(CAL_ID);
    expect(h[GCAL_HEADER.timeZone]).toBe("Asia/Tokyo");
    expect(fake.exchanges).toHaveLength(1);

    const row = await intentRow(db, intentId);
    expect(JSON.stringify(row.result)).not.toContain(ACCESS);
    expect(JSON.stringify(row.result)).not.toContain(REFRESH);
    expect(gw.logs.lines.join("\n")).not.toContain(ACCESS);
    expect(gw.logs.lines.join("\n")).not.toContain(REFRESH);
  });

  it("実行：資格情報がない → failed(auth_required)。tools/call は送らない", async () => {
    const { db, gw, intentId } = await setupFlow("none");
    const r = await gw.client.executeIntent(intentId);
    expect(r).toMatchObject({ intentId, status: "failed", failReason: "auth_required" });
    expect(gw.sent.filter((s) => s.rpc === "tools/call")).toHaveLength(0);
    expect((await intentRow(db, intentId)).fail_reason).toBe("auth_required");
  });

  it("実行：Google が refresh token を拒否（invalid_grant）→ failed(auth_required)。tools/call は送らない", async () => {
    const { gw, fake, intentId } = await setupFlow("ok");
    fake.status = 400;
    fake.body = { error: "invalid_grant" };
    const r = await gw.client.executeIntent(intentId);
    expect(r).toMatchObject({ status: "failed", failReason: "auth_required" });
    expect(gw.sent.filter((s) => s.rpc === "tools/call")).toHaveLength(0);
  });
});
