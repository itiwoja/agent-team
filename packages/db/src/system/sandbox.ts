// 作業場のトークンから作業場とワークスペースを引く（ワークスペースをまたぐ：トークンが来た時点ではワークスペースが分からない。D-116）
// 引いたあとは wsCtxOf で文脈を作り、以降の問い合わせはワークスペースで絞る

import type { Queryable } from "../client.ts";
import type { SandboxSessionRow, WorkspaceRow } from "../types.ts";

export async function findSandboxSessionByTokenHash(
  q: Queryable,
  tokenHash: Buffer,
): Promise<{ session: SandboxSessionRow; workspace: Pick<WorkspaceRow, "id" | "kind" | "kill_switch_engaged"> } | null> {
  const r = await q.query<SandboxSessionRow & { ws_kind: WorkspaceRow["kind"]; ws_kill: boolean }>(
    `SELECT s.*, w.kind AS ws_kind, w.kill_switch_engaged AS ws_kill
       FROM sandbox_sessions s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  const { ws_kind, ws_kill, ...session } = row;
  return { session: session as SandboxSessionRow, workspace: { id: session.workspace_id, kind: ws_kind, kill_switch_engaged: ws_kill } };
}
