// sim-world を起動する（pnpm dev・docker compose。apps/app の server.ts と同じ書き方）
// 足りない環境変数があれば起動しない（画面がないので「準備中」にしない：SO §3.1.3）。
// 保存は DATABASE_URL があれば Postgres、なければメモリ。マイグレーションは流さない（CI・db の migrate）

import { serve } from "@hono/node-server";
import { describeMissing } from "@open-team/platform";
import { createApp } from "./app.ts";
import { readSimWorldEnv } from "./env.ts";
import { simWorldLogger } from "./log.ts";
import { openSimStore } from "./open-store.ts";

const { env, missing } = readSimWorldEnv();
const log = simWorldLogger(env.commitSha);

if (missing.length > 0) {
  // 名前だけを出す（値は出さない：D-47）
  log.log({ severity: "CRITICAL", event: "sim.startup_refused", message: describeMissing(missing), missing });
  process.exit(1);
}

const opened = openSimStore(env);

const app = createApp(env, { store: opened.store, log });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  log.info("sim.listening", `sim-world listening on :${info.port}`, { port: info.port, store: opened.kind });
});

// 止める前に SIGTERM が来る（docker compose stop など）：受け付けをやめ、DB の接続を閉じてから終わる
let stopping = false;
let exiting = false;
const done = () => {
  if (exiting) return;
  exiting = true;
  void opened
    .close()
    .catch(() => {})
    .finally(() => process.exit(0));
};
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info("sim.stopping", `${signal} を受けたので止める`, { signal });
  server.close(done);
  // 開いたままの接続（keep-alive）で close が終わらないときも、10秒で終わる
  setTimeout(done, 10_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
