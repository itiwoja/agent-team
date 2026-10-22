// packages/db/src/repo/evolution.ts と system/evolution.ts の WorkspaceDO 版。
// チームが使うほど育つ（0022）の問い合わせ：スキルの案（skill_proposals）・スキルの使用と整理（agent_skills）・
// ルールの整理（設定変更 origin = 'prune'・'revert'）・整理の記録（agent_evolution_events）。
// - DO の中の行だけを扱う（workspace_id で絞る代わり）。トランザクションの中で外部（LLM）を呼ばない（G-14）
// - Postgres 版でワークスペースをまたいでいた走査（system/evolution.ts）は、この DO の担当だけを見る（末尾の「走査」）

import type { Json, JsonObject } from "@open-team/kernel";
import { appendAuditLog } from "../audit.ts";
import { CODECS } from "../codecs.ts";
import { all, newId, one, run, type WsDb } from "../sqlite.ts";
import type { AgentEvolutionEventRow, AgentSkillRow, EffectivePolicies, EvolutionItem, SkillProposalRow, Uuid } from "../types.ts";
import { requireWorkspace } from "../workspace.ts";

// ---- スキル ----

/** 外したものも含めた担当のスキル（名前の順。「外したもの」の一覧と戻す操作に使う） */
export function listAgentSkillsIncludingRemoved(db: WsDb, agentId: Uuid): AgentSkillRow[] {
  return all<AgentSkillRow>(db, CODECS.agent_skills, "SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY name", agentId);
}

/** 本番のタスクで load_skill で読んだ時刻を残す */
export function touchSkillUsed(db: WsDb, skillId: Uuid, now: Date): void {
  run(db, "UPDATE agent_skills SET last_used_at = ? WHERE id = ?", now, skillId);
}

/** 使われていないスキル：外していなくて、coalesce(last_used_at, approved_at, created_at) が before より前（ちょうど before は含めない） */
export function listStaleSkills(db: WsDb, before: Date): AgentSkillRow[] {
  return all<AgentSkillRow>(
    db,
    CODECS.agent_skills,
    `SELECT * FROM agent_skills
      WHERE removed_at IS NULL AND coalesce(last_used_at, approved_at, created_at) < ?
      ORDER BY agent_id, name`,
    before,
  );
}

/** スキルを外す（まだ外していないものだけ。外した行を返す） */
export function markSkillsRemoved(db: WsDb, skillIds: readonly Uuid[], now: Date): AgentSkillRow[] {
  if (skillIds.length === 0) return [];
  return all<AgentSkillRow>(
    db,
    CODECS.agent_skills,
    "UPDATE agent_skills SET removed_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND removed_at IS NULL RETURNING *",
    now,
    [...skillIds],
  );
}

