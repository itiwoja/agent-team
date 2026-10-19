// 依頼の API（routes/asks.ts：API-072〜077 と一覧）の試験：本物に近い世界（Postgres・gateway・sim-world）で、LLM だけ台本。
// 設定プランナーの編成 → 担当の作成・使い回し → 実行 → 回答までを HTTP で通す
import { issueSession } from "@open-team/db";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { insertUsageRecord } from "@open-team/db/edge";
import { useTestDb } from "@open-team/db/testing";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { DEFAULT_AGENT_MODEL, LlmError, ScriptedLlmClient, type ScriptedResponder } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import { AskDetailResponseSchema, AskSummarySchema, ListAsksResponseSchema, type AskDetailResponse, type AskSummary } from "../asks/contract.ts";
import { T0, startRehearsalWorld, type RehearsalWorld } from "../rehearsal/__fixtures__/world.ts";
import { jsonReply } from "../rehearsal/test-helpers.ts";
import { makeTestApp, send, type TestApp } from "../test-helpers.ts";
import { startAskRun } from "../asks/run.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

interface Setup {
  w: RehearsalWorld;
  t: TestApp;
  cookie: string;
  csrf: string;
  planner: unknown[];
  plannerCalls: number;
  llm: ScriptedLlmClient;
}

/** 呼ぶたびに1秒進む時計 */
function ticking(): { now(): Date } {
  let t = T0.getTime();
  return { now: () => new Date((t += 1000)) };
}

const reportCall = (id: string, body: string, extra: Record<string, unknown> = {}) => ({
  type: "tool_call" as const,
  id,
  name: "submit_report",
  arguments: { title: `${body}の題`, body, sources: [], ...extra },
});

/** 構造化出力の呼び出し（設定プランナー）は planner の列から、それ以外（担当のタスク）は仕事の指示の印で報告する */
function llmOf(s: { planner: unknown[]; plannerCalls: number }, behavior: Record<string, "report" | "fail" | "next"> = {}): ScriptedLlmClient {
  const responder: ScriptedResponder = (req) => {
    if (req.responseJsonSchema !== undefined) {
      const next = s.planner[s.plannerCalls++];
      if (next === undefined) throw new LlmError("設定プランナーの台本が尽きた", null, false);
      return jsonReply(next);
    }
    const all = `${req.system}\n${JSON.stringify(req.messages)}`;
    const mark = ["X", "Y", "Z"].find((m) => all.includes(`MARK-${m}`));
    if (mark === undefined) throw new LlmError("どの担当か分からない", null, false);
    if (behavior[mark] === "fail") throw new LlmError("台本の失敗", null, false);
    // next：次の手の提案つきで報告する（窓口なら回答のボタンになる）
    const extra = behavior[mark] === "next" ? { next_actions: ["来週も同じ条件で調べて", "カレンダーに入れて"] } : {};
    return { parts: [reportCall(`c-${mark}`, `${mark}の結果`, extra)], usage: { inputTokens: 500, outputTokens: 50, thinkingTokens: 0 } };
  };
  return new ScriptedLlmClient(responder);
}

async function setup(planner: unknown[], behavior: Record<string, "report" | "fail" | "next"> = {}): Promise<Setup> {
  const { db, url } = T();
  const w = (world = await startRehearsalWorld(db, url));
  const policy = defaultWorkspacePolicy("owner");
  await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, w.ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
  const state = { planner, plannerCalls: 0 };
  const llm = llmOf(state, behavior);
  const t = makeTestApp(db, {
    deps: { gatewayClient: w.gatewayClient, simClient: w.simClient, llm, clock: ticking() },
    env: { gemini: { project: undefined, location: "global", agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_AGENT_MODEL, compareModels: [] } },
  });
  const issued = await issueSession(db, { workspaceId: w.ws.workspaceId, userId: w.ws.userId, ipHash: null, userAgent: null, now: T0 });
  return { w, t, llm, cookie: issued.cookieValue, csrf: issued.csrfToken, planner: state.planner, get plannerCalls() { return state.plannerCalls; } };
}

