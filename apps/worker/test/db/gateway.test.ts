// gateway（書き込みの唯一の出口）の問い合わせの試験（apps/worker/src/db/repo/gateway.ts）。
// Postgres 版には試験がなかったので新しく書いた。Intent・承認・タスクの状態の移り変わりの条件を中心に見る
import { describe, expect, it } from "vitest";
import { appendAuditLog } from "../../src/db/audit.ts";
import { CODECS } from "../../src/db/codecs.ts";
import {
  completeIntent,
  expireIntentsForTool,
  getApprovalOfIntent,
  getConnector,
  getConnectorTool,
  getIntent,
  insertConnectorTool,
  listConnectorTools,
  listKernelDecisionsOfIntent,
  listKillSwitchEngagedSeqs,
  listTaskAuditEvents,
  locateConnector,
  locateIntent,
  lockIntent,
  lockTask,
  markConnectorSynced,
  markIntentExecuting,
  markToolNeedsReview,
  PRESEND_RETRY_MAX,
  recomputeTaskStatus,
  recordGatewayDecision,
  recordPresendFailure,
  resolveTaskByToken,
  TASK_TOKEN_MAX_LENGTH,
  updateToolAnnotations,
} from "../../src/db/repo/gateway.ts";
import { all, count, isCheckViolation, isUniqueViolation, newId, one, run, type WsDb } from "../../src/db/sqlite.ts";
import { hashTaskToken } from "../../src/db/tokens.ts";
import type { ActionIntentRow, ApprovalRow, ConnectorToolRow, IntentStatus, TaskEventRow, TaskRow, TaskStatus, Uuid } from "../../src/db/types.ts";
import { FIXED_NOW, fxAgent, fxApproval, fxConnector, fxHash, fxIntent, fxTask, fxToolHash, inWorkspace, type FxWorkspace } from "./fixtures.ts";

const NOW = FIXED_NOW;
const LATER = new Date(NOW.getTime() + 60_000);
const TOKEN = "tok-0123456789abcdef";

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

/** コネクタ・担当・タスク（トークンつき）をそろえる */
function setup(db: WsDb, ws: FxWorkspace, o: { status?: TaskStatus; dryRun?: boolean; expiresAt?: Date } = {}) {
  const c = fxConnector(db);
  const agent = fxAgent(db);
  const { taskId } = fxTask(db, ws, agent, { status: o.status ?? "awaiting_approval", dryRun: o.dryRun });
  run(db, "UPDATE tasks SET task_token_hash = ?, task_token_expires_at = ? WHERE id = ?", hashTaskToken(TOKEN), o.expiresAt ?? LATER, taskId);
  const intent = (status: IntentStatus = "pending_approval") => fxIntent(db, { taskId, jobId: agent.jobId, connectorId: c.connectorId, status }).intentId;
  return { c, agent, taskId, intent };
}

function intentRow(db: WsDb, id: Uuid): ActionIntentRow {
  return one<ActionIntentRow>(db, CODECS.action_intents, "SELECT * FROM action_intents WHERE id = ?", id)!;
}
function taskRow(db: WsDb, id: Uuid): TaskRow {
  return one<TaskRow>(db, CODECS.tasks, "SELECT * FROM tasks WHERE id = ?", id)!;
}

