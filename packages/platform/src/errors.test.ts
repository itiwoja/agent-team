import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PlatformEnv } from "./context.ts";
import {
  API_ERROR_CODES,
  AppError,
  DEFAULT_ERROR_MESSAGES,
  ERROR_STATUS,
  errorBody,
  errorHandler,
  errorResponse,
  isApiErrorCode,
  isAppError,
  notFoundHandler,
  parseInput,
  readJsonBody,
  setupRequired,
  validationError,
  zodIssuesToDetails,
  type ApiErrorBody,
} from "./errors.ts";
import { memoryLogger, requestContext } from "./log.ts";

/** cross-check §4.4 の表（＋決めて足した INTERNAL_ERROR・ASK_ALREADY_FINISHED・CHECK_ITEM_NOT_CHECKABLE） */
const TABLE: Record<number, string[]> = {
  400: ["VALIDATION_ERROR"],
  401: ["UNAUTHORIZED"],
  403: ["CSRF_TOKEN_INVALID", "ORIGIN_MISMATCH", "FORBIDDEN"],
  404: ["NOT_FOUND"],
  409: [
    "APPROVAL_NOT_PENDING",
    "INTENT_CHANGED",
    "TASK_ALREADY_TERMINATED",
    "TASK_HALTED",
    "INTENT_NOT_UNKNOWN",
    "ASK_NOT_WAITING",
    "ASK_ALREADY_FINISHED",
    "CHECK_ITEM_NOT_CHECKABLE",
    "PROPOSAL_NOT_PENDING",
    "CHANGE_NOT_PENDING",
    "TASK_NOT_RUNNABLE",
    "TOOL_CHANGED",
    "PACK_ALREADY_INSTALLED",
    "WORKSPACE_IN_USE",
  ],
  413: ["PAYLOAD_TOO_LARGE"],
  415: ["UNSUPPORTED_MEDIA_TYPE"],
  422: ["RULE_NOT_ALLOWED", "NOT_IN_CATALOG", "PROPOSAL_NOT_NARROW", "AGENT_SCHEMA_INVALID", "AGENT_EXCEEDS_POLICY", "AGENT_LIMIT_REACHED"],
  423: ["KILL_SWITCH_ENGAGED"],
  429: ["RATE_LIMITED", "DAILY_BUDGET_EXCEEDED", "USER_CASE_DAILY_LIMIT"],
  500: ["INTERNAL_ERROR"],
  502: ["LLM_UPSTREAM_ERROR"],
  503: ["SETUP_REQUIRED"],
};

