// ワークスペースの作成の試験（db-schema.md §7.3 の T-40〜T-48・T-53・T-56、§7.9 の T-120、SO §7.4 の SO-GC-01〜06・11）
import { describe, expect, it } from "vitest";
import { verifyAuditChain } from "./audit.ts";
import { createDb, type Db } from "./client.ts";
import { countEntryAttempts, hashIp, recordEntryAttempt } from "./system/entry.ts";
import { fxWorkspace, useTestDb } from "./testing.ts";
import { AUDIT_GENESIS_PREV_HASH } from "./audit.ts";
import {
  createGuestWorkspace,
  ensureOwnerWorkspace,
  getWorkspace,
  GUEST_LIMITS,
  lockWorkspace,
  newGuestLogin,
  requestWorkspaceDeletion,
  wsCtxOf,
} from "./workspace.ts";

const T = useTestDb();
const NOW = new Date("2026-10-12T09:00:00.000Z");
const IP = hashIp("203.0.113.7", "test-secret-0123456789");
const OTHER_IP = hashIp("198.51.100.1", "test-secret-0123456789");
const HOUR = 60 * 60 * 1000;

async function createGuest(db: Db, opts: { ipHash?: string; now?: Date; outcome?: "guest_created" | "guest_reset" } = {}) {
  return db.transaction((tx) =>
    createGuestWorkspace(tx, {
      ipHash: opts.ipHash ?? IP,
      now: opts.now ?? NOW,
      seedVersion: "2026-10-12.1",
      outcome: opts.outcome ?? "guest_created",
    }),
  );
}
/** 削除予約でないゲストを n 件、別々の IP で作る */
async function fillGuests(db: Db, n: number): Promise<void> {
  await db.query(
    `INSERT INTO workspaces (kind, max_concurrent_tasks, seed_version)
     SELECT 'guest', 2, '2026-10-12.1' FROM generate_series(1, $1)`,
    [n],
  );
}
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
    expect(ws).toMatchObject({ kind: "owner", timezone: "Asia/Tokyo", max_concurrent_tasks: 3, audit_seq: 1, seed_version: null });
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

