// SG-03 承認の出どころの照合（docs/design/17_security_governance.md）。app（ot_app）が action_intents などの列を書き換えただけの
// Intent を gateway が実行しないこと、正しい証拠のある Intent はこれまでどおり実行すること。
// 証拠のうち書き換えられる列（Intent・承認・判定）は一致を見るだけで、「起きたこと」と「順番」は追記だけの監査ログで見る
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAuditLog, type Db, type PolicyDecisionRow } from "@open-team/db";
import { fxHash, fxTask, openRoleDb, useTestDb } from "@open-team/db/testing";
import type { ProvenanceAuditEvent } from "@open-team/db/gateway";
import { computeMcpIntentHash, type JsonObject } from "@open-team/kernel";
import {
  BEANS_20,
  NOW,
  auditEvents,
  connectionRefused,
  decideApproval,
  gatewayEnv,
  insertIntent,
  insertKernelEvidence,
  intentRow,
  seedConnectors,
  startFakeMcp,
  startGateway,
  taskRow,
  taskWithToken,
  workspace,
  type DecideApprovalInput,
  type FakeMcpHandle,
  type FetchHook,
  type KernelEvidenceInput,
  type SeededConnector,
} from "./test-helpers.ts";
import { judgeProvenance, type ProvenanceInput } from "./provenance.ts";

const T = useTestDb();
let fake: FakeMcpHandle;
beforeAll(async () => {
  fake = await startFakeMcp();
});
afterAll(async () => {
  await fake.close();
});

const PLACE_ORDER = "mcp.supplier.place_order";
const POLICY = fxHash("policy");
const APPROVE = { decision: "approve", reasonCode: "approval_required", matchedRule: "autonomy.mcp_write" } as const;
const RULE_ALLOW = { decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]" } as const;

