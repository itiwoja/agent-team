// edge の業務の問い合わせの試験（apps/worker/src/db/repo/edge.ts）。
// Postgres 版には試験がなかったので新しく書いた。関数ごとに主な流れと守り（状態の条件・期限・一度きり）を見る
import { describe, expect, it } from "vitest";
import { CODECS } from "../../src/db/codecs.ts";
import {
  addTaskUsage,
  claimToolCallExecution,
  countActiveLiveTasks,
  countExecutedToolCalls,
  countTaskIntents,
  endTask,
  expireOpenIntentsOfTask,
  findConnectorTool,
  findTaskByTokenHash,
  findToolCallDecision,
  getAgentJobRow,
  getAgentRow,
  getAgentSnapshotRow,
  getAskRow,
  getAskRunTriggerType,
  getTask,
  hasApprovedDestination,
  insertActionIntent,
  insertApproval,
  insertPolicyDecision,
  insertTaskEvent,
  insertUsageRecord,
  isTaskTainted,
  listAskMembers,
  listConnectorToolsBySlugs,
  listInputTaskReports,
  listLatestMemberTasks,
  listMembershipRoles,
  listTaskIntentStatuses,
  listToolCallIds,
  listUnknownOutcomeKeys,
  lockTask,
  markMessagesDelivered,
  markTaskRunning,
  revokeTaskToken,
  saveTaskReport,
  setTaskTaint,
  setTaskToken,
  setTaskWaitingStatus,
  sumAgentDayCostMicroUsd,
  sumWorkspaceDayCostMicroUsd,
  touchTaskHeartbeat,
  updateTaskCounters,
  type ActionIntentInput,
  type PolicyDecisionInput,
} from "../../src/db/repo/edge.ts";
import { all, count, isTriggerAbort, isUniqueViolation, newId, one, run, type WsDb } from "../../src/db/sqlite.ts";
import { hashTaskToken } from "../../src/db/tokens.ts";
import type { ActionIntentRow, ApprovalRow, TaskEventRow, TaskRow, Uuid } from "../../src/db/types.ts";
import {
  FIXED_NOW,
  fxAgent,
  fxApproval,
  fxAsk,
  fxAskMember,
  fxAskRun,
  fxConnector,
  fxHash,
  fxIntent,
  fxTask,
  fxToolHash,
  fxUsage,
  inWorkspace,
  type FxAgent,
  type FxWorkspace,
} from "./fixtures.ts";

const NOW = FIXED_NOW;
const LATER = new Date(NOW.getTime() + 60_000);
const HOUR = 3600_000;

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}
function taskRow(db: WsDb, id: Uuid): TaskRow {
  return one<TaskRow>(db, CODECS.tasks, "SELECT * FROM tasks WHERE id = ?", id)!;
}

describe("タスクのトークン", () => {
  it("付けて引き直す。期限ちょうど・失効は null。終了状態のタスクには付けない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent, { status: "queued" });
      const hash = hashTaskToken("tok-a");
      expect(findTaskByTokenHash(db, hash, NOW)).toBeNull();
      expect(setTaskToken(db, taskId, hash, LATER, NOW)).toBe(true);
      const hit = findTaskByTokenHash(db, hash, NOW)!;
      expect(hit.task).toMatchObject({ id: taskId, task_token_expires_at: LATER });
      expect(hit.task.task_token_hash?.equals(hash)).toBe(true);
      expect(hit.workspace).toMatchObject({ workspace_id: ws.workspaceId, owner_user_id: ws.userId });
      expect(findTaskByTokenHash(db, hash, LATER)).toBeNull();

      revokeTaskToken(db, taskId, NOW);
      expect(findTaskByTokenHash(db, hash, NOW)).toBeNull();
      expect(taskRow(db, taskId)).toMatchObject({ task_token_hash: null, task_token_expires_at: null });

      // 同じハッシュを2つのタスクに付けられない（一意）
      setTaskToken(db, taskId, hash, LATER, NOW);
      const { taskId: other } = fxTask(db, ws, agent, { status: "running" });
      expect(isUniqueViolation(caught(() => setTaskToken(db, other, hash, LATER, NOW)), "tasks.task_token_hash")).toBe(true);

      const { taskId: done } = fxTask(db, ws, agent, { status: "completed" });
      expect(setTaskToken(db, done, hashTaskToken("tok-b"), LATER, NOW)).toBe(false);
      expect(findTaskByTokenHash(db, hashTaskToken("tok-b"), NOW)).toBeNull();
    });
  });
});

