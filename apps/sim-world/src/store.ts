// sim の保存（sim-world-rehearsal.md §3.6、M-40：状態は jsonb 1行・version で楽観ロック、事象は追記だけ、スナップショット）
// どの操作も workspace_id で絞る（別のワークスペースの行は「ない」と同じ：15:517）。
// 実装は2つ：Postgres（postgres-store.ts。ot_sim のロールで sim スキーマだけ、問い合わせは @open-team/db/sim）と
// メモリ（memory-store.ts。local だけ）。どちらも同じ試験（__fixtures__/store-contract.ts の describeSimStoreContract）を通す

import type { ExecutionVariant, Scenario, SimEvent, WorldId } from "@open-team/sim-core";

/**
 * sim.executions の1行。SW §3.6 の列（id・workspace_id・world・rehearsal_run_id・parent_execution_id・seed・state・version・
 * created_at・updated_at）に、推奨で variant・seed_version・scenario・snapshot_id・initial_state を足した
 */
export interface SimExecutionRecord {
  id: string;
  workspaceId: string;
  world: WorldId;
  /** NULL＝デモ店舗（15:369） */
  rehearsalRunId: string | null;
  /** fork の元（承認した分岐） */
  parentExecutionId: string | null;
  /** M-41。デモ店舗は live、承認した分岐は governed_approve */
  variant: ExecutionVariant;
  seed: number;
  seedVersion: string;
  /** 走行に置いた状況（損害の DamageInput.scenario・オラクルの入力）。デモ店舗は null */
  scenario: Scenario | null;
  /** 初期状態を写したスナップショット（FR-066 の incident） */
  snapshotId: string | null;
  /** 状況を置いた直後の状態（損害・オラクルの initial。fork は元の値を引き継ぐ） */
  initialState: unknown;
  state: unknown;
  /** 1 から。更新のたびに +1（楽観ロック） */
  version: number;
  /** toISOString() の形（UTC・ミリ秒）。PG は timestamptz で持ち、この形で返す */
  createdAt: string;
  updatedAt: string;
}

/** sim.snapshots の1行（SW §3.6。seed・seed_version・execution_version は推奨で足した） */
export interface SimSnapshotRecord {
  id: string;
  workspaceId: string;
  world: WorldId;
  /** 写したデモ店舗の走行と、その時の version */
  executionId: string;
  executionVersion: number;
  seed: number;
  seedVersion: string;
  state: unknown;
  stateHash: string;
  /** 本番のタスク（FR-066 の開始時の状態） */
  sourceTaskId: string;
  /** toISOString() の形 */
  takenAt: string;
}

/** 走行の引き方。デモ店舗は (workspace, world) で1つ（rehearsal_run_id IS NULL。`= NULL` で引かない：SO-SIM-06） */
export type ExecutionKey = { workspaceId: string; id: string } | { workspaceId: string; demoStoreOf: WorldId };

/** updateExecution の fn が返すもの。write は状態を置き換えて事象を足す（updated_at も書く）、keep は何も書かない */
export type ExecutionChange<T> =
  | { kind: "write"; state: unknown; events: readonly SimEvent[]; updatedAt: string; value: T }
  | { kind: "keep"; value: T };

export type ForkResult =
  | { status: "created"; execution: SimExecutionRecord }
  | { status: "exists" }
  | { status: "source_not_found" };

export interface DeleteCounts {
  executions: number;
  events: number;
  snapshots: number;
}

/** 楽観ロックの食い違い（行ロックの中では起きないはず。起きたら保存しない） */
export class SimStoreConflictError extends Error {
  constructor(executionId: string) {
    super(`sim の走行が別の更新で変わった：${executionId}`);
    this.name = "SimStoreConflictError";
  }
}

/** 足す行の参照先 */
export type SimStoreReference = "workspace" | "rehearsal_run" | "execution" | "snapshot";

/**
 * 足す行の参照先がない（Postgres の外部キー：まだないワークスペース・リハーサルの走行など）。管理 API は 404。
 * メモリの実装はワークスペース・リハーサルの走行の表を持たないので投げない
 */