const member = (over: Record<string, unknown> = {}) => ({
  summary: "仕事をする",
  template: "researcher",
  instructions: "MARK-X 仕事をしてください。",
  grants: [],
  ...over,
});

const post = (s: Setup, path: string, body: unknown, headers: Record<string, string> = {}) => send(s.t, "POST", `/api/v1${path}`, { cookie: s.cookie, csrf: s.csrf, body, headers });
const get = (s: Setup, path: string) => send(s.t, "GET", `/api/v1${path}`, { cookie: s.cookie });

async function detailOf(s: Setup, askId: string): Promise<AskDetailResponse> {
  const res = await get(s, `/asks/${askId}`);
  expect(res.status).toBe(200);
  return AskDetailResponseSchema.parse(await res.json());
}

async function waitStatus(s: Setup, askId: string, until: (status: string) => boolean): Promise<AskDetailResponse> {
  for (let i = 0; i < 400; i++) {
    const d = await detailOf(s, askId);
    if (until(d.ask.status)) return d;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("依頼の状態が変わらなかった");
}

const ID = "11111111-1111-4111-8111-111111111111";

describe("POST /asks（API-072）", () => {
  it("201 で依頼を返し、裏で編成を作って動かす。担当は新しく作る・使い回すの両方。回答まで届き、SSE の事象・費用の記録も残る", async () => {
    const s = await setup([]);
    s.planner.push({
      formation: {
        shape: "chain",
        members: [
          member({ newName: "確認係", role: "research", summary: "状況を確認する", instructions: "MARK-X 確認してください。" }),
          member({ agentId: s.w.agent.agentId, summary: "確認の結果をまとめる", instructions: "MARK-Y まとめてください。" }),
        ],
      },
    });
    const key = "22222222-2222-4222-8222-222222222222";
    const res = await post(s, "/asks", { text: "状況を確認して、まとめて" }, { "idempotency-key": key });
    expect(res.status).toBe(201);
    const created = AskSummarySchema.parse(((await res.json()) as { ask: unknown }).ask);
    expect(created).toMatchObject({ text: "状況を確認して、まとめて", status: "generating", shape: null, question: null, failure: null });

    const d = await waitStatus(s, created.id, (st) => st === "done");
    expect(d.ask).toMatchObject({ shape: "chain", status: "done", shapeLine: "確認係 → 仕入れ係 の順に進めて、仕入れ係が答えます" });
    expect(d.formation!.members.map((m) => [m.agentName, m.isNew, m.position, m.isSpokesperson])).toEqual([
      ["確認係", true, 1, false],
      ["仕入れ係", false, 2, true],
    ]);
    expect(d.stages.map((x) => x.state)).toEqual(["done", "done"]);
    expect(d.answer).toMatchObject({ conclusion: "Yの結果", spokesperson: { agentName: "仕入れ係" }, taintNote: null });
    expect(d.answer!.intermediate).toEqual([{ agentName: "確認係", body: "Xの結果" }]);
    expect(d.handoffs).toHaveLength(1);
    expect(d.run).toMatchObject({ runNo: 1, status: "done", triggerType: "initial" });

    // 新しい担当は最初の境界から作られ（suggested）、使い回した担当には仕事が足された（権限は広がらない）
    const { db } = T();
    const agents = await db.query<{ name: string; name_source: string; jobs: number }>(
      `SELECT a.name, a.name_source, (SELECT count(*)::int FROM agent_jobs j WHERE j.agent_id = a.id) AS jobs FROM agents a WHERE a.workspace_id = $1 ORDER BY a.name`,
      [s.w.ws.workspaceId],
    );
    expect(agents.rows.map((a) => [a.name, a.jobs])).toEqual([["仕入れ係", 2], ["確認係", 1]]);
    expect(agents.rows.find((a) => a.name === "確認係")!.name_source).toBe("suggested");

    // SSE の事象（workspace_events）
    const events = await db.query<{ type: string }>("SELECT type FROM workspace_events WHERE workspace_id = $1 AND type LIKE 'ask.%' ORDER BY id", [s.w.ws.workspaceId]);
    const types = events.rows.map((e) => e.type);
    expect(types[0]).toBe("ask.created");
    expect(types).toContain("ask.formed");
    expect(types.filter((x) => x === "ask.step.started")).toHaveLength(2);
    expect(types.filter((x) => x === "ask.step.finished")).toHaveLength(2);
    expect(types).toContain("ask.answered");
    // 設定プランナーの呼び出しは usage_records（phase = planner、ask_id）に残る（費用の上限と同じ集計）
    const usage = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM usage_records WHERE workspace_id = $1 AND ask_id = $2 AND phase = 'planner' AND cost_usd > 0", [s.w.ws.workspaceId, created.id]);
    expect(usage.rows[0]!.n).toBe(1);

    // 冪等：同じキーなら同じ依頼を返し、依頼は増えない（設定プランナーも呼ばない）
    const again = await post(s, "/asks", { text: "状況を確認して、まとめて" }, { "idempotency-key": key });
    expect(again.status).toBe(201);
    expect(((await again.json()) as { ask: AskSummary }).ask.id).toBe(created.id);
    const count = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM asks WHERE workspace_id = $1", [s.w.ws.workspaceId]);
    expect(count.rows[0]!.n).toBe(1);
    expect(s.plannerCalls).toBe(1);
    const mismatch = await post(s, "/asks", { text: "別の依頼" }, { "idempotency-key": key });
    expect(mismatch.status).toBe(400);

    // 一覧
    const list = ListAsksResponseSchema.parse(await (await get(s, "/asks")).json());
    expect(list.asks).toHaveLength(1);
    expect(list.asks[0]).toMatchObject({ id: created.id, status: "done", answerPreview: "Yの結果" });
  });

  it("質問：選択肢つきで返して生成を止め、API-073 の答えで続きを作る。質問は1つだけ", async () => {
    const s = await setup([]);
    s.planner.push(
      { question: { text: "どちらの店舗ですか？", choices: [{ id: "main", label: "本店" }, { id: "second", label: "2号店" }], allowFreeText: false } },
      { formation: { shape: "single", members: [member({ newName: "店舗係", summary: "本店を見る" })] } },
    );
    const res = await post(s, "/asks", { text: "店舗の在庫を見て" });
    const created = AskSummarySchema.parse(((await res.json()) as { ask: unknown }).ask);
    let d = await waitStatus(s, created.id, () => true);
    for (let i = 0; i < 200 && d.ask.question === null; i++) {
      await new Promise((r) => setTimeout(r, 50));
      d = await detailOf(s, created.id);
    }
    expect(d.ask).toMatchObject({ status: "generating", question: { text: "どちらの店舗ですか？", allowFreeText: false } });
    expect(d.ask.question!.choices).toEqual([{ id: "main", label: "本店" }, { id: "second", label: "2号店" }]);

    // 選択肢にない・自由記述が許されない答えは 400。質問が出ていない依頼への答えは 409
    expect((await post(s, `/asks/${created.id}/answer`, { choiceId: "nope" })).status).toBe(400);
    expect((await post(s, `/asks/${created.id}/answer`, { text: "自由に書く" })).status).toBe(400);
    expect((await post(s, `/asks/${created.id}/answer`, { choiceId: "main", text: "x" })).status).toBe(400);
    const ok = await post(s, `/asks/${created.id}/answer`, { choiceId: "main" });
    expect(ok.status).toBe(200);
    expect((await post(s, `/asks/${created.id}/answer`, { choiceId: "main" })).status).toBe(409);

    const done = await waitStatus(s, created.id, (st) => st === "done");
    expect(done.formation!.shape).toBe("single");
    expect(done.answer!.conclusion).toBe("Xの結果");
    expect(s.plannerCalls).toBe(2);
    // 答えは設定プランナーに「データ」として渡った
    const second = JSON.stringify(s.llm.requests.filter((r) => r.responseJsonSchema !== undefined)[1]!.messages);
    expect(second).toContain("本店");
    expect(second).toContain("もう質問しない");
    // 質問が終わったあとの依頼に答えは受け付けない
    const later = await post(s, `/asks/${done.ask.id}/answer`, { choiceId: "main" });
    expect(later.status).toBe(409);
  });

  it("編成を作れなかったら failed（理由の固定文）。担当・依頼の実行は作らない", async () => {
    const bad = { formation: { shape: "chain", members: [member({ agentId: "99999999-9999-4999-8999-999999999999" })] } };
    const s = await setup([bad, bad]);
    const res = await post(s, "/asks", { text: "できない依頼" });
    const created = AskSummarySchema.parse(((await res.json()) as { ask: unknown }).ask);
    const d = await waitStatus(s, created.id, (st) => st === "failed");
    expect(d.ask.failure).toEqual({ reason: "formation_invalid", message: "うまく決められませんでした。言い方を変えてみてください" });
    expect(d.ask.shape).toBeNull();
    expect(d.run).toBeNull();
    expect(d.stages).toEqual([]);
    const events = await T().db.query<{ type: string }>("SELECT type FROM workspace_events WHERE workspace_id = $1 AND type = 'ask.failed'", [s.w.ws.workspaceId]);
    expect(events.rows).toHaveLength(1);
  });

  it("担当の指定（mention）：その担当だけでひとり。存在しない担当は 400", async () => {
    const s = await setup([]);
    s.planner.push({ formation: { shape: "single", members: [member({ newName: "ほかの係", instructions: "MARK-Y 仕事をしてください。" })] } });
    expect((await post(s, "/asks", { text: "発注して", mention: "@いない係" })).status).toBe(400);
    const res = await post(s, "/asks", { text: "発注して", mention: "@仕入れ係" });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { ask: AskSummary }).ask.id;
    const d = await waitStatus(s, id, (st) => st === "done");
    expect(d.formation!.members).toHaveLength(1);
    expect(d.formation!.members[0]).toMatchObject({ agentName: "仕入れ係", isNew: false });
  });

  it("入力の検証（空の文・長すぎる文・余計な項目）は 400。Kill Switch 中は 423、費用の上限に達していれば 429", async () => {
    const s = await setup([]);
    expect((await post(s, "/asks", { text: "   " })).status).toBe(400);
    expect((await post(s, "/asks", { text: "x".repeat(2001) })).status).toBe(400);
    expect((await post(s, "/asks", { text: "a", shape: "single" })).status).toBe(400);

    // 全体の1日の上限（$15）に達している
    await T().db.transaction((tx) =>
      insertUsageRecord(tx, s.w.ws.ctx, { taskId: null, agentId: s.w.agent.agentId, askId: null, rehearsalRunId: null, model: "m", phase: "planner", inputTokens: 1, outputTokens: 1, estimatedCostUsd: "15.000000", costUsd: "15.000000", latencyMs: 1, promptHash: "h" }, T0),
    );
    const over = await post(s, "/asks", { text: "お金がない" });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("DAILY_BUDGET_EXCEEDED");

    await T().db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = now() WHERE id = $1", [s.w.ws.workspaceId]);
    expect((await post(s, "/asks", { text: "止まっている" })).status).toBe(423);
  });
});