describe("入口の引き直し", () => {
  it("トークンからタスクを引き直す。空・長すぎる・知らない・期限ちょうど・失効は UNAUTHORIZED", async () => {
    await inWorkspace((db, ws) => {
      const { agent, taskId } = setup(db, ws, { status: "running" });
      expect(resolveTaskByToken(db, TOKEN, NOW)).toEqual({
        ok: true,
        task: { taskId, jobId: agent.jobId, agentId: agent.agentId, status: "running", isDryRun: false, killSwitchEngaged: false },
      });
      for (const bad of [null, undefined, "", "   ", "x".repeat(TASK_TOKEN_MAX_LENGTH + 1), "unknown-token"]) {
        expect(resolveTaskByToken(db, bad, NOW)).toEqual({ ok: false, error: "UNAUTHORIZED" });
      }
      // 期限ちょうどは無効・1ms 前は有効
      expect(resolveTaskByToken(db, TOKEN, LATER)).toEqual({ ok: false, error: "UNAUTHORIZED" });
      expect(resolveTaskByToken(db, TOKEN, new Date(LATER.getTime() - 1)).ok).toBe(true);
      // 失効（NULL）
      run(db, "UPDATE tasks SET task_token_hash = NULL, task_token_expires_at = NULL WHERE id = ?", taskId);
      expect(resolveTaskByToken(db, TOKEN, NOW)).toEqual({ ok: false, error: "UNAUTHORIZED" });
    });
  });

  it("Kill Switch は kill_switch、終了状態は task_terminated の TASK_HALTED（Kill Switch が先）", async () => {
    await inWorkspace((db, ws) => {
      const { taskId } = setup(db, ws, { status: "running" });
      run(db, "UPDATE tasks SET status = 'failed', fail_reason = 'agent_unable', finished_at = ? WHERE id = ?", NOW, taskId);
      const terminated = resolveTaskByToken(db, TOKEN, NOW);
      expect(terminated).toMatchObject({ ok: false, error: "TASK_HALTED", haltReason: "task_terminated", task: { taskId, status: "failed" } });
      run(db, "UPDATE workspace SET kill_switch_engaged = 1, kill_switch_engaged_at = ? WHERE id = 1", NOW);
      expect(resolveTaskByToken(db, TOKEN, NOW)).toMatchObject({ ok: false, error: "TASK_HALTED", haltReason: "kill_switch", task: { killSwitchEngaged: true } });
    });
  });

  it("Intent・コネクタの ID から行を引き直す。知らない ID は null", async () => {
    await inWorkspace((db, ws) => {
      const { c, taskId, intent } = setup(db, ws);
      const id = intent();
      expect(locateIntent(db, id)).toEqual({ taskId });
      expect(locateIntent(db, newId())).toBeNull();
      expect(locateConnector(db, c.connectorId)).toEqual({ connectorId: c.connectorId });
      expect(locateConnector(db, newId())).toBeNull();
    });
  });
});

