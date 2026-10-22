// 監査ログの一覧・検証（EP-43・44。AS §6.7 の T-140〜T-143、SO §7.8 の SO-AUD-07〜11・17・18）
import { appendAuditLog, type Db, type JsonObject } from "@open-team/db";
import { fxWorkspace, useTestDb } from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import { decodeAuditCursor, encodeAuditCursor } from "./routes/audit.ts";
import { T0, makeTestApp, send, signInOwner, type SignedIn, type TestApp } from "./test-helpers.ts";

const T = useTestDb();

async function addLogs(db: Db, workspaceId: string, n: number, f: (i: number) => { eventType?: string; taskId?: string; payload?: JsonObject } = () => ({})) {
  await db.transaction(async (tx) => {
    for (let i = 0; i < n; i++) {
      const x = f(i);
      await appendAuditLog(
        tx,
        workspaceId,
        { eventType: x.eventType ?? "decision.made", actorType: "system", actorId: "app", taskId: x.taskId ?? null, payload: x.payload ?? { i } },
        new Date(T0.getTime() + (i + 1) * 1000),
      );
    }
  });
}

type Item = { seq: number; eventType: string; hash: string; prevHash: string; occurredAt: string; taskId: string | null; payload: unknown };
const list = async (t: TestApp, a: SignedIn, query = "") => {
  const res = await send(t, "GET", `/api/v1/workspaces/${a.workspaceId}/audit-logs${query}`, { cookie: a.cookie });
  return { status: res.status, body: (await res.json()) as { items: Item[]; nextCursor: string | null } };
};
const verify = (t: TestApp, a: SignedIn, body: unknown = {}) =>
  send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/audit-logs/verify`, { cookie: a.cookie, csrf: a.csrf, body });

describe("EP-43 一覧", () => {
  it("T-140 limit = 101 → 400、既定は20件と nextCursor。カーソルで続きを重複なく最後まで（seq の降順）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    await addLogs(db, a.workspaceId, 44); // workspace.created と合わせて45件
    expect((await list(t, a, "?limit=101")).status).toBe(400);
    expect((await list(t, a, "?limit=0")).status).toBe(400);
    const p1 = await list(t, a);
    expect(p1.status).toBe(200);
    expect(p1.body.items).toHaveLength(20);
    expect(p1.body.items[0]?.seq).toBe(45);
    expect(p1.body.nextCursor).toBe(encodeAuditCursor(26));
    const p2 = await list(t, a, `?cursor=${encodeURIComponent(p1.body.nextCursor!)}`);
    const p3 = await list(t, a, `?cursor=${encodeURIComponent(p2.body.nextCursor!)}`);
    expect(p3.body.nextCursor).toBeNull();
    const seqs = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((x) => x.seq);
    expect(seqs).toEqual(Array.from({ length: 45 }, (_, i) => 45 - i));
  });

  it("行の形（hash・prevHash は16進、payload はそのまま）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const { body } = await list(t, a);
    expect(body.items).toEqual([
      {
        seq: 1,
        occurredAt: T0.toISOString(),
        eventType: "workspace.created",
        actorType: "system",
        actorId: "app",
        taskId: null,
        payload: { kind: "owner" },
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        prevHash: "0".repeat(64),
      },
    ]);
  });

  it("絞り込み：eventType（カンマ区切り）・taskId・from/to（両端を含む）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const task = "11111111-1111-4111-8111-111111111111";
    await addLogs(db, a.workspaceId, 6, (i) => ({ eventType: i % 2 === 0 ? "approval.decided" : "decision.made", ...(i === 3 ? { taskId: task } : {}) }));
    const byType = await list(t, a, "?eventType=approval.decided,workspace.created");
    expect(byType.body.items.map((x) => x.eventType).sort()).toEqual(["approval.decided", "approval.decided", "approval.decided", "workspace.created"]);
    const byTask = await list(t, a, `?taskId=${task}`);
    expect(byTask.body.items.map((x) => x.seq)).toEqual([5]);
    const from = new Date(T0.getTime() + 2000).toISOString();
    const to = new Date(T0.getTime() + 4000).toISOString();
    const ranged = await list(t, a, `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(ranged.body.items.map((x) => x.seq)).toEqual([5, 4, 3]);
  });

  it("カーソルの形が違う ／ 知らないクエリ ／ taskId が uuid でない → 400", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    expect((await list(t, a, "?cursor=%%%")).status).toBe(400);
    expect((await list(t, a, `?cursor=${encodeURIComponent(Buffer.from("abc").toString("base64"))}`)).status).toBe(400);
    expect((await list(t, a, "?unknown=1")).status).toBe(400);
    expect((await list(t, a, "?taskId=x")).status).toBe(400);
    expect((await list(t, a, "?includeShadow=true")).status).toBe(400);
  });

  it("別のワークスペース → 404、セッションなし → 401", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const other = await fxWorkspace(db, { kind: "guest", audit: true });
    expect((await send(t, "GET", `/api/v1/workspaces/${other.workspaceId}/audit-logs`, { cookie: a.cookie })).status).toBe(404);
    expect((await send(t, "GET", `/api/v1/workspaces/${a.workspaceId}/audit-logs`)).status).toBe(401);
  });

  it("カーソルの符号化（09 の例 'MTAyMzI=' は 10232）", () => {
    expect(encodeAuditCursor(10232)).toBe("MTAyMzI=");
    expect(decodeAuditCursor("MTAyMzI=")).toBe(10232);
    expect(decodeAuditCursor(encodeAuditCursor(0))).toBeNull();
  });
});

