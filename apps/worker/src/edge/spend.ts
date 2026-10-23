// 費用の守り（BR-62。packages/edge/src/spend.ts・limits.ts の WorkspaceDO 版）。金額は整数のマイクロドルで比べる（cross-check §1.7）
// - checkSpend：LLM を呼ぶたび、呼ぶ前に「使った額 ＋ 見積もり ＞ 上限」なら呼ばない（ちょうどは通す）
// - canStartWork：タスク・依頼を始める前に「同時実行数 → 使った額 ≥ 上限」を見る（見積もりなし：M-38）
// 全体の今日の費用（全ワークスペースの合計）は D1 の側に置く（第5段）。それまでは、このワークスペースの今日の費用を全体の上限と比べる
// （使える人は ALLOWED_EMAILS の数人なので、全体の上限を1つのワークスペースで使い切ることはまずない）

import { AppError, secondsUntilTokyoDayEnd } from "@open-team/platform";
import { getWorkspaceDayCostMicroUsd } from "../db/repo/app.ts";
import { countActiveLiveTasks } from "../db/repo/edge.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { WorkspaceRow } from "../db/types.ts";

/** 全体1日 $15（BR-62。D-104・D-106。15:228。整数のマイクロドル） */
export const SPEND_LIMITS = {
  platformDayMicroUsd: 15_000_000,
} as const;

export type SpendLimits = { -readonly [K in keyof typeof SPEND_LIMITS]: number };

/** 費用の「1日」の区切り（M-59。すべてのワークスペースを Asia/Tokyo で数える） */
export const BUDGET_TIME_ZONE = "Asia/Tokyo";

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

export type StartDenyReason = "concurrency" | SpendScope;

/** 今日の費用（第5段までは、このワークスペースの分） */
export function spentTodayMicroUsd(db: WsDb, now: Date): number {
  return getWorkspaceDayCostMicroUsd(db, now, BUDGET_TIME_ZONE);
}

/** LLM を呼ぶ前の確かめ（SO §3.12 checkSpend）。estimatedMicroUsd は呼ぶ前の見積もり（整数のマイクロドル） */
export function checkSpend(db: WsDb, estimatedMicroUsd: number, now: Date, limits: SpendLimits = SPEND_LIMITS): SpendCheck {
  if (!Number.isSafeInteger(estimatedMicroUsd) || estimatedMicroUsd < 0) throw new RangeError(`見積もりは0以上の整数のマイクロドル：${estimatedMicroUsd}`);
  const spent = spentTodayMicroUsd(db, now);
  const limit = limits.platformDayMicroUsd;
  if (spent + estimatedMicroUsd > limit) return { ok: false, scope: "global", limitMicroUsd: limit, spentMicroUsd: spent, estimatedMicroUsd };
  return { ok: true };
}

/**
 * 始める前の確かめ（SO §3.12 canStartWork。タスク・依頼）。
 * 1 provisioning・running のタスクが max_concurrent_tasks 以上 → 待つ（BR-08）／2 今日の費用 ≥ 上限
 */
export function canStartWork(
  db: WsDb,
  ws: Pick<WorkspaceRow, "max_concurrent_tasks">,
  now: Date,
  limits: SpendLimits = SPEND_LIMITS,
): { ok: true } | { ok: false; reason: StartDenyReason } {
  if (countActiveLiveTasks(db) >= ws.max_concurrent_tasks) return { ok: false, reason: "concurrency" };
  if (spentTodayMicroUsd(db, now) >= limits.platformDayMicroUsd) return { ok: false, reason: "global" };
  return { ok: true };
}

/**
 * タスクの外の呼び出し（設定プランナーなど）で止めたときの API のエラー（M-38）：
 * 429 DAILY_BUDGET_EXCEEDED（details.scope：global。Retry-After は次の日の0時（Asia/Tokyo）まで）
 */
export function spendDeniedAppError(d: { scope: SpendScope }, now: Date): AppError {
  return new AppError("DAILY_BUDGET_EXCEEDED", undefined, {
    details: { scope: d.scope },
    headers: { "Retry-After": String(Math.max(1, secondsUntilTokyoDayEnd(now))) },
  });
}
