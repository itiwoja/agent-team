// 承認・チェック（repo/check.ts）の試験。Postgres 版には試験がなかったので、出している関数ごとに主な流れと大事な守り（状態の条件など）を試す
import { describe, expect, it } from "vitest";
import { verifyAuditChain } from "../../src/db/audit.ts";
import { CODECS } from "../../src/db/codecs.ts";
import {
  applyRuleChange,
  decideApprovalRow,
  decideIntentRow,
  expireDueApprovals,
  getAgentCurrentSnapshot,
  getAnswerRun,
  getApproval,
  getApprovalBundle,
  getApprovalIntent,
  getCheckMark,
  getEndedTaskReportRow,
  getEvolutionReportRow,
  getSkillProposalReportRow,
  hasDueApprovals,
  insertCheckMark,
  isProductionTask,
  listApprovalBundles,
  listCheckMarks,
  listDecidedApprovals,
  listRunningTasks,
  listStalledApprovedIntents,
  listUncheckedAnswers,
  listUncheckedEndedTasks,
  listUncheckedEvolutionEvents,
  listUncheckedSkillProposals,
  listUnknownOutcomeIntents,
  listWaitingAsks,
  listWorkspaceActiveSkills,
  loadApprovalBundles,
  resolveUnknownOutcome,
  type ApplyRuleChangeInput,
} from "../../src/db/repo/check.ts";
import { isCheckViolation, newId, one, run, type WsDb } from "../../src/db/sqlite.ts";
import type { AuditLogRow } from "../../src/db/types.ts";
import { FIXED_NOW, fxAgent, fxApproval, fxAsk, fxAskRun, fxConnector, fxIntent, fxTask, inWorkspace, type FxWorkspace } from "./fixtures.ts";

const NOW = FIXED_NOW;
const at = (s: number) => new Date(NOW.getTime() + s * 1000);

function caught(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** 担当・コネクタ・承認待ちのタスクと Intent・承認 */
function pendingApproval(db: WsDb, ws: FxWorkspace, o: { askId?: string; s?: number } = {}) {
  const agent = fxAgent(db);
  const conn = fxConnector(db, { slug: `c-${newId().slice(0, 6)}` });
  const { taskId } = fxTask(db, ws, agent, { status: "awaiting_approval", askId: o.askId ?? null });
  const { intentId } = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, now: at(o.s ?? 0) });
  const { approvalId } = fxApproval(db, ws, { taskId, intentId, now: at(o.s ?? 0) });
  return { agent, conn, taskId, intentId, approvalId };
}

