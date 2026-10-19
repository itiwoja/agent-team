// gateway を起動する（Cloud Run・docker compose）。起動時の確認（SO §3.1.2、BR-66・15:489）に外れたら起動しない：
// CRITICAL のログ gateway.startup_refused（名前と理由だけ。値は出さない：D-47）を出して exit 1（リビジョンが準備完了にならずデプロイが失敗する）

import { serve } from "@hono/node-server";
import { createDb } from "@open-team/db";
import { createLogger, readDeploymentMode } from "@open-team/platform";
import { createApp } from "./app.ts";
import { GatewayStartupError, assertGatewayEnv, readProjectNumber, simWorldUrlNeedsProjectNumber } from "./env.ts";

const log = createLogger({ service: "gateway", ...(process.env.COMMIT_SHA ? { commit: process.env.COMMIT_SHA } : {}) });

function refuse(missing: readonly string[], reasons: readonly string[]): never {
  log.log({ severity: "CRITICAL", event: "gateway.startup_refused", message: "起動時の確認に外れたので起動しない", missing: [...missing], reasons: [...reasons] });
  process.exit(1);
}

// cloud で SIM_WORLD_URL がプロジェクト番号の入った run.app なら、その番号が自分のプロジェクトのものか確かめる（SO §3.1.2 の2-4【提案】）
let projectNumber: string | null = null;
if (readDeploymentMode(process.env).mode === "cloud" && simWorldUrlNeedsProjectNumber(process.env.SIM_WORLD_URL?.trim() ?? null)) {
  projectNumber = await readProjectNumber();
  if (projectNumber === null) refuse([], ["メタデータサーバーからプロジェクト番号を読めない"]);
}

let env;
try {
  env = assertGatewayEnv(process.env, { projectNumber });
} catch (e) {
  if (e instanceof GatewayStartupError) refuse(e.missing, e.reasons);
  throw e;
}

// プールは2本（SO §4.6）。トランザクションの中で外部を呼ばない（G-14）
const db = createDb(env.databaseUrl, { max: 2, applicationName: "open-team-gateway" });
const app = createApp(env, { db, log });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  log.info("gateway.listening", `gateway listening on :${info.port}`, { port: info.port, mode: env.deploymentMode });
});

const shutdown = (signal: string) => {
  log.info("gateway.shutdown", "止める", { signal });
  server.close(() => {
    void db.close().finally(() => process.exit(0));
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