describe("タスクの行", () => {
  it("getTask・lockTask は行を読む。markTaskRunning は queued・provisioning のときだけで、started_at は最初の1回", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent, { status: "queued" });
      expect(getTask(db, taskId)).toMatchObject({ id: taskId, status: "queued", started_at: null });
      expect(lockTask(db, taskId)).toEqual(getTask(db, taskId));
      expect(getTask(db, newId())).toBeNull();

      expect(markTaskRunning(db, taskId, NOW)).toMatchObject({ status: "running", started_at: NOW, last_heartbeat_at: NOW });
      expect(markTaskRunning(db, taskId, LATER)).toBeNull();
      run(db, "UPDATE tasks SET status = 'provisioning' WHERE id = ?", taskId);
      expect(markTaskRunning(db, taskId, LATER)).toMatchObject({ status: "running", started_at: NOW, last_heartbeat_at: LATER });

      touchTaskHeartbeat(db, taskId, new Date(LATER.getTime() + 1));
      expect(taskRow(db, taskId).last_heartbeat_at).toEqual(new Date(LATER.getTime() + 1));
    });
  });

  it("endTask は終了状態にしてトークンを失効させる。すでに終了状態なら null。理由の列は CHECK に合う", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const cases = [
        { change: { status: "halted", haltReason: "budget_exceeded" } as const, expect: { halt_reason: "budget_exceeded", fail_reason: null, status_detail: null } },
        { change: { status: "failed", failReason: "sandbox_lost" } as const, expect: { halt_reason: null, fail_reason: "sandbox_lost" } },
        { change: { status: "completed", detail: "report" } as const, expect: { status_detail: "report" } },
        { change: { status: "succeeded" } as const, expect: { status_detail: null } },
        { change: { status: "cancelled", detail: null } as const, expect: { status_detail: null } },
      ];
      for (const c of cases) {
        const { taskId } = fxTask(db, ws, agent, { status: "running" });
        setTaskToken(db, taskId, hashTaskToken(`t-${c.change.status}`), LATER, NOW);
        const row = endTask(db, taskId, c.change, LATER);
        expect(row).toMatchObject({ status: c.change.status, finished_at: LATER, task_token_hash: null, task_token_expires_at: null, ...c.expect });
        expect(endTask(db, taskId, { status: "succeeded" }, LATER)).toBeNull();
      }
    });
  });

  it("setTaskWaitingStatus は終了状態でなければ変える", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent, { status: "running" });
      expect(setTaskWaitingStatus(db, taskId, "awaiting_approval", NOW)).toMatchObject({ status: "awaiting_approval" });
      expect(setTaskWaitingStatus(db, taskId, "executing", LATER)).toMatchObject({ status: "executing", updated_at: LATER });
      const { taskId: done } = fxTask(db, ws, agent, { status: "halted" });
      expect(setTaskWaitingStatus(db, done, "executing", NOW)).toBeNull();
    });
  });

  it("addTaskUsage はマイクロドルとステップを足して返す。整数でない・負の金額は受けない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      expect(addTaskUsage(db, taskId, 12_345, 1, NOW)).toEqual({ cost_micro_usd: 12_345, steps_used: 1 });
      expect(addTaskUsage(db, taskId, 5, 2, LATER)).toEqual({ cost_micro_usd: 12_350, steps_used: 3 });
      expect(taskRow(db, taskId).last_heartbeat_at).toEqual(LATER);
      expect(() => addTaskUsage(db, taskId, 0.5, 1, NOW)).toThrow(RangeError);
      expect(() => addTaskUsage(db, taskId, -1, 1, NOW)).toThrow(RangeError);
      expect(addTaskUsage(db, newId(), 1, 1, NOW)).toBeNull();
    });
  });

  it("Breaker のカウンタ・汚染（戻らない）・報告（1回だけ）", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      updateTaskCounters(db, taskId, { deniedCount: 2, repeatKey: fxHash("r"), repeatCount: 3 }, NOW);
      expect(taskRow(db, taskId)).toMatchObject({ denied_count: 2, repeat_key: fxHash("r"), repeat_count: 3 });

      expect(isTaskTainted(db, taskId)).toBe(false);
      const sources = [{ kind: "web_search" as const, at: NOW.toISOString() }];
      setTaskTaint(db, taskId, { tainted: true, sources }, NOW);
      expect(isTaskTainted(db, taskId)).toBe(true);
      expect(taskRow(db, taskId).taint_sources).toEqual(sources);
      expect(isTriggerAbort(caught(() => setTaskTaint(db, taskId, { tainted: false, sources: [] }, NOW)))).toBe(true);
      expect(isTaskTainted(db, newId())).toBe(false);

      const report = { title: "報告", body: "本文", kind: "normal" as const, sources: [{ kind: "url" as const, url: "https://example.test" }], meta: { nextActions: ["次"] } };
      expect(saveTaskReport(db, taskId, report, NOW)).toBe(true);
      expect(saveTaskReport(db, taskId, { ...report, body: "二回目" }, NOW)).toBe(false);
      expect(taskRow(db, taskId)).toMatchObject({ report: "本文", report_title: "報告", report_kind: "normal", report_sources: report.sources, report_meta: { nextActions: ["次"] } });
      // 空の meta は NULL
      const { taskId: t2 } = fxTask(db, ws, agent);
      saveTaskReport(db, t2, { ...report, meta: {} }, NOW);
      expect(taskRow(db, t2).report_meta).toBeNull();
    });
  });

  it("countActiveLiveTasks は provisioning・running だけを数える", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      for (const status of ["running", "running", "queued", "awaiting_approval", "completed"] as const) fxTask(db, ws, agent, { status });
      const { taskId } = fxTask(db, ws, agent, { status: "queued" });
      run(db, "UPDATE tasks SET status = 'provisioning' WHERE id = ?", taskId);
      expect(countActiveLiveTasks(db)).toBe(3);
    });
  });
});

