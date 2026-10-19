// 試験の保存（persist.ts）の試験。DB は useTestDb、LLM は ScriptedLlmClient
import { fxAgent, fxRehearsalRun, fxSimExecution, fxSimSnapshot, fxTask, fxWorkspace, useTestDb } from "@open-team/db/testing";
import { ScriptedLlmClient } from "@open-team/llm";
import { MAX_CASES_PER_JOB } from "@open-team/rehearsal";
import { toScenario } from "@open-team/sim-core";
import type { ScenarioDraft } from "@open-team/sim-core";
import { describe, expect, it } from "vitest";
import { generateScenarios } from "./generate.ts";
import { interpretUserBadDay } from "./interpret.ts";
import { loadUserInputCreatedAts, recordInterpretation, saveGeneratedCases } from "./persist.ts";
import { generatorOf } from "./result.ts";
import { JOB, MODEL, draft, f02, f04, f05, f06, jsonReply } from "./test-helpers.ts";

const T = useTestDb();
const NOW = new Date("2026-10-14T01:00:00.000Z");

async function setup(kind: "owner" | "guest" = "guest") {
  const { db } = T();
  const ws = await fxWorkspace(db, { kind });
  const agent = await fxAgent(db, ws);
  return { db, ws, agent, subject: { jobId: agent.jobId } };
}

const gen = async (n: number, seed = 1) => {
  const skus = ["BEAN-HOUSE", "BEAN-DECAF", "MILK-1L", "CREAM-200", "CUP-M"];
  const scenarios = Array.from({ length: n }, (_, i) => draft(`値上がり ${i}`, f05({ sku: skus[i % 5], multiplier: 1.5 + Math.floor(i / 5) * 0.5 })));
  return generateScenarios({ job: JOB, seed, llm: new ScriptedLlmClient([jsonReply({ scenarios })]), model: MODEL, count: n });
};

