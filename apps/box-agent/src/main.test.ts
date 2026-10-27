import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMainEntrypoint, runAgent } from "./main.ts";
import type { MainLog, MainOptions, ManagedBrowserBackend } from "./main.ts";
import type { ActionOutput, BrowserAction } from "./protocol.ts";
import { createAgentServer } from "./server.ts";
import type { AgentServerOptions } from "./server.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeBackend extends EventEmitter<{ failure: [Error] }> implements ManagedBrowserBackend {
  sandboxEnabled = true;
  readonly startup = deferred();
  readonly startCalled = deferred();
  readonly actionCalled = deferred();
  actionGate: ReturnType<typeof deferred> | undefined;
  isReady = false;
  stopped = false;
  starting = false;
  ready(): boolean { return this.isReady; }
  start = vi.fn(async () => {
    this.starting = true;
    this.startCalled.resolve();
    await this.startup.promise;
    if (this.stopped) throw new Error("start cancelled");
    this.isReady = true;
  });
  stop = vi.fn(async () => {
    this.stopped = true;
    this.isReady = false;
    if (this.starting) this.startup.reject(new Error("start cancelled"));
    this.actionGate?.reject(new Error("action cancelled"));
  });
  execute = vi.fn(async (_action: BrowserAction): Promise<ActionOutput> => {
    this.actionCalled.resolve();
    if (this.actionGate) await this.actionGate.promise;
    return { executed: true };
  });
  screenshot = vi.fn(async () => Buffer.from("89504e470d0a1a0a", "hex"));
}

const active: Array<{ signals: EventEmitter; done: Promise<number> }> = [];
afterEach(async () => {
  for (const item of active.splice(0)) {
    item.signals.emit("SIGTERM");
    await item.done;
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(options: {
  pending?: boolean;
  epoch?: string;
  proxy?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  backend?: FakeBackend;
  serverFactory?: (options: AgentServerOptions) => Server;
} = {}) {
  const token = randomBytes(32).toString("hex");
  const shellToken = randomBytes(32).toString("hex");
  const environment: NodeJS.ProcessEnv = { BROWSER_TOKEN: token, SHELL_TOKEN: shellToken,
    ...(options.epoch !== undefined ? { CONTROL_EPOCH: options.epoch } : {}),
    ...(options.proxy !== undefined ? { BROWSER_PROXY_URL: options.proxy } : {}),
  };
  const signals = new EventEmitter();
  const backend = options.backend ?? new FakeBackend();
  if (!options.pending) backend.startup.resolve();
  const listening = deferred();
  const ready = deferred();
  const logs: MainLog[] = [];
  let server: Server | undefined;
  const createBackend = vi.fn((settings) => {
    expect(settings).toEqual({ proxyUrl: options.proxy ?? "" });
    expect(environment).not.toHaveProperty("BROWSER_TOKEN");
    expect(environment).not.toHaveProperty("SHELL_TOKEN");
    return backend;
  });
  const done = runAgent({
    environment, args: [], signals, port: 0,
    startupTimeoutMs: options.startupTimeoutMs ?? 2000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 1000,
    createBackend,
    createServer: (settings) => {
      server = (options.serverFactory ?? createAgentServer)(settings);
      server.once("listening", listening.resolve);
      return server;
    },
    log: (entry) => { logs.push(entry); if (entry.event === "ready") ready.resolve(); },
  });
  active.push({ signals, done });
  const base = () => {
    const address = server?.address();
    if (!address || typeof address === "string") throw new Error("test server not listening");
    return `http://127.0.0.1:${address.port}`;
  };
  const get = (path: string, credential = token) => fetch(`${base()}${path}`, {
    headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(2000),
  });
  const post = (controlEpoch = Number(options.epoch ?? "0")) => fetch(`${base()}/actions`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ actionId: randomUUID(), controlEpoch, action: { kind: "wait", duration: 0 } }),
    signal: AbortSignal.timeout(2000),
  });
  return { token, shellToken, environment, signals, backend, listening, ready, logs, done,
    server: () => server!, base, get, post, createBackend };
}

