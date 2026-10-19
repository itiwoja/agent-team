// 締める提案（FR-045）の材料の問い合わせ：オラクルが失敗の原因とした書き込み（Intent）と、その書き込みを判定したときの subject を引く。
// - 読むだけ（SQL は必ず workspace_id で絞る：README §1）。保存は repo/rehearsal.ts の applyTighteningChange
// - subject は edge が policy_decisions に記録した判定の入力そのもの（ツールの分類・引数の役割つき）。kernel の recheckIntent で判定し直す材料になる

import type { JsonObject } from "@open-team/kernel";
import type { Queryable } from "../client.ts";
import type { Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";

/** 本番の経路（governed）で allow になって実行まで進んだ書き込み1件 */
export interface SlippedWriteSource {
  intentId: Uuid;
  /** この書き込みをした状況の行（rehearsal_scenarios.id） */
  scenarioId: Uuid;
  taskId: Uuid;
  /** 書き込みをしたタスクが使っていたスナップショット（matchedRule の添字を、そのときの実効ポリシーのルール id に直す材料） */
  agentSnapshotId: Uuid;
  /** 書き込みをした仕事（agent_jobs.id と、定義の中の仕事の id＝slug） */
  jobId: Uuid;
  jobSlug: string;
  action: string;
  /** 通したルールの場所（判定の記録の matched_rule。例 'rules.items[0]'）。ルールなしなら null */
  matchedRule: string | null;
  /** 判定の入力（Subject の JSON。ツール呼び出しの call は含まれうる）。記録がなければ null */
  subject: JsonObject | null;
}

/** 実行まで進んだ（または結果が分からない）状態。却下・承認待ち・失効は塞ぐ対象でない */
const WENT_THROUGH = ["approved", "executing", "executed", "verified", "unknown_outcome"] as const;

/**
 * Intent の id から、本番の経路で allow になって通った書き込みを引く（影・承認した分岐・enforced でない判定は含めない）。
 * 見つからない id（別の経路・止められた書き込み）は返さない。並びは作成順
 */
export async function listSlippedWriteSources(q: Queryable, ctx: WsCtx, intentIds: readonly Uuid[]): Promise<SlippedWriteSource[]> {
  if (intentIds.length === 0) return [];
  const r = await q.query<{
    intent_id: Uuid;
    scenario_id: Uuid;
    task_id: Uuid;
    agent_snapshot_id: Uuid;
    job_id: Uuid;
    job_slug: string;
    action: string;
    matched_rule: string | null;
    subject: JsonObject | null;
  }>(
    `SELECT i.id AS intent_id, t.rehearsal_scenario_id AS scenario_id, i.task_id, t.agent_snapshot_id, i.job_id, j.slug AS job_slug, i.action, i.matched_rule,
            (SELECT d.subject FROM policy_decisions d
              WHERE d.workspace_id = i.workspace_id AND d.task_id = i.task_id AND d.intent_id = i.id AND d.subject_kind = 'tool_call'
              ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS subject
       FROM action_intents i
       JOIN tasks t ON t.workspace_id = i.workspace_id AND t.id = i.task_id
       JOIN agent_jobs j ON j.workspace_id = i.workspace_id AND j.id = i.job_id
      WHERE i.workspace_id = $1 AND i.id = ANY($2::uuid[])
        AND t.execution_variant = 'governed' AND t.rehearsal_scenario_id IS NOT NULL
        AND i.decision = 'allow' AND i.enforced AND i.status = ANY($3::text[])
      ORDER BY i.created_at, i.id`,
    [ctx.workspaceId, [...intentIds], [...WENT_THROUGH]],
  );
  return r.rows.map((x) => ({
    intentId: x.intent_id,
    scenarioId: x.scenario_id,
    taskId: x.task_id,
    agentSnapshotId: x.agent_snapshot_id,
    jobId: x.job_id,
    jobSlug: x.job_slug,
    action: x.action,
    matchedRule: x.matched_rule,
    subject: x.subject,
  }));
}

/** 状況の行の、本番の経路（governed）でルール（rule_matched）により確認なしで通った書き込み1件（D-108 の注記の材料） */
export interface RuleAllowedWrite {
  scenarioId: Uuid;
  intentId: Uuid;
  /** 書き込みをしたタスクのスナップショット（走行に実効ポリシーがないときの引き先） */
  agentSnapshotId: Uuid;
  jobSlug: string;
  action: string;
  destinationKey: string;
  optionDigest: string;
  /** 通したルールの場所（例 'rules.items[0]'） */
  matchedRule: string | null;
  arguments: JsonObject;
}

/** 状況の行の id から、ルールで確認なしに通って実行まで進んだ書き込みを引く（影・承認した分岐は含めない）。並びは作成順 */
export async function listRuleAllowedWritesOfScenarios(q: Queryable, ctx: WsCtx, scenarioIds: readonly Uuid[]): Promise<RuleAllowedWrite[]> {
  if (scenarioIds.length === 0) return [];
  const r = await q.query<{
    scenario_id: Uuid;
    intent_id: Uuid;
    agent_snapshot_id: Uuid;
    job_slug: string;
    action: string;
    destination_key: string;
    option_digest: string;
    matched_rule: string | null;
    arguments: JsonObject | null;
  }>(
    `SELECT t.rehearsal_scenario_id AS scenario_id, i.id AS intent_id, t.agent_snapshot_id, j.slug AS job_slug, i.action, i.destination_key, i.option_digest, i.matched_rule,
            i.payload->'arguments' AS arguments
       FROM action_intents i
       JOIN tasks t ON t.workspace_id = i.workspace_id AND t.id = i.task_id
       JOIN agent_jobs j ON j.workspace_id = i.workspace_id AND j.id = i.job_id
      WHERE i.workspace_id = $1 AND t.rehearsal_scenario_id = ANY($2::uuid[])
        AND t.execution_variant = 'governed'
        AND i.decision = 'allow' AND i.reason_code = 'rule_matched' AND i.enforced AND i.status = ANY($3::text[])
      ORDER BY i.created_at, i.id`,
    [ctx.workspaceId, [...scenarioIds], [...WENT_THROUGH]],
  );
  return r.rows.map((x) => ({
    scenarioId: x.scenario_id,
    intentId: x.intent_id,
    agentSnapshotId: x.agent_snapshot_id,
    jobSlug: x.job_slug,
    action: x.action,
    destinationKey: x.destination_key,
    optionDigest: x.option_digest,
    matchedRule: x.matched_rule,
    arguments: x.arguments ?? {},
  }));
}
