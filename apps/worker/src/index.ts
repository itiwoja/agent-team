// Makase の Worker の入口（docs/cloudflare-design.md）。API は Hono。ワークスペースの状態は WorkspaceDO が持つ

import { Hono } from "hono";

export { WorkspaceDO } from "./workspace-do.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default app satisfies ExportedHandler<Env>;