describe("コネクタとツール", () => {
  it("読むだけの関数", async () => {
    await inWorkspace((db) => {
      const c = fxConnector(db);
      expect(getConnector(db, c.connectorId)).toMatchObject({ slug: "supplier", enabled: true, auth: { type: "none" } });
      expect(getConnector(db, newId())).toBeNull();
      expect(getConnectorTool(db, c.connectorId, "place_order")).toMatchObject({ classification: "write", tool_hash: c.tools.place_order!.toolHash });
      expect(getConnectorTool(db, c.connectorId, "nope")).toBeNull();
      expect(listConnectorTools(db, c.connectorId).map((t) => t.name)).toEqual(["list_products", "place_order"]);
    });
  });

  it("新しいツールは unclassified・ok で足し、同じ名前は一意の違反。needs_review・注釈・同期の時刻", async () => {
    await inWorkspace((db) => {
      const c = fxConnector(db);
      const def = { name: "cancel_order", description: "取り消す", inputSchema: { type: "object" }, annotations: { destructiveHint: true } };
      const id = insertConnectorTool(db, c.connectorId, def, fxToolHash("supplier.cancel_order"), NOW);
      const t = one<ConnectorToolRow>(db, CODECS.connector_tools, "SELECT * FROM connector_tools WHERE id = ?", id)!;
      expect(t).toMatchObject({ classification: "unclassified", status: "ok", arg_roles: {}, scope: null, verify: "none", input_schema: { type: "object" }, annotations: { destructiveHint: true }, pending: null });
      expect(isUniqueViolation(caught(() => insertConnectorTool(db, c.connectorId, def, fxToolHash("x"), NOW)), "connector_tools.connector_id, connector_tools.name")).toBe(true);
      // 注釈が null・文字列でも JSON として入る
      const id2 = insertConnectorTool(db, c.connectorId, { ...def, name: "plain", inputSchema: "s", annotations: null }, fxToolHash("p"), NOW);
      expect(one<ConnectorToolRow>(db, CODECS.connector_tools, "SELECT * FROM connector_tools WHERE id = ?", id2)).toMatchObject({ input_schema: "s", annotations: null });

      // pending は needs_review のときだけ（CHECK）。確定した定義は変えない
      const pending = { description: "新しい説明", inputSchema: { type: "object", x: 1 }, annotations: null, detectedAt: NOW.toISOString() };
      markToolNeedsReview(db, id, pending, LATER);
      expect(getConnectorTool(db, c.connectorId, "cancel_order")).toMatchObject({ status: "needs_review", pending, description: "取り消す", updated_at: LATER });
      markToolNeedsReview(db, id2, null, LATER);
      expect(getConnectorTool(db, c.connectorId, "plain")).toMatchObject({ status: "needs_review", pending: null });
      expect(isCheckViolation(caught(() => run(db, `UPDATE connector_tools SET status = 'ok' WHERE id = ?`, id)), "connector_tools_pending_chk")).toBe(true);

      updateToolAnnotations(db, id, { readOnlyHint: true }, LATER);
      expect(getConnectorTool(db, c.connectorId, "cancel_order")?.annotations).toEqual({ readOnlyHint: true });
      markConnectorSynced(db, c.connectorId, LATER);
      expect(getConnector(db, c.connectorId)).toMatchObject({ last_synced_at: LATER, updated_at: LATER });
    });
  });
});