describe("GET /asks/:id・resume・reply・messages", () => {
  const chain = (s: Setup) => ({
    formation: {
      shape: "chain",
      members: [member({ newName: "一番係", summary: "調べる", instructions: "MARK-X 調べてください。" }), member({ newName: "二番係", summary: "答える", instructions: "MARK-Y 答えてください。" })],
    },
  });

  it("段が失敗したら waiting_input。resume で「やり直す」と「ここまでで終える」。別のワークスペース・存在しない依頼は 404", async () => {
    const behavior: Record<string, "report" | "fail"> = { X: "fail" };
    const s = await setup([], behavior);
    s.planner.push(chain(s));
    const res = await post(s, "/asks", { text: "調べて答えて" });
    const id = ((await res.json()) as { ask: AskSummary }).ask.id;
    const waiting = await waitStatus(s, id, (st) => st === "waiting_input");
    expect(waiting.resume).toEqual({ agentName: "一番係", reason: "AI につながりませんでした" });
    expect(waiting.answer).toBeNull();
    expect(waiting.answerPending).toBeNull();

    behavior.X = "report";
    const retry = await post(s, `/asks/${id}/resume`, { action: "retry" });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { ask: AskSummary }).ask.status).toBe("running");
    const done = await waitStatus(s, id, (st) => st === "done");
    expect(done.answer!.conclusion).toBe("Yの結果");
    expect(done.resume).toBeNull();
    // 終わったあとの resume は 409
    expect((await post(s, `/asks/${id}/resume`, { action: "finish" })).status).toBe(409);
    expect((await post(s, `/asks/${id}/resume`, { action: "unknown" })).status).toBe(400);

    expect((await get(s, `/asks/${ID}`)).status).toBe(404);
    expect((await get(s, "/asks/not-a-uuid")).status).toBe(400);
  });

  it("回答への返事：窓口の担当に新しいお願いとして動かす（前の回答のタスクを渡す）。並列は 400", async () => {
    const s = await setup([]);
    s.planner.push(chain(s));
    const res = await post(s, "/asks", { text: "調べて答えて" });
    const id = ((await res.json()) as { ask: AskSummary }).ask.id;
    const first = await waitStatus(s, id, (st) => st === "done");
    expect(first.run!.runNo).toBe(1);

    const reply = await post(s, `/asks/${id}/reply`, { text: "もう少し詳しく" });
    expect(reply.status).toBe(202);
    for (let i = 0; i < 400; i++) {
      const d = await detailOf(s, id);
      if (d.run!.runNo === 2 && d.run!.status === "done") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const d = await detailOf(s, id);
    expect(d.run).toMatchObject({ runNo: 2, triggerType: "manual", status: "done" });
    // 返事の実行は窓口の担当だけを動かし、前の回答のタスクを入力に受け取る
    const tasks = await T().db.query<{ agent: string; input_task_ids: string[]; prompt: string }>(
      "SELECT a.name AS agent, t.input_task_ids, t.prompt FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE t.ask_run_id = $1",
      [d.run!.runId],
    );
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0]).toMatchObject({ agent: "二番係", prompt: "もう少し詳しく" });
    expect(tasks.rows[0]!.input_task_ids).toHaveLength(1);

    expect((await post(s, `/asks/${ID}/reply`, { text: "x" })).status).toBe(404);
    expect((await post(s, `/asks/${id}/reply`, { text: "" })).status).toBe(400);
  });

  it("連絡板（API-076）：ひとりの依頼は空。依頼がなければ 404", async () => {
    const s = await setup([]);
    s.planner.push({ formation: { shape: "single", members: [member({ newName: "一人係" })] } });
    const id = ((await (await post(s, "/asks", { text: "ひとりで" })).json()) as { ask: AskSummary }).ask.id;
    await waitStatus(s, id, (st) => st === "done");
    expect(await (await get(s, `/asks/${id}/messages`)).json()).toEqual({ messages: [] });
    expect((await get(s, `/asks/${ID}/messages`)).status).toBe(404);
  });

  it("窓口の次の手の提案は回答の nextActions に出る（変化の有無を言っていなければ unchanged は false）", async () => {
    const s = await setup([], { X: "next" });
    s.planner.push({ formation: { shape: "single", members: [member({ newName: "一人係" })] } });
    const id = ((await (await post(s, "/asks", { text: "ひとりで" })).json()) as { ask: AskSummary }).ask.id;
    const d = await waitStatus(s, id, (st) => st === "done");
    expect(d.answer).toMatchObject({ conclusion: "Xの結果", nextActions: ["来週も同じ条件で調べて", "カレンダーに入れて"], unchanged: false });
    expect(d.agentQuestions).toEqual([]);
  });

  it("定期の実行（見張り）：最初の段の担当に、その担当の前の回の報告を「前回の報告」として渡す（受け渡しにはしない）", async () => {
    const s = await setup([]);
    s.planner.push({ formation: { shape: "single", members: [member({ newName: "見張り番", template: "watcher" })] } });
    const id = ((await (await post(s, "/asks", { text: "このページを見張って" })).json()) as { ask: AskSummary }).ask.id;
    const first = await waitStatus(s, id, (st) => st === "done");
    const started = await startAskRun(s.t.deps, s.w.ws.ctx, id, { requesterId: s.w.ws.userId, trigger: "schedule" });
    expect(started).not.toBeNull();
    await started!.done;
    const d = await detailOf(s, id);
    expect(d.run).toMatchObject({ runNo: 2, triggerType: "schedule", status: "done" });
    const { db } = T();
    const prev = (await db.query<{ id: string }>("SELECT id FROM tasks WHERE ask_run_id = $1", [first.run!.runId])).rows[0]!.id;
    const now = (await db.query<{ input_task_ids: string[] }>("SELECT input_task_ids FROM tasks WHERE ask_run_id = $1", [d.run!.runId])).rows[0]!;
    expect(now.input_task_ids).toEqual([prev]);
    // 2回目の担当の最初の入力に前回の報告が載る（1回目には載らない）
    const firstInputs = s.llm.requests.filter((r) => r.responseJsonSchema === undefined).map((r) => JSON.stringify(r.messages[0]));
    expect(firstInputs[0]).not.toContain("# 前回の報告");
    expect(firstInputs.at(-1)).toContain("# 前回の報告");
    expect(firstInputs.at(-1)).toContain("Xの結果");
    expect(firstInputs.at(-1)).not.toContain("# 受け渡された報告");
  });

  it("担当からの質問：開いている質問は詳細に出て、選択肢で答えられる。答えたら消え、2度目は 409。選択肢にない答え・別の依頼は 400・404", async () => {
    const s = await setup([]);
    s.planner.push({ formation: { shape: "single", members: [member({ newName: "一人係" })] } });
    const id = ((await (await post(s, "/asks", { text: "ひとりで" })).json()) as { ask: AskSummary }).ask.id;
    await waitStatus(s, id, (st) => st === "done");
    const { db } = T();
    const q = (
      await db.query<{ id: string }>(
        `INSERT INTO agent_questions (workspace_id, ask_id, task_id, agent_id, agent_name, question, choices, allow_free_text)
         SELECT workspace_id, ask_id, id, agent_id, '一人係', 'どちらにしますか', '[{"id":"c1","label":"山田珈琲"},{"id":"c2","label":"海辺焙煎"}]', false
           FROM tasks WHERE ask_id = $1 LIMIT 1 RETURNING id`,
        [id],
      )
    ).rows[0]!.id;
    const before = await detailOf(s, id);
    expect(before.agentQuestions).toEqual([
      {
        questionId: q,
        agentName: "一人係",
        text: "どちらにしますか",
        choices: [
          { id: "c1", label: "山田珈琲" },
          { id: "c2", label: "海辺焙煎" },
        ],
        allowFreeText: false,
        createdAt: expect.any(String),
      },
    ]);
    expect((await post(s, `/asks/${id}/questions/${q}/answer`, { choiceId: "c9" })).status).toBe(400);
    expect((await post(s, `/asks/${id}/questions/${q}/answer`, { text: "自由に書く" })).status).toBe(400);
    expect((await post(s, `/asks/${id}/questions/${q}/answer`, {})).status).toBe(400);
    expect((await post(s, `/asks/${ID}/questions/${q}/answer`, { choiceId: "c1" })).status).toBe(404);
    expect((await post(s, `/asks/${id}/questions/${q}/answer`, { choiceId: "c2" })).status).toBe(200);
    const row = (await db.query<{ status: string; answer: string }>("SELECT status, answer FROM agent_questions WHERE id = $1", [q])).rows[0]!;
    expect(row).toEqual({ status: "answered", answer: "海辺焙煎" });
    expect((await detailOf(s, id)).agentQuestions).toEqual([]);
    expect((await post(s, `/asks/${id}/questions/${q}/answer`, { choiceId: "c1" })).status).toBe(409);
  });

  it("認証：セッションがなければ 401、CSRF がなければ 403", async () => {
    const s = await setup([]);
    expect((await send(s.t, "GET", "/api/v1/asks")).status).toBe(401);
    expect((await send(s.t, "POST", "/api/v1/asks", { cookie: s.cookie, body: { text: "x" } })).status).toBe(403);
  });
});

