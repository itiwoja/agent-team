import { describe, expect, it, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createServiceAuth,
  decodeJwtClaims,
  manualClock,
  memoryLogger,
  type IdTokenClaims,
  type IdTokenSignatureVerifier,
} from "@open-team/platform";
import { createApp, type SimWorldDeps } from "./app.ts";
import { CALLER_HEADER, SIM_OPERATIONS, allowedCallersOf, authorizeSimCaller, serviceAuthConfigOf } from "./auth.ts";
import type { SimWorldEnv } from "./env.ts";
import { APP, BEANS_20, FIXED_NOW, GATEWAY, LOCAL_ENV, TOKEN, adminApi, connectMcp, createDemoStore, getExecution, newId, setup, simHeaders, type AppLike } from "./test-helpers.ts";

const SIM_URL = "https://sim-world-123.asia-northeast1.run.app";
const SA_GATEWAY = "sa-gateway@proj.iam.gserviceaccount.com";
const SA_APP = "sa-app@proj.iam.gserviceaccount.com";

const CLOUD_ENV: SimWorldEnv = {
  deploymentMode: "cloud",
  port: 0,
  sharedToken: undefined,
  selfUrl: SIM_URL,
  gatewaySaEmail: SA_GATEWAY,
  appSaEmail: SA_APP,
  databaseUrl: "postgres://ot_sim@/db",
  commitSha: undefined,
};

const NOW_SEC = FIXED_NOW.getTime() / 1000;
const clock = manualClock(FIXED_NOW.getTime());
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
/** Google の ID トークンの形（署名は "sig" の base64url） */
function idToken(email: string, aud = SIM_URL, over: Partial<IdTokenClaims> = {}): string {
  const claims = { iss: "https://accounts.google.com", aud, sub: `sub-${email}`, email, email_verified: true, iat: NOW_SEC - 10, exp: NOW_SEC + 3600, ...over };
  return `${b64({ alg: "RS256", kid: "k1" })}.${b64(claims)}.c2ln`;
}
/** 偽の署名の検証器（試験用）：署名が "sig" のトークンだけ通してクレームを返す。本物は google-auth-library が公開鍵で確かめる */
const fakeVerifier: IdTokenSignatureVerifier = async (token) => {
  if (!token.endsWith(".c2ln")) throw new Error("署名が違う");
  const claims = decodeJwtClaims(token);
  if (!claims) throw new Error("形が違う");
  return claims;
};

