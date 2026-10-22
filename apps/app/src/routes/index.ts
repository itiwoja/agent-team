// ルートの一覧（app.ts が組み立てる）。次の担当は自分のモジュールを作り、ここに足す：
// - 画面の API（/api/v1/*）：(r: ApiRouter, deps) => void。r.get("/asks/:askId", handler) のように /v1 からの相対で書く。
//   既定はセッション必須＋状態を変えるメソッドの CSRF。外すときだけ { auth: "optional" | "none" }
// - 内部（/internal/*）：(r: Hono, deps) => void。sa-app の確認は app.ts が全体にかける

import type { Hono } from "hono";
import type { AppHonoEnv } from "../context.ts";
import type { AppDeps } from "../deps.ts";
import { agentRoutes } from "./agents.ts";
import { approvalRoutes } from "./approvals.ts";
import { connectRoutes } from "./connect.ts";
import { connectGithubRoutes } from "./connect-github.ts";
import { askRoutes } from "./asks.ts";
import { auditRoutes } from "./audit.ts";
import { checkRoutes } from "./check.ts";
import { internalRoutes } from "./internal.ts";
import type { ApiRouter } from "./router.ts";
import { sessionRoutes } from "./session.ts";
import { streamRoutes } from "./stream.ts";
import { taskFilesRoutes, taskRoutes } from "./tasks.ts";
import { packRoutes } from "./packs.ts";
import { workspaceRoutes } from "./workspace.ts";

export type ApiRouteModule = (r: ApiRouter, deps: AppDeps) => void;
export type InternalRouteModule = (r: Hono<AppHonoEnv>, deps: AppDeps) => void;

export const API_ROUTE_MODULES: readonly ApiRouteModule[] = [sessionRoutes, workspaceRoutes, auditRoutes, streamRoutes, approvalRoutes, checkRoutes, taskRoutes, askRoutes, agentRoutes, connectRoutes, connectGithubRoutes, taskFilesRoutes, packRoutes];
export const INTERNAL_ROUTE_MODULES: readonly InternalRouteModule[] = [internalRoutes];

export { apiRouter, type ApiHandler, type ApiRouter, type RouteAuth, type RouteOptions } from "./router.ts";
