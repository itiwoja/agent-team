// PostgresSimStore（M-40）。試験ごとに新しいデータベース（@open-team/db/testing）で、保存は ot_sim のロールの接続（SO §4.6）。
// 行（ワークスペース・リハーサルの走行・試験）は表の所有者の接続で作る（ot_sim は public の表を見られない）
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Db, Tx } from "@open-team/db";
import { fxAgent, fxRehearsalCase, fxTask, useTestDb } from "@open-team/db/testing";
import { SHOP_SEED_VERSION, SHOP_WORLD, type ShopState } from "@open-team/sim-core";
import { openSimDb, pgFixtures, type PgFixtures } from "./__fixtures__/pg.ts";
import { contractRecord, describeSimStoreContract, type SimStoreHarness } from "./__fixtures__/store-contract.ts";
import { PostgresSimStore } from "./postgres-store.ts";
import { SimStoreConflictError, SimStoreInUseError, SimStoreReferenceError } from "./store.ts";

const T = useTestDb();
const AT = "2026-10-14T01:00:00.000Z";

async function pgHarness(): Promise<SimStoreHarness> {
  const { db, url } = T();
  const sim = await openSimDb(url);
  const fx = pgFixtures(db);
  return {
    store: new PostgresSimStore(sim),
    workspace: () => fx.workspace(),
    rehearsalRun: (ws) => fx.rehearsalRun(ws),
    counts: (ws) => fx.counts(ws),
    close: () => sim.close(),
  };
}

// SimStore の約束（メモリの memory-store.test.ts と同じ関数）。ot_sim の権限だけで全部の操作が通ることも確かめる
describeSimStoreContract("PostgresSimStore（ot_sim のロール）", pgHarness);

/** ot_sim の接続を開いて試験し、閉じる */
async function withSim<R>(fn: (sim: Db, ctx: { db: Db; fx: PgFixtures }) => Promise<R>): Promise<R> {
  const { db, url } = T();
  const sim = await openSimDb(url);
  try {
    return await fn(sim, { db, fx: pgFixtures(db) });
  } finally {
    await sim.close();
  }
}

/**
 * ロックを飛ばした書き込みをまねる Db：状態を書く UPDATE の直前に、同じトランザクションで version だけを上げる
 * （行ロックの中では起きないはずの食い違いを起こし、楽観ロックの確かめが効くかを見る）
 */
function versionBumpingDb(db: Db): Db {
  const wrapTx = (tx: Tx): Tx => ({
    ...tx,
    query: (async (text: string, params?: readonly unknown[]) => {
      if (/^UPDATE sim\.executions SET state/.test(text.trim())) {
        await tx.query("UPDATE sim.executions SET version = version + 1 WHERE id = $1", [params?.[1]]);
      }
      return tx.query(text, params);
    }) as Tx["query"],
  });
  return { ...db, transaction: (fn, opts) => db.transaction((tx) => fn(wrapTx(tx)), opts) };
}

