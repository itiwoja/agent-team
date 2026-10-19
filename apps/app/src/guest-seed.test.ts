// ゲストのワークスペース（FR-046）：入口でゲスト用のトークンを入れるたびに作り、デモ用のデータを入れる（D-39・D-69・D-70）
import { useTestDb } from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import type { CheckResponse } from "./check/contract.ts";
import { call, enterGuest, guestHarness } from "./check/test-helpers.ts";
import { GUEST_SEED_VERSION } from "./guest-seed.ts";
import { GUEST_TOKEN, send } from "./test-helpers.ts";

const T = useTestDb();

const one = async <R extends object>(db: ReturnType<typeof T>["db"], sql: string, params: unknown[] = []): Promise<R> => {
  const r = await db.query<R>(sql, params);
  if (!r.rows[0]) throw new Error(`行がない：${sql}`);
  return r.rows[0];
};

describe("ゲストの入口とデモ用のデータ", () => {
  it("入口のたびに新しいゲストのワークスペースができ、用意した依頼の askId が応答に入る（next は入口。D-118）。デモ用のデータは設計書どおり", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: GUEST_TOKEN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; workspaceKind: string; next: string; firstAskId: string; created: boolean };
    expect(body).toMatchObject({ state: "signed_in", workspaceKind: "guest", created: true });
    expect(body.next).toBe(`/?prepared=${body.firstAskId}`);

    const ws = await one<{ id: string; kind: string; seed_version: string; max_concurrent_tasks: number; kill_switch_engaged: boolean }>(db, "SELECT * FROM workspaces");
    expect(ws).toMatchObject({ kind: "guest", seed_version: GUEST_SEED_VERSION, max_concurrent_tasks: 2, kill_switch_engaged: false });
    const ask = await one<{ id: string; shape: string; status: string; text: string; seed_key: string }>(db, "SELECT * FROM asks");
    expect(ask).toMatchObject({ id: body.firstAskId, shape: "chain", seed_key: "prepared-purchasing", text: "仕入れ先のメールを読んで、在庫を見て、必要なら発注して" });

    // 担当2人（受信箱係：書き込みなし、仕入れ係）、用意した依頼の順番どおり
    const agents = (await db.query<{ name: string }>("SELECT name FROM agents ORDER BY name")).rows.map((a) => a.name);
    expect(agents).toEqual(["仕入れ係", "受信箱係"]);
    // コネクタは sim-world だけ（BR-64）。日次の上限はゲストの $4（BR-62・D-105・D-106）
    expect((await db.query<{ slug: string }>("SELECT slug FROM connectors ORDER BY slug")).rows.map((c) => c.slug)).toEqual(["bank", "mail", "store", "supplier"]);
    const policy = await one<{ policy: { budget: { per_day_usd: number }; connectors: { enabled: string[] } } }>(db, "SELECT policy FROM workspace_policies");
    expect(policy.policy.budget.per_day_usd).toBe(4); // D-106（edge のゲスト1日 $4 と同じ）
    // 用意した担当の1日も $4（D-107。SHOP_DEMO_FORMATION の $1 ではなく、ゲストで新しく作る担当と同じ）。1回の仕事の予算は変えない
    const budgets = (await db.query<{ name: string; def: { budget: { per_task_usd: number; per_day_usd: number } }; eff: { budget: { agent_day_usd: number; per_task_usd: number } } }>(
      "SELECT a.name, s.definition AS def, s.effective_policies->(SELECT slug FROM agent_jobs j WHERE j.agent_id = a.id LIMIT 1)->'policy' AS eff FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id ORDER BY a.name",
    )).rows;
    expect(budgets.map((b) => [b.name, b.def.budget.per_day_usd, b.eff.budget.agent_day_usd, b.eff.budget.per_task_usd])).toEqual([["仕入れ係", 4, 4, 0.2], ["受信箱係", 4, 4, 0.2]]);

    // 1回分：受信箱係は済み、仕入れ係は確認待ち。送る前の確認が1件（リハーサルの結果は guest-rehearsal/seed.test.ts）
    const tasks = (await db.query<{ name: string; status: string; tainted: boolean; sim_snapshot_id: string | null; cost_usd: string }>(
      "SELECT a.name, t.status, t.tainted, t.sim_snapshot_id, t.cost_usd FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE t.rehearsal_run_id IS NULL ORDER BY t.queued_at",
    )).rows;
    expect(tasks.map((x) => [x.name, x.status, x.tainted])).toEqual([["受信箱係", "succeeded", true], ["仕入れ係", "awaiting_approval", true]]);
    expect(tasks.every((x) => x.sim_snapshot_id !== null)).toBe(true);
    const intent = await one<{ status: string; action: string; reason_code: string; payload: { arguments: { supplier_id: string; items: Array<{ quantity: number }> } } }>(db, "SELECT * FROM action_intents WHERE status = 'pending_approval'");
    expect((await db.query("SELECT 1 FROM action_intents WHERE status = 'pending_approval'")).rowCount).toBe(1);
    expect(intent).toMatchObject({ status: "pending_approval", action: "mcp.supplier.place_order", reason_code: "approval_required" });
    expect(intent.payload.arguments.supplier_id).toBe("supplier-01");
    expect(intent.payload.arguments.items[0]?.quantity).toBe(20);
    const approval = await one<{ status: string; first_destination: boolean; approver_ids: string[] }>(db, "SELECT * FROM approvals");
    expect(approval).toMatchObject({ status: "pending", first_destination: true });
    // リハーサルの結果は入っている（事前に走らせた固定の結果。合格証はまだない）
    expect((await db.query("SELECT 1 FROM rehearsal_runs WHERE status = 'done'")).rowCount).toBe(1);
    expect((await db.query("SELECT 1 FROM rehearsal_certificates")).rowCount).toBe(0);

    // 回答（依頼1件に1つ）：窓口は仕入れ係。手が要るもの1件
    const run = await one<{ answer: { conclusion: string; spokesperson: { agentName: string }; needsYou: { pendingApprovals: number } }; answered_at: Date | null }>(db, "SELECT * FROM ask_runs");
    expect(run.answered_at).not.toBeNull();
    expect(run.answer.spokesperson.agentName).toBe("仕入れ係");
    expect(run.answer.needsYou.pendingApprovals).toBe(1);
    // 連絡板の1往復（D-73）：仕入れ係の質問に受信箱係が答えている
    const msgs = await db.query<{ kind: string; tainted: boolean; in_reply_to: string | null; id: string }>("SELECT id, kind, tainted, in_reply_to FROM ask_messages ORDER BY created_at");
    expect(msgs.rows.map((m) => m.kind)).toEqual(["question", "reply"]);
    expect(msgs.rows.every((m) => m.tainted)).toBe(true);
    expect(msgs.rows[1]!.in_reply_to).toBe(msgs.rows[0]!.id);

    // 監査ログは作成の1件だけ、費用の記録は入れない（上限を食わない）
    expect((await db.query<{ event_type: string }>("SELECT event_type FROM audit_logs")).rows.map((r) => r.event_type)).toEqual(["workspace.created"]);
    expect((await db.query("SELECT 1 FROM usage_records")).rowCount).toBe(0);
  });

  it("入った直後の GET /session は firstAskId を返し、/me はゲストの残り日数と今日の予算（$4：D-106）を返す", async () => {
    const { t } = guestHarness(T().db);
    const g = await enterGuest(t);
    const session = await call<{ state: string; workspaceKind: string; firstAskId: string }>(t, g, "GET", "/api/v1/session");
    expect(session.body).toMatchObject({ state: "signed_in", workspaceKind: "guest", firstAskId: g.firstAskId });
    const me = await call<{ workspace: { kind: string; guest: { daysLeft: number }; budget: { perDayUsd: string; todayCostUsd: string } } }>(t, g, "GET", "/api/v1/me");
    expect(me.body.workspace.kind).toBe("guest");
    expect(me.body.workspace.guest.daysLeft).toBe(7);
    expect(me.body.workspace.budget).toMatchObject({ perDayUsd: "4.000000", todayCostUsd: "0.000000" });
  });

  it("2人のゲストは分離される：別のゲストの承認・タスクは 404、自分の見てほしいものには相手のものが出ない", async () => {
    const { t } = guestHarness(T().db);
    const a = await enterGuest(t);
    const b = await enterGuest(t);
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.firstAskId).not.toBe(b.firstAskId);
    const aApprovals = await call<{ items: Array<{ id: string; taskId: string }> }>(t, a, "GET", "/api/v1/approvals");
    const bApprovals = await call<{ items: Array<{ id: string; taskId: string; intentHash: string }> }>(t, b, "GET", "/api/v1/approvals");
    expect(aApprovals.body.items).toHaveLength(1);
    expect(bApprovals.body.items).toHaveLength(1);
    const target = bApprovals.body.items[0]!;
    // A のセッションで B の承認・タスクを指す：ワークスペースで絞られるので 404（存在を教えない）
    expect((await call(t, a, "GET", `/api/v1/approvals/${target.id}`)).status).toBe(404);
    expect((await call(t, a, "POST", `/api/v1/approvals/${target.id}/decision`, { decision: "approve", intentHash: target.intentHash })).status).toBe(404);
    expect((await call(t, a, "POST", `/api/v1/tasks/${target.taskId}/cancel`)).status).toBe(404);
    expect((await call<{ items: unknown[] }>(t, a, "GET", `/api/v1/approvals?taskId=${target.taskId}`)).body.items).toHaveLength(0);
    // B の承認は無傷
    expect((await call<{ items: unknown[] }>(t, b, "GET", "/api/v1/approvals")).body.items).toHaveLength(1);
    const checkA = (await call<CheckResponse>(t, a, "GET", "/api/v1/check")).body;
    expect(checkA.items.every((i) => i.askId === a.firstAskId)).toBe(true);
  });

  it("同じ IP から1時間に6件目は 429 GUEST_LIMIT_REACHED（scope ip）。ゲストは作らない（BR-65）", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    for (let i = 0; i < 5; i++) await enterGuest(t);
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: GUEST_TOKEN } });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; details: { scope: string } } };
    expect(body.error.code).toBe("GUEST_LIMIT_REACHED");
    expect(body.error.details.scope).toBe("ip");
    expect((await db.query("SELECT 1 FROM workspaces WHERE kind = 'guest'")).rowCount).toBe(5);
  });

  it("入口で前のセッションは失効する（ワークスペースは残る）。入れ直すと別のゲストになる", async () => {
    const { db } = T();
    const { t } = guestHarness(db);
    const a = await enterGuest(t);
    const res = await send(t, "POST", "/api/v1/entry", { body: { token: GUEST_TOKEN }, cookie: a.cookie });
    expect(res.status).toBe(200);
    expect((await send(t, "GET", "/api/v1/me", { cookie: a.cookie })).status).toBe(401);
    expect((await db.query("SELECT 1 FROM workspaces WHERE kind = 'guest'")).rowCount).toBe(2);
  });
});
