// 承認（API-017・019）・チェック（GET /check・POST /check/:itemId・/done・/counts）・やっていることの取り消し（API-016）・tick
// オーナーで入り、順番の依頼（受信箱係 → 仕入れ係）の1回分（送る前の確認が1件）を入れた状態を土台にする（check/test-helpers.ts）
import { effectivePolicyHash } from "@open-team/kernel";
import { useTestDb } from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import { runTick } from "../tick.ts";
import { approvalsTickStep } from "./tick-step.ts";
import { OWNER_TOKEN, send } from "../test-helpers.ts";
import type { ApprovalListResponse, ApprovalView, CheckCounts, CheckResponse, DecisionResponse, DoneResponse } from "./contract.ts";
import { ApprovalView as ApprovalViewSchema, CheckResponse as CheckResponseSchema, DecisionResponse as DecisionResponseSchema } from "./contract.ts";
import { productionEdgeHooks } from "./hooks.ts";
import { call, checkHarness, enterWithPendingApproval, type CheckHarness, type CheckSession } from "./test-helpers.ts";

const T = useTestDb();

/** 承認の tick の手順だけ動かす（依頼の tick は別の試験） */
const mine = (h: CheckHarness) => ({ ...h.t.deps, tickSteps: [approvalsTickStep] });

async function setup(o: Parameters<typeof checkHarness>[1] = {}): Promise<{ h: CheckHarness; g: CheckSession; approval: ApprovalView }> {
  const h = checkHarness(T().db, o);
  const g = await enterWithPendingApproval(h.t);
  const list = await call<ApprovalListResponse>(h.t, g, "GET", "/api/v1/approvals");
  return { h, g, approval: list.body.items[0]! };
}

const codeOf = (r: { body: unknown }): string => (r.body as { error: { code: string } }).error.code;
const decide = (h: CheckHarness, g: CheckSession, a: Pick<ApprovalView, "id" | "intentHash">, extra: Record<string, unknown> = {}) =>
  call<DecisionResponse>(h.t, g, "POST", `/api/v1/approvals/${a.id}/decision`, { decision: "approve", intentHash: a.intentHash, ...extra });

describe("GET /approvals（API-017）・カードの中身", () => {
  it("承認待ちの一覧は ask_id・task_id で絞れる。カードは決まった文で、BR-70（初めての送り先）は開いた状態", async () => {
    const { h, g, approval } = await setup();
    expect(ApprovalViewSchema.safeParse(approval).success).toBe(true);
    expect(approval).toMatchObject({
      status: "pending",
      title: "place_order を実行する",
      subtitle: "supplier-01",
      action: "mcp.supplier.place_order",
      canDecide: true,
      askId: g.askId,
      agent: { name: "仕入れ係" },
      openReason: { code: "first_destination", text: "初めての送り先です", emphasis: "supplier-01" },
      taintNote: null,
      rule: { reasonCode: "approval_required", text: "ルールにより、送る前に確認が必要です" },
    });
    expect(approval.destination.map((d) => [d.arg, d.label])).toEqual([["supplier_id", null]]);
    expect(approval.options.map((d) => d.arg).sort()).toEqual(["items[].quantity", "items[].sku", "items[].unit_price"]);
    expect(approval.options.find((d) => d.arg === "items[].quantity")?.text).toBe("20");
    expect(approval.content.map((d) => d.text)).toEqual(["いつもの量でお願いします"]);
    // 受け渡しで汚染されている：「受信箱係が読んだメールを受け取った」
    expect(approval.taint.tainted).toBe(true);
    expect(approval.taint.sources[0]?.text).toBe("受信箱係がメールを読んだ内容を受け取った");
    expect(approval.risk.level).toBe("high");
    // [以後も許可]：固定される値を見せる（宛先とその他すべて）
    expect(approval.remember.offered).toBe(true);
    expect(approval.remember.fixed.map((f) => f.arg)).toEqual(["items[].quantity", "items[].sku", "items[].unit_price", "supplier_id"]);
    expect(approval.remember.freeCandidates.sort()).toEqual(["items[].quantity", "items[].sku", "items[].unit_price"]);
    expect(approval.remember.fixedHash).toMatch(/^[0-9a-f]{64}$/);
    // SG-09：汚染されたタスクの書き込みから作るルールだと分かる印（作ることは止めない：BR-57）
    expect(approval.remember.taintedOrigin).toBe(true);

    const byAsk = await call<ApprovalListResponse>(h.t, g, "GET", `/api/v1/approvals?askId=${g.askId}`);
    expect(byAsk.body.items).toHaveLength(1);
    const other = await call<ApprovalListResponse>(h.t, g, "GET", "/api/v1/approvals?askId=00000000-0000-4000-8000-000000000000");
    expect(other.body.items).toHaveLength(0);
    expect((await call<ApprovalListResponse>(h.t, g, "GET", "/api/v1/approvals?status=approved")).body.items).toHaveLength(0);
    expect((await call(h.t, g, "GET", "/api/v1/approvals?limit=0")).status).toBe(400);
    expect((await call<ApprovalView>(h.t, g, "GET", `/api/v1/approvals/${approval.id}`)).body.id).toBe(approval.id);
  });
});

