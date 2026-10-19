// ゲストのリハーサルの結果の事前計算（fixture.json の作り方と、今のコードと食い違っていないことの確かめ）。
// 本物に近い世界（Postgres・sim-world・gateway・edge・runner。LLM だけ台本）で、用意した依頼（受信箱係 → 仕入れ係）を12件の状況で走らせ
// （統制なしの影の走行つき。損害は sim-core の式、合否はオラクル、止めた者は Kernel の判定の記録から決まる）、
// rehearsal_cases / rehearsal_runs / rehearsal_scenarios と、すり抜けた状況のタスク・Intent・判定の記録を fixture.json に書き出す。
// - UPDATE_GUEST_REHEARSAL_FIXTURE=1 で fixture.json を書き換える（kernel・sim-core・オラクル・状況・台本を変えたらこれで作り直す）
// - そうでなければ、今のコードで計算し直した結果が fixture.json と一致することを確かめる（手で書いた数字を持たない）
// ID は出てきた順の連番に直し、時刻は "@t"（入れるときに決める）にして、毎回同じ中身になるようにする
import { readFileSync, writeFileSync } from "node:fs";
import { useTestDb } from "@open-team/db/testing";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { defaultWorkspacePolicy, hashCanonical, type JsonObject } from "@open-team/kernel";
import { ScriptedLlmClient } from "@open-team/llm";
import { SHOP_DEMO_FORMATION, type Scenario } from "@open-team/sim-core";
import { afterEach, describe, expect, it } from "vitest";
import { T0, addCase, mcp, report, scenarioOf, seedChainAsk, startRehearsalWorld, type RehearsalWorld } from "../rehearsal/__fixtures__/world.ts";
import { runRehearsalSuite } from "../rehearsal/suite.ts";
import { CANDIDATE_RULE, PLANNED_CASES } from "./scenarios.ts";
import type { GuestRehearsalFixture, FixtureRow } from "./fixture.ts";
import { GUEST_REHEARSAL_FIXTURE_VERSION, RUN_SEED, decisionInputsHashOfRow, intentHashOfRow } from "./fixture.ts";

const FIXTURE_PATH = new URL("./fixture.json", import.meta.url);

const T = useTestDb();
let world: RehearsalWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const TS_RE = /^\d{4}-\d\d-\d\dT[\d:.]+\+00:00$/;