describe("実行の状態の遷移", () => {
  it("lockTask・lockIntent は行を読むだけ。知らない ID は null", async () => {
    await inWorkspace((db, ws) => {
      const { agent, taskId, intent } = setup(db, ws);
      const id = intent();
      expect(lockTask(db, taskId)).toEqual({ id: taskId, job_id: agent.jobId, agent_id: agent.agentId, status: "awaiting_approval", is_dry_run: false, halt_reason: null });
      expect(lockTask(db, newId())).toBeNull();
      expect(lockIntent(db, id)).toEqual(getIntent(db, id));
      expect(getIntent(db, newId())).toBeNull();
    });
  });

  it("markIntentExecuting は approved のときだけ executing にする（二重のジョブの片方だけ）", async () => {
    await inWorkspace((db, ws) => {
      const { intent } = setup(db, ws);
      const pending = intent("pending_approval");
      expect(markIntentExecuting(db, pending, NOW)).toBe(false);
      expect(intentRow(db, pending).status).toBe("pending_approval");
      const approved = intent("approved");
      expect(markIntentExecuting(db, approved, LATER)).toBe(true);
      expect(intentRow(db, approved)).toMatchObject({ status: "executing", updated_at: LATER });
      expect(markIntentExecuting(db, approved, LATER)).toBe(false);
    });
  });

  it("recordPresendFailure は3回まで approved に戻して数え、4回目で failed(unreachable)。from が違えば skipped", async () => {
    await inWorkspace((db, ws) => {
      const { intent } = setup(db, ws);
      const id = intent("approved");
      expect(recordPresendFailure(db, id, "executing", { error: "x" }, NOW)).toEqual({ retry: false, attempts: 0, skipped: true });
      expect(recordPresendFailure(db, newId(), "approved", { error: "x" }, NOW)).toEqual({ retry: false, attempts: 0, skipped: true });
      for (let i = 1; i <= PRESEND_RETRY_MAX; i++) {
        // 交互に、送る前（approved のまま）と送信の前（executing）の失敗
        if (i % 2 === 0) expect(markIntentExecuting(db, id, NOW)).toBe(true);
        expect(recordPresendFailure(db, id, i % 2 === 0 ? "executing" : "approved", { error: `e${i}` }, NOW)).toEqual({ retry: true, attempts: i });
        expect(intentRow(db, id)).toMatchObject({ status: "approved", presend_attempts: i });
      }
      expect(recordPresendFailure(db, id, "approved", { error: "last" }, LATER)).toEqual({ retry: false, attempts: PRESEND_RETRY_MAX });
      expect(intentRow(db, id)).toMatchObject({ status: "failed", fail_reason: "unreachable", result: { error: "last" }, presend_attempts: PRESEND_RETRY_MAX, updated_at: LATER });
      // 終わったあとは何もしない
      expect(recordPresendFailure(db, id, "approved", { error: "again" }, LATER)).toMatchObject({ skipped: true });
    });
  });

  it("completeIntent は from のどれかのときだけ書く。executed は executed_at、failed・expired は理由、result が null なら元の値を残す", async () => {
    await inWorkspace((db, ws) => {
      const { intent } = setup(db, ws);
      const a = intent("executing");
      expect(completeIntent(db, a, ["approved"], { status: "executed", result: { ok: 1 } }, NOW)).toBe(false);
      expect(intentRow(db, a).status).toBe("executing");
      expect(completeIntent(db, a, ["approved", "executing"], { status: "executed", result: { ok: 1 } }, LATER)).toBe(true);
      expect(intentRow(db, a)).toMatchObject({ status: "executed", result: { ok: 1 }, executed_at: LATER, updated_at: LATER, fail_reason: null, expire_reason: null });
      // 終了したあとは書かない
      expect(completeIntent(db, a, ["executing"], { status: "failed", failReason: "tool_error", result: "x" }, LATER)).toBe(false);

      const b = intent("executing");
      expect(completeIntent(db, b, ["executing"], { status: "failed", failReason: "tool_error", result: "boom" }, LATER)).toBe(true);
      expect(intentRow(db, b)).toMatchObject({ status: "failed", fail_reason: "tool_error", result: "boom", executed_at: null });

      const c = intent("executing");
      expect(completeIntent(db, c, ["executing"], { status: "unknown_outcome", result: [1, 2] }, LATER)).toBe(true);
      expect(intentRow(db, c)).toMatchObject({ status: "unknown_outcome", result: [1, 2] });

      const d = intent("approved");
      run(db, `UPDATE action_intents SET result = '{"before":true}' WHERE id = ?`, d);
      expect(completeIntent(db, d, ["approved"], { status: "expired", expireReason: "tool_changed", result: null }, LATER)).toBe(true);
      expect(intentRow(db, d)).toMatchObject({ status: "expired", expire_reason: "tool_changed", result: { before: true } });
    });
  });
});

