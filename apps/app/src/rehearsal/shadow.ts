// 影の判定の走らせ方と「防いだ損害」（FR-044・BR-67・D-40・D-76）。純粋な関数だけ。
// 影の走行は最初の生成の状況にだけ行う（15:162）。適応で作り直した状況・再試験・再リハーサルでは行わず、最初の影の損害は試験に残す
// （rehearsal_cases.first_shadow_damage_jpy：G-10）。呼び出し側は runRehearsalCase の withShadow で選ぶ（既定の選び方は shouldRunShadow）。
// 防いだ損害は packages/rehearsal の damage の関数（max(0, 影 − 本番)）をそのまま使い、式を重ねて持たない

import type { CaseSource, RunTrigger } from "@open-team/db";
import { damageRowOf, preventedForRow, totalPreventedDamageJpy } from "@open-team/rehearsal";
import type { ScenarioResult } from "@open-team/sim-core";

/** 最初の走行（初回・手動・シード・自分の言葉の1件）。再試験・再リハーサル・モデルの比較は含めない */
const FIRST_RUN_TRIGGERS: ReadonlySet<RunTrigger> = new Set<RunTrigger>(["initial", "manual", "seed", "user_case"]);

export interface ShadowChoiceInput {
  trigger: RunTrigger;
  /** 適応で状況を作り直した回（0 が最初の生成） */
  adaptRound: number;
  caseSource: CaseSource;
  /** 試験に最初の影の損害がすでにある（もう走らせた） */
  hasFirstShadow: boolean;
}

/**
 * 影の走行をするか。次のすべてを満たすときだけ（安全側：迷ったら走らせない＝費用を使わない）：
 * 最初の走行の始まり方・適応の0回目・生成か自分の言葉の試験（incident は本番で起きたことの再生なので影にしない）・まだ影を走らせていない
 */
export function shouldRunShadow(i: ShadowChoiceInput): boolean {
  return FIRST_RUN_TRIGGERS.has(i.trigger) && i.adaptRound === 0 && (i.caseSource === "generated" || i.caseSource === "user") && !i.hasFirstShadow;
}

/** 状況1件の防いだ損害 ＝ max(0, 影 − 本番の経路)。影も残した値もなければ null（packages/rehearsal の preventedForRow） */
export function preventedOf(result: Pick<ScenarioResult, "caseId" | "outcome" | "stoppedBy" | "governed" | "shadow">, carriedShadowJpy: number | null = null): number | null {
  const row = damageRowOf(result);
  if (row.shadow === null && carriedShadowJpy !== null) return preventedForRow({ ...row, shadow: { totalJpy: carriedShadowJpy, harmed: carriedShadowJpy > 0 } });
  return preventedForRow(row);
}

/** 走行全体で防いだ損害（状況ごとの合計。影のない状況は足さない） */
export function totalPrevented(results: ReadonlyArray<Pick<ScenarioResult, "caseId" | "outcome" | "stoppedBy" | "governed" | "shadow">>): number {
  return totalPreventedDamageJpy(results.map(damageRowOf));
}
