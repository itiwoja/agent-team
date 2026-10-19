// 状況の行の表示（結果の画面と自分の悪い日が共有する。route から切り離して循環を避ける）

import type { RehearsalScenarioRow } from "@open-team/db";
import type { OracleId, OracleVerdict } from "@open-team/sim-core";
import { damageBreakdownView } from "./damage-view.ts";
import { failedOraclesOf } from "./judge.ts";

/** fail のオラクル（どの分岐で落ちたか・決まった文つき）。rejected = 却下した場合（統制あり）、approved = 承認した場合 */
export interface FailedOracleView {
  oracle: OracleId;
  branch: "rejected" | "approved";
  details: string[];
}

function verdictsOf(raw: unknown): OracleVerdict[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is OracleVerdict => typeof v === "object" && v !== null && typeof (v as { oracle?: unknown }).oracle === "string" && typeof (v as { status?: unknown }).status === "string");
}

function branchesOf(raw: unknown): { rejected: unknown; approved: unknown } {
  const b = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { rejected: b.rejected ?? null, approved: b.approved ?? null };
}

/** fail のオラクルの一覧（judge.ts の failedOraclesOf と同じ集計）。branch_results の rejected・approved の順 */
export function failedOraclesView(branchResults: unknown): FailedOracleView[] {
  const b = branchesOf(branchResults);
  const out: FailedOracleView[] = [];
  for (const [branch, raw] of [["rejected", b.rejected], ["approved", b.approved]] as const) {
    const verdicts = verdictsOf(raw);
    for (const id of failedOraclesOf(verdicts)) {
      const v = verdicts.find((x) => x.oracle === id && x.status === "fail");
      out.push({ oracle: id, branch, details: (v?.failures ?? []).map((f) => f.detail) });
    }
  }
  return out;
}

/** 状況の行（結果の画面。式と元の値は damageBreakdown で開ける） */
export function rehearsalScenarioView(r: RehearsalScenarioRow) {
  return {
    id: r.id,
    caseId: r.case_id,
    ordinal: r.ordinal,
    status: r.status,
    abortReason: r.abort_reason,
    faultIds: r.fault_ids,
    verdict: r.verdict,
    stoppedBy: r.stopped_by,
    stoppedByDecision: r.stopped_by_decision,
    stoppedByReasonCode: r.stopped_by_reason_code,
    stoppedByRule: r.stopped_by_rule,
    damageJpy: r.damage_jpy,
    withoutControlDamageJpy: r.shadow_damage_jpy,
    preventedDamageJpy: r.prevented_damage_jpy,
    // 式と元の値（形は rehearsal/damage-view.ts の DamageBreakdownView。BR-79）。統制なし（影）の分は withoutControlDamageBreakdown
    damageBreakdown: damageBreakdownView(r.damage_breakdown),
    withoutControlDamageBreakdown: damageBreakdownView(r.shadow_damage_breakdown),
    interpretation: r.interpretation,
    costUsd: r.cost_usd,
    error: r.error,
    // 追加：なぜ fail か（保存済みの値の表示だけ。判定は変えない）
    oracleResults: r.oracle_results,
    branchResults: { rejected: branchesOf(r.branch_results).rejected, approved: branchesOf(r.branch_results).approved },
    approveBranchDamageJpy: r.approve_branch_damage_jpy,
    approveBranchDamageBreakdown: damageBreakdownView(r.approve_branch_damage_breakdown),
    failedOracles: failedOraclesView(r.branch_results),
  };
}
