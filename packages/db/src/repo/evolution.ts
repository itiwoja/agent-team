// チームが使うほど育つ（0022）の問い合わせ：スキルの案（skill_proposals）・スキルの使用と整理（agent_skills）・
// ルールの整理（設定変更 origin = 'prune'・'revert'）・整理の記録（agent_evolution_events）。
// README §1 の約束に従い、SQL を必ず workspace_id で絞る。トランザクションの中で外部（LLM）を呼ばない（G-14）。
// ワークスペースをまたぐ走査は system/evolution.ts

import type { Json, JsonObject } from "@open-team/kernel";
import { appendAuditLog } from "../audit.ts";
import type { Queryable, Tx } from "../client.ts";
import type { AgentEvolutionEventRow, AgentSkillRow, EffectivePolicies, EvolutionItem, SkillProposalRow, Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";

async function maybe<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T | null> {
  const r = await q.query<T>(text, params);
  return r.rows[0] ?? null;
}

// ---- スキル ----

/** 外したものも含めた担当のスキル（名前の順。「外したもの」の一覧と戻す操作に使う） */
export async function listAgentSkillsIncludingRemoved(q: Queryable, ctx: WsCtx, agentId: Uuid): Promise<AgentSkillRow[]> {
  const r = await q.query<AgentSkillRow>("SELECT * FROM agent_skills WHERE workspace_id = $1 AND agent_id = $2 ORDER BY name", [ctx.workspaceId, agentId]);
  return r.rows;
}

/** 本番のタスクで load_skill で読んだ時刻を残す */
export async function touchSkillUsed(q: Queryable, ctx: WsCtx, skillId: Uuid, now: Date): Promise<void> {
  await q.query("UPDATE agent_skills SET last_used_at = $3 WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, skillId, now]);
}

/** 使われていないスキル：外していなくて、coalesce(last_used_at, approved_at, created_at) が before より前（ちょうど before は含めない） */
export async function listStaleSkills(q: Queryable, ctx: WsCtx, before: Date): Promise<AgentSkillRow[]> {
  const r = await q.query<AgentSkillRow>(
    `SELECT * FROM agent_skills
      WHERE workspace_id = $1 AND removed_at IS NULL AND coalesce(last_used_at, approved_at, created_at) < $2
      ORDER BY agent_id, name`,
    [ctx.workspaceId, before],
  );
  return r.rows;
}

/** スキルを外す（まだ外していないものだけ。外した行を返す） */
export async function markSkillsRemoved(tx: Tx, ctx: WsCtx, skillIds: readonly Uuid[], now: Date): Promise<AgentSkillRow[]> {
  if (skillIds.length === 0) return [];
  const r = await tx.query<AgentSkillRow>(
    "UPDATE agent_skills SET removed_at = $3 WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND removed_at IS NULL RETURNING *",
    [ctx.workspaceId, skillIds, now],
  );
  return r.rows;
}

/** 外したスキルを戻す（使った時刻を now にして、すぐ次の整理で外れないようにする）。外していなければ null */
export async function restoreSkill(tx: Tx, ctx: WsCtx, skillId: Uuid, now: Date): Promise<AgentSkillRow | null> {
  return maybe<AgentSkillRow>(
    tx,
    "UPDATE agent_skills SET removed_at = NULL, last_used_at = $3 WHERE workspace_id = $1 AND id = $2 AND removed_at IS NOT NULL RETURNING *",
    [ctx.workspaceId, skillId, now],
  );
}

// ---- スキルの案 ----

export interface InsertSkillProposalInput {
  agentId: Uuid;
  status: "proposed" | "skipped";
  name?: string | null;
  description?: string | null;
  body?: string | null;
  reason?: string | null;
  sourceTaskIds: readonly Uuid[];
  now: Date;
}

/** 案（proposed）か「繰り返しの手順はない」の印（skipped）を保存する。skipped 以外は name・description・body が要る（DB の CHECK） */
export async function insertSkillProposal(tx: Tx, ctx: WsCtx, v: InsertSkillProposalInput): Promise<SkillProposalRow> {
  const r = await tx.query<SkillProposalRow>(
    `INSERT INTO skill_proposals (workspace_id, agent_id, status, name, description, body, reason, source_task_ids, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9) RETURNING *`,
    [ctx.workspaceId, v.agentId, v.status, v.name ?? null, v.description ?? null, v.body ?? null, v.reason ?? null, v.sourceTaskIds, v.now],
  );
  return r.rows[0]!;
}

/** 決めていない案（proposed。新しい順）。agentId を渡せばその担当だけ */
export async function listPendingSkillProposals(q: Queryable, ctx: WsCtx, agentId?: Uuid): Promise<SkillProposalRow[]> {
  const r = await q.query<SkillProposalRow>(
    `SELECT * FROM skill_proposals WHERE workspace_id = $1 AND status = 'proposed' AND ($2::uuid IS NULL OR agent_id = $2)
      ORDER BY created_at DESC, id`,
    [ctx.workspaceId, agentId ?? null],
  );
  return r.rows;
}

export async function getSkillProposal(q: Queryable, ctx: WsCtx, id: Uuid): Promise<SkillProposalRow | null> {
  return maybe<SkillProposalRow>(q, "SELECT * FROM skill_proposals WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, id]);
}

/** 案を決める。proposed のときだけ更新し、すでに決めていた（二重の決定）・なければ null */
export async function decideSkillProposal(
  tx: Tx,
  ctx: WsCtx,
  v: { id: Uuid; status: "approved" | "rejected"; decidedBy: Uuid; skillId?: Uuid | null; now: Date },
): Promise<SkillProposalRow | null> {
  return maybe<SkillProposalRow>(
    tx,
    `UPDATE skill_proposals SET status = $3, decided_by = $4, decided_at = $5, skill_id = $6
      WHERE workspace_id = $1 AND id = $2 AND status = 'proposed' RETURNING *`,
    [ctx.workspaceId, v.id, v.status, v.decidedBy, v.now, v.skillId ?? null],
  );
}

/** 担当の最後の案（skipped を含む）を作った時刻。次の判定は、これより後に終わったタスクを数える */
export async function lastSkillProposalAt(q: Queryable, ctx: WsCtx, agentId: Uuid): Promise<Date | null> {
  const r = await maybe<{ at: Date | null }>(q, "SELECT max(created_at) AS at FROM skill_proposals WHERE workspace_id = $1 AND agent_id = $2", [ctx.workspaceId, agentId]);
  return r?.at ?? null;
}

export interface LiveSucceededTask {
  taskId: Uuid;
  finishedAt: Date;
  /** 仕事の指示（タスクの prompt。なければ依頼の文） */
  instruction: string | null;
  /** 最後の報告の本文（tasks.report） */
  report: string;
  reportTitle: string | null;
}

/**
 * 本番（is_dry_run でない・rehearsal_run_id がない・shadow でない）で成功して終わったタスク（finished_at が since より後。新しい順）。
 * 成功 = succeeded か completed で報告（report）があるもの
 */
export async function listRecentLiveSucceededTasks(
  q: Queryable,
  ctx: WsCtx,
  agentId: Uuid,
  o: { since: Date; limit: number },
): Promise<LiveSucceededTask[]> {
  const r = await q.query<{ id: Uuid; finished_at: Date; instruction: string | null; report: string; report_title: string | null }>(
    `SELECT t.id, t.finished_at, coalesce(t.prompt, k.text) AS instruction, t.report, t.report_title
       FROM tasks t LEFT JOIN asks k ON k.workspace_id = t.workspace_id AND k.id = t.ask_id
      WHERE t.workspace_id = $1 AND t.agent_id = $2 AND t.status IN ('succeeded','completed') AND t.report IS NOT NULL
        AND NOT t.is_dry_run AND t.rehearsal_run_id IS NULL AND NOT t.shadow AND t.finished_at > $3
      ORDER BY t.finished_at DESC, t.id
      LIMIT $4`,
    [ctx.workspaceId, agentId, o.since, o.limit],
  );
  return r.rows.map((x) => ({ taskId: x.id, finishedAt: x.finished_at, instruction: x.instruction, report: x.report, reportTitle: x.report_title }));
}

// ---- ルールの整理 ----

/** ルールが本番の判定で最後に一致した時刻（ルールの id → 時刻。一度も一致していなければ入らない。0015 のコメントの問い合わせ） */
export async function ruleLastMatchedAt(q: Queryable, ctx: WsCtx, agentId: Uuid): Promise<Map<string, Date>> {
  const r = await q.query<{ matched_rule_id: string; last_matched_at: Date }>(
    `SELECT d.matched_rule_id, max(d.created_at) AS last_matched_at
       FROM policy_decisions d JOIN tasks t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
      WHERE d.workspace_id = $1 AND t.agent_id = $2 AND d.matched_rule_id IS NOT NULL AND d.reason_code = 'rule_matched' AND d.enforced
        AND t.is_dry_run = false AND t.rehearsal_run_id IS NULL AND NOT t.shadow
      GROUP BY d.matched_rule_id`,
    [ctx.workspaceId, agentId],
  );
  return new Map(r.rows.map((x) => [x.matched_rule_id, x.last_matched_at]));
}

interface ConfigChangeInput {
  agentId: Uuid;
  patch: Json[];
  /** 判定したときの今のスナップショット。動いていたら null を返す（古い定義に足さない・消さない） */
  expectedSnapshotId: Uuid;
  definition: JsonObject;
  effectivePolicies: EffectivePolicies;
  clamped: Json[];
  ceilingsVersion: string;
  now: Date;
}

export type ApplyPruneChangeInput = ConfigChangeInput & {
  /** 外したルールの id（監査ログに残す） */
  removedRuleIds: string[];
};

/** 設定変更（proposed）→ スナップショット → applied にして agents の今のスナップショットを付け替える。共通部分 */
async function applyConfigChange(
  tx: Tx,
  ctx: WsCtx,
  i: ConfigChangeInput,
  c: { origin: "prune" | "revert"; classification: "narrow" | "widen"; widenedItems: Json[] | null; revertsChangeId: Uuid | null; decidedBy: Uuid | null },
): Promise<{ changeId: Uuid; snapshotId: Uuid } | null> {
  const cur = await maybe<{ current_snapshot_id: Uuid | null }>(tx, "SELECT current_snapshot_id FROM agents WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
    ctx.workspaceId,
    i.agentId,
  ]);
  if (cur === null || cur.current_snapshot_id !== i.expectedSnapshotId) return null;
  const proposed = await maybe<{ id: Uuid }>(
    tx,
    `INSERT INTO agent_config_changes (workspace_id, agent_id, origin, patch, classification, widened_items, reverts_change_id, status, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, 'proposed', $8) RETURNING id`,
    [ctx.workspaceId, i.agentId, c.origin, i.patch as never, c.classification, c.widenedItems as never, c.revertsChangeId, i.now],
  );
  if (proposed === null) throw new Error("設定変更を作れなかった");
  const snapshot = await maybe<{ id: Uuid }>(
    tx,
    `INSERT INTO agent_snapshots (workspace_id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
     VALUES ($1, $2, $3, 'in_app', 'valid', $4::jsonb, $5::jsonb, $6::jsonb, $7, $8) RETURNING id`,
    [ctx.workspaceId, i.agentId, proposed.id, i.definition as never, i.effectivePolicies as never, i.clamped as never, i.ceilingsVersion, i.now],
  );
  if (snapshot === null) throw new Error("スナップショットを作れなかった");
  await tx.query(
    "UPDATE agent_config_changes SET status = 'applied', snapshot_id = $3, decided_by = $4, decided_at = $5 WHERE workspace_id = $1 AND id = $2",
    [ctx.workspaceId, proposed.id, snapshot.id, c.decidedBy, i.now],
  );
  await tx.query("UPDATE agents SET current_snapshot_id = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, i.agentId, snapshot.id, i.now]);
  return { changeId: proposed.id, snapshotId: snapshot.id };
}

/**
 * 使われていないルールを外す設定変更を保存する（origin = prune・narrow・applied・decided_by NULL = システム）。
 * 監査ログ agent.config.narrowed。agent.evolution.pruned と workspace_events は呼び出し側が足す
 */
export async function applyPruneChange(tx: Tx, ctx: WsCtx, i: ApplyPruneChangeInput): Promise<{ changeId: Uuid; snapshotId: Uuid } | null> {
  const done = await applyConfigChange(tx, ctx, i, { origin: "prune", classification: "narrow", widenedItems: null, revertsChangeId: null, decidedBy: null });
  if (done === null) return null;
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "agent.config.narrowed",
      actorType: "system",
      actorId: "evolution",
      payload: {
        agentId: i.agentId,
        changeId: done.changeId,
        snapshotId: done.snapshotId,
        previousSnapshotId: i.expectedSnapshotId,
        classification: "narrow",
        origin: "prune",
        removedRuleIds: i.removedRuleIds,
        patch: i.patch,
      },
    },
    i.now,
  );
  return done;
}

export type ApplyRuleRestoreChangeInput = ConfigChangeInput & {
  /** 戻す（足し直す）ルール。widen の設定変更には widened_items が要る（DB の CHECK） */
  widenedItems: Json[];
  /** 外したときの設定変更（prune） */
  revertsChangeId: Uuid;
  ruleId: string;
  decidedBy: Uuid;
};

/** 外したルールを足し直す設定変更を保存する（origin = revert・widen・applied）。監査ログ agent.config.widened */
export async function applyRuleRestoreChange(tx: Tx, ctx: WsCtx, i: ApplyRuleRestoreChangeInput): Promise<{ changeId: Uuid; snapshotId: Uuid } | null> {
  const done = await applyConfigChange(tx, ctx, i, {
    origin: "revert",
    classification: "widen",
    widenedItems: i.widenedItems,
    revertsChangeId: i.revertsChangeId,
    decidedBy: i.decidedBy,
  });
  if (done === null) return null;
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "agent.config.widened",
      actorType: "user",
      actorId: i.decidedBy,
      payload: {
        agentId: i.agentId,
        changeId: done.changeId,
        snapshotId: done.snapshotId,
        previousSnapshotId: i.expectedSnapshotId,
        classification: "widen",
        origin: "revert",
        widenedItems: i.widenedItems,
        revertsChangeId: i.revertsChangeId,
        ruleId: i.ruleId,
      },
    },
    i.now,
  );
  return done;
}

