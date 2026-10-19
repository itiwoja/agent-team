// gateway の Hono のアプリ（api-surface.md §1.2・§2.12.2・§3.17、security-ops-deploy.md §3.9）。書き込みの唯一の出口（15:445）。
// /gw/v1/* は呼び出し元を sa-app だけに限る（cloud は Cloud Run の IAM の上に ID トークンのクレーム、local は共有トークン：15:483）。
// 本文の workspaceId・rehearsal_run_id・shadow は読まない（EP-49 は z.object で知らないキーを捨てる：AS §2 の例外、T-155）。
// 誤りは 09 の共通の形 { error: { code, message, details, requestId } }

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { GwToolsCallRequest } from "@open-team/gateway-client";
import {
  AppError,
  createServiceAuth,
  errorHandler,
  errorResponse,
  notFoundHandler,
  parseInput,
  readJsonBody,
  requestContext,
  requestIdOf,
  type PlatformEnv,
} from "@open-team/platform";
import { resolveContext, type GatewayContext, type GatewayDeps } from "./context.ts";
import type { GatewayEnv } from "./env.ts";
import { executeIntent } from "./execute.ts";
import { callReadTool } from "./reads.ts";
import { syncConnectorTools } from "./sync.ts";

/** 本文の上限（SO §2.1 の apiBodyLimitBytes と同じ） */
export const BODY_LIMIT_BYTES = 64 * 1024;
export const TASK_TOKEN_HEADER = "x-task-token";

/** EP-49 の本文（z.object：知らないキーは捨てる。workspaceId を載せられても読まない） */
export const ToolsCallBody = z.object({
  connectorId: z.uuid(),
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()),
  toolCallId: z.string().min(1).max(200),
});

export interface GatewayApp {
  app: Hono<PlatformEnv>;
  /** 処理の関数が使う依存（試験で直接呼ぶとき） */
  context: GatewayContext;
}

export function createGateway(env: GatewayEnv, deps: GatewayDeps): GatewayApp {
  const g = resolveContext(env, deps);
  const auth = deps.serviceAuth ?? createServiceAuth(env.serviceAuth, { log: g.log });
  const app = new Hono<PlatformEnv>();

  app.use("*", requestContext({ logger: g.log, acceptIncoming: true }));
  app.onError(errorHandler({ logger: g.log }));
  app.notFound(notFoundHandler());

  // Cloud Run の予約パスを避けた /api/health も同じ（SO §4.1）。中身は版だけ
  const health = { status: "ok", service: "gateway", commit: env.commitSha ?? null } as const;
  app.get("/api/health", (c) => c.json(health));
  app.get("/healthz", (c) => c.json(health));

  app.use(
    "/gw/v1/*",
    bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => errorResponse(c, "PAYLOAD_TOO_LARGE") }),
    auth.verifyServiceCaller(["sa-app"]),
  );

  // EP-49 読み取り
  app.post("/gw/v1/tools/call", async (c) => {
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) throw new AppError("UNSUPPORTED_MEDIA_TYPE");
    const body = parseInput(ToolsCallBody, await readJsonBody(c)) as GwToolsCallRequest;
    const res = await callReadTool(g, c.req.header(TASK_TOKEN_HEADER), body, requestIdOf(c));
    return c.json(res);
  });

  // EP-50 書き込みの実行（本文は読まない：Intent の行から引く）
  app.post("/gw/v1/intents/:intentId/execute", async (c) => {
    const res = await executeIntent(g, c.req.param("intentId"), { requestId: requestIdOf(c), signal: c.req.raw.signal });
    return c.json(res);
  });

  // EP-51 ツールの同期（本文は読まない：コネクタの行から引く）
  app.post("/gw/v1/connectors/:connectorId/tools/sync", async (c) => {
    const res = await syncConnectorTools(g, c.req.param("connectorId"), requestIdOf(c));
    return c.json(res);
  });

  app.post("/gw/v1/connectors/:connectorId/revoke-credential", async (c) => {
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) throw new AppError("UNSUPPORTED_MEDIA_TYPE");
    const body = parseInput(z.object({ workspaceId: z.uuid() }), await readJsonBody(c));
    await g.revokeGoogleCredential(c.req.param("connectorId"), body.workspaceId);
    return c.body(null, 204);
  });

  return { app, context: g };
}

/** Hono のアプリだけ（server.ts・ほかの担当の試験） */
export function createApp(env: GatewayEnv, deps: GatewayDeps): Hono<PlatformEnv> {
  return createGateway(env, deps).app;
}
