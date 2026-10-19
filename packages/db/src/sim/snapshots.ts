// sim.snapshots（デモ店舗の状態の写し。本番のタスクの開始時：FR-066・G-07、SW §3.6）。
// 試験（rehearsal_cases）が参照している間は消せない（外部キー rehearsal_cases_sim_snapshot_fk。DB T-16）

import type { Queryable } from "../client.ts";
import type { Hex64, JsonObject, SimSnapshotRow, SimWorld, Uuid } from "../types.ts";
import type { SimScope } from "./scope.ts";

const COLUMNS = "id, workspace_id, world, execution_id, execution_version, seed, seed_version, state, state_hash, source_task_id, taken_at";

/** 足すスナップショット（id は呼び出し側が決める。apps/sim-world の SimSnapshotRecord と同じ項目） */
export interface NewSimSnapshot {
  id: Uuid;
  world: SimWorld;
  /** 写した走行（デモ店舗）と、その時の version */
  executionId: Uuid;
  executionVersion: number;
  seed: number;
  seedVersion: string;
  state: JsonObject;
  stateHash: Hex64;
  /** 本番のタスク（外部キーは張らない：0004 の注記） */
  sourceTaskId: Uuid;
  takenAt: Date;
}

/** スナップショットを足す。同じ id があれば例外（一意の違反）、写した走行がなければ例外（外部キー） */
export async function insertSimSnapshot(q: Queryable, scope: SimScope, s: NewSimSnapshot): Promise<SimSnapshotRow> {
  const r = await q.query<SimSnapshotRow>(
    `INSERT INTO sim.snapshots (workspace_id, id, world, execution_id, execution_version, seed, seed_version, state, state_hash,
                                source_task_id, taken_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      scope.workspaceId,
      s.id,
      s.world,
      s.executionId,
      s.executionVersion,
      s.seed,
      s.seedVersion,
      s.state,
      s.stateHash,
      s.sourceTaskId,
      s.takenAt,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`スナップショットを足せなかった：${s.id}`);
  return row;
}

/** スナップショット（別のワークスペースの ID なら null） */
export async function getSimSnapshot(q: Queryable, scope: SimScope, snapshotId: Uuid): Promise<SimSnapshotRow | null> {
  const r = await q.query<SimSnapshotRow>(`SELECT ${COLUMNS} FROM sim.snapshots WHERE workspace_id = $1 AND id = $2`, [
    scope.workspaceId,
    snapshotId,
  ]);
  return r.rows[0] ?? null;
}
