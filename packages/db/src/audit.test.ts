// 監査ログの試験（db-schema.md §7.5 の T-70〜T-79、§4.2 のテストベクトル、SO §3.13）
import { canonicalJson } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import { appendAuditLog, assertAuditPayload, AUDIT_GENESIS_PREV_HASH, computeAuditHash, verifyAuditChain, type AuditEventInput } from "./audit.ts";
import { createDb, type Db } from "./client.ts";
import { fxWorkspace, useTestDb } from "./testing.ts";

const T = useTestDb();

const E1 = {
  seq: 1,
  occurredAt: new Date("2026-10-12T09:00:00.000Z"),
  eventType: "workspace.created",
  actorType: "system" as const,
  actorId: "app",
  payload: { kind: "guest", seedVersion: "2026-10-12.1" },
};
const E1_HASH = "a94b93556f22bdfe2d79a46fbcb135e7bb9a6904d38bf80154c79eac69c66606";
const E2 = {
  seq: 2,
  occurredAt: new Date("2026-10-12T09:00:05.123Z"),
  eventType: "approval.decided",
  actorType: "user" as const,
  actorId: "00000000-0000-0000-0000-0000000000b1",
  payload: { decision: "approve", intentId: "00000000-0000-0000-0000-000000000a01", b: [3, 1, 2], a: { y: "雪", x: 1.5 } },
};
const E2_HASH = "11b86533ab808107a55c48b19ddd0000cd5bb32f72757a0053456ebe46f73bec";

function ev(i: number, extra: Partial<AuditEventInput> = {}): AuditEventInput {
  return { eventType: "task.status_changed", actorType: "system", actorId: "app", payload: { n: i, taskId: `t-${i}` }, ...extra };
}
const at = (ms: number) => new Date(Date.UTC(2026, 9, 12, 9, 0, 0) + ms);

async function append(db: Db, workspaceId: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await db.transaction((tx) => appendAuditLog(tx, workspaceId, ev(i), at(i * 1000)));
  }
}

describe("ハッシュの符号化（DB §4.2）", () => {
  it("T-70 テストベクトル e1・e2 と一致する", () => {
    const h1 = computeAuditHash({ prevHash: AUDIT_GENESIS_PREV_HASH, ...E1 });
    expect(h1.toString("hex")).toBe(E1_HASH);
    const h2 = computeAuditHash({ prevHash: h1, ...E2 });
    expect(h2.toString("hex")).toBe(E2_HASH);
    expect(canonicalJson(E2.payload)).toBe(
      '{"a":{"x":1.5,"y":"雪"},"b":[3,1,2],"decision":"approve","intentId":"00000000-0000-0000-0000-000000000a01"}',
    );
  });

  it("T-71 payload のキーの順を変えても同じハッシュ", () => {
    const reordered = { a: { x: 1.5, y: "雪" }, intentId: E2.payload.intentId, b: [3, 1, 2], decision: "approve" };
    const prev = Buffer.from(E1_HASH, "hex");
    expect(computeAuditHash({ prevHash: prev, ...E2, payload: reordered }).toString("hex")).toBe(E2_HASH);
  });

  it("T-72 occurred_at を1ミリ秒ずらすと別のハッシュ。seq・種類・行為者・前のハッシュも効く", () => {
    const base = computeAuditHash({ prevHash: AUDIT_GENESIS_PREV_HASH, ...E1 }).toString("hex");
    const variants = [
      { ...E1, occurredAt: new Date(E1.occurredAt.getTime() + 1) },
      { ...E1, seq: 2 },
      { ...E1, eventType: "workspace.created_" },
      { ...E1, actorId: null },
      { ...E1, actorType: "user" as const },
      { ...E1, payload: { ...E1.payload, kind: "owner" } },
    ];
    for (const v of variants) expect(computeAuditHash({ prevHash: AUDIT_GENESIS_PREV_HASH, ...v }).toString("hex")).not.toBe(base);
    expect(computeAuditHash({ prevHash: Buffer.alloc(32, 1), ...E1 }).toString("hex")).not.toBe(base);
    // 区切りを長さで表すので、項目の境目をずらしても同じにならない
    const a = computeAuditHash({ prevHash: AUDIT_GENESIS_PREV_HASH, ...E1, eventType: "a.b", actorId: "c" });
    const b = computeAuditHash({ prevHash: AUDIT_GENESIS_PREV_HASH, ...E1, eventType: "a", actorId: ".bc" });
    expect(a.equals(b)).toBe(false);
  });

  it("seq・prevHash の形が違えば例外", () => {
    expect(() => computeAuditHash({ prevHash: Buffer.alloc(31), ...E1 })).toThrow(RangeError);
    expect(() => computeAuditHash({ prevHash: AUDIT_GENESIS_PREV_HASH, ...E1, seq: 0 })).toThrow(RangeError);
    expect(() => computeAuditHash({ prevHash: AUDIT_GENESIS_PREV_HASH, ...E1, occurredAt: new Date("x") })).toThrow(TypeError);
  });

  it("jsonb に入らない・往復でハッシュが変わる値は入れない（SO §3.13 の1）", () => {
    for (const bad of [{ n: Number.NaN }, { n: 2 ** 60 }, { s: "a\u0000b" }, { s: "\ud800" }, { d: new Date() }, { f: () => 1 }, { a: [undefined] }]) {
      expect(() => assertAuditPayload(bad)).toThrow(TypeError);
    }
    expect(() => assertAuditPayload({ a: [1, "雪", null, { b: 1.5, c: -0 }], u: undefined, emoji: "😀" })).not.toThrow();
  });
});