describe("EP-44 検証", () => {
  it("T-143 オーナーの作った直後（起点の1件）→ ok、checkedCount 1、checkpointMatched null（SO-AUD-17）", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    const res = await verify(t, a);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, checkedCount: 1, firstBrokenSeq: null, checkpointMatched: null });
  });

  it("T-141 手を加えていない → ok、checkedCount が件数。範囲（SO-AUD-10）は前の行のハッシュから", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    await addLogs(db, a.workspaceId, 9);
    expect(await (await verify(t, a)).json()).toMatchObject({ ok: true, checkedCount: 10 });
    expect(await (await verify(t, a, { fromSeq: 3, toSeq: 4 })).json()).toMatchObject({ ok: true, checkedCount: 2 });
  });

  it("T-142・SO-AUD-07・18 seq = k の payload を書き換える → ok false・firstBrokenSeq k、ログ audit.verify_failed（CRITICAL）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    await addLogs(db, a.workspaceId, 6);
    // 管理者の権限でトリガーを外して書き換える（試験の DB は postgres の利用者）
    await db.query("ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_guard");
    await db.query(`UPDATE audit_logs SET payload = '{"i": 999}' WHERE workspace_id = $1 AND seq = 5`, [a.workspaceId]);
    await db.query("ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_guard");
    expect(await (await verify(t, a)).json()).toEqual({ ok: false, checkedCount: 4, firstBrokenSeq: 5, checkpointMatched: null });
    const log = t.logs.find((r) => r.event === "audit.verify_failed");
    expect(log).toMatchObject({ severity: "CRITICAL", workspaceId: a.workspaceId, firstBrokenSeq: 5 });
  });

  it("fromSeq > toSeq ／ 0 ／ 範囲が100万件を超える ／ 知らないキー → 400、CSRF なし → 403", async () => {
    const t = makeTestApp(T().db);
    const a = await signInOwner(t);
    expect((await verify(t, a, { fromSeq: 5, toSeq: 4 })).status).toBe(400);
    expect((await verify(t, a, { fromSeq: 0 })).status).toBe(400);
    expect((await verify(t, a, { fromSeq: 1, toSeq: 1_000_001 })).status).toBe(400);
    expect((await verify(t, a, { fromSeq: 1, toSeq: 1_000_000 })).status).toBe(200);
    expect((await verify(t, a, { all: true })).status).toBe(400);
    expect((await send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/audit-logs/verify`, { cookie: a.cookie, body: {} })).status).toBe(403);
  });
});