function cloudApp(deps: SimWorldDeps = {}, env: SimWorldEnv = CLOUD_ENV) {
  return createApp(env, { now: () => FIXED_NOW, serviceAuthDeps: { verifier: fakeVerifier, clock }, ...deps });
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** MCP の初期化が通るか（通れば 200、HTTP のエラーならその状態） */
async function mcpStatus(app: AppLike, headers: Record<string, string>): Promise<number> {
  try {
    const c = await connectMcp(app, "/mcp/shop/supplier", headers);
    await c.close();
    return 200;
  } catch (e) {
    if (e instanceof StreamableHTTPError) return e.code ?? -1;
    throw e;
  }
}

describe("authorizeSimCaller・allowedCallersOf（SO §3.11 の表、M-44）", () => {
  it("mcp は sa-gateway だけ、管理の操作は sa-app だけ", () => {
    for (const op of SIM_OPERATIONS) {
      expect(authorizeSimCaller(op, "sa-gateway")).toBe(op === "mcp");
      expect(authorizeSimCaller(op, "sa-app")).toBe(op !== "mcp");
      expect(allowedCallersOf(op)).toEqual(op === "mcp" ? ["sa-gateway"] : ["sa-app"]);
    }
  });

  it("serviceAuthConfigOf：local は共有トークン、cloud は aud（SIM_WORLD_URL）と2つのサービスアカウント", () => {
    expect(serviceAuthConfigOf(LOCAL_ENV)).toEqual({ mode: "local", sharedToken: TOKEN });
    expect(serviceAuthConfigOf(CLOUD_ENV)).toEqual({ mode: "cloud", audience: SIM_URL, callerEmails: { "sa-app": SA_APP, "sa-gateway": SA_GATEWAY } });
  });
});

describe("呼び出し元の確認（local：platform の共有トークン＋x-ot-caller）", () => {
  it("SW-04・BD-11・SO-SIM-01・T-160 sa-app で MCP（place_order）を呼ぶと 403。デモ店舗は変わらない", async () => {
    const { app } = setup();
    const ws = newId();
    const demo = await createDemoStore(app, ws);
    expect(await mcpStatus(app, { ...APP, ...simHeaders({ workspaceId: ws }) })).toBe(403);
    // 生の tools/call でも同じ（初期化を飛ばしても入口で止まる）
    const res = await app.request("http://sim.test/mcp/shop/supplier", {
      method: "POST",
      headers: { ...APP, ...simHeaders({ workspaceId: ws }), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "place_order", arguments: BEANS_20 } }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN", requestId: expect.any(String) } });
    expect((await getExecution(app, ws, demo.id)).state.orders).toEqual([]);
  });

  it("SO-SIM-02 sa-gateway（X-OT-* あり）なら通る", async () => {
    const { app } = setup();
    const ws = newId();
    await createDemoStore(app, ws);
    expect(await mcpStatus(app, { ...GATEWAY, ...simHeaders({ workspaceId: ws }) })).toBe(200);
  });

  it("SO-SIM-03 sa-gateway で管理 API（作成・取得・削除）は 403", async () => {
    const { app } = setup();
    const ws = newId();
    const api = adminApi(app, GATEWAY);
    expect((await api.post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(403);
    expect((await api.get(`/executions/${newId()}?workspaceId=${ws}`)).status).toBe(403);
    expect((await api.del(`/workspaces/${ws}`)).status).toBe(403);
  });

  it.each([
    ["Authorization なし", { [CALLER_HEADER]: "sa-gateway" }],
    ["違うトークン", { authorization: "Bearer wrong-token", [CALLER_HEADER]: "sa-gateway" }],
    ["1文字だけ違うトークン", { authorization: `Bearer ${TOKEN.slice(0, -1)}x`, [CALLER_HEADER]: "sa-gateway" }],
    ["Bearer でない", { authorization: TOKEN, [CALLER_HEADER]: "sa-gateway" }],
    ["呼び出し元の名前なし", { authorization: `Bearer ${TOKEN}` }],
    ["知らない呼び出し元（sa-sim）", { authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-sim" }],
  ])("%s → MCP も管理 API も 403", async (_label, auth) => {
    const { app } = setup();
    expect(await mcpStatus(app, { ...auth, ...simHeaders({ workspaceId: newId() }) })).toBe(403);
    expect((await adminApi(app, auth).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(403);
  });

  it("呼ぶ側（gateway・app）が platform の serviceAuthHeaders で作ったヘッダーがそのまま通る（gateway は MCP、app は管理 API）", async () => {
    const { app } = setup();
    const callers = createServiceAuth({ mode: "local", sharedToken: TOKEN });
    const ws = newId();
    const asApp = await callers.serviceAuthHeaders("sa-app", "http://sim.test");
    expect((await adminApi(app, asApp).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(201);
    const asGateway = await callers.serviceAuthHeaders("sa-gateway", "http://sim.test");
    expect(await mcpStatus(app, { ...asGateway, ...simHeaders({ workspaceId: ws }) })).toBe(200);
    expect(await mcpStatus(app, { ...asApp, ...simHeaders({ workspaceId: ws }) })).toBe(403);
    expect((await adminApi(app, asGateway).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(403);
    // 別の共有トークンの呼び出し元は通らない
    const stranger = await createServiceAuth({ mode: "local", sharedToken: "z".repeat(40) }).serviceAuthHeaders("sa-app", "http://sim.test");
    expect((await adminApi(app, stranger).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(403);
  });

  it("拒否の理由はログ internal_auth.denied にだけ出し（トークンはマスク）、応答には出さない", async () => {
    const { logger, records, lines } = memoryLogger({ service: "sim-world" });
    const { app } = setup({ log: logger });
    const r = await adminApi(app, { authorization: "Bearer secret-wrong-token-0123456789", [CALLER_HEADER]: "sa-app" }).post("/demo-store", {
      workspaceId: newId(),
      world: "shop",
    });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).not.toContain("bad_token");
    const denied = records.find((e) => e.event === "internal_auth.denied");
    expect(denied).toMatchObject({ severity: "WARNING", service: "sim-world", reason: "bad_token", path: "/admin/v1/demo-store", mode: "local" });
    expect(denied?.requestId).toBe(r.json!.error.requestId);
    expect(lines.join("\n")).not.toContain("secret-wrong-token-0123456789");
    // 呼び出しの拒否（名前は正しいが許されない）は caller も残す
    await mcpStatus(app, { ...APP, ...simHeaders({ workspaceId: newId() }) });
    expect(records.filter((e) => e.event === "internal_auth.denied").at(-1)).toMatchObject({ reason: "caller_not_allowed", caller: "sa-app", path: "/mcp/shop/supplier" });
  });

  it("共有トークンが設定されていない・短いと全部 403（閉じる）", async () => {
    for (const sharedToken of [undefined, "short"]) {
      const app = createApp({ ...LOCAL_ENV, sharedToken });
      expect((await adminApi(app, { authorization: `Bearer ${sharedToken ?? ""}`, [CALLER_HEADER]: "sa-app" }).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(403);
    }
  });

  it("/healthz・/api/health は呼び出し元を見ない（commit を返す）", async () => {
    const { app } = setup();
    for (const path of ["/healthz", "/api/health"]) {
      const res = await app.request(`http://sim.test${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok", service: "sim-world", commit: "0123abc" });
    }
  });
});

describe("呼び出し元の確認（cloud：platform の ID トークンの検証。偽の署名の検証器を差し込む）", () => {
  it("SO-SIM-01〜03 email で呼び出し元を決める：sa-gateway は MCP だけ、sa-app は管理 API だけ。x-ot-caller の名前は信じない", async () => {
    const app = cloudApp();
    const asGateway = bearer(idToken(SA_GATEWAY));
    const asApp = bearer(idToken(SA_APP));
    const ws = newId();
    expect((await adminApi(app, asApp).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(201);
    expect(await mcpStatus(app, { ...asGateway, ...simHeaders({ workspaceId: ws }) })).toBe(200);
    expect(await mcpStatus(app, { ...asApp, [CALLER_HEADER]: "sa-gateway", ...simHeaders({ workspaceId: ws }) })).toBe(403);
    expect((await adminApi(app, { ...asGateway, [CALLER_HEADER]: "sa-app" }).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(403);
    // 書き込みも sa-gateway の ID トークンで通り、そのワークスペースのデモ店舗にだけ入る
    const c = await connectMcp(app, "/mcp/shop/supplier", { ...asGateway, ...simHeaders({ workspaceId: ws, taskId: newId() }) });
    try {
      expect((await c.callTool({ name: "place_order", arguments: BEANS_20 })).structuredContent).toMatchObject({ order_id: "order-0001" });
    } finally {
      await c.close();
    }
    const demo = await adminApi(app, asApp).post("/demo-store", { workspaceId: ws, world: "shop" });
    expect(demo.status).toBe(200);
    expect((await getExecution(app, ws, demo.json!.execution.id as string, asApp)).state.orders).toHaveLength(1);
  });

  it("検証器には ID トークンと aud（SIM_WORLD_URL と末尾の / つき）を渡す", async () => {
    const verifier = vi.fn(fakeVerifier);
    const app = cloudApp({ serviceAuthDeps: { verifier, clock } });
    const token = idToken(SA_APP);
    expect((await adminApi(app, bearer(token)).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(201);
    expect(verifier).toHaveBeenCalledWith(token, [SIM_URL, `${SIM_URL}/`]);
  });

  it.each([
    ["SO-INT-02 aud が別のサービス（gateway の URL）", () => bearer(idToken(SA_APP, "https://gateway-123.asia-northeast1.run.app")), "aud_mismatch"],
    ["SO-INT-05 期限切れ", () => bearer(idToken(SA_APP, SIM_URL, { exp: NOW_SEC - 1 })), "expired"],
    ["SO-INT-05 email_verified が false", () => bearer(idToken(SA_APP, SIM_URL, { email_verified: false })), "email_not_verified"],
    ["SO-INT-05 署名の改ざん", () => bearer(`${idToken(SA_APP).slice(0, -4)}AAAA`), "invalid_token"],
    ["Google でない発行者", () => bearer(idToken(SA_APP, SIM_URL, { iss: "https://evil.example" })), "issuer_mismatch"],
    ["知らないサービスアカウント", () => bearer(idToken("someone@proj.iam.gserviceaccount.com")), "email_not_allowed"],
    ["cloud で共有トークン（JWT の形でない）", () => ({ authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-app" }), "malformed_token"],
    ["Authorization なし", () => ({}), "no_bearer"],
  ])("%s → 403（理由はログにだけ）", async (_label, headersOf, reason) => {
    const { logger, records } = memoryLogger({ service: "sim-world" });
    const app = cloudApp({ log: logger });
    const r = await adminApi(app, headersOf()).post("/demo-store", { workspaceId: newId(), world: "shop" });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(JSON.stringify(r.json)).not.toContain(reason);
    expect(records.find((e) => e.event === "internal_auth.denied")).toMatchObject({ reason, mode: "cloud" });
  });

  it("知らない email はログに email を残し、ID トークンそのものはログに出さない（マスク）", async () => {
    const { logger, records, lines } = memoryLogger({ service: "sim-world" });
    const app = cloudApp({ log: logger });
    const token = idToken("someone@proj.iam.gserviceaccount.com");
    expect(await mcpStatus(app, { ...bearer(token), ...simHeaders({ workspaceId: newId() }) })).toBe(403);
    expect(records.find((e) => e.event === "internal_auth.denied")).toMatchObject({ reason: "email_not_allowed", email: "someone@proj.iam.gserviceaccount.com" });
    expect(lines.join("\n")).not.toContain(token);
  });

  it("呼ぶ側（gateway・app）が platform の serviceAuthHeaders（cloud）で取った ID トークンがそのまま通る（aud の末尾の / を除いて取る）", async () => {
    const app = cloudApp();
    const getIdToken = vi.fn(async (aud: string) => idToken(SA_GATEWAY, aud));
    const gateway = createServiceAuth({ mode: "cloud", audience: undefined, callerEmails: {} }, { idTokens: { getIdToken } });
    const headers = await gateway.serviceAuthHeaders("sa-gateway", `${SIM_URL}/`);
    expect(getIdToken).toHaveBeenCalledWith(SIM_URL);
    expect(headers).not.toHaveProperty(CALLER_HEADER);
    const ws = newId();
    expect((await adminApi(app, bearer(idToken(SA_APP))).post("/demo-store", { workspaceId: ws, world: "shop" })).status).toBe(201);
    expect(await mcpStatus(app, { ...headers, ...simHeaders({ workspaceId: ws }) })).toBe(200);
  });

  it("aud（SIM_WORLD_URL）がない・2つのサービスアカウントが同じ email の設定は、全部 403（閉じる）", async () => {
    const noAud = cloudApp({}, { ...CLOUD_ENV, selfUrl: undefined });
    expect((await adminApi(noAud, bearer(idToken(SA_APP))).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(403);
    const same = cloudApp({}, { ...CLOUD_ENV, gatewaySaEmail: SA_APP });
    expect((await adminApi(same, bearer(idToken(SA_APP))).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(403);
    expect(await mcpStatus(same, { ...bearer(idToken(SA_APP)), ...simHeaders({ workspaceId: newId() }) })).toBe(403);
  });

  it("差し込んだ ServiceAuth を env の設定より先に使う（cloud の env でも、差し込んだ local の確かめ方で通る）", async () => {
    const app = createApp(CLOUD_ENV, { serviceAuth: createServiceAuth({ mode: "local", sharedToken: TOKEN }) });
    expect((await adminApi(app, APP).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(201);
    expect((await adminApi(app, bearer(idToken(SA_APP))).post("/demo-store", { workspaceId: newId(), world: "shop" })).status).toBe(403);
  });
});
