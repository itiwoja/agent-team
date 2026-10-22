// app を起動する（ローカル）。足りない環境変数があっても起動し「準備中」を返す（D-47）。
// 準備ができていれば：Kill Switch の見張り（LISTEN ot_kill_switch＋2秒の見回り）・SSE の LISTEN を張り、
// オーナーの初期投入（G-08。冪等）を後ろで試す（DB がまだ起きていなければ少し待ってやり直す。
// 手で呼ぶなら POST /internal/setup/owner-workspace）。tick（毎分）と掃除（毎時）はこのプロセスのタイマーで回す

import { serve } from "@hono/node-server";
import { describeMissing } from "@open-team/platform";
import { createApp } from "./app.ts";
import { createAppDeps, type AppDeps } from "./deps.ts";
import { readAppEnv } from "./env.ts";
import { runCleanup, runTick } from "./tick.ts";
import { ensureOwnerWorkspace, OwnerSetupError } from "./owner-setup.ts";
import { settleDrivingRuns, stopStartingAskTasks } from "./asks/run.ts";
import { startKillWatch, type KillWatch } from "./registry.ts";

const OWNER_SETUP_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];
/** 止めるときに、中断したタスクの後始末（failed にする）を待つ上限（猶予の内に収める） */
const SHUTDOWN_SETTLE_MS = 5_000;

async function setupOwnerInBackground(deps: AppDeps): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ensureOwnerWorkspace(deps);
      return;
    } catch (e) {
      const delay = OWNER_SETUP_RETRY_DELAYS_MS[attempt];
      deps.log.warn("owner_setup.retry", "オーナーの初期投入に失敗した", {
        step: e instanceof OwnerSetupError ? e.step : null,
        error: e,
        retryInMs: delay ?? null,
      });
      if (delay === undefined) return;
      await deps.sleep(delay);
    }
  }
}

const TICK_INTERVAL_MS = 60_000;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

/** 前の実行が終わっていなければ飛ばす。失敗はログだけ（タイマーを止めない） */
function startPeriodic(deps: AppDeps, name: string, intervalMs: number, job: () => Promise<unknown>): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      deps.log.warn("periodic.skipped", `前の ${name} がまだ終わっていないので飛ばした`, { job: name });
      return;
    }
    running = true;
    job()
      .catch((error) => deps.log.error("periodic.failed", `${name} に失敗した`, { job: name, error }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}

const { env, missing } = readAppEnv();
const deps = createAppDeps(env, missing);
if (missing.length > 0) deps.log.warn("app.setup_required", `準備中：${describeMissing(missing)}`, { missing });

const app = createApp(deps);
const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  deps.log.info("app.listening", `app listening on :${info.port}`, { port: info.port });
});

let killWatch: KillWatch | null = null;
const timers: NodeJS.Timeout[] = [];
if (missing.length === 0) {
  try {
    killWatch = await startKillWatch({ db: deps.db, registry: deps.registry, log: deps.log });
    await deps.eventHub.start();
  } catch (error) {
    deps.log.error("app.listen_failed", "LISTEN を張れなかった（Kill Switch は見回りと判定の手順1で止まる）", { error });
  }
  void setupOwnerInBackground(deps);
  timers.push(startPeriodic(deps, "tick", TICK_INTERVAL_MS, () => runTick(deps)));
  // 掃除は DATABASE_URL_MAINT（ot_retention）がなければ回さない
  if (env.databaseUrlMaint) timers.push(startPeriodic(deps, "掃除", CLEANUP_INTERVAL_MS, () => runCleanup(deps)));
}

// SIGTERM・SIGINT を受けたら、動いているものを止め、接続を閉じる
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearInterval(t);
  deps.log.info("app.stopping", `${signal} を受けたので止める`, { running: deps.registry.size });
  // 新しく取らせない（queued のまま残す：次の起動の tick が拾う）。動いているものは止め、後始末が済むのを待つ
  stopStartingAskTasks();
  for (const e of deps.registry.list()) deps.registry.abortTask(e.id, "shutdown");
  await settleDrivingRuns(SHUTDOWN_SETTLE_MS).catch(() => {});
  await killWatch?.stop().catch(() => {});
  await deps.eventHub.stop().catch(() => {});
  server.close();
  await deps.db.close({ timeoutSec: 5 }).catch(() => {});
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
