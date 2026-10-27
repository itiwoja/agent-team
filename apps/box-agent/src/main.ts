import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { ChromiumBrowser } from "./browser.ts";
import type { ChromiumBrowserOptions } from "./browser.ts";
import { createAgentServer } from "./server.ts";
import type { AgentServerOptions } from "./server.ts";
import type { BrowserBackend } from "./protocol.ts";

type StopSignal = "SIGTERM" | "SIGINT" | "SIGHUP";
type MainCode = StopSignal | "OK" | "FAILED" | "STARTING" | "LISTENING" | "READY"
  | "ARGUMENTS_NOT_SUPPORTED" | "BROWSER_TOKEN_REQUIRED" | "INVALID_BROWSER_TOKEN"
  | "INVALID_CONTROL_EPOCH" | "INVALID_PROXY" | "INVALID_MAIN_OPTIONS"
  | "INITIALIZATION_FAILED" | "BACKEND_START_FAILED" | "BACKEND_NOT_READY" | "BACKEND_FAILURE"
  | "LISTEN_FAILED" | "HTTP_FAILURE" | "STARTUP_TIMEOUT" | "SHUTDOWN_TIMEOUT"
  | "HTTP_CLOSE_FAILED" | "BACKEND_STOP_FAILED";

export interface MainLog {
  event: "starting" | "listening" | "ready" | "stopping" | "stopped" | "failed";
  code: MainCode;
}

export interface ManagedBrowserBackend extends BrowserBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: "failure", listener: (error: Error) => void): unknown;
  off(event: "failure", listener: (error: Error) => void): unknown;
}

interface SignalSource {
  on(event: StopSignal, listener: () => void): unknown;
  off(event: StopSignal, listener: () => void): unknown;
}

/** 注入は単体試験用。通常起動の環境・argvにport/host/実行ファイルの変更口はない。 */
export interface MainOptions {
  environment?: NodeJS.ProcessEnv;
  args?: readonly string[];
  createBackend?: (options: ChromiumBrowserOptions) => ManagedBrowserBackend;
  createServer?: (options: AgentServerOptions) => Server;
  signals?: SignalSource;
  port?: 0;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  log?: (entry: MainLog) => void;
}

class ConfigurationError extends Error {
  readonly code: MainCode;
  constructor(code: MainCode) { super(code); this.code = code; }
}

function configuration(environment: NodeJS.ProcessEnv, args: readonly string[]) {
  const token = environment.BROWSER_TOKEN;
  // 子の生成より前に除去する。起動時の/proc等からNode自身の初期環境を隠す保証ではない。
  delete environment.BROWSER_TOKEN;
  delete environment.SHELL_TOKEN;
  if (args.length !== 0) throw new ConfigurationError("ARGUMENTS_NOT_SUPPORTED");
  if (!token) throw new ConfigurationError("BROWSER_TOKEN_REQUIRED");
  if (!/^[\x21-\x7e]+$/.test(token)) throw new ConfigurationError("INVALID_BROWSER_TOKEN");
  const epochText = environment.CONTROL_EPOCH ?? "0";
  const controlEpoch = Number(epochText);
  if (!/^\d+$/.test(epochText) || !Number.isSafeInteger(controlEpoch) || controlEpoch < 0) {
    throw new ConfigurationError("INVALID_CONTROL_EPOCH");
  }
  const proxyUrl = environment.BROWSER_PROXY_URL ?? "";
  if (proxyUrl !== "" && proxyUrl !== "http://egress:3128") throw new ConfigurationError("INVALID_PROXY");
  return { token, controlEpoch, proxyUrl };
}

function logToStderr(entry: MainLog): void {
  process.stderr.write(`[box-agent] ${entry.event} ${entry.code}\n`);
}

function notListening(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING";
}

