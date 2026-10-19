// SG-03 承認の出どころの照合（docs/design/17_security_governance.md）。app（ot_app）が action_intents などの列を書き換えただけの
// Intent を gateway が実行しないこと、正しい証拠のある Intent はこれまでどおり実行すること、影・リハーサルの振る舞いを変えないこと。
// 証拠のうち書き換えられる列（Intent・承認・判定・合格証）は一致を見るだけで、「起きたこと」と「順番」は追記だけの監査ログで見る
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAuditLog, type Db, type PolicyDecisionRow } from "@open-team/db";
import { fxAgent, fxHash, fxTask, openRoleDb, useTestDb } from "@open-team/db/testing";
import type { ProvenanceAuditEvent } from "@open-team/db/gateway";
import { computeMcpIntentHash, type JsonObject } from "@open-team/kernel";
import {
  BEANS_20,
  NOW,
  auditEvents,
  connectionRefused,
  decideApproval,
  gatewayEnv,
  insertCertificate,
  insertDecidedApproval,
  insertIntent,
  insertKernelEvidence,
  intentRow,
  rehearsalRows,
  revokeCertificate,
  seedShop,
  startGateway,
  startSimWorld,
  taskRow,
  taskWithToken,
  workspace,
  type FetchHook,
  type KernelEvidenceInput,
  type SimWorldHandle,
} from "./test-helpers.ts";
import { judgeProvenance, type ProvenanceInput } from "./provenance.ts";

const T = useTestDb();
let sim: SimWorldHandle;
beforeAll(async () => {
  sim = await startSimWorld();
});
afterAll(async () => {
  await sim.close();
});

const PLACE_ORDER = "mcp.supplier.place_order";
const POLICY = fxHash("policy");
const APPROVE = { decision: "approve", reasonCode: "approval_required", matchedRule: "autonomy.mcp_write" } as const;
const RULE_ALLOW = { decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]" } as const;

async function setup(o: { kind?: "owner" | "guest"; hook?: FetchHook } = {}) {
  const { db, url } = T();
  const ws = await workspace(db, o.kind ?? "owner");
  const demo = await sim.createDemoStore(ws.workspaceId);
  let armed = false;
  const hook: FetchHook | undefined = o.hook ? (req, real, init) => (armed ? o.hook!(req, real, init) : null) : undefined;
  const gw = startGateway(db, gatewayEnv(sim.url), hook ? { hook } : {});
  const shop = await seedShop(db, gw.client, ws, sim.url, { slugs: ["supplier"] });
  gw.sent.length = 0;
  armed = true;
  const task = await taskWithToken(db, ws, { status: "executing" });
  const supplier = shop.supplier!;
  const tool = supplier.tools.place_order!;
  /** 証拠なしの Intent（app が行を書き換えた・作った状態）。証拠は試験ごとに入れる */
  const bare = (extra: Partial<Parameters<typeof insertIntent>[2]> = {}) =>
    insertIntent(db, ws, { taskId: task.taskId, jobId: task.agent.jobId, connector: supplier, tool, args: BEANS_20, provenance: false, ...extra });
  /** edge が残す判定の記録（intent.proposed・判定の行・decision.made。approval なら承認待ちの行と approval.requested も） */
  const evidence = (intent: { intentId: string; intentHash: string }, k: Partial<KernelEvidenceInput> & Pick<KernelEvidenceInput, "decision" | "reasonCode" | "matchedRule">) =>
    insertKernelEvidence(db, ws, { taskId: task.taskId, intentId: intent.intentId, intentHash: intent.intentHash, policyHash: POLICY, action: PLACE_ORDER, args: BEANS_20, ...k });
  const orders = async () => (await sim.getState(ws.workspaceId, demo.id)).state.orders as Array<Record<string, any>>;
  const calls = () => gw.sent.filter((s) => s.rpc === "tools/call");
  /** ot_app（乗っ取られた app）のロールで書き換える */
  const asApp = async (fn: (app: Db) => Promise<unknown>): Promise<void> => {
    const app = await openRoleDb(url, "ot_app");
    try {
      await fn(app);
    } finally {
      await app.close();
    }
  };
  /** ot_app で監査ログを足す（追記はできる） */
  const appendAsApp = (eventType: string, payload: JsonObject, o2: { actorType?: "user" | "system" | "agent"; actorId?: string | null; taskId?: string | null } = {}) =>
    asApp((app) =>
      app.transaction((tx) =>
        appendAuditLog(tx, ws.workspaceId, { eventType, actorType: o2.actorType ?? "system", actorId: o2.actorId ?? "app", taskId: o2.taskId === undefined ? task.taskId : o2.taskId, payload }, NOW),
      ),
    );
  return { db, url, ws, gw, task, supplier, tool, bare, evidence, orders, calls, asApp, appendAsApp };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** approve の Intent と edge の判定の記録・承認待ちの承認（決定は試験ごと） */
async function pendingApprove(s: Setup, approval: KernelEvidenceInput["approval"] = true) {
  const intent = await s.bare(APPROVE);
  const k = await s.evidence(intent, { ...APPROVE, approval });
  return { ...intent, approvalId: k.approvalId! };
}

/** 人が正しく承認した approve の Intent */
async function approved(s: Setup) {
  const i = await pendingApprove(s);
  await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId });
  return i;
}

/** ルールで allow の Intent と、判定の記録（合格証は先に入れておく：発行 < 判定） */
async function ruleAllowed(s: Setup, k: Partial<KernelEvidenceInput> = {}) {
  const intent = await s.bare(RULE_ALLOW);
  await s.evidence(intent, { ...RULE_ALLOW, certificateValid: true, ...k });
  return intent;
}