describe("承認", () => {
  it("一覧・1件のカードの材料（Intent・タスク・担当・依頼・コネクタ・ツール）と絞り込み", async () => {
    await inWorkspace((db, ws) => {
      const { askId } = fxAsk(db, ws, { text: "豆を発注して" });
      const p1 = pendingApproval(db, ws, { askId, s: 0 });
      const p2 = pendingApproval(db, ws, { s: 1 });
      const list = listApprovalBundles(db);
      expect(list.map((b) => b.approval.id)).toEqual([p2.approvalId, p1.approvalId]);
      const b1 = getApprovalBundle(db, p1.approvalId)!;
      expect(b1.intent.id).toBe(p1.intentId);
      expect(b1.task).toMatchObject({ id: p1.taskId, ask_id: askId, tainted: false, is_dry_run: false, status: "awaiting_approval" });
      expect(b1.agentName).toMatch(/^仕入れ係-/);
      expect(b1.askText).toBe("豆を発注して");
      expect(b1.connector?.id).toBe(p1.conn.connectorId);
      expect(b1.tool?.name).toBe("place_order");
      expect(listApprovalBundles(db, { askId }).map((b) => b.approval.id)).toEqual([p1.approvalId]);
      expect(listApprovalBundles(db, { taskId: p2.taskId }).map((b) => b.approval.id)).toEqual([p2.approvalId]);
      expect(listApprovalBundles(db, { status: "approved" })).toEqual([]);
      expect(listApprovalBundles(db, { limit: 1 })).toHaveLength(1);
      // 期限（作った時刻 + 24時間）を過ぎた pending は除ける
      expect(listApprovalBundles(db, { notExpiredAt: at(24 * 3600) }).map((b) => b.approval.id)).toEqual([p2.approvalId]);
      expect(getApprovalBundle(db, newId())).toBeNull();
      expect(loadApprovalBundles(db, [])).toEqual([]);
    });
  });

  it("決めるのは pending・pending_approval のときだけ（二重の決定は false）。決定済みの一覧に入る", async () => {
    await inWorkspace((db, ws) => {
      const p = pendingApproval(db, ws);
      const d = { status: "approved" as const, decidedBy: ws.userId, comment: "ok", remember: false, createdRuleId: null, now: at(1) };
      expect(decideApprovalRow(db, p.approvalId, d)).toBe(true);
      expect(decideApprovalRow(db, p.approvalId, { ...d, status: "rejected" })).toBe(false);
      expect(getApproval(db, p.approvalId)).toMatchObject({ status: "approved", decided_by: ws.userId, decision_comment: "ok", decided_at: at(1) });
      expect(decideIntentRow(db, p.intentId, "approved", at(1))).toBe(true);
      expect(decideIntentRow(db, p.intentId, "rejected", at(2))).toBe(false);
      expect(getApprovalIntent(db, p.intentId)?.status).toBe("approved");
      // remember には created_rule_id が要る（CHECK）
      const p2 = pendingApproval(db, ws);
      expect(isCheckViolation(caught(() => decideApprovalRow(db, p2.approvalId, { ...d, remember: true })), "approvals_remember_chk")).toBe(true);
      expect(listDecidedApprovals(db, { limit: 10 }).map((b) => b.approval.id)).toEqual([p.approvalId]);
      expect(listDecidedApprovals(db, { limit: 10, before: at(1) })).toEqual([]);
    });
  });

  it("expireDueApprovals：期限の来た pending を expired、Intent は approval_timeout（next_run は superseded）。hasDueApprovals", async () => {
    await inWorkspace((db, ws) => {
      const ttl = pendingApproval(db, ws);
      const next = pendingApproval(db, ws);
      const later = pendingApproval(db, ws);
      run(db, "UPDATE approvals SET expires_at = ? WHERE id IN (?, ?)", NOW, ttl.approvalId, next.approvalId);
      run(db, "UPDATE approvals SET expiry_cause = 'next_run' WHERE id = ?", next.approvalId);
      expect(hasDueApprovals(db, at(-1))).toBe(false);
      expect(hasDueApprovals(db, NOW)).toBe(true);
      const r = expireDueApprovals(db, NOW);
      expect(new Set(r.map((x) => x.approvalId))).toEqual(new Set([ttl.approvalId, next.approvalId]));
      expect(getApprovalIntent(db, ttl.intentId)).toMatchObject({ status: "expired", expire_reason: "approval_timeout" });
      expect(getApprovalIntent(db, next.intentId)).toMatchObject({ status: "expired", expire_reason: "superseded" });
      expect(getApproval(db, later.approvalId)?.status).toBe("pending");
      expect(expireDueApprovals(db, NOW)).toEqual([]);
      expect(hasDueApprovals(db, NOW)).toBe(false);
    });
  });

  it("listStalledApprovedIntents：approved のまま止まった本番の Intent。試し実行は除く", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const conn = fxConnector(db);
      const live = fxTask(db, ws, agent, { status: "executing" }).taskId;
      const dry = fxTask(db, ws, agent, { status: "executing", dryRun: true }).taskId;
      const stalled = fxIntent(db, { taskId: live, jobId: agent.jobId, connectorId: conn.connectorId, status: "approved", now: at(-120) }).intentId;
      fxIntent(db, { taskId: live, jobId: agent.jobId, connectorId: conn.connectorId, status: "approved", now: at(0) });
      fxIntent(db, { taskId: dry, jobId: agent.jobId, connectorId: conn.connectorId, status: "approved", now: at(-120) });
      expect(listStalledApprovedIntents(db, at(-60), 10)).toEqual([{ intentId: stalled, userId: ws.userId }]);
    });
  });

  it("getAgentCurrentSnapshot・isProductionTask", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db);
      expect(getAgentCurrentSnapshot(db, agent.agentId)).toMatchObject({ id: agent.snapshotId, status: "valid" });
      expect(getAgentCurrentSnapshot(db, newId())).toBeNull();
      expect(isProductionTask({ is_dry_run: false })).toBe(true);
      expect(isProductionTask({ is_dry_run: true })).toBe(false);
    });
  });
});

