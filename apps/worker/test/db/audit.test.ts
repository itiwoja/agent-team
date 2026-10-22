// 監査ログの試験（packages/db/src/audit.test.ts の WorkspaceDO 版。T-70〜T-78）
import { Buffer } from "node:buffer";
import { canonicalJson } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import { appendAuditLog, assertAuditPayload, AUDIT_GENESIS_PREV_HASH, computeAuditHash, verifyAuditChain, type AuditEventInput } from "../../src/db/audit.ts";
import { CODECS } from "../../src/db/codecs.ts";
import { all, isTriggerAbort, one, run, type WsDb } from "../../src/db/sqlite.ts";
import type { AuditLogRow } from "../../src/db/types.ts";
import { getWorkspace } from "../../src/db/workspace.ts";
import { FIXED_NOW, inWorkspace } from "./fixtures.ts";

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
const at = (ms: number) => new Date(FIXED_NOW.getTime() + ms);

/** workspace.created（seq 1）のあとに count 件 */
function append(db: WsDb, count: number): void {
  for (let i = 1; i <= count; i++) appendAuditLog(db, ev(i), at(i * 1000));
}

describe("ハッシュの符号化（Postgres 版と同じ）", () => {
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
    expect(computeAuditHash({ prevHash: Buffer.from(E1_HASH, "hex"), ...E2, payload: reordered }).toString("hex")).toBe(E2_HASH);
  });

  it("JSON に入らない・往復でハッシュが変わる値は入れない", () => {
    expect(() => assertAuditPayload({ a: Number.NaN })).toThrow();
    expect(() => assertAuditPayload({ a: 2 ** 60 })).toThrow();
    expect(() => assertAuditPayload({ a: "x\u0000" })).toThrow();
    expect(() => assertAuditPayload({ a: "\uD800" })).toThrow();
    expect(() => assertAuditPayload({ a: new Date() })).toThrow();
    expect(() => assertAuditPayload({ a: [1, "雪", { b: null }] })).not.toThrow();
  });
});

describe("追記と検証", () => {
  it("init で seq 1 の workspace.created が入り、ワークスペースの先頭が進む", async () => {
    await inWorkspace((db) => {
      const rows = all<AuditLogRow>(db, CODECS.audit_logs, "SELECT * FROM audit_logs ORDER BY seq");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ seq: 1, event_type: "workspace.created", actor_type: "system", actor_id: "app", payload: { kind: "owner" } });
      expect(rows[0]!.prev_hash.equals(AUDIT_GENESIS_PREV_HASH)).toBe(true);
      expect(rows[0]!.occurred_at).toEqual(FIXED_NOW);
      const ws = getWorkspace(db)!;
      expect(ws.audit_seq).toBe(1);
      expect(ws.audit_last_hash.equals(rows[0]!.hash)).toBe(true);
    });
  });

  it("T-73 続けて書いて検証すると ok。範囲も検証できる", async () => {
    await inWorkspace((db) => {
      append(db, 3);
      expect(verifyAuditChain(db)).toEqual({ ok: true, checkedCount: 4, firstBrokenSeq: null });
      expect(verifyAuditChain(db, { fromSeq: 2, toSeq: 3 })).toEqual({ ok: true, checkedCount: 2, firstBrokenSeq: null });
      expect(verifyAuditChain(db, { fromSeq: 5 })).toEqual({ ok: true, checkedCount: 0, firstBrokenSeq: null });
    });
  });

  it("T-01 監査ログの UPDATE・DELETE はトリガーで拒む", async () => {
    await inWorkspace((db) => {
      append(db, 1);
      let err: unknown;
      try {
        run(db, "UPDATE audit_logs SET event_type = 'x' WHERE seq = 2");
      } catch (e) {
        err = e;
      }
      expect(isTriggerAbort(err, "audit_logs is append-only")).toBe(true);
      expect(() => run(db, "DELETE FROM audit_logs WHERE seq = 2")).toThrow(/append-only/);
    });
  });

  it("T-74・T-75 書き換え・末尾の削除を見つける（トリガーを外した保守の手段で壊す）", async () => {
    await inWorkspace((db) => {
      append(db, 3);
      run(db, "DROP TRIGGER audit_logs_no_update");
      run(db, "DROP TRIGGER audit_logs_no_delete");
      run(db, `UPDATE audit_logs SET payload = '{"n":99,"taskId":"t-1"}' WHERE seq = 2`);
      expect(verifyAuditChain(db)).toEqual({ ok: false, checkedCount: 1, firstBrokenSeq: 2 });
    });
    await inWorkspace((db) => {
      append(db, 3);
      run(db, "DROP TRIGGER audit_logs_no_delete");
      run(db, "DELETE FROM audit_logs WHERE seq = 4");
      expect(verifyAuditChain(db)).toEqual({ ok: false, checkedCount: 3, firstBrokenSeq: 4 });
      expect(verifyAuditChain(db, { toSeq: 3 })).toEqual({ ok: true, checkedCount: 3, firstBrokenSeq: null });
    });
  });

  it("T-77 業務の変更のあと監査ログの追記で例外 → 業務の変更も残らない（入れ子のトランザクション）", async () => {
    await inWorkspace((db) => {
      expect(() =>
        db.transaction(() => {
          run(db, "INSERT INTO check_marks (item_key, checked_at) VALUES ('task:00000000-0000-0000-0000-000000000001', ?)", FIXED_NOW);
          appendAuditLog(db, ev(1, { eventType: "Bad Name" }), FIXED_NOW);
        }),
      ).toThrow(/イベントの名前/);
      expect(one(db, {}, "SELECT 1 FROM check_marks")).toBeNull();
      expect(getWorkspace(db)!.audit_seq).toBe(1);
    });
  });

  it("T-78 読み戻した payload で再計算しても同じハッシュ。タスクのイベントは task_id 列にも入る", async () => {
    await inWorkspace((db) => {
      const payload = { s: "改行\nと\"引用\"と絵文字🍣", n: 0.1, neg: -0, big: 9007199254740991, nested: { z: [], a: {} } };
      const row = appendAuditLog(db, { ...ev(1), taskId: "00000000-0000-0000-0000-00000000000a", payload }, at(1));
      const back = one<AuditLogRow>(db, CODECS.audit_logs, "SELECT * FROM audit_logs WHERE seq = ?", row.seq)!;
      expect(back.task_id).toBe("00000000-0000-0000-0000-00000000000a");
      expect(computeAuditHash({ prevHash: back.prev_hash, seq: back.seq, occurredAt: back.occurred_at, eventType: back.event_type, actorType: back.actor_type, actorId: back.actor_id, payload: back.payload }).equals(back.hash)).toBe(true);
      expect(verifyAuditChain(db).ok).toBe(true);
    });
  });
});
