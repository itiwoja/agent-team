// SimStore のメモリの実装（ローカル・計測・試験用。インスタンスをまたいで共有しない）
// 走行ごとの待ち行列で直列化し、書くときに version を確かめる（Postgres の行ロック＋楽観ロックと同じ振る舞い）。
// 保存・読み出しは JSON の往復で写す（jsonb と同じく undefined を落とし、呼び出し側が持っているオブジェクトと切り離す）

import type { SimEvent } from "@open-team/sim-core";
import {
  SimStoreConflictError,
  type DeleteCounts,
  type ExecutionChange,
  type ExecutionKey,
  type ForkResult,
  type SimExecutionRecord,
  type SimSnapshotRecord,
  type SimStore,
} from "./store.ts";

/** jsonb に入れて出したのと同じ写し */
function jsonb<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** キーごとに1つずつ順に動かす（同じ走行の更新を直列化する） */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => done);
    this.tails.set(key, tail);
    return prev.then(async () => {
      try {
        return await task();
      } finally {
        release();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
    });
  }

  /** 待っているキーの数（試験用） */
  get size(): number {
    return this.tails.size;
  }
}

export class MemorySimStore implements SimStore {
  private readonly executions = new Map<string, SimExecutionRecord>();
  private readonly events = new Map<string, SimEvent[]>();
  private readonly snapshots = new Map<string, SimSnapshotRecord>();
  private readonly queue = new KeyedQueue();

  private find(key: ExecutionKey): SimExecutionRecord | undefined {
    if ("id" in key) {
      const rec = this.executions.get(key.id);
      return rec && rec.workspaceId === key.workspaceId ? rec : undefined;
    }
    for (const rec of this.executions.values()) {
      if (rec.workspaceId === key.workspaceId && rec.world === key.demoStoreOf && rec.rehearsalRunId === null) return rec;
    }
    return undefined;
  }

  private appendEvents(executionId: string, added: readonly SimEvent[]): void {
    const list = this.events.get(executionId) ?? [];
    let last = list.at(-1)?.seq ?? 0;
    for (const e of added) {
      // 事象の番号は走行の中で増えるだけ（Postgres では (execution_id, seq) を一意にする）
      if (!Number.isInteger(e.seq) || e.seq <= last) throw new Error(`事象の番号が増えていない：${executionId} seq=${e.seq}`);
      last = e.seq;
    }
    list.push(...jsonb(added));
    this.events.set(executionId, list);
  }

  async createExecution(record: SimExecutionRecord): Promise<"created" | "exists"> {
    if (this.executions.has(record.id)) return "exists";
    this.executions.set(record.id, jsonb(record));
    this.events.set(record.id, []);
    return "created";
  }

  async ensureDemoStore(record: SimExecutionRecord): Promise<{ created: boolean; execution: SimExecutionRecord }> {
    if (record.rehearsalRunId !== null) throw new Error("デモ店舗は rehearsalRunId が null");
    const existing = this.find({ workspaceId: record.workspaceId, demoStoreOf: record.world });
    if (existing) return { created: false, execution: jsonb(existing) };
    if (this.executions.has(record.id)) throw new Error(`走行の id が重なった：${record.id}`);
    this.executions.set(record.id, jsonb(record));
    this.events.set(record.id, []);
    return { created: true, execution: jsonb(record) };
  }

  async getExecution(key: ExecutionKey): Promise<SimExecutionRecord | null> {
    const rec = this.find(key);
    return rec ? jsonb(rec) : null;
  }

  async getExecutionWithEvents(key: ExecutionKey): Promise<{ execution: SimExecutionRecord; events: SimEvent[] } | null> {
    const rec = this.find(key);
    if (!rec) return null;
    return { execution: jsonb(rec), events: jsonb(this.events.get(rec.id) ?? []) };
  }

  async updateExecution<T>(
    key: ExecutionKey,
    fn: (current: SimExecutionRecord) => ExecutionChange<T>,
  ): Promise<{ execution: SimExecutionRecord; value: T } | null> {
    const first = this.find(key);
    if (!first) return null;
    return this.queue.run(first.id, () => {
      // 待っている間に消えた・別の行になったなら「ない」
      const current = this.find(key);
      if (!current || current.id !== first.id) return null;
      const readVersion = current.version;
      const change = fn(jsonb(current));
      if (change.kind === "keep") return { execution: jsonb(current), value: change.value };
      // 楽観ロック：読んだ時の version のままなら書く（行ロックの中なので食い違わないはず）
      const latest = this.executions.get(current.id);
      if (!latest || latest.version !== readVersion) throw new SimStoreConflictError(current.id);
      const next: SimExecutionRecord = {
        ...latest,
        state: jsonb(change.state),
        version: readVersion + 1,
        updatedAt: change.updatedAt,
      };
      this.appendEvents(current.id, change.events);
      this.executions.set(current.id, next);
      return { execution: jsonb(next), value: change.value };
    });
  }

  async forkExecution(input: {
    workspaceId: string;
    sourceId: string;
    id: string;
    variant: SimExecutionRecord["variant"];
    at: string;
  }): Promise<ForkResult> {
    const source = this.find({ workspaceId: input.workspaceId, id: input.sourceId });
    if (!source) return { status: "source_not_found" };
    // 元の走行の更新と混ざらないよう、元の待ち行列の中で写す
    return this.queue.run(source.id, (): ForkResult => {
      const src = this.find({ workspaceId: input.workspaceId, id: input.sourceId });
      if (!src) return { status: "source_not_found" };
      if (this.executions.has(input.id)) return { status: "exists" };
      const record: SimExecutionRecord = {
        ...jsonb(src),
        id: input.id,
        parentExecutionId: src.id,
        variant: input.variant,
        version: 1,
        createdAt: input.at,
        updatedAt: input.at,
      };
      this.executions.set(record.id, record);
      this.events.set(record.id, jsonb(this.events.get(src.id) ?? []));
      return { status: "created", execution: jsonb(record) };
    });
  }

  async insertSnapshot(record: SimSnapshotRecord): Promise<void> {
    if (this.snapshots.has(record.id)) throw new Error(`スナップショットの id が重なった：${record.id}`);
    this.snapshots.set(record.id, jsonb(record));
  }

  async getSnapshot(workspaceId: string, snapshotId: string): Promise<SimSnapshotRecord | null> {
    const rec = this.snapshots.get(snapshotId);
    return rec && rec.workspaceId === workspaceId ? jsonb(rec) : null;
  }

  async deleteWorkspace(workspaceId: string): Promise<DeleteCounts> {
    const counts: DeleteCounts = { executions: 0, events: 0, snapshots: 0 };
    for (const [id, rec] of this.executions) {
      if (rec.workspaceId !== workspaceId) continue;
      counts.executions += 1;
      counts.events += this.events.get(id)?.length ?? 0;
      this.executions.delete(id);
      this.events.delete(id);
    }
    for (const [id, snap] of this.snapshots) {
      if (snap.workspaceId !== workspaceId) continue;
      counts.snapshots += 1;
      this.snapshots.delete(id);
    }
    return counts;
  }

  /** 行の数（試験用） */
  counts(workspaceId?: string): DeleteCounts {
    const match = (w: string) => workspaceId === undefined || w === workspaceId;
    let executions = 0;
    let events = 0;
    for (const [id, rec] of this.executions) {
      if (!match(rec.workspaceId)) continue;
      executions += 1;
      events += this.events.get(id)?.length ?? 0;
    }
    let snapshots = 0;
    for (const snap of this.snapshots.values()) if (match(snap.workspaceId)) snapshots += 1;
    return { executions, events, snapshots };
  }
}
