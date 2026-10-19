// Postgres の試験の道具（試験からだけ使う）。行（ワークスペース・リハーサルの走行・試験）は表の所有者の接続で作り、
// sim-world の保存は ot_sim のロールの接続で動かす（SO §4.6。ot_sim は public の表を見られない）

import type { Db } from "@open-team/db";
import { fxAgent, fxRehearsalRun, fxWorkspace, openRoleDb, type FxWorkspace } from "@open-team/db/testing";
import type { DeleteCounts } from "../store.ts";

export function pgFixtures(db: Db) {
  const workspaces = new Map<string, FxWorkspace>();
  const fx = {
    /** ワークスペース（利用者・所属つき）の ID */
    async workspace(): Promise<string> {
      const ws = await fxWorkspace(db);
      workspaces.set(ws.workspaceId, ws);
      return ws.workspaceId;
    },
    ws(workspaceId: string): FxWorkspace {
      const ws = workspaces.get(workspaceId);
      if (!ws) throw new Error(`pgFixtures で作っていないワークスペース：${workspaceId}`);
      return ws;
    },
    /** そのワークスペースのリハーサルの走行（エージェントの仕事を対象に） */
    async rehearsalRun(workspaceId: string): Promise<string> {
      const ws = fx.ws(workspaceId);
      const agent = await fxAgent(db, ws);
      return (await fxRehearsalRun(db, ws, { jobId: agent.jobId })).runId;
    },
    /** そのワークスペースの sim の行の数（表の所有者の接続で数える） */
    async counts(workspaceId: string): Promise<DeleteCounts> {
      const r = await db.query<DeleteCounts>(
        `SELECT (SELECT count(*)::int FROM sim.executions WHERE workspace_id = $1) AS executions,
                (SELECT count(*)::int FROM sim.events WHERE workspace_id = $1) AS events,
                (SELECT count(*)::int FROM sim.snapshots WHERE workspace_id = $1) AS snapshots`,
        [workspaceId],
      );
      const row = r.rows[0];
      if (!row) throw new Error("数えられなかった");
      return row;
    },
  };
  return fx;
}

export type PgFixtures = ReturnType<typeof pgFixtures>;

/** ot_sim のロールの接続（閉じるのは呼び出し側） */
export function openSimDb(url: string, max = 3): Promise<Db> {
  return openRoleDb(url, "ot_sim", { max });
}
