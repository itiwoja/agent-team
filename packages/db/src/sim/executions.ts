// sim.executions（走行。デモ店舗・リハーサルの状況×種類・承認した分岐：SW §3.5・§3.6、M-40・M-41）。
// 状態は jsonb 1行で、更新は行ロック（SELECT … FOR UPDATE）の中で version を1つ上げる（楽観ロックの確かめを兼ねる）。
// デモ店舗は rehearsal_run_id が NULL の行で、(workspace_id, world) に1つ（`= NULL` で引かない：SO-SIM-06）

import type { Queryable, Tx } from "../client.ts";
import type { ExecutionVariant, JsonObject, SimExecutionRow, SimWorld, Uuid } from "../types.ts";
import { copySimEvents } from "./events.ts";
import type { SimScope } from "./scope.ts";

const COLUMNS = `id, workspace_id, world, rehearsal_run_id, parent_execution_id, variant, seed, seed_version, scenario, snapshot_id,
  initial_state, state, version, created_at, updated_at`;
const COLUMNS_E = COLUMNS.split(",")
  .map((c) => `e.${c.trim()}`)
  .join(", ");

/** 走行の引き方：ID か、その世界のデモ店舗 */
export type SimExecutionKey = { readonly id: Uuid } | { readonly demoStoreOf: SimWorld };

