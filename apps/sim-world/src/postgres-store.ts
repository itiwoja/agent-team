// SimStore の Postgres の実装（M-40、SW §3.6。Cloud SQL の sim スキーマを ot_sim のロールで使う：SO §4.6）。
// 問い合わせは @open-team/db/sim（どれも workspace_id で絞る）。ここは行と記録の写し替え、トランザクションの範囲、制約の違反の読み替え。
// 決まり：トランザクションの中で外部を呼ばない（G-14。updateExecution の fn は同期の純粋関数）、SQL のエラーを中で握りつぶさない

import { isForeignKeyViolation, type Db, type JsonObject } from "@open-team/db";
import {
  appendSimEvents,
  deleteSimWorkspaceRows,
  ensureSimDemoStore,
  forkSimExecution,
  getSimExecution,
  getSimExecutionWithEvents,
  getSimSnapshot,
  insertSimExecution,
  insertSimSnapshot,
  lockSimExecution,
  simMissingReferenceOf,
  updateSimExecutionState,
  type NewSimExecution,
  type SimExecutionKey,
  type SimExecutionRow,
  type SimScope,
  type SimSnapshotRow,
} from "@open-team/db/sim";
import type { Scenario, SimEvent } from "@open-team/sim-core";
import {
  SimStoreConflictError,
  SimStoreInUseError,
  SimStoreReferenceError,
  type DeleteCounts,
  type ExecutionChange,
  type ExecutionKey,
  type ForkResult,
  type SimExecutionRecord,
  type SimSnapshotRecord,
  type SimStore,
} from "./store.ts";

/** 行 → 記録（時刻は toISOString の形。jsonb は読んだ値がそのまま新しいオブジェクト） */
function recordOf(row: SimExecutionRow): SimExecutionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    world: row.world,
    rehearsalRunId: row.rehearsal_run_id,
    parentExecutionId: row.parent_execution_id,
    variant: row.variant,
    seed: row.seed,
    seedVersion: row.seed_version,
    scenario: row.scenario as unknown as Scenario | null,
    snapshotId: row.snapshot_id,
    initialState: row.initial_state,
    state: row.state,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function snapshotRecordOf(row: SimSnapshotRow): SimSnapshotRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    world: row.world,
    executionId: row.execution_id,
    executionVersion: row.execution_version,
    seed: row.seed,
    seedVersion: row.seed_version,
    state: row.state,
    stateHash: row.state_hash,
    sourceTaskId: row.source_task_id,
    takenAt: row.taken_at.toISOString(),
  };
}

/** 記録 → 足す行。状態・状況は jsonb のオブジェクト（違えば DB の CHECK が拒む） */
function newExecutionOf(record: SimExecutionRecord): NewSimExecution {
  return {
    id: record.id,
    world: record.world,
    rehearsalRunId: record.rehearsalRunId,
    parentExecutionId: record.parentExecutionId,
    variant: record.variant,
    seed: record.seed,
    seedVersion: record.seedVersion,
    scenario: record.scenario as unknown as JsonObject | null,
    snapshotId: record.snapshotId,
    initialState: record.initialState as JsonObject,
    state: record.state as JsonObject,
    version: record.version,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

const scopeOf = (key: { workspaceId: string }): SimScope => ({ workspaceId: key.workspaceId });
const dbKeyOf = (key: ExecutionKey): SimExecutionKey => ("id" in key ? { id: key.id } : { demoStoreOf: key.demoStoreOf });

/** 足す文の外部キーの違反を「参照先がない」に読み替える（ほかはそのまま投げる） */
async function mapMissing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const ref = simMissingReferenceOf(e);
    if (ref) throw new SimStoreReferenceError(ref);
    throw e;
  }
}

export class PostgresSimStore implements SimStore {
  readonly #db: Db;

  /** db は ot_sim の接続（cloud）。ローカルは compose の DB の利用者でもよい（sim スキーマに届けばよい） */
  constructor(db: Db) {
    this.#db = db;
  }

