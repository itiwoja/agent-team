// エージェントの一覧（ライブラリ）の表示用ビュー（GET /agents）。読むだけ（トランザクションを張らない）。
// SQL は db の agents リポジトリ（workspace_id で絞る）。画面に出す固定の文（役割・様子・仕事の種類）はここで作って返し、画面はそのまま出す

import type { Queryable, WsCtx } from "@open-team/db";
import { listAgentAsks, listAgentJobs, listAgentLibrary, type AgentAskRow, type AgentJobSummaryRow, type AgentListRow } from "@open-team/db/agents";
import { listWorkspaceActiveSkills } from "@open-team/db/check";
import { listPendingSkillProposals, listRecentEvolutionEvents } from "@open-team/db/evolution";
import type { AgentEvolutionEventRow, AgentSkillRow, SkillProposalRow } from "@open-team/db";
import { FORMATION_LIMITS } from "@open-team/kernel";
import {
  AGENT_LIST_LIMITS,
  type AgentSkillView,
  type PrunedEventView,
  type SkillProposalView,
  type AgentActivityState, type AgentGrowth, type AgentAskView, type AgentJobView, type AgentLibraryItem, type AgentLibraryResponse } from "./contract.ts";

/** 役割の1行（agents.role → 画面の語。設定プランナーの役割の語に揃える） */
export const ROLE_LABELS: Record<NonNullable<AgentLibraryItem["role"]>, string> = {
  research: "調べる係",
  watch: "見張る係",
  brief: "まとめる係",
  assist: "手伝う係",
  dev: "開発の係",
};

export const JOB_KIND_LABELS: Record<AgentJobView["kind"], string> = { once: "1回", recurring: "定期", watch: "見張り" };
export const JOB_TEMPLATE_LABELS: Record<AgentJobView["template"], string> = {
  researcher: "調べる",
  briefer: "まとめる",
  watcher: "見張る",
  assistant: "手伝う",
  "dev-coder": "作る",
  reviewer: "見直す",
};

/** いまの様子（止めている > 動いている > 確認待ち > 待機中）。色は添えるだけで、文で示す */
export function activityOf(row: Pick<AgentListRow, "running" | "awaitingApproval"> & { agent: Pick<AgentListRow["agent"], "status"> }): { state: AgentActivityState; text: string } {
  if (row.agent.status === "disabled") return { state: "disabled", text: "止めています" };
  if (row.running) return { state: "running", text: "動いています" };
  if (row.awaitingApproval) return { state: "awaiting_approval", text: "確認待ち" };
  return { state: "idle", text: "待機中" };
}

export function askView(r: AgentAskRow): AgentAskView {
  return {
    askId: r.ask_id,
    text: r.ask_text,
    status: r.ask_status,
    summary: r.summary,
    isNew: r.is_new,
    isSpokesperson: r.is_spokesperson,
    isAggregator: r.is_aggregator,
    position: r.position,
    createdAt: r.ask_created_at.toISOString(),
  };
}

export function jobView(j: AgentJobSummaryRow): AgentJobView {
  return {
    jobId: j.id,
    kind: j.kind,
    kindLabel: JOB_KIND_LABELS[j.kind],
    template: j.template,
    templateLabel: JOB_TEMPLATE_LABELS[j.template],
    status: j.status,
    createdAt: j.created_at.toISOString(),
  };
}