describe("チェック済み", () => {
  it("insertCheckMark は1回目だけ時刻を返す（冪等）。一覧は新しい順でカーソルつき。形の違うキーは CHECK", async () => {
    await inWorkspace((db) => {
      const k1 = `task:${newId()}`;
      const k2 = `answer:${newId()}`;
      expect(insertCheckMark(db, k1, NOW)).toEqual(NOW);
      expect(insertCheckMark(db, k1, at(1))).toBeNull();
      expect(insertCheckMark(db, k2, at(1))).toEqual(at(1));
      expect(getCheckMark(db, k1)).toEqual(NOW);
      expect(getCheckMark(db, `task:${newId()}`)).toBeNull();
      expect(listCheckMarks(db, { limit: 10 }).map((m) => m.item_key)).toEqual([k2, k1]);
      expect(listCheckMarks(db, { limit: 10, before: at(1) })).toEqual([{ item_key: k1, checked_at: NOW }]);
      expect(isCheckViolation(caught(() => insertCheckMark(db, "task:not-a-uuid", NOW)), "check_marks_item_key_check")).toBe(true);
    });
  });
});

describe("見てほしいもの", () => {
  it("未チェックの回答（実行で最初に渡した文つき）。チェックしたら消える", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { askId } = fxAsk(db, ws, { text: "依頼の文" });
      const { askRunId } = fxAskRun(db, askId);
      const t1 = fxTask(db, ws, agent, { askId, askRunId, status: "completed", now: at(1) }).taskId;
      const t2 = fxTask(db, ws, agent, { askId, askRunId, status: "completed", now: at(2) }).taskId;
      run(db, "UPDATE tasks SET prompt = ? WHERE id = ?", "最初のお願い", t1);
      run(db, "UPDATE tasks SET prompt = ? WHERE id = ?", "二つ目", t2);
      expect(listUncheckedAnswers(db, 10)).toEqual([]);
      run(db, "UPDATE ask_runs SET answer = ?, answered_at = ? WHERE id = ?", { text: "答え" }, at(3), askRunId);
      const rows = listUncheckedAnswers(db, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ askText: "依頼の文", requestText: "最初のお願い", run: { id: askRunId, answer: { text: "答え" }, answered_at: at(3) } });
      expect(getAnswerRun(db, askRunId)).toEqual(rows[0]);
      insertCheckMark(db, `answer:${askRunId}`, at(4));
      expect(listUncheckedAnswers(db, 10)).toEqual([]);
      expect(getAnswerRun(db, newId())).toBeNull();
    });
  });

  it("スキルの案（proposed で外していない担当だけ）・整理の記録・外していないスキル", async () => {
    await inWorkspace((db) => {
      const agent = fxAgent(db, { name: "受信箱係" });
      const gone = fxAgent(db);
      const proposal = (agentId: string, status: string, s: number) => {
        const id = newId();
        run(
          db,
          `INSERT INTO skill_proposals (id, agent_id, status, name, description, body, created_at, decided_at)
           VALUES (?, ?, ?, '名前', '説明', '本文', ?, ?)`,
          id,
          agentId,
          status,
          at(s),
          status === "approved" ? at(s) : null,
        );
        return id;
      };
      const p1 = proposal(agent.agentId, "proposed", 1);
      const p2 = proposal(agent.agentId, "proposed", 2);
      proposal(agent.agentId, "approved", 3);
      proposal(gone.agentId, "proposed", 4);
      run(db, "UPDATE agents SET status = 'removed' WHERE id = ?", gone.agentId);
      insertCheckMark(db, `skill_proposal:${p2}`, NOW);
      expect(listUncheckedSkillProposals(db, 10).map((r) => [r.proposal.id, r.agentName])).toEqual([[p1, "受信箱係"]]);
      expect(getSkillProposalReportRow(db, p2)?.proposal).toMatchObject({ id: p2, source_task_ids: [], created_at: at(2) });

      const ev = newId();
      run(db, "INSERT INTO agent_evolution_events (id, agent_id, kind, items, created_at) VALUES (?, ?, 'pruned', ?, ?)", ev, agent.agentId, [{ kind: "rule" }], NOW);
      expect(listUncheckedEvolutionEvents(db, 10).map((r) => [r.event.id, r.agentName])).toEqual([[ev, "受信箱係"]]);
      expect(getEvolutionReportRow(db, ev)?.event.items).toEqual([{ kind: "rule" }]);
      insertCheckMark(db, `evolution:${ev}`, NOW);
      expect(listUncheckedEvolutionEvents(db, 10)).toEqual([]);

      const skill = (name: string, removed: boolean) =>
        run(db, "INSERT INTO agent_skills (id, agent_id, name, description, body, removed_at) VALUES (?, ?, ?, '説明', '本文', ?)", newId(), agent.agentId, name, removed ? NOW : null);
      skill("b-スキル", false);
      skill("a-スキル", false);
      skill("c-スキル", true);
      expect(listWorkspaceActiveSkills(db).map((s) => s.name)).toEqual(["a-スキル", "b-スキル"]);
    });
  });

  it("未チェックの、依頼に属さない本番の仕事の終了（試し実行・依頼のタスクは入らない）", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { askId } = fxAsk(db, ws);
      const { askRunId } = fxAskRun(db, askId);
      const done = fxTask(db, ws, agent, { status: "completed", now: at(1) }).taskId;
      const failed = fxTask(db, ws, agent, { status: "failed", now: at(2) }).taskId;
      fxTask(db, ws, agent, { status: "completed", dryRun: true });
      fxTask(db, ws, agent, { status: "completed", askId, askRunId });
      fxTask(db, ws, agent, { status: "running" });
      expect(listUncheckedEndedTasks(db, 10).map((r) => r.task.id)).toEqual([failed, done]);
      insertCheckMark(db, `task:${failed}`, NOW);
      expect(listUncheckedEndedTasks(db, 10).map((r) => r.task.id)).toEqual([done]);
      expect(getEndedTaskReportRow(db, done)?.agentName).toMatch(/^仕入れ係-/);
      expect(getEndedTaskReportRow(db, failed)?.task.status).toBe("failed");
    });
  });

  it("聞き返し待ちの依頼・届いたか分からない書き込み", async () => {
    await inWorkspace((db, ws) => {
      const { askId } = fxAsk(db, ws, { status: "waiting_input", text: "店を選んで" });
      fxAsk(db, ws, { status: "waiting_input" });
      const question = { text: "どの店？", choices: [{ id: "a", label: "駅前" }], allowFreeText: true };
      run(db, "UPDATE asks SET question = ?, updated_at = ? WHERE id = ?", question, NOW, askId);
      expect(listWaitingAsks(db, 10)).toEqual([{ askId, text: "店を選んで", question, updatedAt: NOW }]);

      const agent = fxAgent(db);
      const conn = fxConnector(db);
      const { taskId } = fxTask(db, ws, agent, { status: "executing", askId });
      const unknown = fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "unknown_outcome" }).intentId;
      const rows = listUnknownOutcomeIntents(db, 10);
      expect(rows.map((r) => [r.intent.id, r.agentId, r.askId])).toEqual([[unknown, agent.agentId, askId]]);
      expect(rows[0]?.intent.enforced).toBe(true);
    });
  });

  it("resolveUnknownOutcome：まだ確定していない unknown_outcome だけ。届いた・届いていない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const conn = fxConnector(db);
      const { taskId } = fxTask(db, ws, agent, { status: "executing" });
      const mk = () => fxIntent(db, { taskId, jobId: agent.jobId, connectorId: conn.connectorId, status: "unknown_outcome" }).intentId;
      const a = mk();
      const b = mk();
      expect(resolveUnknownOutcome(db, a, "executed", NOW)).toBe(true);
      expect(resolveUnknownOutcome(db, a, "failed", NOW)).toBe(false);
      expect(getApprovalIntent(db, a)).toMatchObject({ status: "executed", resolution: "confirmed_delivered" });
      expect(resolveUnknownOutcome(db, b, "failed", NOW)).toBe(true);
      expect(getApprovalIntent(db, b)).toMatchObject({ status: "failed", fail_reason: "confirmed_not_delivered", resolution: "confirmed_not_delivered" });
      expect(listUnknownOutcomeIntents(db, 10)).toEqual([]);
    });
  });
});

