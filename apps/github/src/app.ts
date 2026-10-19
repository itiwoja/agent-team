// github の Hono のアプリ（18 §3.2）。/mcp/github（MCP。sa-gateway だけ）と /healthz。
// リクエスト ID・ログ・呼び出し元の確認・エラーの形は packages/platform のミドルウェア（sim-world と同じ）。

import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  createServiceAuth,
  errorHandler,
  errorResponse,
  notFoundHandler,
  requestContext,
  silentLogger,
  type Logger,
  type PlatformEnv,
  type ServiceAuth,
  type ServiceAuthDeps,
} from "@open-team/platform";
import { GITHUB_HEADER, GITHUB_MCP_PATH } from "@open-team/github-core";
import { GITHUB_CALLERS } from "./auth.ts";
import { serviceAuthConfigOf, type GithubEnv } from "./env.ts";
import { handleMcpPost, mcpMethodNotAllowed } from "./mcp.ts";

export interface GithubDeps {
  /** GitHub の fetch（既定は実物。試験は偽物） */
  fetch?: typeof fetch;
  /** 呼び出し元の確認。省略は env から createServiceAuth で作る */
  serviceAuth?: ServiceAuth;
  /** serviceAuth を env から作るときの依存（cloud の署名の検証器・時計。試験は偽の検証器を渡す） */
  serviceAuthDeps?: Omit<ServiceAuthDeps, "log">;
  log?: Logger;
}

/** 本文の上限（push_commit は1ファイル20万字・50ファイルまで。書き込みの引数が入る大きさ） */
export const BODY_LIMIT_BYTES = 12 * 1024 * 1024;

export function createApp(env: GithubEnv, deps: GithubDeps = {}) {
  const fetchFn = deps.fetch ?? ((input: string | URL | Request, init?: RequestInit) => fetch(input, init));
  const log = deps.log ?? silentLogger;
  const auth = deps.serviceAuth ?? createServiceAuth(serviceAuthConfigOf(env), { ...deps.serviceAuthDeps, log });

  const app = new Hono<PlatformEnv>();

  // リクエスト ID とリクエストの Logger（Bearer などをマスク）
  app.use("*", requestContext({ logger: log, acceptIncoming: true }));

  // トークンはログに出さない：このリクエストの Logger の既知の値に足す（platform のマスクで [REDACTED]）
  const maskAccessToken: MiddlewareHandler<PlatformEnv> = async (c, next) => {
    const token = c.req.header(GITHUB_HEADER.token);
    if (token) c.set("log", c.get("log").child({}, [token]));
    await next();
  };

  app.get("/healthz", (c) => c.json({ status: "ok", service: "github", commit: env.commitSha ?? null }));

  // 呼び出し元の確認（sa-gateway だけ）。外れたら 403 FORBIDDEN、理由はログにだけ
  app.use(
    GITHUB_MCP_PATH,
    maskAccessToken,
    auth.verifyServiceCaller(GITHUB_CALLERS),
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => errorResponse(c, "PAYLOAD_TOO_LARGE"),
    }),
  );
  app.post(GITHUB_MCP_PATH, (c) =>
    handleMcpPost(c.req.raw, { fetch: fetchFn, apiBase: env.githubApiBase, log: c.get("log") }, c.get("requestId")),
  );
  app.on(["GET", "DELETE", "PUT", "PATCH"], GITHUB_MCP_PATH, () => mcpMethodNotAllowed());

  app.notFound(notFoundHandler());
  app.onError(errorHandler({ logger: log }));

  return app;
}
