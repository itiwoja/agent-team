// app の組み立て（外から届く唯一のサービス：D-52）。/api/v1/*（画面の API）・/internal/*（sa-app だけ）・画面（apps/web のビルド）
// 順番（SO §3.3、AS §3.0）：
//   全体：セキュリティヘッダー（CSP など）→ X-Request-Id（サーバーで作る）→ 構造化ログ
//   /api：no-store → 本文 64KB（413）→ /api/health → 同一オリジンの JSON（403・415）→ 準備中（D-47）→ セッションの解決とローリング
//         → ルート（既定はセッション必須＋CSRF）→ 知らないパスは 404 の JSON
//   /internal：本文 64KB → sa-app の確認（403）→ ルート → 404 の JSON
//   画面：静的ファイル（/assets/ は1年の immutable、ほかは no-cache）、知らないパスは index.html（no-cache）。
//         /assets/ 配下と拡張子付きのパスが無いときは index.html でなく 404（古い index.html が無い JS を取りに来て白画面になるのを防ぐ）。
//         圧縮（hono/compress）は /assets/* と index.html の経路だけ（/api・/internal は上で必ず応答するので index.html にならない：SO §3.3）

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { GatewayClientError } from "@open-team/gateway-client";
import { AppError, errorHandler, errorResponse, notFoundHandler, requestContext } from "@open-team/platform";
import { isSimClientError } from "@open-team/sim-client";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import type { AppHonoEnv } from "./context.ts";
import type { AppDeps } from "./deps.ts";
import { API_BODY_LIMIT_BYTES, noStore, sameOriginJson, securityHeaders, sessionMiddleware, setupGuard } from "./http.ts";
import { sandboxRoutes } from "./routes/sandbox.ts";
import { API_ROUTE_MODULES, INTERNAL_ROUTE_MODULES, apiRouter, type ApiRouteModule, type InternalRouteModule } from "./routes/index.ts";

export interface CreateAppOptions {
  /** 既定は routes/index.ts の一覧 */
  apiRoutes?: readonly ApiRouteModule[];
  internalRoutes?: readonly InternalRouteModule[];
  /** 1リクエスト1行の http.request（既定 true） */
  accessLog?: boolean;
}

/** 外部の失敗を共通の形のエラーに直す（理由の内訳は応答に出さない） */
function mapError(err: unknown): AppError | undefined {
  if (isSimClientError(err)) return new AppError("SIM_WORLD_UNAVAILABLE", undefined, { cause: err });
  if (err instanceof GatewayClientError) return new AppError("INTERNAL_ERROR", "gateway の呼び出しに失敗しました", { cause: err });
  return undefined;
}

export function createApp(deps: AppDeps, opts: CreateAppOptions = {}): Hono<AppHonoEnv> {
  const app = new Hono<AppHonoEnv>();
  app.use("*", securityHeaders());
  app.use("*", requestContext({ logger: deps.log, accessLog: opts.accessLog ?? true }));
  app.onError(errorHandler({ logger: deps.log, mapError }));
  app.notFound(notFoundHandler());

  const limit = bodyLimit({ maxSize: API_BODY_LIMIT_BYTES, onError: (c) => errorResponse(c, "PAYLOAD_TOO_LARGE") });

  // ---- /api ----
  const api = new Hono<AppHonoEnv>();
  api.use("*", noStore);
  api.use("*", limit);
  // 準備中・セッションに関わらず答える（/healthz は使わない：SO C-26。版の照合：15:67）
  api.get("/health", (c) => c.json({ status: "ok", commit: deps.env.commitSha ?? null }));
  api.use("*", sameOriginJson);
  api.use("*", setupGuard(deps.missing));
  api.use("*", sessionMiddleware(deps));
  const router = apiRouter(api);
  for (const mod of opts.apiRoutes ?? API_ROUTE_MODULES) mod(router, deps);
  api.all("*", (c) => errorResponse(c, "NOT_FOUND"));
  app.route("/api", api);

  // ---- /sandbox（作業場の実行役だけ。作業場のトークンで確かめる：D-116）----
  app.route("/sandbox", sandboxRoutes(deps));

  // ---- /internal ----
  const internal = new Hono<AppHonoEnv>();
  internal.use("*", limit);
  internal.use("*", deps.serviceAuth.verifyServiceCaller(["sa-app"]));
  for (const mod of opts.internalRoutes ?? INTERNAL_ROUTE_MODULES) mod(internal, deps);
  internal.all("*", (c) => errorResponse(c, "NOT_FOUND"));
  app.route("/internal", internal);

  // ---- 画面（apps/web のビルド結果）----
  if (deps.env.webDist) {
    const root = deps.env.webDist;
    // 圧縮は画面の経路だけに掛ける。"/assets/*" は /api・/internal に合わず、index.html の経路は
    // そのハンドラにだけ付けるので、/api/*（SSE の /stream を含む）と /internal には掛からない。
    // compress は next() の後に応答を包むので、serveStatic より前に登録する
    app.use("/assets/*", compress());
    // 資産の Cache-Control は応答の後に付ける（@hono/node-server 2.1 の serveStatic は onFound を応答を作った後に呼ぶので、
    // onFound の中で c.header しても応答に乗らない）。成功の応答で、まだ無いときだけ（index.html は自分で付ける。404 には付けない）
    app.use("*", async (c, next) => {
      await next();
      if (c.res.ok && !c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", cacheControlOf(c.req.path));
    });
    app.use("*", serveStatic({ root }));
    app.get("*", compress(), async (c) => {
      // 画面の経路でないファイルの要求（/assets/ 配下・拡張子付き）は index.html を返さず 404 の JSON
      if (looksLikeStaticFile(c.req.path)) return c.notFound();
      c.header("Cache-Control", "no-cache");
      return c.html(await readFile(join(root, "index.html"), "utf8"));
    });
  }
  return app;
}

/** 画面の資産の Cache-Control：/assets/ は Vite のハッシュ付きなので1年の immutable、ほか（favicon など）は毎回確かめる */
export function cacheControlOf(path: string): string {
  return path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

/** 画面の経路でなくファイルの要求に見えるパス（/assets/ 配下、または最後の区切りに拡張子がある：.js .css .map .png .svg .ico など） */
export function looksLikeStaticFile(path: string): boolean {
  if (path.startsWith("/assets/")) return true;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return /^.+\.[A-Za-z0-9]{1,8}$/.test(last);
}
