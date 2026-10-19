// 締める変更の適用（FR-045・D-82）：[適用] を押された案（JSON Patch）を、kernel の checkTighteningProposal（スキーマ → compose の違反 →
// ルールの追加でない → classify が narrow）に通し、通ったものだけを設定変更（TBL-025。origin = rehearsal_tighten・narrow）として保存して、
// 新しい今のスナップショットにする。判定は kernel に任せ、ここでは呼ぶだけ（自前の分類はしない）
// - 締める変更では合格証を切らない（FR-067）：合格証には触れない。切れるのは広げる変更・ツールの変化・モデルの変更・試験の追加
// - 再試験は retest.ts。適用したあとに呼ぶ

import type { AgentConfigChangeRow, AgentSnapshotRow, EffectivePolicies, SessionCtx, Uuid } from "@open-team/db";
import { getWorkspace } from "@open-team/db";
import { getAgentSnapshotRow } from "@open-team/db/edge";
import { getLatestWorkspacePolicy, listConnectors, listConnectorTools } from "@open-team/db/app";
import { applyTighteningChange, getJobStage, getRehearsalRun, listAppliedTighteningChanges } from "@open-team/db/rehearsal";
import { CEILINGS_VERSION, canonicalJson, DEFAULT_CEILINGS, checkTighteningProposal, composeAll, parseWorkspacePolicy } from "@open-team/kernel";
import type { AgentDefinitionInput, ClassifyContext, Json, JsonObject } from "@open-team/kernel";
import { applyJsonPatch, type PatchOp } from "@open-team/rehearsal";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import { catalogOf } from "../owner-setup.ts";
import { resolveStages } from "./run.ts";

export interface ApplyTighteningInput {
  /** 案のもとになった走行 */
  runId: Uuid;
  /** 依頼（chain）の走行のとき、どの担当の仕事を締めるか。仕事の走行では省略（走行の仕事） */
  jobId?: Uuid;
  /** 案の差分（TighteningProposal.patch） */
  patch: readonly PatchOp[];
}

export interface ApplyTighteningResult {
  change: AgentConfigChangeRow;
  snapshot: AgentSnapshotRow;
  jobId: Uuid;
}

type ApplyDeps = Pick<AppDeps, "db" | "clock">;

/** 締める変更を適用する。通らない案は 422（AGENT_SCHEMA_INVALID・AGENT_EXCEEDS_POLICY・PROPOSAL_NOT_NARROW）、走行がない・対象でない仕事は 404 */
export async function applyTightening(deps: ApplyDeps, s: SessionCtx, input: ApplyTighteningInput): Promise<ApplyTighteningResult> {
  const { db } = deps;
  const ctx = s;
  const ws = await getWorkspace(db, ctx);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  const run = await getRehearsalRun(db, ctx, input.runId);
  if (run === null) throw new AppError("NOT_FOUND");
  if (run.status === "queued" || run.status === "generating" || run.status === "running") {
    throw new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: { runId: run.id } });
  }
  if (input.patch.length === 0) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "patch", reason: "差分が空です" }] });

  // 締める対象の仕事：仕事の走行はその仕事、依頼の走行は担当のうちの1つ
  let jobId: Uuid;
  if (run.job_id !== null) {
    if (input.jobId !== undefined && input.jobId !== run.job_id) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "jobId", reason: "走行の仕事と違います" }] });
    jobId = run.job_id;
  } else {
    if (input.jobId === undefined) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "jobId", reason: "依頼の走行では、締める担当の仕事を指定してください" }] });
    const stages = await resolveStages(db, ctx, { askId: run.ask_id });
    if (!stages.some((x) => x.jobId === input.jobId)) throw new AppError("NOT_FOUND");
    jobId = input.jobId;
  }
  const stage = await getJobStage(db, ctx, jobId);
  if (stage === null) throw new AppError("NOT_FOUND");
  const current = await getAgentSnapshotRow(db, ctx, stage.agent_snapshot_id);
  if (current === null || current.definition === null) throw new AppError("NOT_FOUND");
  const before = current.definition as unknown as AgentDefinitionInput;

  let after: unknown;
  try {
    after = applyJsonPatch(before, input.patch);
  } catch (e) {
    // 存在しない場所への replace・remove など（差分が今の定義に合わない）
    throw new AppError("AGENT_SCHEMA_INVALID", e instanceof Error ? e.message : undefined, { cause: e });
  }

  // 冪等性：同じ走行・同じ仕事に同じ差分を適用済み、または適用しても定義が変わらないなら、二重に足さず 409
  const patchKey = canonicalJson(input.patch);
  const prior = await listAppliedTighteningChanges(db, ctx, run.id, jobId);
  if (prior.some((c) => canonicalJson(c.patch) === patchKey) || canonicalJson(after) === canonicalJson(before)) {
    throw new AppError("CHANGE_NOT_PENDING", "この変更はすでに適用されています");
  }

  const policyRow = await getLatestWorkspacePolicy(db, ctx);
  if (policyRow === null) throw new AppError("INTERNAL_ERROR", "ワークスペースのポリシーがありません");
  const workspacePolicy = parseWorkspacePolicy(policyRow.policy);
  const classifyCtx: ClassifyContext = {
    ceilings: DEFAULT_CEILINGS,
    workspacePolicy,
    tools: catalogOf(await listConnectors(db, ctx), await listConnectorTools(db, ctx)),
  };
  const check = checkTighteningProposal({ before, after, ctx: classifyCtx });
  if (!check.ok) {
    if (check.reason === "schema_invalid") throw new AppError("AGENT_SCHEMA_INVALID", undefined, { details: check.issues });
    if (check.reason === "exceeds_policy") throw new AppError("AGENT_EXCEEDS_POLICY", undefined, { details: check.result.violations });
    // ルールの記録（出どころ）は作るとき以外は変えられない（SG-09）。締める変更に混ぜても 422
    if (check.reason === "changes_rule_record") {
      throw new AppError("PROPOSAL_NOT_NARROW", "ルールの記録（作った人・時刻・もとの Intent・汚染の印など）は変えられません", {
        details: { reason: check.reason, classification: check.result.classification, changes: check.changes },
      });
    }
    throw new AppError("PROPOSAL_NOT_NARROW", undefined, { details: { reason: check.reason, classification: check.result.classification } });
  }

  const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy, agent: check.definition });
  if (composed.violations.length > 0) throw new AppError("AGENT_EXCEEDS_POLICY", undefined, { details: composed.violations });
  const effectivePolicies: EffectivePolicies = Object.fromEntries(
    Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash }]),
  );

  const applied = await db.transaction((tx) =>
    applyTighteningChange(tx, ctx, {
      agentId: stage.agent_id,
      jobId,
      runId: run.id,
      patch: input.patch as unknown as Json[],
      expectedSnapshotId: stage.agent_snapshot_id,
      definition: check.definition as unknown as JsonObject,
      effectivePolicies,
      clamped: composed.clamped as unknown as Json[],
      ceilingsVersion: CEILINGS_VERSION,
      decidedBy: s.userId,
      now: deps.clock.now(),
    }),
  );
  // 判定のあとに別の変更でスナップショットが動いた：古い定義に当てた案は保存しない（取り直してもらう）
  if (applied === null) throw new AppError("CHANGE_NOT_PENDING", "設定が別の変更で更新されました。結果を読み直してください");
  return { ...applied, jobId };
}
