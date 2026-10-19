import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformEnv } from "./context.ts";
import { EnvReader, MIN_SECRET_LENGTH } from "./env.ts";
import { errorHandler, notFoundHandler, type ApiErrorBody } from "./errors.ts";
import { decodeJwtClaims, type IdTokenClaims, type IdTokenSignatureVerifier, type IdTokenSource } from "./id-token.ts";
import { memoryLogger, requestContext } from "./log.ts";
import {
  CALLER_HEADER,
  createServiceAuth,
  readServiceAuthEnv,
  safeEqual,
  type ServiceAuth,
  type ServiceAuthConfig,
  type ServiceCaller,
} from "./service-auth.ts";
import { manualClock } from "./time.ts";

const TOKEN = "t".repeat(MIN_SECRET_LENGTH);
const LOCAL: ServiceAuthConfig = { mode: "local", sharedToken: TOKEN };

const SIM_URL = "https://sim-world-123456.asia-northeast1.run.app";
const GATEWAY_URL = "https://gateway-123456.asia-northeast1.run.app";
const SA_APP = "sa-app@proj.iam.gserviceaccount.com";
const SA_GATEWAY = "sa-gateway@proj.iam.gserviceaccount.com";
const NOW_SEC = Date.parse("2026-10-08T00:00:00.000Z") / 1000;
const clock = manualClock(NOW_SEC * 1000);

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
function idToken(email: string, aud: string, over: Partial<IdTokenClaims> = {}): string {
  const claims = { iss: "https://accounts.google.com", aud, sub: `sub-${email}`, email, email_verified: true, iat: NOW_SEC - 10, exp: NOW_SEC + 3600, ...over };
  return `${b64({ alg: "RS256", kid: "k1" })}.${b64(claims)}.c2ln`;
}
/** 偽の検証器（署名は見ずにクレームを返す） */
const fakeVerifier: IdTokenSignatureVerifier = async (token) => {
  const c = decodeJwtClaims(token);
  if (!c) throw new Error("bad");
  return c;
};

/** sim-world の cloud の設定（MCP は sa-gateway、管理 API は sa-app） */
const SIM_CLOUD: ServiceAuthConfig = { mode: "cloud", audience: SIM_URL, callerEmails: { "sa-app": SA_APP, "sa-gateway": SA_GATEWAY } };

const h = (init: Record<string, string>): Headers => new Headers(init);