describe("タスクの文脈", () => {
  it("エージェント・スナップショット・仕事・依頼・実行のきっかけを ID で引く", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db, { name: "仕入れ係" });
      const { askId } = fxAsk(db, ws);
      const { askRunId } = fxAskRun(db, askId);
      expect(getAgentRow(db, agent.agentId)).toMatchObject({ name: "仕入れ係", current_snapshot_id: agent.snapshotId });
      expect(getAgentSnapshotRow(db, agent.snapshotId)).toMatchObject({ status: "valid", definition: { name: "仕入れ係" } });
      expect(getAgentJobRow(db, agent.jobId)).toMatchObject({ slug: "purchase" });
      expect(getAskRow(db, askId)).toMatchObject({ status: "running", shape: "chain" });
      expect(getAskRunTriggerType(db, askRunId)).toBe("initial");
      for (const f of [getAgentRow, getAgentSnapshotRow, getAgentJobRow, getAskRow, getAskRunTriggerType]) expect(f(db, newId())).toBeNull();
    });
  });

  it("listAskMembers は段の順（位置なしは後ろ）、まとめ役は最後", async () => {
    await inWorkspace((db, ws) => {
      const { askId } = fxAsk(db, ws);
      const agg = fxAgent(db, { name: "まとめ係" });
      const second = fxAgent(db, { name: "二番係" });
      const first = fxAgent(db, { name: "一番係" });
      const none = fxAgent(db, { name: "位置なし係" });
      fxAskMember(db, { askId, agent: agg, isAggregator: true });
      fxAskMember(db, { askId, agent: second, position: 2 });
      fxAskMember(db, { askId, agent: none });
      fxAskMember(db, { askId, agent: first, position: 1 });
      const rows = listAskMembers(db, askId);
      expect(rows.map((m) => m.agent_name)).toEqual(["一番係", "二番係", "位置なし係", "まとめ係"]);
      expect(rows[3]).toMatchObject({ is_aggregator: true, depends_on: [] });
    });
  });

  it("listInputTaskReports は渡した ID の順で、ないものは飛ばす", async () => {
    await inWorkspace((db, ws) => {
      const a = fxAgent(db, { name: "上流係" });
      const { taskId: t1 } = fxTask(db, ws, a, { status: "completed", tainted: true });
      const { taskId: t2 } = fxTask(db, ws, a, { status: "completed" });
      run(db, "UPDATE tasks SET report = '報告1', report_kind = 'normal' WHERE id = ?", t1);
      const rows = listInputTaskReports(db, [t2, newId(), t1]);
      expect(rows.map((r) => r.id)).toEqual([t2, t1]);
      expect(rows[1]).toMatchObject({ agent_name: "上流係", report: "報告1", tainted: true, taint_sources: [{ kind: "web_search" }], finished_at: NOW });
      expect(listInputTaskReports(db, [])).toEqual([]);
    });
  });

  it("listMembershipRoles は持ち主1人を owner で返す", async () => {
    await inWorkspace((db, ws) => {
      expect(listMembershipRoles(db)).toEqual([{ user_id: ws.userId, role: "owner" }]);
    });
  });
});

