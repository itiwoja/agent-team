// 画面の API（/api/v1/*）のルートの登録の道具（apps/app/src/routes/router.ts・http.ts の WorkspaceDO 版の一部）。
// ルートごとにセッション必須（なければ 401 UNAUTHORIZED）、状態を変えるメソッド（POST・PUT・PATCH・DELETE）は CSRF も（403 CSRF_TOKEN_INVALID）。
// ルートごとに守りをかけるので、知らないパスはセッションがなくても 404 の JSON になる（index.ts の最後の catch-all。SO-INT-06）。
// エラーは AppError を投げ、index.ts の onError（@open-team/platform の errorHandler）が共通の形 { error: { code, message, details?, requestId } } にする

import { AppError, parseInput } from "@open-team/platform";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { csrfOk, type AppEnv } from "../auth/routes.ts";
import type { SessionCtx } from "../auth/session.ts";
import type { WorkspaceDO } from "../workspace-do.ts";

export type ApiHandler = (c: Context<AppEnv>) => Response | Promise<Response>;

export interface ApiRouter {
  get(path: string, handler: ApiHandler): void;
  post(path: string, handler: ApiHandler): void;
  put(path: string, handler: ApiHandler): void;
  patch(path: string, handler: ApiHandler): void;
  delete(path: string, handler: ApiHandler): void;
}

/** セッションがなければ 401 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.session === null) throw new AppError("UNAUTHORIZED");
  await next();
};

/** X-CSRF-Token がセッションのものと違えば 403（状態を変えるメソッドだけにかける） */
export const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!csrfOk(c)) throw new AppError("CSRF_TOKEN_INVALID");
  await next();
};

/** app にルートを足す道具。path は /v1 からの相対（例 "/asks" → /api/v1/asks） */
export function apiRouter(app: Hono<AppEnv>, prefix = "/api/v1"): ApiRouter {
  return {
    get: (path, h) => void app.get(`${prefix}${path}`, requireSession, h),
    post: (path, h) => void app.post(`${prefix}${path}`, requireSession, requireCsrf, h),
    put: (path, h) => void app.put(`${prefix}${path}`, requireSession, requireCsrf, h),
    patch: (path, h) => void app.patch(`${prefix}${path}`, requireSession, requireCsrf, h),
    delete: (path, h) => void app.delete(`${prefix}${path}`, requireSession, requireCsrf, h),
  };
}

/** ルートの中のセッション（requireSession のあとなので必ずある。なければ 401） */
export function sessionOf(c: Context<AppEnv>): SessionCtx {
  const s = c.var.session;
  if (s === null) throw new AppError("UNAUTHORIZED");
  return s;
}

/** セッションのワークスペースの DO（ワークスペースの ID の名前で引く。別のワークスペースのものには届かない） */
export function workspaceOf(c: Context<AppEnv>, s: SessionCtx): DurableObjectStub<WorkspaceDO> {
  return c.env.WORKSPACE.get(c.env.WORKSPACE.idFromName(s.workspaceId));
}

/** クエリを検証する（外れたら 400 VALIDATION_ERROR） */
export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parseInput(schema, c.req.query());
}

const IdParam = z.guid();

/** パスの ID（8-4-4-4-12 の16進でなければ 400）。小文字にそろえる */
export function idParam(c: Context, name: string): string {
  const v = c.req.param(name) ?? "";
  const r = IdParam.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: name, reason: "uuid の形ではありません" }] });
  return r.data.toLowerCase();
}
