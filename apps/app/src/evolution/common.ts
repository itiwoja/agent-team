// 「チームが使うほど育つ」の共通部分（learn.ts・prune.ts・actions.ts が使う）：期間の定数・ルールの表示名・effective_policies の作り直し・事象の書き方

import type { EffectivePolicies, JsonObject, Tx, Uuid, WsCtx } from "@open-team/db";
import { getLatestWorkspacePolicy } from "@open-team/db/app";
import { appendWorkspaceEvent } from "@open-team/db/app";
import { CEILINGS_VERSION, DEFAULT_CEILINGS, composeAll, parseWorkspacePolicy, validateAgentDefinition } from "@open-team/kernel";
import type { AgentDefinition, Json, Rule } from "@open-team/kernel";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** 使われていないと見る日数（スキルもルールも） */
export const IDLE_MS = 30 * DAY_MS;
/** 整理を走らせる間隔（毎分の tick で毎回は走査しない） */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** 整理の 1 回の走査の上限（偏りを避けるため多めに取る） */
export const PRUNE_SCAN_LIMIT = 200;
/** スキルの案を作る走査の上限（1 回の tick で多くて 2 体） */
export const LEARN_SCAN_LIMIT = 2;

/** 画面に出すルールの表示名（「<ツール名>（<固定の値>）」。最大 60 文字） */
export function ruleLabel(rule: Pick<Rule, "action" | "match">): string {
  const tool = rule.action.replace(/^mcp\./, "");
  const values = Object.values(rule.match ?? {})
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(String)
    .slice(0, 2);
  const text = values.length === 0 ? tool : `${tool}（${values.join("、")}）`;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

export interface BuiltDefinition {
  definition: JsonObject;
  effectivePolicies: EffectivePolicies;
  clamped: Json[];
  ceilingsVersion: string;
}

export type BuildDefinitionResult = { ok: true; built: BuiltDefinition } | { ok: false; reason: "schema_invalid" | "no_policy" | "exceeds_policy" };

/** 定義から effective_policies を作り直す（apply.ts の applyTightening と同じ kernel の関数：validateAgentDefinition → composeAll） */
export async function buildDefinition(q: Parameters<typeof getLatestWorkspacePolicy>[0], ctx: WsCtx, raw: unknown): Promise<BuildDefinitionResult> {
  const v = validateAgentDefinition(raw);
  if (!v.ok) return { ok: false, reason: "schema_invalid" };
  const policyRow = await getLatestWorkspacePolicy(q, ctx);
  if (policyRow === null) return { ok: false, reason: "no_policy" };
  const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy: parseWorkspacePolicy(policyRow.policy), agent: v.definition });
  if (composed.violations.length > 0) return { ok: false, reason: "exceeds_policy" };
  const definition: AgentDefinition = v.definition;
  return {
    ok: true,
    built: {
      definition: definition as unknown as JsonObject,
      effectivePolicies: Object.fromEntries(Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash }])),
      clamped: composed.clamped as unknown as Json[],
      ceilingsVersion: CEILINGS_VERSION,
    },
  };
}

/** workspace_events に書く（業務の変更と同じトランザクション。画面は SSE で受ける） */
export async function emitEvolutionEvent(tx: Tx, ctx: WsCtx, type: "agent.skill_proposed" | "agent.evolution.pruned" | "agent.evolution.restored", data: Record<string, Json>, now: Date): Promise<void> {
  await appendWorkspaceEvent(tx, ctx, { type, data: { type, ...data } as Json }, now);
}

export type { Uuid };
