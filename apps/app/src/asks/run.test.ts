// 編成の実行（FR-062）・回答（FR-063）の試験：本物に近い世界（Postgres・gateway・例の MCP コネクタ）で、LLM だけ台本。
// 形ごとの動かし方・受け渡し（input_task_ids・汚染の引き継ぎ）・失敗時の扱い（やり直す／ここまでで終える）・Kill Switch・hook と tick
import type { Db, SessionCtx, TaskRow, Uuid } from "@open-team/db";
import { insertAsk, insertAskMember } from "@open-team/db/app";
import { getTask } from "@open-team/db/edge";
import { getAsk, getLatestLiveRun, insertAskMessage, insertAskTask, insertLiveRun, insertPendingReply, listMembers, listPendingReplies, listRunTasks } from "@open-team/db/asks";
import { useTestDb } from "@open-team/db/testing";
import { LlmError, ScriptedLlmClient, type ScriptedResponder } from "@open-team/llm";
import type { AgentDefinitionInput } from "@open-team/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { seedAgent, startTestWorld, T0, type TestWorld, type SeededAgent } from "../__fixtures__/world.ts";
import { composeRunAnswer, storedAnswerView } from "./answer.ts";
import { createFollowupsAfterTerminal } from "./followup.ts";
import { asksOnTaskSettled, asksOnTasksTerminated, runAsksTick, STALE_TASK_MS } from "./hooks.ts";
import { queueReply, resumeAsk, resetAskStopForTest, settleDrivingRuns, settleFollowups, startAskRun, startQueuedReply, startWhenRoom, stopStartingAskTasks, type AskRunDeps } from "./run.ts";
import { buildAskDetail, listMessages } from "./view.ts";

const T = useTestDb();
let world: TestWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const def = (name: string, marker: string, template: "researcher" | "briefer" | "assistant" = "researcher"): AgentDefinitionInput => ({
  version: 2,
  name,
  role: "research",
  grants: { connectors: {} },
  autonomy: {},
  rules: [],
  budget: { per_task_usd: 0.2, per_day_usd: 1 },
  max_runs_per_day: 10,
  profile: [],
  jobs: [{ id: "ask-job", kind: "once", template, instructions: `${marker} この仕事をしてください。`, trigger: null, deliver: [], guards: [] }],
});

interface MemberSpec {
  agent: SeededAgent;
  position: number;
  dependsOn?: number[];
  spokesperson?: boolean;
  aggregator?: boolean;
}

async function setup(shape: "single" | "parallel" | "aggregate" | "chain", names: string[], o: { aggregatorIndex?: number; dependsOn?: number[][] } = {}) {
  const { db } = T();
  const w = (world = await startTestWorld(db));
  const agents: SeededAgent[] = [];
  for (const [i, n] of names.entries()) agents.push(await seedAgent(db, w.ws, def(n, `MARK-${n}`, o.aggregatorIndex === i ? "briefer" : "researcher")));
  const specs: MemberSpec[] = agents.map((agent, i) => {
    const n = names.length;
    const aggregator = o.aggregatorIndex === i;
    return {
      agent,
      position: i + 1,
      dependsOn: o.dependsOn?.[i] ?? (shape === "chain" && i > 0 ? [i] : aggregator ? Array.from({ length: n - 1 }, (_, k) => k + 1) : []),
      spokesperson: shape === "single" ? i === 0 : shape === "chain" ? i === n - 1 : aggregator,
      aggregator,
    };
  });
  const ask = await db.transaction(async (tx) => {
    const a = await insertAsk(tx, w.ws.ctx, {
      createdBy: w.ws.userId,
      text: "依頼の文",
      shape,
      status: "running",
      trigger: null,
      nextRunAt: null,
      formation: null,
      seedKey: null,
      now: T0,
    });
    for (const m of specs) {
      await insertAskMember(tx, w.ws.ctx, {
        askId: a.id,
        agentId: m.agent.agentId,
        jobId: m.agent.jobId,
        position: m.position,
        dependsOn: m.dependsOn ?? [],
        isAggregator: m.aggregator ?? false,
        isSpokesperson: m.spokesperson ?? false,
        isNew: false,
        summary: `${names[m.position - 1]}の仕事`,
        now: T0,
      });
    }
    return a;
  });
  return { w, ask, agents };
}

const reportCall = (id: string, body: string) => ({ type: "tool_call" as const, id, name: "submit_report", arguments: { title: `${body}の題`, body, sources: [] } });
const USAGE = { inputTokens: 500, outputTokens: 50, thinkingTokens: 0 };

/** どの担当のタスクか（仕事の指示の印）。担当ごとに「報告する」「失敗する」を決める */
function script(behavior: Record<string, "report" | "fail">): { llm: ScriptedLlmClient; seen: Map<string, string[]> } {
  const seen = new Map<string, string[]>();
  const responder: ScriptedResponder = (req) => {
    const all = `${req.system}\n${JSON.stringify(req.messages)}`;
    const mark = Object.keys(behavior).find((m) => all.includes(`MARK-${m}`));
    if (mark === undefined) throw new LlmError("どの担当か分からない", null, false);
    seen.set(mark, [...(seen.get(mark) ?? []), all]);
    if (behavior[mark] === "fail") throw new LlmError("台本の失敗", null, false);
    return { parts: [reportCall(`c-${mark}`, `${mark}の結果`)], usage: USAGE };
  };
  return { llm: new ScriptedLlmClient(responder), seen };
}

/** 呼ぶたびに1秒進む時計（タスクの作成の順を時刻で決められるように） */
function ticking(): { now(): Date } {
  let t = T0.getTime();
  return { now: () => new Date((t += 1000)) };
}

function runDeps(w: TestWorld, llm: ScriptedLlmClient): AskRunDeps {
  return { ...w.deps(llm), clock: ticking(), sleep: async () => {}, concurrency: { pollMs: 1, maxWaitMs: 50 } };
}

