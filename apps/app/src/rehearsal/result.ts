// リハーサルの結果の集計（結果の取得 GET …/rehearsals/{runId}/result から呼ぶ）。
// 走行が終わっていれば保存した集計（suite.ts が summarizeRehearsal で出したもの）、途中なら今ある状況の行から出し直す（provisional）

import type { Queryable, RehearsalCertificateRow, RehearsalRunRow, RehearsalScenarioRow, WsCtx } from "@open-team/db";
import { rehearsalGenerateCostOf } from "@open-team/db/asks";
import { countGeneratedCasesOfRun } from "@open-team/db/rehearsal";
import { summarizeRehearsal, type DamageRow } from "@open-team/rehearsal";
import type { ScenarioResult } from "@open-team/sim-core";

/** 状況の行から集計の入力を作る（判定まで終わった行だけ。走行が終わる前の途中経過に使う） */
export function damageRowOfScenario(r: RehearsalScenarioRow): DamageRow | null {
  if (r.status !== "done" || r.verdict === null || r.stopped_by === null || r.damage_jpy === null) return null;
  const stoppedBy: ScenarioResult["stoppedBy"] =
    r.stopped_by === "kernel" && r.stopped_by_decision !== null && r.stopped_by_reason_code !== null
      ? { by: "kernel", decision: r.stopped_by_decision, reasonCode: r.stopped_by_reason_code, matchedRule: r.stopped_by_rule }
      : r.stopped_by === "agent"
        ? { by: "agent" }
        : { by: "none" };
  const outcome: ScenarioResult["outcome"] = r.verdict === "fail" ? "slipped" : stoppedBy.by === "none" ? "no_harm" : "stopped";
  return {
    caseId: r.case_id,
    outcome,
    stoppedBy,
    governedJpy: r.damage_jpy,
    shadow: r.shadow_damage_jpy === null ? null : { totalJpy: r.shadow_damage_jpy, harmed: r.shadow_damage_jpy > 0 || (r.shadow_leak_count ?? 0) > 0 },
  };
}

/** 3段の集計 */
export function countsOfRun(run: RehearsalRunRow, scenarios: readonly RehearsalScenarioRow[]): { counts: ReturnType<typeof summarizeRehearsal> | null; provisional: boolean } {
  const saved = run.summary?.counts;
  if (run.status !== "queued" && run.status !== "generating" && run.status !== "running" && saved !== undefined) {
    return { counts: saved as unknown as ReturnType<typeof summarizeRehearsal> | null, provisional: false };
  }
  const rows = scenarios.map(damageRowOfScenario).filter((x): x is DamageRow => x !== null);
  return { counts: rows.length === 0 ? null : summarizeRehearsal(rows), provisional: true };
}

/** 合格証の行（auditSeq で監査ログの記録を引ける。revokedAt が入っていれば失効済み） */
export function rehearsalCertificateView(c: RehearsalCertificateRow) {
  return {
    id: c.id,
    jobId: c.job_id,
    askId: c.ask_id,
    runId: c.rehearsal_run_id,
    policyHash: c.policy_hash,
    toolHashes: c.tool_hashes,
    modelId: c.model_id,
    caseSetHash: c.case_set_hash,
    caseCount: c.case_count,
    summary: c.summary,
    costUsd: c.cost_usd,
    certificateHash: c.certificate_hash,
    auditSeq: c.audit_seq,
    issuedAt: c.issued_at.toISOString(),
    revokedAt: c.revoked_at?.toISOString() ?? null,
    revokeReason: c.revoke_reason,
  };
}

/**
 * 悪い日を作った Gemini（モデル・生成の費用・作った件数）。事前に用意した走行（モデルの記録がない）は null。費用の記録がなければ costUsd は null。
 * count は生成した試験の数（走り出した状況の行の数ではない：生成の直後は行が1件ずつ増える）
 */
export async function generatorOf(
  q: Queryable,
  ctx: WsCtx,
  run: Pick<RehearsalRunRow, "id" | "generator_model_id" | "is_seed">,
): Promise<{ model: string; costUsd: string | null; count: number } | null> {
  if (run.is_seed || run.generator_model_id === null) return null;
  const [cost, count] = await Promise.all([rehearsalGenerateCostOf(q, ctx, run.id), countGeneratedCasesOfRun(q, ctx, run.id)]);
  return { model: run.generator_model_id, costUsd: cost?.costUsd ?? null, count };
}