describe("追記と検証（T-73〜T-78）", () => {
  it("最初の1件は seq 1・prev_hash 0×32 で、ワークスペースの先頭が進む", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const row = await db.transaction((tx) => appendAuditLog(tx, ws.workspaceId, { ...E1, payload: E1.payload }, E1.occurredAt));
    expect(row.seq).toBe(1);
    expect(row.prev_hash.equals(AUDIT_GENESIS_PREV_HASH)).toBe(true);
    expect(row.hash.toString("hex")).toBe(E1_HASH);
    const head = await db.query<{ audit_seq: number; audit_last_hash: Buffer }>("SELECT audit_seq, audit_last_hash FROM workspaces WHERE id = $1", [
      ws.workspaceId,
    ]);
    expect(head.rows[0]?.audit_seq).toBe(1);
    expect(head.rows[0]?.audit_last_hash.toString("hex")).toBe(E1_HASH);
  });

  it("T-73 3件書いて検証すると { ok: true, checkedCount: 3, firstBrokenSeq: null }。範囲も検証できる", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await append(db, ws.workspaceId, 3);
    expect(await verifyAuditChain(db, ws.workspaceId)).toEqual({ ok: true, checkedCount: 3, firstBrokenSeq: null });
    expect(await verifyAuditChain(db, ws.workspaceId, { fromSeq: 2 })).toEqual({ ok: true, checkedCount: 2, firstBrokenSeq: null });
    expect(await verifyAuditChain(db, ws.workspaceId, { fromSeq: 1, toSeq: 2 })).toEqual({ ok: true, checkedCount: 2, firstBrokenSeq: null });
    expect(await verifyAuditChain(db, ws.workspaceId, { toSeq: 99 })).toEqual({ ok: true, checkedCount: 3, firstBrokenSeq: null });
    // 監査ログのないワークスペース
    const empty = await fxWorkspace(db, { second: true });
    expect(await verifyAuditChain(db, empty.workspaceId)).toEqual({ ok: true, checkedCount: 0, firstBrokenSeq: null });
  });

  it("T-74 2件目の payload を（トリガーを外した保守の手段で）書き換えると ok: false・firstBrokenSeq: 2", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await append(db, ws.workspaceId, 3);
    await db.transaction(async (tx) => {
      await tx.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_guard");
      await tx.query(`UPDATE audit_logs SET payload = '{"n": 99}' WHERE workspace_id = $1 AND seq = 2`, [ws.workspaceId]);
      await tx.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_guard");
    });
    expect(await verifyAuditChain(db, ws.workspaceId)).toEqual({ ok: false, checkedCount: 1, firstBrokenSeq: 2 });
    // 3件目から先だけなら正しい（2件目の hash は書き換えていない）
    expect((await verifyAuditChain(db, ws.workspaceId, { fromSeq: 3 })).ok).toBe(true);
  });

  it("T-75 最後の1件を消して全範囲を検証すると ok: false（workspaces.audit_seq と合わない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await append(db, ws.workspaceId, 3);
    await db.transaction(async (tx) => {
      await tx.query("SELECT set_config('ot.audit_purge_workspace', $1, true)", [ws.workspaceId]);
      await tx.query("DELETE FROM audit_logs WHERE workspace_id = $1 AND seq = 3", [ws.workspaceId]);
    });
    expect(await verifyAuditChain(db, ws.workspaceId)).toEqual({ ok: false, checkedCount: 2, firstBrokenSeq: 3 });
  });

  it("途中の行が抜けた・prev_hash が前の hash と違う・ワークスペースの先頭が書き換えられた", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await append(db, ws.workspaceId, 4);
    await db.transaction(async (tx) => {
      await tx.query("SELECT set_config('ot.audit_purge_workspace', $1, true)", [ws.workspaceId]);
      await tx.query("DELETE FROM audit_logs WHERE workspace_id = $1 AND seq = 2", [ws.workspaceId]);
    });
    expect(await verifyAuditChain(db, ws.workspaceId)).toEqual({ ok: false, checkedCount: 1, firstBrokenSeq: 2 });
    expect(await verifyAuditChain(db, ws.workspaceId, { fromSeq: 3 })).toEqual({ ok: false, checkedCount: 0, firstBrokenSeq: 2 });

    const ws2 = await fxWorkspace(db, { second: true });
    await append(db, ws2.workspaceId, 2);
    await db.query("UPDATE workspaces SET audit_last_hash = $2 WHERE id = $1", [ws2.workspaceId, Buffer.alloc(32, 7)]);
    expect(await verifyAuditChain(db, ws2.workspaceId)).toEqual({ ok: false, checkedCount: 2, firstBrokenSeq: 3 });
    await db.query("UPDATE workspaces SET audit_seq = 1 WHERE id = $1", [ws2.workspaceId]);
    expect((await verifyAuditChain(db, ws2.workspaceId)).ok).toBe(false);
  });

  it("T-76 2つのトランザクションが同じワークスペースに同時に追記しても seq は連続し、重複も欠けもない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const many = createDb(T().url, { max: 6 });
    try {
      await Promise.all(
        Array.from({ length: 24 }, (_, i) => many.transaction((tx) => appendAuditLog(tx, ws.workspaceId, ev(i + 1), at(i)), { retryOnce: true })),
      );
    } finally {
      await many.close();
    }
    const seqs = await db.query<{ seq: number }>("SELECT seq FROM audit_logs WHERE workspace_id = $1 ORDER BY seq", [ws.workspaceId]);
    expect(seqs.rows.map((r) => r.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(await verifyAuditChain(db, ws.workspaceId)).toEqual({ ok: true, checkedCount: 24, firstBrokenSeq: null });
  });

  it("検証の途中に追記されても食い違わない（同じ時点を読む）", async () => {
    const { db, url } = T();
    const ws = await fxWorkspace(db);
    await append(db, ws.workspaceId, 3);
    const many = createDb(url, { max: 6 });
    try {
      const writes = Array.from({ length: 20 }, (_, i) =>
        many.transaction((tx) => appendAuditLog(tx, ws.workspaceId, ev(i + 10), at(10_000 + i)), { retryOnce: true }),
      );
      const checks = Array.from({ length: 10 }, () => verifyAuditChain(many, ws.workspaceId));
      const results = await Promise.all([...checks, ...writes.map((w) => w.then(() => null))]);
      for (const r of results.slice(0, 10)) expect(r).toMatchObject({ ok: true, firstBrokenSeq: null });
    } finally {
      await many.close();
    }
    expect(await verifyAuditChain(db, ws.workspaceId)).toEqual({ ok: true, checkedCount: 23, firstBrokenSeq: null });
    // Tx を渡せばその中で読む
    expect(await db.transaction((tx) => verifyAuditChain(tx, ws.workspaceId, { toSeq: 2 }))).toEqual({ ok: true, checkedCount: 2, firstBrokenSeq: null });
  });

  it("T-77 業務の変更のあと監査ログの追記で例外 → 業務の変更も残らない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await expect(
      db.transaction(async (tx) => {
        await tx.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = now() WHERE id = $1", [ws.workspaceId]);
        await appendAuditLog(tx, ws.workspaceId, ev(1, { eventType: "Bad Name" }), at(0));
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      db.transaction(async (tx) => {
        await tx.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = now() WHERE id = $1", [ws.workspaceId]);
        await appendAuditLog(tx, ws.workspaceId, ev(1, { actorId: "x".repeat(300) }), at(0)); // DB の CHECK で止まる
      }),
    ).rejects.toThrow();
    const r = await db.query<{ kill_switch_engaged: boolean; audit_seq: number }>("SELECT kill_switch_engaged, audit_seq FROM workspaces WHERE id = $1", [
      ws.workspaceId,
    ]);
    expect(r.rows[0]).toEqual({ kill_switch_engaged: false, audit_seq: 0 });
  });

  it("T-78 jsonb に入れて読み戻した payload で再計算しても同じハッシュ", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const payload = {
      z: 1,
      a: { y: "雪", x: 1.5, big: 9007199254740991, neg: -0.000001, exp: 1.25e-8, small: 5e-7 },
      list: [3, 1, 2, { k: null }],
      emoji: "😀",
      esc: 'quote " back \\ newline \n',
    };
    const row = await db.transaction((tx) => appendAuditLog(tx, ws.workspaceId, { eventType: "x.y", actorType: "agent", actorId: null, payload }, at(5)));
    const back = await db.query<{ payload: Record<string, never>; occurred_at: Date }>(
      "SELECT payload, occurred_at FROM audit_logs WHERE workspace_id = $1 AND seq = 1",
      [ws.workspaceId],
    );
    const again = computeAuditHash({
      prevHash: AUDIT_GENESIS_PREV_HASH,
      seq: 1,
      occurredAt: back.rows[0]?.occurred_at as Date,
      eventType: "x.y",
      actorType: "agent",
      actorId: null,
      payload: back.rows[0]?.payload ?? {},
    });
    expect(again.equals(row.hash)).toBe(true);
    expect((await verifyAuditChain(db, ws.workspaceId)).ok).toBe(true);
  });

  it("タスクのイベントは task_id 列にも入る（絞り込み用。ハッシュには入らない）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    const taskId = "00000000-0000-0000-0000-00000000aaaa";
    const row = await db.transaction((tx) => appendAuditLog(tx, ws.workspaceId, ev(1, { taskId, payload: { taskId } }), at(0)));
    expect(row.task_id).toBe(taskId);
    const without = computeAuditHash({ prevHash: AUDIT_GENESIS_PREV_HASH, seq: 1, occurredAt: at(0), eventType: "task.status_changed", actorType: "system", actorId: "app", payload: { taskId } });
    expect(row.hash.equals(without)).toBe(true);
  });

  it("ないワークスペースへの追記は例外", async () => {
    const { db } = T();
    await expect(db.transaction((tx) => appendAuditLog(tx, "00000000-0000-0000-0000-000000000000", ev(1), at(0)))).rejects.toThrow(/ワークスペースがない/);
  });
});