const certifyPlaceOrder = (s: Setup, jobId = s.task.agent.jobId, toolHash: string = s.tool.toolHash) => insertCertificate(s.db, s.ws, jobId, [{ action: PLACE_ORDER, toolHash }]);

/** 実行されず、approval_provenance（detail）で終わったこと。判定の記録・監査ログ・error のログ・タスクの終わり方まで */
async function expectDenied(s: Setup, intentId: string, detail: string): Promise<void> {
  const before = s.calls().length;
  const ordersBefore = (await s.orders()).length;
  expect(await s.gw.client.executeIntent(intentId)).toEqual({ intentId, status: "failed", failReason: "precondition_failed", expiredReason: null });
  expect(s.calls()).toHaveLength(before);
  expect(await s.orders()).toHaveLength(ordersBefore);
  expect((await intentRow(s.db, intentId)).result).toEqual({ reasonCode: "approval_provenance", detail });
  const d = (
    await s.db.query<Record<string, any>>("SELECT * FROM policy_decisions WHERE intent_id = $1 AND subject->>'gate' = 'gateway' AND reason_code = 'approval_provenance'", [intentId])
  ).rows;
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({ subject_kind: "intent", decision: "deny", reason_code: "approval_provenance", matched_rule: `provenance.${detail}`, enforced: true });
  const audit = await auditEvents(s.db, s.ws.workspaceId);
  expect(audit.find((e) => e.event_type === "decision.made" && e.payload.intentId === intentId && e.payload.source === "gateway")!.payload).toMatchObject({
    decision: "deny",
    reasonCode: "approval_provenance",
  });
  expect(audit.filter((e) => e.event_type === "action.failed" && e.payload.intentId === intentId).at(-1)!.payload).toMatchObject({
    failReason: "precondition_failed",
    reasonCode: "approval_provenance",
    detail,
    shadow: false,
  });
  // 乗っ取りの兆候なので error の段で出す
  expect(s.gw.logs.records.some((r) => r.event === "gateway.approval_provenance" && r.severity === "ERROR")).toBe(true);
}

/** 実行して executed になったこと */
async function expectExecuted(s: Setup, intentId: string): Promise<void> {
  expect(await s.gw.client.executeIntent(intentId)).toEqual({ intentId, status: "executed", failReason: null, expiredReason: null });
}