/** 人の操作（resume）に渡すセッション */
function sessionOf(w: TestWorld): SessionCtx {
  return { ...w.ws.ctx, userId: w.ws.userId, role: "owner", sessionId: "00000000-0000-4000-8000-000000000001", csrfToken: "x", lastSeenAt: T0, expiresAt: new Date(T0.getTime() + 3600_000) };
}

async function tasksOf(w: TestWorld, askId: Uuid): Promise<TaskRow[]> {
  const run = await getLatestLiveRun(w.db, w.ws.ctx, askId);
  return run === null ? [] : listRunTasks(w.db, w.ws.ctx, run.id);
}

describe("single", () => {
  it("担当のタスクを動かし、報告が回答になる（窓口の submit_report は kind = answer。answer_task_id に結ぶ）", async () => {
    const { w, ask } = await setup("single", ["A"]);
    const { llm } = script({ A: "report" });
    const started = await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;

    const tasks = await tasksOf(w, ask.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ trigger_type: "ask", is_dry_run: false, status: "completed", report_kind: "answer", ask_id: ask.id });
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run).toMatchObject({ status: "done", run_no: 1, trigger_type: "initial", answer_task_id: tasks[0]!.id });
    expect(run.answered_at).not.toBeNull();
    expect(storedAnswerView(run)).toMatchObject({ conclusion: "Aの結果", spokesperson: { agentName: "A" }, taintNote: null, needsYou: { pendingApprovals: 0, line: null } });
    expect((await getAsk(w.db, w.ws.ctx, ask.id))!.status).toBe("done");
  });

  it("動いている実行があれば、もう1つは始めない", async () => {
    const { w, ask } = await setup("single", ["A"]);
    const { llm } = script({ A: "report" });
    const deps = runDeps(w, llm);
    const first = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    const second = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "manual" });
    expect(second).toBeNull();
    await first!.done;
  });
});

