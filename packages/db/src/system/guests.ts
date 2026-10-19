// ゲストのワークスペースの数（BR-65 の同時50件。削除予約のものは数えない：DB I-07）。ワークスペースをまたぐので system に置く

import type { Queryable } from "../client.ts";

export async function countActiveGuestWorkspaces(q: Queryable): Promise<number> {
  const r = await q.query<{ n: number }>("SELECT count(*) AS n FROM workspaces WHERE kind = 'guest' AND delete_requested_at IS NULL");
  return r.rows[0]?.n ?? 0;
}
