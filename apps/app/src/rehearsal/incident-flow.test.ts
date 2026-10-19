// 本番の停止の入口（incident-flow.ts）の試験：Kernel の approve・deny・ユーザーの却下が試験（incident）になり、合格証が切れる（BR-80・FR-066）
import { issueCertificate } from "@open-team/db/rehearsal";
import { fxAgent, fxConnector, fxIntent, fxRehearsalRun, fxSimExecution, fxSimSnapshot, fxTask, fxWorkspace, useTestDb } from "@open-team/db/testing";
import { manualClock, memoryLogger } from "@open-team/platform";
import { describe, expect, it } from "vitest";
import { INCIDENT_REPORT_LINE, incidentKindOfIntent, incidentOnIntentRecorded, incidentReportLine, recordKernelIncident, recordUserRejection } from "./incident-flow.ts";

const T = useTestDb();
const NOW = new Date("2026-10-14T01:00:00.000Z");

async function setup() {
  const { db } = T();
  const ws = await fxWorkspace(db, { kind: "owner" });
  const agent = await fxAgent(db, ws);
  const connector = await fxConnector(db, ws);
  const live = await fxSimExecution(db, ws);
  const logs = memoryLogger();
  const deps = { db, clock: manualClock(NOW), log: logs.logger };
  return { db, ws, agent, connectorId: connector.connectorId, executionId: live.executionId, deps, logs };
}
type S = Awaited<ReturnType<typeof setup>>;

async function stopped(s: S, o: { decision?: string; reasonCode?: string; detail?: unknown; tainted?: boolean; shadow?: boolean } = {}) {
  const { db, ws, agent } = s;
  const { taskId } = await fxTask(db, ws, agent, undefined);
  const snap = await fxSimSnapshot(db, ws, { executionId: s.executionId, sourceTaskId: taskId });
  await db.query("UPDATE tasks SET sim_snapshot_id = $2 WHERE id = $1", [taskId, snap.snapshotId]);
  const { intentId } = await fxIntent(db, ws, { taskId, jobId: agent.jobId, connectorId: s.connectorId });
  await db.query("UPDATE action_intents SET decision = $2, reason_code = $3, decision_detail = $4::jsonb, taint_snapshot = $5::jsonb WHERE id = $1", [
    intentId,
    o.decision ?? "approve",
    o.reasonCode ?? "approval_required",
    o.detail ?? null,
    { tainted: o.tainted === true, sources: [] },
  ]);
  return { taskId, intentId };
}

/** 有効な合格証を1つ作る */
async function certify(s: S) {
  const { runId } = await fxRehearsalRun(s.db, s.ws, { jobId: s.agent.jobId, status: "done" });
  return s.db.transaction((tx) =>
    issueCertificate(tx, s.ws.ctx, {
      jobId: s.agent.jobId,
      runId,
      policyHash: "a".repeat(64),
      toolHashes: [],
      modelId: "gemini-test-001",
      caseSetHash: "b".repeat(64),
      caseCount: 1,
      summary: {},
      costUsd: "0.1",
      certificateHash: "c".repeat(64),
      now: NOW,
    }),
  );
}

const incidents = (s: S) =>
  s.db.query<{ incident_kind: string; reason_code: string }>("SELECT incident_kind, reason_code FROM rehearsal_cases WHERE workspace_id = $1 AND source = 'incident'", [s.ws.workspaceId]);
const certState = (s: S, id: string) => s.db.query<{ revoked_at: Date | null; revoke_reason: string | null }>("SELECT revoked_at, revoke_reason FROM rehearsal_certificates WHERE id = $1", [id]);

describe("incidentKindOfIntent：止まったものだけ試験にする", () => {
  const base = { taint_snapshot: { tainted: false, sources: [] }, decision_detail: null } as const;
  it("ガード・未確定の結果・ツール説明の変更・汚染・宛先の固定の不一致の approve と、halt 以外の deny は試験にする", () => {
    for (const reason_code of ["guard_exceeded", "unknown_outcome_pending", "tool_needs_review"] as const) {
      expect(incidentKindOfIntent({ ...base, decision: "approve", reason_code })).toBe("kernel_approve");
    }
    expect(incidentKindOfIntent({ ...base, decision: "approve", reason_code: "approval_required", taint_snapshot: { tainted: true, sources: [] } })).toBe("kernel_approve");
    expect(
      incidentKindOfIntent({ ...base, decision: "approve", reason_code: "approval_required", decision_detail: { kind: "rule_mismatch", ruleIndex: 0, argPath: "supplier_id", role: "destination" } }),
    ).toBe("kernel_approve");
    expect(incidentKindOfIntent({ ...base, decision: "deny", reason_code: "not_granted" })).toBe("kernel_deny");
  });
  it("ふだんの確認・合格証がないための確認・許可・halt は試験にしない（合格証が切れ続けるのを避ける）", () => {
    expect(incidentKindOfIntent({ ...base, decision: "approve", reason_code: "approval_required" })).toBeNull();
    expect(incidentKindOfIntent({ ...base, decision: "approve", reason_code: "certificate_missing" })).toBeNull();
    expect(incidentKindOfIntent({ ...base, decision: "approve", reason_code: "certificate_missing", taint_snapshot: { tainted: true, sources: [] } })).toBeNull();
    expect(incidentKindOfIntent({ ...base, decision: "allow", reason_code: "rule_matched" })).toBeNull();
    expect(incidentKindOfIntent({ ...base, decision: "deny", reason_code: "kill_switch" })).toBeNull();
    expect(incidentKindOfIntent({ ...base, decision: "halt" as never, reason_code: "budget_exceeded" })).toBeNull();
  });
});