describe("chain", () => {
  it("前の結果が要らない担当は同時に動かし、依存が済んだ担当から始める（文章・デザイン → 実装 → チェック）", async () => {
    const { w, ask } = await setup("chain", ["W", "D", "I", "C"], { dependsOn: [[], [], [1, 2], [3]] });
    // 文章（W）とデザイン（D）は、2人とも動き出すまで返事をしない：1人ずつ動かすと待ちきれずに失敗する
    const begun = new Set<string>();
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const seen = new Map<string, string[]>();
    const llm = new ScriptedLlmClient(async (req) => {
      const all = `${req.system}\n${JSON.stringify(req.messages)}`;
      const mark = ["W", "D", "I", "C"].find((x) => all.includes(`MARK-${x}`));
      if (mark === undefined) throw new LlmError("どの担当か分からない", null, false);
      seen.set(mark, [...(seen.get(mark) ?? []), all]);
      if (mark === "W" || mark === "D") {
        begun.add(mark);
        if (begun.size === 2) release();
        const late = new Promise<"late">((r) => setTimeout(() => r("late"), 2000));
        if ((await Promise.race([both.then(() => "ok" as const), late])) === "late") throw new LlmError("同時に動いていない", null, false);
      }
      return { parts: [reportCall(`c-${mark}`, `${mark}の結果`)], usage: USAGE };
    });
    const started = await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;

    const members = await listMembers(w.db, w.ws.ctx, ask.id);
    const byName = new Map((await tasksOf(w, ask.id)).map((t) => [members.find((m) => m.id === t.ask_member_id)!.agent_name, t]));
    expect([...byName.values()].every((t) => t.status === "completed")).toBe(true);
    expect(byName.get("W")!.input_task_ids).toEqual([]);
    expect(byName.get("D")!.input_task_ids).toEqual([]);
    // 実装は文章とデザインの両方を受け取り、チェックは実装だけを受け取る
    expect([...byName.get("I")!.input_task_ids].sort()).toEqual([byName.get("W")!.id, byName.get("D")!.id].sort());
    expect(byName.get("C")!.input_task_ids).toEqual([byName.get("I")!.id]);
    expect(seen.get("I")![0]).toContain("Wの結果");
    expect(seen.get("I")![0]).toContain("Dの結果");
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run).toMatchObject({ status: "done", answer_task_id: byName.get("C")!.id });
    const detail = (await buildAskDetail(w.db, w.ws.ctx, ask.id))!;
    expect(detail.ask.shapeLine).toBe("W・D → I → C の順に進めて（WとDは同時に動きます）、Cが答えます");
  });

  it("同時に動く担当の1人が止まっても、もう1人は最後まで動き、依存する担当は始めず waiting_input。「やり直す」で両方の結果を渡して再開する", async () => {
    const { w, ask } = await setup("chain", ["A", "B", "C"], { dependsOn: [[], [], [1, 2]] });
    const behavior: Record<string, "report" | "fail"> = { A: "fail", B: "report", C: "report" };
    const { llm } = script(behavior);
    const deps = runDeps(w, llm);
    const started = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;

    let tasks = await tasksOf(w, ask.id);
    expect(tasks.map((t) => t.status).sort()).toEqual(["completed", "failed"]);
    expect((await getAsk(w.db, w.ws.ctx, ask.id))!.status).toBe("waiting_input");

    behavior.A = "report";
    const resumed = await resumeAsk(deps, sessionOf(w), ask.id, "retry");
    await resumed.done;
    tasks = await tasksOf(w, ask.id);
    const members = await listMembers(w.db, w.ws.ctx, ask.id);
    const nameOf = (t: TaskRow) => members.find((m) => m.id === t.ask_member_id)!.agent_name;
    const c = tasks.find((t) => nameOf(t) === "C")!;
    const latestA = tasks.filter((t) => nameOf(t) === "A" && t.status === "completed");
    const b = tasks.find((t) => nameOf(t) === "B")!;
    expect(latestA).toHaveLength(1);
    expect(c.status).toBe("completed");
    expect([...c.input_task_ids].sort()).toEqual([latestA[0]!.id, b.id].sort());
    expect((await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status).toBe("done");
  });

  it("1段ずつ動かし、前の段の報告を次の段にデータとして渡す（input_task_ids）。最後の段の報告が回答で、前の段は途中の経過", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm, seen } = script({ A: "report", B: "report" });
    const started = await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;

    const [ta, tb] = await tasksOf(w, ask.id);
    expect(ta).toMatchObject({ status: "completed", input_task_ids: [], report_kind: "normal" });
    expect(tb).toMatchObject({ status: "completed", input_task_ids: [ta!.id], report_kind: "answer" });
    // 次の段は前の段の報告を入力として受け取る
    expect(seen.get("B")![0]).toContain("Aの結果");
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run).toMatchObject({ status: "done", answer_task_id: tb!.id });
    const answer = storedAnswerView(run)!;
    expect(answer.conclusion).toBe("Bの結果");
    expect(answer.intermediate).toEqual([{ agentName: "A", body: "Aの結果" }]);
    expect(answer.memberLines.map((l) => l.agentName)).toEqual(["A", "B"]);

    const detail = (await buildAskDetail(w.db, w.ws.ctx, ask.id))!;
    expect(detail.stages.map(s => s.taskStatus)).toEqual(["completed", "completed"]);
    expect(detail.stages.map((s) => [s.agentName, s.state, s.stateText])).toEqual([
      ["A", "done", "済み"],
      ["B", "done", "済み"],
    ]);
    expect(detail.handoffs).toEqual([{ fromPosition: 1, toPosition: 2, fromAgentName: "A", toAgentName: "B", label: "Aの結果の題", taintMark: null }]);
    expect(detail.answer?.conclusion).toBe("Bの結果");
    expect(detail.answerPending).toBeNull();
    expect(detail.ask.shapeLine).toBe("A → B の順に進めて、Bが答えます");
  });

  it("段が失敗したら次を始めず waiting_input。「やり直す」で止まった段から再開できる", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const behavior: Record<string, "report" | "fail"> = { A: "fail", B: "report" };
    const { llm } = script(behavior);
    const deps = runDeps(w, llm);
    const started = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;

    let tasks = await tasksOf(w, ask.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "failed", fail_reason: "llm_unavailable" });
    expect((await getAsk(w.db, w.ws.ctx, ask.id))!.status).toBe("waiting_input");
    expect((await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status).toBe("waiting_input");
    const waiting = (await buildAskDetail(w.db, w.ws.ctx, ask.id))!;
    expect(waiting.resume).toEqual({ agentName: "A", reason: "AI につながりませんでした" });
    expect(waiting.stages[0]).toMatchObject({ state: "failed", taskStatus: "failed", stateText: "失敗：AI につながりませんでした" });
    expect(waiting.stages[1]).toMatchObject({ state: "waiting", taskStatus: null, stateText: "待っています" });
    expect(waiting.answer).toBeNull();

    behavior.A = "report";
    const resumed = await resumeAsk(deps, sessionOf(w), ask.id, "retry");
    await resumed.done;
    tasks = await tasksOf(w, ask.id);
    expect(tasks.map((t) => t.status)).toEqual(["failed", "completed", "completed"]);
    // やり直した段のタスクが次の段に渡る（失敗したタスクではなく）
    expect(tasks[2]!.input_task_ids).toEqual([tasks[1]!.id]);
    expect((await getAsk(w.db, w.ws.ctx, ask.id))!.status).toBe("done");
  });

  it("「ここまでで終える」：止まった旨を回答にして終える。waiting_input でなければ 409", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm } = script({ A: "report", B: "fail" });
    const deps = runDeps(w, llm);
    await (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    expect((await getAsk(w.db, w.ws.ctx, ask.id))!.status).toBe("waiting_input");

    const r = await resumeAsk(deps, sessionOf(w), ask.id, "finish");
    expect(r.done).toBeNull();
    expect(r.ask.status).toBe("done");
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run.status).toBe("done");
    const answer = storedAnswerView(run)!;
    expect(answer.conclusion).toBe("Bで止まりました（AI につながりませんでした）");
    expect(answer.needsYou.stoppedMembers).toEqual(["B"]);
    expect(answer.memberLines.map((l) => [l.agentName, l.failed])).toEqual([["A", false], ["B", true]]);
    await expect(resumeAsk(deps, sessionOf(w), ask.id, "finish")).rejects.toMatchObject({ code: "ASK_ALREADY_FINISHED" });
  });
});

describe("返事（API-077）と履歴（turns）", () => {
  it("返事の実行は窓口だけを動かし、履歴に「頼んだこと → 回答」が古い順に並ぶ（返事の文が残る。最後は今の実行）", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm, seen } = script({ A: "report", B: "report" });
    const deps = runDeps(w, llm);
    await (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    const first = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(first.answer_task_id).not.toBeNull();

    const replied = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "manual", reply: "もう少し詳しく", replyOf: first.answer_task_id! });
    await replied!.done;
    // 窓口（B）だけがもう一度動き、返事の文を受け取る
    expect(seen.get("A")).toHaveLength(1);
    expect(seen.get("B")).toHaveLength(2);
    expect(seen.get("B")![1]).toContain("もう少し詳しく");

    const detail = (await buildAskDetail(w.db, w.ws.ctx, ask.id))!;
    expect(detail.turns.map((t) => [t.runNo, t.kind, t.text, t.status, t.answer?.conclusion ?? null])).toEqual([
      [1, "ask", "依頼の文", "done", "Bの結果"],
      [2, "reply", "もう少し詳しく", "done", "Bの結果"],
    ]);
    expect(detail.turns.at(-1)!.runId).toBe(detail.run!.runId);
    expect(detail.answer?.conclusion).toBe("Bの結果");
    // 返事の実行の段は、動いた窓口だけを出す（A を「待っています」と見せない）
    expect(detail.stages.map((s) => [s.agentName, s.state])).toEqual([["B", "done"]]);
  });
});