// ---- 整理の記録 ----

export async function insertEvolutionEvent(
  tx: Tx,
  ctx: WsCtx,
  v: { agentId: Uuid; items: readonly EvolutionItem[]; configChangeId: Uuid | null; now: Date },
): Promise<AgentEvolutionEventRow> {
  const r = await tx.query<AgentEvolutionEventRow>(
    `INSERT INTO agent_evolution_events (workspace_id, agent_id, kind, items, config_change_id, created_at)
     VALUES ($1, $2, 'pruned', $3::jsonb, $4, $5) RETURNING *`,
    [ctx.workspaceId, v.agentId, v.items as never, v.configChangeId, v.now],
  );
  return r.rows[0]!;
}

/** since 以降の整理の記録（新しい順。担当をまたぐ） */
export async function listRecentEvolutionEvents(q: Queryable, ctx: WsCtx, o: { since: Date }): Promise<AgentEvolutionEventRow[]> {
  const r = await q.query<AgentEvolutionEventRow>(
    "SELECT * FROM agent_evolution_events WHERE workspace_id = $1 AND created_at >= $2 ORDER BY created_at DESC, id",
    [ctx.workspaceId, o.since],
  );
  return r.rows;
}

export async function getEvolutionEvent(q: Queryable, ctx: WsCtx, id: Uuid): Promise<AgentEvolutionEventRow | null> {
  return maybe<AgentEvolutionEventRow>(q, "SELECT * FROM agent_evolution_events WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, id]);
}

/** items のうち (type, id) の1件に restoredAt を入れる。その項目がない・もう戻していたら null（二重の戻しの検出） */
export async function markEvolutionItemRestored(
  tx: Tx,
  ctx: WsCtx,
  eventId: Uuid,
  type: "skill" | "rule",
  id: string,
  now: Date,
): Promise<AgentEvolutionEventRow | null> {
  return maybe<AgentEvolutionEventRow>(
    tx,
    `UPDATE agent_evolution_events e SET items = (
         SELECT jsonb_agg(
                  CASE WHEN x.item->>'type' = $3 AND x.item->>'id' = $4 AND (x.item->>'restoredAt') IS NULL
                       THEN x.item || jsonb_build_object('restoredAt', $5::text) ELSE x.item END
                  ORDER BY x.ord)
           FROM jsonb_array_elements(e.items) WITH ORDINALITY AS x(item, ord))
      WHERE e.workspace_id = $1 AND e.id = $2
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.items) AS y(item)
                     WHERE y.item->>'type' = $3 AND y.item->>'id' = $4 AND (y.item->>'restoredAt') IS NULL)
      RETURNING e.*`,
    [ctx.workspaceId, eventId, type, id, now.toISOString()],
  );
}