describe("人の承認（approve）の出どころ（SG-03 の2）", () => {
  it("(a) 承認の行がないのに approved の Intent（列を1つ書き換えた）→ 実行せず approval_provenance（approval_missing）", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    await s.evidence(i, APPROVE);
    await expectDenied(s, i.intentId, "approval_missing");
    expect(await taskRow(s.db, s.task.taskId)).toMatchObject({ status: "failed", fail_reason: "action_failed" });
  });

  it("(b) 承認者でない人が decided_by（approver_ids を書き換えた）→ approver_not_allowed", async () => {
    const s = await setup();
    const i = await approved(s);
    await s.asApp((app) => app.query("UPDATE approvals SET approver_ids = $2 WHERE id = $1", [i.approvalId, [randomUUID()]]));
    await expectDenied(s, i.intentId, "approver_not_allowed");
  });

  it("(c) 期限のあとに決めた承認 → approval_after_expiry", async () => {
    const s = await setup();
    const i = await pendingApprove(s, { expiresAt: new Date(NOW.getTime() - 3600_000) });
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId });
    await expectDenied(s, i.intentId, "approval_after_expiry");
  });

  it("期限ちょうどに決めた承認も拒否（app の API-019 では期限ちょうどはもう決められない）", async () => {
    const s = await setup();
    const i = await pendingApprove(s, { expiresAt: NOW });
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId });
    await expectDenied(s, i.intentId, "approval_after_expiry");
  });

  it("期限のあとの決定の decided_at を書き換えて期限の前に見せても、approval.decided の時刻（追記だけ）で approval_after_expiry", async () => {
    const s = await setup();
    const i = await pendingApprove(s, { expiresAt: NOW });
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId });
    await s.asApp((app) => app.query("UPDATE approvals SET decided_at = $2 WHERE id = $1", [i.approvalId, new Date(NOW.getTime() - 60_000)]));
    await expectDenied(s, i.intentId, "approval_after_expiry");
  });

  it("承認の期限の列を延ばしても、approval.requested の期限と違えば approval_request_mismatch", async () => {
    const s = await setup();
    const i = await pendingApprove(s, { expiresAt: new Date(NOW.getTime() - 3600_000) });
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId });
    await s.asApp((app) => app.query("UPDATE approvals SET expires_at = $2 WHERE id = $1", [i.approvalId, new Date(NOW.getTime() + 3600_000)]));
    await expectDenied(s, i.intentId, "approval_request_mismatch");
  });

  it("(d) 正しい承認（承認者・期限の前・approval.decided の intentHash が同じ・判定 < 要求 < 決定）→ これまでどおり実行", async () => {
    const s = await setup();
    const i = await approved(s);
    await expectExecuted(s, i.intentId);
    expect(await s.orders()).toHaveLength(1);
    expect((await s.db.query("SELECT 1 FROM policy_decisions WHERE intent_id = $1 AND subject->>'gate' = 'gateway'", [i.intentId])).rows).toHaveLength(0);
    // 送り始めを監査ログに残す（再実行の照合の材料）
    const types = (await auditEvents(s.db, s.ws.workspaceId)).filter((e) => e.payload.intentId === i.intentId).map((e) => e.event_type);
    expect(types.slice(-2)).toEqual(["action.started", "action.executed"]);
  });

  it("承認の行が approved でない（rejected のまま Intent だけ approved）→ approval_not_approved", async () => {
    const s = await setup();
    const i = await pendingApprove(s);
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId, status: "rejected" });
    await expectDenied(s, i.intentId, "approval_not_approved");
  });

  it("【回帰】人が却下したあと、ot_app で承認の行を approved に・approve の approval.decided を追記 → 却下の記録が残るので approval_rejected", async () => {
    const s = await setup();
    const i = await pendingApprove(s);
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId, status: "rejected" });
    await s.asApp((app) => app.query("UPDATE approvals SET status = 'approved' WHERE id = $1", [i.approvalId]));
    await s.appendAsApp(
      "approval.decided",
      { approvalId: i.approvalId, intentId: i.intentId, taskId: s.task.taskId, decision: "approve", intentHash: i.intentHash },
      { actorType: "user", actorId: s.ws.userId },
    );
    await expectDenied(s, i.intentId, "approval_rejected");
  });

  it("承認の行を approved に書き換えただけ（approval.decided がない）→ approval_audit_missing", async () => {
    const s = await setup();
    const i = await pendingApprove(s);
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId, audit: false });
    await expectDenied(s, i.intentId, "approval_audit_missing");
  });

  it("approval.decided の行為者が人（decided_by）でない → approval_audit_missing", async () => {
    const s = await setup();
    const i = await pendingApprove(s);
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, approvalId: i.approvalId, audit: false });
    await s.appendAsApp("approval.decided", { approvalId: i.approvalId, intentId: i.intentId, taskId: s.task.taskId, decision: "approve", intentHash: i.intentHash }, { actorType: "system", actorId: "app" });
    await expectDenied(s, i.intentId, "approval_audit_missing");
  });

  it("approval.decided が2件（決定は1回だけ）→ approval_audit_conflict", async () => {
    const s = await setup();
    const i = await approved(s);
    await s.appendAsApp(
      "approval.decided",
      { approvalId: i.approvalId, intentId: i.intentId, taskId: s.task.taskId, decision: "approve", intentHash: i.intentHash },
      { actorType: "user", actorId: s.ws.userId },
    );
    await expectDenied(s, i.intentId, "approval_audit_conflict");
  });

  it("承認のあとに Intent の中身を差し替えた（人が承認した intentHash と違う）→ approval_hash_mismatch", async () => {
    const s = await setup();
    const i = await pendingApprove(s);
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: "e".repeat(64), approvalId: i.approvalId });
    await expectDenied(s, i.intentId, "approval_hash_mismatch");
  });

  it("承認の要求の記録（approval.requested）がない承認 → approval_request_missing（ゲストでなければ例外にしない）", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    await s.evidence(i, APPROVE);
    await insertDecidedApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash });
    await expectDenied(s, i.intentId, "approval_request_missing");
  });

  it("判定の前に決めた承認（seq の順が 判定 < 決定 でない）→ approval_order_invalid", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    const approvalId = await insertDecidedApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash, expiresAt: new Date(NOW.getTime() + 24 * 3600_000) });
    // 決定 → 要求 → 判定 の順に追記されている（あとから要求と判定の記録を足した形。監査ログは前に割り込めない）
    await s.appendAsApp("approval.requested", { taskId: s.task.taskId, intentId: i.intentId, approvalId, expiresAt: new Date(NOW.getTime() + 24 * 3600_000).toISOString(), expiryCause: "ttl" });
    await s.evidence(i, APPROVE);
    await expectDenied(s, i.intentId, "approval_order_invalid");
  });

  it("decided_at を承認の作成より前に書き換えた → approval_time_invalid", async () => {
    const s = await setup();
    const i = await approved(s);
    await s.asApp((app) => app.query("UPDATE approvals SET decided_at = created_at - interval '1 hour' WHERE id = $1", [i.approvalId]));
    await expectDenied(s, i.intentId, "approval_time_invalid");
  });

  it("承認の行を別のタスクに付け替えた → approval_mismatch", async () => {
    const s = await setup();
    const i = await approved(s);
    const other = await fxTask(s.db, s.ws, s.task.agent, { status: "running" });
    await s.asApp((app) => app.query("UPDATE approvals SET task_id = $2 WHERE id = $1", [i.approvalId, other.taskId]));
    await expectDenied(s, i.intentId, "approval_mismatch");
  });
});