  async createExecution(record: SimExecutionRecord): Promise<"created" | "exists"> {
    const row = await mapMissing(() => insertSimExecution(this.#db, scopeOf(record), newExecutionOf(record)));
    return row ? "created" : "exists";
  }

  async ensureDemoStore(record: SimExecutionRecord): Promise<{ created: boolean; execution: SimExecutionRecord }> {
    if (record.rehearsalRunId !== null) throw new Error("デモ店舗は rehearsalRunId が null");
    const r = await mapMissing(() => ensureSimDemoStore(this.#db, scopeOf(record), newExecutionOf(record)));
    return { created: r.created, execution: recordOf(r.row) };
  }

  async getExecution(key: ExecutionKey): Promise<SimExecutionRecord | null> {
    const row = await getSimExecution(this.#db, scopeOf(key), dbKeyOf(key));
    return row ? recordOf(row) : null;
  }

  async getExecutionWithEvents(key: ExecutionKey): Promise<{ execution: SimExecutionRecord; events: SimEvent[] } | null> {
    const found = await getSimExecutionWithEvents(this.#db, scopeOf(key), dbKeyOf(key));
    return found ? { execution: recordOf(found.row), events: found.events as unknown as SimEvent[] } : null;
  }

  async updateExecution<T>(
    key: ExecutionKey,
    fn: (current: SimExecutionRecord) => ExecutionChange<T>,
  ): Promise<{ execution: SimExecutionRecord; value: T } | null> {
    const scope = scopeOf(key);
    // 再試行はしない（fn を1回だけ呼ぶ：メモリの実装と同じ。行1つのロックと追記だけなのでデッドロックにならない）
    return this.#db.transaction(async (tx) => {
      const locked = await lockSimExecution(tx, scope, dbKeyOf(key), "update");
      if (!locked) return null;
      const current = recordOf(locked);
      const change = fn(current);
      if (change.kind === "keep") return { execution: current, value: change.value };
      // 事象を先に足す（番号が増えていなければ SimEventSeqError → トランザクションごと戻る＝何も書かない）
      await appendSimEvents(tx, scope, current.id, change.events as unknown as JsonObject[]);
      const updated = await updateSimExecutionState(tx, scope, {
        id: current.id,
        expectedVersion: current.version,
        state: change.state as JsonObject,
        updatedAt: new Date(change.updatedAt),
      });
      // 行ロックの中なので食い違わないはず。食い違えば書かない（例外でトランザクションごと戻す）
      if (!updated) throw new SimStoreConflictError(current.id);
      return { execution: recordOf(updated), value: change.value };
    });
  }

  async forkExecution(input: {
    workspaceId: string;
    sourceId: string;
    id: string;
    variant: SimExecutionRecord["variant"];
    at: string;
  }): Promise<ForkResult> {
    const r = await mapMissing(() =>
      this.#db.transaction(
        (tx) => forkSimExecution(tx, scopeOf(input), { sourceId: input.sourceId, id: input.id, variant: input.variant, at: new Date(input.at) }),
        { retryOnce: true },
      ),
    );
    return r.status === "created" ? { status: "created", execution: recordOf(r.row) } : r;
  }

  async insertSnapshot(record: SimSnapshotRecord): Promise<void> {
    await mapMissing(() =>
      insertSimSnapshot(this.#db, scopeOf(record), {
        id: record.id,
        world: record.world,
        executionId: record.executionId,
        executionVersion: record.executionVersion,
        seed: record.seed,
        seedVersion: record.seedVersion,
        state: record.state as JsonObject,
        stateHash: record.stateHash,
        sourceTaskId: record.sourceTaskId,
        takenAt: new Date(record.takenAt),
      }),
    );
  }

  async getSnapshot(workspaceId: string, snapshotId: string): Promise<SimSnapshotRecord | null> {
    const row = await getSimSnapshot(this.#db, { workspaceId }, snapshotId);
    return row ? snapshotRecordOf(row) : null;
  }

  async deleteWorkspace(workspaceId: string): Promise<DeleteCounts> {
    try {
      return await this.#db.transaction((tx) => deleteSimWorkspaceRows(tx, { workspaceId }), { retryOnce: true });
    } catch (e) {
      // 消す文の外部キーの違反＝ほかの表（試験など）がまだ参照している。トランザクションごと戻って何も消えていない
      if (isForeignKeyViolation(e)) throw new SimStoreInUseError(workspaceId);
      throw e;
    }
  }
}