describe("コネクタ・ツール", () => {
  it("slug とツール名で引き、slug の一覧でまとめて引く", async () => {
    await inWorkspace((db) => {
      const s = fxConnector(db);
      const m = fxConnector(db, { slug: "mail", tools: [{ name: "send", classification: "write" }] });
      expect(findConnectorTool(db, "supplier", "place_order")).toMatchObject({ connector: { id: s.connectorId, enabled: true }, tool: { name: "place_order" } });
      expect(findConnectorTool(db, "supplier", "nope")).toBeNull();
      expect(findConnectorTool(db, "nope", "place_order")).toBeNull();
      const hits = listConnectorToolsBySlugs(db, ["supplier", "mail", "nope"]);
      expect(hits.map((h) => `${h.connector.slug}.${h.tool.name}`)).toEqual(["supplier.list_products", "supplier.place_order", "mail.send"]);
      expect(hits.find((h) => h.connector.id === m.connectorId)?.tool.classification).toBe("write");
      expect(listConnectorToolsBySlugs(db, [])).toEqual([]);
      expect(listConnectorToolsBySlugs(db, ["nope"])).toEqual([]);
    });
  });
});

describe("費用", () => {
  it("今日（timeZone の暦の日）の費用をマイクロドルで足す。境目は始まりを含み終わりを含まない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const other = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      // NOW = 2026-10-12T09:00Z は東京の 10/12 18:00。今日 = [10/11 15:00Z, 10/12 15:00Z)
      const start = new Date("2026-10-11T15:00:00.000Z");
      const end = new Date("2026-10-12T15:00:00.000Z");
      fxUsage(db, { taskId, costMicroUsd: 100, createdAt: start });
      fxUsage(db, { agentId: agent.agentId, costMicroUsd: 20, createdAt: NOW });
      fxUsage(db, { agentId: other.agentId, costMicroUsd: 3, createdAt: NOW });
      fxUsage(db, { taskId, costMicroUsd: 1000, createdAt: new Date(start.getTime() - 1) });
      fxUsage(db, { taskId, costMicroUsd: 10_000, createdAt: end });
      expect(sumWorkspaceDayCostMicroUsd(db, NOW, "Asia/Tokyo")).toBe(123);
      expect(sumAgentDayCostMicroUsd(db, agent.agentId, NOW, "Asia/Tokyo")).toBe(120);
      expect(sumAgentDayCostMicroUsd(db, other.agentId, NOW, "Asia/Tokyo")).toBe(3);
      // UTC の日なら [10/12 0:00Z, 10/13 0:00Z)：start の行は前の日、end の行は同じ日
      expect(sumWorkspaceDayCostMicroUsd(db, NOW, "UTC")).toBe(10_023);
      expect(sumAgentDayCostMicroUsd(db, newId(), NOW, "Asia/Tokyo")).toBe(0);
    });
  });

  it("insertUsageRecord は持ち主のどれかが要る（CHECK）", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      const u = {
        taskId,
        agentId: null,
        askId: null,
        provider: "google" as const,
        model: "gemini-test",
        phase: "plan" as const,
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostMicroUsd: 40,
        costMicroUsd: 42,
        latencyMs: 7,
        promptHash: fxHash("p"),
      };
      insertUsageRecord(db, u, NOW);
      expect(one(db, CODECS.usage_records, "SELECT task_id, cost_micro_usd, estimated_cost_micro_usd, created_at FROM usage_records")).toEqual({
        task_id: taskId,
        cost_micro_usd: 42,
        estimated_cost_micro_usd: 40,
        created_at: NOW,
      });
      expect(() => insertUsageRecord(db, { ...u, taskId: null }, NOW)).toThrow(/usage_records_owner_chk/);
    });
  });
});