describe("Kernel の判定（SG-03 の1）", () => {
  it("判定の行が deny の Intent を approve・approved に書き換え、承認の行も足した → decision_mismatch", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    await s.evidence(i, { decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.llmWrite" });
    await insertDecidedApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash });
    await expectDenied(s, i.intentId, "decision_mismatch");
  });

  it("deny の Intent の status だけを approved に書き換えた → decision_not_executable", async () => {
    const s = await setup();
    const i = await s.bare({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.llmWrite" });
    await s.evidence(i, { decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.llmWrite" });
    await expectDenied(s, i.intentId, "decision_not_executable");
  });

  it("判定の行の reason_code が Intent と違う → decision_mismatch", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    await s.evidence(i, { ...APPROVE, reasonCode: "guard_exceeded", approval: true });
    await expectDenied(s, i.intentId, "decision_mismatch");
  });

  it("判定の行の matched_rule が Intent と違う → decision_mismatch", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    await s.evidence(i, { ...APPROVE, matchedRule: "guards[0]", approval: true });
    await expectDenied(s, i.intentId, "decision_mismatch");
  });

  it("判定の行の引数と Intent の引数が違う（判定のあとに payload を差し替えた）→ decision_mismatch", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    await s.evidence(i, { ...APPROVE, args: { ...BEANS_20, items: [{ sku: "BEAN-HOUSE", quantity: 1, unit_price: 780 }] }, approval: true });
    await expectDenied(s, i.intentId, "decision_mismatch");
  });

  it("gateway 自身の拒否の記録（subject.gate = 'gateway'）は Kernel の判定として数えない → decision_missing", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    await s.db.query(
      `INSERT INTO policy_decisions (workspace_id, task_id, intent_id, subject_kind, action_type, subject, counters, flags, decision, reason_code,
                                     matched_rule, enforced, inputs_hash, kernel_version, created_at)
       VALUES ($1, $2, $3, 'intent', 'mcp_write', $4, '{}', '{}', 'approve', 'approval_required', 'autonomy.mcp_write', true, $5, '0.1.0', $6)`,
      [s.ws.workspaceId, s.task.taskId, i.intentId, { gate: "gateway", action: PLACE_ORDER, args: BEANS_20 }, "a".repeat(64), NOW],
    );
    await expectDenied(s, i.intentId, "decision_missing");
  });

  it("判定の行だけあって decision.made がない（行を作って入れた）→ decision_audit_missing", async () => {
    const s = await setup();
    const i = await s.bare(APPROVE);
    await s.evidence(i, { ...APPROVE, audit: false });
    await expectDenied(s, i.intentId, "decision_audit_missing");
  });

  it("【回帰】承認待ちの Intent を、Intent の行と判定の行の2文の UPDATE で「ルールの allow」に書き換えた → 元の decision.made と食い違うので decision_audit_mismatch", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    const i = await pendingApprove(s);
    await s.db.query("UPDATE action_intents SET status = 'pending_approval', expires_at = $2 WHERE id = $1", [i.intentId, new Date(NOW.getTime() + 3600_000)]);
    await s.asApp(async (app) => {
      await app.query("UPDATE action_intents SET status = 'approved', decision = 'allow', reason_code = 'rule_matched', matched_rule = 'rules.items[0]' WHERE id = $1", [i.intentId]);
      await app.query(
        `UPDATE policy_decisions SET decision = 'allow', reason_code = 'rule_matched', matched_rule = 'rules.items[0]', flags = flags || '{"certificateValid":true}'::jsonb
          WHERE intent_id = $1`,
        [i.intentId],
      );
    });
    await expectDenied(s, i.intentId, "decision_audit_mismatch");
  });

  it("【回帰】さらに allow の decision.made を追記しても、元の approve の decision.made は消せないので decision_audit_mismatch", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    const i = await pendingApprove(s);
    await s.db.query("UPDATE action_intents SET status = 'pending_approval', expires_at = $2 WHERE id = $1", [i.intentId, new Date(NOW.getTime() + 3600_000)]);
    const row = (await s.db.query<{ inputs_hash: string }>("SELECT inputs_hash FROM policy_decisions WHERE intent_id = $1", [i.intentId])).rows[0]!;
    await s.asApp(async (app) => {
      await app.query("UPDATE action_intents SET status = 'approved', decision = 'allow', reason_code = 'rule_matched', matched_rule = 'rules.items[0]' WHERE id = $1", [i.intentId]);
      await app.query(
        `UPDATE policy_decisions SET decision = 'allow', reason_code = 'rule_matched', matched_rule = 'rules.items[0]', flags = flags || '{"certificateValid":true}'::jsonb
          WHERE intent_id = $1`,
        [i.intentId],
      );
    });
    await s.appendAsApp(
      "decision.made",
      { taskId: s.task.taskId, subjectKind: "tool_call", decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]", inputsHash: row.inputs_hash, enforced: true, intentId: i.intentId },
      { actorType: "agent", actorId: null },
    );
    await expectDenied(s, i.intentId, "decision_audit_mismatch");
  });

  it("引数を差し替え intentHash も判定の行も合わせ直した → 提案の記録（intent.proposed の intentHash）と食い違うので proposal_audit_mismatch", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    const i = await ruleAllowed(s);
    const swapped: JsonObject = { ...BEANS_20, items: [{ sku: "BEAN-HOUSE", quantity: 200, unit_price: 780 }] };
    const hash = computeMcpIntentHash({ connectorId: s.supplier.id, tool: "place_order", arguments: swapped, toolHash: s.tool.toolHash, effectivePolicyHash: POLICY });
    await s.asApp(async (app) => {
      await app.query("UPDATE action_intents SET payload = jsonb_set(payload, '{arguments}', $2::jsonb), intent_hash = $3 WHERE id = $1", [i.intentId, swapped, hash]);
      await app.query("UPDATE policy_decisions SET subject = jsonb_set(subject, '{args}', $2::jsonb) WHERE intent_id = $1", [i.intentId, swapped]);
    });
    await expectDenied(s, i.intentId, "proposal_audit_mismatch");
  });

  it("試し実行（リハーサルでない）の Intent は simulated にしかならない（BR-24）→ approved にしても dry_run_intent", async () => {
    const s = await setup();
    await s.db.query("UPDATE tasks SET is_dry_run = true, trigger_type = 'dry_run' WHERE id = $1", [s.task.taskId]);
    const i = await approved(s);
    await expectDenied(s, i.intentId, "dry_run_intent");
  });

  it("本番で enforced = false（影の印だけ書き換えた）→ not_enforced", async () => {
    const s = await setup();
    const i = await s.bare({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.llmWrite", enforced: false });
    await expectDenied(s, i.intentId, "not_enforced");
  });
});