describe("順番待ちの返事（動いている間の返事）", () => {
  it("動いている間の返事は順番待ちになり、終わると自動で返事の実行が始まる（本文は返事の文として窓口に渡る）", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm, seen } = script({ A: "report", B: "report" });
    const deps = runDeps(w, llm);
    const first = (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!;
    // 実行はまだ動いている：返事は順番待ち
    const queued = await queueReply(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, text: "もう少し詳しく" });
    expect(queued).not.toBeNull();
    const detailBefore = (await buildAskDetail(w.db, w.ws.ctx, ask.id))!;
    expect(detailBefore.pendingReplies.map((x) => x.text)).toEqual(["もう少し詳しく"]);
    await first.done;
    await settleDrivingRuns(10_000);

    expect(await listPendingReplies(w.db, w.ws.ctx, ask.id)).toEqual([]);
    const detail = (await buildAskDetail(w.db, w.ws.ctx, ask.id))!;
    expect(detail.pendingReplies).toEqual([]);
    expect(detail.turns.map((t) => [t.runNo, t.kind, t.text, t.status])).toEqual([
      [1, "ask", "依頼の文", "done"],
      [2, "reply", "もう少し詳しく", "done"],
    ]);
    expect(seen.get("B")).toHaveLength(2);
    expect(seen.get("B")![1]).toContain("もう少し詳しく");
    const audits = await w.db.query<{ event_type: string }>("SELECT event_type FROM audit_logs WHERE workspace_id = $1 AND event_type LIKE 'ask.reply.%' ORDER BY seq", [w.ws.workspaceId]);
    expect(audits.rows.map((x) => x.event_type)).toEqual(["ask.reply.queued", "ask.reply.started"]);
  });

  it("動いている実行がなければ順番待ちに入れない（null）。複数たまったら古い順に1つずつ始まる", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm, seen } = script({ A: "report", B: "report" });
    const deps = runDeps(w, llm);
    await (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    expect(await queueReply(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, text: "x" })).toBeNull();

    const second = (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "manual", reply: "二回目" }))!;
    await queueReply(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, text: "三回目" });
    await queueReply(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, text: "四回目" });
    await second.done;
    await settleDrivingRuns(10_000);
    const detail = (await buildAskDetail(w.db, w.ws.ctx, ask.id))!;
    expect(detail.turns.map((t) => [t.runNo, t.text])).toEqual([
      [1, "依頼の文"],
      [2, "二回目"],
      [3, "三回目"],
      [4, "四回目"],
    ]);
    expect(detail.pendingReplies).toEqual([]);
    expect(seen.get("B")).toHaveLength(4);
  });

  it("二重に始まらない：直接の呼び出しと tick が同時に来ても、1つの返事は1回の実行になる（取りこぼしを拾う）", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm } = script({ A: "report", B: "report" });
    const deps = runDeps(w, llm);
    await (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    // 取りこぼし：実行は終わっているのに返事が残っている
    await w.db.transaction((tx) => insertPendingReply(tx, w.ws.ctx, ask.id, { text: "取りこぼし", requesterId: w.ws.userId, now: T0 }));
    const started = await Promise.all([startQueuedReply(deps, w.ws.ctx, ask.id), startQueuedReply(deps, w.ws.ctx, ask.id), runAsksTick(deps, new Date(T0.getTime() + 60_000))]);
    await Promise.all(started.flatMap((r) => (r !== null && "done" in r ? [r.done] : [])));
    await settleDrivingRuns(10_000);
    const runs = await w.db.query<{ run_no: number }>("SELECT run_no FROM ask_runs WHERE ask_id = $1 ORDER BY run_no", [ask.id]);
    expect(runs.rows.map((x) => x.run_no)).toEqual([1, 2]);
    expect(await listPendingReplies(w.db, w.ws.ctx, ask.id)).toEqual([]);
    expect((await buildAskDetail(w.db, w.ws.ctx, ask.id))!.turns.map((t) => t.text)).toEqual(["依頼の文", "取りこぼし"]);
  });
});

