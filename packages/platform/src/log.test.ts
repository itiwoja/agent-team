import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformEnv, PlatformVariables } from "./context.ts";
import { errorHandler, notFoundHandler } from "./errors.ts";
import {
  REQUEST_ID_PATTERN,
  TRACE_KEY,
  createLogger,
  loggerOf,
  memoryLogger,
  newRequestId,
  requestContext,
  requestIdOf,
  requestSecretsOf,
  silentLogger,
  traceOf,
  type LogRecord,
} from "./log.ts";
import { REDACTED } from "./mask.ts";

const ULID_ID = /^req_[0-9A-HJKMNP-TV-Z]{26}$/;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("構造化ログ（SO §2.10・§3.17、NFR-032）", () => {
  it("NFR-032 必須のキー（severity・message・service・event・requestId・workspaceId・taskId）は値がなくても null で出す", () => {
    const { logger, lines, records } = memoryLogger({ service: "gateway" });
    logger.info("gateway.ready", "起動した");
    expect(lines).toHaveLength(1);
    expect(Object.keys(records[0]!).slice(0, 7)).toEqual(["severity", "message", "service", "event", "requestId", "workspaceId", "taskId"]);
    expect(records[0]).toEqual({
      severity: "INFO",
      message: "起動した",
      service: "gateway",
      event: "gateway.ready",
      requestId: null,
      workspaceId: null,
      taskId: null,
    });
  });

  it("15:459 intentId・rehearsalRunId は渡したときだけ出す（null も渡せる）。commit を付けられる", () => {
    const { logger, records } = memoryLogger({ service: "app", commit: "0123abc" });
    logger.log({ severity: "NOTICE", event: "intent.executed", message: "実行", workspaceId: "w1", taskId: "t1", intentId: "i1", rehearsalRunId: null });
    expect(records[0]).toMatchObject({ severity: "NOTICE", workspaceId: "w1", taskId: "t1", intentId: "i1", rehearsalRunId: null, commit: "0123abc" });
    logger.info("x", "y");
    expect(records[1]).not.toHaveProperty("intentId");
    expect(records[1]).not.toHaveProperty("rehearsalRunId");
  });

  it("debug・info・warn・error の重さ", () => {
    const { logger, records } = memoryLogger();
    logger.debug("a", "a");
    logger.info("b", "b");
    logger.warn("c", "c");
    logger.error("d", "d");
    expect(records.map((r) => r.severity)).toEqual(["DEBUG", "INFO", "WARNING", "ERROR"]);
  });

  it("NFR-032 出す前にマスクする：既知の値・パターン・秘密の名前のキー（message もフィールドも）", () => {
    const owner = "owner-entry-token-0123456789abcdef";
    const { logger, lines } = memoryLogger({ secrets: [owner] });
    logger.warn("entry.wrong_token", `token=${owner}`, {
      headers: { authorization: "Bearer abc.def.ghi", "x-task-token": "tt-0123456789" },
      detail: { url: "postgres://ot_app:hunter2hunter2@db/x", note: `gh ghs_${"a".repeat(36)}` },
      csrfToken: "csrf-value-0123456789",
    });
    const line = lines[0]!;
    for (const leaked of [owner, "abc.def.ghi", "tt-0123456789", "hunter2hunter2", "a".repeat(36), "csrf-value-0123456789"]) {
      expect(line).not.toContain(leaked);
    }
    const rec = JSON.parse(line) as LogRecord;
    expect(rec.message).toBe(`token=${REDACTED}`);
    expect(rec.headers).toEqual({ authorization: REDACTED, "x-task-token": REDACTED });
    expect(rec.csrfToken).toBe(REDACTED);
  });

  it("secrets を省くと環境変数の秘密（INTERNAL_SHARED_TOKEN など）を自動で隠す", () => {
    const shared = "local-shared-token-0123456789abcdef";
    vi.stubEnv("INTERNAL_SHARED_TOKEN", shared);
    const lines: string[] = [];
    const logger = createLogger({ service: "sim-world", write: (l) => lines.push(l) });
    logger.error("sim.error", `failed with ${shared}`);
    expect(lines[0]).not.toContain(shared);
    expect(JSON.parse(lines[0]!)).toMatchObject({ message: `failed with ${REDACTED}`, service: "sim-world" });
  });

  it("フィールドで service・severity などの決まったキーは上書きできない（severity は引数のもの）", () => {
    const { logger, records } = memoryLogger({ service: "app" });
    logger.info("e", "m", { service: "evil", event: "other" } as Record<string, unknown>);
    expect(records[0]).toMatchObject({ service: "app", event: "e", severity: "INFO" });
  });

  it("child は文脈（requestId など）と既知の値を足す。行の値が文脈より優先。親は変わらない", () => {
    const { logger, records } = memoryLogger();
    const reqLog = logger.child({ requestId: "req_1", workspaceId: "w1" }, ["per-request-secret-123"]);
    const taskLog = reqLog.child({ taskId: "t1" });
    taskLog.info("a", "per-request-secret-123 を使った");
    taskLog.log({ severity: "INFO", event: "b", message: "m", workspaceId: "w2" });
    logger.info("c", "per-request-secret-123");
    expect(records[0]).toMatchObject({ requestId: "req_1", workspaceId: "w1", taskId: "t1", message: `${REDACTED} を使った` });
    expect(records[1]).toMatchObject({ workspaceId: "w2", taskId: "t1" });
    // 親の Logger にはリクエストの文脈も既知の値もない
    expect(records[2]).toMatchObject({ requestId: null, workspaceId: null, message: "per-request-secret-123" });
  });

  it("ログは処理を止めない：書き先が投げても、循環した値でも例外にしない", () => {
    const broken = createLogger({ service: "app", secrets: [], write: () => {
      throw new Error("disk full");
    } });
    expect(() => broken.info("a", "b")).not.toThrow();
    const { logger, records } = memoryLogger();
    const loop: Record<string, unknown> = {};
    loop.loop = loop;
    expect(() => logger.info("a", "b", { loop, big: 1n })).not.toThrow();
    expect(records[0]).toMatchObject({ loop: { loop: "[循環]" }, big: "1" });
  });

  it("silentLogger は何も出さず、child も同じもの", () => {
    expect(() => silentLogger.error("x", "y")).not.toThrow();
    expect(silentLogger.child({ requestId: "r" })).toBe(silentLogger);
  });
});

