// sim スキーマの問い合わせ（M-40、SW §3.6）の試験。試験ごとに新しいデータベース（@open-team/db/testing）
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PG_ERROR, isForeignKeyViolation, isUniqueViolation, pgErrorInfo, type Db } from "../client.ts";
import { fxAgent, fxRehearsalCase, fxRehearsalRun, fxTask, fxWorkspace, openRoleDb, useTestDb, type FxWorkspace } from "../testing.ts";
import {
  SimEventSeqError,
  appendSimEvents,
  assertSimEventSeqs,
  deleteSimWorkspaceRows,
  ensureSimDemoStore,
  forkSimExecution,
  getSimExecution,
  getSimExecutionWithEvents,
  getSimSnapshot,
  insertSimExecution,
  insertSimSnapshot,
  lastSimEventSeq,
  listSimEvents,
  lockSimExecution,
  simMissingReferenceOf,
  updateSimExecutionState,
  type NewSimExecution,
  type NewSimSnapshot,
} from "./index.ts";

const T = useTestDb();
const AT = new Date("2026-10-14T01:00:00.000Z");
const LATER = new Date("2026-10-14T02:00:00.000Z");

function exec(over: Partial<NewSimExecution> = {}): NewSimExecution {
  return {
    id: randomUUID(),
    world: "shop",
    rehearsalRunId: null,
    parentExecutionId: null,
    variant: "live",
    seed: 7,
    seedVersion: "shop-v1",
    scenario: null,
    snapshotId: null,
    initialState: { n: 0 },
    state: { n: 0 },
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

const ev = (seq: number, kind = "tool_call") => ({ seq, at: "2026-10-06T18:00:00+09:00", kind, tool: "store.get_inventory", caller: "sa-gateway" });

/** ワークスペースと、そのリハーサルの走行 */
async function wsWithRun(db: Db): Promise<{ ws: FxWorkspace; runId: string }> {
  const ws = await fxWorkspace(db);
  const agent = await fxAgent(db, ws);
  const { runId } = await fxRehearsalRun(db, ws, { jobId: agent.jobId });
  return { ws, runId };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("例外にならなかった");
    },
    (e: unknown) => e,
  );
}