describe("parallel", () => {
  it.each([2, 1])("実際のLLM待機が重なり、同時実行上限%dを超えない", async (limit) => {
    const { w, ask } = await setup("parallel", ["A", "B", "C"]);
    await w.db.query("UPDATE workspaces SET max_concurrent_tasks = $2 WHERE id = $1", [w.ws.workspaceId, limit]);
    let active = 0, peak = 0;
    const intervals: Array<{ name: string; start: number; end: number }> = [];
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    const timer = setTimeout(release, 3000);
    const llm = new ScriptedLlmClient(async (req) => {
      const all = `${req.system}\n${JSON.stringify(req.messages)}`;
      const name = ["A", "B", "C"].find((n) => all.includes(`MARK-${n}`))!;
      const interval = { name, start: performance.now(), end: 0 };
      active++; peak = Math.max(peak, active);
      try {
        if (limit === 2 && intervals.length === 0) { if (active === 2) release(); await together; }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { parts: [reportCall(`overlap-${name}`, `${name}の結果`)], usage: USAGE };
      } finally { interval.end = performance.now(); intervals.push(interval); active--; }
    });
    try {
      await (await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
      expect(peak).toBe(limit);
      expect((await tasksOf(w, ask.id)).every((t) => t.status === "completed")).toBe(true);
      const overlaps = intervals.some((a, i) => intervals.slice(i + 1).some((b) => a.name !== b.name && Math.max(a.start, b.start) < Math.min(a.end, b.end)));
      expect(overlaps).toBe(limit === 2);
    } finally { clearTimeout(timer); release(); }
  });
  it("全員を同時に始め、1人が失敗してもほかは続く。回答は Kernel が担当ごとの報告を見出しつきで並べる（失敗した担当は「失敗：」）", async () => {
    const { w, ask } = await setup("parallel", ["A", "B", "C"]);
    const { llm } = script({ A: "report", B: "fail", C: "report" });
    const started = await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;
    const tasks = await tasksOf(w, ask.id);
    expect(tasks.map((t) => t.status).sort()).toEqual(["completed", "completed", "failed"]);
    expect(tasks.every((t) => t.input_task_ids.length === 0)).toBe(true);
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run.status).toBe("done");
    const a = storedAnswerView(run)!;
    expect(a.spokesperson).toBeNull();
    expect(a.conclusion).toContain("## A\n\nAの結果");
    expect(a.conclusion).toContain("## 失敗：B");
    expect(a.conclusion).toContain("## C\n\nCの結果");
    expect(run.answer_task_id).toBeNull();
  });

  it("全員が失敗したら failed", async () => {
    const { w, ask } = await setup("parallel", ["A", "B"]);
    const { llm } = script({ A: "fail", B: "fail" });
    await (await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    expect((await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status).toBe("failed");
    expect((await getAsk(w.db, w.ws.ctx, ask.id))!.status).toBe("failed");
  });
});

describe("aggregate", () => {
  it("担当を動かしたあと、全担当の結果を渡してまとめ役を動かす。回答はまとめ役の報告", async () => {
    const { w, ask } = await setup("aggregate", ["A", "B", "G"], { aggregatorIndex: 2 });
    const { llm, seen } = script({ A: "report", B: "report", G: "report" });
    await (await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    const tasks = await tasksOf(w, ask.id);
    const g = tasks.find((t) => t.report === "Gの結果")!;
    const workers = tasks.filter((t) => t.id !== g.id);
    expect([...g.input_task_ids].sort()).toEqual(workers.map((t) => t.id).sort());
    expect(seen.get("G")![0]).toContain("Aの結果");
    expect(seen.get("G")![0]).toContain("Bの結果");
    expect(g.report_kind).toBe("answer");
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run).toMatchObject({ status: "done", answer_task_id: g.id });
    expect(storedAnswerView(run)!.conclusion).toBe("Gの結果");
  });

  it("全員が失敗したらまとめ役は動かさず、失敗として終える（回答は止まった旨）", async () => {
    const { w, ask } = await setup("aggregate", ["A", "B", "G"], { aggregatorIndex: 2 });
    const { llm, seen } = script({ A: "fail", B: "fail", G: "report" });
    await (await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    expect(seen.has("G")).toBe(false);
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run.status).toBe("failed");
    expect(storedAnswerView(run)!.conclusion).toMatch(/で止まりました/);
  });
});

describe("連絡板（FR-064。Should）", () => {
  it("保存した連絡を読める（GET の元）。質問と返事は回答の「確かめました」の行になる", async () => {
    const { w, ask } = await setup("aggregate", ["A", "B", "G"], { aggregatorIndex: 2 });
    const { llm } = script({ A: "report", B: "report", G: "report" });
    await (await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    const members = await listMembers(w.db, w.ws.ctx, ask.id);
    const tasks = await listRunTasks(w.db, w.ws.ctx, run.id);
    const [a, b] = [members.find((m) => m.agent_name === "A")!, members.find((m) => m.agent_name === "B")!];
    const taskOf = (id: string) => tasks.find((t) => t.ask_member_id === id)!;
    const q = await w.db.transaction((tx) =>
      insertAskMessage(tx, w.ws.ctx, { askId: ask.id, askRunId: run.id, fromMember: b.id, toMember: a.id, kind: "question", body: "20kg は確定？", inReplyTo: null, tainted: false, fromTaskId: taskOf(b.id).id, now: T0 }),
    );
    await w.db.transaction((tx) =>
      insertAskMessage(tx, w.ws.ctx, { askId: ask.id, askRunId: run.id, fromMember: a.id, toMember: b.id, kind: "reply", body: "確定とは書かれていない", inReplyTo: q.id, tainted: true, fromTaskId: taskOf(a.id).id, now: new Date(T0.getTime() + 1000) }),
    );
    const res = (await listMessages(w.db, w.ws.ctx, ask.id))!;
    expect(res.messages.map((m) => [m.fromAgentName, m.toAgentName, m.kind, m.tainted])).toEqual([
      ["B", "A", "question", false],
      ["A", "B", "reply", true],
    ]);
    expect((await buildAskDetail(w.db, w.ws.ctx, ask.id))!.messageCount).toBe(2);
    const composed = await composeRunAnswer(w.db, w.ws.ctx, { ask: (await getAsk(w.db, w.ws.ctx, ask.id))!, run, members, tasks });
    expect(composed.memberLines.find((l) => l.agentName === "B")!.text).toContain("Aに確かめました");
    expect(await listMessages(w.db, w.ws.ctx, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("連絡板の1往復（D-73：担当 B → 担当 A：「20kg は確定？」）", () => {
  const MESSAGE_ID = /message_id: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;
  const toolResult = (req: { messages: ReadonlyArray<{ role: string; content: unknown }> }, name: string): string | null => {
    for (const m of req.messages) {
      const c = m.content as { name?: string; result?: string };
      if (m.role === "tool" && c.name === name && typeof c.result === "string") return c.result;
    }
    return null;
  };

  it("B が A に質問 → A は終わっているので追いのターンが起きて reply → B は team_wait で返事を受け取って報告する。追いのターンは回答の材料にならない", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const waited: string[] = [];
    const responder: ScriptedResponder = (req) => {
      const all = `${req.system}\n${JSON.stringify(req.messages)}`;
      if (all.includes("MARK-A")) {
        // 追いのターン：質問の message_id に reply を1通
        if (all.includes("質問（追いのターン）")) {
          const first = req.messages[0]!.content as string;
          const id = MESSAGE_ID.exec(first)![1]!;
          return { parts: [{ type: "tool_call", id: "r1", name: "team_post", arguments: { to: "B", kind: "reply", body: "確定とは書かれていない", in_reply_to: id } }], usage: USAGE };
        }
        return { parts: [reportCall("c-A", "A の結果")], usage: USAGE };
      }
      const posted = toolResult(req, "team_post");
      if (posted === null) return { parts: [{ type: "tool_call", id: "q1", name: "team_post", arguments: { to: "A", kind: "question", body: "20kg は確定？" } }], usage: USAGE };
      const wait = toolResult(req, "team_wait");
      if (wait === null) return { parts: [{ type: "tool_call", id: "w1", name: "team_wait", arguments: { message_id: MESSAGE_ID.exec(posted)![1]!, timeout: 30 } }], usage: USAGE };
      waited.push(wait);
      return { parts: [reportCall("c-B", "B の結果")], usage: USAGE };
    };
    const deps: AskRunDeps = { ...runDeps(w, new ScriptedLlmClient(responder)), edge: { limits: { teamWaitPollMs: 20 } } };
    const started = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;
    await settleFollowups();

    // 連絡板：質問と返事が残り、B は返事を「データ」として受け取った
    const msgs = (await listMessages(w.db, w.ws.ctx, ask.id))!.messages;
    expect(msgs.map((m) => [m.fromAgentName, m.toAgentName, m.kind, m.body])).toEqual([
      ["B", "A", "question", "20kg は確定？"],
      ["A", "B", "reply", "確定とは書かれていない"],
    ]);
    expect(waited).toHaveLength(1);
    expect(waited[0]).toContain("Aからの返事");
    expect(waited[0]).toContain('<untrusted source="message:A">');

    // 追いのターン：同じ仕事・A の元のタスクが親・書き込みのツールなし。回答の材料（段・窓口の回答）は通常のタスクだけ
    const tasks = await tasksOf(w, ask.id);
    const followups = tasks.filter((t) => t.kind === "followup");
    const normals = tasks.filter((t) => t.kind === "normal");
    expect(normals).toHaveLength(2);
    expect(followups).toHaveLength(1);
    const aTask = normals.find((t) => t.agent_id === followups[0]!.agent_id)!;
    expect(followups[0]).toMatchObject({ parent_task_id: aTask.id, job_id: aTask.job_id, agent_snapshot_id: aTask.agent_snapshot_id, status: "completed", ask_member_id: aTask.ask_member_id });
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run.status).toBe("done");
    const bTask = normals.find((t) => t.id === run.answer_task_id)!;
    expect(bTask.report).toBe("B の結果");
    const audit = await w.db.query<{ event_type: string }>("SELECT event_type FROM audit_logs WHERE workspace_id = $1 AND event_type LIKE 'ask.%message%' OR event_type = 'ask.followup.started'", [w.ws.workspaceId]);
    expect(audit.rows.map((r) => r.event_type).sort()).toEqual(["ask.followup.started", "ask.message.posted", "ask.message.posted"]);
    // SSE：連絡が増えるたびに ask.message.posted が流れる
    const events = await w.db.query<{ data: { type: string } }>("SELECT data FROM workspace_events WHERE workspace_id = $1 AND type = 'ask.message.posted' ORDER BY id", [w.ws.workspaceId]);
    expect(events.rows).toHaveLength(2);
  });

  it("通常の実行後に単独で動く追いのターンも shutdown の後始末まで待つ", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    let markFollowupStarted!: () => void;
    const followupStarted = new Promise<void>((resolve) => { markFollowupStarted = resolve; });
    let releaseFollowup!: () => void;
    const followupGate = new Promise<void>((resolve) => { releaseFollowup = resolve; });
    const responder: ScriptedResponder = async (req) => {
      const all = `${req.system}\n${JSON.stringify(req.messages)}`;
      if (all.includes("質問（追いのターン）")) {
        markFollowupStarted();
        await followupGate;
        return { parts: [], usage: USAGE };
      }
      if (all.includes("MARK-A")) return { parts: [reportCall("a", "A の結果")], usage: USAGE };
      return { parts: [{ type: "tool_call", id: "q", name: "team_post", arguments: { to: "A", kind: "question", body: "確認？" } }, reportCall("b", "B の結果")], usage: USAGE };
    };
    const deps = runDeps(w, new ScriptedLlmClient(responder));
    const started = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;
    await followupStarted;
    let settled = false;
    const settling = settleDrivingRuns(2_000).then(() => { settled = true; });
    for (const e of deps.registry.list()) deps.registry.abortTask(e.id, "shutdown");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    releaseFollowup();
    await settling;
    expect(settled).toBe(true);
    expect((await tasksOf(w, ask.id)).find((t) => t.kind === "followup")!.status).toBe("failed");
  });
});

describe("追いのターンを作る条件（FR-064）", () => {
  it("動いている間に届いて返事のないまま終わった担当の質問は、終わったときに追いのターンになる。同じ質問に2つ作らず、返事済み・動いている担当には作らない", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm } = script({ A: "report", B: "report" });
    await (await startAskRun(runDeps(w, llm), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    const members = await listMembers(w.db, w.ws.ctx, ask.id);
    const tasks = await listRunTasks(w.db, w.ws.ctx, run.id);
    const [a, b] = [members.find((m) => m.agent_name === "A")!, members.find((m) => m.agent_name === "B")!];
    const aTask = tasks.find((t) => t.ask_member_id === a.id)!;
    const bTask = tasks.find((t) => t.ask_member_id === b.id)!;
    const ask1 = (body: string, from: typeof a, to: typeof a, fromTask: TaskRow) =>
      w.db.transaction((tx) => insertAskMessage(tx, w.ws.ctx, { askId: ask.id, askRunId: run.id, fromMember: from.id, toMember: to.id, kind: "question", body, inReplyTo: null, tainted: true, fromTaskId: fromTask.id, now: T0 }));
    const q = await ask1("20kg は確定？", b, a, bTask);
    const deps = runDeps(w, llm);
    const made = await createFollowupsAfterTerminal(deps, w.ws.ctx, aTask);
    expect(made).toHaveLength(1);
    // 親の汚染から始め、質問の汚染（送った側が汚染）を足す（taintOnTeamMessage）
    expect(made[0]!.task).toMatchObject({ kind: "followup", status: "queued", parent_task_id: aTask.id, input_message_ids: [q.id], tainted: true, prompt: null });
    expect(made[0]!.task.taint_sources.map((x) => x.kind)).toEqual(["team_message"]);
    expect(await createFollowupsAfterTerminal(deps, w.ws.ctx, aTask)).toHaveLength(0);
    // 動いている（終わっていない）担当のタスクには作らない
    expect(await createFollowupsAfterTerminal(deps, w.ws.ctx, { ...aTask, status: "running" })).toHaveLength(0);
    // 追いのターン自身の終了では作らない
    expect(await createFollowupsAfterTerminal(deps, w.ws.ctx, made[0]!.task)).toHaveLength(0);
  });
});

describe("hook・tick", () => {
  it("taskSettled の hook が次の段のタスクを queued で作り、tick が動かして完了させる（承認の確定のあとの続き）", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm } = script({ A: "report", B: "report" });
    const deps = runDeps(w, llm);
    // 1段目のタスクだけを済みにした状態を作る（実行は始めない：run を直接作る）
    const ctx = w.ws.ctx;
    const run = await w.db.transaction(async (tx) => {
      const { insertLiveRun, insertAskTask, listMembers } = await import("@open-team/db/asks");
      const r = (await insertLiveRun(tx, ctx, ask.id, "initial", T0))!;
      const members = await listMembers(tx, ctx, ask.id);
      const m1 = members.find((m) => m.position === 1)!;
      const agent = (await tx.query<{ current_snapshot_id: Uuid }>("SELECT current_snapshot_id FROM agents WHERE id = $1", [m1.agent_id])).rows[0]!;
      const t = await insertAskTask(tx, ctx, {
        requesterId: w.ws.userId,
        agentId: m1.agent_id,
        agentSnapshotId: agent.current_snapshot_id,
        jobId: m1.job_id,
        askId: ask.id,
        askRunId: r.id,
        askMemberId: m1.id,
        inputTaskIds: [],
        taint: { tainted: false, sources: [] },
        prompt: null,
        now: T0,
      });
      await tx.query(
        `UPDATE tasks SET status = 'succeeded', report = 'Aの結果', report_title = 't', report_kind = 'normal', finished_at = $2,
                tainted = true, taint_sources = $3::jsonb WHERE id = $1`,
        [t.id, T0, [{ kind: "mcp_read", connectorId: "c1", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: T0.toISOString() }]],
      );
      return r;
    });
    const later = new Date(T0.getTime() + 5000);
    await w.db.transaction((tx) => asksOnTaskSettled(tx, ctx, { taskId: "00000000-0000-4000-8000-000000000000", status: "succeeded", now: later }));
    const before = await listRunTasks(w.db, ctx, run.id);
    expect(before).toHaveLength(1);
    const firstTaskId = before[0]!.id;
    await w.db.transaction((tx) => asksOnTaskSettled(tx, ctx, { taskId: firstTaskId, status: "succeeded", now: later }));
    const queued = await listRunTasks(w.db, ctx, run.id);
    expect(queued.map((t) => t.status)).toEqual(["succeeded", "queued"]);
    expect(queued[1]!.input_task_ids).toEqual([firstTaskId]);
    // 外部の内容を読んだ段の結果を受け取る段は、汚染されて始まる（BR-71）
    expect(queued[1]).toMatchObject({ tainted: true });
    expect(queued[1]!.taint_sources[0]).toMatchObject({ kind: "handoff", fromTaskId: firstTaskId });

    // tick が queued のタスクを動かす（裏で続く）
    const r = await runAsksTick(deps, new Date(T0.getTime() + 60_000));
    expect(r.dispatched).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 200 && (await getLatestLiveRun(w.db, ctx, ask.id))!.status === "running"; i++) await new Promise((x) => setTimeout(x, 25));
    const finished = (await getLatestLiveRun(w.db, ctx, ask.id))!;
    expect(finished).toMatchObject({ status: "done", answer_task_id: queued[1]!.id });
    expect(storedAnswerView(finished)!.taintNote).toMatch(/^外部の内容をもとにしています/);
    const detail = (await buildAskDetail(w.db, ctx, ask.id))!;
    expect(detail.handoffs[0]).toMatchObject({ taintMark: "外部の内容を含む" });
    expect((await listRunTasks(w.db, ctx, run.id)).map((t) => t.status)).toEqual(["succeeded", "completed"]);
  });

  it("Kill Switch で止めたタスクの実行・依頼は cancelled になる（tasksTerminated の hook）", async () => {
    const { w, ask } = await setup("chain", ["A", "B"]);
    const { llm } = script({ A: "fail", B: "report" });
    const deps = runDeps(w, llm);
    await (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    const run = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    expect(run.status).toBe("waiting_input");
    await w.db.transaction((tx) => asksOnTasksTerminated(tx, w.ws.ctx, { tasks: [{ id: "x" as Uuid, jobId: "x" as Uuid, agentId: "x" as Uuid, askId: ask.id, askRunId: run.id, previousStatus: "running" }], cause: "kill_switch", now: T0 }));
    expect((await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status).toBe("cancelled");
    expect((await getAsk(w.db, w.ws.ctx, ask.id))!.status).toBe("cancelled");
  });
});

/** 担当ごとに queued のタスクを作る（実行の枠を作り、動かさない） */
async function queueTasks(w: TestWorld, askId: Uuid): Promise<{ runId: Uuid; tasks: TaskRow[] }> {
  const ctx = w.ws.ctx;
  const runId = await w.db.transaction(async (tx) => {
    const r = (await insertLiveRun(tx, ctx, askId, "initial", T0))!;
    for (const m of await listMembers(tx, ctx, askId)) {
      const agent = (await tx.query<{ current_snapshot_id: Uuid }>("SELECT current_snapshot_id FROM agents WHERE id = $1", [m.agent_id])).rows[0]!;
      await insertAskTask(tx, ctx, {
        requesterId: w.ws.userId,
        agentId: m.agent_id,
        agentSnapshotId: agent.current_snapshot_id,
        jobId: m.job_id,
        askId,
        askRunId: r.id,
        askMemberId: m.id,
        inputTaskIds: [],
        taint: { tainted: false, sources: [] },
        prompt: null,
        now: T0,
      });
    }
    return r.id;
  });
  return { runId, tasks: await listRunTasks(w.db, ctx, runId) };
}

describe("プロセスの停止と拾い直し（shutdown・同時実行数・ハートビート）", () => {
  afterEach(() => resetAskStopForTest());

  it("停止（shutdown）で中断した担当のタスクは sandbox_lost の failed になり、running のまま残らない", async () => {
    const { w, ask } = await setup("single", ["A"]);
    const llm = new ScriptedLlmClient(() => {
      // 動いている最中にプロセスが止められた（登録簿の中断）。応答は返るが、後始末は止めた側の理由で行う
      for (const e of deps.registry.list()) deps.registry.abortTask(e.id, "shutdown");
      return { parts: [{ type: "tool_call" as const, id: "c-x", name: "read_inbox", arguments: {} }], usage: USAGE };
    });
    const deps = runDeps(w, llm);
    const started = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;

    const tasks = await tasksOf(w, ask.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "failed", fail_reason: "sandbox_lost" });
    expect((await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status).not.toBe("running");
  });

  it("停止の最中は新しく取らない：queued のまま残り、次の tick が拾って動かす", async () => {
    const { w, ask } = await setup("parallel", ["A", "B"]);
    const { llm } = script({ A: "report", B: "report" });
    const deps = runDeps(w, llm);
    stopStartingAskTasks();
    const started = await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" });
    await started!.done;
    expect(await tasksOf(w, ask.id)).toEqual([]);
    expect((await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status).toBe("running");

    resetAskStopForTest();
    await runAsksTick(deps, new Date(T0.getTime() + 60_000));
    await settleDrivingRuns(10_000);
    expect((await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status).toBe("done");
  });

  it("同時実行数（BR-08）：確かめのあとに上限まで取られていたら、取らずに待つ（queued のまま。上限を超えて動かない）", async () => {
    const { w, ask } = await setup("parallel", ["A", "B"]);
    const { tasks } = await queueTasks(w, ask.id);
    const [tA, tB] = tasks as [TaskRow, TaskRow];
    await w.db.query("UPDATE workspaces SET max_concurrent_tasks = 1 WHERE id = $1", [w.ws.workspaceId]);
    // 確かめ（ロックの外の数え）と取得（ロックの中）の間に、もう1つの担当が取られる
    let raced = false;
    const racing = new Proxy(w.db, {
      get(target, prop) {
        if (prop === "query") {
          return async (sql: string, params?: unknown[]) => {
            const out = await (target.query as (...a: unknown[]) => Promise<unknown>).call(target, sql, params);
            if (!raced && sql.includes("count(*)") && sql.includes("provisioning")) {
              raced = true;
              await target.query("UPDATE tasks SET status = 'running', started_at = $2, last_heartbeat_at = $2 WHERE id = $1", [tB.id, T0]);
            }
            return out;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Db;
    const deps: AskRunDeps = { ...runDeps(w, script({}).llm), db: racing };
    const outcome = await startWhenRoom(deps, w.ws.ctx, tA.id, new AbortController().signal);
    expect(raced).toBe(true);
    expect(outcome).toEqual({ kind: "halt", gate: "timeout" });
    expect((await getTask(w.db, w.ws.ctx, tA.id))!.status).toBe("queued");
  });

  it("別 instance がすでに取得した同じタスクは、上限待ちや timeout で停止しない", async () => {
    const { w, ask } = await setup("single", ["A"]);
    const { tasks } = await queueTasks(w, ask.id);
    const task = tasks[0]!;
    await w.db.query("UPDATE workspaces SET max_concurrent_tasks = 1 WHERE id = $1", [w.ws.workspaceId]);
    await w.db.query("UPDATE tasks SET status = 'running', started_at = $2, last_heartbeat_at = $2 WHERE id = $1", [task.id, T0]);
    const deps = { ...runDeps(w, script({}).llm), concurrency: { pollMs: 1, maxWaitMs: 1 } };
    const outcome = await startWhenRoom(deps, w.ws.ctx, task.id, new AbortController().signal);
    expect(outcome).toEqual({ kind: "left" });
    expect((await getTask(w.db, w.ws.ctx, task.id))!.status).toBe("running");
  });

  it("ハートビートの途絶えた実行中のタスク（動かしていたプロセスが落ちた）は tick が sandbox_lost の failed にし、依頼の実行は進む", async () => {
    const { w, ask } = await setup("single", ["A"]);
    const { tasks } = await queueTasks(w, ask.id);
    await w.db.query("UPDATE tasks SET status = 'running', started_at = $2, last_heartbeat_at = $2, updated_at = $2 WHERE id = $1", [tasks[0]!.id, T0]);
    const { llm } = script({ A: "report" });
    const deps = runDeps(w, llm);
    await runAsksTick(deps, new Date(T0.getTime() + STALE_TASK_MS + 1000));
    for (let i = 0; i < 200 && (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status === "running"; i++) await new Promise((x) => setTimeout(x, 25));
    expect((await getTask(w.db, w.ws.ctx, tasks[0]!.id))!).toMatchObject({ status: "failed", fail_reason: "sandbox_lost" });
    expect((await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!.status).not.toBe("running");
  });

  it("ハートビートが途絶えていても、この instance が動かしているタスクは触らない", async () => {
    const { w, ask } = await setup("single", ["A"]);
    const { tasks } = await queueTasks(w, ask.id);
    await w.db.query("UPDATE tasks SET status = 'running', started_at = $2, last_heartbeat_at = $2, updated_at = $2 WHERE id = $1", [tasks[0]!.id, T0]);
    const deps = runDeps(w, script({}).llm);
    const ac = new AbortController();
    deps.registry.register(tasks[0]!.id, w.ws.workspaceId, ac);
    await runAsksTick(deps, new Date(T0.getTime() + STALE_TASK_MS + 1000));
    expect((await getTask(w.db, w.ws.ctx, tasks[0]!.id))!.status).toBe("running");
    deps.registry.unregister(tasks[0]!.id);
  });
});