describe("実行と失効の履歴（監査ログ。再実行・復活の防止）", () => {
  it("【回帰】実行済み（ルールの allow）を ot_app で approved に戻す → already_finished。3回くり返しても1回しか書かない", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    const i = await ruleAllowed(s);
    await expectExecuted(s, i.intentId);
    for (let n = 0; n < 3; n++) {
      await s.asApp((app) => app.query("UPDATE action_intents SET status = 'approved', result = NULL, fail_reason = NULL WHERE id = $1", [i.intentId]));
      await s.db.query("UPDATE tasks SET status = 'executing', finished_at = NULL, fail_reason = NULL, status_detail = NULL WHERE id = $1", [s.task.taskId]);
      if (n === 0) {
        // タスクの終了の記録もあるので、Intent の終わりの記録が先に効く
        await expectDenied(s, i.intentId, "already_finished");
      } else {
        expect((await s.gw.client.executeIntent(i.intentId)).failReason).toBe("precondition_failed");
      }
    }
    expect(await s.orders()).toHaveLength(1);
  });

  it("【回帰】実行済み（人の承認）を approved に戻す → already_finished", async () => {
    const s = await setup();
    const i = await approved(s);
    await expectExecuted(s, i.intentId);
    await s.asApp((app) => app.query("UPDATE action_intents SET status = 'approved' WHERE id = $1", [i.intentId]));
    await s.db.query("UPDATE tasks SET status = 'executing', finished_at = NULL, fail_reason = NULL, status_detail = NULL WHERE id = $1", [s.task.taskId]);
    await expectDenied(s, i.intentId, "already_finished");
    expect(await s.orders()).toHaveLength(1);
  });

  it("【回帰】ポリシーの変更で失効（intent.expired・policy_changed：recheck.ts）した Intent を戻す → already_finished", async () => {
    const s = await setup();
    const i = await approved(s);
    await s.db.query("UPDATE action_intents SET status = 'expired', expire_reason = 'policy_changed' WHERE id = $1", [i.intentId]);
    await s.appendAsApp("intent.expired", { taskId: s.task.taskId, intentId: i.intentId, expireReason: "policy_changed", reasonCode: "not_granted" });
    await s.asApp((app) => app.query("UPDATE action_intents SET status = 'approved', expire_reason = NULL WHERE id = $1", [i.intentId]));
    await expectDenied(s, i.intentId, "already_finished");
  });

  it("【回帰】gateway が failed にした Intent を戻す → already_finished", async () => {
    const s = await setup();
    const i = await approved(s);
    await s.db.query("UPDATE connectors SET enabled = false WHERE id = $1", [s.supplier.id]);
    expect((await s.gw.client.executeIntent(i.intentId)).failReason).toBe("precondition_failed");
    await s.db.query("UPDATE connectors SET enabled = true WHERE id = $1", [s.supplier.id]);
    await s.asApp((app) => app.query("UPDATE action_intents SET status = 'approved', fail_reason = NULL, result = NULL WHERE id = $1", [i.intentId]));
    await s.db.query("UPDATE tasks SET status = 'executing', finished_at = NULL, fail_reason = NULL, status_detail = NULL WHERE id = $1", [s.task.taskId]);
    await expectDenied(s, i.intentId, "already_finished");
  });

  it("承認の期限切れ（approval.expired）・無効化（approval.invalidated）の記録がある承認を戻す → already_finished", async () => {
    for (const eventType of ["approval.expired", "approval.invalidated"]) {
      const s = await setup({ kind: "guest" });
      const i = await approved(s);
      await s.appendAsApp(eventType, { approvalId: i.approvalId, intentId: i.intentId });
      await expectDenied(s, i.intentId, "already_finished");
    }
  });

  it("送り始め（action.started）のあと送信中に止まった Intent を approved に戻す（戻しの記録がない）→ execution_replayed", async () => {
    const s = await setup();
    const i = await approved(s);
    await s.appendAsApp("action.started", { taskId: s.task.taskId, intentId: i.intentId, action: PLACE_ORDER, attempt: 1 }, { actorId: "gateway" });
    await expectDenied(s, i.intentId, "execution_replayed");
  });

  it("送信前の失敗のやり直し（executing → approved）は正当：action.started 2件と action.presend_retry 1件で実行できる", async () => {
    let refused = 0;
    const s = await setup({ hook: (req) => (req.rpc === "tools/call" && refused++ === 0 ? connectionRefused() : null) });
    const i = await approved(s);
    await expectExecuted(s, i.intentId);
    const mine = (await auditEvents(s.db, s.ws.workspaceId)).filter((e) => e.payload.intentId === i.intentId).map((e) => e.event_type);
    expect(mine.filter((t) => t === "action.started")).toHaveLength(2);
    expect(mine.filter((t) => t === "action.presend_retry")).toHaveLength(1);
    expect(await s.orders()).toHaveLength(1);
  });

  it("タスクが終了状態になった記録（task.status_changed）があるのに列を戻した → task_ended", async () => {
    const s = await setup();
    const i = await approved(s);
    await s.appendAsApp("task.status_changed", { taskId: s.task.taskId, from: "executing", to: "cancelled" });
    await expectDenied(s, i.intentId, "task_ended");
  });

  it("判定のあとの Kill Switch の発動（未実行の Intent は一括で失効）→ kill_switch_expired。判定の前の発動は関係ない", async () => {
    const s = await setup();
    const before = await s.bare(APPROVE);
    await s.appendAsApp("killswitch.engaged", { reason: "試験" }, { taskId: null });
    const k = await s.evidence(before, { ...APPROVE, approval: true });
    await decideApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: before.intentId, intentHash: before.intentHash, approvalId: k.approvalId! });
    await expectExecuted(s, before.intentId);

    const s2 = await setup({ kind: "guest" });
    const i = await approved(s2);
    await s2.appendAsApp("killswitch.engaged", { reason: "試験" }, { taskId: null });
    await expectDenied(s2, i.intentId, "kill_switch_expired");
  });
});