/** 成長の1行。0 でない項目だけ「 · 」でつなぐ。全部 0 なら null */
export function growthLineOf(g: AgentGrowth): string | null {
  const parts = [
    g.reuseCount > 0 ? `使い回し ${g.reuseCount}回` : null,
    g.allowedRuleCount > 0 ? `以後も許可にした ${g.allowedRuleCount}回` : null,
    g.tightenedCount > 0 ? `権限を絞った ${g.tightenedCount}回` : null,
    g.skillCount > 0 ? `スキル ${g.skillCount}件` : null,
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** 一覧の1件。asks は新しい順で渡す（生まれた依頼は is_new の依頼のうちいちばん古いもの） */
/** 整理の記録を「外したもの」として出す期間（30日） */
export const PRUNED_VISIBLE_MS = 30 * 24 * 60 * 60 * 1000;

export function skillView(r: AgentSkillRow): AgentSkillView {
  return { id: r.id, name: r.name, description: r.description, origin: r.origin, lastUsedAt: r.last_used_at?.toISOString() ?? null, createdAt: r.created_at.toISOString() };
}

/** 案（proposed は name・description・body が必ずある）。本文は保存時に秘密情報のマスクを通っている前提でそのまま出す */
export function proposalView(r: SkillProposalRow): SkillProposalView {
  return { id: r.id, name: r.name ?? "", description: r.description ?? "", body: r.body ?? "", reason: r.reason, createdAt: r.created_at.toISOString() };
}

export function prunedView(e: AgentEvolutionEventRow): PrunedEventView {
  return { eventId: e.id, createdAt: e.created_at.toISOString(), items: e.items.map((i) => ({ type: i.type, id: i.id, label: i.label, restoredAt: i.restoredAt })) };
}

export interface EvolutionViews {
  skills: readonly AgentSkillView[];
  skillProposals: readonly SkillProposalView[];
  pruned: readonly PrunedEventView[];
}

export function libraryItem(
  row: AgentListRow,
  asks: readonly AgentAskRow[],
  jobs: readonly AgentJobSummaryRow[],
  evolution: EvolutionViews = { skills: [], skillProposals: [], pruned: [] },
): AgentLibraryItem {
  const a = row.agent;
  const activity = activityOf(row);
  const growth: AgentGrowth = { reuseCount: row.reuseCount, allowedRuleCount: row.allowedRuleCount, tightenedCount: row.tightenedCount, skillCount: row.skillCount };
  const born = [...asks].reverse().find((x) => x.is_new) ?? null;
  return {
    id: a.id,
    name: a.name,
    nameSource: a.name_source,
    role: a.role,
    roleLabel: a.role === null ? null : ROLE_LABELS[a.role],
    // removed は一覧に出ない（SQL で除く）ので、ここに来るのは4つの状態だけ
    status: a.status as AgentLibraryItem["status"],
    activity: activity.state,
    activityText: activity.text,
    disabledReason: a.status === "disabled" ? a.disabled_reason : null,
    jobCount: row.jobCount,
    askCount: row.askCount,
    taskCount: row.taskCount,
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    createdAt: a.created_at.toISOString(),
    bornAskId: row.bornAskId ?? born?.ask_id ?? null,
    growth,
    growthLine: growthLineOf(growth),
    asks: asks.map(askView),
    jobs: jobs.map(jobView),
    skills: [...evolution.skills],
    skillProposals: [...evolution.skillProposals],
    pruned: [...evolution.pruned],
  };
}

/** 担当ごとに問い合わせず、ワークスペース単位で3回引いて担当に配る */
export async function buildAgentLibrary(q: Queryable, ctx: WsCtx, now: Date = new Date()): Promise<AgentLibraryResponse> {
  const rows = await listAgentLibrary(q, ctx);
  const ids = rows.map((r) => r.agent.id);
  const [asks, jobs, skills, proposals, events] = await Promise.all([
    listAgentAsks(q, ctx, ids, AGENT_LIST_LIMITS.asksPerAgent),
    listAgentJobs(q, ctx, ids),
    listWorkspaceActiveSkills(q, ctx),
    listPendingSkillProposals(q, ctx),
    listRecentEvolutionEvents(q, ctx, { since: new Date(now.getTime() - PRUNED_VISIBLE_MS) }),
  ]);
  const group = <T extends { agent_id: string }, V>(rows: readonly T[], f: (r: T) => V): Map<string, V[]> => {
    const m = new Map<string, V[]>();
    for (const r of rows) {
      const list = m.get(r.agent_id);
      if (list === undefined) m.set(r.agent_id, [f(r)]);
      else list.push(f(r));
    }
    return m;
  };
  const skillsBy = group(skills, skillView);
  const proposalsBy = group(proposals, proposalView);
  const prunedBy = group(events, prunedView);
  const asksBy = new Map<string, AgentAskRow[]>();
  for (const a of asks) asksBy.set(a.agent_id, [...(asksBy.get(a.agent_id) ?? []), a]);
  const jobsBy = new Map<string, AgentJobSummaryRow[]>();
  for (const j of jobs) jobsBy.set(j.agent_id, [...(jobsBy.get(j.agent_id) ?? []), j]);
  return {
    items: rows.map((r) => libraryItem(r, asksBy.get(r.agent.id) ?? [], jobsBy.get(r.agent.id) ?? [], {
        skills: skillsBy.get(r.agent.id) ?? [],
        skillProposals: proposalsBy.get(r.agent.id) ?? [],
        pruned: prunedBy.get(r.agent.id) ?? [],
      })),
    limit: FORMATION_LIMITS.maxAgentsPerWorkspace,
    count: rows.length,
  };
}
