import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentServer } from "./server.ts";
import type { ActionOutput, BrowserAction, BrowserBackend } from "./protocol.ts";

// 資格は試験の実行時だけ生成し、ファイルやログへ保存しない。
const png = Buffer.from("89504e470d0a1a0a", "hex");
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options: { maxActions?: number; maxResultBytes?: number; ready?: boolean } = {}) {
  const token = randomBytes(32).toString("hex");
  const execute = vi.fn(async (_action: BrowserAction): Promise<ActionOutput> => ({ executed: true }));
  const screenshot = vi.fn(async () => png);
  const backend: BrowserBackend = { ready: () => options.ready ?? true, sandboxEnabled: true, execute, screenshot };
  const server = createAgentServer({ token, controlEpoch: 3, backend, maxActions: options.maxActions, maxResultBytes: options.maxResultBytes });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const base = `http://127.0.0.1:${address.port}`;
  const authorization = `Bearer ${token}`;
  function get(path: string, headers: Record<string, string> = {}) {
    return fetch(`${base}${path}`, { headers: { authorization, ...headers }, signal: AbortSignal.timeout(5000) });
  }
  function post(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${base}/actions`, {
      method: "POST", headers: { authorization, "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
  }
  function action(action: BrowserAction = { kind: "screenshot" }, actionId = randomUUID(), controlEpoch = 3) {
    return post({ actionId, controlEpoch, action });
  }
  return { server, token, base, authorization, backend, execute, screenshot, get, post, action };
}

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: { code } });
}

describe("HTTPの認証と入力境界", () => {
  it("全経路で無資格・別資格・古い資格を拒否する", async () => {
    const f = await fixture();
    const other = randomBytes(32).toString("hex");
    for (const [path, method] of [["/healthz", "GET"], ["/screenshot", "GET"], ["/actions", "POST"], ["/vnc", "GET"], ["/unknown", "OPTIONS"]]) {
      for (const credential of [undefined, `Bearer ${other}`, `Bearer ${randomUUID()}`, "Basic"] ) {
        const response = await fetch(`${f.base}${path}`, {
          method, headers: credential === undefined ? {} : { authorization: credential }, signal: AbortSignal.timeout(5000),
        });
        await expectCode(response, 401, "UNAUTHORIZED");
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
      }
    }
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.screenshot).not.toHaveBeenCalled();
  });

  it("Origin付き・クエリ資格を拒否し、CORSを返さない", async () => {
    const f = await fixture();
    for (const path of ["/healthz", "/screenshot", "/actions", "/vnc"]) {
      const response = await f.get(path, { origin: "https://example.test" });
      await expectCode(response, 403, "ORIGIN_FORBIDDEN");
      expect(response.headers.has("access-control-allow-origin")).toBe(false);
    }
    await expectCode(await f.get(`/healthz?token=${f.token}`), 400, "VALIDATION_ERROR");
    await expectCode(await f.get("/healthz", { origin: "" }), 403, "ORIGIN_FORBIDDEN");
  });

  it("重複Authorizationヘッダーを拒否する", async () => {
    const f = await fixture();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${f.base}/healthz`, { headers: ["Host", new URL(f.base).host, "Authorization", f.authorization, "Authorization", f.authorization] }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(401);
  });

  it("不正JSON・unknown・未対応欄・zoomを実行しない", async () => {
    const f = await fixture();
    const base = { actionId: randomUUID(), controlEpoch: 3, action: { kind: "screenshot" } };
    for (const body of [null, [], { ...base, other: true }, { ...base, dryRun: false }, { ...base, expect: null }, { ...base, action: { kind: "zoom" } }, { ...base, action: { kind: "left_click", x: 1280, y: 0 } }]) {
      await expectCode(await f.post(body), 400, "VALIDATION_ERROR");
    }
    const response = await fetch(`${f.base}/actions`, { method: "POST", headers: { authorization: f.authorization, "content-type": "application/json" }, body: "{" });
    await expectCode(response, 400, "VALIDATION_ERROR");
    await expectCode(await f.post(base, { "content-type": "text/plain" }), 400, "VALIDATION_ERROR");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("Content-Length付きもchunkedも32KiBを越す本文を拒否する", async () => {
    const f = await fixture();
    await expectCode(await f.post({ text: "a".repeat(32 * 1024) }), 413, "BODY_TOO_LARGE");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${f.base}/actions`, { method: "POST", headers: { authorization: f.authorization, "content-type": "application/json" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on("error", reject);
      request.write("a".repeat(16 * 1024));
      request.write("a".repeat(16 * 1024));
      request.end("a");
    });
    expect(status).toBe(413);
    expect(f.execute).not.toHaveBeenCalled();
  });
});

describe("準備状態・応答", () => {
  it("準備前はhealthz/操作/スクショが503、sandbox状態も返す", async () => {
    const f = await fixture({ ready: false });
    f.backend.sandboxEnabled = false;
    const health = await f.get("/healthz");
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ready: false, sandboxEnabled: false });
    await expectCode(await f.action(), 503, "NOT_READY");
    await expectCode(await f.get("/screenshot"), 503, "NOT_READY");
    expect(f.execute).not.toHaveBeenCalled();
    f.backend.ready = () => true;
    expect((await f.get("/healthz")).status).toBe(200);
  });

  it("PNGと操作結果を返し、cacheを許さない", async () => {
    const f = await fixture();
    const response = await f.get("/screenshot");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    const output: ActionOutput = { executed: true, screenshot: { mimeType: "image/png", data: png.toString("base64") } };
    f.execute.mockResolvedValueOnce(output);
    expect(await (await f.action()).json()).toEqual(output);
  });

  it("予期しない例外の本文・資格・入力は応答へ出さない", async () => {
    const f = await fixture();
    f.screenshot.mockRejectedValueOnce(new Error(f.token));
    const response = await f.get("/screenshot");
    await expectCode(response, 500, "INTERNAL_ERROR");
    expect((await f.get("/healthz")).status).toBe(200);
  });
});

describe("冪等性と操作直列化", () => {
  it("同ID同内容の同時要求は一度だけ実行し、順序の違うJSONも再実行しない", async () => {
    const f = await fixture();
    const started = deferred();
    const finish = deferred();
    f.execute.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return { executed: true, text: "result" };
    });
    const id = randomUUID();
    const first = f.action({ kind: "left_click", x: 1, y: 2 }, id);
    await started.promise;
    const second = f.post({ controlEpoch: 3, action: { y: 2, x: 1, kind: "left_click" }, actionId: id });
    // 先行要求の実行中に別内容を送り、競合をその場で確認する。
    await expectCode(await f.action({ kind: "left_click", x: 2, y: 2 }, id), 409, "ACTION_CONFLICT");
    await expectCode(await f.action({ kind: "left_click", x: 1, y: 2 }, id, 2), 409, "STALE_CONTROL");
    expect(f.execute).toHaveBeenCalledTimes(1);
    finish.resolve();
    const responses = await Promise.all([first, second]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies).toEqual([{ executed: true, text: "result" }, { executed: true, text: "result" }]);
    expect(await (await f.action({ kind: "left_click", x: 1, y: 2 }, id)).json()).toEqual(bodies[0]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("epochをキャッシュ・ready・容量より先に検証する", async () => {
    const f = await fixture({ maxActions: 1 });
    const id = randomUUID();
    expect((await f.action({ kind: "screenshot" }, id)).status).toBe(200);
    f.backend.ready = () => false;
    await expectCode(await f.action({ kind: "screenshot" }, id, 2), 409, "STALE_CONTROL");
    await expectCode(await f.action({ kind: "wait", duration: 0 }, randomUUID(), 4), 409, "STALE_CONTROL");
    expect((await f.action({ kind: "screenshot" }, id)).status).toBe(200);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("失敗した操作も記録し、再送で実行せず、後続操作は動かせる", async () => {
    const f = await fixture();
    f.execute.mockRejectedValueOnce(new Error(f.token));
    const id = randomUUID();
    await expectCode(await f.action({ kind: "type", text: "input" }, id), 500, "ACTION_FAILED");
    await expectCode(await f.action({ kind: "type", text: "input" }, id), 500, "ACTION_FAILED");
    await expectCode(await f.action({ kind: "type", text: "different" }, id), 409, "ACTION_CONFLICT");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect((await f.action()).status).toBe(200);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("容量に進行中/失敗を含め、満杯でも既存IDは保持する", async () => {
    const f = await fixture({ maxActions: 1 });
    const started = deferred();
    const finish = deferred();
    f.execute.mockImplementation(async () => { started.resolve(); await finish.promise; throw new Error("failed"); });
    const id = randomUUID();
    const first = f.action({ kind: "screenshot" }, id);
    await started.promise;
    await expectCode(await f.action(), 503, "ACTION_CAPACITY");
    finish.resolve();
    await expectCode(await first, 500, "ACTION_FAILED");
    await expectCode(await f.action(), 503, "ACTION_CAPACITY");
    await expectCode(await f.action({ kind: "screenshot" }, id), 500, "ACTION_FAILED");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("1画像でbyte上限に達したら新規だけを拒否し、再送とGETスクショは許可する", async () => {
    const f = await fixture({ maxResultBytes: png.length });
    const output: ActionOutput = { executed: true, screenshot: { mimeType: "image/png", data: png.toString("base64") } };
    f.execute.mockResolvedValue(output);
    // GETの画像は保持しない。これだけで上限に達した扱いにはしない。
    expect(Buffer.from(await (await f.get("/screenshot")).arrayBuffer())).toEqual(png);
    const id = randomUUID();
    const first = await f.action({ kind: "screenshot" }, id);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(output);
    await expectCode(await f.action(), 503, "ACTION_CAPACITY");
    const replay = await f.action({ kind: "screenshot" }, id);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(output);
    await expectCode(await f.action({ kind: "wait", duration: 0 }, id), 409, "ACTION_CONFLICT");
    expect((await f.get("/screenshot")).status).toBe(200);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.screenshot).toHaveBeenCalledTimes(2);
  });

  it("受付済みの複数操作も先行画像の保存後にbyte上限を再確認する", async () => {
    const f = await fixture({ maxResultBytes: 1 });
    const started = deferred();
    const finish = deferred();
    const accepted = deferred();
    const output: ActionOutput = { executed: true, screenshot: { mimeType: "image/png", data: png.toString("base64") } };
    f.execute.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return output;
    });
    const firstId = randomUUID();
    const first = f.action({ kind: "screenshot" }, firstId);
    await started.promise;
    let readyChecks = 0;
    f.backend.ready = () => {
      // 先行操作が停止中なので、この2回は後続2件の受付時の確認。
      // HTTP受信だけでなく、両方が容量確認を通って予約されたことを待つ。
      if (++readyChecks === 2) accepted.resolve();
      return true;
    };
    const secondId = randomUUID();
    const second = f.action({ kind: "type", text: "queued" }, secondId);
    const third = f.action({ kind: "wait", duration: 0 });
    await accepted.promise;
    expect(f.execute).toHaveBeenCalledTimes(1);
    finish.resolve();
    expect(await (await first).json()).toEqual(output);
    await expectCode(await second, 503, "ACTION_CAPACITY");
    await expectCode(await third, 503, "ACTION_CAPACITY");
    await expectCode(await f.action({ kind: "type", text: "queued" }, secondId), 503, "ACTION_CAPACITY");
    // 拒否した予約IDも保持し、内容違いは新規受付でなく競合として扱う。
    await expectCode(await f.action({ kind: "type", text: "different" }, secondId), 409, "ACTION_CONFLICT");
    expect(await (await f.action({ kind: "screenshot" }, firstId)).json()).toEqual(output);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("保存した本文はUTF-8のバイト数で累計し、再送では重複計上しない", async () => {
    const output: ActionOutput = { executed: true, text: "日本語".repeat(10) };
    const bytes = Buffer.byteLength(JSON.stringify(output), "utf8");
    const f = await fixture({ maxResultBytes: bytes * 2 });
    f.execute.mockResolvedValue(output);
    const id = randomUUID();
    expect((await f.action({ kind: "read_page" }, id)).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await f.action({ kind: "read_page" }, id)).status).toBe(200);
    }
    expect((await f.action({ kind: "read_page" })).status).toBe(200);
    await expectCode(await f.action(), 503, "ACTION_CAPACITY");
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("失敗結果の本文もbyte上限に計上し、満杯後の再送は同じ失敗を返す", async () => {
    const failure = { error: { code: "ACTION_FAILED" } };
    const f = await fixture({ maxResultBytes: Buffer.byteLength(JSON.stringify(failure), "utf8") });
    f.execute.mockRejectedValue(new Error("failed"));
    const id = randomUUID();
    await expectCode(await f.action({ kind: "screenshot" }, id), 500, "ACTION_FAILED");
    await expectCode(await f.action(), 503, "ACTION_CAPACITY");
    await expectCode(await f.action({ kind: "screenshot" }, id), 500, "ACTION_FAILED");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("異なる操作とGETスクショも同じキューで重ならない", async () => {
    const f = await fixture();
    const started = deferred();
    const finish = deferred();
    const events: string[] = [];
    f.execute.mockImplementation(async (action) => {
      events.push(`start:${action.kind}`);
      if (action.kind === "wait") { started.resolve(); await finish.promise; }
      events.push(`end:${action.kind}`);
      return { executed: true };
    });
    f.screenshot.mockImplementation(async () => { events.push("screenshot"); return png; });
    const first = f.action({ kind: "wait", duration: 1 });
    await started.promise;
    const second = f.action({ kind: "type", text: "later" });
    const shot = f.get("/screenshot");
    // healthzはキューを待たず応答し、操作だけが待機する。
    expect((await f.get("/healthz")).status).toBe(200);
    expect(events).toEqual(["start:wait"]);
    finish.resolve();
    const responses = await Promise.all([first, second, shot]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(events.slice(0, 2)).toEqual(["start:wait", "end:wait"]);
    expect(events).toContain("screenshot");
    expect(events.indexOf("end:type") - events.indexOf("start:type")).toBe(1);
  });
});
