// 内部のエンドポイント（/internal/*。共有トークン（INTERNAL_SHARED_TOKEN）だけ。D-52、15:482）
// 認証は app.ts で /internal/* 全体にかける（platform の verifyServiceCaller(["sa-app"])。理由は返さず 403 FORBIDDEN）。
// - POST /internal/cron/tick（EP-47。毎分。server.ts のタイマーも同じ処理を呼ぶ）
// - POST /internal/cron/cleanup-guests（EP-48。毎時。server.ts のタイマーも同じ処理を呼ぶ。7日使われていないゲストのワークスペースと古い入口の記録を消す。
//   ついでに30日使われていないエージェントを removed にする）
// - POST /internal/setup/owner-workspace（G-08 のオーナーの初期投入。起動の後に手で1回。server.ts も起動時に試す。冪等）
// EP-46（/internal/tasks/{taskId}/run）・G-02 の生成・リハーサルの入口は次の担当がここに足す

import { AppError } from "@open-team/platform";
import type { Hono } from "hono";
import type { AppHonoEnv } from "../context.ts";
import type { AppDeps } from "../deps.ts";
import { ensureOwnerWorkspace, OwnerSetupError } from "../owner-setup.ts";
import { runGuestCleanup, runTick } from "../tick.ts";

export function internalRoutes(r: Hono<AppHonoEnv>, deps: AppDeps): void {
  r.post("/cron/tick", async (c) => c.json(await runTick(deps)));

  r.post("/cron/cleanup-guests", async (c) => c.json(await runGuestCleanup(deps)));

  r.post("/setup/owner-workspace", async (c) => {
    try {
      return c.json(await ensureOwnerWorkspace(deps));
    } catch (e) {
      if (e instanceof OwnerSetupError) {
        deps.log.error("owner_setup.failed", e.message, { step: e.step, error: e.cause ?? e });
        // sim-world に届かないときは 503 SIM_WORLD_UNAVAILABLE、それ以外は 500（止まった手順だけ返す。原因はログ）
        throw new AppError(e.step === "demo_store" ? "SIM_WORLD_UNAVAILABLE" : "INTERNAL_ERROR", e.message, { details: { step: e.step }, cause: e });
      }
      throw e;
    }
  });
}