/** 終了まで待ち、プロセス用の終了コードを返す。importや単体試験ではprocess.exitしない。 */
export async function runAgent(options: MainOptions = {}): Promise<number> {
  const log = (entry: MainLog): void => {
    // ログ出力の例外で停止処理を中断しない。生の例外はどの経路でも出さない。
    try { (options.log ?? logToStderr)(entry); } catch { /* stderrの断線等 */ }
  };
  let config: ReturnType<typeof configuration>;
  const startupTimeoutMs = options.startupTimeoutMs ?? 25_000;
  // Bash supervisorの5秒の停止猶予より短くする。
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 4_000;
  try {
    config = configuration(options.environment ?? process.env, options.args ?? process.argv.slice(2));
    if ((options.port !== undefined && options.port !== 0)
      || ![startupTimeoutMs, shutdownTimeoutMs].every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 60_000)) {
      throw new ConfigurationError("INVALID_MAIN_OPTIONS");
    }
  } catch (error) {
    log({ event: "failed", code: error instanceof ConfigurationError ? error.code : "INITIALIZATION_FAILED" });
    return 1;
  }

  const signals = options.signals ?? process;
  const listenAbort = new AbortController();
  const inFlight = new Set<Promise<unknown>>();
  let backend: ManagedBrowserBackend | undefined;
  let server: Server | undefined;
  let backendStarted: Promise<void> | undefined;
  let prepared = false;
  let listening = false;
  let stopping = false;
  let finished = false;
  let exitCode = 0;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let complete!: (code: number) => void;
  const completed = new Promise<number>((done) => { complete = done; });
  const signalHandlers: Array<[StopSignal, () => void]> = [];

  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(startupTimer);
    clearTimeout(shutdownTimer);
    for (const [name, listener] of signalHandlers) signals.off(name, listener);
    backend?.off("failure", onBackendFailure);
    log({ event: "stopped", code: exitCode === 0 ? "OK" : "FAILED" });
    complete(exitCode);
  };

  const closeHttp = async (): Promise<void> => {
    const current = server;
    if (!current) return;
    const closed = new Promise<void>((done, reject) => {
      // vnc.tsのcloseラッパーが先にupgrade済みWS/upstreamを終了させる。
      current.close((error) => error && !notListening(error) ? reject(new Error("HTTP_CLOSE_FAILED")) : done());
    });
    const disconnect = Promise.resolve().then(() => {
      // DNS/listenの途中も取り消す。HTTPの保留本文・応答・keep-aliveも残さない。
      listenAbort.abort();
      current.closeAllConnections();
    });
    await Promise.all([closed, disconnect]);
  };

  const shutdown = (failure: boolean, code: MainCode): void => {
    if (finished) return;
    if (failure) {
      exitCode = 1;
      log({ event: "failed", code });
    }
    if (stopping) return;
    stopping = true;
    prepared = false; // backend.stopの完了を待たず、キューの追加実行を拒否する。
    clearTimeout(startupTimer);
    log({ event: "stopping", code });
    shutdownTimer = setTimeout(() => {
      exitCode = 1;
      log({ event: "failed", code: "SHUTDOWN_TIMEOUT" });
      try { server?.closeAllConnections(); } catch { /* 最後の切断もbest effort */ }
      finish(); // CLIは直後に非0でexitし、supervisorが残りの世代を停止する。
    }, shutdownTimeoutMs);

    const close = closeHttp().catch(() => {
      if (!finished) { exitCode = 1; log({ event: "failed", code: "HTTP_CLOSE_FAILED" }); }
    });
    const stop = Promise.resolve().then(() => backend?.stop()).catch(() => {
      if (!finished) { exitCode = 1; log({ event: "failed", code: "BACKEND_STOP_FAILED" }); }
    });
    // start中の停止、実行中の操作のabortも回収する。後続queueはprepared=falseで実行されない。
    void Promise.allSettled([close, stop, ...(backendStarted ? [backendStarted] : []), ...inFlight]).then(finish);
  };

  function onBackendFailure(): void { shutdown(true, "BACKEND_FAILURE"); }
  function available(): boolean { return prepared && !stopping && (backend?.ready() ?? false); }
  function track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(() => {
      if (!available()) throw new Error("BACKEND_NOT_READY");
      return operation();
    });
    inFlight.add(promise);
    void promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise));
    return promise;
  }

  for (const name of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const listener = (): void => shutdown(false, name);
    signalHandlers.push([name, listener]);
    signals.on(name, listener);
  }
  startupTimer = setTimeout(() => shutdown(true, "STARTUP_TIMEOUT"), startupTimeoutMs);
  log({ event: "starting", code: "STARTING" });
  try {
    const browser = (options.createBackend ?? ((settings) => new ChromiumBrowser(settings)))({ proxyUrl: config.proxyUrl });
    backend = browser;
    browser.on("failure", onBackendFailure);
    const guardedBackend: BrowserBackend = {
      ready: available,
      get sandboxEnabled() { return browser.sandboxEnabled; },
      execute: (action) => track(() => browser.execute(action)),
      screenshot: () => track(() => browser.screenshot()),
    };
    server = (options.createServer ?? createAgentServer)({ token: config.token, controlEpoch: config.controlEpoch, backend: guardedBackend });
    server.on("error", () => shutdown(true, listening ? "HTTP_FAILURE" : "LISTEN_FAILED"));
    server.on("close", () => { if (!stopping) shutdown(true, "HTTP_FAILURE"); });
    server.once("listening", () => {
      listening = true;
      if (stopping) return;
      log({ event: "listening", code: "LISTENING" });
      // 待受を先に用意し、CDPの準備中は認証済みHTTPへ503を返す。
      backendStarted = Promise.resolve().then(() => {
        if (!stopping) return browser.start();
      }).then(() => {
        if (stopping) return;
        if (!browser.ready()) { shutdown(true, "BACKEND_NOT_READY"); return; }
        prepared = true;
        clearTimeout(startupTimer);
        log({ event: "ready", code: "READY" });
      }).catch(() => { if (!stopping) shutdown(true, "BACKEND_START_FAILED"); });
    });
    try { server.listen({ host: "0.0.0.0", port: options.port ?? 6080, signal: listenAbort.signal }); }
    catch { shutdown(true, "LISTEN_FAILED"); }
  } catch {
    shutdown(true, "INITIALIZATION_FAILED");
  }
  return completed;
}

export function isMainEntrypoint(entrypoint: string | undefined, moduleUrl = import.meta.url): boolean {
  return entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === moduleUrl;
}

if (isMainEntrypoint(process.argv[1])) {
  // deadline後にも未完の子/処理が残り得るため、exitCodeの設定だけで待ち続けない。
  void runAgent().then((code) => process.exit(code), () => {
    logToStderr({ event: "failed", code: "INITIALIZATION_FAILED" });
    process.exit(1);
  });
}