describe("ルールで allow の出どころ（SG-03 の3）", () => {
  it("(e) 判定の行が allow（rule_matched）・合格証が有効と記録・判定より前に発行された合格証がこのツールを含む → 実行（承認の行は要らない）", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    const i = await ruleAllowed(s);
    await expectExecuted(s, i.intentId);
    expect(await s.orders()).toHaveLength(1);
  });

  it("(f) 判定の行がない allow（decision を allow に書き換えた）→ decision_missing", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    const i = await s.bare(RULE_ALLOW);
    await expectDenied(s, i.intentId, "decision_missing");
  });

  it("判定の入力に合格証が有効と残っていない → certificate_flag_missing", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    const i = await ruleAllowed(s, { certificateValid: false });
    await expectDenied(s, i.intentId, "certificate_flag_missing");
  });

  it("allow でも rule_matched でない（autonomy などに書き換えた）→ rule_not_matched", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    const i = await s.bare({ decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.mcp_write" });
    await s.evidence(i, { decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.mcp_write", certificateValid: true });
    await expectDenied(s, i.intentId, "rule_not_matched");
  });

  it("合格証の行がない → certificate_missing", async () => {
    const s = await setup();
    const i = await ruleAllowed(s);
    await expectDenied(s, i.intentId, "certificate_missing");
  });

  it("判定の前に失効した合格証（rehearsal.certificate_revoked）→ certificate_missing", async () => {
    const s = await setup();
    const cert = await certifyPlaceOrder(s);
    await revokeCertificate(s.db, s.ws, cert, s.task.agent.jobId);
    const i = await ruleAllowed(s);
    await expectDenied(s, i.intentId, "certificate_missing");
  });

  it("判定の前に同じ仕事の次の合格証が出て superseded（このツールを含まない）→ certificate_missing", async () => {
    const s = await setup();
    await certifyPlaceOrder(s);
    await insertCertificate(s.db, s.ws, s.task.agent.jobId, [{ action: "mcp.store.get_inventory", toolHash: s.tool.toolHash }]);
    const i = await ruleAllowed(s);
    await expectDenied(s, i.intentId, "certificate_missing");
  });

  it("判定のあとに失効した合格証（判定の時点では有効）→ 実行する（その時点の監査ログの順を見る）", async () => {
    const s = await setup();
    const cert = await certifyPlaceOrder(s);
    const i = await ruleAllowed(s);
    await revokeCertificate(s.db, s.ws, cert, s.task.agent.jobId);
    await expectExecuted(s, i.intentId);
  });

  it("合格証の tool_hash がこのツールと違う → certificate_missing", async () => {
    const s = await setup();
    await certifyPlaceOrder(s, s.task.agent.jobId, `sha256:${"9".repeat(64)}`);
    const i = await ruleAllowed(s);
    await expectDenied(s, i.intentId, "certificate_missing");
  });

  it("別の仕事の合格証しかない → certificate_missing", async () => {
    const s = await setup();
    const other = await fxAgent(s.db, s.ws);
    await certifyPlaceOrder(s, other.jobId);
    const i = await ruleAllowed(s);
    await expectDenied(s, i.intentId, "certificate_missing");
  });

  it("【回帰】判定のあとに作った合格証の issued_at を過去に書き換えても、発行の監査ログが判定より後なので certificate_missing", async () => {
    const s = await setup();
    const i = await ruleAllowed(s);
    const cert = await certifyPlaceOrder(s);
    await s.asApp((app) => app.query("UPDATE rehearsal_certificates SET issued_at = $2 WHERE id = $1", [cert, new Date(NOW.getTime() - 30 * 24 * 3600_000)]));
    await expectDenied(s, i.intentId, "certificate_missing");
  });

  it("【回帰】判定のあとに作った合格証の audit_seq を判定より前の seq に書き換えても、その seq の監査ログが発行の記録でない → certificate_missing", async () => {
    const s = await setup();
    const i = await ruleAllowed(s);
    const cert = await certifyPlaceOrder(s);
    await s.asApp((app) => app.query("UPDATE rehearsal_certificates SET audit_seq = 1 WHERE id = $1", [cert]));
    await expectDenied(s, i.intentId, "certificate_missing");
  });

  it("【回帰】失効の列（revoked_at）を消しても、失効の監査ログは消せない → certificate_missing", async () => {
    const s = await setup();
    const cert = await certifyPlaceOrder(s);
    await revokeCertificate(s.db, s.ws, cert, s.task.agent.jobId);
    await s.asApp((app) => app.query("UPDATE rehearsal_certificates SET revoked_at = NULL, revoke_reason = NULL WHERE id = $1", [cert]));
    const i = await ruleAllowed(s);
    await expectDenied(s, i.intentId, "certificate_missing");
  });

  it("【回帰】判定のあとに作った合格証の audit_seq を、同じ仕事の前の合格証の発行の seq に付け替えても、ハッシュが違う → certificate_missing", async () => {
    const s = await setup();
    // 前の合格証（このツールを含まない）の発行 → 判定 → 新しい合格証（このツールを含む）の発行
    const old = await insertCertificate(s.db, s.ws, s.task.agent.jobId, [{ action: "mcp.store.get_inventory", toolHash: s.tool.toolHash }]);
    const oldSeq = (await s.db.query<{ audit_seq: number }>("SELECT audit_seq FROM rehearsal_certificates WHERE id = $1", [old])).rows[0]!.audit_seq;
    const i = await ruleAllowed(s);
    const cert = await certifyPlaceOrder(s);
    await s.asApp((app) => app.query("UPDATE rehearsal_certificates SET audit_seq = $2 WHERE id = $1", [cert, oldSeq]));
    await expectDenied(s, i.intentId, "certificate_missing");
  });
});

describe("照合しないもの・例外（影・リハーサル・ゲストのデモ）", () => {
  it("影の走行：判定の記録も承認の行もない deny の Intent も、これまでどおり sim-world に実行する（BR-67③）", async () => {
    const s = await setup();
    const rows = await rehearsalRows(s.db, s.ws, s.task.agent, "shadow");
    await sim.createExecution({ workspaceId: s.ws.workspaceId, rehearsalRunId: rows.runId, executionId: rows.executionId, variant: "shadow", faults: [] });
    const shadow = await taskWithToken(s.db, s.ws, { agent: s.task.agent, rehearsalRunId: rows.runId, rehearsalScenarioId: rows.scenarioId, shadow: true, simExecutionId: rows.executionId, status: "executing" });
    const { intentId } = await insertIntent(s.db, s.ws, {
      taskId: shadow.taskId,
      jobId: s.task.agent.jobId,
      connector: s.supplier,
      tool: s.tool,
      args: BEANS_20,
      decision: "deny",
      reasonCode: "not_granted",
      enforced: false,
      provenance: false,
    });
    expect((await s.gw.client.executeIntent(intentId)).status).toBe("executed");
    expect((await sim.getState(s.ws.workspaceId, rows.executionId)).state.orders).toHaveLength(1);
  });

  it("リハーサルの承認した分岐の写し（承認の行・判定の記録なしの approved）→ これまでどおり sim-world に実行する", async () => {
    const s = await setup();
    const rows = await rehearsalRows(s.db, s.ws, s.task.agent, "governed");
    await sim.createExecution({ workspaceId: s.ws.workspaceId, rehearsalRunId: rows.runId, executionId: rows.executionId, variant: "governed", faults: [] });
    const task = await taskWithToken(s.db, s.ws, { agent: s.task.agent, rehearsalRunId: rows.runId, rehearsalScenarioId: rows.scenarioId, simExecutionId: rows.executionId, status: "executing" });
    const { intentId } = await insertIntent(s.db, s.ws, { taskId: task.taskId, jobId: s.task.agent.jobId, connector: s.supplier, tool: s.tool, args: BEANS_20, provenance: false });
    expect((await s.gw.client.executeIntent(intentId)).status).toBe("executed");
  });

  it("ゲストのデモ（判定の記録が何もない approve を sim-world へ）：人の承認があれば実行", async () => {
    const s = await setup({ kind: "guest" });
    const seeded = await s.bare(APPROVE);
    await insertDecidedApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: seeded.intentId, intentHash: seeded.intentHash });
    await expectExecuted(s, seeded.intentId);
  });

  it("ゲストのデモでも人の承認がなければ approval_missing", async () => {
    const s = await setup({ kind: "guest" });
    const seeded = await s.bare(APPROVE);
    await expectDenied(s, seeded.intentId, "approval_missing");
  });

  it("ゲストでも allow は例外にしない → decision_missing", async () => {
    const s = await setup({ kind: "guest" });
    await certifyPlaceOrder(s);
    const allow = await s.bare(RULE_ALLOW);
    await expectDenied(s, allow.intentId, "decision_missing");
  });

  it("ゲストで判定の行だけを消しても、decision.made が残るので例外にならない → decision_missing", async () => {
    const s = await setup({ kind: "guest" });
    const i = await approved(s);
    await s.asApp((app) => app.query("DELETE FROM policy_decisions WHERE intent_id = $1", [i.intentId]));
    await expectDenied(s, i.intentId, "decision_missing");
  });

  it("ゲストで判定の行があるのに監査ログ（decision.made など）がない → 例外にせず decision_audit_missing", async () => {
    const s = await setup({ kind: "guest" });
    const i = await s.bare(APPROVE);
    await s.evidence(i, { ...APPROVE, audit: false });
    await insertDecidedApproval(s.db, s.ws, { taskId: s.task.taskId, intentId: i.intentId, intentHash: i.intentHash });
    await expectDenied(s, i.intentId, "decision_audit_missing");
  });
});