describe("mainの起動・準備・停止", () => {
  it("HTTPを先に待受け、CDP準備前は503、準備後だけbackendへ操作を渡す", async () => {
    const f = fixture({ pending: true, epoch: "3", proxy: "http://egress:3128" });
    await f.listening.promise;
    expect((await f.get("/healthz")).status).toBe(503);
    expect((await f.get("/screenshot")).status).toBe(503);
    expect((await f.post()).status).toBe(503);
    expect((await f.get("/healthz", f.shellToken)).status).toBe(401);
    expect(f.backend.execute).not.toHaveBeenCalled();
    expect(f.backend.screenshot).not.toHaveBeenCalled();
    f.backend.startup.resolve();
    await f.ready.promise;
    const health = await f.get("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ready: true, sandboxEnabled: true });
    expect((await f.post(2)).status).toBe(409);
    expect((await f.post()).status).toBe(200);
    expect(f.backend.execute).toHaveBeenCalledOnce();
    const screenshot = await f.get("/screenshot");
    expect(screenshot.headers.get("content-type")).toBe("image/png");
    expect(f.backend.screenshot).toHaveBeenCalledOnce();
    f.signals.emit("SIGTERM");
    expect(await f.done).toBe(0);
    expect(f.server().listening).toBe(false);
    expect(f.backend.stop).toHaveBeenCalledOnce();
    for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) expect(f.signals.listenerCount(name)).toBe(0);
    expect(f.backend.listenerCount("failure")).toBe(0);
    expect(JSON.stringify(f.logs)).not.toContain(f.token);
    expect(JSON.stringify(f.logs)).not.toContain(f.shellToken);
  });

  it("backend.readyが早くtrueでもstartが完了するまでは503を維持する", async () => {
    const backend = new FakeBackend();
    backend.isReady = true;
    const f = fixture({ backend, pending: true });
    await f.listening.promise;
    expect((await f.get("/healthz")).status).toBe(503);
    f.signals.emit("SIGTERM");
    expect(await f.done).toBe(0);
    expect(f.logs.some((entry) => entry.event === "ready")).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT", "SIGHUP"])("%sでHTTPとbackendを閉じ、重複停止をしない", async (signal) => {
    const f = fixture();
    await f.ready.promise;
    const closeAll = vi.spyOn(f.server(), "closeAllConnections");
    f.signals.emit(signal);
    f.signals.emit(signal);
    expect(await f.done).toBe(0);
    expect(f.backend.stop).toHaveBeenCalledOnce();
    expect(closeAll).toHaveBeenCalled();
  });

  it("準備中のSIGTERMでstartを取り消し、準備完了を後から通知しない", async () => {
    const f = fixture({ pending: true });
    await f.backend.startCalled.promise;
    f.signals.emit("SIGTERM");
    expect(await f.done).toBe(0);
    f.backend.startup.resolve();
    await Promise.resolve();
    expect(f.logs.some((entry) => entry.event === "ready")).toBe(false);
    expect(f.server().listening).toBe(false);
  });

  it("起動失敗を固定コードへ変換し、HTTPも閉じて非0で終了する", async () => {
    const f = fixture({ pending: true });
    await f.backend.startCalled.promise;
    const privateMessage = `${f.token} http://shell/private 入力本文`;
    f.backend.startup.reject(new Error(privateMessage));
    expect(await f.done).toBe(1);
    expect(f.backend.stop).toHaveBeenCalledOnce();
    expect(f.server().listening).toBe(false);
    expect(f.logs).toContainEqual({ event: "failed", code: "BACKEND_START_FAILED" });
    expect(JSON.stringify(f.logs)).not.toMatch(/private|入力本文/);
    expect(JSON.stringify(f.logs)).not.toContain(f.token);
  });

  it("startが成功してもready=falseなら正常起動にしない", async () => {
    const backend = new FakeBackend();
    backend.start.mockResolvedValue(undefined);
    const f = fixture({ backend });
    expect(await f.done).toBe(1);
    expect(f.logs).toContainEqual({ event: "failed", code: "BACKEND_NOT_READY" });
  });

  it("Chromium failureで非0終了し、生の例外は出さない", async () => {
    const f = fixture();
    await f.ready.promise;
    f.backend.emit("failure", new Error(`${f.token} http://shell/private`));
    expect(await f.done).toBe(1);
    expect(f.logs).toContainEqual({ event: "failed", code: "BACKEND_FAILURE" });
    expect(f.backend.stop).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.logs)).not.toMatch(/http|private/);
    expect(JSON.stringify(f.logs)).not.toContain(f.token);
  });

  it("listen失敗ならbackendを開始せず、非0で終了する", async () => {
    const f = fixture({ serverFactory: (settings) => {
      const server = createAgentServer(settings);
      vi.spyOn(server, "listen").mockImplementation(() => {
        queueMicrotask(() => server.emit("error", new Error("host/pathを含む外部エラー")));
        return server;
      });
      return server;
    } });
    expect(await f.done).toBe(1);
    expect(f.backend.start).not.toHaveBeenCalled();
    expect(f.backend.stop).toHaveBeenCalledOnce();
    expect(f.logs).toContainEqual({ event: "failed", code: "LISTEN_FAILED" });
    expect(JSON.stringify(f.logs)).not.toContain("host/path");
  });

  it("listenの同期例外も非0で終了する", async () => {
    const f = fixture({ serverFactory: (settings) => {
      const server = createAgentServer(settings);
      vi.spyOn(server, "listen").mockImplementation(() => { throw new Error("untrusted detail"); });
      return server;
    } });
    expect(await f.done).toBe(1);
    expect(f.logs).toContainEqual({ event: "failed", code: "LISTEN_FAILED" });
  });

  it("server生成が失敗しても生成済みbackendを停止する", async () => {
    const f = fixture({ serverFactory: () => { throw new Error("untrusted detail"); } });
    expect(await f.done).toBe(1);
    expect(f.backend.start).not.toHaveBeenCalled();
    expect(f.backend.stop).toHaveBeenCalledOnce();
    expect(f.logs).toContainEqual({ event: "failed", code: "INITIALIZATION_FAILED" });
  });

  it("HTTP待受が予期せず閉じられたらbackendも停止する", async () => {
    const f = fixture();
    await f.ready.promise;
    f.server().close();
    expect(await f.done).toBe(1);
    expect(f.backend.stop).toHaveBeenCalledOnce();
    expect(f.logs).toContainEqual({ event: "failed", code: "HTTP_FAILURE" });
  });

  it("起動処理が止まっていてもstartup期限で停止する", async () => {
    const f = fixture({ pending: true, startupTimeoutMs: 30 });
    expect(await f.done).toBe(1);
    expect(f.logs).toContainEqual({ event: "failed", code: "STARTUP_TIMEOUT" });
    expect(f.backend.stop).toHaveBeenCalledOnce();
  });

  it("backend.stopが止まっていても停止期限で非0を返す", async () => {
    const backend = new FakeBackend();
    backend.stop.mockImplementation(() => new Promise<void>(() => {}));
    const f = fixture({ backend, shutdownTimeoutMs: 30 });
    await f.ready.promise;
    f.signals.emit("SIGTERM");
    expect(await f.done).toBe(1);
    expect(f.logs).toContainEqual({ event: "failed", code: "SHUTDOWN_TIMEOUT" });
    expect(f.server().listening).toBe(false);
  });

  it("HTTP closeのcallbackが返らなくても停止期限で非0を返す", async () => {
    const f = fixture({ shutdownTimeoutMs: 30, serverFactory: (settings) => {
      const server = createAgentServer(settings);
      const close = server.close.bind(server);
      vi.spyOn(server, "close").mockImplementation(() => { close(() => {}); return server; });
      return server;
    } });
    await f.ready.promise;
    f.signals.emit("SIGTERM");
    expect(await f.done).toBe(1);
    expect(f.logs).toContainEqual({ event: "failed", code: "SHUTDOWN_TIMEOUT" });
  });

  it("backend停止の失敗を正常終了にしない", async () => {
    const backend = new FakeBackend();
    backend.stop.mockRejectedValue(new Error("秘密が入った停止エラー"));
    const f = fixture({ backend });
    await f.ready.promise;
    f.signals.emit("SIGINT");
    expect(await f.done).toBe(1);
    expect(f.logs).toContainEqual({ event: "failed", code: "BACKEND_STOP_FAILED" });
    expect(JSON.stringify(f.logs)).not.toContain("秘密");
  });

  it("実行中HTTPを切断して操作をabortし、後続queueを実行させない", async () => {
    const backend = new FakeBackend();
    backend.actionGate = deferred();
    const f = fixture({ backend });
    await f.ready.promise;
    let requests = 0;
    const secondReceived = deferred();
    f.server().on("request", (request) => {
      if (++requests === 2) request.once("end", secondReceived.resolve);
    });
    const first = f.post().catch(() => undefined);
    await backend.actionCalled.promise;
    const queued = f.post().catch(() => undefined);
    await secondReceived.promise;
    f.signals.emit("SIGTERM");
    expect(await f.done).toBe(0);
    await Promise.all([first, queued]);
    expect(backend.execute).toHaveBeenCalledOnce();
    expect(backend.stop).toHaveBeenCalledOnce();
  });

  it("backend.stop後も操作promiseが残れば期限内に非0で終了する", async () => {
    const backend = new FakeBackend();
    const operation = deferred();
    backend.actionGate = operation;
    backend.stop.mockResolvedValue(undefined);
    const f = fixture({ backend, shutdownTimeoutMs: 30 });
    await f.ready.promise;
    const request = f.post().catch(() => undefined);
    await backend.actionCalled.promise;
    f.signals.emit("SIGTERM");
    expect(await f.done).toBe(1);
    expect(f.logs).toContainEqual({ event: "failed", code: "SHUTDOWN_TIMEOUT" });
    await request;
    operation.resolve();
  });

  it("upgrade済みVNCとupstreamをserver.closeのラッパー経由で閉じる", async () => {
    const upstreams = new Set<Socket>();
    const upstreamConnected = deferred();
    const tcp = createTcpServer((socket) => {
      upstreams.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => upstreams.delete(socket));
      upstreamConnected.resolve();
    });
    tcp.listen(0, "127.0.0.1");
    await once(tcp, "listening");
    const address = tcp.address();
    if (!address || typeof address === "string") throw new Error("missing upstream address");
    const f = fixture({ serverFactory: (settings) => createAgentServer({ ...settings, vncPort: address.port }) });
    let ws: WebSocket | undefined;
    try {
      await f.ready.promise;
      ws = new WebSocket(`${f.base().replace("http:", "ws:")}/vnc`, { headers: { authorization: `Bearer ${f.token}` } });
      ws.on("error", () => {});
      await once(ws, "open");
      await upstreamConnected.promise;
      const closed = once(ws, "close");
      f.signals.emit("SIGHUP");
      expect(await f.done).toBe(0);
      await closed;
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    } finally {
      ws?.terminate();
      for (const socket of upstreams) socket.destroy();
      await new Promise<void>((done) => tcp.close(() => done()));
    }
  });
});