describe("insertSimExecution・getSimExecution（M-40：workspace_id で絞る）", () => {
  it("足した行を値の型どおりに返す（seed は number、時刻は Date、jsonb は値）。同じ id は作らずに null", async () => {
    const { db } = T();
    const { ws, runId } = await wsWithRun(db);
    const e = exec({ rehearsalRunId: runId, variant: "governed", scenario: { schemaVersion: 1, world: "shop", seed: 4294967295 }, seed: 4294967295 });
    const row = await insertSimExecution(db, ws, e);
    expect(row).toMatchObject({
      id: e.id,
      workspace_id: ws.workspaceId,
      world: "shop",
      rehearsal_run_id: runId,
      parent_execution_id: null,
      variant: "governed",
      seed: 4294967295,
      seed_version: "shop-v1",
      scenario: { schemaVersion: 1, world: "shop", seed: 4294967295 },
      snapshot_id: null,
      initial_state: { n: 0 },
      state: { n: 0 },
      version: 1,
    });
    expect(row?.created_at).toEqual(AT);
    expect(row?.updated_at).toEqual(AT);
    expect(await insertSimExecution(db, ws, { ...e, state: { n: 9 } })).toBeNull();
    // 別のワークスペースからは同じ id でも「ない」
    const other = await fxWorkspace(db);
    expect(await getSimExecution(db, other, { id: e.id })).toBeNull();
    expect(await insertSimExecution(db, other, e)).toBeNull();
    expect((await getSimExecution(db, ws, { id: e.id }))?.state).toEqual({ n: 0 });
  });

  it("参照先がない走行は外部キーの違反で、simMissingReferenceOf がどれかを返す（ワークスペース・リハーサルの走行・分岐の元・スナップショット）", async () => {
    const { db } = T();
    const { ws, runId } = await wsWithRun(db);
    const missingWs = await rejection(insertSimExecution(db, { workspaceId: randomUUID() }, exec()));
    expect(simMissingReferenceOf(missingWs)).toBe("workspace");
    const missingRun = await rejection(insertSimExecution(db, ws, exec({ rehearsalRunId: randomUUID(), variant: "governed" })));
    expect(simMissingReferenceOf(missingRun)).toBe("rehearsal_run");
    const missingParent = await rejection(
      insertSimExecution(db, ws, exec({ rehearsalRunId: runId, variant: "governed_approve", parentExecutionId: randomUUID() })),
    );
    expect(simMissingReferenceOf(missingParent)).toBe("execution");
    const missingSnap = await rejection(insertSimExecution(db, ws, exec({ rehearsalRunId: runId, variant: "governed", snapshotId: randomUUID() })));
    expect(simMissingReferenceOf(missingSnap)).toBe("snapshot");
    // 別のワークスペースのリハーサルの走行も「ない」（複合 FK：DB I-41）
    const b = await wsWithRun(db);
    expect(simMissingReferenceOf(await rejection(insertSimExecution(db, ws, exec({ rehearsalRunId: b.runId, variant: "governed" }))))).toBe(
      "rehearsal_run",
    );
    // 外部キーでない違反は null（CHECK：live なのにリハーサルの走行あり）
    const check = await rejection(insertSimExecution(db, ws, exec({ rehearsalRunId: runId, variant: "live" })));
    expect(pgErrorInfo(check)?.code).toBe(PG_ERROR.checkViolation);
    expect(simMissingReferenceOf(check)).toBeNull();
    expect(simMissingReferenceOf(new Error("x"))).toBeNull();
  });

  it("SO-SIM-06 デモ店舗は rehearsal_run_id IS NULL の行（同じワークスペースのリハーサルの走行は引かない）", async () => {
    const { db } = T();
    const { ws, runId } = await wsWithRun(db);
    await insertSimExecution(db, ws, exec({ rehearsalRunId: runId, variant: "governed" }));
    expect(await getSimExecution(db, ws, { demoStoreOf: "shop" })).toBeNull();
    const demo = exec();
    await insertSimExecution(db, ws, demo);
    expect((await getSimExecution(db, ws, { demoStoreOf: "shop" }))?.id).toBe(demo.id);
    expect(await getSimExecution(db, ws, { demoStoreOf: "brief" })).toBeNull();
    expect(await getSimExecution(db, await fxWorkspace(db), { demoStoreOf: "shop" })).toBeNull();
  });
});

describe("ensureSimDemoStore（SD-07・SO-SIM-04：ワークスペース×世界に1つ）", () => {
  it("2回目は作らずに最初の行を返す。リハーサルの印つきは例外", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const first = exec();
    expect(await ensureSimDemoStore(db, ws, first)).toMatchObject({ created: true, row: { id: first.id, variant: "live" } });
    expect(await ensureSimDemoStore(db, ws, exec({ state: { n: 5 } }))).toMatchObject({ created: false, row: { id: first.id, state: { n: 0 } } });
    await expect(ensureSimDemoStore(db, ws, exec({ rehearsalRunId: randomUUID(), variant: "governed" }))).rejects.toThrow("rehearsalRunId");
    // 別のワークスペース・別の世界は別の店舗
    const other = await fxWorkspace(db);
    expect((await ensureSimDemoStore(db, other, exec())).created).toBe(true);
    expect((await ensureSimDemoStore(db, ws, exec({ world: "brief" }))).created).toBe(true);
  });

  it("同時に8回作っても1つだけ（部分一意索引への ON CONFLICT DO NOTHING）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureSimDemoStore(db, ws, exec())));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.row.id)).size).toBe(1);
    const n = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM sim.executions WHERE workspace_id = $1", [ws.workspaceId]);
    expect(n.rows[0]?.n).toBe(1);
  });

  it("id がほかの走行と重なれば一意の違反（デモ店舗がまだないとき）", async () => {
    const { db } = T();
    const { ws, runId } = await wsWithRun(db);
    const run = exec({ rehearsalRunId: runId, variant: "governed" });
    await insertSimExecution(db, ws, run);
    expect(isUniqueViolation(await rejection(ensureSimDemoStore(db, ws, exec({ id: run.id }))), "executions_pkey")).toBe(true);
  });
});