describe("エラーコード（cross-check §4.4）", () => {
  it("§4.4 の表どおりのコードと HTTP の状態（過不足なし）", () => {
    const expected = Object.entries(TABLE).flatMap(([status, codes]) => codes.map((c) => [c, Number(status)] as const));
    expect(Object.entries(ERROR_STATUS).sort()).toEqual([...expected].sort());
    expect([...API_ERROR_CODES].sort()).toEqual(expected.map(([c]) => c).sort());
  });

  it("M-55 ほか §4.4 の使わない別名は持たない", () => {
    for (const alias of [
      "WRONG_TOKEN",
      "BAD_ORIGIN",
      "BAD_CONTENT_TYPE",
      "CASE_ALREADY_REMOVED",
      "GUEST_CAPACITY",
      "GUEST_IP_LIMIT",
      "USER_CASE_LIMIT",
      "USER_BAD_DAY_LIMIT",
      "BUDGET_EXCEEDED",
      "SETUP_FAILED",
    ]) {
      expect(isApiErrorCode(alias)).toBe(false);
    }
    expect(isApiErrorCode("UNAUTHORIZED")).toBe(true);
    expect(isApiErrorCode("toString")).toBe(false);
    expect(isApiErrorCode(404)).toBe(false);
  });

  it("どのコードにも既定の文がある", () => {
    for (const code of API_ERROR_CODES) expect(DEFAULT_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
  });
});

describe("共通の形（09_api/common.md:59-68）と AppError", () => {
  it("errorBody：details は渡したときだけ（配列でもオブジェクトでも）", () => {
    expect(errorBody("NOT_FOUND", "見つかりません", "req_1")).toEqual({ error: { code: "NOT_FOUND", message: "見つかりません", requestId: "req_1" } });
    expect(errorBody("VALIDATION_ERROR", "m", "r", [{ field: "a", reason: "b" }]).error.details).toEqual([{ field: "a", reason: "b" }]);
    expect(errorBody("SETUP_REQUIRED", "m", "r", { missing: ["X"] }).error.details).toEqual({ missing: ["X"] });
  });

  it("AppError：状態はコードから、文は既定か指定、details・headers・cause を持つ", () => {
    const e = new AppError("DAILY_BUDGET_EXCEEDED", undefined, { details: { scope: "workspace" }, headers: { "retry-after": "60" }, cause: "x" });
    expect(e).toBeInstanceOf(Error);
    expect(isAppError(e)).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(e.status).toBe(429);
    expect(e.message).toBe(DEFAULT_ERROR_MESSAGES.DAILY_BUDGET_EXCEEDED);
    expect(e.details).toEqual({ scope: "workspace" });
    expect(e.headers).toEqual({ "retry-after": "60" });
    expect(e.cause).toBe("x");
    expect(new AppError("FORBIDDEN", "だめ").message).toBe("だめ");
  });

  it("D-47 setupRequired は 503 で details.missing に名前だけ", () => {
    const e = setupRequired(["PHASE0_ACCESS_TOKEN", "SESSION_COOKIE_SECRET"]);
    expect(e.status).toBe(503);
    expect(e.code).toBe("SETUP_REQUIRED");
    expect(e.details).toEqual({ missing: ["PHASE0_ACCESS_TOKEN", "SESSION_COOKIE_SECRET"] });
  });
});

describe("Zod の検証 → VALIDATION_ERROR（AS §3.0 の 10）", () => {
  const Body = z.strictObject({
    title: z.string().min(1),
    items: z.array(z.strictObject({ sku: z.string(), quantity: z.number().int().positive() })),
  });

  it("知らないキー（ownerId・role）はキーごとに1件の details", () => {
    const r = Body.safeParse({ title: "x", items: [], ownerId: "u", role: "owner" });
    expect(r.success).toBe(false);
    expect(zodIssuesToDetails(r.error!.issues)).toEqual([
      { field: "ownerId", reason: "unrecognized_key" },
      { field: "role", reason: "unrecognized_key" },
    ]);
  });

  it("入れ子・配列のパスは a.0.b の形、根は空文字", () => {
    const r = Body.safeParse({ title: "", items: [{ sku: "A", quantity: 0, extra: 1 }] });
    const fields = zodIssuesToDetails(r.error!.issues).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["title", "items.0.quantity", "items.0.extra"]));
    const root = z.object({}).safeParse("not an object");
    expect(zodIssuesToDetails(root.error!.issues)[0]?.field).toBe("");
  });

  it("details に入力の値を入れない（秘密が混ざりうる）", () => {
    const r = z.strictObject({ token: z.string().max(3) }).safeParse({ token: "secret-value-xyz" });
    expect(JSON.stringify(zodIssuesToDetails(r.error!.issues))).not.toContain("secret-value-xyz");
  });

  it("parseInput は通れば値、外れれば AppError(VALIDATION_ERROR)", () => {
    expect(parseInput(Body, { title: "t", items: [] })).toEqual({ title: "t", items: [] });
    try {
      parseInput(Body, { title: "t", items: [], ownerId: "u" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(400);
      expect((e as AppError).details).toEqual([{ field: "ownerId", reason: "unrecognized_key" }]);
    }
  });

  it("validationError は details を [{ field, reason }] にする", () => {
    expect(validationError([{ field: "count", reason: "1〜20" }]).details).toEqual([{ field: "count", reason: "1〜20" }]);
  });
});

describe("Hono の onError・notFound（errorHandler・notFoundHandler）", () => {
  function makeApp() {
    const mem = memoryLogger({ service: "app" });
    const app = new Hono<PlatformEnv>();
    app.use("*", requestContext({ logger: mem.logger }));
    app.onError(errorHandler());
    app.notFound(notFoundHandler());
    app.get("/app-error", () => {
      throw new AppError("TASK_HALTED", undefined, { details: { haltReason: "kill_switch" } });
    });
    app.get("/budget", () => {
      throw new AppError("DAILY_BUDGET_EXCEEDED", undefined, { details: { scope: "global" }, headers: { "Retry-After": "3600" } });
    });
    app.get("/upstream", () => {
      throw new AppError("LLM_UPSTREAM_ERROR");
    });
    app.get("/crash", () => {
      throw new Error("db failed postgres://ot_app:pw-0123456789@10.0.0.3/x");
    });
    app.get("/http-exception/:status", (c) => {
      throw new HTTPException(Number(c.req.param("status")) as 400);
    });
    app.post("/limited", bodyLimit({ maxSize: 10 }), (c) => c.json({ ok: true }));
    app.post("/json", async (c) => c.json({ got: await readJsonBody(c) }));
    app.get("/middleware-reject", (c) => errorResponse(c, "ORIGIN_MISMATCH"));
    return { app, ...mem };
  }

  async function body(res: Response): Promise<ApiErrorBody> {
    return (await res.json()) as ApiErrorBody;
  }

  it("AppError はコードの状態と共通の形。requestId はヘッダーと同じ", async () => {
    const { app } = makeApp();
    const res = await app.request("/app-error");
    expect(res.status).toBe(409);
    const b = await body(res);
    expect(b).toEqual({
      error: { code: "TASK_HALTED", message: DEFAULT_ERROR_MESSAGES.TASK_HALTED, details: { haltReason: "kill_switch" }, requestId: b.error.requestId },
    });
    expect(res.headers.get("x-request-id")).toBe(b.error.requestId);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("I-10 AppError のヘッダー（Retry-After）を応答に付ける", async () => {
    const { app } = makeApp();
    const res = await app.request("/budget");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");
    expect((await body(res)).error).toMatchObject({ code: "DAILY_BUDGET_EXCEEDED", details: { scope: "global" } });
  });

  it("AS §3.0 の 14 知らない例外は 500 INTERNAL_ERROR。文・スタックを出さず、ログにはマスクして残す", async () => {
    const { app, records, lines } = makeApp();
    const res = await app.request("/crash");
    expect(res.status).toBe(500);
    const text = JSON.stringify(await body(res));
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toContain("db failed");
    expect(text).not.toContain("at ");
    const logged = records.find((r) => r.event === "http.error");
    expect(logged).toMatchObject({ severity: "ERROR", code: "INTERNAL_ERROR", path: "/crash", error: { name: "Error" } });
    expect(lines.join("\n")).not.toContain("pw-0123456789");
  });

  it("5xx の AppError は WARNING でログ、4xx はログに出さない", async () => {
    const { app, records } = makeApp();
    await app.request("/upstream");
    await app.request("/app-error");
    const errs = records.filter((r) => r.event === "http.error");
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ severity: "WARNING", code: "LLM_UPSTREAM_ERROR", status: 502 });
  });

  it("bodyLimit の既定（HTTPException 413）は PAYLOAD_TOO_LARGE の共通の形", async () => {
    const { app } = makeApp();
    const res = await app.request("/limited", { method: "POST", body: "x".repeat(100), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(413);
    expect((await body(res)).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("HTTPException の状態をコードにする（知らない状態は 500）", async () => {
    const { app } = makeApp();
    const cases: Array<[number, number, string]> = [
      [400, 400, "VALIDATION_ERROR"],
      [401, 401, "UNAUTHORIZED"],
      [403, 403, "FORBIDDEN"],
      [404, 404, "NOT_FOUND"],
      [415, 415, "UNSUPPORTED_MEDIA_TYPE"],
      [429, 429, "RATE_LIMITED"],
      [418, 500, "INTERNAL_ERROR"],
      [503, 500, "INTERNAL_ERROR"],
    ];
    for (const [thrown, status, code] of cases) {
      const res = await app.request(`/http-exception/${thrown}`);
      expect(res.status).toBe(status);
      expect((await body(res)).error.code).toBe(code);
    }
  });

  it("readJsonBody：JSON として読めない本文は 400 VALIDATION_ERROR（500 にしない）", async () => {
    const { app } = makeApp();
    const bad = await app.request("/json", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect((await body(bad)).error.code).toBe("VALIDATION_ERROR");
    const ok = await app.request("/json", { method: "POST", body: '{"a":1}', headers: { "content-type": "application/json" } });
    expect(await ok.json()).toEqual({ got: { a: 1 } });
  });

  it("SO-INT-06 知らないパスは 404 NOT_FOUND の JSON（index.html ではない）", async () => {
    const { app } = makeApp();
    for (const path of ["/api/whatever", "/internal/whatever"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      const b = await body(res);
      expect(b.error.code).toBe("NOT_FOUND");
      expect(res.headers.get("x-request-id")).toBe(b.error.requestId);
    }
  });

  it("errorResponse はミドルウェアから直接返せる（ORIGIN_MISMATCH 403）", async () => {
    const { app } = makeApp();
    const res = await app.request("/middleware-reject");
    expect(res.status).toBe(403);
    expect((await body(res)).error).toMatchObject({ code: "ORIGIN_MISMATCH", message: DEFAULT_ERROR_MESSAGES.ORIGIN_MISMATCH });
  });

  it("mapError で apps の独自の例外を AppError に直せる。requestContext がなくても requestId を作る", async () => {
    class NotReady extends Error {}
    const app = new Hono();
    app.onError(errorHandler({ mapError: (e) => (e instanceof NotReady ? new AppError("SETUP_REQUIRED") : undefined) }));
    app.get("/", () => {
      throw new NotReady("x");
    });
    const res = await app.request("/");
    expect(res.status).toBe(503);
    const b = await body(res);
    expect(b.error.code).toBe("SETUP_REQUIRED");
    expect(b.error.requestId).toMatch(/^req_/);
    expect(res.headers.get("x-request-id")).toBe(b.error.requestId);
  });
});
