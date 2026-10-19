// エージェントの一覧（ライブラリ。SCR-014・API-041 の v0.5 版）の問い合わせ（@open-team/db/agents）
// README §1 の約束：業務の関数は (q, ctx: WsCtx, …)、SQL を必ず workspace_id で絞る。読むだけなので Queryable を受ける。
// 「生成した担当」は依頼（asks）の編成で作られたもの（ask_members に並ぶ）と、用意した依頼の担当。removed は出さない（画面の約束：06 agents.md）

import type { Queryable } from "../client.ts";
import type { AgentRow, AskStatus, JobKind, JobStatus, JobTemplate, Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";

/** 一覧の1行：担当の行 ＋ 仕事の数 ＋ 関わった依頼の数 ＋ 本番のタスクの数と最後に動いた時刻 */
export interface AgentListRow {
  agent: AgentRow;
  jobCount: number;
  askCount: number;
  /** 本番（trigger_type = 'ask'・リハーサルでない）のタスクの数と、最後に始めた・終わった時刻 */
  taskCount: number;
  lastActiveAt: Date | null;
  /** いま動いているか（queued〜running のタスクがある） */
  running: boolean;
  /** 確認待ちのタスクがあるか */
  awaitingApproval: boolean;
  /** 使い回された依頼の数（ask_members で is_new でない依頼。全期間） */
  reuseCount: number;
  /** 生まれた依頼（is_new の依頼のうちいちばん古いもの。全期間。なければ null） */
  bornAskId: Uuid | null;
  /** 「以後も許可」にしたルールの数（設定変更 origin = approval_rule・applied） */
  allowedRuleCount: number;
  /** 安全チェックで権限を絞った回数（設定変更 origin = rehearsal_tighten・applied） */
  tightenedCount: number;
  /** 持っているスキルの数 */
  skillCount: number;
}

/**
 * ワークスペースの担当（removed を除く）を、最後に動いた順 → 作った順の新しい順で返す。
 * 数えるのは本番のタスクだけ（リハーサル・影の走行は混ぜない：BR-67①）。
 * 最後に動いた時刻は、終わったタスクは終わった時刻、終わっていないタスク（実行中・確認待ち）は最後に状態が変わった時刻
 */
export async function listAgentLibrary(q: Queryable, ctx: WsCtx): Promise<AgentListRow[]> {
  const r = await q.query<
    AgentRow & { job_count: number; ask_count: number; task_count: number; last_active_at: Date | null; running: boolean; awaiting_approval: boolean;
      reuse_count: number; born_ask_id: Uuid | null; allowed_rule_count: number; tightened_count: number; skill_count: number }
  >(
    `SELECT a.id, a.workspace_id, a.slug, a.name, a.name_source, a.role, a.appearance, a.status, a.current_snapshot_id, a.disabled_by,
            a.disabled_reason, a.disabled_at, a.created_at, a.updated_at,
            (SELECT count(*)::int FROM agent_jobs j WHERE j.workspace_id = a.workspace_id AND j.agent_id = a.id) AS job_count,
            (SELECT count(DISTINCT m.ask_id)::int FROM ask_members m WHERE m.workspace_id = a.workspace_id AND m.agent_id = a.id) AS ask_count,
            (SELECT count(DISTINCT m.ask_id)::int FROM ask_members m WHERE m.workspace_id = a.workspace_id AND m.agent_id = a.id AND NOT m.is_new) AS reuse_count,
            (SELECT m.ask_id FROM ask_members m JOIN asks k ON k.workspace_id = m.workspace_id AND k.id = m.ask_id
              WHERE m.workspace_id = a.workspace_id AND m.agent_id = a.id AND m.is_new ORDER BY k.created_at, k.id LIMIT 1) AS born_ask_id,
            (SELECT count(*)::int FROM agent_config_changes c WHERE c.workspace_id = a.workspace_id AND c.agent_id = a.id AND c.origin = 'approval_rule' AND c.status = 'applied') AS allowed_rule_count,
            (SELECT count(*)::int FROM agent_config_changes c WHERE c.workspace_id = a.workspace_id AND c.agent_id = a.id AND c.origin = 'rehearsal_tighten' AND c.status = 'applied') AS tightened_count,
            (SELECT count(*)::int FROM agent_skills s WHERE s.workspace_id = a.workspace_id AND s.agent_id = a.id) AS skill_count,
            t.task_count, t.last_active_at, t.running, t.awaiting_approval
       FROM agents a
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS task_count,
                max(coalesce(x.finished_at, x.updated_at)) AS last_active_at,
                bool_or(x.status IN ('queued','provisioning','running')) AS running,
                bool_or(x.status = 'awaiting_approval') AS awaiting_approval
           FROM tasks x
          WHERE x.workspace_id = a.workspace_id AND x.agent_id = a.id AND x.rehearsal_run_id IS NULL AND NOT x.shadow AND NOT x.is_dry_run
       ) t ON true
      WHERE a.workspace_id = $1 AND a.status <> 'removed'
      ORDER BY coalesce(t.last_active_at, a.created_at) DESC, a.created_at DESC, a.id`,
    [ctx.workspaceId],
  );
  return r.rows.map(({ job_count, ask_count, task_count, last_active_at, running, awaiting_approval, reuse_count, born_ask_id, allowed_rule_count, tightened_count, skill_count, ...agent }) => ({
    agent,
    jobCount: job_count,
    askCount: ask_count,
    taskCount: task_count ?? 0,
    lastActiveAt: last_active_at,
    running: running ?? false,
    awaitingApproval: awaiting_approval ?? false,
    reuseCount: reuse_count ?? 0,
    bornAskId: born_ask_id ?? null,
    allowedRuleCount: allowed_rule_count ?? 0,
    tightenedCount: tightened_count ?? 0,
    skillCount: skill_count ?? 0,
  }));
}

/** 担当が関わった依頼（ask_members）の1行。summary はその依頼でその担当がすること */
export interface AgentAskRow {
  agent_id: Uuid;
  ask_id: Uuid;
  ask_text: string;
  ask_status: AskStatus;
  summary: string;
  is_new: boolean;
  is_spokesperson: boolean;
  is_aggregator: boolean;
  position: number | null;
  ask_created_at: Date;
}

/** 担当ごとの関わった依頼（新しい順）。perAgent 件ずつ（一覧に畳んで出す分） */
export async function listAgentAsks(q: Queryable, ctx: WsCtx, agentIds: readonly Uuid[], perAgent: number): Promise<AgentAskRow[]> {
  if (agentIds.length === 0) return [];
  const r = await q.query<AgentAskRow>(
    `SELECT * FROM (
       SELECT m.agent_id, m.ask_id, k.text AS ask_text, k.status AS ask_status, m.summary, m.is_new, m.is_spokesperson, m.is_aggregator, m.position,
              k.created_at AS ask_created_at,
              row_number() OVER (PARTITION BY m.agent_id ORDER BY k.created_at DESC, k.id DESC) AS rn
         FROM ask_members m
         JOIN asks k ON k.workspace_id = m.workspace_id AND k.id = m.ask_id
        WHERE m.workspace_id = $1 AND m.agent_id = ANY($2::uuid[])
     ) s WHERE s.rn <= $3
     ORDER BY s.agent_id, s.ask_created_at DESC, s.ask_id DESC`,
    [ctx.workspaceId, [...agentIds], perAgent],
  );
  return r.rows;
}

/** 担当の仕事（agent_jobs）の1行 */
export interface AgentJobSummaryRow {
  id: Uuid;
  agent_id: Uuid;
  slug: string;
  kind: JobKind;
  template: JobTemplate;
  status: JobStatus;
  created_at: Date;
}

/** 担当ごとの仕事（作った順） */
export async function listAgentJobs(q: Queryable, ctx: WsCtx, agentIds: readonly Uuid[]): Promise<AgentJobSummaryRow[]> {
  if (agentIds.length === 0) return [];
  const r = await q.query<AgentJobSummaryRow>(
    `SELECT id, agent_id, slug, kind, template, status, created_at
       FROM agent_jobs WHERE workspace_id = $1 AND agent_id = ANY($2::uuid[])
      ORDER BY agent_id, created_at, id`,
    [ctx.workspaceId, [...agentIds]],
  );
  return r.rows;
}
