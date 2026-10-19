// 合格証の発行（FR-067・BR-81）：走行が全件判定できて全件合格のときだけ、packages/rehearsal の buildCertificate で組み立てて保存する。
// 試験が0件・走らせなかった試験がある・不合格がある・ポリシーやツールの指紋がない走行では発行しない（締める側。ルールの auto は使えないまま）
// 依頼（askId）の走行は、担当の仕事ごとに1枚ずつ発行する（D-101）。担当ごとの指紋は走行の開始時に行へ残したもの（stage_fingerprints）を使い、
// 発行の前に今の指紋と比べる（違えば stale：走行の後で広げた・ツールが変わった）。試験の集合は依頼の試験で確かめる

import { buildCertificate, caseSetHash, expiryReasons, type CertificateBuild } from "@open-team/rehearsal";
import type { Queryable, RehearsalCaseRow, RehearsalCertificateRow, RehearsalRunRow, SessionCtx, Tx, WsCtx } from "@open-team/db";
import { issueCertificateIfCurrent } from "@open-team/db/rehearsal";
import type { ScenarioResult } from "@open-team/sim-core";
import { buildJobMaterials } from "./job-materials.ts";
import { resolveStages, type RehearsalRunDeps } from "./run.ts";

export type CertifyOutcome =
  | { issued: true; certificate: RehearsalCertificateRow }
  | { issued: false; reason: "not_done" | "not_job" | "no_fingerprint" | "no_cases" | "result_mismatch" | "not_all_passed" | "already_issued" | "stale" };
type Fingerprint = NonNullable<RehearsalRunRow["stage_fingerprints"]>[number];

export interface CertifyInput {
  ctx: WsCtx;
  run: RehearsalRunRow;
  /** 走らせた試験（外されていないもの） */
  cases: readonly RehearsalCaseRow[];
  /** 判定まで終わった状況の結果 */
  results: readonly ScenarioResult[];
}

/** 走行の結果から合格証を出す。出せない理由は reason で返す（例外にしない：不合格は普通の結果） */
export async function certifyRun(deps: Pick<RehearsalRunDeps, "db" | "clock">, input: CertifyInput): Promise<CertifyOutcome> {
  const { run } = input;
  if (run.status !== "done") return { issued: false, reason: "not_done" };
  // 発行済みの走行には重ねて出さない（監査ログへの記録も1回だけ）
  if (run.certificate_id !== null) return { issued: false, reason: "already_issued" };
  if (run.job_id !== null) {
    if (run.policy_hash === null || run.tool_hashes === null) return { issued: false, reason: "no_fingerprint" };
    return issueOne(deps, input, { jobId: run.job_id, policyHash: run.policy_hash, toolHashes: run.tool_hashes });
  }
  if (run.ask_id === null) return { issued: false, reason: "not_job" };
  // 依頼の走行：走らせたときの担当ごとの指紋が行に残っていなければ出さない（依頼の走行が指紋を残す前の行・ユーザーの悪い日の1件など）
  const saved = run.stage_fingerprints;
  if (saved === null) return { issued: false, reason: "no_fingerprint" };
  const stages = await resolveStages(deps.db, input.ctx, { askId: run.ask_id });
  // 全段の指紋を先に比べる（一部だけ出してから止まらないように）。担当の並びが変わったものも stale
  if (stages.length !== saved.length) return { issued: false, reason: "stale" };
  const fps: Fingerprint[] = [];
  for (const [i, st] of stages.entries()) {
    const fp = saved[i];
    if (fp === undefined || fp.jobId !== st.jobId) return { issued: false, reason: "stale" };
    const m = await buildJobMaterials(deps, input.ctx as unknown as SessionCtx, { jobId: st.jobId });
    if (m.policyHash === null || m.toolHashes === null) return { issued: false, reason: "no_fingerprint" };
    if (m.policyHash !== fp.policyHash || !sameToolHashes(m.toolHashes, fp.toolHashes)) return { issued: false, reason: "stale" };
    fps.push(fp);
  }
  // 担当の仕事ごとに1枚（全件合格のときだけ。不合格・走らせなかった試験があれば最初の担当の組み立てで断る）。最後の担当の1枚を返す
  // 全段を同じワークスペースロック・トランザクションで再確認して発行する。
  // 途中で stale / 発行不可なら例外で全てロールバックし、部分発行を残さない。
  try {
    return await deps.db.transaction(async (tx) => {
      // 先に全段の現在指紋をロック下で確認し、ひとつでも違えば発行処理に進まない。
      for (const fp of fps) {
        const current = await buildJobMaterials({ db: tx }, input.ctx as unknown as SessionCtx, { jobId: fp.jobId });
        if (current.policyHash === null || current.toolHashes === null) throw new BatchIssueFailure({ issued: false, reason: "no_fingerprint" });
        if (current.policyHash !== fp.policyHash || !sameToolHashes(current.toolHashes, fp.toolHashes)) {
          throw new BatchIssueFailure({ issued: false, reason: "stale" });
        }
      }
      let last: RehearsalCertificateRow | null = null;
      for (const fp of fps) {
        const outcome = await issueOne(deps, input, { jobId: fp.jobId, policyHash: fp.policyHash, toolHashes: fp.toolHashes }, tx);
        if (!outcome.issued) throw new BatchIssueFailure(outcome);
        last = outcome.certificate;
      }
      if (last === null) throw new BatchIssueFailure({ issued: false, reason: "no_fingerprint" });
      return { issued: true, certificate: last };
    });
  } catch (e) {
    if (e instanceof BatchIssueFailure) return e.outcome;
    throw e;
  }
}

