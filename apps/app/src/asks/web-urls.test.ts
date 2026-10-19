// SG-04：依頼のタスクを作るとき（createMemberTask）、見た URL の集合に入れるのは利用者自身が書いた文（依頼の文・返事の文）の URL だけ。
// 担当の指示（プランナーが書いた instructions）の URL は入れない。返事の実行は、前の回答のタスクの集合を写す
import type { Uuid } from "@open-team/db";
import { insertAsk, insertAskMember } from "@open-team/db/app";
import { getLatestLiveRun, listRunTasks } from "@open-team/db/asks";
import { addTaskWebUrls, hasTaskWebUrl, TASK_WEB_URLS_MAX } from "@open-team/db/edge";
import { useTestDb } from "@open-team/db/testing";
import { userTextWebUrlHashes } from "@open-team/edge";
import type { AgentDefinitionInput } from "@open-team/kernel";
import { ScriptedLlmClient } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import { seedAgent, startRehearsalWorld, T0, type RehearsalWorld } from "../rehearsal/__fixtures__/world.ts";
import { startAskRun, type AskRunDeps } from "./run.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const ASK_URL = "https://user.example/report?id=7";
const PLANNER_URL = "https://planner.example/plan";
const REPLY_URL = "https://reply.example/more";
const SEEN_URL = "https://seen.example/page";
/** 利用者の文と同じ規則で作った鍵（userTextWebUrlHashes は本文の URL を正規化して SHA-256 にする） */
const key = (url: string): string => userTextWebUrlHashes([url])[0]!;

const def: AgentDefinitionInput = {
  version: 2,
  name: "A",
  role: "research",
  grants: { connectors: {} },
  autonomy: {},
  rules: [],
  budget: { per_task_usd: 0.2, per_day_usd: 1 },
  max_runs_per_day: 10,
  profile: [],
  // 担当の指示（プランナーの LLM が書くもの）にだけ URL がある
  jobs: [{ id: "ask-job", kind: "once", template: "researcher", instructions: `${PLANNER_URL} も参考にしてください。`, trigger: null, deliver: [], guards: [] }],
};

const USAGE = { inputTokens: 500, outputTokens: 50, thinkingTokens: 0 };
/** 窓口の担当が書く次の手の提案（担当の文。画面ではボタンになり、押すとそのまま返事として送られる） */
const SUGGESTED_URL = "https://suggested.example/c?d=abc";
const SUGGESTION = `${SUGGESTED_URL} を開いて`;
const llm = (): ScriptedLlmClient =>
  new ScriptedLlmClient(() => ({
    parts: [{ type: "tool_call", id: "c1", name: "submit_report", arguments: { title: "題", body: "結果", sources: [], next_actions: [SUGGESTION, "来週も同じ条件で"] } }],
    usage: USAGE,
  }));

function runDeps(w: RehearsalWorld): AskRunDeps {
  let t = T0.getTime();
  return { ...w.deps(llm()), clock: { now: () => new Date((t += 1000)) }, sleep: async () => {}, concurrency: { pollMs: 1, maxWaitMs: 50 } };
}

async function setup() {
  const { db, url } = T();
  const w = (world = await startRehearsalWorld(db, url));
  const agent = await seedAgent(db, w.ws, def);
  const ask = await db.transaction(async (tx) => {
    const a = await insertAsk(tx, w.ws.ctx, {
      createdBy: w.ws.userId,
      text: `${ASK_URL} の資料をまとめて`,
      shape: "single",
      status: "running",
      trigger: null,
      nextRunAt: null,
      formation: null,
      seedKey: null,
      now: T0,
    });
    await insertAskMember(tx, w.ws.ctx, {
      askId: a.id,
      agentId: agent.agentId,
      jobId: agent.jobId,
      position: 1,
      dependsOn: [],
      isAggregator: false,
      isSpokesperson: true,
      isNew: false,
      summary: "Aの仕事",
      now: T0,
    });
    return a;
  });
  return { w, ask };
}

async function lastTask(w: RehearsalWorld, askId: Uuid): Promise<Uuid> {
  const run = (await getLatestLiveRun(w.db, w.ws.ctx, askId))!;
  return (await listRunTasks(w.db, w.ws.ctx, run.id)).at(-1)!.id;
}

describe("SG-04：依頼のタスクの見た URL の集合（createMemberTask）", () => {
  it("依頼の文の URL は入り、担当の指示にだけある URL は入らない", async () => {
    const { w, ask } = await setup();
    await (await startAskRun(runDeps(w), w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    const taskId = await lastTask(w, ask.id);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(ASK_URL))).toBe(true);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(PLANNER_URL))).toBe(false);
  });

  it("返事の実行：返事の文の URL を入れ、前の回答のタスクが見た URL を写す", async () => {
    const { w, ask } = await setup();
    const deps = runDeps(w);
    await (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    const first = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    // 前の回答のタスクが Web で見た URL
    await w.db.transaction((tx) => addTaskWebUrls(tx, w.ws.ctx, first.answer_task_id!, [key(SEEN_URL)], TASK_WEB_URLS_MAX, T0));
    const replied = await startAskRun(deps, w.ws.ctx, ask.id, {
      requesterId: w.ws.userId,
      trigger: "manual",
      reply: `${REPLY_URL} も見て`,
      replyOf: first.answer_task_id!,
    });
    await replied!.done;
    const taskId = await lastTask(w, ask.id);
    expect(taskId).not.toBe(first.answer_task_id);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(REPLY_URL))).toBe(true);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(ASK_URL))).toBe(true);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(SEEN_URL))).toBe(true);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(PLANNER_URL))).toBe(false);
  });

  /** 最初の回答のあと、reply を返事として送り、返事のタスクを返す */
  async function replyWith(reply: string): Promise<{ w: RehearsalWorld; taskId: Uuid; answerTaskId: Uuid }> {
    const { w, ask } = await setup();
    const deps = runDeps(w);
    await (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "initial" }))!.done;
    const first = (await getLatestLiveRun(w.db, w.ws.ctx, ask.id))!;
    await (await startAskRun(deps, w.ws.ctx, ask.id, { requesterId: w.ws.userId, trigger: "manual", reply, replyOf: first.answer_task_id! }))!.done;
    return { w, taskId: await lastTask(w, ask.id), answerTaskId: first.answer_task_id! };
  }

  it("提案のボタンで送られた返事（前の回答の next_actions と同じ文）の URL は入れない", async () => {
    const { w, taskId, answerTaskId } = await replyWith(SUGGESTION);
    // 前の回答（汚染されていない窓口）の提案は URL つきのまま残っている
    const meta = await w.db.query<{ report_meta: { nextActions?: string[] } | null }>("SELECT report_meta FROM tasks WHERE id = $1", [answerTaskId]);
    expect(meta.rows[0]!.report_meta?.nextActions).toContain(SUGGESTION);
    expect(taskId).not.toBe(answerTaskId);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(SUGGESTED_URL))).toBe(false);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(ASK_URL))).toBe(true);
  });

  it("利用者が自分で書いた返事の URL は入れる（提案を書き足しても、提案の URL は入れない）", async () => {
    const { w, taskId } = await replyWith(`${SUGGESTION}。あと ${REPLY_URL} も見て`);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(REPLY_URL))).toBe(true);
    expect(await hasTaskWebUrl(w.db, w.ws.ctx, taskId, key(SUGGESTED_URL))).toBe(false);
  });
});
