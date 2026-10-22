// 依頼（repo/asks.ts）の試験。Postgres 版には試験がなかったので、出している関数ごとに主な流れと大事な守り（状態の条件・一意の違反など）を試す
import { describe, expect, it } from "vitest";
import {
  answerAgentQuestion,
  appendAgentSnapshot,
  bumpPlannerAttempts,
  claimQueuedTask,
  countAskMessages,
  countOpenRunTasks,
  countPriorAsksOfAgents,
  countRejectedIntentsOfTasks,
  expireAgentQuestion,
  expireQuestionsOfTask,
  findLiveAgentByIdOrName,
  firstPromptsOfRuns,
  getAgentQuestion,
  getAsk,
  getAskRun,
  getLatestLiveRun,
  getPreviousReportTask,
  hasActiveLiveRun,
  hasFollowupForMessage,
  insertAgentQuestion,
  insertAskMessage,
  insertAskTask,
  insertFollowupTask,
  insertGeneratingAsk,
  insertLiveRun,
  insertPendingReply,
  listActiveLiveRuns,
  listAgentQuestions,
  listAgentsForPlanner,
  listAskMessages,
  listAsks,
  listLiveRuns,
  listMembers,
  listPendingIntentsOfTasks,
  listPendingReplies,
  listRunTasks,
  listToolActivityOfTasks,
  listUnansweredQuestionsTo,
  markAskFormed,
  markAskGenerationFailed,
  markFirstMemberStarted,
  markPendingReplyConsumed,
  peekPendingReply,
  plannerUsageOf,
  saveRunAnswer,
  setAskNextRun,
  setAskQuestion,
  setAskQuestionAnswer,
  sumAskCostMicroUsd,
  transitionAsk,
  transitionRun,
} from "../../src/db/repo/asks.ts";
import { isCheckViolation, isUniqueViolation, newId, run, type WsDb } from "../../src/db/sqlite.ts";
import type { Uuid } from "../../src/db/types.ts";
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
  fxUsage,
  inWorkspace,
  type FxAgent,
  type FxWorkspace,
} from "./fixtures.ts";

const NOW = FIXED_NOW;
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const QUESTION = { text: "どの店？", choices: [{ id: "a", label: "駅前" }], allowFreeText: true };