describe("タスクの状態の決め直し", () => {
  function events(db: WsDb, taskId: Uuid): TaskEventRow[] {
    return all<TaskEventRow>(db, CODECS.task_events, "SELECT * FROM task_events WHERE task_id = ? ORDER BY id", taskId);
  }

  it("すべて executed なら succeeded にし、トークンを失効させ、事象と監査ログを書く", async () => {
    await inWorkspace((db, ws) => {
      const { taskId, intent } = setup(db, ws, { status: "executing" });
      intent("executed");
      expect(recomputeTaskStatus(db, taskId, LATER)).toEqual({ changed: true, from: "executing", to: "succeeded", terminal: true });
      expect(taskRow(db, taskId)).toMatchObject({ status: "succeeded", finished_at: LATER, task_token_hash: null, task_token_expires_at: null, status_detail: null, fail_reason: null });
      expect(events(db, taskId).map((e) => [e.type, e.payload])).toEqual([
        ["status_changed", { from: "executing", to: "succeeded" }],
        ["finished", { outcome: "succeeded" }],
      ]);
      expect(listTaskAuditEvents(db, taskId)).toEqual([
        expect.objectContaining({ event_type: "task.status_changed", actor_type: "system", actor_id: "gateway", payload: { taskId, from: "executing", to: "succeeded" } }),
      ]);
      expect(resolveTaskByToken(db, TOKEN, NOW)).toEqual({ ok: false, error: "UNAUTHORIZED" });
      // 2回目は変えない（終了状態は最終）
      expect(recomputeTaskStatus(db, taskId, LATER)).toEqual({ changed: false, from: "succeeded", to: "succeeded", terminal: false });
    });
  });

  it("failed・unknown_outcome があれば failed(action_failed)、断られたものがあれば completed(actions_declined)", async () => {
    await inWorkspace((db, ws) => {
      const f = setup(db, ws, { status: "executing" });
      f.intent("executed");
      f.intent("unknown_outcome");
      expect(recomputeTaskStatus(db, f.taskId, LATER)).toMatchObject({ to: "failed", terminal: true });
      expect(taskRow(db, f.taskId)).toMatchObject({ status: "failed", fail_reason: "action_failed" });
      expect(events(db, f.taskId).at(-1)?.payload).toEqual({ outcome: "failed", failReason: "action_failed" });

      const agent = fxAgent(db);
      const c = fxConnector(db, { slug: "other" });
      const { taskId } = fxTask(db, ws, agent, { status: "awaiting_approval" });
      fxIntent(db, { taskId, jobId: agent.jobId, connectorId: c.connectorId, status: "rejected" });
      expect(recomputeTaskStatus(db, taskId, LATER)).toMatchObject({ to: "completed", terminal: true });
      expect(taskRow(db, taskId)).toMatchObject({ status: "completed", status_detail: "actions_declined", fail_reason: null });
    });
  });

  it("承認待ちが残れば awaiting_approval、approved・executing が残れば executing（終了しない・トークンは残す）", async () => {
    await inWorkspace((db, ws) => {
      const { taskId, intent } = setup(db, ws, { status: "awaiting_approval" });
      const a = intent("approved");
      intent("executed");
      expect(recomputeTaskStatus(db, taskId, LATER)).toEqual({ changed: true, from: "awaiting_approval", to: "executing", terminal: false });
      expect(taskRow(db, taskId)).toMatchObject({ status: "executing", finished_at: null });
      expect(taskRow(db, taskId).task_token_hash).not.toBeNull();
      expect(events(db, taskId).map((e) => e.type)).toEqual(["status_changed"]);
      // 同じ状態なら何も書かない
      expect(recomputeTaskStatus(db, taskId, LATER)).toEqual({ changed: false, from: "executing", to: "executing", terminal: false });
      expect(events(db, taskId)).toHaveLength(1);
      run(db, "UPDATE action_intents SET status = 'pending_approval', expires_at = ? WHERE id = ?", LATER, a);
      expect(recomputeTaskStatus(db, taskId, LATER)).toMatchObject({ to: "awaiting_approval", terminal: false });
    });
  });

  it("ループが終わっていない（running）なら変えない。試し実行は completed(dry_run)。ないタスクは null", async () => {
    await inWorkspace((db, ws) => {
      const r = setup(db, ws, { status: "running" });
      r.intent("executed");
      expect(recomputeTaskStatus(db, r.taskId, LATER)).toEqual({ changed: false, from: "running", to: "running", terminal: false });

      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent, { status: "awaiting_approval", dryRun: true });
      expect(recomputeTaskStatus(db, taskId, LATER)).toMatchObject({ to: "completed", terminal: true });
      expect(taskRow(db, taskId).status_detail).toBe("dry_run");
      expect(recomputeTaskStatus(db, newId(), LATER)).toBeNull();
    });
  });
});

