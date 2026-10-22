// 人の操作：スキルの案の承認・却下、整理で外したものを戻す（HTTP のルートが呼ぶ。権限は owner・maintainer をルート側で確かめる）
// - 承認：learned のスキルを足す（approved_digest = skillDigest）→ 案を approved にする。承認するまでスキルにならない
// - 戻す：スキルは removed_at を外す。ルールは外した設定変更の patch（remove の value）から値を取り出して今の定義に足し直す（widen・origin = revert）
// エラー：NOT_FOUND（案・記録・担当が違う）／PROPOSAL_NOT_PENDING（案がもう決まっている）／CHANGE_NOT_PENDING（もう戻している）／
// RULE_NOT_ALLOWED（ルールが上限・戻す値が読めない）／VALIDATION_ERROR（同じ名前のスキルがすでにある）／KILL_SWITCH_ENGAGED／AGENT_EXCEEDS_POLICY／AGENT_SCHEMA_INVALID

import { appendAuditLog, getWorkspace, lockWorkspace, type Json, type SessionCtx, type Uuid } from "@open-team/db";
import { getAgent, getLatestWorkspacePolicy, listConnectors, listConnectorTools } from "@open-team/db/app";
import { getAgentSnapshotRow } from "@open-team/db/edge";
import {
  applyRuleRestoreChange,
  decideSkillProposal,
  getEvolutionEvent,
  getSkillProposal,
  listAgentSkillsIncludingRemoved,
  markEvolutionItemRestored,
  restoreSkill,
} from "@open-team/db/evolution";
import { insertAgentSkill } from "@open-team/db/sandbox";
import { skillDigest } from "@open-team/edge";
import { DEFAULT_CEILINGS, RULES_MAX_PER_AGENT, classify, parseWorkspacePolicy, type AgentDefinitionInput, type Rule } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import { catalogOf } from "../owner-setup.ts";
import { publishCheckRemove } from "../check/events.ts";
import { buildDefinition, emitEvolutionEvent } from "./common.ts";

type ActionDeps = Pick<AppDeps, "db" | "clock">;

export async function decideSkillProposalAction(
  deps: ActionDeps,
  s: SessionCtx,
  agentId: Uuid,
  proposalId: Uuid,
  decision: "approve" | "reject",
): Promise<{ proposalId: Uuid; status: "approved" | "rejected"; skillId: Uuid | null }> {
  const now = deps.clock.now();
  const ws = await getWorkspace(deps.db, s);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");

  return deps.db.transaction(async (tx) => {
    await lockWorkspace(tx, s);
    const p = await getSkillProposal(tx, s, proposalId);
    if (p === null || p.agent_id !== agentId) throw new AppError("NOT_FOUND");
    if (p.status !== "proposed") throw new AppError("PROPOSAL_NOT_PENDING");
    if (p.name === null || p.description === null || p.body === null) throw new AppError("INTERNAL_ERROR", "案に中身がありません");

    let skillId: Uuid | null = null;
    if (decision === "approve") {
      // 同じ名前の使えるスキルを上書きしない（外したものは置き換えてよい）
      const same = (await listAgentSkillsIncludingRemoved(tx, s, agentId)).find((k) => k.name === p.name);
      if (same !== undefined && same.removed_at === null) {
        throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "name", reason: "同じ名前のスキルがすでにあります" }] });
      }
      const skill = await insertAgentSkill(tx, s, {
        agentId,
        name: p.name,
        description: p.description,
        body: p.body,
        packId: null,
        now,
        origin: "learned",
        approvedBy: s.userId,
        approvedAt: now,
        approvedDigest: skillDigest({ name: p.name, description: p.description, body: p.body }),
        proposalId: p.id,
      });
      skillId = skill.id;
    }
    const decided = await decideSkillProposal(tx, s, { id: p.id, status: decision === "approve" ? "approved" : "rejected", decidedBy: s.userId, skillId, now });
    if (decided === null) throw new AppError("PROPOSAL_NOT_PENDING");
    await appendAuditLog(
      tx,
      s.workspaceId,
      { eventType: decision === "approve" ? "agent.skill.approved" : "agent.skill.rejected", actorType: "user", actorId: s.userId, payload: { agentId, proposalId: p.id, skillId, name: p.name } },
      now,
    );
    await publishCheckRemove(tx, s, `skill_proposal:${p.id}`, now);
    return { proposalId: p.id, status: decided.status as "approved" | "rejected", skillId };
  });
}

/** 外した設定変更の patch から、外したルールの値を取り出す（prune.ts が remove の value に入れたもの） */
function removedRuleOf(patch: readonly Json[], ruleId: string): Rule | null {
  for (const op of patch) {
    if (op === null || typeof op !== "object" || Array.isArray(op)) continue;
    const v = op.value;
    if (op.op === "remove" && typeof op.path === "string" && op.path.startsWith("/rules/") && v !== null && typeof v === "object" && !Array.isArray(v) && v.id === ruleId) {
      return v as unknown as Rule;
    }
  }
  return null;
}

