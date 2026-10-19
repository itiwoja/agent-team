// sim-world の Hono のアプリ（15:272「状態を持つ MCP サーバー」、sim-world-rehearsal.md §4.1、M-44）
// /mcp/<world>/<service>（MCP。sa-gateway だけ）と /admin/v1/*（管理 API。sa-app だけ）。保存・時刻・ID・呼び出し元の確認は差し込む。
// リクエスト ID・ログ・呼び出し元の確認は packages/platform のミドルウェア（requestContext・verifyServiceCaller）

import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createServiceAuth, loggerOf, requestContext, type ServiceAuth } from "@open-team/platform";
import { adminRoutes } from "./admin.ts";
import { SIM_OPERATIONS, allowedCallersOf, serviceAuthConfigOf, type SimOperation } from "./auth.ts";
import type { SimWorldHonoEnv } from "./context.ts";
import type { SimWorldEnv } from "./env.ts";
import { SimHttpError, errorBody } from "./errors.ts";
import { silentLogger, type Logger } from "./log.ts";
import { handleMcpPost, mcpMethodNotAllowed } from "./mcp.ts";
import { MemorySimStore } from "./memory-store.ts";
import { SimStoreInUseError, SimStoreReferenceError, type SimStore, type SimStoreReference } from "./store.ts";
import { DEFAULT_WORLDS, type WorldRegistry } from "./worlds.ts";

export interface SimWorldDeps {
  /** 既定はメモリ（ローカル・試験）。server.ts は DATABASE_URL があれば Postgres（open-store.ts） */
  store?: SimStore;
  /** 動く世界（既定は sim-core の shop） */
  worlds?: WorldRegistry;
  /** 実時刻（作成・更新の時刻、デモ店舗の1日目の既定）。仮想の時計は世界の状態が持つ */
  now?: () => Date;
  newId?: () => string;
  /** 呼び出し元の確認（packages/platform）。省略は env から createServiceAuth で作る */
  serviceAuth?: ServiceAuth;
  log?: Logger;
}

/** 本文の上限（SO §2.1 の apiBodyLimitBytes と同じ。sim-world の引数・状況はこれより十分小さい） */
export const BODY_LIMIT_BYTES = 64 * 1024;

/** 管理 API のパスから操作名（authorizeSimCaller の表で呼び出し元を決める） */
export function adminOperationOf(method: string, path: string): SimOperation {
  const p = path.replace(/^\/admin\/v1/, "");
  if (method === "DELETE" && p.startsWith("/workspaces/")) return "admin_cleanup";
  if (p === "/snapshots") return "admin_snapshot";
  if (p === "/demo-store") return "admin_demo_store";
  if (p.endsWith("/fork")) return "admin_fork";
  if (p.endsWith("/advance")) return "admin_advance";
  if (p.endsWith("/damage")) return "admin_damage";
  if (p.endsWith("/web")) return "admin_web";
  if (method === "POST" && p === "/executions") return "admin_create";
  return "admin_view";
}

const REFERENCE_LABEL: Record<SimStoreReference, string> = {
  workspace: "ワークスペース",
  rehearsal_run: "リハーサルの走行",
  execution: "走行",
  snapshot: "スナップショット",
};

export function createApp(env: SimWorldEnv, deps: SimWorldDeps = {}) {
  const store = deps.store ?? new MemorySimStore();
  const worlds = deps.worlds ?? DEFAULT_WORLDS;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? silentLogger;
  const auth = deps.serviceAuth ?? createServiceAuth(serviceAuthConfigOf(env), { log });

  const app = new Hono<SimWorldHonoEnv>();

  // リクエスト ID（来た x-request-id は形が合えば引き継ぐ：内部のサービス）とリクエストの Logger（Bearer などをマスク）
  app.use("*", requestContext({ logger: log, acceptIncoming: true }));

  // /api/health も同じ（SO §4.1）
  const health = { status: "ok", service: "sim-world", commit: env.commitSha ?? null } as const;
  app.get("/healthz", (c) => c.json(health));
  app.get("/api/health", (c) => c.json(health));

  // 呼び出し元の確認（SO §3.11 の表を操作ごとに）。外れたら 403 FORBIDDEN、理由はログ internal_auth.denied にだけ（SO §3.9）
  const verifyByOperation = new Map(SIM_OPERATIONS.map((op) => [op, auth.verifyServiceCaller(allowedCallersOf(op))] as const));
  const requireCaller =
    (opOf: (method: string, path: string) => SimOperation): MiddlewareHandler<SimWorldHonoEnv> =>
    (c, next) => {
      const verify = verifyByOperation.get(opOf(c.req.method, c.req.path));
      if (!verify) throw new Error("操作の呼び出し元の表がない");
      return verify(c, next);
    };

  const limit = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", "本文が大きすぎます", c.get("requestId")), 413),
  });

  // ---- MCP（/mcp/<world>/<service>。M-44：サービスごと）----
  app.use("/mcp/*", requireCaller(() => "mcp"), limit);
  app.post("/mcp/:world/:service", (c) =>
    handleMcpPost(
      c.req.raw,
      { world: c.req.param("world"), service: c.req.param("service") },
      { store, worlds, now, log: c.get("log") },
      c.get("requestId"),
    ),
  );
  app.on(["GET", "DELETE", "PUT", "PATCH"], "/mcp/:world/:service", () => mcpMethodNotAllowed());

  // ---- 管理 API（/admin/v1/*）----
  app.use("/admin/v1/*", requireCaller(adminOperationOf), limit, async (c, next) => {
    if (c.req.method === "POST" && !/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
      return c.json(errorBody("UNSUPPORTED_MEDIA_TYPE", "本文は application/json", c.get("requestId")), 415);
    }
    await next();
  });
  app.route("/admin/v1", adminRoutes({ store, worlds, now, newId, log }));

  app.notFound((c) => c.json(errorBody("NOT_FOUND", "見つかりません", c.get("requestId")), 404));
  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "-";
    if (err instanceof SimHttpError) return c.json(errorBody(err.code, err.message, requestId, err.details), err.status);
    // Postgres の保存の制約（メモリの保存は投げない）：参照先がない → 404、試験が使っているスナップショット → 409
    if (err instanceof SimStoreReferenceError) {
      return c.json(errorBody("NOT_FOUND", `${REFERENCE_LABEL[err.reference]}が見つかりません`, requestId), 404);
    }
    if (err instanceof SimStoreInUseError) {
      return c.json(errorBody("SNAPSHOT_IN_USE", "試験が参照しているスナップショットがあるので消せません", requestId), 409);
    }
    loggerOf(c, log).error("sim.error", err instanceof Error ? err.message : String(err), { path: c.req.path });
    return c.json(errorBody("INTERNAL_ERROR", "sim-world の内部エラー", requestId), 500);
  });

  return app;
}