describe("更新：行ロックと version の楽観ロック", () => {
  it("updateSimExecutionState は version を1つ上げて updated_at を書く。読んだ version と違えば null（何も書かない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const e = exec();
    await insertSimExecution(db, ws, e);
    const r1 = await db.transaction((tx) => updateSimExecutionState(tx, ws, { id: e.id, expectedVersion: 1, state: { n: 1 }, updatedAt: LATER }));
    expect(r1).toMatchObject({ version: 2, state: { n: 1 }, updated_at: LATER, created_at: AT });
    expect(await db.transaction((tx) => updateSimExecutionState(tx, ws, { id: e.id, expectedVersion: 1, state: { n: 99 }, updatedAt: LATER }))).toBeNull();
    const other = await fxWorkspace(db);
    expect(await db.transaction((tx) => updateSimExecutionState(tx, other, { id: e.id, expectedVersion: 2, state: {}, updatedAt: LATER }))).toBeNull();
    expect(await getSimExecution(db, ws, { id: e.id })).toMatchObject({ version: 2, state: { n: 1 } });
  });

  it("ロックせずに読んだ2つの更新：先に書いた方だけが通り、後は version の食い違いで null（楽観ロック）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const e = exec();
    await insertSimExecution(db, ws, e);
    const a = await getSimExecution(db, ws, { id: e.id });
    const b = await getSimExecution(db, ws, { id: e.id });
    const wa = await db.transaction((tx) => updateSimExecutionState(tx, ws, { id: e.id, expectedVersion: a!.version, state: { n: "a" }, updatedAt: LATER }));
    const wb = await db.transaction((tx) => updateSimExecutionState(tx, ws, { id: e.id, expectedVersion: b!.version, state: { n: "b" }, updatedAt: LATER }));
    expect(wa?.version).toBe(2);
    expect(wb).toBeNull();
    expect((await getSimExecution(db, ws, { id: e.id }))?.state).toEqual({ n: "a" });
  });

  it("FOR UPDATE は直列にする：後のロックは先のコミットを待ち、待ったあとは最新の version を読む", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const e = exec();
    await insertSimExecution(db, ws, e);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let firstLocked!: () => void;
    const locked = new Promise<void>((r) => {
      firstLocked = r;
    });
    const order: string[] = [];
    const first = db.transaction(async (tx) => {
      const row = await lockSimExecution(tx, ws, { id: e.id }, "update");
      firstLocked();
      await gate;
      await updateSimExecutionState(tx, ws, { id: e.id, expectedVersion: row!.version, state: { n: 1 }, updatedAt: LATER });
      order.push("first:commit");
    });
    await locked;
    const second = db.transaction(async (tx) => {
      const row = await lockSimExecution(tx, ws, { id: e.id }, "update");
      order.push(`second:locked:v${row!.version}`);
      return row;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual([]);
    releaseFirst();
    await first;
    expect((await second)?.state).toEqual({ n: 1 });
    expect(order).toEqual(["first:commit", "second:locked:v2"]);
  });

  it("lockSimExecution はデモ店舗の鍵でも引け、別のワークスペースは null", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const demo = exec();
    await insertSimExecution(db, ws, demo);
    expect((await db.transaction((tx) => lockSimExecution(tx, ws, { demoStoreOf: "shop" }, "update")))?.id).toBe(demo.id);
    expect(await db.transaction(async (tx) => lockSimExecution(tx, await fxWorkspace(db), { id: demo.id }, "share"))).toBeNull();
  });
});

