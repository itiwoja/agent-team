// リハーサルの費用（BR-62：1回 $3 まで。D-106）。金額は整数のマイクロドル（LlmResponse.usage.costMicroUsd と同じ）
import { SPEND_LIMITS } from "@open-team/edge";

// 純粋関数。上限を超えたかどうかの判定だけで、止める処理は呼び出し側（新しい実行を始めない）

/** リハーサル1回の費用の上限 $3（BR-62・D-106。edge の SPEND_LIMITS と同じ値を使う） */
export const REHEARSAL_BUDGET_MICRO_USD: number = SPEND_LIMITS.rehearsalRunMicroUsd;

/** 費用の足し算（マイクロドル）。整数でない・負の値は例外（費用の数え間違いを黙って通さない） */
export function addCosts(...costs: readonly number[]): number {
  let total = 0;
  for (const c of costs) {
    if (!Number.isSafeInteger(c) || c < 0) throw new RangeError(`費用は 0 以上の整数のマイクロドルにする：${String(c)}`);
    total += c;
  }
  return total;
}

/**
 * 累計が上限を超えたら true（ちょうど上限は超えていない）。
 * 累計・上限が壊れた値（整数でない・負）なら true（締める側：止める）。limit の既定は $3
 */
export function exceedsRehearsalBudget(totalMicroUsd: number, limitMicroUsd: number = REHEARSAL_BUDGET_MICRO_USD): boolean {
  if (!Number.isSafeInteger(totalMicroUsd) || totalMicroUsd < 0) return true;
  if (!Number.isSafeInteger(limitMicroUsd) || limitMicroUsd < 0) return true;
  return totalMicroUsd > limitMicroUsd;
}

/** 呼び出し側から渡す費用の枠（このリハーサルで、ここまでに使った分と上限） */
export interface BudgetInput {
  /** この走行でここまでに使った費用（既定 0） */
  spentMicroUsd?: number;
  /** 上限（既定 $3） */
  limitMicroUsd?: number;
}