export async function restoreEvolutionItemAction(
  deps: ActionDeps,
  s: SessionCtx,
  agentId: Uuid,
  eventId: Uuid,
  item: { type: "skill" | "rule"; id: string },
): Promise<{ eventId: Uuid; type: "skill" | "rule"; id: string; restoredAt: string }> {
  const now = deps.clock.now();
  const ws = await getWorkspace(deps.db, s);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");

  return deps.db.transaction(async (tx) => {
    await lockWorkspace(tx, s);
    const event = await getEvolutionEvent(tx, s, eventId);
    if (event === null || event.agent_id !== agentId) throw new AppError("NOT_FOUND");
    const entry = event.items.find((i) => i.type === item.type && i.id === item.id);
    if (entry === undefined) throw new AppError("NOT_FOUND");
    if (entry.restoredAt !== null) throw new AppError("CHANGE_NOT_PENDING", "すでに戻しています");

    if (item.type === "skill") {
      const row = await restoreSkill(tx, s, item.id, now);
      if (row === null || row.agent_id !== agentId) throw new AppError("CHANGE_NOT_PENDING", "すでに戻しています");
    } else {
      if (event.config_change_id === null) throw new AppError("NOT_FOUND");
      const change = await tx.query<{ patch: Json[] }>("SELECT patch FROM agent_config_changes WHERE workspace_id = $1 AND id = $2 AND agent_id = $3", [s.workspaceId, event.config_change_id, agentId]);
      const removedRule = removedRuleOf(change.rows[0]?.patch ?? [], item.id);
      if (removedRule === null) throw new AppError("NOT_FOUND");
      // 戻した時刻から数え直す（古い added_at のままだと次の整理ですぐまた外れる。スキルの last_used_at = now と同じ）
      const rule: Rule = { ...removedRule, added_at: now.toISOString() };
      const agent = await getAgent(tx, s, agentId);
      if (agent === null || agent.current_snapshot_id === null) throw new AppError("NOT_FOUND");
      const snap = await getAgentSnapshotRow(tx, s, agent.current_snapshot_id);
      const current = snap?.definition as { rules?: Rule[] } | null | undefined;
      if (snap === null || !current) throw new AppError("NOT_FOUND");
      const rules = Array.isArray(current.rules) ? current.rules : [];
      // 同じ id がもう今の定義にあれば足さずに、戻した印だけ付ける
      if (!rules.some((r) => r.id === rule.id)) {
        if (rules.length + 1 > RULES_MAX_PER_AGENT) {
          throw new AppError("RULE_NOT_ALLOWED", "ルールが上限（20個）に達しているので戻せません", { details: { failedConditions: ["limit"] } });
        }
        const after = { ...current, rules: [...rules, rule] };
        const built = await buildDefinition(tx, s, after);
        if (!built.ok) {
          throw new AppError(built.reason === "exceeds_policy" ? "AGENT_EXCEEDS_POLICY" : built.reason === "schema_invalid" ? "AGENT_SCHEMA_INVALID" : "INTERNAL_ERROR");
        }
        // 広げる項目は classify に任せる（承認の [以後も許可] と同じ）
        const policyRow = await getLatestWorkspacePolicy(tx, s);
        if (policyRow === null) throw new AppError("INTERNAL_ERROR", "ワークスペースのポリシーがありません");
        const cls = classify({
          before: current as unknown as AgentDefinitionInput,
          after: built.built.definition as unknown as AgentDefinitionInput,
          ctx: { ceilings: DEFAULT_CEILINGS, workspacePolicy: parseWorkspacePolicy(policyRow.policy), tools: catalogOf(await listConnectors(tx, s), await listConnectorTools(tx, s)) },
        });
        if (cls.violations.length > 0) throw new AppError("AGENT_EXCEEDS_POLICY", undefined, { details: cls.violations });
        const done = await applyRuleRestoreChange(tx, s, {
          agentId,
          patch: [{ op: "add", path: "/rules/-", value: rule as unknown as Json }],
          widenedItems: cls.widenItems as unknown as Json[],
          expectedSnapshotId: snap.id,
          definition: built.built.definition,
          effectivePolicies: built.built.effectivePolicies,
          clamped: built.built.clamped,
          ceilingsVersion: built.built.ceilingsVersion,
          now,
          revertsChangeId: event.config_change_id,
          ruleId: rule.id,
          decidedBy: s.userId,
        });
        if (done === null) throw new AppError("CHANGE_NOT_PENDING", "設定が別の変更で更新されました。読み直してください");
      }
    }

    const marked = await markEvolutionItemRestored(tx, s, eventId, item.type, item.id, now);
    if (marked === null) throw new AppError("CHANGE_NOT_PENDING", "すでに戻しています");
    await appendAuditLog(tx, s.workspaceId, { eventType: "agent.evolution.restored", actorType: "user", actorId: s.userId, payload: { agentId, eventId, type: item.type, id: item.id } }, now);
    await emitEvolutionEvent(tx, s, "agent.evolution.restored", { agentId, eventId, itemType: item.type, itemId: item.id }, now);
    return { eventId, type: item.type, id: item.id, restoredAt: now.toISOString() };
  });
}