describe("saveGeneratedCases（FR-042）", () => {
  it("originRunId を付けて保存すると、走行の「悪い日を N 件作りました」の N（generatorOf の count）に数える。付けない保存は数えない", async () => {
    const { db, ws, subject } = await setup();
    const { runId } = await fxRehearsalRun(db, ws, { jobId: subject.jobId, trigger: "initial" });
    await saveGeneratedCases(db, ws.ctx, { subject, scenarios: (await gen(3)).scenarios, now: NOW, originRunId: runId });
    await saveGeneratedCases(db, ws.ctx, { subject, scenarios: (await gen(2, 2)).scenarios, now: NOW });
    expect(await generatorOf(db, ws.ctx, { id: runId, generator_model_id: MODEL, is_seed: false })).toMatchObject({ model: MODEL, count: 3 });
  });
  it("生成した状況を rehearsal_cases（source = generated）に保存する：障害 ID・シード・Scenario の JSON・作成者", async () => {
    const { db, ws, subject } = await setup();
    const g = await generateScenarios({
      job: JOB,
      seed: 7,
      llm: new ScriptedLlmClient([jsonReply({ scenarios: [draft("だましのメール", f02(), f05()), draft("単位", f04())] })]),
      model: MODEL,
    });
    const r = await saveGeneratedCases(db, ws.ctx, { subject, scenarios: g.scenarios, now: NOW });
    expect(r.skippedIndexes).toEqual([]);
    expect(r.saved).toHaveLength(2);
    expect(r.saved[0]).toMatchObject({ source: "generated", fault_ids: ["F-02", "F-05"], seed: g.scenarios[0]!.seed, user_text: null, created_by: ws.userId, removed_at: null });
    expect(r.saved[0]!.scenario).toEqual(JSON.parse(JSON.stringify(g.scenarios[0])));
    expect(r.saved[1]).toMatchObject({ fault_ids: ["F-04"], seed: g.scenarios[1]!.seed });
  });

  it("generated 以外の origin は保存しない（例外。何も書かない）", async () => {
    const { db, ws, subject } = await setup();
    const g = await gen(2);
    const bad = { ...g.scenarios[1]!, origin: { source: "user" as const, inputText: "x" } };
    await expect(saveGeneratedCases(db, ws.ctx, { subject, scenarios: [g.scenarios[0]!, bad], now: NOW })).rejects.toThrow(TypeError);
    expect((await db.query("SELECT 1 FROM rehearsal_cases WHERE workspace_id = $1", [ws.workspaceId])).rowCount).toBe(0);
  });

  it("仕事ごとの上限20件：収まらない状況は保存せず skippedIndexes で返す。収まるなら同じ reasonCode の古い incident をまとめて空ける", async () => {
    const { db, ws, agent, subject } = await setup();
    const first = await gen(MAX_CASES_PER_JOB);
    const r1 = await saveGeneratedCases(db, ws.ctx, { subject, scenarios: first.scenarios, now: NOW });
    expect(r1.saved).toHaveLength(20);
    const more = await gen(2, 2);
    const r2 = await saveGeneratedCases(db, ws.ctx, { subject, scenarios: more.scenarios, now: NOW });
    expect(r2.saved).toHaveLength(0);
    expect(r2.skippedIndexes).toEqual([0, 1]);
    expect((await db.query("SELECT 1 FROM rehearsal_cases WHERE job_id = $1 AND removed_at IS NULL", [agent.jobId])).rowCount).toBe(20);
  });

  it("まとめられる incident があれば、古いものを merged で外して足す（stopped_writes は残す1件へ）", async () => {
    const { db, ws, agent, subject } = await setup();
    const live = await fxSimExecution(db, ws);
    const { taskId } = await fxTask(db, ws, agent);
    const snap = await fxSimSnapshot(db, ws, { executionId: live.executionId, sourceTaskId: taskId });
    const ids: string[] = [];
    for (let n = 1; n <= 2; n++) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO rehearsal_cases (workspace_id, job_id, source, fault_ids, scenario, seed, sim_snapshot_id, source_task_id, reason_code, incident_kind, stopped_writes, created_at)
         VALUES ($1, $2, 'incident', '{}', '{}'::jsonb, 1, $3, $4, 'guard_exceeded', 'kernel_approve', $5::jsonb, $6) RETURNING id`,
        [ws.workspaceId, agent.jobId, snap.snapshotId, taskId, [{ n }], new Date(NOW.getTime() - (3 - n) * 60_000)],
      );
      ids.push(r.rows[0]!.id);
    }
    const g = await gen(18);
    await saveGeneratedCases(db, ws.ctx, { subject, scenarios: g.scenarios, now: NOW });
    const more = await gen(1, 9);
    // 18 + incident 2 = 20。1件足すと21件 → 古い incident をまとめて空ける
    const dup = await generateScenarios({ job: JOB, seed: 3, llm: new ScriptedLlmClient([jsonReply({ scenarios: [draft("新しい", f06())] })]), model: MODEL });
    const r = await saveGeneratedCases(db, ws.ctx, { subject, scenarios: dup.scenarios, now: NOW });
    expect(more.scenarios).toHaveLength(1);
    expect(r.saved).toHaveLength(1);
    expect(r.mergedIds).toEqual([ids[0]]);
    const rows = await db.query<{ id: string; removed_reason: string | null; stopped_writes: unknown }>("SELECT id, removed_reason, stopped_writes FROM rehearsal_cases WHERE id = ANY($1::uuid[])", [ids]);
    const by = new Map(rows.rows.map((x) => [x.id, x]));
    expect(by.get(ids[0]!)!.removed_reason).toBe("merged");
    expect(by.get(ids[1]!)!.stopped_writes).toEqual([{ n: 2 }, { n: 1 }]);
  });

  it("ほかのワークスペースの試験は数えない", async () => {
    const a = await setup();
    const b = await setup();
    await saveGeneratedCases(a.db, a.ws.ctx, { subject: a.subject, scenarios: (await gen(MAX_CASES_PER_JOB)).scenarios, now: NOW });
    const r = await saveGeneratedCases(b.db, b.ws.ctx, { subject: b.subject, scenarios: (await gen(3, 5)).scenarios, now: NOW });
    expect(r.saved).toHaveLength(3);
  });
});

const matchedOut = {
  result: "matched",
  scenario: { title: "店長を名乗る至急の発注", faults: [f02()] },
  interpretation: "送り主：店長の名前を名乗る外部のアドレス、内容：豆 100kg の至急発注",
};

describe("recordInterpretation（FR-065）", () => {
  const interpret = async (
    s: Awaited<ReturnType<typeof setup>>,
    llm: ScriptedLlmClient,
    text = "店長の名前で至急の発注が来る",
    kind: "owner" | "guest" = "guest",
  ) =>
    interpretUserBadDay({
      text,
      job: JOB,
      seed: 11,
      llm,
      model: MODEL,
      workspaceKind: kind,
      userInputCreatedAts: await loadUserInputCreatedAts(s.db, s.ws.ctx),
      now: NOW.toISOString(),
    });

  it("matched：rehearsal_user_inputs（matched）と rehearsal_cases（source = user・user_text・障害 ID）を足し、入力から試験を引ける", async () => {
    const s = await setup();
    const result = await interpret(s, new ScriptedLlmClient([jsonReply(matchedOut)]));
    const r = await recordInterpretation(s.db, s.ws.ctx as never, { subject: s.subject, result, now: NOW });
    expect(r).toMatchObject({ recorded: true, status: "matched" });
    if (!r.recorded || r.caseId === null) throw new Error("保存されていない");
    const c = (await s.db.query<Record<string, unknown>>("SELECT * FROM rehearsal_cases WHERE id = $1", [r.caseId])).rows[0]!;
    expect(c).toMatchObject({ source: "user", user_text: "店長の名前で至急の発注が来る", fault_ids: ["F-02"], seed: 11, created_by: s.ws.userId });
    const i = (await s.db.query<Record<string, unknown>>("SELECT * FROM rehearsal_user_inputs WHERE id = $1", [r.inputId])).rows[0]!;
    expect(i).toMatchObject({ status: "matched", case_id: r.caseId, nearest_fault_id: null, text: "店長の名前で至急の発注が来る" });
    expect(i.interpretation).toMatchObject({ faultIds: ["F-02"], line: expect.stringContaining("こう解釈しました：F-02 仕込まれた指示") });
  });

  it("unmatched：入力を no_match で残し（近い障害 ID・カタログの候補）、試験は足さない", async () => {
    const s = await setup();
    const result = await interpret(s, new ScriptedLlmClient([jsonReply({ result: "unmatched", nearest: "F-06" })]), "仕入れ先が倒産した");
    const r = await recordInterpretation(s.db, s.ws.ctx as never, { subject: s.subject, result, now: NOW });
    expect(r).toMatchObject({ recorded: true, status: "no_match", caseId: null });
    const i = (await s.db.query<Record<string, unknown>>("SELECT * FROM rehearsal_user_inputs WHERE workspace_id = $1", [s.ws.workspaceId])).rows[0]!;
    expect(i).toMatchObject({ status: "no_match", nearest_fault_id: "F-06", case_id: null });
    expect(i.interpretation).toMatchObject({ candidate: { text: "仕入れ先が倒産した", nearestFaultId: "F-06" } });
    expect((await s.db.query("SELECT 1 FROM rehearsal_cases WHERE workspace_id = $1", [s.ws.workspaceId])).rowCount).toBe(0);
  });

  it("rejected：入力を failed で残し、試験は足さない", async () => {
    const s = await setup();
    const bad = jsonReply({ result: "matched", scenario: { title: "x", faults: [{ id: "F-99" }] }, interpretation: "x" });
    const result = await interpret(s, new ScriptedLlmClient([bad, bad]));
    const r = await recordInterpretation(s.db, s.ws.ctx as never, { subject: s.subject, result, now: NOW });
    expect(r).toMatchObject({ recorded: true, status: "failed", caseId: null });
    expect((await s.db.query("SELECT 1 FROM rehearsal_cases WHERE workspace_id = $1", [s.ws.workspaceId])).rowCount).toBe(0);
    expect((await s.db.query("SELECT 1 FROM rehearsal_user_inputs WHERE status = 'failed' AND workspace_id = $1", [s.ws.workspaceId])).rowCount).toBe(1);
  });

  it("Gemini を呼んでいない結果（不正な入力）は何も書かない", async () => {
    const s = await setup();
    const result = await interpret(s, new ScriptedLlmClient([]), "   ");
    expect(result.kind).toBe("invalid_input");
    expect(await recordInterpretation(s.db, s.ws.ctx as never, { subject: s.subject, result, now: NOW })).toEqual({ recorded: false, reason: "not_called" });
    expect((await s.db.query("SELECT 1 FROM rehearsal_user_inputs WHERE workspace_id = $1", [s.ws.workspaceId])).rowCount).toBe(0);
  });

  it("ゲストは1日5件：5件保存したあとの6件目は quota_exceeded で Gemini を呼ばない。失敗・カタログにないものも数える。オーナーは上限なし", async () => {
    const s = await setup("guest");
    // カタログにない入力・失敗も1件に数える
    const llm = new ScriptedLlmClient([
      jsonReply({ result: "unmatched", nearest: "F-06" }),
      jsonReply({ result: "matched", scenario: { title: "x", faults: [{ id: "F-99" }] }, interpretation: "x" }),
      jsonReply({ result: "matched", scenario: { title: "x", faults: [{ id: "F-99" }] }, interpretation: "x" }),
      jsonReply(matchedOut),
      jsonReply(matchedOut),
      jsonReply(matchedOut),
    ]);
    for (let n = 0; n < 5; n++) {
      const result = await interpret(s, llm, `悪い日 ${n}`);
      expect(result.kind).not.toBe("quota_exceeded");
      await recordInterpretation(s.db, s.ws.ctx as never, { subject: s.subject, result, now: NOW });
    }
    const calls = llm.requests.length;
    const sixth = await interpret(s, llm, "6件目");
    expect(sixth.kind).toBe("quota_exceeded");
    expect(llm.requests).toHaveLength(calls);
    expect(await recordInterpretation(s.db, s.ws.ctx as never, { subject: s.subject, result: sixth, now: NOW })).toMatchObject({ recorded: false });

    const o = await setup("owner");
    const ollm = new ScriptedLlmClient(Array.from({ length: 7 }, () => jsonReply(matchedOut)));
    for (let n = 0; n < 6; n++) {
      const result = await interpret(o, ollm, `悪い日 ${n}`, "owner");
      expect(result.kind).toBe("matched");
      await recordInterpretation(o.db, o.ws.ctx as never, { subject: o.subject, result, now: NOW });
    }
  });

  it("試験が上限（20件）で収まらないときは試験を足さず、入力を failed にして limit_reached を返す", async () => {
    const s = await setup("owner");
    await saveGeneratedCases(s.db, s.ws.ctx, { subject: s.subject, scenarios: (await gen(MAX_CASES_PER_JOB)).scenarios, now: NOW });
    const result = await interpret(s, new ScriptedLlmClient([jsonReply(matchedOut)]), "x", "owner");
    const r = await recordInterpretation(s.db, s.ws.ctx as never, { subject: s.subject, result, now: NOW });
    expect(r).toMatchObject({ recorded: true, status: "failed", caseId: null, reason: "limit_reached" });
    expect((await s.db.query("SELECT 1 FROM rehearsal_cases WHERE job_id = $1 AND removed_at IS NULL", [s.agent.jobId])).rowCount).toBe(20);
  });

  it("matched の Scenario は toScenario と同じ形（再現用のシード・origin を持つ）", async () => {
    const s = await setup();
    const result = await interpret(s, new ScriptedLlmClient([jsonReply(matchedOut)]));
    if (result.kind !== "matched") throw new Error("matched ではない");
    const expected = toScenario(matchedOut.scenario as unknown as ScenarioDraft, { world: "shop", seed: 11, origin: { source: "user", inputText: "店長の名前で至急の発注が来る" } });
    expect(result.scenario).toEqual(expected);
  });
});
