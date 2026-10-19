// gateway を起動する（pnpm dev・docker compose）。起動時の確認（SO §3.1.2、BR-66・15:489）に外れたら起動しない：
// CRITICAL のログ gateway.startup_refused（名前と理由だけ。値は出さない：D-47）を出して exit 1

import { serve } from "@hono/node-server";
import { createDb } from "@open-team/db";
import { createLogger } from "@open-team/platform";
import { createApp } from "./app.ts";
import { GatewayStartupError, assertGatewayEnv } from "./env.ts";

const log = createLogger({ service: "gateway", ...(process.env.COMMIT_SHA ? { commit: process.env.COMMIT_SHA } : {}) });

function refuse(missing: readonly string[], reasons: readonly string[]): never {
  log.log({ severity: "CRITICAL", event: "gateway.startup_refused", message: "起動時の確認に外れたので起動しない", missing: [...missing], reasons: [...reasons] });
  process.exit(1);
}

let env;
try {
  env = assertGatewayEnv(process.env);
} catch (e) {
  if (e instanceof GatewayStartupError) refuse(e.missing, e.reasons);
  throw e;
}

// プールは2本（SO §4.6）。トランザクションの中で外部を呼ばない（G-14）
const db = createDb(env.databaseUrl, { max: 2, applicationName: "open-team-gateway" });
const app = createApp(env, { db, log });

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  log.info("gateway.listening", `gateway listening on :${info.port}`, { port: info.port });
});

const shutdown = (signal: string) => {
  log.info("gateway.shutdown", "止める", { signal });
  server.close(() => {
    void db.close().finally(() => process.exit(0));
  });
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
