// 画面の API のルートの登録（/api/v1/*）。既定はセッション必須＋状態を変えるメソッドの CSRF（AS §3.0 の7・9、SO §3.8）。
// 守りを外すのはルートごとに auth を書いたものだけ（入口 EP-01 は none、EP-02 は optional）。
// ルートごとに守りをかけるので、知らないパスはセッションがなくても 404 の JSON になる（SO-INT-06：index.html にしない）

import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppHonoEnv } from "../context.ts";
import { requireCsrf, requireSession } from "../http.ts";

/** session＝セッション必須（状態を変えるメソッドは CSRF も）、optional＝あれば使う、none＝見ない */
export type RouteAuth = "session" | "optional" | "none";
export interface RouteOptions {
  auth?: RouteAuth;
}
export type ApiHandler = (c: Context<AppHonoEnv>) => Response | Promise<Response>;

export interface ApiRouter {
  get(path: string, handler: ApiHandler, opts?: RouteOptions): void;
  post(path: string, handler: ApiHandler, opts?: RouteOptions): void;
  put(path: string, handler: ApiHandler, opts?: RouteOptions): void;
  patch(path: string, handler: ApiHandler, opts?: RouteOptions): void;
  delete(path: string, handler: ApiHandler, opts?: RouteOptions): void;
}

/** api（/api に載せる Hono）にルートを足す道具。path は /v1 からの相対（例 "/me" → /api/v1/me） */
export function apiRouter(api: Hono<AppHonoEnv>, prefix = "/v1"): ApiRouter {
  const guards = (opts: RouteOptions = {}): MiddlewareHandler<AppHonoEnv>[] => {
    const auth = opts.auth ?? "session";
    return auth === "session" ? [requireSession, requireCsrf] : [];
  };
  const add =
    (method: "get" | "post" | "put" | "patch" | "delete") =>
    (path: string, handler: ApiHandler, opts?: RouteOptions): void => {
      // Hono の型の重ね合わせは配列の展開を受けないので、ここだけ形を緩める（中身は MiddlewareHandler と handler の並び）
      const register = api[method] as (p: string, ...h: Array<MiddlewareHandler<AppHonoEnv> | ApiHandler>) => unknown;
      register.call(api, `${prefix}${path}`, ...guards(opts), handler);
    };
  return { get: add("get"), post: add("post"), put: add("put"), patch: add("patch"), delete: add("delete") };
}