describe("事象（追記だけ・番号は増えるだけ）", () => {
  it("appendSimEvents は seq の順に足し、getSimExecutionWithEvents・listSimEvents は seq の順で返す。生成列 kind・intent_id", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const e = exec();
    await insertSimExecution(db, ws, e);
    await db.transaction((tx) => appendSimEvents(tx, ws, e.id, [ev(1), { ...ev(2, "clock"), intentId: "intent-1", caller: "clock" }]));
    await db.transaction((tx) => appendSimEvents(tx, ws, e.id, [ev(5)]));
    expect((await listSimEvents(db, ws, e.id)).map((x) => x.seq)).toEqual([1, 2, 5]);
    expect(await lastSimEventSeq(db, ws, e.id)).toBe(5);
    const got = await getSimExecutionWithEvents(db, ws, { id: e.id });
    expect(got?.events.map((x) => x.seq)).toEqual([1, 2, 5]);
    expect(got?.events[1]).toEqual({ ...ev(2, "clock"), intentId: "intent-1", caller: "clock" });
    expect(got?.row).not.toHaveProperty("events");
    const cols = await db.query<{ kind: string; intent_id: string | null }>("SELECT kind, intent_id FROM sim.events WHERE execution_id = $1 ORDER BY seq", [e.id]);
    expect(cols.rows).toEqual([
      { kind: "tool_call", intent_id: null },
      { kind: "clock", intent_id: "intent-1" },
      { kind: "tool_call", intent_id: null },
    ]);
    // 別のワークスペースからは見えない
    const other = await fxWorkspace(db);
    expect(await listSimEvents(db, other, e.id)).toEqual([]);
    expect(await lastSimEventSeq(db, other, e.id)).toBe(0);
    expect(await getSimExecutionWithEvents(db, other, { id: e.id })).toBeNull();
  });

  it("事象のない走行は events = []（デモ店舗の鍵でも）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await insertSimExecution(db, ws, exec());
    expect((await getSimExecutionWithEvents(db, ws, { demoStoreOf: "shop" }))?.events).toEqual([]);
  });

  it("番号が増えていなければ SimEventSeqError で何も足さない（同じ回の中・最後の番号以下・正の整数でない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const e = exec();
    await insertSimExecution(db, ws, e);
    await db.transaction((tx) => appendSimEvents(tx, ws, e.id, [ev(1), ev(2)]));
    for (const bad of [[ev(3), ev(3)], [ev(2)], [ev(1)], [{ ...ev(3), seq: 3.5 }], [{ ...ev(3), seq: "4" }], [ev(0)]]) {
      await expect(db.transaction((tx) => appendSimEvents(tx, ws, e.id, bad))).rejects.toBeInstanceOf(SimEventSeqError);
    }
    expect((await listSimEvents(db, ws, e.id)).map((x) => x.seq)).toEqual([1, 2]);
    expect(await db.transaction((tx) => appendSimEvents(tx, ws, e.id, []))).toBe(0);
    expect(() => assertSimEventSeqs(e.id, [ev(4), ev(6)], 3)).not.toThrow();
    expect(() => assertSimEventSeqs(e.id, [ev(3)], 3)).toThrow("事象の番号が増えていない");
  });

  it("ロックを待ったあとの追記も、待つ間に足された番号を見て確かめる（主キーの違反ではなく SimEventSeqError）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const e = exec();
    await insertSimExecution(db, ws, e);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let lockedFirst!: () => void;
    const locked = new Promise<void>((r) => {
      lockedFirst = r;
    });
    const first = db.transaction(async (tx) => {
      await lockSimExecution(tx, ws, { id: e.id }, "update");
      await appendSimEvents(tx, ws, e.id, [ev(1)]);
      lockedFirst();
      await gate;
    });
    await locked;
    const second = db.transaction(async (tx) => {
      await lockSimExecution(tx, ws, { id: e.id }, "update");
      await appendSimEvents(tx, ws, e.id, [ev(1)]);
    });
    await new Promise((r) => setTimeout(r, 100));
    release();
    await first;
    await expect(second).rejects.toBeInstanceOf(SimEventSeqError);
    expect((await listSimEvents(db, ws, e.id)).map((x) => x.seq)).toEqual([1]);
  });

  it("sim.events は UPDATE できない（追記だけ。トリガー）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const e = exec();
    await insertSimExecution(db, ws, e);
    await db.transaction((tx) => appendSimEvents(tx, ws, e.id, [ev(1)]));
    await expect(db.query("UPDATE sim.events SET event = event WHERE execution_id = $1", [e.id])).rejects.toThrow("immutable");
  });
});