/** 外したスキルを戻す（使った時刻を now にして、すぐ次の整理で外れないようにする）。外していなければ null */
export function restoreSkill(db: WsDb, skillId: Uuid, now: Date): AgentSkillRow | null {
  return one<AgentSkillRow>(
    db,
    CODECS.agent_skills,
    "UPDATE agent_skills SET removed_at = NULL, last_used_at = ? WHERE id = ? AND removed_at IS NOT NULL RETURNING *",
    now,
    skillId,
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
export function insertSkillProposal(db: WsDb, v: InsertSkillProposalInput): SkillProposalRow {
  const row = one<SkillProposalRow>(
    db,
    CODECS.skill_proposals,
    `INSERT INTO skill_proposals (id, agent_id, status, name, description, body, reason, source_task_ids, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    newId(),
    v.agentId,
    v.status,
    v.name ?? null,
    v.description ?? null,
    v.body ?? null,
    v.reason ?? null,
    [...v.sourceTaskIds],
    v.now,
  );
  return row!;
}

/** 決めていない案（proposed。新しい順）。agentId を渡せばその担当だけ */
export function listPendingSkillProposals(db: WsDb, agentId?: Uuid): SkillProposalRow[] {
  return all<SkillProposalRow>(
    db,
    CODECS.skill_proposals,
    "SELECT * FROM skill_proposals WHERE status = 'proposed' AND (?1 IS NULL OR agent_id = ?1) ORDER BY created_at DESC, id",
    agentId ?? null,
  );
}

export function getSkillProposal(db: WsDb, id: Uuid): SkillProposalRow | null {
  return one<SkillProposalRow>(db, CODECS.skill_proposals, "SELECT * FROM skill_proposals WHERE id = ?", id);
}

/** 案を決める。proposed のときだけ更新し、すでに決めていた（二重の決定）・なければ null */
export function decideSkillProposal(
  db: WsDb,
  v: { id: Uuid; status: "approved" | "rejected"; decidedBy: Uuid; skillId?: Uuid | null; now: Date },
): SkillProposalRow | null {
  return one<SkillProposalRow>(
    db,
    CODECS.skill_proposals,
    "UPDATE skill_proposals SET status = ?, decided_by = ?, decided_at = ?, skill_id = ? WHERE id = ? AND status = 'proposed' RETURNING *",
    v.status,
    v.decidedBy,
    v.now,
    v.skillId ?? null,
    v.id,
  );
}

/** 担当の最後の案（skipped を含む）を作った時刻。次の判定は、これより後に終わったタスクを数える */
export function lastSkillProposalAt(db: WsDb, agentId: Uuid): Date | null {
  return one<{ at: Date | null }>(db, { at: "date" }, "SELECT max(created_at) AS at FROM skill_proposals WHERE agent_id = ?", agentId)?.at ?? null;
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
 * 本番（is_dry_run でない）で成功して終わったタスク（finished_at が since より後。新しい順）。
 * 成功 = succeeded か completed で報告（report）があるもの
 */
export function listRecentLiveSucceededTasks(db: WsDb, agentId: Uuid, o: { since: Date; limit: number }): LiveSucceededTask[] {
  return all<{ id: Uuid; finished_at: Date; instruction: string | null; report: string; report_title: string | null }>(
    db,
    CODECS.tasks,
    `SELECT t.id, t.finished_at, coalesce(t.prompt, k.text) AS instruction, t.report, t.report_title
       FROM tasks t LEFT JOIN asks k ON k.id = t.ask_id
      WHERE t.agent_id = ? AND t.status IN ('succeeded','completed') AND t.report IS NOT NULL
        AND t.is_dry_run = 0 AND t.finished_at > ?
      ORDER BY t.finished_at DESC, t.id
      LIMIT ?`,
    agentId,
    o.since,
    o.limit,
  ).map((x) => ({ taskId: x.id, finishedAt: x.finished_at, instruction: x.instruction, report: x.report, reportTitle: x.report_title }));
}

// ---- ルールの整理 ----

/** ルールが本番の判定で最後に一致した時刻（ルールの id → 時刻。一度も一致していなければ入らない。0015 のコメントの問い合わせ） */
export function ruleLastMatchedAt(db: WsDb, agentId: Uuid): Map<string, Date> {
  const rows = all<{ matched_rule_id: string; last_matched_at: Date }>(
    db,
    { last_matched_at: "date" },
    `SELECT d.matched_rule_id, max(d.created_at) AS last_matched_at
       FROM policy_decisions d JOIN tasks t ON t.id = d.task_id
      WHERE t.agent_id = ? AND d.matched_rule_id IS NOT NULL AND d.reason_code = 'rule_matched' AND d.enforced = 1
        AND t.is_dry_run = 0
      GROUP BY d.matched_rule_id`,
    agentId,
  );
  return new Map(rows.map((x) => [x.matched_rule_id, x.last_matched_at]));
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

/** 設定変更（proposed）→ スナップショット → applied にして agents の今のスナップショットを付け替える。共通部分（呼ぶ側のトランザクションの中で） */
function applyConfigChange(
  db: WsDb,
  i: ConfigChangeInput,
  c: { origin: "prune" | "revert"; classification: "narrow" | "widen"; widenedItems: Json[] | null; revertsChangeId: Uuid | null; decidedBy: Uuid | null },
): { changeId: Uuid; snapshotId: Uuid } | null {
  const cur = one<{ current_snapshot_id: Uuid | null }>(db, {}, "SELECT current_snapshot_id FROM agents WHERE id = ?", i.agentId);
  if (cur === null || cur.current_snapshot_id !== i.expectedSnapshotId) return null;
  const changeId = newId();
  run(
    db,
    `INSERT INTO agent_config_changes (id, agent_id, origin, patch, classification, widened_items, reverts_change_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
    changeId,
    i.agentId,
    c.origin,
    i.patch,
    c.classification,
    c.widenedItems,
    c.revertsChangeId,
    i.now,
  );
  const snapshotId = newId();
  run(
    db,
    `INSERT INTO agent_snapshots (id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
     VALUES (?, ?, ?, 'in_app', 'valid', ?, ?, ?, ?, ?)`,
    snapshotId,
    i.agentId,
    changeId,
    i.definition,
    i.effectivePolicies as never,
    i.clamped,
    i.ceilingsVersion,
    i.now,
  );
  run(db, "UPDATE agent_config_changes SET status = 'applied', snapshot_id = ?, decided_by = ?, decided_at = ? WHERE id = ?", snapshotId, c.decidedBy, i.now, changeId);
  run(db, "UPDATE agents SET current_snapshot_id = ?, updated_at = ? WHERE id = ?", snapshotId, i.now, i.agentId);
  return { changeId, snapshotId };
}

/**
 * 使われていないルールを外す設定変更を保存する（origin = prune・narrow・applied・decided_by NULL = システム）。
 * 監査ログ agent.config.narrowed。agent.evolution.pruned と workspace_events は呼び出し側が足す
 */
export function applyPruneChange(db: WsDb, i: ApplyPruneChangeInput): { changeId: Uuid; snapshotId: Uuid } | null {
  return db.transaction(() => {
    const done = applyConfigChange(db, i, { origin: "prune", classification: "narrow", widenedItems: null, revertsChangeId: null, decidedBy: null });
    if (done === null) return null;
    appendAuditLog(
      db,
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
  });
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
export function applyRuleRestoreChange(db: WsDb, i: ApplyRuleRestoreChangeInput): { changeId: Uuid; snapshotId: Uuid } | null {
  return db.transaction(() => {
    const done = applyConfigChange(db, i, {
      origin: "revert",
      classification: "widen",
      widenedItems: i.widenedItems,
      revertsChangeId: i.revertsChangeId,
      decidedBy: i.decidedBy,
    });
    if (done === null) return null;
    appendAuditLog(
      db,
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
  });
}

// ---- 整理の記録 ----

export function insertEvolutionEvent(
  db: WsDb,
  v: { agentId: Uuid; items: readonly EvolutionItem[]; configChangeId: Uuid | null; now: Date },
): AgentEvolutionEventRow {
  const row = one<AgentEvolutionEventRow>(
    db,
    CODECS.agent_evolution_events,
    `INSERT INTO agent_evolution_events (id, agent_id, kind, items, config_change_id, created_at)
     VALUES (?, ?, 'pruned', ?, ?, ?) RETURNING *`,
    newId(),
    v.agentId,
    v.items as never,
    v.configChangeId,
    v.now,
  );
  return row!;
}

/** since 以降の整理の記録（新しい順。担当をまたぐ） */
export function listRecentEvolutionEvents(db: WsDb, o: { since: Date }): AgentEvolutionEventRow[] {
  return all<AgentEvolutionEventRow>(
    db,
    CODECS.agent_evolution_events,
    "SELECT * FROM agent_evolution_events WHERE created_at >= ? ORDER BY created_at DESC, id",
    o.since,
  );
}

export function getEvolutionEvent(db: WsDb, id: Uuid): AgentEvolutionEventRow | null {
  return one<AgentEvolutionEventRow>(db, CODECS.agent_evolution_events, "SELECT * FROM agent_evolution_events WHERE id = ?", id);
}

/**
 * items のうち (type, id) の1件に restoredAt を入れる。その項目がない・もう戻していたら null（二重の戻しの検出）。
 * Postgres 版の jsonb_agg の書き換えの代わりに、読んで JS で直して書く（DO の中は1本の流れなので間に割り込まれない）
 */
export function markEvolutionItemRestored(
  db: WsDb,
  eventId: Uuid,
  type: "skill" | "rule",
  id: string,
  now: Date,
): AgentEvolutionEventRow | null {
  return db.transaction(() => {
    const ev = getEvolutionEvent(db, eventId);
    if (ev === null) return null;
    const hit = (x: EvolutionItem) => x.type === type && x.id === id && (x.restoredAt ?? null) === null;
    if (!ev.items.some(hit)) return null;
    const items = ev.items.map((x) => (hit(x) ? { ...x, restoredAt: now.toISOString() } : x));
    return one<AgentEvolutionEventRow>(db, CODECS.agent_evolution_events, "UPDATE agent_evolution_events SET items = ? WHERE id = ? RETURNING *", items as never, eventId);
  });
}

// ===================================================================
// 走査（packages/db/src/system/evolution.ts の WorkspaceDO 版）。app の tick の手順 evolution が呼ぶ。
// Postgres 版はワークスペースをまたいで (workspace_id, agent_id) を返したが、DO の中ではこのワークスペースの担当だけを返す。
// 中身の判断（LLM・ルールの期限）は呼ぶ側で行う
// ===================================================================

export const EVOLUTION_DEFAULTS = {
  /** 案を作る起点になる本番の成功タスクの数 */
  minTasks: 3,
  windowMs: 30 * 24 * 60 * 60 * 1000,
  idleMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface EvolutionTarget {
  agentId: Uuid;
}

/**
 * スキルの案を作る候補：Kill Switch でなければ、removed でない担当で、
 * 最後の案（skipped を含む。なければ最初から）より後・windowMs 以内に終わった本番の成功タスクが minTasks 件以上のもの。
 * 未決定の案（proposed）がある担当は除く（人が決めるまで次の案は作らない。除かないと limit の枠を占め続ける）
 */
export function scanAgentsForSkillLearning(db: WsDb, now: Date, o: { minTasks?: number; windowMs?: number; limit: number }): EvolutionTarget[] {
  if (requireWorkspace(db).kill_switch_engaged) return [];
  const since = new Date(now.getTime() - (o.windowMs ?? EVOLUTION_DEFAULTS.windowMs));
  return all<{ agent_id: Uuid }>(
    db,
    {},
    `SELECT a.id AS agent_id
       FROM agents a
       JOIN tasks t ON t.agent_id = a.id
      WHERE a.status <> 'removed'
        AND t.status IN ('succeeded','completed') AND t.report IS NOT NULL
        AND t.is_dry_run = 0
        AND t.finished_at >= ? AND t.finished_at <= ?
        AND t.finished_at > coalesce((SELECT max(p.created_at) FROM skill_proposals p WHERE p.agent_id = a.id), '')
        AND NOT EXISTS (SELECT 1 FROM skill_proposals p WHERE p.agent_id = a.id AND p.status = 'proposed')
      GROUP BY a.id
     HAVING count(*) >= ?
      ORDER BY max(t.finished_at), a.id
      LIMIT ?`,
    since,
    now,
    o.minTasks ?? EVOLUTION_DEFAULTS.minTasks,
    o.limit,
  ).map((x) => ({ agentId: x.agent_id }));
}

/**
 * 整理の候補：Kill Switch でなければ、removed でない担当で、
 * 外す候補のスキル（idleMs より使われていない）があるか、今の定義にルール（rules[]）があるもの。
 * ルールの期限の判定はアプリ側（rules を持つ担当を返すだけ）
 */
export function scanAgentsForPruning(db: WsDb, now: Date, o: { idleMs?: number; limit: number }): EvolutionTarget[] {
  if (requireWorkspace(db).kill_switch_engaged) return [];
  const before = new Date(now.getTime() - (o.idleMs ?? EVOLUTION_DEFAULTS.idleMs));
  return all<{ agent_id: Uuid }>(
    db,
    {},
    `SELECT a.id AS agent_id
       FROM agents a
       LEFT JOIN agent_snapshots s ON s.id = a.current_snapshot_id
      WHERE a.status <> 'removed'
        AND (EXISTS (SELECT 1 FROM agent_skills k WHERE k.agent_id = a.id AND k.removed_at IS NULL
                        AND coalesce(k.last_used_at, k.approved_at, k.created_at) < ?)
             OR (s.status = 'valid' AND json_type(s.definition, '$.rules') = 'array' AND json_array_length(s.definition, '$.rules') > 0))
      ORDER BY a.updated_at, a.id
      LIMIT ?`,
    before,
    o.limit,
  ).map((x) => ({ agentId: x.agent_id }));
}
