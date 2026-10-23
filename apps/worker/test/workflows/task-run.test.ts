// 担当のタスクの Workflow（workflows/task-run.ts）と DO の進め役（asks/drive.ts）：
// POST /asks → PlanAskWorkflow（編成）→ DO が TaskRunWorkflow を起動 → runner の runTask（LLM は ScriptedLlmClient）→ 報告 → 1歩進める → 回答。
// 順番（前の段の報告を受けて次の段）・LLM の失敗・途中の Kill Switch も確かめる
import { env, introspectWorkflow } from "cloudflare:test";
import { LlmError, ScriptedLlmClient, type LlmRequest, type ScriptedReply } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../src/auth/routes.ts";
import { ensureUser, issueSession } from "../../src/auth/session.ts";
import { all, newId } from "../../src/db/sqlite.ts";
import { createApp } from "../../src/index.ts";
import { setLlmForTest } from "../../src/llm.ts";
import { AskAcceptedResponseSchema, AskDetailResponseSchema, type AskDetailResponse } from "../../src/views/asks/contract.ts";
import { inNamedWorkspace, type FxWorkspace } from "../db/fixtures.ts";
import { jsonReply } from "../asks/helpers.ts";

const NOW = new Date("2026-10-22T09:00:00.000Z");
const ORIGIN = "https://makase.test";

const app = createApp({
  fetch: () => {
    throw new Error("外へは呼ばない");
  },
  now: () => NOW,
});

interface Signed {
  cookie: string;
  csrfToken: string;
  ws: FxWorkspace;
}

async function signIn(label: string): Promise<Signed> {
  const u = await ensureUser(env.DB, { sub: `sub-${label}-${newId()}`, email: `${label}@example.com`, name: null }, NOW);
  await env.WORKSPACE.get(env.WORKSPACE.idFromName(u.workspaceId)).init(u.workspaceId, u.userId);
  const s = await issueSession(env.DB, { userId: u.userId, workspaceId: u.workspaceId, now: NOW });
  return { cookie: `${SESSION_COOKIE}=${s.cookieValue}`, csrfToken: s.csrfToken, ws: { workspaceId: u.workspaceId, userId: u.userId } };
}

function post(path: string, who: Signed, body: unknown): Promise<Response> {
  const headers = { cookie: who.cookie, "x-csrf-token": who.csrfToken, "content-type": "application/json" };
  return Promise.resolve(app.request(`${ORIGIN}/api/v1${path}`, { method: "POST", headers, body: JSON.stringify(body) }, env));
}

async function detail(who: Signed, askId: string): Promise<AskDetailResponse> {
  const res = await app.request(`${ORIGIN}/api/v1/asks/${askId}`, { headers: { cookie: who.cookie } }, env);
  return AskDetailResponseSchema.parse(await res.json());
}

const member = (mark: string, over: Record<string, unknown> = {}) => ({
  summary: `${mark}の仕事`,
  template: "researcher",
  instructions: `MARK-${mark} の仕事をして、結果を報告してください。`,
  grants: [],
  ...over,
});

const reportCall = (id: string, body: string) => ({ type: "tool_call" as const, id, name: "submit_report", arguments: { title: `${body}の題`, body, sources: [] } });
const USAGE = { inputTokens: 500, outputTokens: 50, thinkingTokens: 0 };

/** 設定プランナー（構造化出力の要求）には編成を、担当には印ごとの台本を返す */
function scripted(formation: unknown, agent: Record<string, (req: LlmRequest) => ScriptedReply | Promise<ScriptedReply>>) {
  const seen: string[] = [];
  const llm = new ScriptedLlmClient(async (req) => {
    if (req.responseJsonSchema !== undefined) return jsonReply({ formation });
    const text = `${req.system}\n${JSON.stringify(req.messages)}`;
    const mark = Object.keys(agent).find((m) => text.includes(`MARK-${m}`));
    if (mark === undefined) throw new LlmError("どの担当か分からない", null, false);
    seen.push(mark);
    return agent[mark]!(req);
  });
  return { llm, seen };
}

const reports = (mark: string) => () => ({ parts: [reportCall(`c-${mark}`, `${mark}の結果`)], usage: USAGE });

