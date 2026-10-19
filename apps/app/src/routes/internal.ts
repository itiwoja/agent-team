// 内部のエンドポイント（/internal/*。外からは届かない：sa-app の ID トークンだけ。SO §3.9、D-52、15:482）
// 認証は app.ts で /internal/* 全体にかける（platform の verifyServiceCaller(["sa-app"])。理由は返さず 403 FORBIDDEN）。
// - POST /internal/cron/tick（EP-47。毎分）
// - POST /internal/cron/cleanup-guests（EP-48。毎時。7日使われていないゲストのワークスペースと古い入口の記録を消す。
//   ついでに30日使われていないエージェントを removed にする）
// - POST /internal/setup/owner-workspace（G-08 のオーナーの初期投入。デプロイの後に CI か手で1回。冪等）
// EP-46（/internal/tasks/{taskId}/run）・G-02 の生成・リハーサルの入口は次の担当がここに足す

import { system } from "@open-team/db";
import { AppError } from "@open-team/platform";
import type { Hono } from "hono";
import type { AppHonoEnv } from "../context.ts";
import type { AppDeps } from "../deps.ts";
import { ensureOwnerWorkspace, OwnerSetupError } from "../owner-setup.ts";
import { runTick } from "../tick.ts";

export function internalRoutes(r: Hono<AppHonoEnv>, deps: AppDeps): void {
  r.post("/cron/tick", async (c) => c.json(await runTick(deps)));

  r.post("/cron/cleanup-guests", async (c) => {
    const started = performance.now();
    const res = await system.cleanupGuestWorkspaces(deps.maintDb, deps.clock.now());
    const body = {
      scanned: res.scanned,
      deleted: res.deleted.length,
      deferred: res.deferred.length,
      failed: res.failed.length,
      purged: res.purged,
    };
    deps.log.info("cleanup.guests", "ゲストの掃除をした", { ...body, latencyMs: Math.round(performance.now() - started) });
    // 失敗した1件ごとの理由はログだけに残す（応答には出さない）
    for (const f of res.failed) deps.log.error("cleanup.guest_failed", "ゲストの削除に失敗した", { workspaceId: f.workspaceId, error: f.error });
    // 使われないエージェントの片付けは ot_app の接続で（agents の更新はアプリの権限）。失敗してもゲストの掃除の結果は返す
    let agentsRemoved = 0;
    try {
      const agents = await system.removeUnusedAgents(deps.db, deps.clock.now());
      agentsRemoved = agents.removed.length;
      deps.log.info("cleanup.agents", "使われないエージェントを片付けた", { scanned: agents.scanned, removed: agentsRemoved, failed: agents.failed.length });
      for (const f of agents.failed) deps.log.error("cleanup.agent_failed", "エージェントの片付けに失敗した", { ...f });
    } catch (error) {
      deps.log.error("cleanup.agents_failed", "使われないエージェントの片付けに失敗した", { error });
    }
    return c.json({ ...body, agentsRemoved });
  });

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