describe("forkSimExecution（承認した分岐：SW §4.1.3）", () => {
  it("状態・初期状態・状況・事象（番号そのまま）を写し、version 1・parent は元。元を進めても分岐は変わらない", async () => {
    const { db } = T();
    const { ws, runId } = await wsWithRun(db);
    const src = exec({ rehearsalRunId: runId, variant: "governed", scenario: { schemaVersion: 1, world: "shop" }, initialState: { n: 0 }, state: { n: 2 }, version: 3 });
    await insertSimExecution(db, ws, src);
    await db.transaction((tx) => appendSimEvents(tx, ws, src.id, [ev(1), ev(2)]));
    const forkId = randomUUID();
    const r = await db.transaction((tx) => forkSimExecution(tx, ws, { sourceId: src.id, id: forkId, variant: "governed_approve", at: LATER }));
    expect(r.status).toBe("created");
    if (r.status !== "created") return;
    expect(r.events).toBe(2);
    expect(r.row).toMatchObject({
      id: forkId,
      parent_execution_id: src.id,
      rehearsal_run_id: runId,
      variant: "governed_approve",
      version: 1,
      state: { n: 2 },
      initial_state: { n: 0 },
      scenario: { schemaVersion: 1, world: "shop" },
      created_at: LATER,
      updated_at: LATER,
    });
    await db.transaction((tx) => updateSimExecutionState(tx, ws, { id: src.id, expectedVersion: 3, state: { n: 3 }, updatedAt: LATER }));
    await db.transaction((tx) => appendSimEvents(tx, ws, src.id, [ev(3)]));
    expect((await getSimExecution(db, ws, { id: forkId }))?.state).toEqual({ n: 2 });
    expect((await listSimEvents(db, ws, forkId)).map((x) => x.seq)).toEqual([1, 2]);
    // 分岐の事象の続きは元と別に足せる
    await db.transaction((tx) => appendSimEvents(tx, ws, forkId, [ev(3)]));
    expect(await db.transaction((tx) => forkSimExecution(tx, ws, { sourceId: src.id, id: forkId, variant: "governed_approve", at: LATER }))).toEqual({
      status: "exists",
    });
    expect(
      await db.transaction(async (tx) => forkSimExecution(tx, await fxWorkspace(db), { sourceId: src.id, id: randomUUID(), variant: "governed_approve", at: LATER })),
    ).toEqual({ status: "source_not_found" });
  });

  it("写している間（FOR SHARE）は元の更新（FOR UPDATE）が待つ", async () => {
    const { db } = T();
    const { ws, runId } = await wsWithRun(db);
    const src = exec({ rehearsalRunId: runId, variant: "governed" });
    await insertSimExecution(db, ws, src);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let shared!: () => void;
    const sharedP = new Promise<void>((r) => {
      shared = r;
    });
    const order: string[] = [];
    const fork = db.transaction(async (tx) => {
      const r = await forkSimExecution(tx, ws, { sourceId: src.id, id: randomUUID(), variant: "governed_approve", at: LATER });
      shared();
      await gate;
      order.push("fork:commit");
      return r;
    });
    await sharedP;
    const update = db.transaction(async (tx) => {
      await lockSimExecution(tx, ws, { id: src.id }, "update");
      order.push("update:locked");
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual([]);
    release();
    await Promise.all([fork, update]);
    expect(order).toEqual(["fork:commit", "update:locked"]);
  });
});

describe("スナップショット（FR-066）", () => {
  function snap(executionId: string, over: Partial<NewSimSnapshot> = {}): NewSimSnapshot {
    return {
      id: randomUUID(),
      world: "shop",
      executionId,
      executionVersion: 3,
      seed: 7,
      seedVersion: "shop-v1",
      state: { n: 3 },
      stateHash: "a".repeat(64),
      sourceTaskId: randomUUID(),
      takenAt: AT,
      ...over,
    };
  }

  it("足して読む（別のワークスペースは null）。同じ id は一意の違反、走行がなければ execution", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const demo = exec();
    await insertSimExecution(db, ws, demo);
    const s = snap(demo.id);
    const row = await insertSimSnapshot(db, ws, s);
    expect(row).toMatchObject({ id: s.id, workspace_id: ws.workspaceId, execution_id: demo.id, execution_version: 3, seed: 7, state: { n: 3 }, taken_at: AT });
    expect(await getSimSnapshot(db, ws, s.id)).toEqual(row);
    expect(await getSimSnapshot(db, await fxWorkspace(db), s.id)).toBeNull();
    expect(isUniqueViolation(await rejection(insertSimSnapshot(db, ws, s)))).toBe(true);
    expect(simMissingReferenceOf(await rejection(insertSimSnapshot(db, ws, snap(randomUUID()))))).toBe("execution");
    // 別のワークスペースの走行は写せない（複合 FK）
    expect(simMissingReferenceOf(await rejection(insertSimSnapshot(db, await fxWorkspace(db), snap(demo.id))))).toBe("execution");
  });
});

describe("deleteSimWorkspaceRows（15:375、SW-13・T-161）", () => {
  it("そのワークスペースの事象・スナップショット・走行（分岐を含む）を数えて消し、ほかは残す。2回目は全部0", async () => {
    const { db } = T();
    const a = await wsWithRun(db);
    const b = await wsWithRun(db);
    for (const { ws, runId } of [a, b]) {
      const demo = exec();
      await insertSimExecution(db, ws, demo);
      await db.transaction((tx) => appendSimEvents(tx, ws, demo.id, [ev(1), ev(2)]));
      await insertSimSnapshot(db, ws, {
        id: randomUUID(),
        world: "shop",
        executionId: demo.id,
        executionVersion: 1,
        seed: 7,
        seedVersion: "shop-v1",
        state: { n: 0 },
        stateHash: "b".repeat(64),
        sourceTaskId: randomUUID(),
        takenAt: AT,
      });
      const run = exec({ rehearsalRunId: runId, variant: "governed" });
      await insertSimExecution(db, ws, run);
      await db.transaction((tx) => appendSimEvents(tx, ws, run.id, [ev(1)]));
      await db.transaction((tx) => forkSimExecution(tx, ws, { sourceId: run.id, id: randomUUID(), variant: "governed_approve", at: AT }));
    }
    expect(await db.transaction((tx) => deleteSimWorkspaceRows(tx, a.ws))).toEqual({ executions: 3, events: 4, snapshots: 1 });
    const left = await db.query<{ ws: string; e: number; v: number; s: number }>(
      `SELECT w.id AS ws,
              (SELECT count(*)::int FROM sim.executions WHERE workspace_id = w.id) AS e,
              (SELECT count(*)::int FROM sim.events WHERE workspace_id = w.id) AS v,
              (SELECT count(*)::int FROM sim.snapshots WHERE workspace_id = w.id) AS s
         FROM workspaces w WHERE w.id = ANY($1::uuid[]) ORDER BY w.id = $2 DESC`,
      [[a.ws.workspaceId, b.ws.workspaceId], a.ws.workspaceId],
    );
    expect(left.rows).toEqual([
      { ws: a.ws.workspaceId, e: 0, v: 0, s: 0 },
      { ws: b.ws.workspaceId, e: 3, v: 4, s: 1 },
    ]);
    expect(await db.transaction((tx) => deleteSimWorkspaceRows(tx, a.ws))).toEqual({ executions: 0, events: 0, snapshots: 0 });
  });

  it("DB T-16 試験が参照しているスナップショットがあれば外部キーの違反で、トランザクションごと何も消えない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const agent = await fxAgent(db, ws);
    const { taskId } = await fxTask(db, ws, agent);
    const demo = exec();
    await insertSimExecution(db, ws, demo);
    const s = await insertSimSnapshot(db, ws, {
      id: randomUUID(),
      world: "shop",
      executionId: demo.id,
      executionVersion: 1,
      seed: 7,
      seedVersion: "shop-v1",
      state: { n: 0 },
      stateHash: "c".repeat(64),
      sourceTaskId: taskId,
      takenAt: AT,
    });
    await fxRehearsalCase(db, ws, { jobId: agent.jobId, source: "incident", simSnapshotId: s.id, sourceTaskId: taskId });
    const e = await rejection(db.transaction((tx) => deleteSimWorkspaceRows(tx, ws)));
    expect(isForeignKeyViolation(e, "rehearsal_cases_sim_snapshot_fk")).toBe(true);
    expect(await getSimExecution(db, ws, { id: demo.id })).not.toBeNull();
    expect(await getSimSnapshot(db, ws, s.id)).not.toBeNull();
  });

  it("ワークスペースの行を消すと sim の行も CASCADE で消え、そのあとの掃除は何もしない（冪等：SO §3.16 の4）", async () => {
    const { db } = T();
    const { ws, runId } = await wsWithRun(db);
    const run = exec({ rehearsalRunId: runId, variant: "governed" });
    await insertSimExecution(db, ws, run);
    await db.transaction((tx) => appendSimEvents(tx, ws, run.id, [ev(1)]));
    await db.query("DELETE FROM workspaces WHERE id = $1", [ws.workspaceId]);
    expect(await getSimExecution(db, ws, { id: run.id })).toBeNull();
    expect(await db.transaction((tx) => deleteSimWorkspaceRows(tx, ws))).toEqual({ executions: 0, events: 0, snapshots: 0 });
    // リハーサルの走行を消しても、その sim の走行は CASCADE で消える（sim_executions_rehearsal_run_fk）
    const c = await wsWithRun(db);
    const run2 = exec({ rehearsalRunId: c.runId, variant: "shadow" });
    await insertSimExecution(db, c.ws, run2);
    await db.query("DELETE FROM rehearsal_runs WHERE id = $1", [c.runId]);
    expect(await getSimExecution(db, c.ws, { id: run2.id })).toBeNull();
  });
});