function caught(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** 依頼・実行・担当2人（1段目と窓口の2段目） */
function team(db: WsDb, ws: FxWorkspace) {
  const a = fxAgent(db, { name: "受信箱係" });
  const b = fxAgent(db, { name: "仕入れ係" });
  const { askId } = fxAsk(db, ws);
  const { askRunId } = fxAskRun(db, askId);
  const ma = fxAskMember(db, { askId, agent: a, position: 1 }).memberId;
  const mb = fxAskMember(db, { askId, agent: b, position: 2, isSpokesperson: true }).memberId;
  const ta = fxTask(db, ws, a, { askId, askRunId, status: "completed", now: at(-2) }).taskId;
  const tb = fxTask(db, ws, b, { askId, askRunId, status: "running", now: at(-1) }).taskId;
  run(db, "UPDATE asks SET created_at = ? WHERE id = ?", NOW, askId);
  run(db, "UPDATE tasks SET ask_member_id = ? WHERE id = ?", ma, ta);
  run(db, "UPDATE tasks SET ask_member_id = ? WHERE id = ?", mb, tb);
  return { a, b, askId, askRunId, ma, mb, ta, tb };
}

function askTask(db: WsDb, ws: FxWorkspace, agent: FxAgent, t: { askId: Uuid; askRunId: Uuid; memberId: Uuid; prompt?: string | null; now?: Date }) {
  return insertAskTask(db, {
    requesterId: ws.userId,
    agentId: agent.agentId,
    agentSnapshotId: agent.snapshotId,
    jobId: agent.jobId,
    askId: t.askId,
    askRunId: t.askRunId,
    askMemberId: t.memberId,
    inputTaskIds: [],
    taint: { tainted: false, sources: [] },
    prompt: t.prompt === undefined ? "お願い" : t.prompt,
    now: t.now ?? NOW,
  });
}

describe("依頼の状態", () => {
  it("生成中で作り、質問・答え・編成で running へ。どれも状態の条件を外れたら変えない", async () => {
    await inWorkspace((db, ws) => {
      const agent = fxAgent(db);
      const ask = insertGeneratingAsk(db, { createdBy: ws.userId, text: "在庫を見て", mentionAgentId: agent.agentId, packId: "coffee-shop", now: NOW });
      expect(ask).toMatchObject({ status: "generating", shape: null, mention_agent_id: agent.agentId, pack_id: "coffee-shop", created_at: NOW, trigger: null });
      expect(getAsk(db, ask.id)).toEqual(ask);
      expect(getAsk(db, newId())).toBeNull();

      bumpPlannerAttempts(db, ask.id, 2, NOW);
      bumpPlannerAttempts(db, ask.id, 2, NOW);
      expect(getAsk(db, ask.id)?.planner_attempts).toBe(3);

      expect(setAskQuestionAnswer(db, ask.id, "駅前", NOW)).toBeNull();
      expect(setAskQuestion(db, ask.id, QUESTION, NOW)).toBe(true);
      expect(setAskQuestion(db, ask.id, { ...QUESTION, text: "二つ目" }, NOW)).toBe(false);
      expect(setAskQuestionAnswer(db, ask.id, "駅前", at(1))).toMatchObject({ question: QUESTION, question_answer: "駅前", updated_at: at(1) });
      expect(setAskQuestionAnswer(db, ask.id, "もう一度", at(1))).toBeNull();

      const trigger = { type: "schedule" as const, cron: "0 8 * * *", timezone: "Asia/Tokyo" };
      const formed = markAskFormed(db, ask.id, { shape: "chain", formation: { members: 1 }, trigger, nextRunAt: at(60), now: at(2) });
      expect(formed).toMatchObject({ status: "running", shape: "chain", formation: { members: 1 }, trigger, next_run_at: at(60) });
      expect(markAskFormed(db, ask.id, { shape: "single", formation: {}, trigger: null, nextRunAt: null, now: at(3) })).toBeNull();
      expect(markAskGenerationFailed(db, ask.id, "timeout", at(3))).toBeNull();
      bumpPlannerAttempts(db, ask.id, -3, at(3));
      expect(getAsk(db, ask.id)?.planner_attempts).toBe(3);

      setAskNextRun(db, ask.id, at(120), at(4));
      expect(getAsk(db, ask.id)?.next_run_at).toEqual(at(120));
    });
  });

  it("markAskGenerationFailed：generating → failed。transitionAsk：from のどれかのときだけ、終わりなら finished_at", async () => {
    await inWorkspace((db, ws) => {
      const gen = insertGeneratingAsk(db, { createdBy: ws.userId, text: "x", mentionAgentId: null, now: NOW });
      expect(markAskGenerationFailed(db, gen.id, "planner_error", at(1))).toMatchObject({ status: "failed", failure_reason: "planner_error", finished_at: at(1) });

      const { askId } = fxAsk(db, ws);
      expect(transitionAsk(db, askId, ["waiting_input"], "done", at(1))).toBeNull();
      expect(transitionAsk(db, askId, ["running", "waiting_input"], "waiting_input", at(1))).toMatchObject({ status: "waiting_input", finished_at: null });
      expect(transitionAsk(db, askId, ["waiting_input"], "done", at(2))).toMatchObject({ status: "done", finished_at: at(2) });
      // 定期でない依頼の次の時刻は入れない
      setAskNextRun(db, askId, at(3), at(3));
      expect(getAsk(db, askId)?.next_run_at).toBeNull();
    });
  });

  it("listAsks：新しい順・状態で絞る・limit", async () => {
    await inWorkspace((db, ws) => {
      const a1 = insertGeneratingAsk(db, { createdBy: ws.userId, text: "1", mentionAgentId: null, now: NOW });
      const a2 = insertGeneratingAsk(db, { createdBy: ws.userId, text: "2", mentionAgentId: null, now: at(1) });
      markAskGenerationFailed(db, a1.id, "timeout", at(2));
      expect(listAsks(db, { limit: 10 }).map((a) => a.id)).toEqual([a2.id, a1.id]);
      expect(listAsks(db, { limit: 10, status: "failed" }).map((a) => a.id)).toEqual([a1.id]);
      expect(listAsks(db, { limit: 1 })).toHaveLength(1);
    });
  });
});

describe("編成の材料", () => {
  it("listAgentsForPlanner は removed も含めて作った順・仕事の数・今の定義。findLiveAgentByIdOrName は removed を除き、ID でも名前でも引ける", async () => {
    await inWorkspace((db) => {
      const a = fxAgent(db, { name: "受信箱係" });
      const b = fxAgent(db, { name: "仕入れ係" });
      run(db, "UPDATE agents SET status = 'removed' WHERE id = ?", b.agentId);
      run(db, "UPDATE agents SET created_at = ? WHERE id = ?", NOW, a.agentId);
      run(db, "UPDATE agents SET created_at = ? WHERE id = ?", at(1), b.agentId);
      const rows = listAgentsForPlanner(db);
      expect(rows.map((r) => r.agent.name)).toEqual(["受信箱係", "仕入れ係"]);
      expect(rows[0]).toMatchObject({ jobCount: 1, definition: { version: 2, name: "受信箱係" } });
      expect(rows[0]!.agent.created_at).toBeInstanceOf(Date);

      expect(findLiveAgentByIdOrName(db, "受信箱係")?.id).toBe(a.agentId);
      expect(findLiveAgentByIdOrName(db, a.agentId.toUpperCase())?.id).toBe(a.agentId);
      expect(findLiveAgentByIdOrName(db, "仕入れ係")).toBeNull();
      expect(findLiveAgentByIdOrName(db, b.agentId)).toBeNull();
    });
  });

  it("appendAgentSnapshot：新しいスナップショットを足して今のものにする", async () => {
    await inWorkspace((db) => {
      const a = fxAgent(db);
      const s = appendAgentSnapshot(db, { agentId: a.agentId, definition: { version: 2, name: "x" }, effectivePolicies: {}, clamped: [], ceilingsVersion: "0-H.2", now: NOW });
      expect(s).toMatchObject({ agent_id: a.agentId, status: "valid", definition: { version: 2, name: "x" }, clamped: [], errors: [] });
      expect(listAgentsForPlanner(db)[0]?.agent.current_snapshot_id).toBe(s.id);
      // 担当がいなければ外部キーで止まり、何も残らない
      expect(() => appendAgentSnapshot(db, { agentId: newId(), definition: {}, effectivePolicies: {}, clamped: [], ceilingsVersion: "x", now: NOW })).toThrow();
    });
  });
});

describe("実行（ask_runs）", () => {
  it("insertLiveRun は回数を1つずつ進め、動いている実行があれば作らない。transitionRun・markFirstMemberStarted・saveRunAnswer", async () => {
    await inWorkspace((db, ws) => {
      const { askId } = fxAsk(db, ws);
      const r1 = insertLiveRun(db, askId, "initial", NOW)!;
      expect(r1).toMatchObject({ run_no: 1, status: "running", trigger_type: "initial", started_at: NOW });
      expect(hasActiveLiveRun(db, askId)).toBe(true);
      expect(insertLiveRun(db, askId, "manual", NOW)).toBeNull();
      expect(listActiveLiveRuns(db).map((r) => r.id)).toEqual([r1.id]);

      markFirstMemberStarted(db, r1.id, at(1));
      markFirstMemberStarted(db, r1.id, at(2));
      expect(getAskRun(db, r1.id)?.first_member_started_at).toEqual(at(1));

      const ans = saveRunAnswer(db, r1.id, { answerTaskId: null, answer: { text: "答え" }, answerHash: fxHash("a1"), now: at(3) });
      expect(ans).toMatchObject({ answer: { text: "答え" }, answered_at: at(3) });
      expect(saveRunAnswer(db, r1.id, { answerTaskId: null, answer: { text: "直した" }, answerHash: fxHash("a2"), now: at(4) })).toMatchObject({
        answer: { text: "直した" },
        answered_at: at(3),
      });

      expect(transitionRun(db, r1.id, ["waiting_input"], "done", at(5))).toBeNull();
      expect(transitionRun(db, r1.id, ["running"], "done", at(5))).toMatchObject({ status: "done", finished_at: at(5) });
      expect(hasActiveLiveRun(db, askId)).toBe(false);
      const r2 = insertLiveRun(db, askId, "resume", at(6))!;
      expect(r2.run_no).toBe(2);
      expect(getLatestLiveRun(db, askId)?.id).toBe(r2.id);
      expect(listLiveRuns(db, askId, 10).map((r) => r.run_no)).toEqual([2, 1]);
      expect(listLiveRuns(db, askId, 1)).toHaveLength(1);
    });
  });
});

describe("担当・タスク", () => {
  it("listMembers：まとめ役は後ろ、段の順、担当の名前つき", async () => {
    await inWorkspace((db, ws) => {
      const t = team(db, ws);
      const rows = listMembers(db, t.askId);
      expect(rows.map((m) => [m.agent_name, m.position, m.is_spokesperson])).toEqual([
        ["受信箱係", 1, false],
        ["仕入れ係", 2, true],
      ]);
      expect(rows[0]?.depends_on).toEqual([]);
    });
  });

  it("insertAskTask は queued・ask・入力の ID・汚染で作る。claimQueuedTask は1回だけ取れる", async () => {
    await inWorkspace((db, ws) => {
      const t = team(db, ws);
      const task = insertAskTask(db, {
        requesterId: ws.userId,
        agentId: t.b.agentId,
        agentSnapshotId: t.b.snapshotId,
        jobId: t.b.jobId,
        askId: t.askId,
        askRunId: t.askRunId,
        askMemberId: t.mb,
        inputTaskIds: [t.ta],
        taint: { tainted: true, sources: [{ kind: "web_search", at: NOW.toISOString() }] },
        prompt: "まとめて",
        now: at(1),
      });
      expect(task).toMatchObject({ status: "queued", trigger_type: "ask", is_dry_run: false, input_task_ids: [t.ta], tainted: true, prompt: "まとめて", queued_at: at(1) });
      expect(claimQueuedTask(db, task.id, at(2))).toMatchObject({ status: "provisioning", updated_at: at(2) });
      expect(claimQueuedTask(db, task.id, at(3))).toBeNull();
      expect(listRunTasks(db, t.askRunId).map((x) => x.id)).toEqual([t.ta, t.tb, task.id]);
      expect(countOpenRunTasks(db, t.askRunId)).toBe(2);
    });
  });

  it("firstPromptsOfRuns：実行ごとに最初の通常のタスクの prompt（追いのターン・prompt なしは数えない）", async () => {
    await inWorkspace((db, ws) => {
      const t = team(db, ws);
      const first = askTask(db, ws, t.a, { askId: t.askId, askRunId: t.askRunId, memberId: t.ma, prompt: "最初", now: at(1) });
      askTask(db, ws, t.b, { askId: t.askId, askRunId: t.askRunId, memberId: t.mb, prompt: "二つ目", now: at(2) });
      insertFollowupTask(db, { parent: first, messageId: newId(), taint: { tainted: false, sources: [] }, now: at(0) });
      const { askRunId: other } = fxAskRun(db, t.askId, { runNo: 2 });
      expect(firstPromptsOfRuns(db, [t.askRunId, other])).toEqual(new Map([[t.askRunId, "最初"]]));
      expect(firstPromptsOfRuns(db, [])).toEqual(new Map());
    });
  });

  it("getPreviousReportTask：前の実行の、報告のある通常のタスクのうち最も新しいもの", async () => {
    await inWorkspace((db, ws) => {
      const t = team(db, ws);
      run(db, "UPDATE tasks SET report = '前回', report_kind = 'normal' WHERE id = ?", t.tb);
      const { askRunId: run2 } = fxAskRun(db, t.askId, { runNo: 2 });
      const now2 = askTask(db, ws, t.b, { askId: t.askId, askRunId: run2, memberId: t.mb, now: at(10) });
      run(db, "UPDATE tasks SET report = '今回', report_kind = 'normal' WHERE id = ?", now2.id);
      expect(getPreviousReportTask(db, t.mb, run2)?.id).toBe(t.tb);
      expect(getPreviousReportTask(db, t.mb, t.askRunId)?.id).toBe(now2.id);
      expect(getPreviousReportTask(db, t.ma, run2)).toBeNull();
    });
  });
});

describe("送る前の確認・やったこと・ほかの依頼", () => {
  it("countRejectedIntentsOfTasks・listPendingIntentsOfTasks・listToolActivityOfTasks・countPriorAsksOfAgents", async () => {
    await inWorkspace((db, ws) => {
      const t = team(db, ws);
      const c = fxConnector(db);
      const pending = fxIntent(db, { taskId: t.tb, jobId: t.b.jobId, connectorId: c.connectorId });
      const { approvalId } = fxApproval(db, ws, { taskId: t.tb, intentId: pending.intentId });
      const pending2 = fxIntent(db, { taskId: t.tb, jobId: t.b.jobId, connectorId: c.connectorId, now: at(1) });
      fxIntent(db, { taskId: t.tb, jobId: t.b.jobId, connectorId: c.connectorId, status: "rejected" });
      fxIntent(db, { taskId: t.tb, jobId: t.b.jobId, connectorId: c.connectorId, status: "rejected" });
      fxIntent(db, { taskId: t.ta, jobId: t.a.jobId, connectorId: c.connectorId, status: "expired" });
      expect(countRejectedIntentsOfTasks(db, [t.ta, t.tb])).toEqual(new Map([[t.tb, 2]]));

      const p = listPendingIntentsOfTasks(db, [t.tb]);
      expect(p.map((x) => [x.intent_id, x.approval_id])).toEqual([
        [pending.intentId, approvalId],
        [pending2.intentId, null],
      ]);
      expect(p[0]).toMatchObject({ agent_name: "仕入れ係", taint_snapshot: { tainted: false, sources: [] } });
      expect(p[0]?.created_at).toBeInstanceOf(Date);

      const decide = (subject: Record<string, unknown>, s: number) =>
        run(
          db,
          `INSERT INTO policy_decisions (id, task_id, subject_kind, subject, counters, flags, decision, reason_code, inputs_hash, kernel_version, created_at)
           VALUES (?, ?, 'tool_call', ?, '{}', '{}', 'allow', 'ok', ?, '0.1.0', ?)`,
          newId(),
          t.tb,
          subject,
          fxHash("in"),
          at(s),
        );
      decide({ action: "mcp.supplier.list_products" }, 1);
      decide({ actionType: "web_search" }, 2);
      decide({ call: { name: "read_file" } }, 3);
      expect(listToolActivityOfTasks(db, [t.tb], 2).map((x) => x.action)).toEqual(["web_search", "read_file"]);
      expect(listToolActivityOfTasks(db, [t.tb], 5)[0]?.created_at).toEqual(at(1));

      const later = fxAsk(db, ws).askId;
      run(db, "UPDATE asks SET created_at = ? WHERE id = ?", at(100), later);
      fxAskMember(db, { askId: later, agent: { ...t.a, jobId: fxAgentJob(db, t.a.agentId) }, position: 1 });
      expect(countPriorAsksOfAgents(db, [t.a.agentId, t.b.agentId], { askId: later, createdAt: at(100) })).toEqual(
        new Map([
          [t.a.agentId, 1],
          [t.b.agentId, 1],
        ]),
      );
      expect(countPriorAsksOfAgents(db, [t.a.agentId], { askId: t.askId, createdAt: NOW })).toEqual(new Map());
    });
  });
});

/** 同じ担当に2つ目の仕事を足す（ask_members.job_id は一意） */
function fxAgentJob(db: WsDb, agentId: Uuid): Uuid {
  const id = newId();
  run(db, "INSERT INTO agent_jobs (id, agent_id, slug, kind, template) VALUES (?, ?, ?, 'once', 'assistant')", id, agentId, `job-${id.slice(0, 8)}`);
  return id;
}

describe("連絡板・追いのターン", () => {
  it("insertAskMessage は名前つきで読み戻す。返事は in_reply_to が要る。listUnansweredQuestionsTo・hasFollowupForMessage", async () => {
    await inWorkspace((db, ws) => {
      const t = team(db, ws);
      const base = { askId: t.askId, askRunId: t.askRunId, inReplyTo: null, tainted: false };
      const share = insertAskMessage(db, { ...base, fromMember: t.ma, toMember: null, kind: "share", body: "共有", fromTaskId: t.ta, now: NOW });
      expect(share).toMatchObject({ from_agent_name: "受信箱係", to_agent_name: null, kind: "share", tainted: false, created_at: NOW });
      const q1 = insertAskMessage(db, { ...base, fromMember: t.ma, toMember: t.mb, kind: "question", body: "量は？", fromTaskId: t.ta, now: at(1) });
      const q2 = insertAskMessage(db, { ...base, fromMember: t.ma, toMember: t.mb, kind: "question", body: "期日は？", fromTaskId: t.ta, now: at(2) });
      expect(q1.to_agent_name).toBe("仕入れ係");
      expect(isCheckViolation(caught(() => insertAskMessage(db, { ...base, fromMember: t.mb, toMember: t.ma, kind: "reply", body: "20", fromTaskId: t.tb, now: at(3) })), "ask_messages_reply_chk")).toBe(true);
      insertAskMessage(db, { ...base, inReplyTo: q1.id, fromMember: t.mb, toMember: t.ma, kind: "reply", body: "20", fromTaskId: t.tb, now: at(3) });
      run(db, "UPDATE ask_messages SET rejected_reason = 'x' WHERE id = ?", share.id);
      expect(listAskMessages(db, t.askId).map((m) => m.body)).toEqual(["量は？", "期日は？", "20"]);
      expect(countAskMessages(db, t.askId)).toBe(3);
      expect(listUnansweredQuestionsTo(db, t.askId, t.mb).map((m) => m.id)).toEqual([q2.id]);

      expect(hasFollowupForMessage(db, q2.id)).toBe(false);
      const parent = listRunTasks(db, t.askRunId).find((x) => x.id === t.tb)!;
      const follow = insertFollowupTask(db, { parent, messageId: q2.id, taint: { tainted: false, sources: [] }, now: at(4) });
      expect(follow).toMatchObject({ kind: "followup", input_message_ids: [q2.id], ask_member_id: t.mb, prompt: null });
      expect(hasFollowupForMessage(db, q2.id)).toBe(true);
    });
  });
});

describe("費用（整数のマイクロドル）", () => {
  it("sumAskCostMicroUsd・plannerUsageOf（呼んでいなければ null、モデルは最新の呼び出し）", async () => {
    await inWorkspace((db, ws) => {
      const { askId } = fxAsk(db, ws);
      expect(sumAskCostMicroUsd(db, askId)).toBe(0);
      expect(plannerUsageOf(db, askId)).toBeNull();
      const planner = (model: string, cost: number, s: number) =>
        run(
          db,
          `INSERT INTO usage_records (id, ask_id, provider, model, phase, input_tokens, output_tokens, estimated_cost_micro_usd, cost_micro_usd, latency_ms, prompt_hash, created_at)
           VALUES (?, ?, 'google', ?, 'planner', 1, 1, ?, ?, 7000, 'h', ?)`,
          newId(),
          askId,
          model,
          cost,
          cost,
          at(s),
        );
      planner("gemini-old", 1_000, 1);
      planner("gemini-new", 2_000, 2);
      fxUsage(db, { askId, costMicroUsd: 500 });
      expect(sumAskCostMicroUsd(db, askId)).toBe(3_500);
      expect(plannerUsageOf(db, askId)).toEqual({ model: "gemini-new", calls: 2, latencyMs: 14_000, costMicroUsd: 3_000 });
    });
  });
});

describe("担当から利用者への質問", () => {
  it("open で作り、答える・時間切れは open のときだけ。終わったタスクの質問をまとめて閉じる", async () => {
    await inWorkspace((db, ws) => {
      const t = team(db, ws);
      const mk = (s: number) =>
        insertAgentQuestion(db, {
          askId: t.askId,
          askRunId: t.askRunId,
          taskId: t.tb,
          agentId: t.b.agentId,
          agentName: "仕入れ係",
          question: "どの店？",
          choices: [{ id: "a", label: "駅前" }],
          allowFreeText: false,
          now: at(s),
        });
      const q1 = mk(1);
      expect(q1).toMatchObject({ status: "open", choices: [{ id: "a", label: "駅前" }], allow_free_text: false, created_at: at(1) });
      const q2 = mk(2);
      const q3 = mk(3);
      expect(getAgentQuestion(db, q1.id)).toEqual(q1);
      expect(answerAgentQuestion(db, q1.id, { answer: "駅前", userId: ws.userId, now: at(4) })).toMatchObject({ status: "answered", answered_by: ws.userId, answered_at: at(4) });
      expect(answerAgentQuestion(db, q1.id, { answer: "別", userId: ws.userId, now: at(5) })).toBeNull();
      expect(expireAgentQuestion(db, q1.id)).toBeNull();
      expect(expireAgentQuestion(db, q2.id)).toMatchObject({ status: "expired" });
      expect(expireQuestionsOfTask(db, t.tb)).toBe(1);
      expect(listAgentQuestions(db, t.askId).map((q) => [q.id, q.status])).toEqual([
        [q1.id, "answered"],
        [q2.id, "expired"],
        [q3.id, "expired"],
      ]);
    });
  });
});

describe("順番待ちの返事", () => {
  it("古い順に並び、消化の印は1回だけ付く", async () => {
    await inWorkspace((db, ws) => {
      const { askId } = fxAsk(db, ws);
      const r2 = insertPendingReply(db, askId, { text: "二つ目", requesterId: ws.userId, now: at(2) });
      const r1 = insertPendingReply(db, askId, { text: "一つ目", requesterId: ws.userId, now: at(1) });
      expect(r1).toMatchObject({ text: "一つ目", consumed_at: null, created_at: at(1) });
      expect(listPendingReplies(db, askId).map((r) => r.id)).toEqual([r1.id, r2.id]);
      expect(peekPendingReply(db, askId)?.id).toBe(r1.id);
      expect(markPendingReplyConsumed(db, r1.id, at(3))).toBe(true);
      expect(markPendingReplyConsumed(db, r1.id, at(4))).toBe(false);
      expect(peekPendingReply(db, askId)?.id).toBe(r2.id);
      expect(listPendingReplies(db, askId).map((r) => r.id)).toEqual([r2.id]);
      expect(isCheckViolation(caught(() => insertPendingReply(db, askId, { text: "", requesterId: ws.userId, now: NOW })), "ask_pending_replies_text_check")).toBe(true);
    });
  });
});

describe("一意の守り", () => {
  it("同じ依頼の同じ担当は2回入らない（ask_members_agent_uq）", async () => {
    await inWorkspace((db, ws) => {
      const t = team(db, ws);
      const e = caught(() => fxAskMember(db, { askId: t.askId, agent: { ...t.a, jobId: fxAgentJob(db, t.a.agentId) }, position: 3 }));
      expect(isUniqueViolation(e, "ask_members.ask_id, ask_members.agent_id")).toBe(true);
    });
  });
});
