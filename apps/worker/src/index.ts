// Makase の Worker の入口（docs/cloudflare-design.md）。API は Hono。ワークスペースの状態は WorkspaceDO が持つ
// createApp は外への呼び出し（fetch）と時計を受け取る（試験で差し替える）。既定の export は本物を渡したもの
// 画面の API（/api/v1/*。routes/）のエラーは AppError を投げ、onError が apps/app と同じ共通の形の JSON にする

import { errorHandler } from "@open-team/platform";
import { Hono } from "hono";
import { authRoutes, sessionMiddleware, type AppEnv, type AuthDeps } from "./auth/routes.ts";
import { v1Routes } from "./routes/index.ts";

export { PlanAskWorkflow } from "./workflows/plan-ask.ts";
export { TaskRunWorkflow } from "./workflows/task-run.ts";
export { WorkspaceDO } from "./workspace-do.ts";

export function createApp(deps: AuthDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.use("/api/*", sessionMiddleware(deps));
  authRoutes(app, deps);
  v1Routes(app, deps);
  app.onError(errorHandler());
  return app;
}

const app = createApp({ fetch: (input, init) => fetch(input, init), now: () => new Date() });

export default app satisfies ExportedHandler<Env>;