class BatchIssueFailure extends Error {
  readonly outcome: CertifyOutcome;
  constructor(outcome: CertifyOutcome) { super("依頼の合格証を一括発行できなかった"); this.outcome = outcome; }
}


/** 合格証の tool_hashes と走行の指紋が同じか（順番を含めて比べる） */
function sameToolHashes(a: readonly { action: string; toolHash: string }[], b: readonly { action: string; toolHash: string }[]): boolean {
  return a.length === b.length && a.every((x, i) => x.action === b[i]!.action && x.toolHash === b[i]!.toolHash);
}

/** 1つの仕事の合格証を組み立てて、発行の直前にロックの下で確かめて保存する */
async function issueOne(
  deps: Pick<RehearsalRunDeps, "db" | "clock">,
  input: CertifyInput,
  fp: { jobId: string; policyHash: string; toolHashes: Fingerprint["toolHashes"] },
  q?: Tx,
): Promise<CertifyOutcome> {
  const { run, cases, results } = input;
  const now = deps.clock.now();
  const built: CertificateBuild = buildCertificate({
    jobId: fp.jobId,
    policyHash: fp.policyHash,
    toolHashes: fp.toolHashes,
    modelId: run.model_id,
    cases: cases.map((c) => ({ source: c.source, scenario: c.scenario as never, simSnapshotId: c.sim_snapshot_id })),
    results: results.map((r) => {
      const c = cases.find((x) => x.id === r.caseId);
      return { caseId: r.caseId, source: c?.source ?? "generated", verdict: r.verdict };
    }),
    costUsd: run.cost_usd,
    issuedAt: now.toISOString(),
  });
  if (!built.ok) return { issued: false, reason: built.reason };
  const c = built.certificate;
  // 発行の直前にロックの下で、走行を読み直して（発行済みか）、走行中に試験・ポリシー・ツールが変わっていないかを確かめる
  const issue = (tx: Tx) =>
    issueCertificateIfCurrent(
      tx,
      input.ctx,
      {
      jobId: c.jobId,
      askId: run.ask_id,
      runId: run.id,
      policyHash: c.policyHash,
      toolHashes: c.toolHashes,
      modelId: c.modelId,
      caseSetHash: c.caseSetHash,
      caseCount: c.caseCount,
      summary: c.summary,
      costUsd: c.costUsd,
      certificateHash: c.certificateHash,
      now,
      },
      async (active) => {
        const materials = await buildJobMaterials({ db: tx }, input.ctx as unknown as SessionCtx, { jobId: c.jobId });
        if (materials.policyHash === null || materials.toolHashes === null) return "no_fingerprint";
        const reasons = expiryReasons(
          { jobId: c.jobId, policyHash: c.policyHash, toolHashes: c.toolHashes, modelId: c.modelId, caseSetHash: c.caseSetHash },
          {
            jobId: c.jobId,
            policyHash: materials.policyHash as never,
            toolHashes: materials.toolHashes,
            modelId: c.modelId,
            caseSetHash: caseSetHash(active.map((x) => ({ source: x.source, scenario: x.scenario as never, simSnapshotId: x.sim_snapshot_id }))),
          },
        );
        return reasons.length === 0 ? null : reasons.join(",");
      },
    );
  const issued = q === undefined ? await deps.db.transaction(issue) : await issue(q);
  if (!issued.issued) return { issued: false, reason: issued.reason === "stale" ? "stale" : issued.reason === "run_not_done" ? "not_done" : "already_issued" };
  const certificate = issued.certificate;
  return { issued: true, certificate };
}