describe("Intent・承認", () => {
  function intentInput(agent: FxAgent, taskId: Uuid, connectorId: Uuid, over: Partial<ActionIntentInput> = {}): ActionIntentInput {
    const toolHash = fxToolHash("supplier.place_order");
    return {
      taskId,
      jobId: agent.jobId,
      connectorId,
      action: "mcp.supplier.place_order",
      origin: "agent",
      payload: { connectorId, tool: "place_order", arguments: { supplier_id: "s-1" }, toolHash },
      toolHash,
      destinationKey: fxHash("dest:s-1"),
      optionDigest: fxHash("opt"),
      taintSnapshot: { tainted: true, sources: [{ kind: "web_search", at: NOW.toISOString() }] },
      status: "pending_approval",
      decision: "approve",
      reasonCode: "approval_required",
      matchedRule: "autonomy.mcp_write",
      decisionDetail: null,
      enforced: true,
      policyHash: fxHash("policy"),
      intentHash: fxHash(`intent:${newId()}`),
      expiresAt: LATER,
      ...over,
    };
  }

  it("Intent と承認を作る。承認待ちには期限が要り、1つの Intent に承認は1つ", async () => {
    await inWorkspace((db, ws) => {
      const c = fxConnector(db);
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      const intentId = insertActionIntent(db, intentInput(agent, taskId, c.connectorId), NOW);
      const row = one<ActionIntentRow>(db, CODECS.action_intents, "SELECT * FROM action_intents WHERE id = ?", intentId)!;
      expect(row).toMatchObject({ action_type: "mcp_call", status: "pending_approval", enforced: true, expires_at: LATER, connector_credential_id: null, created_at: NOW });
      expect(row.payload.arguments).toEqual({ supplier_id: "s-1" });
      expect(row.taint_snapshot).toEqual({ tainted: true, sources: [{ kind: "web_search", at: NOW.toISOString() }] });
      expect(() => insertActionIntent(db, intentInput(agent, taskId, c.connectorId, { expiresAt: null }), NOW)).toThrow(/action_intents_pending_expiry_chk/);

      const approval = {
        taskId,
        intentId,
        riskLevel: "medium" as const,
        riskScore: 40,
        riskReasons: [{ code: "first_destination", points: 20, detail: null }],
        approverIds: [ws.userId],
        expiresAt: LATER,
        expiryCause: "ttl" as const,
        firstDestination: true,
      };
      const approvalId = insertApproval(db, approval, NOW);
      expect(one<ApprovalRow>(db, CODECS.approvals, "SELECT * FROM approvals WHERE id = ?", approvalId)).toMatchObject({
        status: "pending",
        approver_ids: [ws.userId],
        risk_reasons: approval.riskReasons,
        first_destination: true,
        expires_at: LATER,
      });
      expect(isUniqueViolation(caught(() => insertApproval(db, approval, NOW)), "approvals.intent_id")).toBe(true);
      expect(() => insertApproval(db, { ...approval, intentId: insertActionIntent(db, intentInput(agent, taskId, c.connectorId), NOW), approverIds: [] }, NOW)).toThrow(
        /approvals_approver_ids_check/,
      );
    });
  });

  it("Intent の数・状態・unknown_outcome の宛先・承認したことのある宛先", async () => {
    await inWorkspace((db, ws) => {
      const c = fxConnector(db);
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      const mk = (status: Parameters<typeof fxIntent>[1]["status"], dest: string, at: Date) =>
        fxIntent(db, { taskId, jobId: agent.jobId, connectorId: c.connectorId, status, destinationKey: fxHash(dest), now: at }).intentId;
      mk("denied", "d1", NOW);
      mk("unknown_outcome", "d2", new Date(NOW.getTime() + 1));
      mk("unknown_outcome", "d2", new Date(NOW.getTime() + 2));
      const approvedIntent = mk("executed", "d3", new Date(NOW.getTime() + 3));
      const rejectedIntent = mk("rejected", "d4", new Date(NOW.getTime() + 4));
      fxApproval(db, ws, { taskId, intentId: approvedIntent, status: "approved" });
      fxApproval(db, ws, { taskId, intentId: rejectedIntent, status: "rejected" });

      expect(countTaskIntents(db, taskId)).toBe(5);
      expect(countTaskIntents(db, newId())).toBe(0);
      expect(listTaskIntentStatuses(db, taskId)).toEqual(["denied", "unknown_outcome", "unknown_outcome", "executed", "rejected"]);
      expect(listUnknownOutcomeKeys(db, agent.jobId)).toEqual([fxHash("d2")]);
      expect(hasApprovedDestination(db, agent.jobId, fxHash("d3"))).toBe(true);
      expect(hasApprovedDestination(db, agent.jobId, fxHash("d4"))).toBe(false);
      expect(hasApprovedDestination(db, fxAgent(db).jobId, fxHash("d3"))).toBe(false);
    });
  });

  it("expireOpenIntentsOfTask は未実行の Intent と承認待ちを expired にし、executing・終わったもの・別のタスクはそのまま", async () => {
    await inWorkspace((db, ws) => {
      const c = fxConnector(db);
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      const { taskId: other } = fxTask(db, ws, agent);
      const mk = (t: Uuid, status: Parameters<typeof fxIntent>[1]["status"]) => fxIntent(db, { taskId: t, jobId: agent.jobId, connectorId: c.connectorId, status }).intentId;
      const proposed = mk(taskId, "proposed");
      const pending = mk(taskId, "pending_approval");
      const approved = mk(taskId, "approved");
      const executing = mk(taskId, "executing");
      const executed = mk(taskId, "executed");
      const otherPending = mk(other, "pending_approval");
      fxApproval(db, ws, { taskId, intentId: pending });
      fxApproval(db, ws, { taskId: other, intentId: otherPending });

      const r = expireOpenIntentsOfTask(db, taskId, "task_ended", LATER);
      expect(r.approvals).toBe(1);
      expect([...r.intentIds].sort()).toEqual([proposed, pending, approved].sort());
      const statusOf = (id: Uuid) => one<{ status: string; expire_reason: string | null }>(db, {}, "SELECT status, expire_reason FROM action_intents WHERE id = ?", id);
      for (const id of [proposed, pending, approved]) expect(statusOf(id)).toEqual({ status: "expired", expire_reason: "task_ended" });
      expect(statusOf(executing)?.status).toBe("executing");
      expect(statusOf(executed)?.status).toBe("executed");
      expect(statusOf(otherPending)?.status).toBe("pending_approval");
      expect(all<{ status: string }>(db, {}, "SELECT status FROM approvals ORDER BY task_id = ? DESC", taskId).map((a) => a.status)).toEqual(["expired", "pending"]);
      expect(expireOpenIntentsOfTask(db, taskId, "task_ended", LATER)).toEqual({ intentIds: [], approvals: 0 });
    });
  });
});

