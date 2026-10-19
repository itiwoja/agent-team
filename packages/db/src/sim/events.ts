// sim.events（追記だけ。O-01 の数え方・損害・タイムラインの元：SW §3.6、M-40）。event は sim-core の SimEvent そのもの。
// 番号（seq）は走行の中で増えるだけ（メモリの実装と同じ決まり。fork は元の番号のまま写す）

import type { Queryable, Tx } from "../client.ts";
import type { JsonObject, Uuid } from "../types.ts";
import type { SimScope } from "./scope.ts";

/** 事象の番号が増えていない（その走行の最後の番号以下・同じ回の中で増えていない・正の整数でない） */
export class SimEventSeqError extends Error {
  readonly executionId: Uuid;
  readonly seq: unknown;
  constructor(executionId: Uuid, seq: unknown) {
    super(`事象の番号が増えていない：${executionId} seq=${String(seq)}`);
    this.name = "SimEventSeqError";
    this.executionId = executionId;
    this.seq = seq;
  }
}

/** 同じ回の中で番号が正の整数で増えているか（書く前に確かめる）。最初の番号を返す（空なら null） */
export function assertSimEventSeqs(executionId: Uuid, events: readonly JsonObject[], after = 0): number | null {
  let last = after;
  for (const e of events) {
    const seq = e.seq;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= last) throw new SimEventSeqError(executionId, seq);
    last = seq;
  }
  return events[0] ? (events[0].seq as number) : null;
}

/**
 * 事象を足す（同じトランザクションで走行の行をロックしていること）。番号は今ある最後の番号より大きいこと：
 * 確かめる問い合わせは足す文の中に入れる（ロックを待ったあとの新しいスナップショットで最後の番号を読むため。
 * FOR UPDATE の文の中の副問い合わせは、待つ前の古いスナップショットで読む）。外れたら SimEventSeqError（何も足さない）
 */
export async function appendSimEvents(tx: Tx, scope: SimScope, executionId: Uuid, events: readonly JsonObject[]): Promise<number> {
  const first = assertSimEventSeqs(executionId, events);
  if (first === null) return 0;
  const r = await tx.query(
    `INSERT INTO sim.events (execution_id, seq, workspace_id, event)
     SELECT $2, (x->>'seq')::integer, $1, x FROM jsonb_array_elements($3::jsonb) AS t(x)
      WHERE (SELECT COALESCE(max(ev.seq), 0) FROM sim.events ev WHERE ev.execution_id = $2) < $4`,
    [scope.workspaceId, executionId, events, first],
  );
  if (r.rowCount !== events.length) throw new SimEventSeqError(executionId, first);
  return r.rowCount;
}

/** 走行の事象（seq の順）。別のワークスペースの走行なら空 */
export async function listSimEvents(q: Queryable, scope: SimScope, executionId: Uuid): Promise<JsonObject[]> {
  const r = await q.query<{ event: JsonObject }>(
    "SELECT event FROM sim.events WHERE workspace_id = $1 AND execution_id = $2 ORDER BY seq",
    [scope.workspaceId, executionId],
  );
  return r.rows.map((row) => row.event);
}

/** 走行の最後の番号（事象がなければ 0） */
export async function lastSimEventSeq(q: Queryable, scope: SimScope, executionId: Uuid): Promise<number> {
  const r = await q.query<{ last: number }>(
    "SELECT COALESCE(max(seq), 0)::integer AS last FROM sim.events WHERE workspace_id = $1 AND execution_id = $2",
    [scope.workspaceId, executionId],
  );
  return r.rows[0]?.last ?? 0;
}

/** 事象を別の走行に写す（fork。番号はそのまま）。写した数 */
export async function copySimEvents(tx: Tx, scope: SimScope, fromExecutionId: Uuid, toExecutionId: Uuid): Promise<number> {
  const r = await tx.query(
    `INSERT INTO sim.events (execution_id, seq, workspace_id, event)
     SELECT $3, seq, workspace_id, event FROM sim.events WHERE workspace_id = $1 AND execution_id = $2`,
    [scope.workspaceId, fromExecutionId, toExecutionId],
  );
  return r.rowCount;
}
