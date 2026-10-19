// ワークスペースの sim の行をすべて消す（15:375、SW §4.1.3 の DELETE /admin/workspaces/:id、SO §3.16 の4）。
// ふつうは app の掃除がワークスペースの行を消した時点で CASCADE で消えているので、何も消えない（冪等）。
// ほかのワークスペースの行には触れない（T-161）

import type { Tx } from "../client.ts";
import type { SimScope } from "./scope.ts";

export interface SimDeleteCounts {
  executions: number;
  events: number;
  snapshots: number;
}

/**
 * 事象 → スナップショット → 走行の順に消す（スナップショットは走行を参照するので先に。走行どうしの分岐の元・
 * tasks・rehearsal_scenarios からの参照は SET NULL、事象の CASCADE は先に消してあるので数がずれない）。
 * 試験が参照しているスナップショットが残っていれば外部キーの違反（rehearsal_cases_sim_snapshot_fk）で例外：
 * 呼び出し側でトランザクションごと戻す（ワークスペースがまだあり、試験が使っている間は消さない：DB T-16）
 */
export async function deleteSimWorkspaceRows(tx: Tx, scope: SimScope): Promise<SimDeleteCounts> {
  const events = await tx.query(
    `DELETE FROM sim.events ev USING sim.executions e
      WHERE e.workspace_id = $1 AND ev.execution_id = e.id AND ev.workspace_id = $1`,
    [scope.workspaceId],
  );
  const snapshots = await tx.query("DELETE FROM sim.snapshots WHERE workspace_id = $1", [scope.workspaceId]);
  const executions = await tx.query("DELETE FROM sim.executions WHERE workspace_id = $1", [scope.workspaceId]);
  return { executions: executions.rowCount, events: events.rowCount, snapshots: snapshots.rowCount };
}
