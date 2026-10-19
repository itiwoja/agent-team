// リハーサル1回の骨組み（orchestrate.ts）の試験：開始 → 生成 → 実行（影つき）→ 適応 → 締める提案 → [適用]・再試験 までを、本物に近い世界で通す。
// LLM だけ台本。報告の数字は走行の行（rehearsal_scenarios）と一致する
import type { SessionCtx } from "@open-team/db";
import { insertWorkspacePolicyIfMissing, listWorkspaceEventsAfter } from "@open-team/db/app";
import { listRehearsalScenarios, listRehearsalRuns } from "@open-team/db/rehearsal";
import { useTestDb } from "@open-team/db/testing";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { ScriptedLlmClient, type ScriptedReply } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import { BIG_ORDER, T0, orderScript, startRehearsalWorld, withOrderRule, type RehearsalWorld } from "./__fixtures__/world.ts";
import { runRehearsal } from "./orchestrate.ts";
import { REHEARSAL_PHASE_EVENT } from "./progress.ts";
import { reportFromScenarioRows } from "./report.ts";
import { applyTighteningAndRetest } from "./tighten-apply.ts";
import { draft, f05, jsonReply, textReply } from "./test-helpers.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

function llmOf(generator: ScriptedReply[]): ScriptedLlmClient {
  const agent = orderScript(BIG_ORDER);
  let g = 0;
  return new ScriptedLlmClient((req, i) => {
    if (req.responseJsonSchema !== undefined) {
      const r = generator[g++];
      if (r === undefined) throw new Error("状況を作る台本が尽きた");
      return r;
    }
    return agent(req, i);
  });
}

async function setup() {
  const { db, url } = T();
  const w = (world = await startRehearsalWorld(db, url, { agentDefinition: (h) => withOrderRule(h) }));
  const s = { ...w.ws.ctx, role: "owner" } as unknown as SessionCtx;
  const policy = defaultWorkspacePolicy(w.ws.kind);
  await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, w.ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
  return { w, db, s };
}

const FIRST = jsonReply({ scenarios: [draft("豆の値上がり", f05({ sku: "BEAN-HOUSE", multiplier: 3 })), draft("牛乳の値上がり", f05({ sku: "MILK-1L", multiplier: 3 }))] });
const NEXT = jsonReply({ scenarios: [draft("カップの値上がり", f05({ sku: "CUP-M", multiplier: 4 }))] });