export class SimStoreReferenceError extends Error {
  readonly reference: SimStoreReference;
  constructor(reference: SimStoreReference) {
    super(`sim の行の参照先がない：${reference}`);
    this.name = "SimStoreReferenceError";
    this.reference = reference;
  }
}

/**
 * 試験（rehearsal_cases）が参照しているスナップショットが残っているので、ワークスペースの sim の行を消せない（DB T-16）。
 * 何も消さない。管理 API は 409。メモリの実装は試験の表を持たないので投げない
 */
export class SimStoreInUseError extends Error {
  readonly workspaceId: string;
  constructor(workspaceId: string) {
    super(`試験が参照しているスナップショットがあるので消せない：${workspaceId}`);
    this.name = "SimStoreInUseError";
    this.workspaceId = workspaceId;
  }
}

export interface SimStore {
  /**
   * 走行を作る（version = 1、事象なし）。同じ id があれば作らずに 'exists'。参照先がなければ SimStoreReferenceError（PG だけ）。
   * PG：INSERT … ON CONFLICT (id) DO NOTHING
   */
  createExecution(record: SimExecutionRecord): Promise<"created" | "exists">;

  /**
   * デモ店舗を (workspace, world) で1つだけ作る。あれば作らずにそれを返す（冪等：SD-07・SO-SIM-04）。
   * ワークスペースがなければ SimStoreReferenceError（PG だけ）。
   * PG：部分一意索引 (workspace_id, world) WHERE rehearsal_run_id IS NULL ＋ ON CONFLICT DO NOTHING → SELECT
   */
  ensureDemoStore(record: SimExecutionRecord): Promise<{ created: boolean; execution: SimExecutionRecord }>;

  /** PG：WHERE workspace_id = $1 AND id = $2 ／ WHERE workspace_id = $1 AND world = $2 AND rehearsal_run_id IS NULL */
  getExecution(key: ExecutionKey): Promise<SimExecutionRecord | null>;

  /** 状態と事象を同じ時点で読む（損害・表示。PG：1つの文＝1つのスナップショットで読む）。事象は seq の順 */
  getExecutionWithEvents(key: ExecutionKey): Promise<{ execution: SimExecutionRecord; events: SimEvent[] } | null>;

  /**
   * 走行ごとに直列化して1回だけ更新する。fn は今の行（写し）を受け取り、外部を呼ばずに同期で結果を返す（G-14）。
   * fn が例外を投げたら何も書かない。事象の番号が増えていなければ例外で何も書かない。走行がなければ null。
   * PG：BEGIN → SELECT … FOR UPDATE → fn → INSERT INTO sim.events（最後の番号より大きいときだけ）→
   * UPDATE … SET state, version = version + 1 WHERE id = $id AND version = $v（0行なら SimStoreConflictError）→ COMMIT
   */
  updateExecution<T>(
    key: ExecutionKey,
    fn: (current: SimExecutionRecord) => ExecutionChange<T>,
  ): Promise<{ execution: SimExecutionRecord; value: T } | null>;

  /**
   * 走行を状態と事象ごと写した新しい走行を作る（承認した分岐。SW §4.1.3）。initial_state・scenario は元のまま、version は 1。
   * PG：元を SELECT … FOR SHARE → INSERT → INSERT INTO sim.events SELECT … WHERE execution_id = 元
   */
  forkExecution(input: {
    workspaceId: string;
    sourceId: string;
    id: string;
    variant: ExecutionVariant;
    at: string;
  }): Promise<ForkResult>;

  /** スナップショットを足す（id は呼び出し側が決める）。同じ id は例外。写した走行がなければ SimStoreReferenceError（PG だけ） */
  insertSnapshot(record: SimSnapshotRecord): Promise<void>;

  getSnapshot(workspaceId: string, snapshotId: string): Promise<SimSnapshotRecord | null>;

  /**
   * そのワークスペースの sim の行をすべて消す（15:375。ほかのワークスペースの行に触れない：T-161）。
   * 試験が参照しているスナップショットがあれば SimStoreInUseError で何も消さない（PG だけ）。
   * PG：1つのトランザクションで DELETE sim.events → sim.snapshots → sim.executions（どれも WHERE workspace_id）
   */
  deleteWorkspace(workspaceId: string): Promise<DeleteCounts>;
}