describe("やっていること", () => {
  it("動いている本番のタスクと最後に呼んだツール（awaiting_approval・試し実行・終わったものは入らない）", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const running = fxTask(db, ws, agent, { status: "running", now: at(1) }).taskId;
      const queued = fxTask(db, ws, agent, { status: "queued", now: at(2) }).taskId;
      fxTask(db, ws, agent, { status: "awaiting_approval" });
      fxTask(db, ws, agent, { status: "running", dryRun: true });
      fxTask(db, ws, agent, { status: "completed" });
      run(db, "INSERT INTO task_events (task_id, type, payload) VALUES (?, 'tool_called', ?), (?, 'tool_called', ?)", running, { tool: "web_search" }, running, { tool: "read_file" });
      const rows = listRunningTasks(db, 10);
      expect(rows.map((r) => [r.taskId, r.status, r.lastTool])).toEqual([
        [queued, "queued", null],
        [running, "running", "read_file"],
      ]);
      expect(rows[1]).toMatchObject({ agentId: agent.agentId, requesterId: ws.userId, startedAt: at(1), askId: null });
    });
  });
});

describe("[以後も許可]", () => {
  it("applyRuleChange：設定変更（widen・applied）と新しいスナップショットを作って今のものにし、監査ログを足す。古いスナップショットなら null", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const { taskId } = fxTask(db, ws, agent, { status: "awaiting_approval" });
      const input: ApplyRuleChangeInput = {
        agentId: agent.agentId,
        jobId: agent.jobId,
        patch: [{ op: "add", path: "/rules/-", value: { id: "r-7f3a" } }],
        widenedItems: [{ kind: "rule", id: "r-7f3a" }],
        expectedSnapshotId: agent.snapshotId,
        definition: { version: 2, name: "x", rules: [{ id: "r-7f3a" }] },
        effectivePolicies: {},
        clamped: [],
        ceilingsVersion: "0-H.1",
        decidedBy: ws.userId,
        sourceTaskId: taskId,
        rule: { id: "r-7f3a", sourceIntentId: newId(), createdWhileTainted: false },
        now: NOW,
      };
      const r = applyRuleChange(db, input)!;
      expect(getAgentCurrentSnapshot(db, agent.agentId)).toMatchObject({ id: r.snapshotId, config_change_id: r.changeId, definition: input.definition });
      const change = one<{ status: string; classification: string; origin: string; snapshot_id: string; decided_at: Date; patch: unknown }>(
        db,
        CODECS.agent_config_changes,
        "SELECT * FROM agent_config_changes WHERE id = ?",
        r.changeId,
      );
      expect(change).toMatchObject({ status: "applied", classification: "widen", origin: "approval_rule", snapshot_id: r.snapshotId, decided_at: NOW, patch: input.patch });
      const log = one<AuditLogRow>(db, CODECS.audit_logs, "SELECT * FROM audit_logs ORDER BY seq DESC LIMIT 1")!;
      expect(log).toMatchObject({ event_type: "agent.config.widened", actor_id: ws.userId, payload: { changeId: r.changeId, previousSnapshotId: agent.snapshotId, ruleId: "r-7f3a" } });
      expect(verifyAuditChain(db).ok).toBe(true);
      // 判定のときのスナップショットが今のものでなければ何もしない
      expect(applyRuleChange(db, input)).toBeNull();
      expect(applyRuleChange(db, { ...input, agentId: newId() })).toBeNull();
    });
  });
});