describe("ツールの変化で Intent を失効させる", () => {
  it("そのツールの承認待ちと approved を expired(tool_changed) にし、承認待ちの承認も expired。executing・別のツールはそのまま", async () => {
    await inWorkspace((db, ws) => {
      const { c, agent, taskId: t1, intent } = setup(db, ws, { status: "awaiting_approval" });
      const pending = intent("pending_approval");
      const { approvalId } = fxApproval(db, ws, { taskId: t1, intentId: pending });
      const approved = intent("approved");
      const { approvalId: decided } = fxApproval(db, ws, { taskId: t1, intentId: approved, status: "approved" });

      const { taskId: t2 } = fxTask(db, ws, agent, { status: "executing" });
      const executing = fxIntent(db, { taskId: t2, jobId: agent.jobId, connectorId: c.connectorId, status: "executing" }).intentId;
      const other = fxIntent(db, { taskId: t2, jobId: agent.jobId, connectorId: c.connectorId, status: "pending_approval" }).intentId;
      run(db, `UPDATE action_intents SET payload = json_set(payload, '$.tool', 'list_products') WHERE id = ?`, other);
      const { approvalId: otherApproval } = fxApproval(db, ws, { taskId: t2, intentId: other });

      const out = expireIntentsForTool(db, { connectorId: c.connectorId, name: "place_order" }, LATER);
      const expected = [
        { intentId: pending, taskId: t1, approvalId },
        { intentId: approved, taskId: t1, approvalId: null },
      ].sort((a, b) => (a.intentId < b.intentId ? -1 : 1));
      expect(out).toEqual(expected);

      for (const id of [pending, approved]) {
        expect(intentRow(db, id)).toMatchObject({ status: "expired", expire_reason: "tool_changed", result: { reasonCode: "tool_changed", tool: "place_order" }, updated_at: LATER });
      }
      expect(intentRow(db, executing).status).toBe("executing");
      expect(intentRow(db, other).status).toBe("pending_approval");
      const approvalStatus = (id: Uuid) => one<ApprovalRow>(db, CODECS.approvals, "SELECT * FROM approvals WHERE id = ?", id)!.status;
      expect(approvalStatus(approvalId)).toBe("expired");
      expect(approvalStatus(decided)).toBe("approved");
      expect(approvalStatus(otherApproval)).toBe("pending");

      // 監査ログ：承認があれば approval.expired、なければ intent.expired。そのあとタスクの状態
      const log = listTaskAuditEvents(db, t1).map((e) => [e.event_type, e.payload]);
      expect(log).toContainEqual(["approval.expired", { approvalId, intentId: pending, taskId: t1, reason: "tool_changed" }]);
      expect(log).toContainEqual(["intent.expired", { intentId: approved, taskId: t1, reason: "tool_changed" }]);
      expect(log.at(-1)).toEqual(["task.status_changed", { taskId: t1, from: "awaiting_approval", to: "completed", detail: "actions_declined" }]);
      expect(taskRow(db, t1)).toMatchObject({ status: "completed", status_detail: "actions_declined" });
      expect(taskRow(db, t2).status).toBe("executing");
      expect(listTaskAuditEvents(db, t2)).toEqual([]);

      // 2回目は何もしない
      expect(expireIntentsForTool(db, { connectorId: c.connectorId, name: "place_order" }, LATER)).toEqual([]);
    });
  });

  it("途中で失敗したらまとめて戻る（承認・Intent・監査ログ）", async () => {
    await inWorkspace((db, ws) => {
      const { c, taskId, intent } = setup(db, ws);
      const pending = intent("pending_approval");
      const { approvalId } = fxApproval(db, ws, { taskId, intentId: pending });
      const seq = count(db, "SELECT audit_seq FROM workspace WHERE id = 1");
      // 監査ログの追記を壊す（approval.expired の行だけ止めるトリガー）
      run(db, "CREATE TRIGGER t_fail BEFORE INSERT ON audit_logs WHEN NEW.event_type = 'approval.expired' BEGIN SELECT RAISE(ABORT, 'boom'); END");
      expect(() => expireIntentsForTool(db, { connectorId: c.connectorId, name: "place_order" }, LATER)).toThrow(/boom/);
      expect(intentRow(db, pending).status).toBe("pending_approval");
      expect(getApprovalOfIntent(db, pending)).toMatchObject({ id: approvalId, status: "pending" });
      expect(count(db, "SELECT audit_seq FROM workspace WHERE id = 1")).toBe(seq);
    });
  });
});

