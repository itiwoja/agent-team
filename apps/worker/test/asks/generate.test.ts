// 依頼の生成の DB 側（src/asks/generate.ts）の試験：材料・質問・編成の保存・失敗で閉じる。
// apps/app/src/asks/create.test.ts のうち DB で確かめられるもの（closeFailedStart・policyLinesOf）と、編成の保存（materializeFormation）を試す。
// 時間切れ・登録簿の中断は Workflow 側（4b の残り）なので、ここでは failureReasonOf の対応だけを見る
import { defaultWorkspacePolicy } from "@open-team/kernel";
import { ScriptedLlmClient } from "@open-team/llm";
import { describe, expect, it } from "vitest";
import {
  closeFailedStart,
  failGeneration,
  failureReasonOf,
  loadPlannerMaterials,
  materializeFormation,
  policyLinesOf,
  savePlanQuestion,
} from "../../src/asks/generate.ts";
import { AskPlanError, planFormation } from "../../src/asks/planner.ts";
import { insertPackInstall } from "../../src/db/repo/sandbox.ts";
import { getAsk, insertGeneratingAsk, insertLiveRun, listMembers, markAskFormed, setAskQuestion, setAskQuestionAnswer } from "../../src/db/repo/asks.ts";
import { all, count, run, type WsDb } from "../../src/db/sqlite.ts";
import type { Uuid } from "../../src/db/types.ts";
import { FIXED_NOW, fxAgent, fxConnector, inWorkspace, type FxWorkspace } from "../db/fixtures.ts";
import { auditTypes, draftMember, events, formAsk, fxPolicy, jsonReply } from "./helpers.ts";

const NOW = FIXED_NOW;
const SECRET = "sk-test-secret-0123456789abcdef";

function generating(db: WsDb, ws: FxWorkspace, text = "競合を調べて"): Uuid {
  return insertGeneratingAsk(db, { createdBy: ws.userId, text, mentionAgentId: null, now: NOW }).id;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("投げるはず");
}

describe("loadPlannerMaterials", () => {
  it("担当・コネクタ・ポリシーの要約を集める。作業場は使えない（false）", () =>
    inWorkspace((db, ws) => {
      fxPolicy(db, NOW, ["supplier"]);
      fxConnector(db);
      const agent = fxAgent(db, { name: "仕入れ係" });
      const askId = generating(db, ws);
      const m = loadPlannerMaterials(db, askId);
      expect(m?.ask.id).toBe(askId);
      expect(m?.input).toMatchObject({ text: "競合を調べて", mention: null, pack: null, answered: null, sandbox: false });
      expect(m?.input.agents).toEqual([
        expect.objectContaining({ agentId: agent.agentId, name: "仕入れ係", jobCount: 1, grants: { supplier: ["place_order", "list_products"] }, templates: ["assistant"], skills: [] }),
      ]);
      expect(m?.input.connectors[0]).toMatchObject({ slug: "supplier", connected: true });
      expect(m?.input.policyLines.at(-1)).toBe("使えるコネクタ：supplier");
    }));

  it("generating でない・質問に答えていなければ null。答えたら answered に入る", () =>
    inWorkspace((db, ws) => {
      fxPolicy(db, NOW);
      const askId = generating(db, ws);
      setAskQuestion(db, askId, { text: "どの店？", choices: [{ id: "a", label: "本店" }], allowFreeText: true }, NOW);
      expect(loadPlannerMaterials(db, askId)).toBeNull();
      setAskQuestionAnswer(db, askId, "本店", NOW);
      expect(loadPlannerMaterials(db, askId)?.input.answered).toEqual({ question: "どの店？", answer: "本店" });
      markAskFormed(db, askId, { shape: "single", formation: {}, trigger: null, nextRunAt: null, now: NOW });
      expect(loadPlannerMaterials(db, askId)).toBeNull();
    }));

  it("パックの作業場から出した依頼：入れた担当のうち動けるものをヒントにする（名前は pack_id）", () =>
    inWorkspace((db, ws) => {
      fxPolicy(db, NOW);
      const a = fxAgent(db, { name: "採点係" });
      insertPackInstall(db, { packId: "teacher", version: 1, userId: ws.userId, agentIds: [a.agentId, "00000000-0000-4000-8000-000000000000"], now: NOW });
      const askId = insertGeneratingAsk(db, { createdBy: ws.userId, text: "採点して", mentionAgentId: null, packId: "teacher", now: NOW }).id;
      expect(loadPlannerMaterials(db, askId)?.input.pack).toEqual({ id: "teacher", name: "teacher", agentIds: [a.agentId] });
    }));

  it("ポリシーがなければ planner_error", () =>
    inWorkspace((db, ws) => {
      const askId = generating(db, ws);
      expect(caught(() => loadPlannerMaterials(db, askId))).toMatchObject({ name: "AskPlanError", code: "planner_error" });
    }));
});