describe("判定の記録とツール呼び出し", () => {
  function decision(taskId: Uuid, toolCallId: string | null, over: Partial<PolicyDecisionInput> = {}): PolicyDecisionInput {
    return {
      taskId,
      intentId: null,
      subjectKind: "tool_call",
      actionType: "mcp_read",
      subject: toolCallId ? { action: "mcp.supplier.list_products", call: { toolCallId, name: "list_products" } } : { action: "llm" },
      counters: { steps: 1 },
      flags: {},
      taint: { tainted: false, sources: [] },
      decision: "allow",
      reasonCode: "allowed",
      matchedRule: null,
      detail: null,
      enforced: true,
      inputsHash: fxHash("in"),
      kernelVersion: "0.1.0",
      ...over,
    };
  }

  it("判定を残し、toolCallId で新しいものを引く。toolCallId の一覧は重複なし", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      const first = insertPolicyDecision(db, decision(taskId, "call-1"), NOW);
      const second = insertPolicyDecision(db, decision(taskId, "call-1", { decision: "deny", reasonCode: "denied", matchedRuleId: "r-1" }), LATER);
      insertPolicyDecision(db, decision(taskId, "call-2"), NOW);
      insertPolicyDecision(db, decision(taskId, null, { subjectKind: "llm_call" }), NOW);
      expect(first).not.toBe(second);
      expect(findToolCallDecision(db, taskId, "call-1")).toMatchObject({ id: second, decision: "deny", matched_rule_id: "r-1", enforced: true, created_at: LATER });
      expect(findToolCallDecision(db, taskId, "call-9")).toBeNull();
      expect(findToolCallDecision(db, newId(), "call-1")).toBeNull();
      expect(listToolCallIds(db, taskId).sort()).toEqual(["call-1", "call-2"]);
      // intent の判定は intent_id が要る（CHECK）
      expect(() => insertPolicyDecision(db, decision(taskId, null, { subjectKind: "intent" }), NOW)).toThrow(/policy_decisions_intent_kind_chk/);
    });
  });

  it("claimToolCallExecution は同じ toolCallId を1回だけ受け付け、runner の進捗（by なし）とは別に数える", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      const { taskId: other } = fxTask(db, ws, agent);
      insertTaskEvent(db, taskId, "tool_called", { toolCallId: "c1", name: "web_fetch" }, NOW);
      expect(claimToolCallExecution(db, taskId, { toolCallId: "c1", name: "web_fetch" }, NOW)).toBe(true);
      expect(claimToolCallExecution(db, taskId, { toolCallId: "c1", name: "web_fetch" }, NOW)).toBe(false);
      expect(claimToolCallExecution(db, taskId, { toolCallId: "c2", name: "web_fetch" }, NOW)).toBe(true);
      expect(claimToolCallExecution(db, taskId, { toolCallId: "c3", name: "web_search" }, NOW)).toBe(true);
      expect(claimToolCallExecution(db, other, { toolCallId: "c1", name: "web_fetch" }, NOW)).toBe(true);
      expect(countExecutedToolCalls(db, taskId, "web_fetch")).toBe(2);
      expect(countExecutedToolCalls(db, taskId, "web_search")).toBe(1);
      expect(countExecutedToolCalls(db, taskId, "nope")).toBe(0);
      const ev = all<TaskEventRow>(db, CODECS.task_events, "SELECT * FROM task_events WHERE task_id = ? ORDER BY id", taskId);
      expect(ev.map((e) => e.payload)).toEqual([
        { toolCallId: "c1", name: "web_fetch" },
        { toolCallId: "c1", name: "web_fetch", by: "edge", stage: "executed" },
        { toolCallId: "c2", name: "web_fetch", by: "edge", stage: "executed" },
        { toolCallId: "c3", name: "web_search", by: "edge", stage: "executed" },
      ]);
      expect(ev[0]).toMatchObject({ type: "tool_called", created_at: NOW });
      expect(() => insertTaskEvent(db, taskId, "nope" as never, {}, NOW)).toThrow(/task_events_type_check/);
    });
  });
});

