// 用意した依頼の再試験の再現（D-101）：台本で走り、全件合格 → 担当（受信箱係・仕入れ係）ごとに合格証が出る。Gemini は呼ばない
// 本物に近い世界（Postgres・sim-world・gateway・edge・runner）で、LLM だけ台本
import type { SessionCtx } from "@open-team/db";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { getRehearsalRun } from "@open-team/db/rehearsal";
import { useTestDb } from "@open-team/db/testing";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { ScriptedLlmClient } from "@open-team/llm";
import { afterEach, describe, expect, it } from "vitest";
import { SHOP_DEMO_FORMATION } from "@open-team/sim-core";
import { T0, addCase, scenarioOf, seedChainAsk, startRehearsalWorld, type RehearsalWorld } from "../rehearsal/__fixtures__/world.ts";
import { proposalsOfRun } from "../rehearsal/proposals.ts";
import { startRetest } from "../rehearsal/retest.ts";
import { applyTightening } from "../rehearsal/apply.ts";
import { preparedAgentBudgetFor } from "../owner-setup.ts";
import { runRehearsalSuite } from "../rehearsal/suite.ts";
import { createGuestReplay, orderAsPlanned } from "./replay.ts";
import { CANDIDATE_RULE, PLANNED_CASES } from "./scenarios.ts";

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

describe("orderAsPlanned", () => {
  const caseOf = (title: string) => ({ scenario: { title } as never });
  it("題が用意した12件とちょうど一致するときだけ、台本の並びにして返す", () => {
    const shuffled = [...PLANNED_CASES].reverse().map((p) => caseOf(p.title));
    expect(orderAsPlanned(shuffled)?.map((c) => (c.scenario as unknown as { title: string }).title)).toEqual(PLANNED_CASES.map((p) => p.title));
    expect(orderAsPlanned(shuffled.slice(1))).toBeNull();
    expect(orderAsPlanned([...shuffled.slice(1), caseOf("自分の悪い日")])).toBeNull();
    expect(orderAsPlanned([...shuffled.slice(1), shuffled[1]!])).toBeNull();
  });
});