describe("ゲストのワークスペース（FR-046、BR-65）", () => {
  it("T-120 作った直後：監査ログは workspace.created の1件（seq 1・prev 0×32）、ゲスト・2並列・Asia/Tokyo・owner の所属・Kill Switch 解除", async () => {
    const { db } = T();
    const r = await createGuest(db);
    if (!r.ok) throw new Error("作れない");
    expect(r.login).toMatch(/^guest-[a-z2-7]{8}$/);
    const ws = await getWorkspace(db, r.ctx);
    expect(ws).toMatchObject({
      kind: "guest",
      max_concurrent_tasks: 2,
      timezone: "Asia/Tokyo",
      seed_version: "2026-10-12.1",
      kill_switch_engaged: false,
      delete_requested_at: null,
      audit_seq: 1,
      last_seen_at: NOW,
    });
    const logs = await db.query<{ seq: number; event_type: string; payload: unknown; prev_hash: Buffer; actor_type: string }>(
      "SELECT seq, event_type, payload, prev_hash, actor_type FROM audit_logs WHERE workspace_id = $1",
      [r.ctx.workspaceId],
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ seq: 1, event_type: "workspace.created", actor_type: "system", payload: { kind: "guest", seedVersion: "2026-10-12.1" } });
    expect(logs.rows[0]?.prev_hash.equals(AUDIT_GENESIS_PREV_HASH)).toBe(true);
    const m = await db.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id = $1", [r.ctx.workspaceId]);
    expect(m.rows.map((x) => x.role)).toEqual(["owner"]);
    const ea = await db.query<{ outcome: string; workspace_id: string }>("SELECT outcome, workspace_id FROM entry_attempts");
    expect(ea.rows).toEqual([{ outcome: "guest_created", workspace_id: r.ctx.workspaceId }]);
  });

  it("T-40 削除予約でないゲストが49件なら作れる（50件目）。T-41 50件なら capacity で、行は増えず既存は残る", async () => {
    const { db } = T();
    await fillGuests(db, GUEST_LIMITS.activeMax - 1);
    expect((await createGuest(db)).ok).toBe(true);
    expect(await count(db, "SELECT count(*) AS n FROM workspaces WHERE kind = 'guest'")).toBe(50);
    const r = await createGuest(db, { ipHash: OTHER_IP });
    expect(r).toEqual({ ok: false, scope: "global" });
    expect(await count(db, "SELECT count(*) AS n FROM workspaces WHERE kind = 'guest'")).toBe(50);
    expect(await count(db, "SELECT count(*) AS n FROM entry_attempts WHERE outcome = 'capacity'")).toBe(1);
  });

  it("T-42 50件のうち1件が削除予約なら作れる", async () => {
    const { db } = T();
    await fillGuests(db, 50);
    await db.query("UPDATE workspaces SET delete_requested_at = now() WHERE id = (SELECT id FROM workspaces LIMIT 1)");
    expect((await createGuest(db)).ok).toBe(true);
  });

  it("T-43・T-44 同じ IP の guest_created が直近1時間に4件なら作れ（5件目）、5件なら ip_limit。ほかの IP は作れる", async () => {
    const { db } = T();
    for (let i = 0; i < 4; i++) expect((await createGuest(db, { now: new Date(NOW.getTime() - i * 60_000) })).ok).toBe(true);
    expect((await createGuest(db)).ok).toBe(true);
    expect(await createGuest(db)).toEqual({ ok: false, scope: "ip" });
    expect(await count(db, "SELECT count(*) AS n FROM entry_attempts WHERE outcome = 'ip_limit'")).toBe(1);
    expect((await createGuest(db, { ipHash: OTHER_IP })).ok).toBe(true);
  });

  it("T-45 5件のうち最古がちょうど1時間前なら作れる（窓は created_at > now − 1h）", async () => {
    const { db } = T();
    await recordEntryAttempt(db, { ipHash: IP, outcome: "guest_created", now: new Date(NOW.getTime() - HOUR) });
    for (let i = 1; i <= 4; i++) await recordEntryAttempt(db, { ipHash: IP, outcome: "guest_created", now: new Date(NOW.getTime() - i * 1000) });
    expect((await createGuest(db)).ok).toBe(true);
    // 1ms でも窓の中なら断る
    await recordEntryAttempt(db, { ipHash: OTHER_IP, outcome: "guest_created", now: new Date(NOW.getTime() - HOUR + 1) });
    for (let i = 1; i <= 4; i++) await recordEntryAttempt(db, { ipHash: OTHER_IP, outcome: "guest_created", now: new Date(NOW.getTime() - i * 1000) });
    expect(await createGuest(db, { ipHash: OTHER_IP })).toEqual({ ok: false, scope: "ip" });
  });

  it("T-46 49件の状態で同時に作ろうとしても、アドバイザリロックで直列になり51件目はできない（SO-GC-06）", async () => {
    const { db, url } = T();
    await fillGuests(db, 48);
    const many = createDb(url, { max: 6 });
    try {
      const ips = [1, 2, 3, 4, 5, 6].map((i) => hashIp(`192.0.2.${i}`, "test-secret-0123456789"));
      const rs = await Promise.all(ips.map((ip) => createGuest(many, { ipHash: ip })));
      expect(rs.filter((r) => r.ok)).toHaveLength(2);
      expect(rs.filter((r) => !r.ok && r.scope === "global")).toHaveLength(4);
    } finally {
      await many.close();
    }
    expect(await count(db, "SELECT count(*) AS n FROM workspaces WHERE kind = 'guest' AND delete_requested_at IS NULL")).toBe(50);
  });

  it("T-47 同じトークン（同じ IP）を2回入れると別々のワークスペース", async () => {
    const { db } = T();
    const a = await createGuest(db);
    const b = await createGuest(db);
    if (!a.ok || !b.ok) throw new Error("作れない");
    expect(a.ctx.workspaceId).not.toBe(b.ctx.workspaceId);
    expect(a.ctx.userId).not.toBe(b.ctx.userId);
  });

  it("T-53 [最初からやり直す]：古い方を削除予約・セッション失効にし、guest_reset は IP の数に入れない。50件ちょうどでもやり直せる", async () => {
    const { db } = T();
    await fillGuests(db, 44);
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await createGuest(db);
      if (!r.ok) throw new Error("作れない");
      made.push(r.ctx.workspaceId);
    }
    expect(await count(db, "SELECT count(*) AS n FROM workspaces WHERE kind = 'guest' AND delete_requested_at IS NULL")).toBe(49);
    const sixth = await createGuest(db, { ipHash: OTHER_IP });
    expect(sixth.ok).toBe(true);
    // 50件・同じ IP の作成が5件の状態でも、やり直しは作れる
    const old = made[0] as string;
    const reset = await db.transaction(async (tx) => {
      expect(await requestWorkspaceDeletion(tx, wsCtxOf({ id: old, kind: "guest" }), NOW)).toBe(true);
      return createGuestWorkspace(tx, { ipHash: IP, now: NOW, seedVersion: "2026-10-12.1", outcome: "guest_reset" });
    });
    expect(reset.ok).toBe(true);
    expect(await countEntryAttempts(db, { ipHash: IP, outcomes: ["guest_created"], since: new Date(NOW.getTime() - HOUR) })).toBe(5);
    expect(await count(db, "SELECT count(*) AS n FROM entry_attempts WHERE outcome = 'guest_reset'")).toBe(1);
    const oldWs = await db.query<{ delete_requested_at: Date | null }>("SELECT delete_requested_at FROM workspaces WHERE id = $1", [old]);
    expect(oldWs.rows[0]?.delete_requested_at).toEqual(NOW);
  });

  it("オーナーは削除予約にできない", async () => {
    const { db } = T();
    const owner = await ensureOwnerWorkspace(db, { now: NOW });
    expect(await db.transaction((tx) => requestWorkspaceDeletion(tx, owner.ctx, NOW))).toBe(false);
  });

  it("T-56 作成の途中（シードの投入）で例外が出たら何も残らない（1トランザクション）", async () => {
    const { db } = T();
    await expect(
      db.transaction(async (tx) => {
        const r = await createGuestWorkspace(tx, { ipHash: IP, now: NOW, seedVersion: "2026-10-12.1", outcome: "guest_created" });
        expect(r.ok).toBe(true);
        throw new Error("シードの投入に失敗");
      }),
    ).rejects.toThrow("シードの投入に失敗");
    expect(await count(db, "SELECT count(*) AS n FROM workspaces")).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM users")).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM entry_attempts")).toBe(0);
    expect(await count(db, "SELECT count(*) AS n FROM audit_logs")).toBe(0);
  });

  it("ゲストの login は 'guest-' ＋ base32 小文字8文字", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const l = newGuestLogin();
      expect(l).toMatch(/^guest-[a-z2-7]{8}$/);
      seen.add(l);
    }
    expect(seen.size).toBeGreaterThan(195);
  });
});

describe("ワークスペースの読み取り（WsCtx で絞る）", () => {
  it("getWorkspace・lockWorkspace は文脈のワークスペースだけを返す", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db);
    expect((await getWorkspace(db, a.ctx))?.id).toBe(a.workspaceId);
    expect((await getWorkspace(db, b.ctx))?.id).toBe(b.workspaceId);
    expect(await getWorkspace(db, { workspaceId: "00000000-0000-0000-0000-000000000000", kind: "guest", userId: null })).toBeNull();
    const locked = await db.transaction((tx) => lockWorkspace(tx, a.ctx));
    expect(locked?.id).toBe(a.workspaceId);
    expect(locked?.audit_last_hash.length).toBe(32);
  });
});
