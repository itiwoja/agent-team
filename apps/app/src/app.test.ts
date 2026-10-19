// 画面の API の共通の守り（DB なし）：セキュリティヘッダー・no-store・X-Request-Id・/api/health・知らないパス・
// 同一オリジンの JSON・本文の上限・準備中（D-47）・内部の呼び出し元（SO §3.3・3.8・3.9、AS §3.0、T-16・T-17、SO-HDR-01〜03・SO-INT-01〜06）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cacheControlOf, looksLikeStaticFile } from "./app.ts";
import { unavailableDb } from "./deps.ts";
import type { ApiRouteModule } from "./routes/index.ts";
import { HOST, ORIGIN, makeTestApp, send, sendInternal } from "./test-helpers.ts";

const t = makeTestApp(unavailableDb());

describe("SO-HDR-01〜03 ヘッダー", () => {
  it("CSP（default-src 'self'・script-src 'self'・img-src 'self' data:・frame-ancestors 'none'・object-src 'none'・base-uri 'none'）と Referrer-Policy", async () => {
    const res = await send(t, "GET", "/api/health");
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const d of ["default-src 'self'", "script-src 'self'", "img-src 'self' data:", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) {
      expect(csp).toContain(d);
    }
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("/api は Cache-Control: no-store と X-Request-Id（req_ ＋ ULID。サーバーで作り、来た値は使わない）", async () => {
    const res = await send(t, "GET", "/api/health", { headers: { "x-request-id": "evil-id" } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("GET /api/health は準備中でも 200 { status, commit }（Cloud Run の予約パス /healthz は使わない：SO C-26）", async () => {
    const setup = makeTestApp(unavailableDb(), { missing: ["DATABASE_URL"] });
    const res = await send(setup, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", commit: "0123abc" });
    expect((await send(setup, "GET", "/healthz")).status).toBe(404);
  });
});

describe("知らないパスは index.html ではなく JSON（SO-INT-06）", () => {
  it("GET /api/whatever はセッションがなくても 404 NOT_FOUND の共通の形", async () => {
    const res = await send(t, "GET", "/api/whatever");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("GET /api/v1/nothing も 404", async () => {
    expect((await send(t, "GET", "/api/v1/nothing")).status).toBe(404);
  });

  it("SO-INT-01・06 /internal/* に証明なし → 403 FORBIDDEN（理由は返さない）、知らないパスも 403", async () => {
    for (const path of ["/internal/cron/tick", "/internal/whatever"]) {
      const res = await sendInternal(t, "POST", path, null);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    }
    expect((await sendInternal(t, "GET", "/internal/whatever", null)).status).toBe(403);
  });

  it("SO-INT-03 sa-gateway の証明で app の /internal/* → 403", async () => {
    expect((await sendInternal(t, "POST", "/internal/cron/tick", "sa-gateway")).status).toBe(403);
  });

  it("sa-app の証明で知らない /internal/* → 404 の JSON", async () => {
    const res = await sendInternal(t, "POST", "/internal/whatever", "sa-app");
    expect(res.status).toBe(404);
  });

  it("共有トークンが違う → 403", async () => {
    const res = await t.app.request(`http://${HOST}/internal/cron/tick`, {
      method: "POST",
      headers: { host: HOST, authorization: "Bearer wrong-token-wrong-token-wrong-token-00", "x-ot-caller": "sa-app" },
    });
    expect(res.status).toBe(403);
  });
});

describe("T-17 状態を変える API の守り（SO-ENT-09）", () => {
  it("Origin が別 → 403 ORIGIN_MISMATCH（既存の BAD_ORIGIN を直した）", async () => {
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: "x" }, headers: { origin: "https://evil.test" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("ORIGIN_MISMATCH");
  });

  it("Origin がない ／ 読めない Origin → 403", async () => {
    const none = await t.app.request(`http://${HOST}/api/v1/entry`, {
      method: "POST",
      headers: { host: HOST, "content-type": "application/json" },
      body: "{}",
    });
    expect(none.status).toBe(403);
    expect((await send(t, "POST", "/api/v1/entry", { body: {}, headers: { origin: "null" } })).status).toBe(403);
  });

  it("Sec-Fetch-Site: cross-site → 403（Origin が同じでも）", async () => {
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: "x" }, headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
  });

  it("Content-Type: text/plain → 415 UNSUPPORTED_MEDIA_TYPE（既存の BAD_CONTENT_TYPE を直した）", async () => {
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: "x" }, headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("本文があるのに Content-Type がない（Content-Length で分かる）→ 415", async () => {
    const res = await t.app.request(`http://${HOST}/api/v1/entry`, {
      method: "POST",
      headers: { host: HOST, origin: ORIGIN, "content-length": "13" },
      body: '{"token":"x"}',
    });
    expect(res.status).toBe(415);
  });

  it("本文 64KB を超える → 413 PAYLOAD_TOO_LARGE（共通の形）", async () => {
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: "x".repeat(70 * 1024) }, headers: { "content-length": String(70 * 1024 + 12) } });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("GET は Origin を見ない", async () => {
    expect((await send(t, "GET", "/api/health", { headers: { origin: "https://evil.test" } })).status).toBe(200);
  });
});

describe("準備中（D-47、T-16、SO-ENV-08）", () => {
  const empty = makeTestApp(unavailableDb(), { missing: ["PHASE0_ACCESS_TOKEN", "SESSION_COOKIE_SECRET", "DATABASE_URL"] });

  it("GET /api/v1/session は足りない変数の名前だけを返す", async () => {
    const res = await send(empty, "GET", "/api/v1/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "setup_required", missing: ["PHASE0_ACCESS_TOKEN", "SESSION_COOKIE_SECRET", "DATABASE_URL"] });
  });

  it("EP-01 は 503 SETUP_REQUIRED（details.missing は名前だけ）", async () => {
    const res = await send(empty, "POST", "/api/v1/entry", { body: { token: "x" } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; details: { missing: string[] } } };
    expect(body.error.code).toBe("SETUP_REQUIRED");
    expect(body.error.details.missing).toEqual(["PHASE0_ACCESS_TOKEN", "SESSION_COOKIE_SECRET", "DATABASE_URL"]);
  });

  it("ほかの GET も 503（AS §8-32）", async () => {
    expect((await send(empty, "GET", "/api/v1/me")).status).toBe(503);
  });

  it("別のオリジンからの状態を変える要求には準備中の名前も返さない（同一オリジンの確認が先）", async () => {
    const res = await send(empty, "POST", "/api/v1/entry", { body: { token: "x" }, headers: { origin: "https://evil.test" } });
    expect(res.status).toBe(403);
  });
});

describe("画面の配信（WEB_DIST：圧縮・Cache-Control・無いファイルは 404）", () => {
  // apps/web のビルド結果に見立てた一時ディレクトリ（index.html・ハッシュ付きの JS・favicon）
  const dist = mkdtempSync(join(tmpdir(), "ot-webdist-"));
  const INDEX = "<!doctype html><html><body><div id=\"root\"></div><script src=\"/assets/app-abc.js\"></script></body></html>";
  const JS = `// 画面の束\n${"console.log('x');\n".repeat(200)}`; // 1KB を超える（compress の既定の threshold は 1024）
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "assets", "app-abc.js"), JS);
  writeFileSync(join(dist, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  // /api の応答が圧縮されないことを確かめる、1KB を超える JSON と SSE 風の流れ（セッションなしで呼べる）
  const bigRoutes: ApiRouteModule = (r) => {
    r.get("/big-json", (c) => c.json({ pad: "x".repeat(4096) }), { auth: "none" });
    r.get(
      "/big-stream",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode(`data: ${"y".repeat(4096)}\n\n`));
              ctrl.close();
            },
          }),
          { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } },
        ),
      { auth: "none" },
    );
  };
  const w = makeTestApp(unavailableDb(), { env: { webDist: dist }, app: { apiRoutes: [bigRoutes] } });
  const gz = { "accept-encoding": "gzip, deflate, br" };
  const gunzip = (res: Response) => new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();

  it("F-066 /assets/ の JS は gzip で送る（Vary: Accept-Encoding、中身は展開すると同じ）", async () => {
    const res = await send(w, "GET", "/assets/app-abc.js", { headers: gz });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toMatch(/Accept-Encoding/i);
    expect(res.headers.get("content-length")).toBeNull();
    expect(await gunzip(res)).toBe(JS);
  });

  it("Accept-Encoding がなければそのまま送る", async () => {
    const res = await send(w, "GET", "/assets/app-abc.js");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe(JS);
  });

  it("F-067 /assets/ は public, max-age=31536000, immutable。ほかの資産は no-cache", async () => {
    expect((await send(w, "GET", "/assets/app-abc.js")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const svg = await send(w, "GET", "/favicon.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers.get("cache-control")).toBe("no-cache");
    expect((await send(w, "GET", "/index.html")).headers.get("cache-control")).toBe("no-cache");
  });

  it("画面の経路は index.html（200・text/html・no-cache。gzip も効く）", async () => {
    for (const path of ["/", "/asks/01HXYZ", "/audit?seq=3", "/check"]) {
      const res = await send(w, "GET", path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/^text\/html/);
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
      expect(await res.text(), path).toBe(INDEX);
    }
    const res = await send(w, "GET", "/asks/01HXYZ", { headers: gz });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(await gunzip(res)).toBe(INDEX);
  });

  it("F-067 存在しない /assets/x.js や拡張子付きのパスは index.html でなく 404 の JSON（古い index.html の白画面を防ぐ）", async () => {
    for (const path of ["/assets/x.js", "/assets/old-hash.css", "/app.js.map", "/missing.png", "/icons/missing.svg"]) {
      const res = await send(w, "GET", path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("content-type"), path).toMatch(/^application\/json/);
      expect(((await res.json()) as { error: { code: string } }).error.code, path).toBe("NOT_FOUND");
    }
  });

  it("/api の JSON と SSE（text/event-stream）には圧縮が掛からない", async () => {
    const json = await send(w, "GET", "/api/v1/big-json", { headers: gz });
    expect(json.status).toBe(200);
    expect(json.headers.get("content-encoding")).toBeNull();
    expect(json.headers.get("vary")).toBeNull();
    expect(((await json.json()) as { pad: string }).pad.length).toBe(4096);

    const sse = await send(w, "GET", "/api/v1/big-stream", { headers: gz });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(sse.headers.get("content-encoding")).toBeNull();
    expect(sse.headers.get("vary")).toBeNull();
    expect(await sse.text()).toBe(`data: ${"y".repeat(4096)}\n\n`);
  });

  it("/api・/internal の知らないパスは WEB_DIST があっても JSON の 404／403 のまま", async () => {
    const api = await send(w, "GET", "/api/whatever", { headers: gz });
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toMatch(/^application\/json/);
    expect(api.headers.get("content-encoding")).toBeNull();
    expect((await sendInternal(w, "GET", "/internal/whatever", null)).status).toBe(403);
  });

  it("判定の関数：Cache-Control と、ファイルの要求に見えるパス", () => {
    expect(cacheControlOf("/assets/app-abc.js")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlOf("/favicon.svg")).toBe("no-cache");
    expect(cacheControlOf("/")).toBe("no-cache");
    for (const p of ["/assets/x.js", "/assets/", "/a.js", "/a/b.css", "/a.js.map", "/x.png", "/x.svg", "/favicon.ico", "/x.woff2"]) {
      expect(looksLikeStaticFile(p), p).toBe(true);
    }
    for (const p of ["/", "/asks/01HXYZ", "/audit", "/check/items", "/v1.2/thing", "/.well-known"]) {
      expect(looksLikeStaticFile(p), p).toBe(false);
    }
  });
});
