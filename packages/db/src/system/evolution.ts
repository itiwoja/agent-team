// チームが使うほど育つ（0022）の対象の走査。ワークスペースをまたぐ（app の tick の手順 evolution が呼ぶ）。ot_app の接続で呼ぶ。
// 返すのは (workspace_id, agent_id) だけ。中身の判断（LLM・ルールの期限）は app 側でワークスペースごとに WsCtx を作って行う

import type { Db } from "../client.ts";
import type { Uuid } from "../types.ts";

export const EVOLUTION_DEFAULTS = {
  /** 案を作る起点になる本番の成功タスクの数 */
  minTasks: 3,
  windowMs: 30 * 24 * 60 * 60 * 1000,
  idleMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface EvolutionTarget {
  workspaceId: Uuid;
  agentId: Uuid;
}

/**
 * スキルの案を作る候補：owner のワークスペース・Kill Switch でない・削除要求なし・removed でない担当で、
 * 最後の案（skipped を含む。なければ最初から）より後・windowMs 以内に終わった本番の成功タスクが minTasks 件以上のもの。
 * 未決定の案（proposed）がある担当は除く（人が決めるまで次の案は作らない。除かないと limit の枠を占め続ける）
 */
export async function scanAgentsForSkillLearning(
  db: Db,
  now: Date,
  o: { minTasks?: number; windowMs?: number; limit: number },
): Promise<EvolutionTarget[]> {
  const since = new Date(now.getTime() - (o.windowMs ?? EVOLUTION_DEFAULTS.windowMs));
  const r = await db.query<{ workspace_id: Uuid; agent_id: Uuid }>(
    `SELECT a.workspace_id, a.id AS agent_id
       FROM agents a
       JOIN workspaces w ON w.id = a.workspace_id
       JOIN tasks t ON t.workspace_id = a.workspace_id AND t.agent_id = a.id
      WHERE w.kind = 'owner' AND NOT w.kill_switch_engaged AND w.delete_requested_at IS NULL AND a.status <> 'removed'
        AND t.status IN ('succeeded','completed') AND t.report IS NOT NULL
        AND NOT t.is_dry_run
        AND t.finished_at >= $1 AND t.finished_at <= $2
        AND t.finished_at > coalesce((SELECT max(p.created_at) FROM skill_proposals p WHERE p.workspace_id = a.workspace_id AND p.agent_id = a.id), '-infinity'::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM skill_proposals p WHERE p.workspace_id = a.workspace_id AND p.agent_id = a.id AND p.status = 'proposed')
      GROUP BY a.workspace_id, a.id
     HAVING count(*) >= $3
      ORDER BY max(t.finished_at), a.id
      LIMIT $4`,
    [since, now, o.minTasks ?? EVOLUTION_DEFAULTS.minTasks, o.limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, agentId: x.agent_id }));
}

/**
 * 整理の候補：owner のワークスペース・Kill Switch でない・削除要求なし・removed でない担当で、
 * 外す候補のスキル（idleMs より使われていない）があるか、今の定義にルール（rules[]）があるもの。
 * ルールの期限の判定はアプリ側（rules を持つ担当を返すだけ）
 */
export async function scanAgentsForPruning(db: Db, now: Date, o: { idleMs?: number; limit: number }): Promise<EvolutionTarget[]> {
  const before = new Date(now.getTime() - (o.idleMs ?? EVOLUTION_DEFAULTS.idleMs));
  const r = await db.query<{ workspace_id: Uuid; agent_id: Uuid }>(
    `SELECT a.workspace_id, a.id AS agent_id
       FROM agents a
       JOIN workspaces w ON w.id = a.workspace_id
       LEFT JOIN agent_snapshots s ON s.workspace_id = a.workspace_id AND s.id = a.current_snapshot_id
      WHERE w.kind = 'owner' AND NOT w.kill_switch_engaged AND w.delete_requested_at IS NULL AND a.status <> 'removed'
        AND (EXISTS (SELECT 1 FROM agent_skills k WHERE k.workspace_id = a.workspace_id AND k.agent_id = a.id AND k.removed_at IS NULL
                        AND coalesce(k.last_used_at, k.approved_at, k.created_at) < $1)
             OR (s.status = 'valid' AND jsonb_typeof(s.definition->'rules') = 'array' AND jsonb_array_length(s.definition->'rules') > 0))
      ORDER BY a.updated_at, a.id
      LIMIT $2`,
    [before, o.limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, agentId: x.agent_id }));
}
