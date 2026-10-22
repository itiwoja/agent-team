// packages/db/src/system/agents.ts の WorkspaceDO 版。使われないエージェントの片付け（毎時の掃除のついで）。
// Postgres 版はワークスペースをまたいで走査したが、DO の中ではこのワークスペースの担当だけを見る（掃除の alarm が呼ぶ）。
// 1. 候補：removed でなく、最後に使われた時刻が now − 30日より前。ちょうど30日は消さない
//    最後に使われた時刻 = 作成・更新・タスク・依頼への参加・会話のうち一番新しいもの
// 2. 除くもの：終わっていないタスクがある／動いている依頼（generating・running・waiting_input）に入っている／
//    定期の依頼（取り消し・失敗でないもの）に入っている／用意した依頼（seed_key）に入っている
// 3. 消すといっても行は消さない（過去のタスクと監査ログから参照するため。agent-builder.md の BR）。status を removed にして
//    監査ログ agent.removed を残す。1件1トランザクション

import { appendAuditLog } from "../audit.ts";
import { all, one, type WsDb } from "../sqlite.ts";
import { TASK_TERMINAL, type Uuid } from "../types.ts";

export const AGENT_RETENTION_DEFAULTS = {
  batch: 50,
  /** 最後に使われてから30日を「過ぎた」ら removed にする */
  idleMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface RemoveUnusedAgentsResult {
  scanned: number;
  removed: Array<{ agentId: Uuid }>;
  failed: Array<{ agentId: Uuid; error: string }>;
}

/**
 * ?1 = 使われた時刻の境界、?2 = 終わったタスクの状態（JSON の配列）。a は agents。
 * SQLite の複数引数の max() は NULL があると NULL になるので、サブクエリは coalesce で a.created_at に寄せる（Postgres の GREATEST は NULL を飛ばす）
 */
const UNUSED = `a.status <> 'removed'
  AND max(
        a.created_at, a.updated_at,
        coalesce((SELECT max(t.created_at) FROM tasks t WHERE t.agent_id = a.id), a.created_at),
        coalesce((SELECT max(m.created_at) FROM ask_members m WHERE m.agent_id = a.id), a.created_at),
        coalesce((SELECT max(x.created_at) FROM agent_messages x WHERE x.agent_id = a.id), a.created_at)
      ) < ?1
  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.agent_id = a.id AND t.status NOT IN (SELECT value FROM json_each(?2)))
  AND NOT EXISTS (
        SELECT 1 FROM ask_members m JOIN asks k ON k.id = m.ask_id
         WHERE m.agent_id = a.id
           AND (k.status IN ('generating', 'running', 'waiting_input')
                OR k.seed_key IS NOT NULL
                OR (k."trigger" IS NOT NULL AND k.status NOT IN ('cancelled', 'failed'))))`;

/** 使われないエージェントを1回（batch 件まで）removed にする。残りは次の回 */
export function removeUnusedAgents(db: WsDb, now: Date, opts: { batch?: number } = {}): RemoveUnusedAgentsResult {
  const unusedBefore = new Date(now.getTime() - AGENT_RETENTION_DEFAULTS.idleMs);
  const terminal = [...TASK_TERMINAL];
  const candidates = all<{ id: Uuid }>(
    db,
    {},
    `SELECT a.id FROM agents a WHERE ${UNUSED} ORDER BY a.updated_at, a.id LIMIT ?3`,
    unusedBefore,
    terminal,
    opts.batch ?? AGENT_RETENTION_DEFAULTS.batch,
  );
  const result: RemoveUnusedAgentsResult = { scanned: candidates.length, removed: [], failed: [] };
  for (const { id: agentId } of candidates) {
    try {
      const done = db.transaction(() => {
        // 候補を選んだあとに使われたら removed にしない（同じ条件で確かめ直す）
        const row = one<{ name: string }>(
          db,
          {},
          `UPDATE agents AS a SET status = 'removed', updated_at = ?4
            WHERE a.id = ?3 AND ${UNUSED}
            RETURNING name`,
          unusedBefore,
          terminal,
          agentId,
          now,
        );
        if (!row) return false;
        appendAuditLog(
          db,
          { eventType: "agent.removed", actorType: "system", actorId: "retention", payload: { agentId, name: row.name, reason: "unused_30d" } },
          now,
        );
        return true;
      });
      if (done) result.removed.push({ agentId });
    } catch (e) {
      result.failed.push({ agentId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