describe("policyLinesOf", () => {
  it("ポリシーの要約を固定の文で作る（書き込みは確認が要る・予算・使えるコネクタ）", () => {
    const lines = policyLinesOf(defaultWorkspacePolicy());
    expect(lines).toContain("書き込み（発注・送信など）は送る前の確認が要る");
    expect(lines.join("\n")).toMatch(/予算は \$0\.5、1日は \$10/);
    expect(lines.at(-1)).toMatch(/^使えるコネクタ：/);
  });
});

describe("savePlanQuestion", () => {
  it("質問を載せ、ask.question の事象と監査ログを残す。2つ目は載せない（BR-49）", () =>
    inWorkspace((db, ws) => {
      const askId = generating(db, ws);
      const q = { text: "どの店舗ですか？", choices: [{ id: "a", label: "本店" }], allowFreeText: false };
      expect(savePlanQuestion(db, askId, q, NOW)).toBe(true);
      expect(getAsk(db, askId)).toMatchObject({ status: "generating", question: q });
      expect(events(db, "ask.question").map((e) => e.data)).toEqual([{ type: "ask.question", askId, question: q }]);
      expect(auditTypes(db)).toContain("ask.question");
      expect(savePlanQuestion(db, askId, { ...q, text: "別の質問" }, NOW)).toBe(false);
      expect(events(db, "ask.question")).toHaveLength(1);
    }));
});

describe("materializeFormation", () => {
  it("新しい担当を作り、使い回す担当には仕事を足す。ask_members ができ、依頼は running、ask.formed を出す", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW, ["supplier"]);
      fxConnector(db);
      const reuse = fxAgent(db, { name: "仕入れ係" });
      const askId = generating(db, ws);
      const mats = loadPlannerMaterials(db, askId)!;
      const plan = await planFormation(mats.input, {
        llm: new ScriptedLlmClient([
          jsonReply({
            formation: {
              shape: "chain",
              members: [draftMember({ newName: "グルメ探偵", role: "research" }), draftMember({ agentId: reuse.agentId, template: "assistant", summary: "発注する", instructions: "必要なら発注してください。" })],
              schedule: { cron: "0 18 * * *" },
            },
          }),
        ]),
        model: "m",
      });
      if (plan.kind !== "formation") throw new Error("編成のはず");
      const formed = materializeFormation(db, { askId, requesterId: ws.userId, planned: plan.formation, now: NOW });
      expect(formed?.ask).toMatchObject({ status: "running", shape: "chain", trigger: { type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" } });
      // NOW は 18:00 JST ちょうど。ちょうどは含まないので次の日の 18:00 JST
      expect(formed?.ask.next_run_at?.toISOString()).toBe("2026-10-13T09:00:00.000Z");
      const members = listMembers(db, askId);
      expect(members.map((m) => [m.agent_name, m.position, m.depends_on, m.is_new, m.is_spokesperson])).toEqual([
        ["グルメ探偵", 1, [], true, false],
        ["仕入れ係", 2, [1], false, true],
      ]);
      // 仕事：新しい担当に1つ、使い回す担当に1つ足す（定期なので recurring）
      const jobs = all<{ agent_id: string; slug: string; kind: string }>(db, {}, "SELECT agent_id, slug, kind FROM agent_jobs WHERE slug LIKE 'ask-%' ORDER BY slug");
      expect(jobs.map((j) => j.kind)).toEqual(["recurring", "recurring"]);
      expect(jobs.map((j) => j.agent_id)).toContain(reuse.agentId);
      // 使い回す担当は新しいスナップショットになる
      expect(count(db, "SELECT count(*) FROM agent_snapshots WHERE agent_id = ?", reuse.agentId)).toBe(2);
      const ev = events(db, "ask.formed");
      expect(ev).toHaveLength(1);
      expect(ev[0]!.data).toMatchObject({ askId, trigger: { cron: "0 18 * * *" } });
      expect(auditTypes(db)).toEqual(expect.arrayContaining(["agent.created", "job.created", "ask.formed"]));
    }));

  it("generating でなくなっていれば null（何も作らない）", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const askId = generating(db, ws);
      const mats = loadPlannerMaterials(db, askId)!;
      const plan = await planFormation(mats.input, { llm: new ScriptedLlmClient([jsonReply({ formation: { shape: "single", members: [draftMember({ newName: "調べ屋" })] } })]), model: "m" });
      if (plan.kind !== "formation") throw new Error("編成のはず");
      failGeneration(db, { askId, reason: "timeout", detail: "時間切れ", now: NOW, secrets: [] });
      expect(materializeFormation(db, { askId, requesterId: ws.userId, planned: plan.formation, now: NOW })).toBeNull();
      expect(count(db, "SELECT count(*) FROM agents")).toBe(0);
    }));
});

