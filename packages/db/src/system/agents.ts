// 使われないエージェントの片付け（毎時の掃除のついで）。ot_app の接続で呼ぶ。
// 1. 候補：removed でなく、最後に使われた時刻が now − 30日より前。ちょうど30日は消さない
//    最後に使われた時刻 = 作成・更新・タスク・依頼への参加・会話のうち一番新しいもの
// 2. 除くもの：終わっていないタスクがある／動いている依頼（generating・running・waiting_input）に入っている／
//    定期の依頼（取り消し・失敗でないもの）に入っている／用意した依頼（seed_key）に入っている／削除予約のワークスペース
// 3. 消すといっても行は消さない（過去のタスクと監査ログから参照するため。agent-builder.md の BR）。status を removed にして
//    監査ログ agent.removed を残す。1件1トランザクションで、ロックはワークスペース → エージェントの順（M-21）

import { appendAuditLog } from "../audit.ts";
import type { Db } from "../client.ts";
import { TASK_TERMINAL, type Uuid } from "../types.ts";

export const AGENT_RETENTION_DEFAULTS = {
  batch: 50,
  /** 最後に使われてから30日を「過ぎた」ら removed にする */
  idleMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface RemoveUnusedAgentsResult {
  scanned: number;
  removed: Array<{ workspaceId: Uuid; agentId: Uuid }>;
  failed: Array<{ workspaceId: Uuid; agentId: Uuid; error: string }>;
}

/** $1 = 使われた時刻の境界、$2 = 終わったタスクの状態。a は agents */
const UNUSED = `a.status <> 'removed'
  AND GREATEST(
        a.created_at, a.updated_at,
        (SELECT max(t.created_at) FROM tasks t WHERE t.agent_id = a.id),
        (SELECT max(m.created_at) FROM ask_members m WHERE m.agent_id = a.id),
        (SELECT max(x.created_at) FROM agent_messages x WHERE x.agent_id = a.id)
      ) < $1
  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status <> ALL($2::text[]))
  AND NOT EXISTS (
        SELECT 1 FROM ask_members m JOIN asks k ON k.workspace_id = m.workspace_id AND k.id = m.ask_id
         WHERE m.agent_id = a.id
           AND (k.status IN ('generating', 'running', 'waiting_input')
                OR k.seed_key IS NOT NULL
                OR (k.trigger IS NOT NULL AND k.status NOT IN ('cancelled', 'failed'))))`;

/** 使われないエージェントを1回（batch 件まで）removed にする。残りは次の回 */
export async function removeUnusedAgents(db: Db, now: Date, opts: { batch?: number } = {}): Promise<RemoveUnusedAgentsResult> {
  const unusedBefore = new Date(now.getTime() - AGENT_RETENTION_DEFAULTS.idleMs);
  const terminal = [...TASK_TERMINAL];
  const candidates = await db.query<{ workspace_id: Uuid; id: Uuid }>(
    `SELECT a.workspace_id, a.id FROM agents a JOIN workspaces w ON w.id = a.workspace_id
      WHERE w.delete_requested_at IS NULL AND ${UNUSED}
      ORDER BY a.updated_at, a.id
      LIMIT $3`,
    [unusedBefore, terminal, opts.batch ?? AGENT_RETENTION_DEFAULTS.batch],
  );
  const result: RemoveUnusedAgentsResult = { scanned: candidates.rows.length, removed: [], failed: [] };
  for (const { workspace_id: workspaceId, id: agentId } of candidates.rows) {
    try {
      const done = await db.transaction(async (tx) => {
        const ws = await tx.query("SELECT 1 FROM workspaces WHERE id = $1 AND delete_requested_at IS NULL FOR NO KEY UPDATE", [workspaceId]);
        if (ws.rowCount === 0) return false;
        // 候補を選んだあとに使われたら removed にしない（同じ条件で確かめ直す）
        const r = await tx.query<{ name: string }>(
          `UPDATE agents a SET status = 'removed', updated_at = $5
            WHERE a.workspace_id = $3 AND a.id = $4 AND ${UNUSED}
            RETURNING a.name`,
          [unusedBefore, terminal, workspaceId, agentId, now],
        );
        const row = r.rows[0];
        if (!row) return false;
        await appendAuditLog(
          tx,
          workspaceId,
          { eventType: "agent.removed", actorType: "system", actorId: "retention", payload: { agentId, name: row.name, reason: "unused_30d" } },
          now,
        );
        return true;
      });
      if (done) result.removed.push({ workspaceId, agentId });
    } catch (e) {
      result.failed.push({ workspaceId, agentId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
