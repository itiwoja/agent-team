import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contractRecord, describeSimStoreContract } from "./__fixtures__/store-contract.ts";
import { KeyedQueue, MemorySimStore } from "./memory-store.ts";
import { SimStoreConflictError, SimStoreInUseError, SimStoreReferenceError } from "./store.ts";

// SimStore の約束（Postgres の postgres-store.test.ts と同じ関数）
describeSimStoreContract("MemorySimStore", () => {
  const store = new MemorySimStore();
  return {
    store,
    workspace: async () => randomUUID(),
    rehearsalRun: async () => randomUUID(),
    counts: async (workspaceId) => store.counts(workspaceId),
  };
});

describe("MemorySimStore だけの振る舞い", () => {
  it("ワークスペース・リハーサルの走行の表を持たないので、参照先を確かめない（Postgres は SimStoreReferenceError）", async () => {
    const store = new MemorySimStore();
    expect(await store.createExecution(contractRecord({ workspaceId: randomUUID(), rehearsalRunId: randomUUID(), variant: "governed" }))).toBe("created");
    expect((await store.ensureDemoStore(contractRecord({ workspaceId: randomUUID() }))).created).toBe(true);
  });

  it("counts() は引数なしで全部のワークスペースを数える（試験用）", async () => {
    const store = new MemorySimStore();
    await store.ensureDemoStore(contractRecord({ workspaceId: randomUUID() }));
    await store.ensureDemoStore(contractRecord({ workspaceId: randomUUID() }));
    expect(store.counts()).toEqual({ executions: 2, events: 0, snapshots: 0 });
  });
});

describe("保存の例外", () => {
  it("SimStoreConflictError は走行の ID を持つ", () => {
    const e = new SimStoreConflictError("exec-1");
    expect(e.message).toContain("exec-1");
    expect(e.name).toBe("SimStoreConflictError");
  });

  it("SimStoreReferenceError は参照先、SimStoreInUseError はワークスペースを持つ", () => {
    const r = new SimStoreReferenceError("rehearsal_run");
    expect([r.name, r.reference]).toEqual(["SimStoreReferenceError", "rehearsal_run"]);
    const u = new SimStoreInUseError("ws-1");
    expect([u.name, u.workspaceId]).toEqual(["SimStoreInUseError", "ws-1"]);
    expect(u.message).toContain("ws-1");
  });
});

describe("KeyedQueue（走行ごとの直列化）", () => {
  it("同じキーは前が終わってから、違うキーは並行に動く", async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => {
      releaseA = r;
    });
    const a1 = q.run("a", async () => {
      log.push("a1:start");
      await gate;
      log.push("a1:end");
    });
    const a2 = q.run("a", () => {
      log.push("a2");
    });
    const b1 = q.run("b", () => {
      log.push("b1");
    });
    await b1;
    expect(log).toEqual(["a1:start", "b1"]);
    releaseA();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["a1:start", "b1", "a1:end", "a2"]);
    expect(q.size).toBe(0);
  });

  it("前の仕事が失敗しても次は動く", async () => {
    const q = new KeyedQueue();
    const failed = q.run("k", () => {
      throw new Error("x");
    });
    await expect(failed).rejects.toThrow("x");
    expect(await q.run("k", () => 1)).toBe(1);
  });
});