describe("failGeneration・failureReasonOf", () => {
  it("generating → failed。ask.failed の事象（画面の1行）と監査ログ（detail は秘密を伏せる）。閉じたあとは何もしない", () =>
    inWorkspace((db, ws) => {
      const askId = generating(db, ws);
      failGeneration(db, { askId, reason: "planner_error", detail: `呼べなかった ${SECRET}`, now: NOW, secrets: [SECRET] });
      expect(getAsk(db, askId)).toMatchObject({ status: "failed", failure_reason: "planner_error" });
      expect(events(db, "ask.failed").map((e) => e.data)).toEqual([
        { type: "ask.failed", askId, reason: "planner_error", message: "Claude の呼び出しに失敗しました。もう一度送ってください" },
      ]);
      const payload = all<{ payload: string }>(db, {}, "SELECT payload FROM audit_logs WHERE event_type = 'ask.failed'")[0]!.payload;
      expect(payload).not.toContain(SECRET);
      failGeneration(db, { askId, reason: "timeout", detail: "x", now: NOW, secrets: [] });
      expect(events(db, "ask.failed")).toHaveLength(1);
      expect(getAsk(db, askId)?.failure_reason).toBe("planner_error");
    }));

  it("理由の対応：AskPlanError の code・LlmCallError の kind・時間切れ", () => {
    const llmErr = (kind: string) => Object.assign(new Error("x"), { name: "LlmCallError", kind });
    expect(failureReasonOf(new AskPlanError("agent_limit", "x"), true)).toBe("agent_limit");
    expect(failureReasonOf(llmErr("budget"), false)).toBe("budget_exceeded");
    expect(failureReasonOf(llmErr("aborted"), true)).toBe("timeout");
    expect(failureReasonOf(llmErr("aborted"), false)).toBe("planner_error");
    expect(failureReasonOf(llmErr("llm"), false)).toBe("planner_error");
    expect(failureReasonOf(llmErr("unpriced_model"), true)).toBe("planner_error");
    expect(failureReasonOf(new Error("x"), true)).toBe("timeout");
    expect(failureReasonOf(new Error("x"), false)).toBe("planner_error");
  });
});

describe("編成のあと実行を始められなかったとき（closeFailedStart）", () => {
  /** 編成ができた直後の依頼（running）。実行の行はまだない */
  function runningAsk(db: WsDb, ws: FxWorkspace): Uuid {
    const askId = generating(db, ws);
    expect(markAskFormed(db, askId, { shape: "single", formation: {}, trigger: null, nextRunAt: null, now: NOW })).toMatchObject({ status: "running" });
    return askId;
  }
  const statuses = (db: WsDb) => events(db, "ask.status").map((e) => e.data.status);

  it("そのほかの失敗は running → failed（SSE も出す）", () =>
    inWorkspace((db, ws) => {
      const askId = runningAsk(db, ws);
      closeFailedStart(db, { askId, error: new Error("接続が切れた"), now: NOW, secrets: [] });
      expect(getAsk(db, askId)).toMatchObject({ status: "failed" });
      expect(statuses(db)).toEqual(["failed"]);
    }));

  it("すでに running でない依頼・実行がもうある依頼は触らない（遷移も SSE もなし）", () =>
    inWorkspace((db, ws) => {
      const done = runningAsk(db, ws);
      run(db, "UPDATE asks SET status = 'done' WHERE id = ?", done);
      closeFailedStart(db, { askId: done, error: new Error("遅れて届いた失敗"), now: NOW, secrets: [] });
      expect(getAsk(db, done)).toMatchObject({ status: "done" });
      const started = runningAsk(db, ws);
      expect(insertLiveRun(db, started, "manual", NOW)).not.toBeNull();
      closeFailedStart(db, { askId: started, error: new Error("一時的な失敗"), now: NOW, secrets: [] });
      expect(getAsk(db, started)).toMatchObject({ status: "running" });
      expect(statuses(db)).toHaveLength(0);
    }));
});

describe("仕事の空き（A-81）", () => {
  it("仕事が10個になったら、終わった1回きりの仕事を古い順に外して受け続ける", () =>
    inWorkspace(async (db, ws) => {
      fxPolicy(db, NOW);
      const first = await formAsk(db, ws.userId, NOW, { shape: "single", members: [draftMember({ newName: "調べ屋" })] });
      run(db, "UPDATE asks SET status = 'done' WHERE id = ?", first.askId);
      const agentId = all<{ agent_id: string }>(db, {}, "SELECT agent_id FROM ask_members WHERE ask_id = ?", first.askId)[0]!.agent_id;
      for (let k = 0; k < 10; k += 1) {
        const { askId } = await formAsk(db, ws.userId, NOW, { shape: "single", members: [draftMember({ agentId })] });
        run(db, "UPDATE asks SET status = 'done' WHERE id = ?", askId);
      }
      const jobs = all<{ status: string }>(db, {}, "SELECT status FROM agent_jobs WHERE agent_id = ?", agentId);
      expect(jobs).toHaveLength(11);
      expect(jobs.filter((j) => j.status === "done")).toHaveLength(1);
      const def = all<{ definition: string }>(db, {}, "SELECT s.definition FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id WHERE a.id = ?", agentId)[0]!;
      expect((JSON.parse(def.definition) as { jobs: unknown[] }).jobs).toHaveLength(10);
      // 終わった仕事は数えない
      const askId = generating(db, ws, "次");
      expect(loadPlannerMaterials(db, askId)?.input.agents.find((a) => a.agentId === agentId)?.jobCount).toBe(0);
    }));
});