describe("GET /check（SCR-019）", () => {
  it("送る前の確認 → 質問 → 報告の順。件数・やっていること・Kill Switch の状態を返し、?item= で行を開く", async () => {
    const { h, g, approval } = await setup();
    const res = await call<CheckResponse>(h.t, g, "GET", "/api/v1/check");
    expect(CheckResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.items.map((i) => [i.kind, i.key.split(":")[0]])).toEqual([["approval", "approval"], ["report", "answer"]]);
    expect(res.body.items[0]).toMatchObject({ kind: "approval", title: "place_order を実行する", opened: true });
    const answer = res.body.items[1]!;
    expect(answer).toMatchObject({ kind: "report", reportKind: "answer", failed: false, subtitle: "仕入れ係 · 2人で", title: "豆が残り2kgなので、山田珈琲に20kgを発注します。" });
    expect(answer.kind === "report" ? answer.lines : []).toEqual(["受信箱係：新しいメール3通を確認しました", "仕入れ係：豆が残り2kgなので、山田珈琲に20kgを発注します。受信箱係に確かめました", "あなたの確認待ち：1件", "外部の内容をもとにしています（受信箱係が読んだメール）"]);
    expect(res.body.counts).toEqual({ attention: 2, running: 0, hasApproval: true });
    expect(res.body.killSwitch).toEqual({ engaged: false });
    expect(res.body.running).toEqual([]);
    expect(res.body.focus).toBeNull();
    const focused = await call<CheckResponse>(h.t, g, "GET", `/api/v1/check?item=${encodeURIComponent(answer.key)}`);
    expect(focused.body.focus).toBe(answer.key);
    expect(focused.body.items.find((i) => i.key === answer.key)?.opened).toBe(true);
    expect((await call<CheckCounts>(h.t, g, "GET", "/api/v1/counts")).body).toEqual({ attention: 2, running: 0, hasApproval: true });
    void approval;
  });

  it("報告の ○（POST /check/:itemId）：行が消えて件数が減り、済んだものに出る。冪等。承認・質問は ○ で消せない。別のワークスペースの行は 404", async () => {
    const { h, g, approval } = await setup();
    const check = (await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body;
    const answerKey = check.items.find((i) => i.kind === "report")!.key;
    const r1 = await call<{ key: string; checkedAt: string; counts: CheckCounts }>(h.t, g, "POST", `/api/v1/check/${encodeURIComponent(answerKey)}`);
    expect(r1.status).toBe(200);
    expect(r1.body.counts).toEqual({ attention: 1, running: 0, hasApproval: true });
    h.t.clock.advance(1000);
    const r2 = await call<{ checkedAt: string }>(h.t, g, "POST", `/api/v1/check/${encodeURIComponent(answerKey)}`);
    expect(r2.body.checkedAt).toBe(r1.body.checkedAt);
    expect((await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body.items.map((i) => i.kind)).toEqual(["approval"]);
    const done = await call<DoneResponse>(h.t, g, "GET", "/api/v1/done");
    expect(done.body.items.map((d) => [d.key, d.kind])).toEqual([[answerKey, "report"]]);
    expect(codeOf(await call(h.t, g, "POST", `/api/v1/check/approval:${approval.id}`))).toBe("CHECK_ITEM_NOT_CHECKABLE");
    expect(codeOf(await call(h.t, g, "POST", "/api/v1/check/answer:00000000-0000-4000-8000-000000000000"))).toBe("NOT_FOUND");
    expect((await call(h.t, g, "POST", "/api/v1/check/ばらばら")).status).toBe(400);
    // SSE の事象（check.remove・check.counts）が書かれている
    const types = (await T().db.query<{ type: string }>("SELECT type FROM workspace_events ORDER BY id")).rows.map((r) => r.type);
    expect(types).toContain("check.remove");
    expect(types).toContain("check.counts");
  });

  it("状態を変える API は CSRF とセッションが必須", async () => {
    const { h, g, approval } = await setup();
    const noCsrf = await send(h.t, "POST", `/api/v1/approvals/${approval.id}/decision`, { cookie: g.cookie, body: { decision: "approve", intentHash: approval.intentHash } });
    expect(noCsrf.status).toBe(403);
    const noSession = await send(h.t, "GET", "/api/v1/check");
    expect(noSession.status).toBe(401);
    expect((await send(h.t, "POST", "/api/v1/tasks/00000000-0000-4000-8000-000000000000/cancel", { cookie: g.cookie })).status).toBe(403);
  });
});

describe("POST /approvals/:id/decision（API-019）", () => {
  it("approve：intentHash が違えば 409 INTENT_CHANGED、合えば approved になり、既存の経路（再判定 → gateway）で実行される。2回目は 409 APPROVAL_NOT_PENDING", async () => {
    const { h, g, approval } = await setup();
    const bad = await decide(h, g, { id: approval.id, intentHash: "0".repeat(64) });
    expect(bad.status).toBe(409);
    expect(codeOf(bad)).toBe("INTENT_CHANGED");
    expect(h.gateway.executed).toEqual([]);

    const ok = await decide(h, g, approval);
    expect(ok.status).toBe(200);
    expect(DecisionResponseSchema.safeParse(ok.body).success).toBe(true);
    expect(ok.body.approval).toMatchObject({ status: "approved", decisionComment: null });
    expect(ok.body.execution).toEqual({ status: "executed", failReason: null, expiredReason: null });
    expect(ok.body.rule).toBeNull();
    expect(h.gateway.executed).toEqual([approval.intentId]);
    const db = T().db;
    expect((await db.query<{ status: string }>("SELECT status FROM action_intents")).rows[0]?.status).toBe("executed");
    expect((await db.query<{ status: string; decided_by: string }>("SELECT status, decided_by FROM approvals")).rows[0]).toMatchObject({ status: "approved", decided_by: g.userId });
    const audit = (await db.query<{ event_type: string; payload: { decision?: string; remember?: boolean } }>("SELECT event_type, payload FROM audit_logs WHERE event_type = 'approval.decided'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({ decision: "approve", remember: false });
    expect(codeOf(await decide(h, g, approval))).toBe("APPROVAL_NOT_PENDING");
    expect((await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body.items.map((i) => i.kind)).toEqual(["report"]);
    // 済んだもの：決定した承認
    const done = (await call<DoneResponse>(h.t, g, "GET", "/api/v1/done")).body;
    expect(done.items[0]).toMatchObject({ kind: "approval", outcome: "approved", title: "place_order を実行する" });
  });

  it("gateway に届かなくても承認は残り（Intent は approved のまま）、30秒後の tick が拾い直して実行する（G-02）", async () => {
    const { h, g, approval } = await setup();
    h.gateway.failExecute(503);
    const res = await decide(h, g, approval);
    expect(res.status).toBe(200);
    expect(res.body.execution?.status).toBe("not_started");
    expect(res.body.approval.status).toBe("approved");
    const db = T().db;
    expect((await db.query<{ status: string }>("SELECT status FROM action_intents")).rows[0]?.status).toBe("approved");
    // 30秒たつまでは拾わない
    const c0 = await runTick(mine(h));
    expect(c0).toMatchObject({ dispatched: 0 });
    h.gateway.failExecute(null);
    h.t.clock.advance(31_000);
    expect(await runTick(mine(h))).toMatchObject({ dispatched: 1 });
    expect((await db.query<{ status: string }>("SELECT status FROM action_intents")).rows[0]?.status).toBe("executed");
  });

  it("reject：却下になり、実行しない。タスクは確認で断った終わり方になり、送る前の確認の行が消える", async () => {
    const { h, g, approval } = await setup();
    const res = await call<DecisionResponse>(h.t, g, "POST", `/api/v1/approvals/${approval.id}/decision`, { decision: "reject", intentHash: approval.intentHash, comment: "数量が多い" });
    expect(res.status).toBe(200);
    expect(res.body.approval).toMatchObject({ status: "rejected", decisionComment: "数量が多い" });
    expect(res.body.execution).toBeNull();
    expect(h.gateway.executed).toEqual([]);
    const db = T().db;
    expect((await db.query<{ status: string }>("SELECT status FROM action_intents")).rows[0]?.status).toBe("rejected");
    expect((await db.query<{ status: string; status_detail: string | null }>("SELECT status, status_detail FROM tasks WHERE status NOT IN ('succeeded')")).rows[0]).toMatchObject({ status: "completed", status_detail: "actions_declined" });
    const check = (await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body;
    expect(check.items.map((i) => (i.kind === "report" ? i.reportKind : i.kind))).toContain("answer");
    expect(check.items.some((i) => i.kind === "approval")).toBe(false);
  });

  it("reject のあと：用意した依頼の回答に「送らない」にしたことが出る（結論は担当の報告のまま、手が要るものの行と担当の行・段の文で言う：FR-063・D-108）", async () => {
    const { h, g, approval } = await setup();
    const db = T().db;
    const askId = (await db.query<{ ask_id: string }>("SELECT ask_id FROM tasks WHERE ask_id IS NOT NULL LIMIT 1")).rows[0]!.ask_id;
    const before = (await call<{ answer: { needsYou: { declinedLine: string | null; declinedWrites: number } } }>(h.t, g, "GET", `/api/v1/asks/${askId}`)).body;
    expect(before.answer.needsYou).toMatchObject({ declinedWrites: 0, declinedLine: null });
    expect((await call(h.t, g, "POST", `/api/v1/approvals/${approval.id}/decision`, { decision: "reject", intentHash: approval.intentHash })).status).toBe(200);
    const after = (
      await call<{
        ask: { status: string };
        answer: { conclusion: string; memberLines: Array<{ agentName: string; text: string }>; needsYou: { pendingApprovals: number; line: string | null; declinedWrites: number; declinedLine: string | null } };
        stages: Array<{ agentName: string; stateText: string }>;
      }>(h.t, g, "GET", `/api/v1/asks/${askId}`)
    ).body;
    expect(after.answer.needsYou).toMatchObject({ pendingApprovals: 0, line: null, declinedWrites: 1, declinedLine: "あなたが「送らない」にしたもの：1件（送っていません）" });
    expect(after.answer.memberLines.find((m) => m.agentName === "仕入れ係")?.text).toBe("豆が残り2kgなので、山田珈琲に20kgを発注します（あなたの確認で1件を送りませんでした）。受信箱係に確かめました");
    expect(after.stages.find((s) => s.agentName === "仕入れ係")?.stateText).toBe("済み（1件は送りませんでした）");
    // 定期の依頼（毎日18時）は、1回分が終わっても依頼そのものは running のまま（askStatusFor。次の実行を待つ）
    expect(after.ask.status).toBe("running");
    // SCR-019 の回答の行にも出る
    const check = (await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body;
    const answerRow = check.items.find((i) => i.kind === "report" && i.reportKind === "answer");
    expect(answerRow && "lines" in answerRow ? answerRow.lines : []).toContain("あなたが「送らない」にしたもの：1件（送っていません）");
  });

  it("remember：固定される値の確認（rememberFixedHash）が要る。違えば 409、合えばルールが定義に足され（widen・approval_rule）、新しいスナップショットになる", async () => {
    const { h, g, approval } = await setup();
    const noHash = await call(h.t, g, "POST", `/api/v1/approvals/${approval.id}/decision`, { decision: "approve", intentHash: approval.intentHash, remember: true });
    expect(noHash.status).toBe(400);
    const badHash = await decide(h, g, approval, { remember: true, rememberFixedHash: "f".repeat(64) });
    expect(badHash.status).toBe(409);
    expect(h.gateway.executed).toEqual([]);
    const rejectRemember = await call(h.t, g, "POST", `/api/v1/approvals/${approval.id}/decision`, { decision: "reject", intentHash: approval.intentHash, remember: true, rememberFixedHash: approval.remember.fixedHash });
    expect(rejectRemember.status).toBe(400);
    const notOption = await decide(h, g, approval, { remember: true, rememberFixedHash: approval.remember.fixedHash, freeOptions: ["supplier_id"] });
    expect(notOption.status).toBe(400);

    const db = T().db;
    const before = (await db.query<{ current_snapshot_id: string }>("SELECT current_snapshot_id FROM agents WHERE name = '仕入れ係'")).rows[0]!.current_snapshot_id;
    const res = await decide(h, g, approval, { remember: true, rememberFixedHash: approval.remember.fixedHash, freeOptions: ["items[].quantity"] });
    expect(res.status).toBe(200);
    expect(res.body.rule).toMatchObject({ action: "mcp.supplier.place_order", free: ["items[].quantity"], labels: null });
    expect(res.body.rule?.match).toMatchObject({ supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE"] });
    expect(res.body.rule?.match).not.toHaveProperty("items[].quantity");
    expect(res.body.execution?.status).toBe("executed");
    const row = (await db.query<{ current_snapshot_id: string; definition: { rules: Array<{ id: string; added_by: string }> } }>(
      "SELECT a.current_snapshot_id, s.definition FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id WHERE a.name = '仕入れ係'",
    )).rows[0]!;
    expect(row.current_snapshot_id).not.toBe(before);
    // 仕入れ係には前からあるルール（r-0001）が入っている。新しいルールは最後に足される
    expect(row.definition.rules).toHaveLength(2);
    expect(row.definition.rules[0]).toMatchObject({ id: "r-0001" });
    expect(row.definition.rules[1]).toMatchObject({ id: res.body.rule?.id, added_by: g.userId });
    const change = (await db.query<{ origin: string; classification: string; status: string; widened_items: Array<{ kind: string }> }>("SELECT * FROM agent_config_changes")).rows;
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({ origin: "approval_rule", classification: "widen", status: "applied" });
    expect(change[0]?.widened_items[0]?.kind).toBe("rule_added");
    expect((await db.query<{ remember: boolean; created_rule_id: string }>("SELECT remember, created_rule_id FROM approvals")).rows[0]).toMatchObject({ remember: true, created_rule_id: res.body.rule?.id });
    expect((await db.query("SELECT 1 FROM audit_logs WHERE event_type = 'agent.config.widened'")).rowCount).toBe(1);
  });

  it("SG-09：remember で作ったルールに出どころの記録（安定した id・作った人・時刻・Intent・汚染）が付き、監査ログにも残る", async () => {
    const { h, g, approval } = await setup();
    const db = T().db;
    const res = await decide(h, g, approval, { remember: true, rememberFixedHash: approval.remember.fixedHash, freeOptions: ["items[].quantity"] });
    expect(res.status).toBe(200);
    const ruleId = res.body.rule!.id;
    expect(ruleId).toMatch(/^r-[0-9a-f]{32}$/);
    const def = (await db.query<{ definition: { rules: Array<Record<string, unknown>> } }>(
      "SELECT s.definition FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id WHERE a.name = '仕入れ係'",
    )).rows[0]!.definition;
    const rule = def.rules.find((r) => r.id === ruleId);
    expect(rule).toMatchObject({ added_by: g.userId, added_at: expect.any(String), source_intent_id: approval.intentId, created_while_tainted: true });
    // 前からあるルール（記録より前の形）も、そのまま読めて残る
    const legacy = def.rules.find((r) => r.id === "r-0001");
    expect(legacy).toBeDefined();
    expect(legacy).not.toHaveProperty("created_while_tainted");
    const widened = (await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_logs WHERE event_type = 'agent.config.widened'")).rows;
    expect(widened).toEqual([{ payload: expect.objectContaining({ origin: "approval_rule", ruleId, sourceIntentId: approval.intentId, createdWhileTainted: true }) }]);
    const decided = (await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_logs WHERE event_type = 'approval.decided'")).rows;
    expect(decided).toEqual([{ payload: expect.objectContaining({ decision: "approve", remember: true, ruleId, ruleCreatedWhileTainted: true }) }]);
  });

  it("SG-09：汚染されていない Intent からのルールは taintedOrigin: false・created_while_tainted: false", async () => {
    const { h, g, approval } = await setup();
    const db = T().db;
    await db.query(`UPDATE action_intents SET taint_snapshot = '{"tainted":false,"sources":[]}'::jsonb WHERE id = $1`, [approval.intentId]);
    const list = await call<ApprovalListResponse>(h.t, g, "GET", "/api/v1/approvals");
    const fresh = list.body.items.find((a) => a.id === approval.id)!;
    expect(fresh.remember).toMatchObject({ offered: true, taintedOrigin: false });
    const res = await decide(h, g, fresh, { remember: true, rememberFixedHash: fresh.remember.fixedHash });
    expect(res.status).toBe(200);
    const ruleId = res.body.rule!.id;
    const rules = (await db.query<{ definition: { rules: Array<Record<string, unknown>> } }>(
      "SELECT s.definition FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id WHERE a.name = '仕入れ係'",
    )).rows[0]!.definition.rules;
    expect(rules.find((r) => r.id === ruleId)).toMatchObject({ created_while_tainted: false, source_intent_id: approval.intentId });
    const widened = (await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_logs WHERE event_type = 'agent.config.widened'")).rows;
    expect(widened[0]?.payload).toMatchObject({ ruleId, createdWhileTainted: false });
  });

  it("SG-09：承認だけ（remember なし）の監査ログには、ルールの汚染の印を付けない", async () => {
    const { h, g, approval } = await setup();
    const res = await decide(h, g, approval);
    expect(res.status).toBe(200);
    const decided = (await T().db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_logs WHERE event_type = 'approval.decided'")).rows;
    expect(decided[0]?.payload).toMatchObject({ remember: false, ruleId: null });
    expect(decided[0]?.payload).not.toHaveProperty("ruleCreatedWhileTainted");
  });

  it("Kill Switch 発動中は承認も却下も 423。却下・承認の対象でない人は 403。期限切れは 409 で、承認は expired になる", async () => {
    const { h, g, approval } = await setup();
    const ks = await call(h.t, g, "POST", `/api/v1/workspaces/${g.workspaceId}/kill-switch`, {});
    expect(ks.status).toBe(200);
    expect((await decide(h, g, approval)).status).toBe(423);
    expect((await call(h.t, g, "POST", `/api/v1/approvals/${approval.id}/decision`, { decision: "reject", intentHash: approval.intentHash })).status).toBe(423);
    expect(h.gateway.executed).toEqual([]);
  });

  it("承認者でないと 403（approver_ids に自分がいない）", async () => {
    const { h, g, approval } = await setup();
    await T().db.query("UPDATE approvals SET approver_ids = ARRAY[gen_random_uuid()]");
    const res = await decide(h, g, approval);
    expect(res.status).toBe(403);
    const list = (await call<ApprovalListResponse>(h.t, g, "GET", "/api/v1/approvals")).body.items[0]!;
    expect(list.canDecide).toBe(false);
  });

  it("期限（24時間と依頼の次の実行の早い方）が過ぎた承認は 409 APPROVAL_NOT_PENDING。一覧・見てほしいものから消え、承認は expired・Intent は superseded（BR-60）", async () => {
    const { h, g, approval } = await setup();
    h.t.clock.advance(25 * 60 * 60 * 1000);
    expect((await call<ApprovalListResponse>(h.t, g, "GET", "/api/v1/approvals")).body.items).toHaveLength(0);
    expect((await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body.counts.hasApproval).toBe(false);
    const res = await decide(h, g, approval);
    expect(codeOf(res)).toBe("APPROVAL_NOT_PENDING");
    const db = T().db;
    expect((await db.query<{ status: string }>("SELECT status FROM approvals")).rows[0]?.status).toBe("expired");
    expect((await db.query<{ status: string; expire_reason: string }>("SELECT status, expire_reason FROM action_intents")).rows[0]).toMatchObject({ status: "expired", expire_reason: "superseded" });
  });

  it("実行の前の再判定（M-20）：承認のあとに今のポリシーが deny になっていたら、実行せず expired（policy_changed）にする", async () => {
    const { h, g, approval } = await setup();
    const db = T().db;
    const snap = (await db.query<{ id: string; agent_id: string; definition: unknown; effective_policies: Record<string, { policy: { autonomy: Record<string, string> }; hash: string }>; clamped: unknown; ceilings_version: string }>(
      "SELECT s.* FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id WHERE a.name = '仕入れ係'",
    )).rows[0]!;
    const policies = structuredClone(snap.effective_policies);
    const entry = policies.reorder!;
    entry.policy.autonomy.mcp_write = "deny";
    entry.hash = effectivePolicyHash(entry.policy as never);
    const ins = await db.query<{ id: string }>(
      `INSERT INTO agent_snapshots (workspace_id, agent_id, source, status, definition, effective_policies, clamped, ceilings_version)
       VALUES ($1, $2, 'in_app', 'valid', $3::jsonb, $4::jsonb, $5::jsonb, $6) RETURNING id`,
      [g.workspaceId, snap.agent_id, snap.definition as never, policies as never, snap.clamped as never, snap.ceilings_version],
    );
    await db.query("UPDATE agents SET current_snapshot_id = $1 WHERE id = $2", [ins.rows[0]!.id, snap.agent_id]);
    const res = await decide(h, g, approval);
    expect(res.status).toBe(200);
    expect(res.body.execution).toEqual({ status: "expired", failReason: null, expiredReason: "policy_changed" });
    expect(h.gateway.executed).toEqual([]);
    expect((await db.query<{ status: string; expire_reason: string }>("SELECT status, expire_reason FROM action_intents")).rows[0]).toMatchObject({ status: "expired", expire_reason: "policy_changed" });
  });
});

describe("Idempotency-Key と届いたか分からない書き込み（API-070）", () => {
  it("同じ Idempotency-Key の再送は、記録した応答をそのまま返す（2回目の承認は 409 にならず、実行も1回だけ）。違う内容に同じキーは 400", async () => {
    const { h, g, approval } = await setup();
    const key = "3b1f7d1e-8a3c-4d57-9c41-0d6a8f5f2a10";
    const headers = { "idempotency-key": key };
    const post = (body: unknown, path = `/api/v1/approvals/${approval.id}/decision`) => send(h.t, "POST", path, { cookie: g.cookie, csrf: g.csrf, body, headers });
    const first = await post({ decision: "approve", intentHash: approval.intentHash });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const second = await post({ decision: "approve", intentHash: approval.intentHash });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(h.gateway.executed).toEqual([approval.intentId]);
    expect((await post({ decision: "reject", intentHash: approval.intentHash })).status).toBe(400);
  });

  it("unknown_outcome は質問の行（選択肢は2つに固定）。[届いていた]・[届いていない] で確定し、もう一度実行は断る（自動で再送しない）", async () => {
    const { h, g, approval } = await setup();
    const db = T().db;
    await db.query("UPDATE approvals SET status = 'approved', decided_by = $1, decided_at = now()", [g.userId]);
    await db.query("UPDATE action_intents SET status = 'unknown_outcome'");
    const check = (await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body;
    const q = check.items.find((i) => i.kind === "question");
    expect(q).toMatchObject({
      kind: "question",
      source: "unknown_outcome",
      key: `unknown_outcome:${approval.intentId}`,
      title: "届いたか分かりません：place_order を実行する",
      question: { text: "書き込みが届いたか分かりません", choices: [{ id: "executed", label: "届いていた" }, { id: "failed", label: "届いていない" }], allowFreeText: false },
      opened: true,
    });
    // 質問は ○ では消せない
    expect(codeOf(await call(h.t, g, "POST", `/api/v1/check/unknown_outcome:${approval.intentId}`))).toBe("CHECK_ITEM_NOT_CHECKABLE");
    const retry = await call(h.t, g, "POST", `/api/v1/intents/${approval.intentId}/resolve`, { outcome: "retry" });
    expect(retry.status).toBe(422);
    const ok = await call<{ status: string }>(h.t, g, "POST", `/api/v1/intents/${approval.intentId}/resolve`, { outcome: "failed" });
    expect(ok.body).toMatchObject({ status: "failed" });
    expect((await db.query<{ status: string; fail_reason: string; resolution: string }>("SELECT status, fail_reason, resolution FROM action_intents")).rows[0]).toMatchObject({ status: "failed", fail_reason: "confirmed_not_delivered", resolution: "confirmed_not_delivered" });
    expect(codeOf(await call(h.t, g, "POST", `/api/v1/intents/${approval.intentId}/outcome`, { outcome: "executed" }))).toBe("INTENT_NOT_UNKNOWN");
    expect((await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body.items.some((i) => i.kind === "question")).toBe(false);
    expect((await db.query("SELECT 1 FROM audit_logs WHERE event_type = 'intent.resolved'")).rowCount).toBe(1);
  });
});

describe("POST /tasks/:taskId/cancel（API-016）", () => {
  it("取り消すと cancelled（user）・待っていた承認は expired になり、行が消える。2回目は 409、別人は 403（owner でなく依頼者でもない場合）", async () => {
    const { h, g, approval } = await setup();
    const res = await call<{ taskId: string; status: string; expiredApprovals: number }>(h.t, g, "POST", `/api/v1/tasks/${approval.taskId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ taskId: approval.taskId, status: "cancelled", expiredApprovals: 1 });
    const db = T().db;
    expect((await db.query<{ status: string; status_detail: string; task_token_hash: unknown }>("SELECT status, status_detail, task_token_hash FROM tasks WHERE id = $1", [approval.taskId])).rows[0]).toMatchObject({ status: "cancelled", status_detail: "user", task_token_hash: null });
    expect((await db.query<{ status: string }>("SELECT status FROM approvals")).rows[0]?.status).toBe("expired");
    expect((await db.query<{ status: string; expire_reason: string }>("SELECT status, expire_reason FROM action_intents")).rows[0]).toMatchObject({ status: "expired", expire_reason: "task_cancelled" });
    expect((await db.query("SELECT 1 FROM audit_logs WHERE event_type = 'task.cancelled'")).rowCount).toBe(1);
    expect(codeOf(await call(h.t, g, "POST", `/api/v1/tasks/${approval.taskId}/cancel`))).toBe("TASK_ALREADY_TERMINATED");
    expect((await call<CheckResponse>(h.t, g, "GET", "/api/v1/check")).body.counts.hasApproval).toBe(false);
    expect((await call<ApprovalListResponse>(h.t, g, "GET", "/api/v1/approvals")).body.items).toHaveLength(0);
  });

  it("owner でも依頼者でもなければ 403。存在しないタスクは 404", async () => {
    const { h, g, approval } = await setup();
    await T().db.query("UPDATE memberships SET role = 'maintainer'");
    await T().db.query("UPDATE tasks SET requester_id = (SELECT id FROM users WHERE login = 'owner' UNION ALL SELECT gen_random_uuid() LIMIT 1) WHERE false");
    await T().db.query("INSERT INTO users (login) VALUES ('someone') ON CONFLICT DO NOTHING");
    await T().db.query("UPDATE tasks SET requester_id = (SELECT id FROM users WHERE login = 'someone')");
    expect((await call(h.t, g, "POST", `/api/v1/tasks/${approval.taskId}/cancel`)).status).toBe(403);
    expect((await call(h.t, g, "POST", "/api/v1/tasks/00000000-0000-4000-8000-000000000000/cancel")).status).toBe(404);
  });
});

describe("tick：承認の期限切れ", () => {
  it("期限が来た承認を expired にし、タスクの状態を決め直す。見てほしいものの行を消す事象も書く", async () => {
    const { h } = await setup();
    h.t.clock.advance(25 * 60 * 60 * 1000);
    const counts = await runTick(mine(h));
    expect(counts.expiredApprovals).toBe(1);
    const db = T().db;
    expect((await db.query<{ status: string }>("SELECT status FROM approvals")).rows[0]?.status).toBe("expired");
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_events WHERE type = 'check.remove'")).rows[0]?.n).toBe(1);
    expect(await runTick(mine(h))).toMatchObject({ expiredApprovals: 0 });
  });
});

describe("本番の edge の hooks（productionEdgeHooks）", () => {
  it("Intent を保存したあと：送る前の確認の行を SSE に足す。approved は再判定のあと gateway を起こす", async () => {
    const { h, g, approval } = await setup();
    const hooks = productionEdgeHooks(h.t.deps);
    const ctx = { workspaceId: g.workspaceId, kind: "owner" as const, userId: null };
    await hooks.onIntentRecorded?.(ctx, { taskId: approval.taskId, intentId: approval.intentId, status: "pending_approval" });
    const db = T().db;
    const events = (await db.query<{ type: string; data: { item?: { key: string; kind: string } } }>("SELECT type, data FROM workspace_events WHERE type = 'check.upsert'")).rows;
    expect(events).toHaveLength(1);
    expect(events[0]?.data.item).toMatchObject({ key: `approval:${approval.id}`, kind: "approval" });
    expect(h.gateway.executed).toEqual([]);
    // ルールの allow で通った Intent（approved）は、再判定のあと実行する
    await db.query("UPDATE approvals SET status = 'approved', decided_by = $1, decided_at = now()", [g.userId]);
    await db.query("UPDATE action_intents SET status = 'approved'");
    await hooks.onIntentRecorded?.(ctx, { taskId: approval.taskId, intentId: approval.intentId, status: "approved" });
    expect(h.gateway.executed).toEqual([approval.intentId]);
  });
});

describe("オーナーのワークスペース（確認がないとき）", () => {
  it("承認がなければ一覧は空", async () => {
    const h = checkHarness(T().db);
    const res = await send(h.t, "POST", "/api/v1/entry", { body: { token: OWNER_TOKEN } });
    expect(res.status).toBe(200);
    const cookie = /ot_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const list = await send(h.t, "GET", "/api/v1/approvals", { cookie });
    expect(((await list.json()) as ApprovalListResponse).items).toEqual([]);
  });
});