describe("Kernel の判定・却下から試験を足す（BR-80）", () => {
  it("approve（guard_exceeded）で incident が増え、合格証が case_added で切れる。報告の行の文が取れる", async () => {
    const s = await setup();
    const cert = await certify(s);
    const t = await stopped(s, { reasonCode: "guard_exceeded", detail: { kind: "guard", argPath: "items[0].quantity", value: 20, found: true, guard: {} } });
    const r = await recordKernelIncident(s.deps, s.ws.ctx, { ...t, shadow: false });
    expect(r.recorded).toBe(true);
    expect(incidentReportLine(r)).toBe(INCIDENT_REPORT_LINE);
    expect((await incidents(s)).rows).toEqual([{ incident_kind: "kernel_approve", reason_code: "guard_exceeded" }]);
    expect((await certState(s, cert.id)).rows[0]).toMatchObject({ revoke_reason: "case_added" });
  });

  it("deny も足す。EdgeHooks.onIntentRecorded 用の関数でも同じ", async () => {
    const s = await setup();
    const t = await stopped(s, { decision: "deny", reasonCode: "not_granted" });
    await incidentOnIntentRecorded(s.deps)(s.ws.ctx, { taskId: t.taskId, intentId: t.intentId, status: "denied", shadow: false });
    expect((await incidents(s)).rows).toEqual([{ incident_kind: "kernel_deny", reason_code: "not_granted" }]);
  });

  it("ふだんの確認・certificate_missing・影では足さず、合格証も切らない", async () => {
    const s = await setup();
    const cert = await certify(s);
    for (const o of [{}, { reasonCode: "certificate_missing" }]) {
      const t = await stopped(s, o);
      expect(await recordKernelIncident(s.deps, s.ws.ctx, { ...t, shadow: false })).toEqual({ recorded: false, reason: "not_incident" });
    }
    const sh = await stopped(s, { reasonCode: "guard_exceeded" });
    expect(await recordKernelIncident(s.deps, s.ws.ctx, { ...sh, shadow: true })).toEqual({ recorded: false, reason: "shadow" });
    expect((await incidents(s)).rowCount).toBe(0);
    expect((await certState(s, cert.id)).rows[0]).toMatchObject({ revoked_at: null });
  });

  it("ユーザーの却下で incident（user_reject）が増え、合格証が切れる。同じ却下を2回呼んでも1件", async () => {
    const s = await setup();
    const cert = await certify(s);
    const t = await stopped(s);
    const r = await s.db.transaction((tx) => recordUserRejection(tx, s.ws.ctx, t, NOW, s.deps.log));
    expect(incidentReportLine(r)).toBe(INCIDENT_REPORT_LINE);
    const again = await s.db.transaction((tx) => recordUserRejection(tx, s.ws.ctx, t, NOW, s.deps.log));
    expect(again).toEqual({ recorded: false, reason: "duplicate" });
    expect(incidentReportLine(again)).toBeNull();
    expect((await incidents(s)).rows).toEqual([{ incident_kind: "user_reject", reason_code: "approval_required" }]);
    expect((await certState(s, cert.id)).rows[0]).toMatchObject({ revoke_reason: "case_added" });
  });

  it("試験を足せなくても（例外）却下の書き込みは成立する：ログに残して error を返す", async () => {
    const s = await setup();
    const t = await stopped(s);
    // 試験の書き込みを失敗させる（CHECK 違反）
    await s.db.query("ALTER TABLE rehearsal_cases ADD CONSTRAINT boom CHECK (false) NOT VALID");
    try {
      const r = await s.db.transaction(async (tx) => {
        await tx.query("UPDATE tasks SET updated_at = now() WHERE id = $1", [t.taskId]);
        return recordUserRejection(tx, s.ws.ctx, t, NOW, s.deps.log);
      });
      expect(r).toEqual({ recorded: false, reason: "error" });
      expect(s.logs.records.some((x) => x.event === "rehearsal.incident_failed")).toBe(true);
    } finally {
      await s.db.query("ALTER TABLE rehearsal_cases DROP CONSTRAINT boom");
    }
  });
});