describe("gateway の判定の記録と承認の出どころ", () => {
  it("recordGatewayDecision は deny の行と decision.made を残し、Kernel の判定の一覧には入らない", async () => {
    await inWorkspace((db, ws) => {
      const { taskId, intent } = setup(db, ws);
      const id = intent("approved");
      // edge が書いた Kernel の判定（gate なし）
      run(
        db,
        `INSERT INTO policy_decisions (id, task_id, intent_id, subject_kind, subject, counters, flags, decision, reason_code, inputs_hash, kernel_version, created_at)
         VALUES (?, ?, ?, 'intent', '{"action":"mcp.supplier.place_order"}', '{}', '{}', 'approve', 'approval_required', ?, '0.1.0', ?)`,
        newId(),
        taskId,
        id,
        fxHash("kernel"),
        NOW,
      );
      recordGatewayDecision(
        db,
        {
          taskId,
          intentId: id,
          subjectKind: "intent",
          operation: "mcp_write",
          subject: { action: "mcp.supplier.place_order", tool: "place_order" },
          inputs: { boundary: "x" },
          reasonCode: "tool_changed",
          matchedRule: "gateway.tool_changed",
          enforced: true,
        },
        LATER,
      );
      const rows = all<{ decision: string; subject: unknown; flags: unknown; enforced: boolean }>(
        db,
        CODECS.policy_decisions,
        "SELECT decision, subject, flags, enforced FROM policy_decisions WHERE json_extract(subject, '$.gate') = 'gateway'",
      );
      expect(rows).toEqual([{ decision: "deny", subject: { gate: "gateway", action: "mcp.supplier.place_order", tool: "place_order" }, flags: { boundary: "x" }, enforced: true }]);
      const kernel = listKernelDecisionsOfIntent(db, { id, task_id: taskId });
      expect(kernel.map((d) => d.decision)).toEqual(["approve"]);
      expect(listKernelDecisionsOfIntent(db, { id, task_id: newId() })).toEqual([]);
      expect(listTaskAuditEvents(db, taskId).map((e) => e.payload)).toEqual([
        { taskId, intentId: id, decision: "deny", reasonCode: "tool_changed", matchedRule: "gateway.tool_changed", enforced: true, source: "gateway", action: "mcp.supplier.place_order", tool: "place_order" },
      ]);
    });
  });

  it("承認の行・監査ログの Kill Switch の seq を読む", async () => {
    await inWorkspace((db, ws) => {
      const { taskId, intent } = setup(db, ws);
      const id = intent();
      expect(getApprovalOfIntent(db, id)).toBeNull();
      const { approvalId } = fxApproval(db, ws, { taskId, intentId: id });
      expect(getApprovalOfIntent(db, id)).toMatchObject({ id: approvalId, status: "pending", approver_ids: [ws.userId] });
      expect(listKillSwitchEngagedSeqs(db)).toEqual([]);
      const a = appendAuditLog(db, { eventType: "killswitch.engaged", actorType: "user", actorId: ws.userId, payload: {} }, NOW);
      appendAuditLog(db, { eventType: "killswitch.released", actorType: "user", actorId: ws.userId, payload: {} }, NOW);
      const b = appendAuditLog(db, { eventType: "killswitch.engaged", actorType: "user", actorId: ws.userId, payload: {} }, LATER);
      expect(listKillSwitchEngagedSeqs(db)).toEqual([a.seq, b.seq]);
    });
  });
});
