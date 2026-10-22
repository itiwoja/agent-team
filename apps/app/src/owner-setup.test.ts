// オーナーの初期投入（G-08）：ワークスペースとポリシーだけ（コネクタは利用者がつなぐ）。冪等
import type { Db } from "@open-team/db";
import { useTestDb } from "@open-team/db/testing";
import { defaultWorkspacePolicy, hashCanonical } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import { ensureOwnerWorkspace, OwnerSetupError } from "./owner-setup.ts";
import { makeTestApp, send, sendInternal, signInOwner } from "./test-helpers.ts";

const T = useTestDb();

/** 投入した行の数（2回目で増えないこと） */
async function counts(db: Db) {
  const tables = ["workspaces", "users", "memberships", "workspace_policies", "connectors", "connector_tools", "agents", "asks", "audit_logs"];
  const out: Record<string, number> = {};
  for (const name of tables) out[name] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${name}`)).rows[0]?.n ?? -1;
  return out;
}

describe("ensureOwnerWorkspace（G-08）", () => {
  it("1回目でワークスペースとポリシーが入り、2回目は同じ（行・ID・監査ログが増えない、作ったものは false）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const first = await ensureOwnerWorkspace(t.deps);
    expect(first.created).toEqual({ workspace: true, policy: true });
    const after1 = await counts(db);
    // コネクタ・担当・依頼は作らない（利用者がつなぐ・頼む）
    expect(after1).toMatchObject({ workspaces: 1, users: 1, memberships: 1, workspace_policies: 1, connectors: 0, connector_tools: 0, agents: 0, asks: 0 });

    const second = await ensureOwnerWorkspace(t.deps);
    expect(second).toEqual({ workspaceId: first.workspaceId, ownerUserId: first.ownerUserId, created: { workspace: false, policy: false } });
    expect(await counts(db)).toEqual(after1);
  });

  it("ポリシーは kernel のオーナーの既定（per_day_usd 10・mcp_write approve）。ハッシュは正規化した JSON のハッシュ", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const r = await ensureOwnerWorkspace(t.deps);
    const p = await db.query<{ version: number; policy: { budget: { per_day_usd: number }; autonomy: Record<string, string> }; policy_hash: string }>(
      "SELECT version, policy, policy_hash FROM workspace_policies WHERE workspace_id = $1",
      [r.workspaceId],
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]?.version).toBe(1);
    expect(p.rows[0]?.policy.budget.per_day_usd).toBe(10);
    expect(p.rows[0]?.policy.autonomy.mcp_write).toBe("approve");
    expect(p.rows[0]?.policy_hash).toBe(hashCanonical(defaultWorkspacePolicy("owner")));
  });

  it("監査ログは workspace.created とポリシー（origin: seed）だけで、ハッシュチェーンが通る。2回目は増えない", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const r = await ensureOwnerWorkspace(t.deps);
    const logs = async () =>
      (await db.query<{ event_type: string; payload: Record<string, unknown> }>("SELECT event_type, payload FROM audit_logs WHERE workspace_id = $1 ORDER BY seq", [r.workspaceId])).rows;
    const first = await logs();
    expect(first.map((x) => x.event_type)).toEqual(["workspace.created", "policy.snapshot_created"]);
    expect(first[1]?.payload).toMatchObject({ scope: "workspace", version: 1, origin: "seed" });
    await ensureOwnerWorkspace(t.deps);
    expect(await logs()).toHaveLength(2);
    // 監査ログの検証（EP-44）もこのワークスペースで通る
    const a = await signInOwner(t);
    const v = await send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/audit-logs/verify`, { cookie: a.cookie, csrf: a.csrf, body: {} });
    expect(await v.json()).toMatchObject({ ok: true, checkedCount: 2 });
  });

  it("入口で先にできたオーナーのワークスペースに足していく（同じワークスペース）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const r = await ensureOwnerWorkspace(t.deps);
    expect(r.workspaceId).toBe(a.workspaceId);
    expect(r.ownerUserId).toBe(a.userId);
    expect(r.created.workspace).toBe(false);
  });

  it("同時に2回呼んでも二重に作らない", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const [x, y] = await Promise.all([ensureOwnerWorkspace(t.deps), ensureOwnerWorkspace(t.deps)]);
    expect(x.workspaceId).toBe(y.workspaceId);
    expect([x.created.policy, y.created.policy].filter(Boolean)).toHaveLength(1);
    expect(await counts(db)).toMatchObject({ workspaces: 1, workspace_policies: 1 });
  });

  it("DB に届かない → workspace の手順で止まる（OwnerSetupError）", async () => {
    const { db } = T();
    const broken = { ...db, query: async () => Promise.reject(new Error("つながらない")), transaction: async () => Promise.reject(new Error("つながらない")) } as unknown as Db;
    const e = await ensureOwnerWorkspace({ db: broken, clock: { now: () => new Date() } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OwnerSetupError);
    expect((e as OwnerSetupError).step).toBe("workspace");
  });
});

describe("POST /internal/setup/owner-workspace", () => {
  it("sa-app の証明で呼べる（結果の JSON）。証明なし → 403。2回目は作ったものが false", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    expect((await sendInternal(t, "POST", "/internal/setup/owner-workspace", null)).status).toBe(403);
    const res = await sendInternal(t, "POST", "/internal/setup/owner-workspace");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaceId: string; created: { workspace: boolean; policy: boolean } };
    expect(body.created).toEqual({ workspace: true, policy: true });
    const again = (await (await sendInternal(t, "POST", "/internal/setup/owner-workspace")).json()) as typeof body;
    expect(again).toMatchObject({ workspaceId: body.workspaceId, created: { workspace: false, policy: false } });
  });
});