/** reuse を渡すと、同じワークスペース・gateway・コネクタで新しいタスクを作る（オーナーのワークスペースは DB に1つだけ） */
async function setup(o: { hook?: FetchHook; reuse?: { db: Db; url: string; ws: Awaited<ReturnType<typeof workspace>>; gw: ReturnType<typeof startGateway>; supplier: SeededConnector } } = {}) {
  const { db, url } = o.reuse ?? T();
  const ws = o.reuse?.ws ?? (await workspace(db));
  let armed = false;
  const hook: FetchHook | undefined = o.hook ? (req, real, init) => (armed ? o.hook!(req, real, init) : null) : undefined;
  const gw = o.reuse?.gw ?? startGateway(db, gatewayEnv(fake.url), hook ? { hook } : {});
  const supplier = o.reuse?.supplier ?? (await seedConnectors(db, gw.client, ws, fake.url, { slugs: ["supplier"] })).supplier!;
  gw.sent.length = 0;
  armed = true;
  const task = await taskWithToken(db, ws, { status: "executing" });
  const tool = supplier.tools.place_order!;
  /** 証拠なしの Intent（app が行を書き換えた・作った状態）。証拠は試験ごとに入れる */
  const bare = (extra: Partial<Parameters<typeof insertIntent>[2]> = {}) =>
    insertIntent(db, ws, { taskId: task.taskId, jobId: task.agent.jobId, connector: supplier, tool, args: BEANS_20, provenance: false, ...extra });
  /** edge が残す判定の記録（intent.proposed・判定の行・decision.made。approval なら承認待ちの行と approval.requested も） */
  const evidence = (intent: { intentId: string; intentHash: string }, k: Partial<KernelEvidenceInput> & Pick<KernelEvidenceInput, "decision" | "reasonCode" | "matchedRule">) =>
    insertKernelEvidence(db, ws, { taskId: task.taskId, intentId: intent.intentId, intentHash: intent.intentHash, policyHash: POLICY, action: PLACE_ORDER, args: BEANS_20, ...k });
  /** この試験で偽のサーバーが受けた発注（tools/call place_order。ファイルの中の試験は順に動く） */
  const callsFrom = fake.calls.length;
  const orders = async () => fake.calls.slice(callsFrom).filter((c) => c.tool === "place_order");
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

/** 判定の記録のない承認：承認の行を作って人が決める（承認の要求・判定の記録はない） */
async function insertDecidedApproval(
  db: Db,
  ws: Setup["ws"],
  a: Omit<DecideApprovalInput, "approvalId"> & { expiresAt?: Date },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO approvals (workspace_id, task_id, intent_id, status, risk_level, risk_score, approver_ids, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', 'medium', 3, $4, $5, $6, $6) RETURNING id`,
    [ws.workspaceId, a.taskId, a.intentId, [ws.userId], a.expiresAt ?? new Date(NOW.getTime() + 24 * 3600_000), new Date(NOW.getTime() - 120_000)],
  );
  const approvalId = r.rows[0]!.id;
  await decideApproval(db, ws, { ...a, approvalId });
  return approvalId;
}

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

/** ルールで allow の Intent と、判定の記録 */
async function ruleAllowed(s: Setup, k: Partial<KernelEvidenceInput> = {}) {
  const intent = await s.bare(RULE_ALLOW);
  await s.evidence(intent, { ...RULE_ALLOW, ...k });
  return intent;
}

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

  it("承認の要求の記録（approval.requested）がない承認 → approval_request_missing", async () => {
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
    const i = await pendingApprove(s);
    await s.db.query("UPDATE action_intents SET status = 'pending_approval', expires_at = $2 WHERE id = $1", [i.intentId, new Date(NOW.getTime() + 3600_000)]);
    await s.asApp(async (app) => {
      await app.query("UPDATE action_intents SET status = 'approved', decision = 'allow', reason_code = 'rule_matched', matched_rule = 'rules.items[0]' WHERE id = $1", [i.intentId]);
      await app.query(
        `UPDATE policy_decisions SET decision = 'allow', reason_code = 'rule_matched', matched_rule = 'rules.items[0]'
          WHERE intent_id = $1`,
        [i.intentId],
      );
    });
    await expectDenied(s, i.intentId, "decision_audit_mismatch");
  });

  it("【回帰】さらに allow の decision.made を追記しても、元の approve の decision.made は消せないので decision_audit_mismatch", async () => {
    const s = await setup();
    const i = await pendingApprove(s);
    await s.db.query("UPDATE action_intents SET status = 'pending_approval', expires_at = $2 WHERE id = $1", [i.intentId, new Date(NOW.getTime() + 3600_000)]);
    const row = (await s.db.query<{ inputs_hash: string }>("SELECT inputs_hash FROM policy_decisions WHERE intent_id = $1", [i.intentId])).rows[0]!;
    await s.asApp(async (app) => {
      await app.query("UPDATE action_intents SET status = 'approved', decision = 'allow', reason_code = 'rule_matched', matched_rule = 'rules.items[0]' WHERE id = $1", [i.intentId]);
      await app.query(
        `UPDATE policy_decisions SET decision = 'allow', reason_code = 'rule_matched', matched_rule = 'rules.items[0]'
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
    const i = await ruleAllowed(s);
    const swapped: JsonObject = { ...BEANS_20, items: [{ sku: "BEAN-HOUSE", quantity: 200, unit_price: 780 }] };
    const hash = computeMcpIntentHash({ connectorId: s.supplier.id, tool: "place_order", arguments: swapped, toolHash: s.tool.toolHash, effectivePolicyHash: POLICY });
    await s.asApp(async (app) => {
      await app.query("UPDATE action_intents SET payload = jsonb_set(payload, '{arguments}', $2::jsonb), intent_hash = $3 WHERE id = $1", [i.intentId, swapped, hash]);
      await app.query("UPDATE policy_decisions SET subject = jsonb_set(subject, '{args}', $2::jsonb) WHERE intent_id = $1", [i.intentId, swapped]);
    });
    await expectDenied(s, i.intentId, "proposal_audit_mismatch");
  });

  it("試し実行の Intent は simulated にしかならない（BR-24）→ approved にしても dry_run_intent", async () => {
    const s = await setup();
    await s.db.query("UPDATE tasks SET is_dry_run = true, trigger_type = 'dry_run' WHERE id = $1", [s.task.taskId]);
    const i = await approved(s);
    await expectDenied(s, i.intentId, "dry_run_intent");
  });

  it("enforced = false（判定を効かせていない印に書き換えた）→ not_enforced", async () => {
    const s = await setup();
    const i = await s.bare({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.llmWrite", enforced: false });
    await expectDenied(s, i.intentId, "not_enforced");
  });
});

describe("実行と失効の履歴（監査ログ。再実行・復活の防止）", () => {
  it("【回帰】実行済み（ルールの allow）を ot_app で approved に戻す → already_finished。3回くり返しても1回しか書かない", async () => {
    const s = await setup();
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
    let prev: Setup | undefined;
    for (const eventType of ["approval.expired", "approval.invalidated"]) {
      const s = await setup(prev ? { reuse: prev } : {});
      prev = s;
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

    const s2 = await setup({ reuse: s });
    const i = await approved(s2);
    await s2.appendAsApp("killswitch.engaged", { reason: "試験" }, { taskId: null });
    await expectDenied(s2, i.intentId, "kill_switch_expired");
  });
});

describe("ルールで allow の出どころ（SG-03 の3）", () => {
  it("(e) 判定の行が allow（rule_matched・rules.items[n]）で判定の記録がそろっている → 実行（承認の行は要らない）", async () => {
    const s = await setup();
    const i = await ruleAllowed(s);
    await expectExecuted(s, i.intentId);
    expect(await s.orders()).toHaveLength(1);
  });

  it("(f) 判定の行がない allow（decision を allow に書き換えた）→ decision_missing", async () => {
    const s = await setup();
    const i = await s.bare(RULE_ALLOW);
    await expectDenied(s, i.intentId, "decision_missing");
  });

  it("allow でも rule_matched でない（autonomy などに書き換えた）→ rule_not_matched", async () => {
    const s = await setup();
    const i = await s.bare({ decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.mcp_write" });
    await s.evidence(i, { decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.mcp_write" });
    await expectDenied(s, i.intentId, "rule_not_matched");
  });

  it("rule_matched でも matched_rule が rules.items[n] の形でない → rule_not_matched", async () => {
    const s = await setup();
    const i = await s.bare({ ...RULE_ALLOW, matchedRule: "rules.extra" });
    await s.evidence(i, { ...RULE_ALLOW, matchedRule: "rules.extra" });
    await expectDenied(s, i.intentId, "rule_not_matched");
  });
});

describe("judgeProvenance（純粋な照合）", () => {
  const intent: ProvenanceInput["intent"] = {
    id: randomUUID(),
    task_id: randomUUID(),
    action: PLACE_ORDER,
    payload: { connectorId: randomUUID(), tool: "place_order", arguments: BEANS_20, toolHash: `sha256:${"1".repeat(64)}` } as never,
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
  const live = { is_dry_run: false };
  const empty = { decisions: [], approval: null, taskAudits: [], killSwitchSeqs: [] };

  it("試し実行のタスクは dry_run_intent、enforced = false は not_enforced（証拠より先に見る）", () => {
    expect(judgeProvenance({ task: { is_dry_run: true }, intent }, empty)).toEqual({ ok: false, detail: "dry_run_intent" });
    expect(judgeProvenance({ task: live, intent: { ...intent, enforced: false } }, empty)).toEqual({ ok: false, detail: "not_enforced" });
  });

  it("判定の行の Intent の ID・操作・効かせたか・宛先が違えば一致しない（decision_mismatch）", () => {
    for (const bad of [
      row({ subject: { action: PLACE_ORDER, args: BEANS_20, call: { intentId: randomUUID() } } }),
      row({ action_type: "mcp_read" }),
      row({ enforced: false }),
      row({ subject: { action: "mcp.supplier.cancel_order", args: BEANS_20, call: { intentId: intent.id } } }),
    ]) {
      expect(judgeProvenance({ task: live, intent }, { ...empty, decisions: [bad], taskAudits: kernelAudits })).toEqual({ ok: false, detail: "decision_mismatch" });
    }
    // 一致する行と記録があれば、P-1 を通って承認の照合へ
    expect(judgeProvenance({ task: live, intent }, { ...empty, decisions: [row()], taskAudits: kernelAudits })).toEqual({ ok: false, detail: "approval_missing" });
  });

  it("decision.made の inputsHash・subjectKind が判定の行と違う → decision_audit_mismatch。intent.proposed がなければ proposal_audit_missing", () => {
    const [proposed, made] = kernelAudits as [ProvenanceAuditEvent, ProvenanceAuditEvent];
    for (const p of [{ inputsHash: "1".repeat(64) }, { subjectKind: "intent" }, { enforced: false }] as JsonObject[]) {
      const bad = { ...made, payload: { ...made.payload, ...p } };
      expect(judgeProvenance({ task: live, intent }, { ...empty, decisions: [row()], taskAudits: [proposed, bad] })).toEqual({ ok: false, detail: "decision_audit_mismatch" });
    }
    expect(judgeProvenance({ task: live, intent }, { ...empty, decisions: [row()], taskAudits: [made] })).toEqual({ ok: false, detail: "proposal_audit_missing" });
  });

  it("allow：rule_matched の rules.items[n] なら通る。それ以外の matched_rule は rule_not_matched", () => {
    const allowIntent = { ...intent, decision: "allow" as const, reason_code: "rule_matched", matched_rule: "rules.items[0]" };
    const allowRow = row({ decision: "allow", reason_code: "rule_matched", matched_rule: "rules.items[0]" });
    const audits = [
      ev(10, "intent.proposed", { ...kernelAudits[0]!.payload, decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]" }),
      ev(11, "decision.made", { ...kernelAudits[1]!.payload, decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]" }),
    ];
    expect(judgeProvenance({ task: live, intent: allowIntent }, { ...empty, decisions: [allowRow], taskAudits: audits })).toEqual({ ok: true });

    const other = { ...allowIntent, matched_rule: "autonomy.mcp_write" };
    const otherRow = row({ decision: "allow", reason_code: "rule_matched", matched_rule: "autonomy.mcp_write" });
    const otherAudits = audits.map((a) => ({ ...a, payload: { ...a.payload, matchedRule: "autonomy.mcp_write" } }));
    expect(judgeProvenance({ task: live, intent: other }, { ...empty, decisions: [otherRow], taskAudits: otherAudits })).toEqual({ ok: false, detail: "rule_not_matched" });
  });
});
