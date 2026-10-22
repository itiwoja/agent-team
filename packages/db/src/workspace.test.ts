// ワークスペースの作成の試験（db-schema.md §7.3 の T-48、§7.9 の T-120）。ワークスペースはオーナーの1つだけ
import { describe, expect, it } from "vitest";
import { verifyAuditChain } from "./audit.ts";
import { createDb, PG_ERROR, pgErrorInfo, type Db } from "./client.ts";
import { fxWorkspace, useTestDb } from "./testing.ts";
import { ensureOwnerWorkspace, getWorkspace, lockWorkspace } from "./workspace.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");

async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  return (await db.query<{ n: number }>(sql, params)).rows[0]?.n ?? -1;
}

describe("オーナーのワークスペース（D-05、G-08 の DB の部分）", () => {
  it("1回目に作り（監査ログの起点 seq 1）、2回目は同じものを返す", async () => {
    const { db } = T();
    const a = await ensureOwnerWorkspace(db, { now: NOW });
    expect(a.created).toBe(true);
    expect(a.ctx.kind).toBe("owner");
    const b = await ensureOwnerWorkspace(db, { now: NOW });
    expect(b).toEqual({ ctx: a.ctx, created: false });
    const ws = await getWorkspace(db, a.ctx);
    expect(ws).toMatchObject({ kind: "owner", timezone: "Asia/Tokyo", max_concurrent_tasks: 3, audit_seq: 1 });
    const role = await db.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2", [
      a.ctx.workspaceId,
      a.ctx.userId,
    ]);
    expect(role.rows[0]?.role).toBe("owner");
    expect(await verifyAuditChain(db, a.ctx.workspaceId)).toEqual({ ok: true, checkedCount: 1, firstBrokenSeq: null });
  });

  it("同時に呼んでもオーナーは1つ", async () => {
    const { db, url } = T();
    const many = createDb(url, { max: 4 });
    try {
      const rs = await Promise.all([1, 2, 3, 4].map(() => ensureOwnerWorkspace(many, { now: NOW })));
      expect(new Set(rs.map((r) => r.ctx.workspaceId)).size).toBe(1);
      expect(rs.filter((r) => r.created)).toHaveLength(1);
    } finally {
      await many.close();
    }
    expect(await count(db, "SELECT count(*) AS n FROM workspaces WHERE kind = 'owner'")).toBe(1);
  });
});

describe("ワークスペースの種類（0025）", () => {
  it("kind は owner だけ。2つ目のオーナー・削除予約・シードの版は作れない", async () => {
    const { db } = T();
    const a = await ensureOwnerWorkspace(db, { now: NOW });
    const err = async (p: Promise<unknown>) =>
      pgErrorInfo(
        await p.then(
          () => null,
          (x: unknown) => x,
        ),
      );
    expect((await err(db.query("INSERT INTO workspaces (kind) VALUES ('guest')")))?.code).toBe(PG_ERROR.checkViolation);
    expect((await err(db.query("INSERT INTO workspaces (kind) VALUES ('owner')")))?.code).toBe(PG_ERROR.uniqueViolation);
    expect((await err(db.query("UPDATE workspaces SET delete_requested_at = now() WHERE id = $1", [a.ctx.workspaceId])))?.code).toBe(
      PG_ERROR.checkViolation,
    );
    expect((await err(db.query("UPDATE workspaces SET seed_version = 'x' WHERE id = $1", [a.ctx.workspaceId])))?.code).toBe(PG_ERROR.checkViolation);
  });
});

describe("ワークスペースの読み取り（WsCtx で絞る）", () => {
  it("getWorkspace・lockWorkspace は文脈のワークスペースだけを返す", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db, { second: true });
    expect((await getWorkspace(db, a.ctx))?.id).toBe(a.workspaceId);
    expect((await getWorkspace(db, b.ctx))?.id).toBe(b.workspaceId);
    expect(await getWorkspace(db, { workspaceId: "00000000-0000-0000-0000-000000000000", kind: "owner", userId: null })).toBeNull();
    const locked = await db.transaction((tx) => lockWorkspace(tx, a.ctx));
    expect(locked?.id).toBe(a.workspaceId);
    expect(locked?.audit_last_hash.length).toBe(32);
  });
});
