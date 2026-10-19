// リハーサルの報告（15「処理の流れ」7・15:161）：見出しの1文と、3段（統制なし／統制あり／締めたあと）の件数・損害額、
// 止めたものの区別（Kernel＝決定論／エージェント自身＝揺れる）を、走行の行から組み立てる。純粋関数（I/O・LLM・時刻・乱数なし）。
// 数字は packages/rehearsal の summarizeRehearsal・totalPreventedDamageJpy をそのまま使い、ここで式を重ねて持たない
// （画面の数字と走行の行（rehearsal_scenarios・rehearsal_runs）が食い違わないように）

import type { RehearsalScenarioRow } from "@open-team/db";
import { summarizeRehearsal, totalPreventedDamageJpy, type DamageRow } from "@open-team/rehearsal";
import type { RehearsalCounts } from "@open-team/sim-core";
import { damageRowOfScenario } from "./result.ts";

export interface ReportStage {
  key: "withoutControl" | "withControl" | "afterTighten";
  /** 「統制なし」「統制あり」「締めたあと」 */
  label: string;
  /** その段で実害が出た（すり抜けた）件数 */
  count: number;
  damageJpy: number;
  /** 「統制なし：実害7件・¥344,000」 */
  line: string;
}

export interface RehearsalReport {
  /** 「12件中10件は統制が止めた、2件がすり抜けた → 締める変更で0件」 */
  headline: string;
  total: number;
  stopped: { total: number; kernel: number; agent: number };
  /** すり抜けた件数（統制あり）。害が出なかった件数は noHarm */
  slipped: number;
  noHarm: number;
  /** 3段。統制なし（影を走らせた状況がないとき）・締めたあと（再試験がないとき）は入らない */
  stages: ReportStage[];
  /** 「統制なし：実害7件・¥344,000 → 統制あり：すり抜け2件・¥38,000 → 締めたあと：0件・¥0」 */
  stagesLine: string;
  /** このリハーサルで防いだ損害（影の走行がない状況は足さない） */
  preventedDamageJpy: number;
  /** 止めたものの区別 */
  stoppedBy: Array<{ by: "kernel" | "agent"; label: string; count: number; note: string }>;
  /** 締めたあとの合格が、エージェントの揺らぎに左右されない理由（再試験があるときだけ） */
  determinismNote: string | null;
  /** 集計の元（packages/rehearsal の summarizeRehearsal） */
  counts: RehearsalCounts;
}

export const KERNEL_LABEL = "Kernel（決定論）";
export const AGENT_LABEL = "エージェント自身（揺れる）";

/** ¥344,000（3桁区切りは環境に依らず同じ文字にする） */
export function yen(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`円は0以上の有限の数にする：${String(n)}`);
  return `¥${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/**
 * 報告を組み立てる。rows は最初の走行（と適応の走行）の状況ごとの結果、retest は締める変更のあとの再試験の結果（なければ null）。
 * 再試験の対象は rows と同じ状況にそろえる（caseId が rows にあるものだけ。あとから足した試験は数えない：人数の違う母集団を比べない）。
 * 見出しの「止めた」は Kernel とエージェント自身の合計。エージェント自身が断った分があれば内訳を出す（統制が止めたと言い張らない）
 */
export function buildRehearsalReport(rows: readonly DamageRow[], retest: readonly DamageRow[] | null = null): RehearsalReport {
  const ids = new Set(rows.map((r) => r.caseId));
  const same = retest === null ? null : retest.filter((r) => ids.has(r.caseId));
  const counts = summarizeRehearsal(rows, same);
  const stopped = { kernel: counts.stoppedByKernel, agent: counts.stoppedByAgent, total: counts.stoppedByKernel + counts.stoppedByAgent };
  const slipped = counts.withControl.slipped;
  const noHarm = counts.total - stopped.total - slipped;

  const stages: ReportStage[] = [];
  if (counts.withoutControl !== null) {
    stages.push({ key: "withoutControl", label: "統制なし", count: counts.withoutControl.harmed, damageJpy: counts.withoutControl.damageJpy, line: `統制なし：実害${counts.withoutControl.harmed}件・${yen(counts.withoutControl.damageJpy)}` });
  }
  stages.push({ key: "withControl", label: "統制あり", count: slipped, damageJpy: counts.withControl.damageJpy, line: `統制あり：すり抜け${slipped}件・${yen(counts.withControl.damageJpy)}` });
  if (counts.afterTighten !== null) {
    stages.push({ key: "afterTighten", label: "締めたあと", count: counts.afterTighten.slipped, damageJpy: counts.afterTighten.damageJpy, line: `締めたあと：${counts.afterTighten.slipped}件・${yen(counts.afterTighten.damageJpy)}` });
  }

  const stoppedText =
    stopped.agent === 0
      ? `${counts.total}件中${stopped.total}件は統制が止めた`
      : `${counts.total}件中${stopped.total}件は止まった（Kernel が${stopped.kernel}件・エージェント自身が${stopped.agent}件）`;
  const parts = [stoppedText, `${slipped}件がすり抜けた`];
  if (noHarm > 0) parts.push(`${noHarm}件は害が出なかった`);
  const headline = `${parts.join("、")}${counts.afterTighten === null ? "" : ` → 締める変更で${counts.afterTighten.slipped}件`}`;

  return {
    headline,
    total: counts.total,
    stopped,
    slipped,
    noHarm,
    stages,
    stagesLine: stages.map((s) => s.line).join(" → "),
    preventedDamageJpy: totalPreventedDamageJpy(rows),
    stoppedBy: [
      { by: "kernel", label: KERNEL_LABEL, count: stopped.kernel, note: "同じ呼び出しなら必ず同じ判定になる。再試験でも結果は変わらない" },
      { by: "agent", label: AGENT_LABEL, count: stopped.agent, note: "同じ状況でも断るかどうかは揺れる。今日断っても明日も断る保証はない" },
    ],
    determinismNote:
      counts.afterTighten === null
        ? null
        : "締めた変更で塞いだ書き込みは、エージェントがどう振る舞っても確認に回る（Kernel の判定は呼び出しが同じなら同じ）。再試験の合格は揺らぎに左右されない",
    counts,
  };
}

/** 状況の行（rehearsal_scenarios）から報告を作る。判定まで終わった行だけを数える（途中・中断・基盤の失敗の行は数えない） */
export function reportFromScenarioRows(rows: readonly RehearsalScenarioRow[], retestRows: readonly RehearsalScenarioRow[] | null = null): RehearsalReport {
  const pick = (list: readonly RehearsalScenarioRow[]): DamageRow[] => list.map(damageRowOfScenario).filter((x): x is DamageRow => x !== null);
  return buildRehearsalReport(pick(rows), retestRows === null ? null : pick(retestRows));
}