/** 足す走行（id は呼び出し側が決める。apps/sim-world の SimExecutionRecord と同じ項目） */
export interface NewSimExecution {
  id: Uuid;
  world: SimWorld;
  rehearsalRunId: Uuid | null;
  parentExecutionId: Uuid | null;
  variant: ExecutionVariant;
  seed: number;
  seedVersion: string;
  scenario: JsonObject | null;
  snapshotId: Uuid | null;
  initialState: JsonObject;
  state: JsonObject;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** 鍵の条件（$1 は workspace_id、$2 から） */
function keyCondition(key: SimExecutionKey, alias: string): { sql: string; params: unknown[] } {
  return "id" in key
    ? { sql: `${alias}.id = $2`, params: [key.id] }
    : { sql: `${alias}.world = $2 AND ${alias}.rehearsal_run_id IS NULL`, params: [key.demoStoreOf] };
}

function insertParams(scope: SimScope, e: NewSimExecution): unknown[] {
  return [
    scope.workspaceId,
    e.id,
    e.world,
    e.rehearsalRunId,
    e.parentExecutionId,
    e.variant,
    e.seed,
    e.seedVersion,
    e.scenario,
    e.snapshotId,
    e.initialState,
    e.state,
    e.version,
    e.createdAt,
    e.updatedAt,
  ];
}

const INSERT_SQL = `INSERT INTO sim.executions (workspace_id, id, world, rehearsal_run_id, parent_execution_id, variant, seed, seed_version,
                                   scenario, snapshot_id, initial_state, state, version, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`;

/**
 * 走行を足す。同じ id の行があれば作らずに null（ON CONFLICT (id) DO NOTHING）。
 * 参照先がない（ワークスペース・リハーサルの走行・スナップショット）・CHECK の違反は例外（simMissingReferenceOf で見分ける）
 */
export async function insertSimExecution(q: Queryable, scope: SimScope, e: NewSimExecution): Promise<SimExecutionRow | null> {
  const r = await q.query<SimExecutionRow>(`${INSERT_SQL} ON CONFLICT (id) DO NOTHING RETURNING ${COLUMNS}`, insertParams(scope, e));
  return r.rows[0] ?? null;
}

/**
 * デモ店舗を (workspace, world) に1つだけ作る。あれば作らずにそれを返す（冪等：SD-07・SO-SIM-04）。
 * 部分一意索引 sim_executions_demo_store_uq への ON CONFLICT DO NOTHING → なければ読む（同時に作っても1つ）
 */
export async function ensureSimDemoStore(
  q: Queryable,
  scope: SimScope,
  e: NewSimExecution,
): Promise<{ created: boolean; row: SimExecutionRow }> {
  if (e.rehearsalRunId !== null || e.variant !== "live") throw new Error("デモ店舗は rehearsalRunId が null・variant が live");
  // 2つの文の間にデモ店舗が消えた（ワークスペースの削除と重なった）ときだけ、もう一度作る
  for (let attempt = 0; attempt < 2; attempt++) {
    const ins = await q.query<SimExecutionRow>(
      `${INSERT_SQL} ON CONFLICT (workspace_id, world) WHERE rehearsal_run_id IS NULL DO NOTHING RETURNING ${COLUMNS}`,
      insertParams(scope, e),
    );
    const created = ins.rows[0];
    if (created) return { created: true, row: created };
    const existing = await getSimExecution(q, scope, { demoStoreOf: e.world });
    if (existing) return { created: false, row: existing };
  }
  throw new Error(`デモ店舗を作れない（作るたびに消えた）：${scope.workspaceId} ${e.world}`);
}

/** 走行（別のワークスペースの ID なら null） */
export async function getSimExecution(q: Queryable, scope: SimScope, key: SimExecutionKey): Promise<SimExecutionRow | null> {
  const k = keyCondition(key, "e");
  const r = await q.query<SimExecutionRow>(`SELECT ${COLUMNS_E} FROM sim.executions e WHERE e.workspace_id = $1 AND ${k.sql}`, [
    scope.workspaceId,
    ...k.params,
  ]);
  return r.rows[0] ?? null;
}

/**
 * 走行と事象（seq の順）を同じ時点で読む（1つの文＝1つのスナップショット。損害・表示）。なければ null
 */
export async function getSimExecutionWithEvents(
  q: Queryable,
  scope: SimScope,
  key: SimExecutionKey,
): Promise<{ row: SimExecutionRow; events: JsonObject[] } | null> {
  const k = keyCondition(key, "e");
  const r = await q.query<SimExecutionRow & { events: JsonObject[] }>(
    `SELECT ${COLUMNS_E},
            COALESCE((SELECT jsonb_agg(ev.event ORDER BY ev.seq) FROM sim.events ev
                       WHERE ev.execution_id = e.id AND ev.workspace_id = e.workspace_id), '[]'::jsonb) AS events
       FROM sim.executions e WHERE e.workspace_id = $1 AND ${k.sql}`,
    [scope.workspaceId, ...k.params],
  );
  const found = r.rows[0];
  if (!found) return null;
  const { events, ...row } = found;
  return { row, events };
}

/**
 * 走行の行をロックして読む（update：更新する前・FOR UPDATE、share：写す前・FOR SHARE）。なければ null。
 * READ COMMITTED では、別の更新を待ったあとは最新の行を返す。ただし同じ文に副問い合わせを足すと待つ前の
 * スナップショットで読むので、最後の事象の番号はここで読まない（appendSimEvents が足す文の中で読む）
 */
export async function lockSimExecution(
  tx: Tx,
  scope: SimScope,
  key: SimExecutionKey,
  mode: "update" | "share",
): Promise<SimExecutionRow | null> {
  const k = keyCondition(key, "e");
  const r = await tx.query<SimExecutionRow>(
    `SELECT ${COLUMNS_E} FROM sim.executions e WHERE e.workspace_id = $1 AND ${k.sql} ${mode === "update" ? "FOR UPDATE" : "FOR SHARE"}`,
    [scope.workspaceId, ...k.params],
  );
  return r.rows[0] ?? null;
}

/**
 * 状態を置き換え、version を1つ上げる（読んだ時の version のままのときだけ：楽観ロック）。
 * 食い違えば（別の更新が先に書いた・行がない）null。updated_at は引数の時刻（DB の now() を使わない：README §1 の10）
 */
export async function updateSimExecutionState(
  tx: Tx,
  scope: SimScope,
  input: { id: Uuid; expectedVersion: number; state: JsonObject; updatedAt: Date },
): Promise<SimExecutionRow | null> {
  const r = await tx.query<SimExecutionRow>(
    `UPDATE sim.executions SET state = $4, version = version + 1, updated_at = $5
      WHERE workspace_id = $1 AND id = $2 AND version = $3
      RETURNING ${COLUMNS}`,
    [scope.workspaceId, input.id, input.expectedVersion, input.state, input.updatedAt],
  );
  return r.rows[0] ?? null;
}

export type ForkSimExecutionResult =
  | { status: "created"; row: SimExecutionRow; events: number }
  | { status: "exists" }
  | { status: "source_not_found" };

/**
 * 走行を状態と事象ごと写した新しい走行を作る（承認した分岐：SW §4.1.3・§4.4.3 の4）。
 * 元を FOR SHARE でロックしてから写す（写す間に元の更新が入らない＝状態と事象が同じ時点）。
 * initial_state・scenario・seed・snapshot_id・rehearsal_run_id は元のまま、parent_execution_id は元、version は 1
 */
export async function forkSimExecution(
  tx: Tx,
  scope: SimScope,
  input: { sourceId: Uuid; id: Uuid; variant: ExecutionVariant; at: Date },
): Promise<ForkSimExecutionResult> {
  const source = await lockSimExecution(tx, scope, { id: input.sourceId }, "share");
  if (!source) return { status: "source_not_found" };
  const ins = await tx.query<SimExecutionRow>(
    `INSERT INTO sim.executions (workspace_id, id, world, rehearsal_run_id, parent_execution_id, variant, seed, seed_version,
                                 scenario, snapshot_id, initial_state, state, version, created_at, updated_at)
     SELECT workspace_id, $3, world, rehearsal_run_id, id, $4, seed, seed_version, scenario, snapshot_id, initial_state, state, 1, $5, $5
       FROM sim.executions WHERE workspace_id = $1 AND id = $2
     ON CONFLICT (id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [scope.workspaceId, input.sourceId, input.id, input.variant, input.at],
  );
  const row = ins.rows[0];
  if (!row) return { status: "exists" };
  const events = await copySimEvents(tx, scope, input.sourceId, input.id);
  return { status: "created", row, events };
}
