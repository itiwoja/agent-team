import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { PlatformEnv } from "./context.ts";
import { EnvReader, MIN_SECRET_LENGTH } from "./env.ts";
import { errorHandler, notFoundHandler, type ApiErrorBody } from "./errors.ts";
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

const TOKEN = "t".repeat(MIN_SECRET_LENGTH);
const LOCAL: ServiceAuthConfig = { sharedToken: TOKEN };

const GATEWAY_URL = "http://localhost:8787";

const h = (init: Record<string, string>): Headers => new Headers(init);

describe("共有トークン＋x-ot-caller（G-11）", () => {
  const auth = createServiceAuth(LOCAL);

  it("serviceAuthHeaders は Authorization: Bearer <INTERNAL_SHARED_TOKEN> と x-ot-caller", async () => {
    expect(await auth.serviceAuthHeaders("sa-app", GATEWAY_URL)).toEqual({ authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-app" });
    expect(await auth.serviceAuthHeaders("sa-gateway", GATEWAY_URL)).toEqual({ authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-gateway" });
  });

  it("自分で作ったヘッダーは、許す呼び出し元なら通る", async () => {
    const headers = new Headers(await auth.serviceAuthHeaders("sa-gateway", GATEWAY_URL));
    expect(await auth.checkServiceCaller(headers, ["sa-gateway"])).toEqual({ ok: true, caller: "sa-gateway" });
  });

  it.each([
    ["Authorization なし", { [CALLER_HEADER]: "sa-app" }, "bad_token"],
    ["違うトークン", { authorization: "Bearer wrong-token", [CALLER_HEADER]: "sa-app" }, "bad_token"],
    ["1文字だけ違うトークン", { authorization: `Bearer ${TOKEN.slice(0, -1)}x`, [CALLER_HEADER]: "sa-app" }, "bad_token"],
    ["Bearer でない（トークンだけ）", { authorization: TOKEN, [CALLER_HEADER]: "sa-app" }, "bad_token"],
    ["呼び出し元の名前なし", { authorization: `Bearer ${TOKEN}` }, "unknown_caller"],
    ["知らない呼び出し元（sa-unknown）", { authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-unknown" }, "unknown_caller"],
  ])("%s → 拒否（%s）", async (_label, headers, reason) => {
    expect(await auth.checkServiceCaller(h(headers), ["sa-app", "sa-gateway"])).toMatchObject({ ok: false, reason });
  });

  it("知っている呼び出し元でも、許す一覧になければ caller_not_allowed（sa-app で MCP）", async () => {
    const headers = new Headers(await auth.serviceAuthHeaders("sa-app", GATEWAY_URL));
    expect(await auth.checkServiceCaller(headers, ["sa-gateway"])).toEqual({ ok: false, reason: "caller_not_allowed", caller: "sa-app" });
    expect(await auth.checkServiceCaller(headers, [])).toMatchObject({ ok: false, reason: "caller_not_allowed" });
  });

  it("共有トークンがない・短いと、受ける側は全部拒否し、呼ぶ側は例外（閉じた側に倒す）", async () => {
    for (const sharedToken of [undefined, "short"]) {
      const bad = createServiceAuth({ sharedToken });
      expect(await bad.checkServiceCaller(h({ authorization: `Bearer ${sharedToken ?? ""}`, [CALLER_HEADER]: "sa-app" }), ["sa-app"])).toEqual({
        ok: false,
        reason: "shared_token_not_configured",
      });
      await expect(bad.serviceAuthHeaders("sa-app", GATEWAY_URL)).rejects.toThrow(/INTERNAL_SHARED_TOKEN/);
    }
  });
});

describe("verifyServiceCaller（Hono のミドルウェア）", () => {
  function makeApp(auth: ServiceAuth) {
    const mem = memoryLogger({ service: "gateway" });
    const app = new Hono<PlatformEnv>();
    app.use("*", requestContext({ logger: mem.logger }));
    app.onError(errorHandler());
    app.notFound(notFoundHandler());
    app.use("/mcp/*", auth.verifyServiceCaller(["sa-gateway"]));
    app.use("/admin/v1/*", auth.verifyServiceCaller(["sa-app"]));
    app.post("/mcp/:server/:tool", (c) => c.json({ caller: c.var.serviceCaller }));
    app.post("/admin/v1/settings", (c) => c.json({ caller: c.var.serviceCaller }));
    return { app, ...mem };
  }

  async function call(app: Hono<PlatformEnv>, path: string, headers: Record<string, string>) {
    const res = await app.request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
    return { status: res.status, json: (await res.json()) as ApiErrorBody & { caller?: ServiceCaller }, requestId: res.headers.get("x-request-id") };
  }

  it("通れば c.var.serviceCaller に呼び出し元（local）", async () => {
    const auth = createServiceAuth(LOCAL);
    const { app } = makeApp(auth);
    expect((await call(app, "/mcp/example/search", await auth.serviceAuthHeaders("sa-gateway", GATEWAY_URL))).json).toEqual({ caller: "sa-gateway" });
    expect((await call(app, "/admin/v1/settings", await auth.serviceAuthHeaders("sa-app", GATEWAY_URL))).json).toEqual({ caller: "sa-app" });
  });

  it("I-20 拒否は 403 FORBIDDEN の共通の形で、理由は応答に出さずログ internal_auth.denied にだけ（トークンは出さない）", async () => {
    const auth = createServiceAuth(LOCAL);
    const { app, records, lines } = makeApp(auth);
    const r = await call(app, "/admin/v1/settings", { authorization: "Bearer secret-wrong-token-0123", [CALLER_HEADER]: "sa-app" });
    expect(r.status).toBe(403);
    expect(r.json.error).toEqual({ code: "FORBIDDEN", message: "この呼び出し元は使えません", requestId: r.requestId });
    expect(JSON.stringify(r.json)).not.toContain("bad_token");
    const denied = records.find((x) => x.event === "internal_auth.denied");
    expect(denied).toMatchObject({ severity: "WARNING", reason: "bad_token", path: "/admin/v1/settings", method: "POST", requestId: r.requestId });
    expect(lines.join("\n")).not.toContain("secret-wrong-token-0123");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("呼び出し元を取り違えると 403（local：sa-app で MCP、sa-gateway で管理 API）", async () => {
    const auth = createServiceAuth(LOCAL);
    const { app, records } = makeApp(auth);
    expect((await call(app, "/mcp/example/search", await auth.serviceAuthHeaders("sa-app", GATEWAY_URL))).status).toBe(403);
    expect((await call(app, "/admin/v1/settings", await auth.serviceAuthHeaders("sa-gateway", GATEWAY_URL))).status).toBe(403);
    expect(records.filter((x) => x.event === "internal_auth.denied").map((x) => [x.reason, x.caller])).toEqual([
      ["caller_not_allowed", "sa-app"],
      ["caller_not_allowed", "sa-gateway"],
    ]);
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
  it("INTERNAL_SHARED_TOKEN（32文字以上）が要る", () => {
    const r1 = new EnvReader({});
    expect(readServiceAuthEnv(r1)).toEqual({ sharedToken: undefined });
    expect(r1.missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    const r2 = new EnvReader({ INTERNAL_SHARED_TOKEN: "x".repeat(MIN_SECRET_LENGTH - 1) });
    readServiceAuthEnv(r2);
    expect(r2.missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    const r3 = new EnvReader({ INTERNAL_SHARED_TOKEN: TOKEN });
    expect(readServiceAuthEnv(r3)).toEqual({ sharedToken: TOKEN });
    expect(r3.missing).toEqual([]);
  });

  it("読んだ設定でそのまま createServiceAuth が組める", async () => {
    const r = new EnvReader({ INTERNAL_SHARED_TOKEN: TOKEN });
    const auth = createServiceAuth(readServiceAuthEnv(r));
    expect(await auth.checkServiceCaller(h(await auth.serviceAuthHeaders("sa-app", GATEWAY_URL)), ["sa-app"])).toEqual({ ok: true, caller: "sa-app" });
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