describe("mainの設定・entrypoint境界", () => {
  it.each([
    { field: "BROWSER_TOKEN", value: undefined, code: "BROWSER_TOKEN_REQUIRED" },
    { field: "BROWSER_TOKEN", value: "", code: "BROWSER_TOKEN_REQUIRED" },
    { field: "BROWSER_TOKEN", value: "\n", code: "INVALID_BROWSER_TOKEN" },
    ...["", "-1", "1.5", "1e2", "0x10", " 1", "9007199254740992"].map((value) => ({ field: "CONTROL_EPOCH", value, code: "INVALID_CONTROL_EPOCH" })),
    { field: "BROWSER_PROXY_URL", value: "http://localhost:3128", code: "INVALID_PROXY" },
    { field: "BROWSER_PROXY_URL", value: " http://egress:3128", code: "INVALID_PROXY" },
  ])("不正設定 $field=$value は子の生成前に拒否する", async ({ field, value, code }) => {
    const environment: NodeJS.ProcessEnv = { BROWSER_TOKEN: randomBytes(32).toString("hex"), SHELL_TOKEN: randomBytes(32).toString("hex") };
    environment[field] = value;
    const createBackend = vi.fn();
    const log = vi.fn();
    expect(await runAgent({ environment, args: [], createBackend, log })).toBe(1);
    expect(createBackend).not.toHaveBeenCalled();
    expect(environment).not.toHaveProperty("BROWSER_TOKEN");
    expect(environment).not.toHaveProperty("SHELL_TOKEN");
    expect(log).toHaveBeenCalledWith({ event: "failed", code });
  });

  it("argvの任意URL/flagを拒否し、入力をログへ出さない", async () => {
    const environment = { BROWSER_TOKEN: randomBytes(32).toString("hex") };
    const createBackend = vi.fn();
    const log = vi.fn();
    expect(await runAgent({ environment, args: ["--remote-debugging-port=9222", "http://shell/private"], createBackend, log })).toBe(1);
    expect(createBackend).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({ event: "failed", code: "ARGUMENTS_NOT_SUPPORTED" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("CONTROL_EPOCHの既定0と最大safe integerをserverへ渡す", async () => {
    for (const epoch of [undefined, String(Number.MAX_SAFE_INTEGER)]) {
      const f = fixture({ epoch });
      await f.ready.promise;
      expect((await f.post()).status).toBe(200);
      f.signals.emit("SIGTERM");
      expect(await f.done).toBe(0);
    }
  });

  it("通常起動では0.0.0.0:6080固定で、PORT/HOST環境を採用しない", async () => {
    const token = randomBytes(32).toString("hex");
    const backend = new FakeBackend();
    const listen = vi.fn();
    const log = vi.fn();
    const code = await runAgent({ environment: { BROWSER_TOKEN: token, PORT: "9999", HOST: "other-host" }, args: [],
      createBackend: () => backend, log,
      createServer: (settings) => {
        const server = createAgentServer(settings);
        vi.spyOn(server, "listen").mockImplementation((...args) => {
          listen(...args);
          queueMicrotask(() => server.emit("error", new Error("test listen failure")));
          return server;
        });
        return server;
      },
    });
    expect(code).toBe(1);
    expect(listen).toHaveBeenCalledWith(expect.objectContaining({ host: "0.0.0.0", port: 6080 }));
  });

  it("実process.envから資格を除去した後でbackend factoryを呼ぶ", async () => {
    vi.stubEnv("BROWSER_TOKEN", randomBytes(32).toString("hex"));
    vi.stubEnv("SHELL_TOKEN", randomBytes(32).toString("hex"));
    vi.stubEnv("CONTROL_EPOCH", "0");
    vi.stubEnv("BROWSER_PROXY_URL", "");
    const createBackend: NonNullable<MainOptions["createBackend"]> = () => {
      expect(process.env.BROWSER_TOKEN).toBeUndefined();
      expect(process.env.SHELL_TOKEN).toBeUndefined();
      throw new Error("factory failure");
    };
    expect(await runAgent({ args: [], createBackend, log: () => {} })).toBe(1);
  });

  it("entrypointはprocess.argv[1]とimport.meta.urlの一致で判定する", () => {
    const url = new URL("./main.ts", import.meta.url).href;
    expect(isMainEntrypoint(fileURLToPath(url), url)).toBe(true);
    expect(isMainEntrypoint(undefined, url)).toBe(false);
    expect(isMainEntrypoint(fileURLToPath(import.meta.url), url)).toBe(false);
  });

  it("Nodeからimportしても起動せず、CLIの無資格起動は非0終了する", async () => {
    const url = new URL("./main.ts", import.meta.url);
    const child = (args: string[]) => new Promise<{ failed: boolean; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, args, { env: { PATH: "/usr/bin:/bin" }, timeout: 5000, encoding: "utf8" }, (error, stdout, stderr) => {
        done({ failed: error !== null, stdout, stderr });
      });
    });
    const imported = await child(["--input-type=module", "-e", `await import(${JSON.stringify(url.href)}); process.stdout.write("imported");`]);
    expect(imported).toEqual({ failed: false, stdout: "imported", stderr: "" });
    const cli = await child([fileURLToPath(url)]);
    expect(cli.failed).toBe(true);
    expect(cli.stderr).toBe("[box-agent] failed BROWSER_TOKEN_REQUIRED\n");
  });
});
