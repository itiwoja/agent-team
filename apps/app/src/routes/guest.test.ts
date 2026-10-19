// ゲストの [最初からやり直す]（POST /guest/restart）とゲストのログアウトの削除予約
import { useTestDb } from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import { call, enterGuest, guestHarness } from "../check/test-helpers.ts";
import { makeTestApp, send, sessionCookieOf, signInOwner } from "../test-helpers.ts";

const T = useTestDb();

const deletionOf = async (db: ReturnType<typeof T>["db"]) =>
  (await db.query<{ id: string; delete_requested_at: Date | null; kill_switch_engaged: boolean }>("SELECT id, delete_requested_at, kill_switch_engaged FROM workspaces WHERE kind = 'guest'")).rows;

describe("POST /guest/restart", () => {
  it("新しいゲストを作り、古いワークスペースを Kill Switch と削除予約にして、新しい Cookie と next を返す", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    const a = await enterGuest(t);
    const res = await send(t, "POST", "/api/v1/guest/restart", { cookie: a.cookie, csrf: a.csrf, body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { next: string; firstAskId: string };
    expect(body.next).toBe(`/?prepared=${body.firstAskId}`);
    expect(body.firstAskId).not.toBe(a.firstAskId);
    const cookie = sessionCookieOf(res);
    expect(cookie).toBeTruthy();
    expect(cookie).not.toBe(a.cookie);
    // 古いセッションは失効、新しい Cookie で入れる
    expect((await send(t, "GET", "/api/v1/me", { cookie: a.cookie })).status).toBe(401);
    const me = (await (await send(t, "GET", "/api/v1/me", { cookie: cookie! })).json()) as { workspace: { id: string } };
    expect(me.workspace.id).not.toBe(a.workspaceId);

    const rows = await deletionOf(db);
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.id === a.workspaceId)!;
    const fresh = rows.find((r) => r.id === me.workspace.id)!;
    expect(old.delete_requested_at).not.toBeNull();
    expect(old.kill_switch_engaged).toBe(true);
    expect(fresh.delete_requested_at).toBeNull();
    expect(fresh.kill_switch_engaged).toBe(false);
    const audit = await db.query<{ payload: { reason: string } }>("SELECT payload FROM audit_logs WHERE workspace_id = $1 AND event_type = 'killswitch.engaged'", [a.workspaceId]);
    expect(audit.rows[0]?.payload.reason).toBe("restart");
  });

  it("作成が上限に当たったら 429 GUEST_LIMIT_REACHED。古いワークスペースもセッションもそのまま残る", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    let last = await enterGuest(t);
    for (let i = 0; i < 4; i++) last = await enterGuest(t);
    const res = await send(t, "POST", "/api/v1/guest/restart", { cookie: last.cookie, csrf: last.csrf, body: {} });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("GUEST_LIMIT_REACHED");
    expect(res.headers.get("set-cookie")).toBeNull();
    const rows = await deletionOf(db);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.delete_requested_at === null && !r.kill_switch_engaged)).toBe(true);
    expect((await send(t, "GET", "/api/v1/me", { cookie: last.cookie })).status).toBe(200);
  });

  it("オーナーは 403、セッションなしは 401、CSRF なしは 403", async () => {
    const t = makeTestApp(T().db);
    const o = await signInOwner(t);
    expect((await send(t, "POST", "/api/v1/guest/restart", { cookie: o.cookie, csrf: o.csrf, body: {} })).status).toBe(403);
    expect((await send(t, "POST", "/api/v1/guest/restart", { body: {} })).status).toBe(401);
    const { t: gt } = guestHarness(T().db);
    const g = await enterGuest(gt);
    expect((await send(gt, "POST", "/api/v1/guest/restart", { cookie: g.cookie, body: {} })).status).toBe(403);
  });
});

describe("ログアウトの削除予約", () => {
  it("ゲストのログアウトでワークスペースが削除予約になる", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    const g = await enterGuest(t);
    const res = await call(t, g, "POST", "/api/v1/logout");
    expect(res.status).toBe(204);
    const rows = await deletionOf(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delete_requested_at).not.toBeNull();
  });

  it("オーナーのログアウトは削除予約にしない", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const o = await signInOwner(t);
    expect((await send(t, "POST", "/api/v1/logout", { cookie: o.cookie, csrf: o.csrf })).status).toBe(204);
    const rows = (await db.query<{ delete_requested_at: Date | null }>("SELECT delete_requested_at FROM workspaces")).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.delete_requested_at === null)).toBe(true);
  });
});