describe("リクエスト ID（09_api/common.md:52、SO §3.3 の 2）", () => {
  it("newRequestId は req_＋ULID（26文字の Crockford base32）。時刻の順に並び、重ならない", () => {
    const a = newRequestId(Date.parse("2026-10-08T00:00:00Z"));
    const b = newRequestId(Date.parse("2026-10-08T00:00:01Z"));
    expect(a).toMatch(ULID_ID);
    expect(a.slice(0, 14) < b.slice(0, 14)).toBe(true);
    const ids = new Set(Array.from({ length: 1000 }, () => newRequestId()));
    expect(ids.size).toBe(1000);
    expect(REQUEST_ID_PATTERN.test(a)).toBe(true);
  });

  it("traceOf：X-Cloud-Trace-Context・traceparent から Cloud Logging の trace を作る。読めなければ null", () => {
    const id = "105445aa7843bc8bf206b12000100000";
    expect(traceOf(new Headers({ "x-cloud-trace-context": `${id}/1;o=1` }), "proj")).toBe(`projects/proj/traces/${id}`);
    expect(traceOf(new Headers({ "x-cloud-trace-context": id.toUpperCase() }), "proj")).toBe(`projects/proj/traces/${id}`);
    expect(traceOf(new Headers({ traceparent: `00-${id}-00f067aa0ba902b7-01` }), "proj")).toBe(`projects/proj/traces/${id}`);
    expect(traceOf(new Headers({ "x-cloud-trace-context": "nothex/1" }), "proj")).toBeNull();
    expect(traceOf(new Headers({ "x-cloud-trace-context": `${"0".repeat(32)}/1` }), "proj")).toBeNull();
    expect(traceOf(new Headers(), "proj")).toBeNull();
  });

  it("requestSecretsOf：Cookie の ot_session・X-Task-Token・X-CSRF-Token・Bearer を拾う", () => {
    const h = new Headers({
      cookie: "theme=dark; ot_session=sess-value-123; x=1",
      "x-task-token": "task-token-value",
      "x-csrf-token": "csrf-token-value",
      authorization: "Bearer id-token-value",
    });
    expect(requestSecretsOf(h).sort()).toEqual(["csrf-token-value", "id-token-value", "sess-value-123", "task-token-value"]);
    expect(requestSecretsOf(new Headers({ authorization: "Basic abc" }))).toEqual([]);
  });

  function appWith(opts: Partial<Parameters<typeof requestContext>[0]> = {}) {
    const mem = memoryLogger({ service: "app" });
    const app = new Hono<PlatformEnv>();
    app.use("*", requestContext({ logger: mem.logger, ...opts }));
    app.onError(errorHandler());
    app.notFound(notFoundHandler());
    app.get("/ok", (c) => {
      c.var.log.info("handler.called", `token ${c.req.header("x-task-token") ?? ""}`);
      return c.json({ requestId: c.var.requestId });
    });
    app.get("/boom", () => {
      throw new Error("boom");
    });
    return { app, ...mem };
  }

  it("SO-HDR-02 毎回サーバーで作って応答の X-Request-Id に付ける（来た値は既定では使わない）", async () => {
    const { app } = appWith();
    const res = await app.request("/ok", { headers: { "x-request-id": "from-client" } });
    const body = (await res.json()) as { requestId: string };
    expect(body.requestId).toMatch(ULID_ID);
    expect(res.headers.get("x-request-id")).toBe(body.requestId);
  });

  it("acceptIncoming なら形の合う来た値を使い、合わない値（空白・長すぎ）は作り直す", async () => {
    const { app } = appWith({ acceptIncoming: true });
    const given = (await app.request("/ok", { headers: { "x-request-id": "req_from-app:1.2" } })).headers.get("x-request-id");
    expect(given).toBe("req_from-app:1.2");
    for (const bad of ["has space", "x".repeat(129), "a/b"]) {
      const id = (await app.request("/ok", { headers: { "x-request-id": bad } })).headers.get("x-request-id");
      expect(id).toMatch(ULID_ID);
    }
  });

  it("404・500 の応答にも同じ X-Request-Id が付き、本文の requestId と一致する", async () => {
    const { app } = appWith();
    for (const path of ["/missing", "/boom"]) {
      const res = await app.request(path);
      const body = (await res.json()) as { error: { requestId: string } };
      expect(res.headers.get("x-request-id")).toBe(body.error.requestId);
      expect(body.error.requestId).toMatch(ULID_ID);
    }
  });

  it("リクエストの Logger は requestId を付け、そのリクエストのトークンをマスクする", async () => {
    const { app, records, lines } = appWith();
    const res = await app.request("/ok", { headers: { "x-task-token": "task-token-abcdef123" } });
    const { requestId } = (await res.json()) as { requestId: string };
    const rec = records.find((r) => r.event === "handler.called");
    expect(rec).toMatchObject({ requestId, message: `token ${REDACTED}` });
    expect(lines.join("\n")).not.toContain("task-token-abcdef123");
  });

  it("accessLog は1リクエスト1行の http.request（クエリは出さない）", async () => {
    const { app, records } = appWith({ accessLog: true });
    await app.request("/ok?token=secret-in-query");
    await app.request("/boom");
    const access = records.filter((r) => r.event === "http.request");
    expect(access).toHaveLength(2);
    expect(access[0]).toMatchObject({ severity: "INFO", method: "GET", path: "/ok", status: 200 });
    expect(access[1]).toMatchObject({ severity: "WARNING", path: "/boom", status: 500 });
    expect(typeof access[0]!.latencyMs).toBe("number");
    expect(JSON.stringify(access)).not.toContain("secret-in-query");
  });

  it("traceProjectId があれば行に logging.googleapis.com/trace を付ける", async () => {
    const { app, records } = appWith({ traceProjectId: "proj-1" });
    await app.request("/ok", { headers: { "x-cloud-trace-context": "105445aa7843bc8bf206b12000100000/1;o=1" } });
    expect(records.find((r) => r.event === "handler.called")?.[TRACE_KEY]).toBe("projects/proj-1/traces/105445aa7843bc8bf206b12000100000");
  });

  it("requestIdOf・loggerOf はミドルウェアがなくても動く（作る・fallback）", async () => {
    const app = new Hono();
    app.get("/", (c) => {
      const id = requestIdOf(c);
      return c.json({ id, again: requestIdOf(c), silent: loggerOf(c) === silentLogger });
    });
    const body = (await (await app.request("/")).json()) as { id: string; again: string; silent: boolean };
    expect(body.id).toMatch(ULID_ID);
    expect(body.again).toBe(body.id);
    expect(body.silent).toBe(true);
  });

  it("apps の Variables と交差させた Hono でも使える（型）", async () => {
    type AppVars = PlatformVariables & { session: { workspaceId: string } };
    const app = new Hono<{ Variables: AppVars }>();
    app.use("*", requestContext({ logger: silentLogger }));
    app.onError(errorHandler());
    app.notFound(notFoundHandler());
    app.get("/", (c) => c.json({ id: c.var.requestId }));
    expect((await app.request("/")).status).toBe(200);
  });
});
