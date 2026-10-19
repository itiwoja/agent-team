// sandbox-edge（/sandbox/v1。D-116）：作業場の実行役だけが呼ぶ口。セッション・CSRF ではなく、作業場のトークン（Bearer）で確かめる。
// 作業場は判定済みのコマンドを受け取り、結果とファイルの控えを返すだけ（LLM・Intent・ほかのタスクには届かない）

import { EdgeError } from "@open-team/runner";
import { errorResponse } from "@open-team/platform";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import type { AppHonoEnv } from "../context.ts";
import type { AppDeps } from "../deps.ts";

/** 控え（tar.gz 10MB）と少しの余裕 */
export const SANDBOX_BODY_LIMIT_BYTES = 11 * 1024 * 1024;

function bearer(c: Context): string {
  const h = c.req.header("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

/** edge のエラーを HTTP にする（理由の内訳は返さない） */
function edgeErrorStatus(e: unknown): 400 | 401 | 409 | null {
  if (!(e instanceof EdgeError)) return null;
  if (e.code === "UNAUTHORIZED") return 401;
  if (e.code === "TASK_HALTED") return 409;
  if (e.code === "VALIDATION_ERROR") return 400;
  return null;
}

export function sandboxRoutes(deps: Pick<AppDeps, "sandboxEdge">): Hono<AppHonoEnv> {
  const r = new Hono<AppHonoEnv>();
  r.use("*", bodyLimit({ maxSize: SANDBOX_BODY_LIMIT_BYTES, onError: (c) => errorResponse(c, "PAYLOAD_TOO_LARGE") }));
  r.onError((e, c) => {
    const status = edgeErrorStatus(e);
    if (status !== null) return c.json({ error: { code: (e as EdgeError).code } }, status);
    throw e;
  });
  const edge = () => deps.sandboxEdge;

  r.post("/v1/claim", async (c) => c.json(await edge().claim(bearer(c))));

  r.post("/v1/next", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { waitSec?: unknown };
    const waitSec = typeof body.waitSec === "number" ? body.waitSec : 20;
    return c.json(await edge().next(bearer(c), waitSec));
  });

  r.post("/v1/commands/:id/result", async (c) => {
    const ok = await edge().result(bearer(c), c.req.param("id"), await c.req.json().catch(() => null));
    return ok ? c.json({ ok: true }) : c.json({ error: { code: "NOT_FOUND" } }, 404);
  });

  r.put("/v1/archive", async (c) => {
    const buf = Buffer.from(await c.req.arrayBuffer());
    const files = Number(c.req.query("files") ?? "0");
    const bytes = Number(c.req.query("bytes") ?? "0");
    await edge().archive(bearer(c), buf, { files: Number.isFinite(files) ? Math.floor(files) : 0, bytes: Number.isFinite(bytes) ? Math.floor(bytes) : 0 });
    return c.json({ ok: true });
  });

  r.all("*", (c) => errorResponse(c, "NOT_FOUND"));
  return r;
}