/** 依頼を送り、編成と担当の Workflow がすべて終わるまで待つ */
async function askAndRun(who: Signed, text: string, llm: ScriptedLlmClient): Promise<string> {
  setLlmForTest(llm);
  await using plans = await introspectWorkflow(env.PLAN_ASK);
  await using runs = await introspectWorkflow(env.TASK_RUN);
  const res = await post("/asks", who, { text });
  expect(res.status).toBe(201);
  const askId = AskAcceptedResponseSchema.parse(await res.json()).ask.id;
  for (const p of await plans.get()) await p.waitForStatus("complete");
  // 1つの担当が終わると次の担当の Workflow が起動する（順番）。増えなくなるまで待つ
  let waited = 0;
  for (let round = 0; round < 10; round += 1) {
    const instances = await runs.get();
    // Kill Switch で止めた Workflow は terminated で終わる
    for (const i of instances.slice(waited)) await i.waitForStatus("complete").catch(() => i.waitForStatus("terminated"));
    if ((await runs.get()).length === instances.length) break;
    waited = instances.length;
  }
  return askId;
}

afterEach(() => setLlmForTest(null));

describe("TaskRunWorkflow", () => {
  it("ひとり：担当が報告し（タスクは completed）、回答になって依頼が done", async () => {
    const who = await signIn("run-single");
    const { llm, seen } = scripted({ shape: "single", members: [member("a", { newName: "在庫係" })] }, { a: reports("a") });
    const askId = await askAndRun(who, "在庫の少ないものを教えて", llm);
    expect(seen).toEqual(["a"]);
    const view = await detail(who, askId);
    expect(view.ask.status).toBe("done");
    expect(view.answer).not.toBeNull();
    expect(JSON.stringify(view.answer)).toContain("aの結果");
    await inNamedWorkspace(who.ws, (db) => {
      const tasks = all<{ status: string; report: string | null }>(db, {}, "SELECT status, report FROM tasks WHERE ask_id = ?", askId);
      // Intent のない報告は completed（Node 版と同じ）
      expect(tasks).toEqual([{ status: "completed", report: "aの結果" }]);
      const types = all<{ type: string }>(db, {}, "SELECT type FROM workspace_events ORDER BY id").map((r) => r.type);
      expect(types).toEqual(expect.arrayContaining(["ask.step.started", "ask.step.finished", "ask.answered"]));
    });
  });

  it("順番：1段目が報告してから2段目が始まり、2段目が窓口として回答する", async () => {
    const who = await signIn("run-chain");
    const { llm, seen } = scripted(
      { shape: "chain", members: [member("a", { newName: "受信箱係" }), member("b", { newName: "棚卸し係", after: [1] })] },
      { a: reports("a"), b: reports("b") },
    );
    const askId = await askAndRun(who, "メールを読んで、在庫を見て", llm);
    expect(seen).toEqual(["a", "b"]);
    const view = await detail(who, askId);
    expect(view.ask.status).toBe("done");
    expect(JSON.stringify(view.answer)).toContain("bの結果");
  });

  it("担当の LLM が失敗したら、タスクは failed(llm_unavailable) で依頼は止まる", async () => {
    const who = await signIn("run-llm-fail");
    const { llm } = scripted(
      { shape: "single", members: [member("a", { newName: "在庫係" })] },
      {
        a: () => {
          throw new LlmError("混んでいる", 503, false);
        },
      },
    );
    const askId = await askAndRun(who, "在庫を見て", llm);
    await inNamedWorkspace(who.ws, (db) => {
      expect(all<{ status: string; fail_reason: string }>(db, {}, "SELECT status, fail_reason FROM tasks WHERE ask_id = ?", askId)).toEqual([
        { status: "failed", fail_reason: "llm_unavailable" },
      ]);
    });
    expect((await detail(who, askId)).ask.status).not.toBe("running");
  });

  it("担当が動いている間に Kill Switch が入ったら、タスクは halted、依頼は cancelled", async () => {
    const who = await signIn("run-kill");
    const { llm } = scripted(
      { shape: "single", members: [member("a", { newName: "在庫係" })] },
      {
        a: async () => {
          expect((await post(`/workspaces/${who.ws.workspaceId}/kill-switch`, who, {})).status).toBe(200);
          return reports("a")();
        },
      },
    );
    const askId = await askAndRun(who, "在庫を見て", llm);
    await inNamedWorkspace(who.ws, (db) => {
      expect(all<{ status: string; halt_reason: string }>(db, {}, "SELECT status, halt_reason FROM tasks WHERE ask_id = ?", askId)).toEqual([
        { status: "halted", halt_reason: "kill_switch" },
      ]);
    });
    expect((await detail(who, askId)).ask.status).toBe("cancelled");
  });
});
