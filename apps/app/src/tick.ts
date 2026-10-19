// EP-47 毎分の tick の骨組み（AS §3.16、G-02、DB §4.12）。Cloud Scheduler が sa-app の OIDC で POST /internal/cron/tick を呼ぶ。
// tick は取りこぼしの拾い直しだけ（承認の期限切れ・定期の依頼の起動・queued のタスクと走行・止まった generating と executing）。
// 中身の手順は担当ごとに deps.tickSteps に足す（intents・formation・rehearsal）。ここは順に動かして数を足し、1つの失敗でほかを止めない

import type { AppDeps, CronTickCounts } from "./deps.ts";

export const EMPTY_TICK_COUNTS: CronTickCounts = { dispatched: 0, expiredApprovals: 0, scheduled: 0, reRehearsals: 0 };

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
      total.reRehearsals += r.reRehearsals ?? 0;
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
