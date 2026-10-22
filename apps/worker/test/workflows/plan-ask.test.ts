// 依頼の編成の Workflow（workflows/plan-ask.ts）：POST /asks → DO が PlanAskWorkflow を起動 → 設定プランナー（ScriptedLlmClient）→
// 保存して最初の実行を始める（担当のタスクが queued で並ぶ）。質問・LLM の失敗・途中の Kill Switch も確かめる
import { env, introspectWorkflow } from "cloudflare:test";
import { LlmError, ScriptedLlmClient, type ScriptedStep } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../src/auth/routes.ts";
import { ensureUser, issueSession } from "../../src/auth/session.ts";
import { all, count, newId } from "../../src/db/sqlite.ts";
import { createApp } from "../../src/index.ts";
import { setLlmForTest } from "../../src/llm.ts";
import { AskAcceptedResponseSchema, AskDetailResponseSchema } from "../../src/views/asks/contract.ts";
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

async function detail(who: Signed, askId: string) {
  const res = await app.request(`${ORIGIN}/api/v1/asks/${askId}`, { headers: { cookie: who.cookie } }, env);
  return AskDetailResponseSchema.parse(await res.json());
}

const member = (over: Record<string, unknown> = {}) => ({
  summary: "在庫を見る",
  template: "researcher",
  instructions: "在庫の表を見て、少ないものをまとめてください。",
  grants: [],
  ...over,
});

/** 依頼を送り、起動した編成の Workflow が終わるまで待って、その結果を返す */
async function askAndPlan(who: Signed, text: string, script: readonly ScriptedStep[]) {
  setLlmForTest(new ScriptedLlmClient(script));
  await using flows = await introspectWorkflow(env.PLAN_ASK);
  const res = await post("/asks", who, { text });
  expect(res.status).toBe(201);
  const askId = AskAcceptedResponseSchema.parse(await res.json()).ask.id;
  const [instance] = await flows.get();
  expect(instance).toBeDefined();
  await instance!.waitForStatus("complete");
  return { askId, output: (await instance!.getOutput()) as { outcome: string; runId?: string | null; taskIds?: string[] } };
}

afterEach(() => setLlmForTest(null));

describe("PlanAskWorkflow", () => {
  it("ひとり：新しい担当を作り、依頼は running、担当のタスクが queued で並ぶ。費用は planner で残る", async () => {
    const who = await signIn("plan-single");
    const { askId, output } = await askAndPlan(who, "在庫の少ないものを教えて", [
      jsonReply({ formation: { shape: "single", members: [member({ newName: "在庫の守護神", role: "watch" })] } }),
    ]);
    expect(output.outcome).toBe("formed");
    expect(output.taskIds).toHaveLength(1);

    const view = await detail(who, askId);
    expect(view.ask).toMatchObject({ status: "running", shape: "single" });
    // ひとりは形の1行を出さない（kernel の shapeLine）。編成は formation に並ぶ
    expect(view.formation?.members.map((m) => m.agentName)).toEqual(["在庫の守護神"]);

    await inNamedWorkspace(who.ws, (db) => {
      expect(all<{ status: string }>(db, {}, "SELECT status FROM tasks WHERE ask_id = ?", askId)).toEqual([{ status: "queued" }]);
      expect(all<{ name: string }>(db, {}, "SELECT name FROM agents")).toEqual([{ name: "在庫の守護神" }]);
      expect(count(db, "SELECT count(*) FROM usage_records WHERE ask_id = ? AND phase = 'planner'", askId)).toBe(1);
      expect(all<{ planner_attempts: number }>(db, {}, "SELECT planner_attempts FROM asks WHERE id = ?", askId)[0]?.planner_attempts).toBe(1);
      const types = all<{ type: string }>(db, {}, "SELECT type FROM workspace_events ORDER BY id").map((r) => r.type);
      expect(types).toEqual(expect.arrayContaining(["ask.created", "ask.formed", "ask.step.started"]));
    });
  });

  it("順番：1段目の担当のタスクだけが並ぶ", async () => {
    const who = await signIn("plan-chain");
    const { askId, output } = await askAndPlan(who, "メールを読んで、在庫を見て", [
      jsonReply({
        formation: {
          shape: "chain",
          members: [member({ newName: "受信箱係", summary: "メールを読む" }), member({ newName: "棚卸し係", summary: "在庫を見る", after: [1] })],
        },
      }),
    ]);
    expect(output.outcome).toBe("formed");
    expect(output.taskIds).toHaveLength(1);
    expect((await detail(who, askId)).ask.shape).toBe("chain");
  });

  it("質問：質問を載せて止まり、答えると編成を作る", async () => {
    const who = await signIn("plan-question");
    const question = { text: "どの店の在庫ですか", choices: [{ id: "c1", label: "本店" }, { id: "c2", label: "駅前店" }], allowFreeText: false };
    const first = await askAndPlan(who, "在庫を見て", [jsonReply({ question })]);
    expect(first.output.outcome).toBe("question");
    expect((await detail(who, first.askId)).ask.question).toMatchObject({ text: "どの店の在庫ですか" });

    setLlmForTest(new ScriptedLlmClient([jsonReply({ formation: { shape: "single", members: [member({ newName: "駅前の棚番" })] } })]));
    await using flows = await introspectWorkflow(env.PLAN_ASK);
    expect((await post(`/asks/${first.askId}/answer`, who, { choiceId: "c2" })).status).toBe(200);
    const [instance] = await flows.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toMatchObject({ outcome: "formed" });
    expect((await detail(who, first.askId)).ask.status).toBe("running");
  });

  it("LLM が失敗したら failed（planner_error）。送れたか分からない失敗も見積もりを費用に数える", async () => {
    const who = await signIn("plan-llm-fail");
    const { askId, output } = await askAndPlan(who, "在庫を見て", [
      () => {
        throw new LlmError("混んでいる", null, false);
      },
    ]);
    expect(output.outcome).toBe("failed");
    const view = await detail(who, askId);
    expect(view.ask).toMatchObject({ status: "failed", failure: { reason: "planner_error" } });
    await inNamedWorkspace(who.ws, (db) => {
      expect(count(db, "SELECT count(*) FROM usage_records WHERE ask_id = ? AND cost_micro_usd > 0", askId)).toBe(1);
    });
  });

  it("計画の途中で Kill Switch が入ったら、保存せず failed（kill_switch）", async () => {
    const who = await signIn("plan-kill");
    const { askId, output } = await askAndPlan(who, "在庫を見て", [
      async () => {
        expect((await post(`/workspaces/${who.ws.workspaceId}/kill-switch`, who, {})).status).toBe(200);
        return jsonReply({ formation: { shape: "single", members: [member({ newName: "在庫係" })] } });
      },
    ]);
    expect(output.outcome).toBe("failed");
    expect((await detail(who, askId)).ask).toMatchObject({ status: "failed", failure: { reason: "kill_switch" } });
    await inNamedWorkspace(who.ws, (db) => {
      expect(count(db, "SELECT count(*) FROM agents")).toBe(0);
      expect(count(db, "SELECT count(*) FROM tasks")).toBe(0);
    });
  });
});
