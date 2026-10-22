// EP-47 毎分の tick の骨組み（AS §3.16、G-02、DB §4.12）。server.ts のタイマーが毎分これを呼ぶ（POST /internal/cron/tick でも手で呼べる）。
// tick は取りこぼしの拾い直しだけ（承認の期限切れ・定期の依頼の起動・queued のタスクと走行・止まった generating と executing）。
// 中身の手順は担当ごとに deps.tickSteps に足す（intents・formation・evolution）。ここは順に動かして数を足し、1つの失敗でほかを止めない

import { system } from "@open-team/db";
import type { AppDeps, CronTickCounts } from "./deps.ts";

export const EMPTY_TICK_COUNTS: CronTickCounts = { dispatched: 0, expiredApprovals: 0, scheduled: 0 };

/** 手順は1つずつ順に（DB の接続は2本：SO §4.6）。失敗はログに残して次へ */
export async function runTick(deps: Pick<AppDeps, "tickSteps" | "log" | "clock"> & AppDeps, now: Date = deps.clock.now()): Promise<CronTickCounts> {
  const total: CronTickCounts = { ...EMPTY_TICK_COUNTS };
  for (const step of deps.tickSteps) {
    const started = performance.now();
    try {
      const r = await step.run(deps, now);
      total.dispatched += r.dispatched ?? 0;
      total.expiredApprovals += r.expiredApprovals ?? 0;
      total.scheduled += r.scheduled ?? 0;
    } catch (error) {
      deps.log.error("tick.step_failed", `tick の手順が失敗した：${step.name}`, {
        step: step.name,
        latencyMs: Math.round(performance.now() - started),
        error,
      });
    }
  }
  return total;
}

/**
 * EP-48 掃除（毎時）。24時間より古い入口の試行・冪等性のキー・SSE の事象を消し（ot_retention の接続）、
 * 30日使われていないエージェントを removed にする（ot_app の接続）
 */
export async function runCleanup(deps: AppDeps) {
  const started = performance.now();
  const purged = await system.purgeExpiredRows(deps.maintDb, deps.clock.now());
  deps.log.info("cleanup.purged", "古い記録を消した", { ...purged, latencyMs: Math.round(performance.now() - started) });
  // 使われないエージェントの片付けは ot_app の接続で（agents の更新はアプリの権限）。失敗しても古い記録の掃除の結果は返す
  let agentsRemoved = 0;
  try {
    const agents = await system.removeUnusedAgents(deps.db, deps.clock.now());
    agentsRemoved = agents.removed.length;
    deps.log.info("cleanup.agents", "使われないエージェントを片付けた", { scanned: agents.scanned, removed: agentsRemoved, failed: agents.failed.length });
    for (const f of agents.failed) deps.log.error("cleanup.agent_failed", "エージェントの片付けに失敗した", { ...f });
  } catch (error) {
    deps.log.error("cleanup.agents_failed", "使われないエージェントの片付けに失敗した", { error });
  }
  return { purged, agentsRemoved };
}
