// SimStore の約束の試験（メモリと Postgres に同じ関数で流す：store.ts の注記、M-40）。試験からだけ使う（vitest を import する）。
// harness はワークスペース・リハーサルの走行を用意する（Postgres は外部キーがあるので実際の行、メモリは新しい ID だけ）

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ScenarioSchema, type SimEvent } from "@open-team/sim-core";
import type { DeleteCounts, ExecutionChange, SimExecutionRecord, SimSnapshotRecord, SimStore } from "../store.ts";

export interface SimStoreHarness {
  store: SimStore;
  /** 新しいワークスペース（Postgres：workspaces の行。メモリ：新しい ID） */
  workspace(): Promise<string>;
  /** そのワークスペースのリハーサルの走行（Postgres：rehearsal_runs の行） */
  rehearsalRun(workspaceId: string): Promise<string>;
  /** そのワークスペースの sim の行の数 */
  counts(workspaceId: string): Promise<DeleteCounts>;
  /** 試験の終わりに閉じるもの */
  close?(): Promise<void>;
}

const AT = "2026-10-14T01:00:00.000Z";

export function contractRecord(over: Partial<SimExecutionRecord> & Pick<SimExecutionRecord, "workspaceId">): SimExecutionRecord {
  return {
    id: randomUUID(),
    world: "shop",
    rehearsalRunId: null,
    parentExecutionId: null,
    variant: "live",
    seed: 1,
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

const ev = (seq: number): SimEvent => ({ seq, at: "2026-10-06T18:00:00+09:00", kind: "tool_call", tool: "store.get_inventory", caller: "sa-gateway" });

/** 状態 { n } を1つ増やし、番号 n の事象を1つ足す */
const bump =
  (at = AT) =>
  (cur: SimExecutionRecord): ExecutionChange<number> => {
    const n = (cur.state as { n: number }).n + 1;
    return { kind: "write", state: { n }, events: [ev(n)], updatedAt: at, value: n };
  };

export function describeSimStoreContract(label: string, open: () => SimStoreHarness | Promise<SimStoreHarness>): void {
  /** harness を開いて試験し、終わったら閉じる */
  const withHarness = (fn: (h: SimStoreHarness) => Promise<void>) => async () => {
    const h = await open();
    try {
      await fn(h);
    } finally {
      await h.close?.();
    }
  };
  /** リハーサルの走行の記録（governed） */
  const runRecord = async (h: SimStoreHarness, over: Partial<SimExecutionRecord> = {}): Promise<SimExecutionRecord> => {
    const workspaceId = over.workspaceId ?? (await h.workspace());
    const rehearsalRunId = over.rehearsalRunId ?? (await h.rehearsalRun(workspaceId));
    return contractRecord({ variant: "governed", ...over, workspaceId, rehearsalRunId });
  };

  describe(`${label}：SimStore の約束（M-40：状態は jsonb 1行・version、事象は追記だけ、workspace_id で絞る）`, () => {
    it(
      "ISO-02 別のワークスペースの id では引けない・書けない・写せない（fn も呼ばない）",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        expect(await h.store.createExecution(rec)).toBe("created");
        const other = await h.workspace();
        expect(await h.store.getExecution({ workspaceId: other, id: rec.id })).toBeNull();
        expect(await h.store.getExecutionWithEvents({ workspaceId: other, id: rec.id })).toBeNull();
        let called = false;
        expect(
          await h.store.updateExecution({ workspaceId: other, id: rec.id }, (cur) => {
            called = true;
            return bump()(cur);
          }),
        ).toBeNull();
        expect(called).toBe(false);
        expect(await h.store.forkExecution({ workspaceId: other, sourceId: rec.id, id: randomUUID(), variant: "governed_approve", at: AT })).toEqual({
          status: "source_not_found",
        });
        expect((await h.store.getExecution({ workspaceId: rec.workspaceId, id: rec.id }))?.version).toBe(1);
        expect(await h.store.updateExecution({ workspaceId: rec.workspaceId, id: randomUUID() }, bump())).toBeNull();
      }),
    );

    it(
      "同じ id は作らずに exists（別のワークスペースからでも。元の行は変わらない）",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const other = await h.workspace();
        expect(await h.store.createExecution({ ...rec, workspaceId: other, rehearsalRunId: await h.rehearsalRun(other) })).toBe("exists");
        expect(await h.store.createExecution({ ...rec, state: { n: 9 } })).toBe("exists");
        expect((await h.store.getExecution({ workspaceId: rec.workspaceId, id: rec.id }))?.state).toEqual({ n: 0 });
      }),
    );

    it(
      "作った行を同じ値で読める（記録の項目すべて・時刻は toISOString の形）",
      withHarness(async (h) => {
        const rec = await runRecord(h, {
          seed: 4_294_967_295,
          scenario: ScenarioSchema.parse({
            schemaVersion: 1,
            world: "shop",
            seed: 7,
            title: "試験の状況",
            faults: [{ id: "F-05", sku: "BEAN-HOUSE" }],
            agentRuns: 1,
            endAt: "day2_end",
            origin: { source: "generated" },
          }),
          initialState: { n: 0, list: [1, { b: 2, a: 1 }] },
          state: { n: 0, list: [1, { b: 2, a: 1 }] },
          createdAt: "2026-10-14T01:00:00.123Z",
          updatedAt: "2026-10-14T01:00:00.123Z",
        });
        await h.store.createExecution(rec);
        expect(await h.store.getExecution({ workspaceId: rec.workspaceId, id: rec.id })).toEqual(rec);
      }),
    );

    it(
      "updateExecution：version が1ずつ増え、事象は seq の順に追記、updatedAt を書く（createdAt・initialState はそのまま）",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        const r1 = await h.store.updateExecution(key, bump("2026-10-14T02:00:00.000Z"));
        const r2 = await h.store.updateExecution(key, bump("2026-10-14T03:00:00.000Z"));
        expect([r1?.value, r2?.value]).toEqual([1, 2]);
        expect(r2?.execution).toMatchObject({ version: 3, state: { n: 2 }, updatedAt: "2026-10-14T03:00:00.000Z" });
        const got = await h.store.getExecutionWithEvents(key);
        expect(got?.execution).toMatchObject({ version: 3, state: { n: 2 }, initialState: { n: 0 }, updatedAt: "2026-10-14T03:00:00.000Z", createdAt: AT });
        expect(got?.events).toEqual([ev(1), ev(2)]);
      }),
    );

    it(
      "fn には今の行（最新の version・state）を渡す。1回の更新で複数の事象を足せる",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        await h.store.updateExecution(key, bump());
        const seen: Array<{ version: number; state: unknown }> = [];
        await h.store.updateExecution(key, (cur) => {
          seen.push({ version: cur.version, state: cur.state });
          return { kind: "write", state: { n: 3 }, events: [ev(2), ev(3)], updatedAt: AT, value: null };
        });
        expect(seen).toEqual([{ version: 2, state: { n: 1 } }]);
        expect((await h.store.getExecutionWithEvents(key))?.events.map((e) => e.seq)).toEqual([1, 2, 3]);
      }),
    );

    it(
      "keep は何も書かない（version・updatedAt はそのまま）",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        const r = await h.store.updateExecution(key, () => ({ kind: "keep", value: "same" }));
        expect(r).toMatchObject({ value: "same", execution: { version: 1 } });
        expect((await h.store.getExecution(key))?.updatedAt).toBe(AT);
      }),
    );

    it(
      "fn が例外を投げた・事象の番号が増えていない（同じ回の中・前の回以下）なら何も書かない。そのあとの更新は普通に通る",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        await expect(
          h.store.updateExecution(key, () => {
            throw new RangeError("壊れた入力");
          }),
        ).rejects.toThrow(RangeError);
        await expect(
          h.store.updateExecution(key, (cur) => ({ kind: "write", state: { n: 9 }, events: [ev(1), ev(1)], updatedAt: AT, value: cur.version })),
        ).rejects.toThrow("事象の番号");
        let got = await h.store.getExecutionWithEvents(key);
        expect(got?.execution).toMatchObject({ version: 1, state: { n: 0 } });
        expect(got?.events).toEqual([]);
        expect((await h.store.updateExecution(key, bump()))?.value).toBe(1);
        // 前の回の番号（1）以下は足さない
        await expect(
          h.store.updateExecution(key, () => ({ kind: "write", state: { n: 9 }, events: [ev(1)], updatedAt: AT, value: 0 })),
        ).rejects.toThrow("事象の番号");
        got = await h.store.getExecutionWithEvents(key);
        expect(got?.execution).toMatchObject({ version: 2, state: { n: 1 } });
        expect(got?.events.map((e) => e.seq)).toEqual([1]);
        expect((await h.store.updateExecution(key, bump()))?.value).toBe(2);
      }),
    );

    it(
      "同じ走行の更新は直列化される（並行に40回 → version 41・事象 40件・番号が飛ばない）",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        const values = await Promise.all(Array.from({ length: 40 }, () => h.store.updateExecution(key, bump()).then((r) => r?.value)));
        expect([...values].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
        const got = await h.store.getExecutionWithEvents(key);
        expect(got?.execution.version).toBe(41);
        expect(got?.events.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      }),
    );

    it(
      "違う走行の更新は互いに待たずに進み、混ざらない",
      withHarness(async (h) => {
        const a = await runRecord(h);
        const b = await runRecord(h, { workspaceId: a.workspaceId, rehearsalRunId: a.rehearsalRunId });
        await h.store.createExecution(a);
        await h.store.createExecution(b);
        await Promise.all(
          Array.from({ length: 10 }, (_, i) => h.store.updateExecution({ workspaceId: a.workspaceId, id: i % 2 === 0 ? a.id : b.id }, bump())),
        );
        for (const id of [a.id, b.id]) {
          const got = await h.store.getExecutionWithEvents({ workspaceId: a.workspaceId, id });
          expect(got?.execution).toMatchObject({ version: 6, state: { n: 5 } });
          expect(got?.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
        }
      }),
    );

    it(
      "getExecutionWithEvents は状態と事象を同じ時点で読む（更新と同時に読んでも state.n = 事象の数）",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        const reads: Array<Promise<{ execution: SimExecutionRecord; events: SimEvent[] } | null>> = [];
        const writes: Array<Promise<unknown>> = [];
        for (let i = 0; i < 15; i++) {
          writes.push(h.store.updateExecution(key, bump()));
          reads.push(h.store.getExecutionWithEvents(key));
        }
        await Promise.all(writes);
        for (const r of await Promise.all(reads)) {
          expect(r).not.toBeNull();
          expect((r!.execution.state as { n: number }).n).toBe(r!.events.length);
          expect(r!.execution.version).toBe(r!.events.length + 1);
        }
      }),
    );

    it(
      "読み出し・保存は jsonb と同じ写し（呼び出し側のオブジェクトを変えても保存は変わらない・undefined は落ちる）",
      withHarness(async (h) => {
        const state = { n: 0, nested: { a: 1 }, gone: undefined };
        const rec = await runRecord(h, { state });
        await h.store.createExecution(rec);
        state.nested.a = 999;
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        const got = await h.store.getExecution(key);
        expect(got?.state).toEqual({ n: 0, nested: { a: 1 } });
        expect(Object.keys(got?.state as object)).not.toContain("gone");
        (got!.state as { n: number }).n = 42;
        expect(((await h.store.getExecution(key))?.state as { n: number }).n).toBe(0);
        // fn に渡すのも写し（中で書き換えても保存されない）
        await h.store.updateExecution(key, (cur) => {
          (cur.state as { n: number }).n = 77;
          return { kind: "keep", value: null };
        });
        expect(((await h.store.getExecution(key))?.state as { n: number }).n).toBe(0);
        // 書いた状態の undefined も落ちる
        await h.store.updateExecution(key, () => ({ kind: "write", state: { n: 1, gone: undefined }, events: [], updatedAt: AT, value: null }));
        expect((await h.store.getExecution(key))?.state).toEqual({ n: 1 });
      }),
    );

    it(
      "SO-SIM-06 デモ店舗は (workspace, world) に1つ。rehearsalRunId が null の行を引く",
      withHarness(async (h) => {
        const ws = await h.workspace();
        const demo = contractRecord({ workspaceId: ws });
        // 同じワークスペースのリハーサルの走行はデモ店舗として引かない
        await h.store.createExecution(await runRecord(h, { workspaceId: ws }));
        expect(await h.store.getExecution({ workspaceId: ws, demoStoreOf: "shop" })).toBeNull();
        const first = await h.store.ensureDemoStore(demo);
        const second = await h.store.ensureDemoStore({ ...demo, id: randomUUID(), state: { n: 5 } });
        expect(first).toMatchObject({ created: true, execution: { id: demo.id, variant: "live", version: 1 } });
        expect(second).toMatchObject({ created: false, execution: { id: demo.id, state: { n: 0 } } });
        expect((await h.store.getExecution({ workspaceId: ws, demoStoreOf: "shop" }))?.id).toBe(demo.id);
        expect(await h.store.getExecution({ workspaceId: ws, demoStoreOf: "brief" })).toBeNull();
        expect(await h.store.getExecution({ workspaceId: await h.workspace(), demoStoreOf: "shop" })).toBeNull();
        await expect(h.store.ensureDemoStore(await runRecord(h))).rejects.toThrow("rehearsalRunId");
        // デモ店舗も鍵で更新できる（事象も同じ鍵で読める）
        expect((await h.store.updateExecution({ workspaceId: ws, demoStoreOf: "shop" }, bump()))?.execution.id).toBe(demo.id);
        expect((await h.store.getExecutionWithEvents({ workspaceId: ws, demoStoreOf: "shop" }))?.events.map((e) => e.seq)).toEqual([1]);
      }),
    );

    it(
      "SD-07 ensureDemoStore を同時に8回呼んでも1つだけ作る（全部同じ ID を返す）",
      withHarness(async (h) => {
        const ws = await h.workspace();
        const results = await Promise.all(Array.from({ length: 8 }, () => h.store.ensureDemoStore(contractRecord({ workspaceId: ws }))));
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(new Set(results.map((r) => r.execution.id)).size).toBe(1);
        expect((await h.counts(ws)).executions).toBe(1);
      }),
    );

    it(
      "SW-12 fork：状態・初期状態・状況・事象を写した新しい走行（version 1）。元を進めても分岐は変わらない",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        await h.store.updateExecution(key, bump());
        const forkId = randomUUID();
        const f = await h.store.forkExecution({ workspaceId: rec.workspaceId, sourceId: rec.id, id: forkId, variant: "governed_approve", at: "2026-10-14T05:00:00.000Z" });
        expect(f.status).toBe("created");
        if (f.status !== "created") return;
        expect(f.execution).toMatchObject({
          id: forkId,
          workspaceId: rec.workspaceId,
          rehearsalRunId: rec.rehearsalRunId,
          parentExecutionId: rec.id,
          variant: "governed_approve",
          version: 1,
          state: { n: 1 },
          initialState: { n: 0 },
          seed: rec.seed,
          seedVersion: rec.seedVersion,
          createdAt: "2026-10-14T05:00:00.000Z",
          updatedAt: "2026-10-14T05:00:00.000Z",
        });
        await h.store.updateExecution(key, bump());
        const branch = await h.store.getExecutionWithEvents({ workspaceId: rec.workspaceId, id: forkId });
        expect(branch?.execution.state).toEqual({ n: 1 });
        expect(branch?.events.map((e) => e.seq)).toEqual([1]);
        // 分岐は元の番号の続きから進む
        expect((await h.store.updateExecution({ workspaceId: rec.workspaceId, id: forkId }, bump()))?.execution).toMatchObject({ version: 2, state: { n: 2 } });
        expect((await h.store.getExecutionWithEvents(key))?.events.map((e) => e.seq)).toEqual([1, 2]);
        expect(await h.store.forkExecution({ workspaceId: rec.workspaceId, sourceId: rec.id, id: forkId, variant: "governed_approve", at: AT })).toEqual({
          status: "exists",
        });
      }),
    );

    it(
      "fork は状態と事象を同じ時点で写す（元の更新と同時に走らせても、分岐の state.n = 事象の数）",
      withHarness(async (h) => {
        const rec = await runRecord(h);
        await h.store.createExecution(rec);
        const key = { workspaceId: rec.workspaceId, id: rec.id };
        const forks: string[] = [];
        const work: Array<Promise<unknown>> = [];
        for (let i = 0; i < 12; i++) {
          work.push(h.store.updateExecution(key, bump()));
          if (i % 3 === 1) {
            const id = randomUUID();
            forks.push(id);
            work.push(h.store.forkExecution({ workspaceId: rec.workspaceId, sourceId: rec.id, id, variant: "governed_approve", at: AT }));
          }
        }
        await Promise.all(work);
        for (const id of forks) {
          const b = await h.store.getExecutionWithEvents({ workspaceId: rec.workspaceId, id });
          expect((b!.execution.state as { n: number }).n).toBe(b!.events.length);
          expect(b!.events.map((e) => e.seq)).toEqual(Array.from({ length: b!.events.length }, (_, i) => i + 1));
        }
        expect((await h.store.getExecution(key))?.version).toBe(13);
      }),
    );

    it(
      "スナップショット：ワークスペースで絞る。同じ id は例外",
      withHarness(async (h) => {
        const ws = await h.workspace();
        const demo = (await h.store.ensureDemoStore(contractRecord({ workspaceId: ws }))).execution;
        const snap: SimSnapshotRecord = {
          id: randomUUID(),
          workspaceId: ws,
          world: "shop",
          executionId: demo.id,
          executionVersion: 3,
          seed: 1,
          seedVersion: "shop-v1",
          state: { n: 3, nested: { b: 1, a: 2 } },
          stateHash: "a".repeat(64),
          sourceTaskId: randomUUID(),
          takenAt: AT,
        };
        await h.store.insertSnapshot(snap);
        expect(await h.store.getSnapshot(ws, snap.id)).toEqual(snap);
        expect(await h.store.getSnapshot(await h.workspace(), snap.id)).toBeNull();
        expect(await h.store.getSnapshot(ws, randomUUID())).toBeNull();
        await expect(h.store.insertSnapshot(snap)).rejects.toThrow();
        expect((await h.counts(ws)).snapshots).toBe(1);
      }),
    );

    it(
      "SW-13・T-161 deleteWorkspace：そのワークスペースの行の数を返して消し、ほかは残す。消えたあとの更新は null、2回目は0",
      withHarness(async (h) => {
        const [a, b] = [await h.workspace(), await h.workspace()];
        const runs: Record<string, SimExecutionRecord> = {};
        for (const ws of [a, b]) {
          const demo = (await h.store.ensureDemoStore(contractRecord({ workspaceId: ws }))).execution;
          await h.store.updateExecution({ workspaceId: ws, id: demo.id }, bump());
          await h.store.insertSnapshot({
            id: randomUUID(),
            workspaceId: ws,
            world: "shop",
            executionId: demo.id,
            executionVersion: 2,
            seed: 1,
            seedVersion: "shop-v1",
            state: { n: 1 },
            stateHash: "b".repeat(64),
            sourceTaskId: randomUUID(),
            takenAt: AT,
          });
          const run = await runRecord(h, { workspaceId: ws });
          await h.store.createExecution(run);
          await h.store.updateExecution({ workspaceId: ws, id: run.id }, bump());
          await h.store.forkExecution({ workspaceId: ws, sourceId: run.id, id: randomUUID(), variant: "governed_approve", at: AT });
          runs[ws] = run;
        }
        const beforeB = await h.counts(b);
        expect(await h.counts(a)).toEqual({ executions: 3, events: 3, snapshots: 1 });
        expect(await h.store.deleteWorkspace(a)).toEqual({ executions: 3, events: 3, snapshots: 1 });
        expect(await h.counts(a)).toEqual({ executions: 0, events: 0, snapshots: 0 });
        expect(await h.counts(b)).toEqual(beforeB);
        expect(await h.store.updateExecution({ workspaceId: a, id: runs[a]!.id }, bump())).toBeNull();
        expect(await h.store.getExecution({ workspaceId: a, demoStoreOf: "shop" })).toBeNull();
        expect(await h.store.deleteWorkspace(a)).toEqual({ executions: 0, events: 0, snapshots: 0 });
        expect((await h.store.getExecutionWithEvents({ workspaceId: b, id: runs[b]!.id }))?.events.map((e) => e.seq)).toEqual([1]);
      }),
    );
  });
}