describe("用意した依頼の再試験", () => {
  it("12件を台本で再現して全件合格し、担当ごとに合格証が出る。台本の LLM を渡さなくても（deps.llm が空でも）台本で走る", async () => {
    const { db, url } = T();
    // ゲストの仕入れ係と同じ定義（候補のルールが入っている：owner-setup.ts の candidateRuleFor。1日はゲストの $4：preparedAgentBudgetFor・D-107）
    const buyerDef = preparedAgentBudgetFor("guest", SHOP_DEMO_FORMATION.members[1]!.agent, defaultWorkspacePolicy("guest").budget.per_day_usd);
    const w = (world = await startRehearsalWorld(db, url, {
      workspaceKind: "guest",
      agentDefinition: (h) => ({ ...structuredClone(buyerDef), rules: [{ id: "r-0001", ...structuredClone(CANDIDATE_RULE), tool_hash: h.placeOrderHash, added_by: "seed", added_at: T0.toISOString() }] }) as never,
    }));
    const policy = defaultWorkspacePolicy(w.ws.kind);
    await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, w.ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
    const { askId, inbox } = await seedChainAsk(w);
    for (const [i, p] of PLANNED_CASES.entries()) await addCase(w, scenarioOf(p.title, p.faults as never, { seed: 9000 + i }), "generated", { askId });
    const cases = (await db.query<{ id: string }>("SELECT id FROM rehearsal_cases WHERE ask_id = $1", [askId])).rows.length;
    expect(cases).toBe(12);

    // 親の走行（最初の生成）。台本で走らせて、再試験の親にする
    const replay = createGuestReplay();
    const allCases = (await import("@open-team/db/rehearsal")).listActiveRehearsalCases;
    const first = await runRehearsalSuite(w.deps(replay.llm as ScriptedLlmClient), {
      ctx: w.ws.ctx,
      requesterId: w.ws.userId,
      subject: { askId },
      trigger: "initial",
      seed: 20261003,
      modelId: "gemini-test",
      cases: orderAsPlanned(await allCases(db, w.ws.ctx, { askId }))!,
      shadowFor: (c) => (replay.select(c), true),
    });
    expect(first.run.status).toBe("done");

    // 再試験：台本の LLM ではなく、何も返さない LLM を渡しても、台本で走る
    const never = new ScriptedLlmClient([]);
    const s = { ...w.ws.ctx, role: "owner" } as unknown as SessionCtx;
    // 台本どおり、2件がすり抜ける（豆の値上がり・店長を名乗る大量発注）。締める提案（数量・単価のガード）を全部適用してから再試験する
    expect(first.counts).toMatchObject({ total: 12, withControl: { slipped: 2 } });
    const proposals = await proposalsOfRun(w.deps(never), s, first.run);
    // 提案はガード2件と、同じ穴を塞ぐ代替（ルールの取り消し）。画面と同じに、塞がれていない穴を塞ぐものだけを上から選ぶ
    const covered = new Set<string>();
    const picked = proposals.filter((p) => p.fixes.some((f) => !covered.has(f)) && (p.fixes.forEach((f) => covered.add(f)), true));
    expect(picked.map((p) => p.label)).toEqual([expect.stringContaining("「1回の発注の数量」"), expect.stringContaining("「単価」")]);
    // ルールの取り消しの案は、内部の ID（r-0001）ではなくルールの中身で言う（D-108）
    const removeRule = proposals.find((p) => p.label.includes("取り消し"));
    expect(removeRule?.label).toBe("「山田珈琲への発注は以後も許可」のルールを取り消し、同じ書き込みを確認に回します");
    for (const p of proposals) expect(p.label).not.toMatch(/r-\d/);
    let lastChangeId = "";
    for (const p of picked) lastChangeId = (await applyTightening(w.deps(never), s, { runId: first.run.id, patch: p.patch as never, jobId: p.jobId })).change.id;
    const retest = await startRetest(w.deps(never), s, { parentRunId: first.run.id, configChangeId: lastChangeId });
    expect(retest).toMatchObject({ trigger: "retest", parent_run_id: first.run.id, seed: 20261003 });
    let done = retest;
    for (let i = 0; i < 600 && done.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = (await getRehearsalRun(db, w.ws.ctx, retest.id))!;
    }
    const scenarios = await db.query<{ ordinal: number; verdict: string }>("SELECT ordinal, verdict FROM rehearsal_scenarios WHERE rehearsal_run_id = $1 ORDER BY ordinal", [retest.id]);
    expect(scenarios.rows.map((r) => `${r.ordinal}:${r.verdict}`)).toEqual(scenarios.rows.map((r) => `${r.ordinal}:pass`));
    expect(scenarios.rows).toHaveLength(12);
    expect(done.status).toBe("done");
    expect(never.requests).toHaveLength(0);
    // 台本の応答は費用 0（Gemini を呼んでいない）
    expect(Number(done.cost_usd)).toBe(0);

    // 担当ごとに1枚（受信箱係・仕入れ係）。どれも依頼の12件の試験で出す
    // 走行が done になったあとに合格証を出すので、出るまで待つ
    let certs = await db.query<{ job_id: string; ask_id: string; case_count: number }>("SELECT job_id, ask_id, case_count FROM rehearsal_certificates WHERE revoked_at IS NULL ORDER BY job_id");
    for (let i = 0; i < 100 && certs.rows.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 100));
      certs = await db.query<{ job_id: string; ask_id: string; case_count: number }>("SELECT job_id, ask_id, case_count FROM rehearsal_certificates WHERE revoked_at IS NULL ORDER BY job_id");
    }
    expect(certs.rows.map((c) => c.job_id).sort()).toEqual([inbox.jobId, w.agent.jobId].sort());
    expect(certs.rows.every((c) => c.ask_id === askId && c.case_count === 12)).toBe(true);
    expect((await getRehearsalRun(db, w.ws.ctx, retest.id))!.certificate_id).not.toBeNull();
  }, 180_000);
});