async function build(): Promise<GuestRehearsalFixture> {
  const { db, url } = T();
  const buyerDef = SHOP_DEMO_FORMATION.members[1]!.agent;
  const w = (world = await startRehearsalWorld(db, url, {
    agentDefinition: (h) =>
      ({
        ...structuredClone(buyerDef),
        rules: [{ id: "r-0001", ...structuredClone(CANDIDATE_RULE), tool_hash: h.placeOrderHash, added_by: "owner", added_at: T0.toISOString() }],
      }) as never,
  }));
  const policy = defaultWorkspacePolicy(w.ws.kind);
  await db.transaction((tx) => insertWorkspacePolicyIfMissing(tx, w.ws.ctx, { policy: policy as unknown as JsonObject, policyHash: hashCanonical(policy), createdBy: null, now: T0 }));
  const { askId, inbox } = await seedChainAsk(w);

  // 素直なエージェントの台本：受信箱係はメールを読んで報告、仕入れ係は在庫を読む → 状況ごとの手順 → 報告（どの走行でも同じ）
  let current = 0;
  const USAGE = { inputTokens: 1000, outputTokens: 100, thinkingTokens: 0 } as const;
  const llm = new ScriptedLlmClient((req) => {
    const n = req.messages.filter((m) => m.role === "tool").length;
    if (req.mcpTools.some((t) => t.tool === "list_inbox")) {
      return { parts: [n === 0 ? mcp("c-mail", "mail", "list_inbox", {}) : report("c-r1", "受信箱を読みました。")], usage: USAGE };
    }
    const plan = PLANNED_CASES[current]!.buyer;
    if (n === 0) return { parts: [mcp("c-inv", "store", "get_inventory")], usage: USAGE };
    const step = plan[n - 1];
    if (step) return { parts: [mcp(`c-${n}`, step.connector, step.tool, step.args)], usage: USAGE };
    return { parts: [report("c-report")], usage: USAGE };
  });
  const cases = [];
  for (const [i, p] of PLANNED_CASES.entries()) cases.push(await addCase(w, scenarioOf(p.title, p.faults as never, { seed: 9000 + i }), "generated", { askId }));
  // 時計は呼ばれるたびに1秒進める（手で止めた時計だと、同じ時刻の Intent の並びが DB の返し方で変わり、「最初に止めた者」が揺れる）
  let ticks = 0;
  const clock = { now: () => new Date(T0.getTime() + ticks++ * 1000) };
  const out = await runRehearsalSuite(w.deps(llm, { clock }), {
    ctx: w.ws.ctx,
    requesterId: w.ws.userId,
    subject: { askId },
    trigger: "seed",
    seed: RUN_SEED,
    modelId: "gemini-test",
    cases,
    // 影の走行は全件（最初の生成の状況）。ここで状況ごとの台本を切り替える（試験は順に1件ずつ走る）
    shadowFor: (c) => {
      current = PLANNED_CASES.findIndex((p) => p.title === (c.scenario as unknown as Scenario).title);
      return true;
    },
  });
  expect(out.run.status).toBe("done");
  expect(out.results).toHaveLength(PLANNED_CASES.length);

  // ---- 取り出す ----
  const wsId = w.ws.workspaceId;
  const generated = new Set(
    (await db.query<{ column_name: string; table_name: string }>("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND is_generated = 'ALWAYS'", [])).rows.map(
      (r) => `${r.table_name}.${r.column_name}`,
    ),
  );
  const rows = async (table: string, where: string, params: unknown[], order: string): Promise<FixtureRow[]> =>
    (await db.query<{ j: FixtureRow }>(`SELECT to_jsonb(t) AS j FROM ${table} t WHERE workspace_id = $1 ${where} ORDER BY ${order}`, [wsId, ...params])).rows.map((r) => {
      const o: FixtureRow = { ...r.j };
      delete o.workspace_id;
      for (const [k, v] of Object.entries(o)) {
        if (generated.has(`${table}.${k}`)) delete o[k];
        else if (typeof v === "string" && TS_RE.test(v)) o[k] = "@t";
      }
      return o;
    });
  const caseRows = await rows("rehearsal_cases", "", [], "created_at, (scenario->>'seed')::bigint");
  const runRow = (await rows("rehearsal_runs", "", [], "created_at"))[0]!;
  const scenarioRows = await rows("rehearsal_scenarios", "", [], "ordinal");
  const slipped = scenarioRows.filter((s) => s.verdict === "fail");
  const slipIds = slipped.map((s) => s.id as string);
  const ordinalOf = new Map(scenarioRows.map((s) => [s.id as string, s.ordinal as number]));
  const members = (await db.query<{ id: string; position: number }>("SELECT id, position FROM ask_members WHERE workspace_id = $1 AND ask_id = $2", [wsId, askId])).rows;
  const positionOf = new Map(members.map((m) => [m.id, m.position]));
  const taskRows = (await rows("tasks", "AND rehearsal_scenario_id = ANY($2::uuid[]) AND execution_variant = 'governed'", [slipIds], "created_at, id")).sort(
    (a, b) =>
      (ordinalOf.get(a.rehearsal_scenario_id as string) ?? 0) - (ordinalOf.get(b.rehearsal_scenario_id as string) ?? 0) ||
      (positionOf.get(a.ask_member_id as string) ?? 0) - (positionOf.get(b.ask_member_id as string) ?? 0),
  );
  const taskIndex = new Map(taskRows.map((t, i) => [t.id as string, i]));
  const byTask = (a: FixtureRow, b: FixtureRow): number => (taskIndex.get(a.task_id as string) ?? 0) - (taskIndex.get(b.task_id as string) ?? 0);
  // すり抜けた書き込み（オラクルが失敗の原因とした Intent）とその判定の記録だけを残す（締める提案の材料：listSlippedWriteSources）
  const blamed = [
    ...new Set(
      slipped.flatMap((s) => ((s.oracle_results as { governed: Array<{ failures: Array<{ writes: Array<{ intentId: string | null }> }> }> }).governed ?? []).flatMap((v) => v.failures.flatMap((f) => f.writes.flatMap((x) => (x.intentId ? [x.intentId] : []))))),
    ),
  ];
  const intentRows = (await rows("action_intents", "AND id = ANY($2::uuid[])", [blamed], "created_at, id")).sort(
    (a, b) => byTask(a, b) || JSON.stringify(a.payload).localeCompare(JSON.stringify(b.payload)),
  );
  const decisionRows = await rows("policy_decisions", "AND intent_id = ANY($2::uuid[]) AND subject_kind = 'tool_call'", [blamed], "created_at, id");
  // 判定の入力の数え物（費用・経過秒・回数は走らせるたびに揺れる）は固定の値にし、指紋は固定したあとの中身から作り直す
  for (const d of decisionRows) {
    d.counters = { costUsd: 0, repeatKey: "", stepsUsed: 0, dayCostUsd: 0, elapsedSec: 0, deniedCount: 0, repeatCount: 0, intentsCount: 0, agentDayCostUsd: 0, unknownOutcomeKeys: [] };
  }

  // 外の行（入れ先のワークスペースで本物に置き換える ID）
  const connectors = (await db.query<{ id: string; slug: string }>("SELECT id, slug FROM connectors WHERE workspace_id = $1", [wsId])).rows;
  const toolHashes = (await db.query<{ name: string; tool_hash: string }>("SELECT name, tool_hash FROM connector_tools WHERE workspace_id = $1 AND name IN ('place_order', 'register_payee')", [wsId])).rows;
  const snapshotOf = async (agentId: string) => (await db.query<{ current_snapshot_id: string }>("SELECT current_snapshot_id FROM agents WHERE workspace_id = $1 AND id = $2", [wsId, agentId])).rows[0]!.current_snapshot_id;
  const refs: GuestRehearsalFixture["refs"] = {
    workspace: wsId,
    user: w.ws.userId,
    ask: askId,
    inbox: { agent: inbox.agentId, job: inbox.jobId, snapshot: await snapshotOf(inbox.agentId), member: members.find((m) => m.position === 1)!.id },
    buyer: { agent: w.agent.agentId, job: w.agent.jobId, snapshot: await snapshotOf(w.agent.agentId), member: members.find((m) => m.position === 2)!.id },
    connectors: Object.fromEntries(connectors.map((c) => [c.slug, c.id])),
    toolHashes: Object.fromEntries(toolHashes.map((t) => [t.name, t.tool_hash])),
  };

  // 入れるときに決める値
  for (const c of caseRows) {
    c.created_at = "@runStart";
    c.created_by = "@user";
  }
  Object.assign(runRow, { is_seed: true, model_id: "@agentModel", requested_by: "@user", cost_usd: 0, candidate_rules: [CANDIDATE_RULE], tool_hashes: "@toolHashes", created_at: "@runStart", started_at: "@runStart", finished_at: "@runEnd" });
  for (const s of scenarioRows) Object.assign(s, { cost_usd: 0, governed_execution_id: null, approve_execution_id: null, shadow_execution_id: null });
  for (const t of taskRows) Object.assign(t, { cost_usd: 0, sim_execution_id: null, requester_id: "@user" });

  const raw: GuestRehearsalFixture = {
    version: GUEST_REHEARSAL_FIXTURE_VERSION,
    refs,
    run: runRow,
    cases: caseRows,
    scenarios: scenarioRows,
    slippedScenarioIds: slipIds,
    tasks: taskRows,
    intents: intentRows,
    decisions: decisionRows,
  };
  // ID を出てきた順の連番にする（refs が先）
  const text = JSON.stringify(raw);
  const seen = new Map<string, string>();
  const numbered = text.replace(UUID_RE, (u) => {
    const known = seen.get(u);
    if (known !== undefined) return known;
    const next = `00000000-0000-4000-8000-${seen.size.toString(16).padStart(12, "0")}`;
    seen.set(u, next);
    return next;
  });
  const fixture = JSON.parse(numbered) as GuestRehearsalFixture;
  // ID を連番にしたので、ID を材料にする指紋を作り直す（入れるときも同じ関数で作り直す）
  for (const i of fixture.intents) i.intent_hash = intentHashOfRow(i);
  for (const d of fixture.decisions) d.inputs_hash = decisionInputsHashOfRow(d);
  return fixture;
}

/** 配列は1要素1行にして、作り直したときの差分が読めるようにする */
function format(f: GuestRehearsalFixture): string {
  const lines = Object.entries(f).map(([k, v]) => (Array.isArray(v) ? `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]` : `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`));
  return `{\n${lines.join(",\n")}\n}\n`;
}

describe("ゲストのリハーサルの事前計算", () => {
  it("今のコードで計算し直した結果が fixture.json と一致する（UPDATE_GUEST_REHEARSAL_FIXTURE=1 で作り直す）", async () => {
    const built = await build();
    if (process.env.UPDATE_GUEST_REHEARSAL_FIXTURE === "1") {
      writeFileSync(FIXTURE_PATH, format(built));
      return;
    }
    const committed = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GuestRehearsalFixture;
    expect(built).toEqual(committed);
  }, 300_000);
});