describe("judgeProvenance（純粋な照合）", () => {
  const intent: ProvenanceInput["intent"] = {
    id: randomUUID(),
    task_id: randomUUID(),
    job_id: randomUUID(),
    action: PLACE_ORDER,
    payload: { connectorId: randomUUID(), tool: "place_order", arguments: BEANS_20, toolHash: `sha256:${"1".repeat(64)}` } as never,
    tool_hash: `sha256:${"1".repeat(64)}` as never,
    decision: "approve",
    reason_code: "approval_required",
    matched_rule: "autonomy.mcp_write",
    enforced: true,
    intent_hash: "f".repeat(64) as never,
    policy_hash: POLICY as never,
  };
  const row = (o: Partial<PolicyDecisionRow> = {}): PolicyDecisionRow =>
    ({
      id: randomUUID(),
      workspace_id: randomUUID(),
      task_id: intent.task_id,
      intent_id: intent.id,
      subject_kind: "tool_call",
      action_type: "mcp_write",
      // 引数のキーの順が違っても同じ（正規形 JSON で比べる）
      subject: { action: PLACE_ORDER, args: { items: BEANS_20.items, supplier_id: BEANS_20.supplier_id }, call: { intentId: intent.id } },
      counters: {},
      flags: {},
      taint: { tainted: false, sources: [] },
      decision: "approve",
      reason_code: "approval_required",
      matched_rule: "autonomy.mcp_write",
      detail: null,
      enforced: true,
      inputs_hash: "0".repeat(64),
      kernel_version: "0.1.0",
      created_at: NOW,
      ...o,
    }) as PolicyDecisionRow;
  const ev = (seq: number, event_type: string, payload: JsonObject): ProvenanceAuditEvent => ({ seq, occurred_at: NOW, event_type, actor_type: "agent", actor_id: null, payload });
  const kernelAudits = [
    ev(10, "intent.proposed", { intentId: intent.id, action: PLACE_ORDER, decision: "approve", reasonCode: "approval_required", matchedRule: "autonomy.mcp_write", intentHash: intent.intent_hash, policyHash: POLICY, enforced: true }),
    ev(11, "decision.made", { intentId: intent.id, subjectKind: "tool_call", decision: "approve", reasonCode: "approval_required", matchedRule: "autonomy.mcp_write", inputsHash: "0".repeat(64), enforced: true }),
  ];
  const live = { is_dry_run: false, rehearsal_run_id: null, shadow: false };
  const empty = { decisions: [], approval: null, taskAudits: [], killSwitchSeqs: [], certificates: [], certificateAudits: [] };

  it("影・リハーサルのタスクは照合の対象外（checked = false）", () => {
    expect(judgeProvenance({ task: { is_dry_run: true, rehearsal_run_id: randomUUID(), shadow: true }, intent, guestSimWrite: false }, empty)).toEqual({ ok: true, checked: false });
    expect(judgeProvenance({ task: { is_dry_run: true, rehearsal_run_id: randomUUID(), shadow: false }, intent, guestSimWrite: false }, empty)).toEqual({ ok: true, checked: false });
  });

  it("判定の行の Intent の ID・操作・効かせたか・宛先が違えば一致しない（decision_mismatch）", () => {
    for (const bad of [
      row({ subject: { action: PLACE_ORDER, args: BEANS_20, call: { intentId: randomUUID() } } }),
      row({ action_type: "mcp_read" }),
      row({ enforced: false }),
      row({ subject: { action: "mcp.supplier.cancel_order", args: BEANS_20, call: { intentId: intent.id } } }),
    ]) {
      expect(judgeProvenance({ task: live, intent, guestSimWrite: false }, { ...empty, decisions: [bad], taskAudits: kernelAudits })).toEqual({ ok: false, detail: "decision_mismatch" });
    }
    // 一致する行と記録があれば、P-1 を通って承認の照合へ
    expect(judgeProvenance({ task: live, intent, guestSimWrite: false }, { ...empty, decisions: [row()], taskAudits: kernelAudits })).toEqual({ ok: false, detail: "approval_missing" });
  });

  it("decision.made の inputsHash・subjectKind が判定の行と違う → decision_audit_mismatch。intent.proposed がなければ proposal_audit_missing", () => {
    const [proposed, made] = kernelAudits as [ProvenanceAuditEvent, ProvenanceAuditEvent];
    for (const p of [{ inputsHash: "1".repeat(64) }, { subjectKind: "intent" }, { enforced: false }] as JsonObject[]) {
      const bad = { ...made, payload: { ...made.payload, ...p } };
      expect(judgeProvenance({ task: live, intent, guestSimWrite: false }, { ...empty, decisions: [row()], taskAudits: [proposed, bad] })).toEqual({ ok: false, detail: "decision_audit_mismatch" });
    }
    expect(judgeProvenance({ task: live, intent, guestSimWrite: false }, { ...empty, decisions: [row()], taskAudits: [made] })).toEqual({ ok: false, detail: "proposal_audit_missing" });
  });

  it("合格証は Intent の仕事のものだけ（別の仕事の合格証と発行の記録が混ざっても数えない）", () => {
    const allowIntent = { ...intent, decision: "allow" as const, reason_code: "rule_matched", matched_rule: "rules.items[0]" };
    const allowRow = row({ decision: "allow", reason_code: "rule_matched", matched_rule: "rules.items[0]", flags: { certificateValid: true } });
    const audits = [
      ev(10, "intent.proposed", { ...kernelAudits[0]!.payload, decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]" }),
      ev(11, "decision.made", { ...kernelAudits[1]!.payload, decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]" }),
    ];
    const cert = (jobId: string) =>
      ({ id: randomUUID(), job_id: jobId, tool_hashes: [{ action: PLACE_ORDER, toolHash: intent.tool_hash }], certificate_hash: "c".repeat(64), audit_seq: 5 }) as never;
    const issued = (jobId: string) => ev(5, "rehearsal.certificate_issued", { jobId, certificateHash: "c".repeat(64) });
    const input = { task: live, intent: allowIntent, guestSimWrite: false };
    const other = randomUUID();
    expect(judgeProvenance(input, { ...empty, decisions: [allowRow], taskAudits: audits, certificates: [cert(other)], certificateAudits: [issued(other)] })).toEqual({
      ok: false,
      detail: "certificate_missing",
    });
    expect(judgeProvenance(input, { ...empty, decisions: [allowRow], taskAudits: audits, certificates: [cert(intent.job_id)], certificateAudits: [issued(intent.job_id)] })).toEqual({
      ok: true,
      checked: true,
    });
  });
});