describe("PostgresSimStore だけの振る舞い（外部キー・ロック・複数のインスタンス）", () => {
  it("参照先がない行は SimStoreReferenceError（ワークスペース・リハーサルの走行・写す走行）。何も作らない", async () => {
    await withSim(async (sim, { fx }) => {
      const store = new PostgresSimStore(sim);
      const ghost = randomUUID();
      const e1 = await store.ensureDemoStore(contractRecord({ workspaceId: ghost })).catch((e: unknown) => e);
      expect(e1).toBeInstanceOf(SimStoreReferenceError);
      expect((e1 as SimStoreReferenceError).reference).toBe("workspace");
      const ws = await fx.workspace();
      const e2 = await store.createExecution(contractRecord({ workspaceId: ws, rehearsalRunId: randomUUID(), variant: "governed" })).catch((e: unknown) => e);
      expect((e2 as SimStoreReferenceError).reference).toBe("rehearsal_run");
      // 別のワークスペースのリハーサルの走行も「ない」（複合 FK）
      const other = await fx.workspace();
      const otherRun = await fx.rehearsalRun(other);
      const e3 = await store.createExecution(contractRecord({ workspaceId: ws, rehearsalRunId: otherRun, variant: "governed" })).catch((e: unknown) => e);
      expect((e3 as SimStoreReferenceError).reference).toBe("rehearsal_run");
      const e4 = await store
        .insertSnapshot({
          id: randomUUID(),
          workspaceId: ws,
          world: "shop",
          executionId: randomUUID(),
          executionVersion: 1,
          seed: 1,
          seedVersion: "shop-v1",
          state: { n: 0 },
          stateHash: "a".repeat(64),
          sourceTaskId: randomUUID(),
          takenAt: AT,
        })
        .catch((e: unknown) => e);
      expect((e4 as SimStoreReferenceError).reference).toBe("execution");
      expect(await fx.counts(ws)).toEqual({ executions: 0, events: 0, snapshots: 0 });
    });
  });

  it("DB T-16 試験が参照しているスナップショットがあれば deleteWorkspace は SimStoreInUseError で、何も消さない", async () => {
    await withSim(async (sim, { db, fx }) => {
      const store = new PostgresSimStore(sim);
      const ws = await fx.workspace();
      const agent = await fxAgent(db, fx.ws(ws));
      const { taskId } = await fxTask(db, fx.ws(ws), agent);
      const demo = (await store.ensureDemoStore(contractRecord({ workspaceId: ws }))).execution;
      const snapshotId = randomUUID();
      await store.insertSnapshot({
        id: snapshotId,
        workspaceId: ws,
        world: "shop",
        executionId: demo.id,
        executionVersion: 1,
        seed: 1,
        seedVersion: "shop-v1",
        state: { n: 0 },
        stateHash: "a".repeat(64),
        sourceTaskId: taskId,
        takenAt: AT,
      });
      await fxRehearsalCase(db, fx.ws(ws), { jobId: agent.jobId, source: "incident", simSnapshotId: snapshotId, sourceTaskId: taskId });
      const e = await store.deleteWorkspace(ws).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SimStoreInUseError);
      expect(await fx.counts(ws)).toEqual({ executions: 1, events: 0, snapshots: 1 });
    });
  });

  it("15:375 掃除でワークスペースの行を消すと（CASCADE）sim の行も消え、store からは見えない。そのあとの deleteWorkspace は0件", async () => {
    await withSim(async (sim, { db, fx }) => {
      const store = new PostgresSimStore(sim);
      const ws = await fx.workspace();
      const run = contractRecord({ workspaceId: ws, rehearsalRunId: await fx.rehearsalRun(ws), variant: "governed" });
      await store.createExecution(run);
      await store.updateExecution({ workspaceId: ws, id: run.id }, () => ({
        kind: "write",
        state: { n: 1 },
        events: [{ seq: 1, at: AT, kind: "clock", caller: "clock" }],
        updatedAt: AT,
        value: null,
      }));
      await db.query("DELETE FROM workspaces WHERE id = $1", [ws]);
      expect(await store.getExecution({ workspaceId: ws, id: run.id })).toBeNull();
      expect(await store.deleteWorkspace(ws)).toEqual({ executions: 0, events: 0, snapshots: 0 });
    });
  });

  it("楽観ロック：ロックを飛ばした書き込みが先に version を上げていたら SimStoreConflictError で、状態も事象も書かない", async () => {
    await withSim(async (sim, { fx }) => {
      const ws = await fx.workspace();
      const rec = contractRecord({ workspaceId: ws, rehearsalRunId: await fx.rehearsalRun(ws), variant: "governed" });
      await new PostgresSimStore(sim).createExecution(rec);
      const store = new PostgresSimStore(versionBumpingDb(sim));
      const write = () => ({ kind: "write" as const, state: { n: 1 }, events: [{ seq: 1, at: AT, kind: "clock" as const, caller: "clock" as const }], updatedAt: AT, value: 1 });
      const e = await store.updateExecution({ workspaceId: ws, id: rec.id }, write).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SimStoreConflictError);
      expect((e as Error).message).toContain(rec.id);
      const got = await new PostgresSimStore(sim).getExecutionWithEvents({ workspaceId: ws, id: rec.id });
      expect(got?.execution).toMatchObject({ version: 1, state: { n: 0 } });
      expect(got?.events).toEqual([]);
      // keep は UPDATE を流さないので食い違いの確かめもない
      expect((await store.updateExecution({ workspaceId: ws, id: rec.id }, () => ({ kind: "keep", value: "ok" })))?.value).toBe("ok");
    });
  });

  it("Cloud Run の複数のインスタンス（別の接続・別のストア）からの同時の更新も、行ロックで直列になる（version・番号が飛ばない）", async () => {
    await withSim(async (sim, { fx }) => {
      const { url } = T();
      const sim2 = await openSimDb(url, 2);
      try {
        const a = new PostgresSimStore(sim);
        const b = new PostgresSimStore(sim2);
        const ws = await fx.workspace();
        const demo = (await a.ensureDemoStore(contractRecord({ workspaceId: ws }))).execution;
        // 別のインスタンスが同じデモ店舗を作ろうとしても1つ
        expect(await b.ensureDemoStore(contractRecord({ workspaceId: ws }))).toMatchObject({ created: false, execution: { id: demo.id } });
        const key = { workspaceId: ws, demoStoreOf: "shop" as const };
        const bump = (cur: { state: unknown }) => {
          const n = (cur.state as { n: number }).n + 1;
          return { kind: "write" as const, state: { n }, events: [{ seq: n, at: AT, kind: "clock" as const, caller: "clock" as const }], updatedAt: AT, value: n };
        };
        await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? a : b).updateExecution(key, bump)));
        const got = await b.getExecutionWithEvents(key);
        expect(got?.execution).toMatchObject({ id: demo.id, version: 21, state: { n: 20 } });
        expect(got?.events.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      } finally {
        await sim2.close();
      }
    });
  });

  it("jsonb の往復でキーの順が変わっても、shop の状態は同じ値・同じ状態のハッシュ（SW §4.4.9）で、続きの処理も同じ結果", async () => {
    await withSim(async (sim, { fx }) => {
      const store = new PostgresSimStore(sim);
      const ws = await fx.workspace();
      const initial = SHOP_WORLD.createInitialState(1234, { seedVersion: SHOP_SEED_VERSION, startDate: "2026-10-06" });
      const demo = contractRecord({ workspaceId: ws, seed: 1234, initialState: initial, state: initial });
      await store.ensureDemoStore(demo);
      const back = await store.getExecution({ workspaceId: ws, demoStoreOf: "shop" });
      expect(back?.state).toEqual(initial);
      const saved = back!.state as ShopState;
      expect(SHOP_WORLD.stateHash(saved)).toBe(SHOP_WORLD.stateHash(initial));
      // 同じ呼び出しを、保存した状態と元の状態にかけて同じ結果（在庫の並びは商品の表の順：sim-core の注記）
      const ctx = { caller: "sa-gateway" as const, taskId: null, intentId: null, shadow: false };
      const call = { connector: "store", tool: "get_inventory", args: {} };
      const fromDb = SHOP_WORLD.handleTool(saved, call, ctx);
      const fromMemory = SHOP_WORLD.handleTool(initial, call, ctx);
      expect(JSON.stringify(fromDb.kind === "ok" ? fromDb.result : null)).toBe(JSON.stringify(fromMemory.kind === "ok" ? fromMemory.result : null));
      expect(SHOP_WORLD.stateHash(fromDb.state)).toBe(SHOP_WORLD.stateHash(fromMemory.state));
    });
  });

  it("jsonb に入らない値（U+0000 を含む文字列）は保存できず、例外で何も書かない（メモリの保存との違い）", async () => {
    await withSim(async (sim, { fx }) => {
      const store = new PostgresSimStore(sim);
      const ws = await fx.workspace();
      await store.ensureDemoStore(contractRecord({ workspaceId: ws }));
      const key = { workspaceId: ws, demoStoreOf: "shop" as const };
      await expect(
        store.updateExecution(key, () => ({ kind: "write", state: { n: 1, note: "a\u0000b" }, events: [], updatedAt: AT, value: null })),
      ).rejects.toThrow();
      expect((await store.getExecution(key))?.state).toEqual({ n: 0 });
      // そのあとの更新は普通に通る（ロックは残らない）
      expect((await store.updateExecution(key, () => ({ kind: "write", state: { n: 2 }, events: [], updatedAt: AT, value: 2 })))?.value).toBe(2);
    });
  });

  it("行の値の型：seed は number（bigint）、時刻は toISOString の形、状況の null は null", async () => {
    await withSim(async (sim, { fx }) => {
      const store = new PostgresSimStore(sim);
      const ws = await fx.workspace();
      const r = await store.ensureDemoStore(contractRecord({ workspaceId: ws, seed: 4_294_967_295, createdAt: "2026-10-14T01:02:03.456Z", updatedAt: "2026-10-14T01:02:03.456Z" }));
      expect(r.execution).toMatchObject({ seed: 4_294_967_295, createdAt: "2026-10-14T01:02:03.456Z", scenario: null, snapshotId: null, parentExecutionId: null });
      expect(typeof r.execution.seed).toBe("number");
    });
  });
});