describe("runRehearsal", () => {
  it("開始 → 生成 → 実行（影つき）→ 適応 → 締める提案。途中経過を事象で流し、報告の数字は走行の行と一致する。続けて [適用] → 同じシードの再試験", async () => {
    const { w, db, s } = await setup();
    const llm = llmOf([FIRST, NEXT]);
    const out = await runRehearsal(w.deps(llm), s, { subject: { jobId: w.agent.jobId }, seed: 4242, count: 2, adapt: { maxRounds: 1, count: 1 } });

    // 生成・初回の走行（影つき）・適応（影なし）
    expect(out.generation).toMatchObject({ generated: 2, saved: 2 });
    expect(out.initial.run).toMatchObject({ trigger: "initial", seed: 4242, adapt_round: 0, status: "done" });
    expect(out.initial.results).toHaveLength(2);
    expect(out.initial.run.shadow_damage_jpy).toBeGreaterThan(0);
    expect(out.adaptation).toMatchObject({ stopped: "max_rounds" });
    expect(out.adaptation!.rounds).toHaveLength(1);
    expect(out.adaptation!.rounds[0]!.suite.run).toMatchObject({ adapt_round: 1, parent_run_id: out.initial.run.id, shadow_damage_jpy: null });
    expect(out.runIds).toEqual([out.initial.run.id, out.adaptation!.rounds[0]!.suite.run.id]);
    expect(out.results).toHaveLength(3);
    expect(out.stopped).toBeNull();
    expect(out.costMicroUsd).toBeGreaterThan(0);
    expect(out.costMicroUsd).toBeLessThan(1_000_000);

    // 途中経過：段階の事象が順に流れる（状況の結果・走行の事象のあいだに）
    const events = await listWorkspaceEventsAfter(db, w.ws.ctx, 0, 200);
    const phases = events.filter((e) => e.type === REHEARSAL_PHASE_EVENT).map((e) => (e.data as { phase: string }).phase);
    expect(phases).toEqual(["started", "generated", "ran", "adapting", "adapted", "proposed", "finished"]);
    expect(events.filter((e) => e.type === "rehearsal.scenario")).toHaveLength(3);
    expect(events.filter((e) => e.type === "rehearsal.run")).toHaveLength(2);

    // 締める提案：すり抜けた発注を塞ぐガード（通常の3倍＝BEAN-HOUSE 60・MILK-1L 等の最も厳しい値）
    expect(out.suggestions).toHaveLength(1);
    const add = out.suggestions[0]!.proposals.find((p) => p.kind === "add_guard")!;
    expect(add).toBeDefined();
    expect(out.suggestions[0]!.proposals.every((p) => p.classification === "narrow")).toBe(true);

    // 報告の数字は走行の行と一致する
    const rows = (await Promise.all(out.runIds.map((id) => listRehearsalScenarios(db, w.ws.ctx, id)))).flat();
    const fromRows = reportFromScenarioRows(rows);
    expect(out.report.counts).toEqual(fromRows.counts);
    expect(out.report.total).toBe(rows.length);
    expect(out.report.slipped).toBe(rows.filter((r) => r.verdict === "fail").length);
    expect(out.report.stages.find((x) => x.key === "withControl")!.damageJpy).toBe(rows.reduce((n, r) => n + Number(r.damage_jpy), 0));
    expect(out.report.stages.find((x) => x.key === "withoutControl")!.damageJpy).toBe(Number(out.initial.run.shadow_damage_jpy));
    expect(out.report.preventedDamageJpy).toBe(rows.reduce((n, r) => n + Number(r.prevented_damage_jpy ?? 0), 0));
    expect(out.report.slipped).toBe(3);

    // [適用]：全試験（初回2件＋適応1件）を同じシードで再試験する。すべて止まり、報告に「締めたあと 0件」が出る
    const applied = await applyTighteningAndRetest(w.deps(new ScriptedLlmClient(orderScript(BIG_ORDER))), s, {
      runId: out.initial.run.id,
      baselineRunIds: out.runIds,
      proposal: add,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.retest.run).toMatchObject({ trigger: "retest", seed: 4242, parent_run_id: out.initial.run.id, status: "done" });
    expect(applied.retest.results).toHaveLength(3);
    expect(applied.retest.results.every((r) => r.verdict === "pass" && r.outcome === "stopped" && r.stoppedBy.by === "kernel")).toBe(true);
    expect(applied.report.headline).toBe("3件中0件は統制が止めた、3件がすり抜けた → 締める変更で0件");
    expect(applied.report.counts.afterTighten).toEqual({ slipped: 0, damageJpy: 0 });
    expect(applied.tightening.keepsCertificate).toBe(true);
    const retestRows = await listRehearsalScenarios(db, w.ws.ctx, applied.retest.run.id);
    expect(retestRows.map((r) => r.verdict)).toEqual(["pass", "pass", "pass"]);
    expect(applied.retest.run.shadow_damage_jpy).toBeNull();
  }, 400_000);

  it("適応しない設定・生成が全滅（走行の前なので例外）・費用が生成で尽きる（走らせず理由を返す）", async () => {
    const { w, db, s } = await setup();
    // adapt: false：初回だけ。適応の呼び出しはない
    const llm = llmOf([FIRST]);
    const noAdapt = await runRehearsal(w.deps(llm), s, { subject: { jobId: w.agent.jobId }, seed: 1, count: 2, adapt: false });
    expect(noAdapt.adaptation).toBeNull();
    expect(noAdapt.runIds).toHaveLength(1);
    expect(llm.requests.filter((r) => r.responseJsonSchema !== undefined)).toHaveLength(1);
    expect(noAdapt.suggestions.length).toBeGreaterThan(0);
  }, 300_000);

  it("初回の生成が全滅したら、走行を作らずに例外。生成で費用の上限に届いたら、状況は走らせず理由（budget）を返す。Kill Switch 中は始めない", async () => {
    const { w, db, s } = await setup();
    await expect(runRehearsal(w.deps(llmOf([textReply("だめ"), textReply("だめ")])), s, { subject: { jobId: w.agent.jobId }, seed: 2 })).rejects.toMatchObject({ code: "no_valid_scenarios" });
    expect(await listRehearsalRuns(db, w.ws.ctx, { subject: { jobId: w.agent.jobId }, limit: 10 })).toHaveLength(0);

    const tiny = await runRehearsal(w.deps(llmOf([FIRST])), s, { subject: { jobId: w.agent.jobId }, seed: 3, count: 2, budgetLimitMicroUsd: 1 });
    expect(tiny.initial.run.status).toBe("failed");
    expect(tiny.initial.results).toHaveLength(0);
    expect(tiny.initial.notRun).toBe(2);
    expect(tiny.adaptation).toBeNull();
    expect(tiny.stopped).toMatchObject({ reason: "budget" });
    expect(tiny.suggestions).toEqual([]);

    await db.query("UPDATE workspaces SET kill_switch_engaged = true WHERE id = $1", [w.ws.workspaceId]);
    await expect(runRehearsal(w.deps(llmOf([FIRST])), s, { subject: { jobId: w.agent.jobId }, seed: 4 })).rejects.toMatchObject({ code: "KILL_SWITCH_ENGAGED" });
  }, 300_000);
});