describe("連絡板", () => {
  function memberTask(db: WsDb, ws: FxWorkspace, o: { askId: Uuid; memberId: Uuid; agent: FxAgent; at: Date; kind?: "normal" | "followup" }): Uuid {
    const { taskId } = fxTask(db, ws, o.agent, { askId: o.askId, now: o.at });
    run(db, "UPDATE tasks SET ask_member_id = ? WHERE id = ?", o.memberId, taskId);
    if (o.kind === "followup") run(db, "UPDATE tasks SET kind = 'followup', parent_task_id = id WHERE id = ?", taskId);
    return taskId;
  }

  it("listLatestMemberTasks は担当ごとの最新の通常のタスク（追いのターンは除く）", async () => {
    await inWorkspace((db, ws) => {
      const { askId } = fxAsk(db, ws);
      const a = fxAgent(db);
      const b = fxAgent(db);
      const { memberId: ma } = fxAskMember(db, { askId, agent: a, position: 1 });
      const { memberId: mb } = fxAskMember(db, { askId, agent: b, position: 2 });
      memberTask(db, ws, { askId, memberId: ma, agent: a, at: NOW });
      const aLatest = memberTask(db, ws, { askId, memberId: ma, agent: a, at: new Date(NOW.getTime() + HOUR) });
      memberTask(db, ws, { askId, memberId: ma, agent: a, at: new Date(NOW.getTime() + 2 * HOUR), kind: "followup" });
      const bOnly = memberTask(db, ws, { askId, memberId: mb, agent: b, at: NOW });
      fxTask(db, ws, a, { askId }); // 担当なし
      const rows = listLatestMemberTasks(db, askId);
      expect(rows.map((t) => t.id).sort()).toEqual([aLatest, bOnly].sort());
      expect(rows[0]).not.toHaveProperty("rn");
      expect(rows.find((t) => t.id === aLatest)).toMatchObject({ kind: "normal", ask_member_id: ma, created_at: new Date(NOW.getTime() + HOUR) });
      expect(listLatestMemberTasks(db, newId())).toEqual([]);
    });
  });

  it("markMessagesDelivered は input_message_ids の後ろに足す（空なら何もしない）", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent);
      const [m1, m2, m3] = [newId(), newId(), newId()];
      markMessagesDelivered(db, taskId, [m1, m2], NOW);
      markMessagesDelivered(db, taskId, [], LATER);
      expect(taskRow(db, taskId)).toMatchObject({ input_message_ids: [m1, m2], updated_at: NOW });
      markMessagesDelivered(db, taskId, [m3], LATER);
      expect(taskRow(db, taskId)).toMatchObject({ input_message_ids: [m1, m2, m3], updated_at: LATER });
      expect(count(db, "SELECT count(*) FROM tasks WHERE json_array_length(input_message_ids) > 0")).toBe(1);
    });
  });
});
