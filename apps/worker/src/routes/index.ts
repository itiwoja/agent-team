// 画面の API（/api/v1/*）のルートをまとめて登録する。最後に知らない /api/v1/* を 404 の JSON にする（セッションの有無を問わない）

import { errorResponse } from "@open-team/platform";
import type { Hono } from "hono";
import type { AppEnv } from "../auth/routes.ts";
import { agentRoutes } from "./agents.ts";
import { askRoutes } from "./asks.ts";
import { apiRouter, type ApiDeps } from "./router.ts";

export function v1Routes(app: Hono<AppEnv>, deps: ApiDeps): void {
  const r = apiRouter(app);
  agentRoutes(r);
  askRoutes(r, deps);
  app.all("/api/v1/*", (c) => errorResponse(c, "NOT_FOUND"));
}
