// 使っていないスキル・ルールの整理（毎分の tick の手順 prune。1時間に1回だけ走る）
// - スキル：30日使われていない（coalesce(last_used_at, approved_at, created_at)）ものの removed_at を埋める
// - ルール：本番の判定で最後に一致した時刻と added_at の新しい方が30日より前のものを、定義から外した新しいスナップショット（origin = prune・narrow）にする。
//   外したルールの値は patch の remove に value として残す（戻すときに actions.ts がここから読む）。patch の remove は添字の大きい順
// - 外したら agent_evolution_events に1行・監査ログ agent.evolution.pruned・workspace_events を同じトランザクションで書く
// - スナップショットが動いていたら（判定してから別の変更が入った）その担当は今回は飛ばす

import { appendAuditLog, lockWorkspace, system, wsCtxOf, type Json, type Uuid, type WsCtx } from "@open-team/db";
import { getAgent } from "@open-team/db/app";
import { getAgentSnapshotRow } from "@open-team/db/edge";
import { applyPruneChange, insertEvolutionEvent, listStaleSkills, markSkillsRemoved, ruleLastMatchedAt } from "@open-team/db/evolution";
import type { EvolutionItem } from "@open-team/db";
import type { Rule } from "@open-team/kernel";
import type { AppDeps, TickStep } from "../deps.ts";
import { IDLE_MS, PRUNE_INTERVAL_MS, PRUNE_SCAN_LIMIT, buildDefinition, emitEvolutionEvent, ruleLabel } from "./common.ts";

export interface PruneAgentResult {
  skills: number;
  rules: number;
  eventId: Uuid | null;
}

/** 1体ぶん。外したものがなければ何も書かない */
export async function pruneAgent(deps: Pick<AppDeps, "db" | "log">, ctx: WsCtx, agentId: Uuid, now: Date): Promise<PruneAgentResult> {
  const before = new Date(now.getTime() - IDLE_MS);
  return deps.db.transaction(async (tx): Promise<PruneAgentResult> => {
    await lockWorkspace(tx, ctx);
    const none: PruneAgentResult = { skills: 0, rules: 0, eventId: null };
    const agent = await getAgent(tx, ctx, agentId);
    if (agent === null || agent.status === "removed") return none;
    const items: EvolutionItem[] = [];
    let configChangeId: Uuid | null = null;

    // ルール（先に。スナップショットが動いていたら担当ごと飛ばす）
    const snap = agent.current_snapshot_id === null ? null : await getAgentSnapshotRow(tx, ctx, agent.current_snapshot_id);
    const definition = snap?.definition as { rules?: Rule[] } | null | undefined;
    const rules = Array.isArray(definition?.rules) ? definition.rules : [];
    if (snap !== null && snap !== undefined && definition && rules.length > 0) {
      const matched = await ruleLastMatchedAt(tx, ctx, agentId);
      const stale: { index: number; rule: Rule }[] = [];
      rules.forEach((rule, index) => {
        const added = new Date(rule.added_at).getTime();
        const lastMatch = matched.get(rule.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
        const newest = Math.max(Number.isFinite(added) ? added : Number.NEGATIVE_INFINITY, lastMatch);
        if (newest < before.getTime()) stale.push({ index, rule });
      });
      if (stale.length > 0) {
        const staleIds = new Set(stale.map((s) => s.rule.id));
        const built = await buildDefinition(tx, ctx, { ...definition, rules: rules.filter((r) => !staleIds.has(r.id)) });
        if (!built.ok) {
          deps.log.warn("evolution.prune_rules_skipped", "ルールを外した定義を作れなかった", { workspaceId: ctx.workspaceId, agentId, reason: built.reason });
        } else {
          const patch = [...stale].sort((a, b) => b.index - a.index).map((s) => ({ op: "remove", path: `/rules/${s.index}`, value: s.rule as unknown as Json }));
          const done = await applyPruneChange(tx, ctx, {
            agentId,
            patch: patch as Json[],
            expectedSnapshotId: snap.id,
            definition: built.built.definition,
            effectivePolicies: built.built.effectivePolicies,
            clamped: built.built.clamped,
            ceilingsVersion: built.built.ceilingsVersion,
            now,
            removedRuleIds: stale.map((s) => s.rule.id),
          });
          // 判定のあとにスナップショットが動いた：今回は飛ばす（次の整理で取り直す）
          if (done === null) return none;
          configChangeId = done.changeId;
          for (const s of stale) items.push({ type: "rule", id: s.rule.id, label: ruleLabel(s.rule), restoredAt: null });
        }
      }
    }

    // スキル
    const staleSkills = (await listStaleSkills(tx, ctx, before)).filter((s) => s.agent_id === agentId);
    const removed = await markSkillsRemoved(tx, ctx, staleSkills.map((s) => s.id), now);
    for (const s of removed) items.push({ type: "skill", id: s.id, label: s.name, restoredAt: null });

    if (items.length === 0) return none;
    const event = await insertEvolutionEvent(tx, ctx, { agentId, items, configChangeId, now });
    const skillCount = items.filter((i) => i.type === "skill").length;
    const ruleCount = items.length - skillCount;
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      {
        eventType: "agent.evolution.pruned",
        actorType: "system",
        actorId: "evolution",
        payload: { agentId, eventId: event.id, configChangeId, skillIds: items.filter((i) => i.type === "skill").map((i) => i.id), ruleIds: items.filter((i) => i.type === "rule").map((i) => i.id) },
      },
      now,
    );
    await emitEvolutionEvent(tx, ctx, "agent.evolution.pruned", { agentId, eventId: event.id, skills: skillCount, rules: ruleCount }, now);
    return { skills: skillCount, rules: ruleCount, eventId: event.id };
  });
}

/** 1時間に1回だけ走る手順を作る（前回の時刻は手順のクロージャに持つ。試験は作り直して使う） */
export function createPruneStep(intervalMs: number = PRUNE_INTERVAL_MS): TickStep {
  let lastRunAt: number | null = null;
  return {
    name: "prune",
    async run(deps, now) {
      if (lastRunAt !== null && now.getTime() - lastRunAt < intervalMs) return {};
      lastRunAt = now.getTime();
      for (const t of await system.scanAgentsForPruning(deps.db, now, { limit: PRUNE_SCAN_LIMIT })) {
        try {
          await pruneAgent(deps, wsCtxOf({ id: t.workspaceId, kind: "owner" }), t.agentId, now);
        } catch (error) {
          deps.log.warn("evolution.prune_failed", "整理できなかった", { workspaceId: t.workspaceId, agentId: t.agentId, error });
        }
      }
      return {};
    },
  };
}

export const pruneStep: TickStep = createPruneStep();
