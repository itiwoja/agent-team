// github を起動する（pnpm dev・docker compose。sim-world の server.ts と同じ書き方）
// 足りない環境変数があれば起動しない（名前だけを出す：D-47）。DB は持たない（18 §2-4）

import { serve } from "@hono/node-server";
import { describeMissing } from "@open-team/platform";
import { createApp } from "./app.ts";
import { readGithubEnv } from "./env.ts";
import { githubLogger } from "./log.ts";

const { env, missing } = readGithubEnv();
const log = githubLogger(env.commitSha);

if (missing.length > 0) {
  log.log({ severity: "CRITICAL", event: "github.startup_refused", message: describeMissing(missing), missing });
  process.exit(1);
}

const app = createApp(env, { log });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  log.info("github.listening", `github listening on :${info.port}`, { port: info.port });
});

// 止める前に SIGTERM が来る（docker compose stop など）：受け付けをやめてから終わる
let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info("github.stopping", `${signal} を受けたので止める`, { signal });
  server.close(() => process.exit(0));
  // 開いたままの接続（keep-alive）で close が終わらないときも、10秒で終わる
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