describe("ot_sim のロール（SO §4.6：sim スキーマだけ）", () => {
  it("作成・ロック・更新・追記・分岐・スナップショット・掃除がすべて ot_sim の権限で動く（外部キーの確かめは表の所有者の権限）", async () => {
    const { db, url } = T();
    const { ws, runId } = await wsWithRun(db);
    const sim = await openRoleDb(url, "ot_sim");
    try {
      const demo = await ensureSimDemoStore(sim, ws, exec());
      expect(demo.created).toBe(true);
      const run = exec({ rehearsalRunId: runId, variant: "governed" });
      expect(await insertSimExecution(sim, ws, run)).not.toBeNull();
      await sim.transaction(async (tx) => {
        const row = await lockSimExecution(tx, ws, { id: run.id }, "update");
        await appendSimEvents(tx, ws, run.id, [ev(1)]);
        await updateSimExecutionState(tx, ws, { id: run.id, expectedVersion: row!.version, state: { n: 1 }, updatedAt: LATER });
      });
      const fork = await sim.transaction((tx) => forkSimExecution(tx, ws, { sourceId: run.id, id: randomUUID(), variant: "governed_approve", at: LATER }));
      expect(fork.status).toBe("created");
      await insertSimSnapshot(sim, ws, {
        id: randomUUID(),
        world: "shop",
        executionId: demo.row.id,
        executionVersion: 1,
        seed: 7,
        seedVersion: "shop-v1",
        state: { n: 0 },
        stateHash: "d".repeat(64),
        sourceTaskId: randomUUID(),
        takenAt: AT,
      });
      expect((await getSimExecutionWithEvents(sim, ws, { id: run.id }))?.events).toHaveLength(1);
      // 参照先がないときの外部キーの違反も、権限の違反（42501）ではなく 23503 になる
      const missing = await rejection(insertSimExecution(sim, ws, exec({ rehearsalRunId: randomUUID(), variant: "governed" })));
      expect(simMissingReferenceOf(missing)).toBe("rehearsal_run");
      expect(await sim.transaction((tx) => deleteSimWorkspaceRows(tx, ws))).toEqual({ executions: 3, events: 2, snapshots: 1 });
    } finally {
      await sim.close();
    }
  });
});
