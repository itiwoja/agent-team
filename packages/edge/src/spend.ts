// 費用の守り（BR-62：全体1日 $15。15:228）。decide の外（M-19）
// - checkSpend：Gemini を呼ぶたび、呼ぶ前に「使った額 ＋ 見積もり ＞ 上限」なら呼ばない（ちょうどは通す：decide の手順2と同じ）
// - canStartWork：タスク・依頼を始める前に「使った額 ≥ 上限」なら始めない（見積もりなし：M-38）
// 金額は整数のマイクロドルで比べる（cross-check §1.7）

import { AppError, secondsUntilTokyoDayEnd } from "@open-team/platform";
import { system, wsCtxOf, type Queryable, type Uuid, type WorkspaceKind, type WorkspaceRow } from "@open-team/db";
import { countActiveLiveTasks } from "@open-team/db/edge";
import { BUDGET_TIME_ZONE, SPEND_LIMITS, type SpendLimits } from "./limits.ts";

/** 止めた範囲（全体の1日の上限だけ） */
export type SpendScope = "global";

export interface SpendDenied {
  ok: false;
  scope: SpendScope;
  limitMicroUsd: number;
  spentMicroUsd: number;
  estimatedMicroUsd: number;
}
export type SpendCheck = { ok: true } | SpendDenied;

/** 費用を数える相手（タスクの外の呼び出し：設定プランナー・状況の生成も同じ） */
export interface SpendTarget {
  workspaceId: Uuid;
  workspaceKind: WorkspaceKind;
}

/** 全体の今日の費用（整数のマイクロドル） */
async function globalSpentOf(q: Queryable, now: Date): Promise<number> {
  return system.usdToMicro(await system.getPlatformDayCostUsd(q, now, BUDGET_TIME_ZONE));
}

/**
 * Gemini を呼ぶ前の確かめ（SO §3.12 checkSpend）。estimatedMicroUsd は呼ぶ前の見積もり（整数のマイクロドル）。
 * spent + est > limit で止める（ちょうど上限に届くのは通す）
 */
export async function checkSpend(
  q: Queryable,
  target: SpendTarget,
  estimatedMicroUsd: number,
  now: Date,
  limits: SpendLimits = SPEND_LIMITS,
): Promise<SpendCheck> {
  if (!Number.isSafeInteger(estimatedMicroUsd) || estimatedMicroUsd < 0) throw new RangeError(`見積もりは0以上の整数のマイクロドル：${estimatedMicroUsd}`);
  void target;
  const spent = await globalSpentOf(q, now);
  const limit = limits.platformDayMicroUsd;
  if (spent + estimatedMicroUsd > limit) return { ok: false, scope: "global", limitMicroUsd: limit, spentMicroUsd: spent, estimatedMicroUsd };
  return { ok: true };
}

export type StartDenyReason = "kill_switch" | "concurrency" | SpendScope;

/**
 * 始める前の確かめ（SO §3.12 canStartWork。タスク・FR-065 の1件・依頼）。
 * 1 Kill Switch → 始めない／2 そのワークスペースの provisioning・running の本番のタスクが max_concurrent_tasks 以上 → 待つ（BR-08）／
 * 3 全体の今日の費用 ≥ $15
 */
export async function canStartWork(
  q: Queryable,
  ws: Pick<WorkspaceRow, "id" | "kind" | "kill_switch_engaged" | "max_concurrent_tasks">,
  now: Date,
  limits: SpendLimits = SPEND_LIMITS,
): Promise<{ ok: true } | { ok: false; reason: StartDenyReason }> {
  if (ws.kill_switch_engaged) return { ok: false, reason: "kill_switch" };
  const active = await countActiveLiveTasks(q, wsCtxOf(ws));
  if (active >= ws.max_concurrent_tasks) return { ok: false, reason: "concurrency" };
  if ((await globalSpentOf(q, now)) >= limits.platformDayMicroUsd) return { ok: false, reason: "global" };
  return { ok: true };
}

/**
 * タスクの外の呼び出し（設定プランナー・状況の生成）で止めたときの API のエラー（M-38）：
 * 429 DAILY_BUDGET_EXCEEDED（details.scope：global。Retry-After は次の日の0時（Asia/Tokyo）まで）
 */
export function spendDeniedAppError(d: Pick<SpendDenied, "scope">, now: Date): AppError {
  return new AppError("DAILY_BUDGET_EXCEEDED", undefined, {
    details: { scope: d.scope },
    headers: { "Retry-After": String(Math.max(1, secondsUntilTokyoDayEnd(now))) },
  });
}
