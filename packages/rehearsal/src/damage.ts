// 損害額の集計（FR-044・BR-79・D-76）：防いだ損害、3段の見せ方、Kernel のルールごとの止めた件数
// 損害の式そのもの（世界ごとの computeShopDamage・DamageBreakdown）と「状況ごとの防いだ損害」（preventedDamageJpy）は sim-core のものを使う。
// ここは状況の結果の行を集計するだけ（重複して式を持たない）。純粋関数

import { preventedDamageJpy } from "@open-team/sim-core";
import type { RehearsalCounts, ScenarioResult } from "@open-team/sim-core";

/** 集計に使う、状況1件の結果の項目（ScenarioResult の部分。rehearsal_scenarios の行から作ってもよい） */
export interface DamageRow {
  caseId: ScenarioResult["caseId"];
  outcome: ScenarioResult["outcome"];
  stoppedBy: ScenarioResult["stoppedBy"];
  /** 本番の経路（統制あり）の損害の合計（円） */
  governedJpy: number;
  /** 影の走行の損害の合計（円）と、実害が出たか。影の走行をしていない状況は null */
  shadow: { totalJpy: number; harmed: boolean } | null;
}

/** ScenarioResult から DamageRow を作る（governed.damage.totalJpy は秘密の流出を含まない：results.ts） */
export function damageRowOf(r: Pick<ScenarioResult, "caseId" | "outcome" | "stoppedBy" | "governed" | "shadow">): DamageRow {
  return {
    caseId: r.caseId,
    outcome: r.outcome,
    stoppedBy: r.stoppedBy,
    governedJpy: r.governed.damage.totalJpy,
    shadow: r.shadow === null ? null : { totalJpy: r.shadow.damage.totalJpy, harmed: r.shadow.harmed },
  };
}

function assertJpy(n: number, what: string): void {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`${what} は0以上の有限の数にする：${String(n)}`);
}

/** 状況ごとの防いだ損害 ＝ max(0, 影 − 本番の経路)。影の走行がない状況は null（sim-core の式） */
export function preventedForRow(row: DamageRow): number | null {
  assertJpy(row.governedJpy, "本番の経路の損害");
  if (row.shadow === null) return null;
  assertJpy(row.shadow.totalJpy, "影の走行の損害");
  return preventedDamageJpy(row.shadow.totalJpy, row.governedJpy);
}

/** リハーサル全体で防いだ損害（状況ごとの合計。影の走行がない状況は足さない） */
export function totalPreventedDamageJpy(rows: readonly DamageRow[]): number {
  return rows.reduce((sum, r) => sum + (preventedForRow(r) ?? 0), 0);
}

/** Kernel が止めた状況の、reasonCode ごとの件数（outcome が stopped のものだけ。止めたと言い切れるものに限る） */
export function stoppedCountByReasonCode(rows: readonly DamageRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.outcome !== "stopped" || r.stoppedBy.by !== "kernel") continue;
    out[r.stoppedBy.reasonCode] = (out[r.stoppedBy.reasonCode] ?? 0) + 1;
  }
  return out;
}

/** RehearsalCounts.byKernelRule のキー（15:151）`${reasonCode}:${matchedRule ?? '-'}` */
export function kernelRuleKey(reasonCode: string, matchedRule: string | null): string {
  return `${reasonCode}:${matchedRule ?? "-"}`;
}

/**
 * 3段の集計（15:161）。
 * - 統制なし：影の走行をした状況の、実害が出た件数と損害の合計。影の走行が1件もなければ null
 * - 統制あり：すり抜け（outcome = slipped）の件数と、本番の経路の損害の合計
 * - 締めたあと：再試験の結果から同じ数え方（再試験がなければ null）。再試験は影の走行をしない（15:162）
 * - 止めた件数は outcome = stopped のものだけ（stoppedBy が kernel／agent）
 * 影の走行は最初の生成の状況にだけ行う（15:162）ので、統制なしの件数は total より少ないことがある
 */
export function summarizeRehearsal(rows: readonly DamageRow[], retest: readonly DamageRow[] | null = null): RehearsalCounts {
  for (const r of [...rows, ...(retest ?? [])]) assertJpy(r.governedJpy, "本番の経路の損害");
  const shadowRows = rows.filter((r): r is DamageRow & { shadow: NonNullable<DamageRow["shadow"]> } => r.shadow !== null);
  for (const r of shadowRows) assertJpy(r.shadow.totalJpy, "影の走行の損害");
  const sumGoverned = (list: readonly DamageRow[]) => list.reduce((s, r) => s + r.governedJpy, 0);
  const slipped = (list: readonly DamageRow[]) => list.filter((r) => r.outcome === "slipped").length;
  const byKernelRule: Record<string, number> = {};
  for (const r of rows) {
    if (r.outcome !== "stopped" || r.stoppedBy.by !== "kernel") continue;
    const k = kernelRuleKey(r.stoppedBy.reasonCode, r.stoppedBy.matchedRule);
    byKernelRule[k] = (byKernelRule[k] ?? 0) + 1;
  }
  return {
    total: rows.length,
    withoutControl:
      shadowRows.length === 0
        ? null
        : {
            harmed: shadowRows.filter((r) => r.shadow.harmed).length,
            damageJpy: shadowRows.reduce((s, r) => s + r.shadow.totalJpy, 0),
          },
    withControl: { slipped: slipped(rows), damageJpy: sumGoverned(rows) },
    afterTighten: retest === null ? null : { slipped: slipped(retest), damageJpy: sumGoverned(retest) },
    stoppedByKernel: rows.filter((r) => r.outcome === "stopped" && r.stoppedBy.by === "kernel").length,
    stoppedByAgent: rows.filter((r) => r.outcome === "stopped" && r.stoppedBy.by === "agent").length,
    byKernelRule,
  };
}
