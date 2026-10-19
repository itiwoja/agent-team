// リハーサルの費用の守り（BR-62：1回 $3）。走行ごとの費用の集計と、新しい走行を始めてよいかの確かめ。
// 実際に Gemini を呼ぶたびの確かめ（checkSpend）は edge が持つ。ここは「状況を1件始める前」の確かめで、同じ仕組み（edge の canStartWork：
// Kill Switch・全体 $15・ゲスト $4・走行 $3）に、cost.ts の上限（呼び出し側が持つ累計との比較）を足す

import { getWorkspace, system, type Db, type Uuid, type WsCtx } from "@open-team/db";
import { sumRehearsalRunCostUsd } from "@open-team/db/edge";
import { sumTaskCostMicroUsd } from "@open-team/db/rehearsal";
import { SPEND_LIMITS, canStartWork, type SpendLimits } from "@open-team/edge";
import { addCosts, exceedsRehearsalBudget, type BudgetInput } from "./cost.ts";

/** 走行のここまでの費用（マイクロドル。usage_records の合計＝edge が上限の確かめに使うのと同じ値） */
export async function runCostMicroUsd(db: Db, ctx: WsCtx, runId: Uuid): Promise<number> {
  return system.usdToMicro(await sumRehearsalRunCostUsd(db, ctx, runId));
}

/** タスクの費用の合計（tasks.cost_usd。状況1件の費用の集計に使う） */
export async function tasksCostMicroUsd(db: Db, ctx: WsCtx, taskIds: readonly Uuid[]): Promise<number> {
  return sumTaskCostMicroUsd(db, ctx, taskIds);
}

/** マイクロドル → '0.012345'（小数6桁。rehearsal_scenarios.cost_usd・rehearsal_runs.cost_usd。db の system と同じ） */
export const microToUsd = system.microToUsd;

export type StartDenied = "budget" | "kill_switch";

/**
 * 新しい走行（状況1件）を始めてよいか。次のどれかなら始めない（安全側：締める）：
 * - Kill Switch の発動中
 * - DB の走行の費用が上限以上（edge の canStartWork：使った額 ≥ 上限）、全体・ゲストの1日の上限
 * - 呼び出し側の累計（budget.spentMicroUsd）が上限（budget.limitMicroUsd。既定 $3）を超えた（cost.ts の exceedsRehearsalBudget。壊れた値も止める）
 * 累計は DB の値と呼び出し側の値の大きいほうで見る（どちらかが少なく数えても止め損なわない）
 */
export async function canStartCase(
  db: Db,
  ctx: WsCtx,
  runId: Uuid,
  now: Date,
  o: { budget?: BudgetInput; spendLimits?: Partial<SpendLimits> } = {},
): Promise<{ ok: true; spentMicroUsd: number } | { ok: false; reason: StartDenied; spentMicroUsd: number }> {
  const spent = addCosts(Math.max(await runCostMicroUsd(db, ctx, runId), o.budget?.spentMicroUsd ?? 0));
  if (exceedsRehearsalBudget(spent, o.budget?.limitMicroUsd ?? o.spendLimits?.rehearsalRunMicroUsd)) return { ok: false, reason: "budget", spentMicroUsd: spent };
  const ws = await getWorkspace(db, ctx);
  if (ws === null) throw new Error(`ワークスペースがない：${ctx.workspaceId}`);
  const r = await canStartWork(db, ws, { rehearsalRunId: runId }, now, { ...SPEND_LIMITS, ...o.spendLimits });
  if (!r.ok) return { ok: false, reason: r.reason === "kill_switch" ? "kill_switch" : "budget", spentMicroUsd: spent };
  return { ok: true, spentMicroUsd: spent };
}