describe("local：共有トークン＋x-ot-caller（G-11。apps/sim-world の auth.ts と同じ形）", () => {
  const auth = createServiceAuth(LOCAL);

  it("serviceAuthHeaders は Authorization: Bearer <INTERNAL_SHARED_TOKEN> と x-ot-caller", async () => {
    expect(await auth.serviceAuthHeaders("sa-app", GATEWAY_URL)).toEqual({ authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-app" });
    expect(await auth.serviceAuthHeaders("sa-gateway", SIM_URL)).toEqual({ authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-gateway" });
  });

  it("自分で作ったヘッダーは、許す呼び出し元なら通る", async () => {
    const headers = new Headers(await auth.serviceAuthHeaders("sa-gateway", SIM_URL));
    expect(await auth.checkServiceCaller(headers, ["sa-gateway"])).toEqual({ ok: true, caller: "sa-gateway" });
  });

  it.each([
    ["Authorization なし", { [CALLER_HEADER]: "sa-app" }, "bad_token"],
    ["違うトークン", { authorization: "Bearer wrong-token", [CALLER_HEADER]: "sa-app" }, "bad_token"],
    ["1文字だけ違うトークン", { authorization: `Bearer ${TOKEN.slice(0, -1)}x`, [CALLER_HEADER]: "sa-app" }, "bad_token"],
    ["Bearer でない（トークンだけ）", { authorization: TOKEN, [CALLER_HEADER]: "sa-app" }, "bad_token"],
    ["呼び出し元の名前なし", { authorization: `Bearer ${TOKEN}` }, "unknown_caller"],
    ["知らない呼び出し元（sa-sim）", { authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-sim" }, "unknown_caller"],
  ])("%s → 拒否（%s）", async (_label, headers, reason) => {
    expect(await auth.checkServiceCaller(h(headers), ["sa-app", "sa-gateway"])).toMatchObject({ ok: false, reason });
  });

  it("知っている呼び出し元でも、許す一覧になければ caller_not_allowed（SO-SIM-01 の local 版：sa-app で MCP）", async () => {
    const headers = new Headers(await auth.serviceAuthHeaders("sa-app", SIM_URL));
    expect(await auth.checkServiceCaller(headers, ["sa-gateway"])).toEqual({ ok: false, reason: "caller_not_allowed", caller: "sa-app" });
    expect(await auth.checkServiceCaller(headers, [])).toMatchObject({ ok: false, reason: "caller_not_allowed" });
  });

  it("共有トークンがない・短いと、受ける側は全部拒否し、呼ぶ側は例外（閉じた側に倒す）", async () => {
    for (const sharedToken of [undefined, "short"]) {
      const bad = createServiceAuth({ mode: "local", sharedToken });
      expect(await bad.checkServiceCaller(h({ authorization: `Bearer ${sharedToken ?? ""}`, [CALLER_HEADER]: "sa-app" }), ["sa-app"])).toEqual({
        ok: false,
        reason: "shared_token_not_configured",
      });
      await expect(bad.serviceAuthHeaders("sa-app", GATEWAY_URL)).rejects.toThrow(/INTERNAL_SHARED_TOKEN/);
    }
  });
});

describe("cloud：Google の ID トークン（SO §3.9・§3.11）", () => {
  it("serviceAuthHeaders は ID トークンだけ（x-ot-caller は送らない）。aud は呼び先の URL（末尾の / を除く）", async () => {
    const getIdToken = vi.fn(async (aud: string) => `id-token-for:${aud}`);
    const auth = createServiceAuth(SIM_CLOUD, { idTokens: { getIdToken } satisfies IdTokenSource });
    expect(await auth.serviceAuthHeaders("sa-app", `${GATEWAY_URL}/`)).toEqual({ authorization: `Bearer id-token-for:${GATEWAY_URL}` });
    expect(getIdToken).toHaveBeenCalledWith(GATEWAY_URL);
  });

  it("email で呼び出し元を決める：sa-gateway は MCP、sa-app は管理 API", async () => {
    const auth = createServiceAuth(SIM_CLOUD, { verifier: fakeVerifier, clock });
    const asGateway = h({ authorization: `Bearer ${idToken(SA_GATEWAY, SIM_URL)}` });
    const asApp = h({ authorization: `Bearer ${idToken(SA_APP, SIM_URL)}` });
    expect(await auth.checkServiceCaller(asGateway, ["sa-gateway"])).toEqual({ ok: true, caller: "sa-gateway" });
    expect(await auth.checkServiceCaller(asApp, ["sa-app"])).toEqual({ ok: true, caller: "sa-app" });
    expect(await auth.checkServiceCaller(asApp, ["sa-gateway", "sa-app"])).toEqual({ ok: true, caller: "sa-app" });
  });

  it("SO-SIM-01 sa-app のトークンで MCP（sa-gateway だけ）は拒否。x-ot-caller の名前は信じない", async () => {
    const auth = createServiceAuth(SIM_CLOUD, { verifier: fakeVerifier, clock });
    const r = await auth.checkServiceCaller(h({ authorization: `Bearer ${idToken(SA_APP, SIM_URL)}`, [CALLER_HEADER]: "sa-gateway" }), ["sa-gateway"]);
    expect(r).toEqual({ ok: false, reason: "email_not_allowed", email: SA_APP });
  });

  it("SO-INT-02 aud が別のサービスのトークンは拒否。共有トークンも cloud では通らない", async () => {
    const auth = createServiceAuth(SIM_CLOUD, { verifier: fakeVerifier, clock });
    expect(await auth.checkServiceCaller(h({ authorization: `Bearer ${idToken(SA_GATEWAY, GATEWAY_URL)}` }), ["sa-gateway"])).toEqual({
      ok: false,
      reason: "aud_mismatch",
    });
    expect(await auth.checkServiceCaller(h({ authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-gateway" }), ["sa-gateway"])).toEqual({
      ok: false,
      reason: "malformed_token",
    });
  });

  it("許す呼び出し元の email が設定にない・2つの呼び出し元が同じ email → 全部拒否", async () => {
    const noGateway = createServiceAuth({ mode: "cloud", audience: SIM_URL, callerEmails: { "sa-app": SA_APP } }, { verifier: fakeVerifier, clock });
    expect(await noGateway.checkServiceCaller(h({ authorization: `Bearer ${idToken(SA_GATEWAY, SIM_URL)}` }), ["sa-gateway"])).toEqual({
      ok: false,
      reason: "caller_email_not_configured",
    });
    const same = createServiceAuth(
      { mode: "cloud", audience: SIM_URL, callerEmails: { "sa-app": SA_APP, "sa-gateway": SA_APP.toUpperCase() } },
      { verifier: fakeVerifier, clock },
    );
    expect(await same.checkServiceCaller(h({ authorization: `Bearer ${idToken(SA_APP, SIM_URL)}` }), ["sa-app"])).toEqual({
      ok: false,
      reason: "caller_email_not_configured",
    });
  });

  it("aud（自分の URL）が設定になければ全部拒否", async () => {
    const auth = createServiceAuth({ mode: "cloud", audience: undefined, callerEmails: { "sa-app": SA_APP } }, { verifier: fakeVerifier, clock });
    expect(await auth.checkServiceCaller(h({ authorization: `Bearer ${idToken(SA_APP, SIM_URL)}` }), ["sa-app"])).toEqual({ ok: false, reason: "not_configured" });
  });

  it("署名の検証は既定で行い、verifySignature: false なら検証器を呼ばない（I-27）", async () => {
    const verifier = vi.fn(fakeVerifier);
    const token = h({ authorization: `Bearer ${idToken(SA_APP, SIM_URL)}` });
    await createServiceAuth(SIM_CLOUD, { verifier, clock }).checkServiceCaller(token, ["sa-app"]);
    expect(verifier).toHaveBeenCalledTimes(1);
    const r = await createServiceAuth({ ...SIM_CLOUD, verifySignature: false }, { verifier, clock }).checkServiceCaller(token, ["sa-app"]);
    expect(r).toEqual({ ok: true, caller: "sa-app" });
    expect(verifier).toHaveBeenCalledTimes(1);
  });

  it("検証器が通さなければ invalid_token（署名の改ざん）", async () => {
    const auth = createServiceAuth(SIM_CLOUD, {
      verifier: async () => {
        throw new Error("Invalid token signature");
      },
      clock,
    });
    expect(await auth.checkServiceCaller(h({ authorization: `Bearer ${idToken(SA_APP, SIM_URL)}` }), ["sa-app"])).toEqual({ ok: false, reason: "invalid_token" });
  });
});

describe("verifyServiceCaller（Hono のミドルウェア）", () => {
  function makeApp(auth: ServiceAuth) {
    const mem = memoryLogger({ service: "sim-world" });
    const app = new Hono<PlatformEnv>();
    app.use("*", requestContext({ logger: mem.logger }));
    app.onError(errorHandler());
    app.notFound(notFoundHandler());
    app.use("/mcp/*", auth.verifyServiceCaller(["sa-gateway"]));
    app.use("/admin/v1/*", auth.verifyServiceCaller(["sa-app"]));
    app.post("/mcp/:world/:service", (c) => c.json({ caller: c.var.serviceCaller }));
    app.post("/admin/v1/demo-store", (c) => c.json({ caller: c.var.serviceCaller }));
    return { app, ...mem };
  }

  async function call(app: Hono<PlatformEnv>, path: string, headers: Record<string, string>) {
    const res = await app.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
    return { status: res.status, json: (await res.json()) as ApiErrorBody & { caller?: ServiceCaller }, requestId: res.headers.get("x-request-id") };
  }

  it("通れば c.var.serviceCaller に呼び出し元（local）", async () => {
    const auth = createServiceAuth(LOCAL);
    const { app } = makeApp(auth);
    expect((await call(app, "/mcp/shop/supplier", await auth.serviceAuthHeaders("sa-gateway", SIM_URL))).json).toEqual({ caller: "sa-gateway" });
    expect((await call(app, "/admin/v1/demo-store", await auth.serviceAuthHeaders("sa-app", SIM_URL))).json).toEqual({ caller: "sa-app" });
  });

  it("I-20 拒否は 403 FORBIDDEN の共通の形で、理由は応答に出さずログ internal_auth.denied にだけ（トークンは出さない）", async () => {
    const auth = createServiceAuth(LOCAL);
    const { app, records, lines } = makeApp(auth);
    const r = await call(app, "/admin/v1/demo-store", { authorization: "Bearer secret-wrong-token-0123", [CALLER_HEADER]: "sa-app" });
    expect(r.status).toBe(403);
    expect(r.json.error).toEqual({ code: "FORBIDDEN", message: "この呼び出し元は使えません", requestId: r.requestId });
    expect(JSON.stringify(r.json)).not.toContain("bad_token");
    const denied = records.find((x) => x.event === "internal_auth.denied");
    expect(denied).toMatchObject({ severity: "WARNING", reason: "bad_token", path: "/admin/v1/demo-store", method: "POST", mode: "local", requestId: r.requestId });
    expect(lines.join("\n")).not.toContain("secret-wrong-token-0123");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("SO-SIM-01・SO-SIM-03 呼び出し元を取り違えると 403（local：sa-app で MCP、sa-gateway で管理 API）", async () => {
    const auth = createServiceAuth(LOCAL);
    const { app, records } = makeApp(auth);
    expect((await call(app, "/mcp/shop/supplier", await auth.serviceAuthHeaders("sa-app", SIM_URL))).status).toBe(403);
    expect((await call(app, "/admin/v1/demo-store", await auth.serviceAuthHeaders("sa-gateway", SIM_URL))).status).toBe(403);
    expect(records.filter((x) => x.event === "internal_auth.denied").map((x) => [x.reason, x.caller])).toEqual([
      ["caller_not_allowed", "sa-app"],
      ["caller_not_allowed", "sa-gateway"],
    ]);
  });

  it("cloud：ID トークンの email で通し、知らない email はログに email を残して 403", async () => {
    const auth = createServiceAuth(SIM_CLOUD, { verifier: fakeVerifier, clock });
    const { app, records } = makeApp(auth);
    expect((await call(app, "/mcp/shop/supplier", { authorization: `Bearer ${idToken(SA_GATEWAY, SIM_URL)}` })).json).toEqual({ caller: "sa-gateway" });
    const stranger = "someone@proj.iam.gserviceaccount.com";
    expect((await call(app, "/admin/v1/demo-store", { authorization: `Bearer ${idToken(stranger, SIM_URL)}` })).status).toBe(403);
    expect(records.find((x) => x.event === "internal_auth.denied")).toMatchObject({ reason: "email_not_allowed", email: stranger, mode: "cloud" });
  });

  it("requestContext がなくても動く（拒否のログは deps.log へ）", async () => {
    const mem = memoryLogger({ service: "gateway" });
    const auth = createServiceAuth(LOCAL, { log: mem.logger });
    const app = new Hono();
    app.use("/gw/v1/*", auth.verifyServiceCaller(["sa-app"]));
    app.post("/gw/v1/tools/call", (c) => c.json({ ok: true }));
    const res = await app.request("/gw/v1/tools/call", { method: "POST" });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ApiErrorBody;
    expect(body.error.requestId).toMatch(/^req_/);
    expect(mem.records[0]).toMatchObject({ event: "internal_auth.denied", reason: "bad_token", service: "gateway" });
  });
});

describe("readServiceAuthEnv（足りない名前だけ。D-47）", () => {
  it("local は INTERNAL_SHARED_TOKEN（32文字以上）が要る", () => {
    const r1 = new EnvReader({});
    expect(readServiceAuthEnv(r1, "local")).toEqual({ mode: "local", sharedToken: undefined });
    expect(r1.missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    const r2 = new EnvReader({ INTERNAL_SHARED_TOKEN: "x".repeat(MIN_SECRET_LENGTH - 1) });
    readServiceAuthEnv(r2, "local");
    expect(r2.missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    const r3 = new EnvReader({ INTERNAL_SHARED_TOKEN: TOKEN, GATEWAY_URL: "not a url" });
    expect(readServiceAuthEnv(r3, "local", { audienceVar: "GATEWAY_URL", callers: ["sa-app"] })).toEqual({ mode: "local", sharedToken: TOKEN });
    // local は aud・email を見ない
    expect(r3.missing).toEqual([]);
  });

  it("SO-ENV-16 cloud は自分の URL（https）と、受け入れる呼び出し元の email が要る（共有トークンは見ない）", () => {
    const r = new EnvReader({ SIM_WORLD_URL: `${SIM_URL}/`, APP_SA_EMAIL: SA_APP, GATEWAY_SA_EMAIL: SA_GATEWAY, INTERNAL_SHARED_TOKEN: "short" });
    expect(readServiceAuthEnv(r, "cloud", { audienceVar: "SIM_WORLD_URL", callers: ["sa-gateway", "sa-app"] })).toEqual({
      mode: "cloud",
      audience: SIM_URL,
      callerEmails: { "sa-app": SA_APP, "sa-gateway": SA_GATEWAY },
    });
    expect(r.missing).toEqual([]);

    const none = new EnvReader({});
    readServiceAuthEnv(none, "cloud", { audienceVar: "SIM_WORLD_URL", callers: ["sa-gateway", "sa-app"] });
    expect(none.missing).toEqual(["SIM_WORLD_URL", "APP_SA_EMAIL", "GATEWAY_SA_EMAIL"]);

    const http = new EnvReader({ GATEWAY_URL: "http://gateway.run.app", APP_SA_EMAIL: SA_APP });
    readServiceAuthEnv(http, "cloud", { audienceVar: "GATEWAY_URL", callers: ["sa-app"] });
    expect(http.missing).toEqual(["GATEWAY_URL"]);
  });

  it("cloud で APP_SA_EMAIL と GATEWAY_SA_EMAIL が同じなら後の方を不正にする（呼び出し元を見分けられない）", () => {
    const r = new EnvReader({ SIM_WORLD_URL: SIM_URL, APP_SA_EMAIL: SA_APP, GATEWAY_SA_EMAIL: SA_APP.toUpperCase() });
    const cfg = readServiceAuthEnv(r, "cloud", { audienceVar: "SIM_WORLD_URL", callers: ["sa-app", "sa-gateway"] });
    expect(r.missing).toEqual(["GATEWAY_SA_EMAIL"]);
    expect(cfg).toMatchObject({ callerEmails: { "sa-app": SA_APP } });
  });

  it("読んだ設定でそのまま createServiceAuth が組める（gateway：sa-app だけを受ける）", async () => {
    const r = new EnvReader({ DEPLOYMENT_MODE: "cloud", GATEWAY_URL, APP_SA_EMAIL: SA_APP });
    const mode = r.deploymentMode();
    const auth = createServiceAuth(readServiceAuthEnv(r, mode, { audienceVar: "GATEWAY_URL", callers: ["sa-app"] }), { verifier: fakeVerifier, clock });
    expect(r.missing).toEqual([]);
    expect(await auth.checkServiceCaller(h({ authorization: `Bearer ${idToken(SA_APP, GATEWAY_URL)}` }), ["sa-app"])).toEqual({ ok: true, caller: "sa-app" });
  });
});

describe("ほかのパッケージの形との互換（型）", () => {
  it("gateway-client の authHeaders（(audience) => Promise<Record<string, string>>）に渡せる", async () => {
    const auth = createServiceAuth(LOCAL);
    const authHeaders: (audience: string) => Promise<Record<string, string>> = (aud) => auth.serviceAuthHeaders("sa-app", aud);
    // this を使わないので、取り出して呼んでも動く
    const { serviceAuthHeaders } = auth;
    expect(await authHeaders(GATEWAY_URL)).toEqual(await serviceAuthHeaders("sa-app", GATEWAY_URL));
  });
});

describe("safeEqual（定数時間の比較）", () => {
  it("同じなら true、1文字でも・長さが違えば false", () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true);
    expect(safeEqual(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(safeEqual(`${TOKEN.slice(1)}u`, TOKEN)).toBe(false);
    expect(safeEqual("", TOKEN)).toBe(false);
  });
});
