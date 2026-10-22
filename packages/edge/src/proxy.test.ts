// LLM Proxy（llmMessages）の試験：入力の検証・回数・予算（decide と checkSpend）・LLM の失敗・費用の加算・
// 応答のツール呼び出しの判定（M-14・M-15・M-12）・Intent（recordMcpIntent）・Breaker・submit_report の後ろ（決定 (e)）
// （formation-runtime.md §3.10・§6.6、kernel-decide.md §3.4、intents-approvals.md §3.5・§3.7、SO §3.12）
import { describe, expect, it } from "vitest";
import {
  INITIAL_AGENT_BOUNDARY,
  computeMcpIntentHash,
  defaultWorkspacePolicy,
  destinationKey,
  optionDigest,
  toMicroUsd,
  type JsonObject,
} from "@open-team/kernel";
import { DEFAULT_AGENT_MODEL, LlmError, type LlmRequest } from "@open-team/llm";
import { EdgeError, type TaskContext } from "@open-team/runner";
import { system, type Db, type Uuid } from "@open-team/db";
import { fxUsage, useTestDb, type FxWorkspace } from "@open-team/db/testing";
import { buildEdge, call, llmRequest, mcp, report, text, USAGE, type TestEdge } from "./__fixtures__/env.ts";
import {
  T0,
  fxWorkspace,
  inboxDefinition,
  seedAgent,
  seedChainAsk,
  seedConnectors,
  seedTask,
  supplierDefinition,
  tokenFor,
  type SeededAgent,
  type SeededConnector,
  type SeedTaskOptions,
} from "./__fixtures__/seed.ts";
import { estimateCallMicroUsd } from "./gemini.ts";
import { EDGE_LIMITS, SPEND_LIMITS } from "./limits.ts";

const T = useTestDb();

interface World {
  db: Db;
  ws: FxWorkspace;
  conns: Record<string, SeededConnector>;
  agent: SeededAgent;
  jobSlug: string;
  taskId: Uuid;
  token: string;
  ctx: TaskContext;
  env: TestEdge;
}

/** 仕入れ係（既定）か受信箱係のタスクを running にして返す */
async function world(
  db: Db,
  o: {
    kind?: "guest" | "owner";
    def?: "supplier" | "inbox";
    defOverride?: Parameters<typeof supplierDefinition>;
    task?: SeedTaskOptions;
    env?: Parameters<typeof buildEdge>[1];
  } = {},
): Promise<World> {
  const ws = await fxWorkspace(db, { kind: o.kind ?? "guest", audit: true });
  const conns = await seedConnectors(db, ws);
  const def = o.def === "inbox" ? inboxDefinition() : supplierDefinition(...(o.defOverride ?? []));
  const agent = await seedAgent(db, ws, def);
  const jobSlug = o.def === "inbox" ? "read-supplier-mail" : "reorder";
  const taskId = await seedTask(db, ws, agent, jobSlug, { ...o.task });
  const token = await tokenFor(db, ws, taskId);
  const env = buildEdge(db, o.env);
  const ctx = await env.edge.getTaskContext(token);
  return { db, ws, conns, agent, jobSlug, taskId, token, ctx, env };
}

async function expectEdgeError(p: Promise<unknown>, code: string): Promise<EdgeError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e, `EdgeError(${code}) のはず`).toBeInstanceOf(EdgeError);
  expect((e as EdgeError).code).toBe(code);
  return e as EdgeError;
}

async function taskRow(db: Db, taskId: Uuid) {
  return (
    await db.query<{
      status: string;
      halt_reason: string | null;
      fail_reason: string | null;
      cost_usd: string;
      steps_used: number;
      denied_count: number;
      repeat_count: number;
      task_token_hash: Buffer | null;
    }>("SELECT status, halt_reason, fail_reason, cost_usd::text AS cost_usd, steps_used, denied_count, repeat_count, task_token_hash FROM tasks WHERE id = $1", [taskId])
  ).rows[0]!;
}

async function auditEvents(db: Db, ws: FxWorkspace, type: string) {
  return (await db.query<{ payload: JsonObject }>("SELECT payload FROM audit_logs WHERE workspace_id = $1 AND event_type = $2 ORDER BY seq", [ws.workspaceId, type])).rows.map(
    (r) => r.payload,
  );
}

const ORDER = { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 20, unit_price: 1800 }] };

/** ツールを渡さない要求（見積もりを試験で計算しやすくする） */
function bareRequest(maxTokens: number): LlmRequest {
  return { model: DEFAULT_AGENT_MODEL, system: "s", messages: [{ role: "user", content: "u" }], tools: [], mcpTools: [], maxTokens };
}

describe("入力の検証（§3.10-2）・回数（§3.10-3）", () => {
  it("HL-23 phase = design は 400／HL-22 system＋messages が 1MB を超えると 400／maxTokens 0・16,001 は 400", async () => {
    const { db } = T();
    const w = await world(db);
    const base = llmRequest(w.ctx.tools);
    await expectEdgeError(w.env.edge.llmMessages(w.token, { ...base, phase: "design" as never }), "VALIDATION_ERROR");
    await expectEdgeError(w.env.edge.llmMessages(w.token, { ...base, system: "あ".repeat(400_000) }), "VALIDATION_ERROR");
    await expectEdgeError(w.env.edge.llmMessages(w.token, { ...base, maxTokens: 0 }), "VALIDATION_ERROR");
    await expectEdgeError(w.env.edge.llmMessages(w.token, { ...base, maxTokens: 16_001 }), "VALIDATION_ERROR");
    expect(w.env.llm.requests).toHaveLength(0);
  });

  it("tools ⊆ TaskContext.tools：文脈にないツール（web_search・remember）を渡すと 400。ツールの宣言は edge が作ったものを LLM に渡す", async () => {
    const { db } = T();
    const w = await world(db, { env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([{ name: "web_search" }])), "VALIDATION_ERROR");
    expect(e.details).toMatchObject({ reason: "tool_not_in_context", tools: ["web_search"] });
    // 宣言の中身を書き換えて渡しても、LLM に渡るのは edge の宣言
    const req = llmRequest(w.ctx.tools);
    req.tools = req.tools.map((t) => ({ ...t, description: "書き換えた説明" }));
    await w.env.edge.llmMessages(w.token, req);
    const sent = w.env.llm.requests[0]!;
    expect(sent.tools.map((t) => t.name)).toEqual(["mcp_call", "notify", "submit_report", "finish"]);
    expect(sent.tools.every((t) => t.description !== "書き換えた説明")).toBe(true);
    expect(sent.mcpTools.map((t) => `${t.connector}.${t.tool}`)).toEqual([
      "bank.register_payee",
      "store.get_inventory",
      "supplier.list_products",
      "supplier.place_order",
    ]);
    expect(sent.model).toBe(DEFAULT_AGENT_MODEL);
  });

  it("HL-14 1分に上限を超えた呼び出しは 429 RATE_LIMITED（retryAfterSec つき）。60秒たてばまた呼べる", async () => {
    const { db } = T();
    const w = await world(db, { env: { script: () => ({ parts: [text("ok")], usage: USAGE }), limits: { llmCallsPerMinute: 3 } } });
    for (let i = 0; i < 3; i++) {
      await w.env.edge.llmMessages(w.token, llmRequest([]));
      w.env.clock.advance(1_000);
    }
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([])), "RATE_LIMITED");
    expect(e.retryAfterSec).toBe(57);
    w.env.clock.advance(57_000);
    await w.env.edge.llmMessages(w.token, llmRequest([]));
    expect(w.env.llm.requests).toHaveLength(4);
  });
});

describe("費用の加算（§3.10-8、FR-013）", () => {
  it("usage_records（task・agent・phase・トークン・実費）、tasks.cost_usd・steps_used、task_events・監査ログ llm.called。応答の budget は足したあとの値", async () => {
    const { db } = T();
    const w = await world(db, { env: { script: [{ parts: [text("在庫を見ます")], usage: USAGE }] } });
    const res = await w.env.edge.llmMessages(w.token, llmRequest([], { phase: "implement" }));
    // gemini-3.8-flash：入力 $1.5/100万・出力 $7.5/100万 → 1000×1.5 + 100×7.5 = 2250 マイクロドル
    expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 100, costUsd: "0.002250" });
    expect(res.budget).toEqual({ costUsd: "0.002250", stepsUsed: 1 });
    expect(res.governance).toEqual([]);
    const usage = (await db.query<Record<string, unknown>>("SELECT * FROM usage_records WHERE workspace_id = $1", [w.ws.workspaceId])).rows;
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ task_id: w.taskId, agent_id: w.agent.agentId, phase: "implement", input_tokens: 1000, output_tokens: 100, cost_usd: "0.002250", model: DEFAULT_AGENT_MODEL });
    const row = await taskRow(db, w.taskId);
    expect(row).toMatchObject({ cost_usd: "0.002250", steps_used: 1, status: "running" });
    const audit = await auditEvents(db, w.ws, "llm.called");
    expect(audit).toEqual([expect.objectContaining({ taskId: w.taskId, model: DEFAULT_AGENT_MODEL, costUsd: "0.002250", ignoredToolCalls: 0 })]);
    expect(audit[0]).toHaveProperty("promptHash");
    const decisions = (await db.query<{ subject_kind: string; decision: string; reason_code: string }>("SELECT subject_kind, decision, reason_code FROM policy_decisions WHERE task_id = $1", [w.taskId])).rows;
    expect(decisions).toEqual([{ subject_kind: "llm_call", decision: "allow", reason_code: "not_gated" }]);
  });
});

describe("予算（decide の手順2：llm_call。超える（>）で止める）", () => {
  it("HL-10・HL-11 per_task_usd 0.2：0.15＋見積もり（約0.048）は呼ぶ、0.16＋見積もりは呼ばずに halted(budget_exceeded)・409・トークン失効・監査ログ budget.exceeded", async () => {
    const { db } = T();
    const est = estimateCallMicroUsd(bareRequest(3200));
    expect(est).toBeGreaterThan(40_000);
    expect(est).toBeLessThan(50_000);
    const ok = await world(db, { task: { status: "running", costUsd: "0.150000" }, env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    await ok.env.edge.llmMessages(ok.token, llmRequest([], { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 3200 }));
    expect(ok.env.llm.requests).toHaveLength(1);

    const ng = await world(db, { task: { status: "running", costUsd: "0.160000" }, env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    const e = await expectEdgeError(ng.env.edge.llmMessages(ng.token, llmRequest([], { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 3200 })), "TASK_HALTED");
    expect(e.details).toMatchObject({ haltReason: "budget_exceeded", reasonCode: "budget_exceeded", matchedRule: "budget.per_task_usd" });
    expect(ng.env.llm.requests).toHaveLength(0);
    const row = await taskRow(db, ng.taskId);
    expect(row).toMatchObject({ status: "halted", halt_reason: "budget_exceeded", task_token_hash: null });
    expect(await auditEvents(db, ng.ws, "budget.exceeded")).toEqual([
      expect.objectContaining({ taskId: ng.taskId, item: "per_task_usd", limitUsd: "0.200000", usedUsd: "0.160000" }),
    ]);
    expect(ng.env.hooks).toEqual([{ hook: "onTaskTerminal", taskId: ng.taskId, status: "halted" }]);
    // 止めたあとはトークンが失効（401）
    await expectEdgeError(ng.env.edge.llmMessages(ng.token, llmRequest([])), "UNAUTHORIZED");
  });

  it("境界：使った額＋見積もり＝上限ちょうどは呼ぶ、1マイクロドルでも超えれば止める", async () => {
    const { db } = T();
    const req = { system: "s", messages: [{ role: "user" as const, content: "u" }], maxTokens: 1000 };
    const est = estimateCallMicroUsd(bareRequest(1000));
    const exact = system.microToUsd(toMicroUsd(0.2) - est);
    const over = system.microToUsd(toMicroUsd(0.2) - est + 1);
    const a = await world(db, { task: { status: "running", costUsd: exact }, env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    await a.env.edge.llmMessages(a.token, llmRequest([], req));
    const b = await world(db, { task: { status: "running", costUsd: over }, env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    await expectEdgeError(b.env.edge.llmMessages(b.token, llmRequest([], req)), "TASK_HALTED");
  });

  it("D-106：1ステップの maxTokens の既定は 4,096。見積もり（思考の上限＝maxTokens のまま：BR-10）は1回 $0.07 未満になり、per_task_usd 0.2 で実費 $0.12 まで呼べる（8,000 のときは止まっていた）", async () => {
    const { db } = T();
    expect(EDGE_LIMITS.maxTokensDefault).toBe(4096);
    const est = estimateCallMicroUsd(bareRequest(EDGE_LIMITS.maxTokensDefault));
    expect(est).toBeGreaterThanOrEqual(4096 * 2 * 7.5); // 出力の上限＋思考の上限（どちらも maxTokens）× 出力単価。見積もりは保守的なまま
    expect(est).toBeLessThan(70_000);
    // 8,000 のときの見積もりでは、実費 $0.12 の仕事は次の呼び出しで per_task_usd 0.2 を超えて止まっていた
    expect(toMicroUsd(0.12) + estimateCallMicroUsd(bareRequest(8000))).toBeGreaterThan(toMicroUsd(0.2));
    const req = { system: "s", messages: [{ role: "user" as const, content: "u" }], maxTokens: EDGE_LIMITS.maxTokensDefault };
    const w = await world(db, { task: { status: "running", costUsd: "0.120000" }, env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    await w.env.edge.llmMessages(w.token, llmRequest([], req));
    expect(w.env.llm.requests).toHaveLength(1);
    expect(w.env.llm.requests[0]!.maxTokens).toBe(4096);
  });

  it("HL-12 max_steps 40：stepsUsed 39 は呼ぶ、40 は halt（budget.max_steps）", async () => {
    const { db } = T();
    const a = await world(db, { task: { status: "running", stepsUsed: 39 }, env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    await a.env.edge.llmMessages(a.token, llmRequest([]));
    const b = await world(db, { task: { status: "running", stepsUsed: 40 } });
    const e = await expectEdgeError(b.env.edge.llmMessages(b.token, llmRequest([])), "TASK_HALTED");
    expect(e.details).toMatchObject({ matchedRule: "budget.max_steps" });
  });

  it("max_minutes（15分）を過ぎた llm_call は halted(timeout)（FR §8-31）", async () => {
    const { db } = T();
    const w = await world(db, { task: { status: "running", startedAt: new Date(T0.getTime() - 15 * 60_000 - 1_000) } });
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([])), "TASK_HALTED");
    expect(e.details).toMatchObject({ haltReason: "timeout", matchedRule: "budget.max_minutes" });
    expect((await taskRow(db, w.taskId)).halt_reason).toBe("timeout");
  });

  it("agent_day_usd（エージェントの1日 $1）：同じエージェントの別のタスクの今日の費用も数える（G-01）", async () => {
    const { db } = T();
    const w = await world(db, { kind: "owner", env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    const other = await seedTask(db, w.ws, w.agent, w.jobSlug, { status: "running" });
    await fxUsage(db, w.ws, { taskId: other, costUsd: "0.999000", createdAt: T0 });
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([])), "TASK_HALTED");
    expect(e.details).toMatchObject({ matchedRule: "budget.agent_day_usd" });
  });
});

describe("全体 $15・ゲスト $4（checkSpend：decide の外。M-19・D-106）", () => {
  it("D-106：上限は全体 $15・ゲスト1日 $4。ゲスト1日は Kernel のゲストのワークスペース・担当の1日（per_day_usd）と同じ値", () => {
    expect(SPEND_LIMITS).toEqual({ platformDayMicroUsd: 15_000_000, guestDayMicroUsd: 4_000_000 });
    expect(toMicroUsd(defaultWorkspacePolicy("guest").budget.per_day_usd)).toBe(SPEND_LIMITS.guestDayMicroUsd);
    expect(toMicroUsd(INITIAL_AGENT_BOUNDARY.guest_per_day_usd)).toBe(SPEND_LIMITS.guestDayMicroUsd);
  });

  it("BR-62 全体の今日の費用＋見積もり > $15 → 呼ばずに halted(budget_exceeded)、監査ログに scope: global", async () => {
    const { db } = T();
    const w = await world(db, { kind: "owner", env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    const est = estimateCallMicroUsd({ ...bareRequest(1000), system: "s" });
    const otherWs = await fxWorkspace(db, { kind: "guest" });
    const otherAgent = await seedAgent(db, otherWs, inboxDefinition());
    await fxUsage(db, otherWs, { agentId: otherAgent.agentId, costUsd: system.microToUsd(15_000_000 - est + 1), createdAt: T0 });
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([], { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 1000 })), "TASK_HALTED");
    expect(e.details).toMatchObject({ haltReason: "budget_exceeded", scope: "global" });
    expect(w.env.llm.requests).toHaveLength(0);
    expect(await auditEvents(db, w.ws, "budget.exceeded")).toEqual([expect.objectContaining({ scope: "global", limitUsd: "15.000000" })]);
  });

  it("全体：ちょうど $15 に届くのは通す（日付が変われば数えない）", async () => {
    const { db } = T();
    const w = await world(db, { kind: "owner", env: { script: [{ parts: [text("ok")], usage: USAGE }] } });
    const est = estimateCallMicroUsd(bareRequest(1000));
    const otherWs = await fxWorkspace(db, { kind: "guest" });
    const otherAgent = await seedAgent(db, otherWs, inboxDefinition());
    await fxUsage(db, otherWs, { agentId: otherAgent.agentId, costUsd: system.microToUsd(15_000_000 - est), createdAt: T0 });
    // 前の日（Asia/Tokyo の 0時より前）の費用は数えない
    await fxUsage(db, otherWs, { agentId: otherAgent.agentId, costUsd: "5.000000", createdAt: new Date("2026-10-11T14:59:59.000Z") });
    await w.env.edge.llmMessages(w.token, llmRequest([], { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 1000 }));
    expect(w.env.llm.requests).toHaveLength(1);
  });

  it("BR-62 ゲストのワークスペースの今日の費用＋見積もり > $4 → scope: workspace", async () => {
    const { db } = T();
    const w = await world(db, { kind: "guest" });
    const est = estimateCallMicroUsd(bareRequest(1000));
    const otherAgent = await seedAgent(db, w.ws, { ...inboxDefinition(), name: "別の係" });
    await fxUsage(db, w.ws, { agentId: otherAgent.agentId, costUsd: system.microToUsd(SPEND_LIMITS.guestDayMicroUsd - est + 1), createdAt: T0 });
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([], { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 1000 })), "TASK_HALTED");
    expect(e.details).toMatchObject({ scope: "workspace" });
  });

});

describe("Kill Switch・LLM の失敗（§3.10-1・7）", () => {
  it("Kill Switch 発動中は呼ばずに 409 TASK_HALTED（haltReason: kill_switch）", async () => {
    const { db } = T();
    const w = await world(db);
    await db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2 WHERE id = $1", [w.ws.workspaceId, T0]);
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([])), "TASK_HALTED");
    expect(e.details).toMatchObject({ haltReason: "kill_switch" });
    expect(w.env.llm.requests).toHaveLength(0);
  });

  it("呼んでいる間に Kill Switch でタスクが止まった：費用は数え、ツール呼び出しは判定せず 409", async () => {
    const { db } = T();
    let w: World | null = null;
    w = await world(db, {
      env: {
        script: [
          async () => {
            await db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2 WHERE id = $1", [w!.ws.workspaceId, T0]);
            await db.query("UPDATE tasks SET status = 'halted', halt_reason = 'kill_switch', finished_at = $2 WHERE id = $1", [w!.taskId, T0]);
            return { parts: [mcp("c1", "supplier", "place_order", ORDER)], usage: USAGE };
          },
        ],
      },
    });
    await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools)), "TASK_HALTED");
    expect((await taskRow(db, w.taskId)).cost_usd).toBe("0.002250");
    const intents = await db.query("SELECT 1 FROM action_intents WHERE task_id = $1", [w.taskId]);
    expect(intents.rowCount).toBe(0);
  });

  it("HL-13 503 が4回：1・4・16秒で3回やり直したあと 502 LLM_UPSTREAM_ERROR、failed(llm_unavailable)・トークン失効（HTTP の失敗は費用に数えない）", async () => {
    const { db } = T();
    const w = await world(db, {
      env: {
        script: () => {
          throw new LlmError("Gemini がエラーを返しました（HTTP 503）", 503, true);
        },
      },
    });
    await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([])), "LLM_UPSTREAM_ERROR");
    expect(w.env.sleeps).toEqual([1_000, 4_000, 16_000]);
    expect(w.env.llm.requests).toHaveLength(4);
    expect(await taskRow(db, w.taskId)).toMatchObject({ status: "failed", fail_reason: "llm_unavailable", task_token_hash: null, cost_usd: "0.000000" });
    expect(w.env.hooks).toEqual([{ hook: "onTaskTerminal", taskId: w.taskId, status: "failed" }]);
  });

  it("SO §3.12-6 使った量が分からない失敗（タイムアウト）は見積もりを費用に数える。2回失敗して3回目で通る", async () => {
    const { db } = T();
    let n = 0;
    const w = await world(db, {
      env: {
        script: () => {
          n += 1;
          if (n <= 2) throw new LlmError("タイムアウト", null, true);
          return { parts: [text("ok")], usage: USAGE };
        },
      },
    });
    const res = await w.env.edge.llmMessages(w.token, llmRequest([], { system: "s", messages: [{ role: "user", content: "u" }], maxTokens: 1000 }));
    const est = estimateCallMicroUsd(bareRequest(1000));
    expect(toMicroUsd(Number(res.usage.costUsd))).toBe(2250 + 2 * est);
    expect(w.env.sleeps).toEqual([1_000, 4_000]);
    expect((await taskRow(db, w.taskId)).steps_used).toBe(1);
  });

  it("決定 (d) 価格表にないモデルは呼ばない：502、failed(llm_unavailable)", async () => {
    const { db } = T();
    const w = await world(db, { env: { extra: { models: { agentModel: "gemini-unknown-9", plannerModel: "gemini-unknown-9" } } } });
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest([])), "LLM_UPSTREAM_ERROR");
    expect(e.details).toMatchObject({ reason: "unpriced_model" });
    expect(w.env.llm.requests).toHaveLength(0);
    expect(await taskRow(db, w.taskId)).toMatchObject({ status: "failed", fail_reason: "llm_unavailable" });
  });
});

/** 台本の次の応答を返させて判定させる（runner と同じく文脈のツールを渡す） */
async function respond(w: World) {
  return w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools));
}

describe("応答のツール呼び出しの判定（M-14：tool_call で1回。§3.10-9）", () => {
  it("HL-05 仕入れ係の place_order（ルールなし）→ Intent pending_approval と承認（期限24時間・承認者・リスク・初めての宛先）。governance に intent", async () => {
    const { db } = T();
    const w = await world(db, { env: { script: [{ parts: [text("発注します"), mcp("c1", "supplier", "place_order", ORDER)], usage: USAGE }] } });
    const res = await respond(w);
    const intent = (
      await db.query<Record<string, unknown> & { id: Uuid }>("SELECT * FROM action_intents WHERE task_id = $1", [w.taskId])
    ).rows[0]!;
    expect(res.governance).toEqual([
      { toolCallId: "c1", decision: "approve", reasonCode: "approval_required", matchedRule: "autonomy.mcp_write", intent: { intentId: intent.id, status: "pending_approval" } },
    ]);
    const job = w.agent.jobs.reorder!;
    const argRoles = { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" } as const;
    const supplierConn = w.conns.supplier!;
    expect(intent).toMatchObject({
      status: "pending_approval",
      decision: "approve",
      reason_code: "approval_required",
      matched_rule: "autonomy.mcp_write",
      action: "mcp.supplier.place_order",
      origin: "agent",
      enforced: true,
      job_id: job.jobId,
      connector_id: supplierConn.id,
      tool_hash: supplierConn.tools.place_order!.toolHash,
      policy_hash: job.policyHash,
      destination_key: destinationKey("mcp.supplier.place_order", ORDER, argRoles),
      option_digest: optionDigest("mcp.supplier.place_order", ORDER, argRoles),
      intent_hash: computeMcpIntentHash({
        connectorId: supplierConn.id,
        tool: "place_order",
        arguments: ORDER,
        toolHash: supplierConn.tools.place_order!.toolHash,
        effectivePolicyHash: job.policyHash,
      }),
      payload: { connectorId: supplierConn.id, tool: "place_order", arguments: ORDER, toolHash: supplierConn.tools.place_order!.toolHash },
      taint_snapshot: { tainted: false, sources: [] },
    });
    expect((intent.expires_at as Date).getTime()).toBe(T0.getTime() + 24 * 3600_000);
    const approval = (await db.query<Record<string, unknown>>("SELECT * FROM approvals WHERE intent_id = $1", [intent.id])).rows[0]!;
    expect(approval).toMatchObject({
      status: "pending",
      risk_level: "medium",
      risk_score: 3,
      approver_ids: [w.ws.userId],
      expiry_cause: "ttl",
      first_destination: true,
    });
    // policy_decisions：tool_call の判定に intent_id（M-16）、記録の引数（callTool が使う）
    const pd = (await db.query<Record<string, unknown>>("SELECT * FROM policy_decisions WHERE task_id = $1 AND subject_kind = 'tool_call'", [w.taskId])).rows[0]!;
    expect(pd).toMatchObject({ intent_id: intent.id, action_type: "mcp_write", decision: "approve", enforced: true, matched_rule_id: null });
    expect((pd.subject as { args: unknown }).args).toEqual(ORDER);
    expect(await auditEvents(db, w.ws, "intent.proposed")).toEqual([expect.objectContaining({ intentId: intent.id, status: "pending_approval" })]);
    expect(await auditEvents(db, w.ws, "approval.requested")).toHaveLength(1);
    expect(await auditEvents(db, w.ws, "decision.made")).toEqual([expect.objectContaining({ intentId: intent.id, decision: "approve" })]);
    expect(w.env.hooks).toEqual([{ hook: "onIntentRecorded", taskId: w.taskId, status: "pending_approval", intentId: intent.id }]);
  });

  it("M-25 定期の依頼の承認の期限は「次の実行」が24時間より早ければそれ（expiry_cause: next_run）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { kind: "guest", audit: true });
    await seedConnectors(db, ws);
    const supplier = await seedAgent(db, ws, supplierDefinition());
    const ask = await seedChainAsk(db, ws, [{ agent: supplier, jobSlug: "reorder", position: 1, spokesperson: true }], {
      nextRunAt: new Date(T0.getTime() + 3600_000),
    });
    const taskId = await seedTask(db, ws, supplier, "reorder", { ask, memberName: "仕入れ係" });
    const token = await tokenFor(db, ws, taskId);
    const env = buildEdge(db, { script: [{ parts: [mcp("c1", "supplier", "place_order", ORDER)], usage: USAGE }] });
    const ctx = await env.edge.getTaskContext(token);
    await env.edge.llmMessages(token, llmRequest(ctx.tools));
    const a = (await db.query<{ expires_at: Date; expiry_cause: string }>("SELECT expires_at, expiry_cause FROM approvals WHERE task_id = $1", [taskId])).rows[0]!;
    expect(a.expiry_cause).toBe("next_run");
    expect(a.expires_at.getTime()).toBe(T0.getTime() + 3600_000);
  });

  it("HL-06 ルールに一致・ガード内 → allow（rule_matched）、Intent approved（accepted）。onIntentRecorded で実行を起こせる", async () => {
    const { db } = T();
    const w = await ruleWorld(db, { script: [mcp("c1", "supplier", "place_order", { ...ORDER, items: [{ sku: "BEAN-01", quantity: 10, unit_price: 1900 }] })] });
    const res = await respond(w);
    expect(res.governance[0]).toMatchObject({ decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]", intent: { status: "accepted" } });
    const intent = (await db.query<{ status: string; enforced: boolean }>("SELECT status, enforced FROM action_intents WHERE task_id = $1", [w.taskId])).rows[0]!;
    expect(intent).toEqual({ status: "approved", enforced: true });
    expect((await db.query("SELECT 1 FROM approvals WHERE task_id = $1", [w.taskId])).rowCount).toBe(0);
    expect(w.env.hooks).toEqual([expect.objectContaining({ hook: "onIntentRecorded", status: "approved" })]);
    // SG-09：判定の記録に、添字のパスに加えて一致したルールの id を残す。「最後に使った時刻」を担当ごとに、本番のタスクだけで引ける
    const pd = (await db.query<{ matched_rule: string; matched_rule_id: string | null }>("SELECT matched_rule, matched_rule_id FROM policy_decisions WHERE task_id = $1 AND subject_kind = 'tool_call'", [w.taskId])).rows;
    expect(pd).toEqual([{ matched_rule: "rules.items[0]", matched_rule_id: "r-0001" }]);
    const lastMatched = async () =>
      (
        await db.query<{ matched_rule_id: string; last_matched_at: Date }>(
          `SELECT d.matched_rule_id, max(d.created_at) AS last_matched_at
             FROM policy_decisions d JOIN tasks t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
            WHERE d.workspace_id = $1 AND t.agent_id = (SELECT agent_id FROM tasks WHERE id = $2) AND d.matched_rule_id IS NOT NULL AND d.reason_code = 'rule_matched' AND d.enforced
              AND t.is_dry_run = false
            GROUP BY d.matched_rule_id`,
          [w.ws.workspaceId, w.taskId],
        )
      ).rows;
    expect(await lastMatched()).toEqual([{ matched_rule_id: "r-0001", last_matched_at: expect.any(Date) }]);
    // 試し実行の一致は記録には残るが、「最後に使った時刻」には数えない
    await db.query("UPDATE tasks SET is_dry_run = true, trigger_type = 'dry_run' WHERE id = $1", [w.taskId]);
    expect(await lastMatched()).toEqual([]);
    expect((await db.query("SELECT 1 FROM policy_decisions WHERE task_id = $1 AND matched_rule_id = 'r-0001'", [w.taskId])).rowCount).toBe(1);
    expect(await auditEvents(db, w.ws, "decision.made")).toEqual([expect.objectContaining({ reasonCode: "rule_matched", matchedRule: "rules.items[0]", matchedRuleId: "r-0001" })]);
  });

  it("BR-61 ガード（items[].quantity ≤ 20）を超える → approve（guard_exceeded）、decision_detail にガードと値", async () => {
    const { db } = T();
    const w = await ruleWorld(db, { script: [mcp("c1", "supplier", "place_order", { ...ORDER, items: [{ sku: "BEAN-01", quantity: 21, unit_price: 1800 }] })] });
    const res = await respond(w);
    expect(res.governance[0]).toMatchObject({ decision: "approve", reasonCode: "guard_exceeded", matchedRule: "guards[0]" });
    const intent = (await db.query<{ decision_detail: JsonObject }>("SELECT decision_detail FROM action_intents WHERE task_id = $1", [w.taskId])).rows[0]!;
    expect(intent.decision_detail).toMatchObject({ kind: "guard", argPath: "items[0].quantity", value: 21, guard: { arg: "items[].quantity", max: 20 } });
  });

  it("KD §8-16 destination・option の文字列の前後の空白を除いてから判定・保存する（ルールに一致し、送る値も同じ）", async () => {
    const { db } = T();
    const w = await ruleWorld(db, { script: [mcp("c1", "supplier", "place_order", { supplier_id: " supplier-01 ", items: [{ sku: "BEAN-01 ", quantity: 5, unit_price: 1800 }], note: " 備考 " })] });
    const res = await respond(w);
    expect(res.governance[0]).toMatchObject({ decision: "allow" });
    const intent = (await db.query<{ payload: { arguments: JsonObject } }>("SELECT payload FROM action_intents WHERE task_id = $1", [w.taskId])).rows[0]!;
    expect(intent.payload.arguments).toEqual({ supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 5, unit_price: 1800 }], note: " 備考 " });
  });

  it("HL-07・M-14 受信箱係（researcher）が supplier.place_order → deny（not_granted：付与なし）、Intent は denied", async () => {
    const { db } = T();
    const w = await world(db, { def: "inbox", env: { script: [{ parts: [mcp("c1", "supplier", "place_order", ORDER)], usage: USAGE }] } });
    const res = await respond(w);
    expect(res.governance[0]).toMatchObject({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.grants.supplier", intent: { status: "denied" } });
    expect((await taskRow(db, w.taskId)).denied_count).toBe(1);
    const intent = (await db.query<{ status: string; decision: string }>("SELECT status, decision FROM action_intents WHERE task_id = $1", [w.taskId])).rows[0]!;
    expect(intent).toEqual({ status: "denied", decision: "deny" });
  });

  it("M-14 researcher に書き込みのツールを付与しても LLM は呼べない（not_granted：mcp.llmWrite）", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { kind: "guest", audit: true });
    await seedConnectors(db, ws);
    const def = inboxDefinition();
    def.grants = { connectors: { mail: { grant: ["list_inbox", "send"] } } };
    const agent = await seedAgent(db, ws, def);
    const taskId = await seedTask(db, ws, agent, "read-supplier-mail");
    const token = await tokenFor(db, ws, taskId);
    const env = buildEdge(db, { script: [{ parts: [mcp("c1", "mail", "send", { to: "evil@example.com", body: "x" })], usage: USAGE }] });
    const ctx = await env.edge.getTaskContext(token);
    const res = await env.edge.llmMessages(token, llmRequest(ctx.tools));
    expect(res.governance[0]).toMatchObject({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.llmWrite" });
  });

  it("HL-08 仕入れ係が mail.list_inbox（付与なしの読み取り）→ deny（not_granted）、Intent は作らない", async () => {
    const { db } = T();
    const w = await world(db, { env: { script: [{ parts: [mcp("c1", "mail", "list_inbox", {})], usage: USAGE }] } });
    const res = await respond(w);
    expect(res.governance).toEqual([{ toolCallId: "c1", decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.grants.mail" }]);
    expect((await db.query("SELECT 1 FROM action_intents WHERE task_id = $1", [w.taskId])).rowCount).toBe(0);
  });

  it("HL-01・BR-09 remember → not_granted（tools）、カタログにない名前 → unknown_action、どちらも deniedCount に数える。読み取りの allow は Intent にしない", async () => {
    const { db } = T();
    const w = await world(db, {
      env: {
        script: [
          {
            parts: [call("c1", "remember", { content: "x" }), call("c2", "drop_database", {}), mcp("c3", "store", "get_inventory", {}), call("c4", "notify", { title: "t", body: "b", priority: "normal" })],
            usage: USAGE,
          },
        ],
      },
    });
    const res = await respond(w);
    expect(res.governance).toEqual([
      { toolCallId: "c1", decision: "deny", reasonCode: "not_granted", matchedRule: "tools" },
      { toolCallId: "c2", decision: "deny", reasonCode: "unknown_action", matchedRule: null },
      { toolCallId: "c3", decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.mcp_read" },
      { toolCallId: "c4", decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.notify" },
    ]);
    expect((await taskRow(db, w.taskId)).denied_count).toBe(2);
    const pd = (await db.query<{ action_type: string | null }>("SELECT action_type FROM policy_decisions WHERE task_id = $1 AND subject_kind = 'tool_call' ORDER BY created_at, id", [w.taskId])).rows;
    expect(pd.map((r) => r.action_type).sort()).toEqual(["mcp_read", "memory_write", "notify", null].sort());
  });

  it("BR-64 ゲストの web_search は decide の前に deny（guest_workspace）", async () => {
    const { db } = T();
    const w = await world(db, { env: { script: [{ parts: [call("c1", "web_search", { query: "豆", max_results: 3 })], usage: USAGE }] } });
    const res = await respond(w);
    expect(res.governance).toEqual([{ toolCallId: "c1", decision: "deny", reasonCode: "guest_workspace", matchedRule: null }]);
  });

  it("FR-014 同じ呼び出しの5回目で Breaker（same_action_repeat）→ halt、タスクは halted(breaker_tripped)・監査ログ breaker.tripped。残りは判定しない", async () => {
    const { db } = T();
    const w = await world(db, {
      env: { script: [{ parts: [mcp("a1", "store", "get_inventory", {}), mcp("a2", "store", "get_inventory", {}), mcp("a3", "store", "get_inventory", {}), mcp("a4", "store", "get_inventory", {}), mcp("a5", "store", "get_inventory", {}), mcp("a6", "store", "get_inventory", {})], usage: USAGE }] },
    });
    const res = await respond(w);
    expect(res.governance.map((g) => g.decision)).toEqual(["allow", "allow", "allow", "allow", "halt"]);
    expect(res.governance[4]).toMatchObject({ reasonCode: "breaker_tripped", matchedRule: "breakers.same_action_repeat" });
    expect(await taskRow(db, w.taskId)).toMatchObject({ status: "halted", halt_reason: "breaker_tripped", task_token_hash: null });
    expect(await auditEvents(db, w.ws, "breaker.tripped")).toEqual([expect.objectContaining({ breaker: "same_action_repeat", value: 5, threshold: 5 })]);
    expect(w.env.hooks).toEqual([{ hook: "onTaskTerminal", taskId: w.taskId, status: "halted" }]);
  });

  it("FR-014 拒否が3回たまると次の判定で Breaker（denied_attempts_max）。応答をまたいでも数える", async () => {
    const { db } = T();
    const w = await world(db, {
      env: {
        script: [
          { parts: [call("d1", "remember", { content: "1" }), call("d2", "remember", { content: "2" }), call("d3", "remember", { content: "3" })], usage: USAGE },
          { parts: [text("ok")], usage: USAGE },
        ],
      },
    });
    const first = await respond(w);
    expect(first.governance.map((g) => g.decision)).toEqual(["deny", "deny", "deny"]);
    const e = await expectEdgeError(w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools)), "TASK_HALTED");
    expect(e.details).toMatchObject({ reasonCode: "breaker_tripped", matchedRule: "breakers.denied_attempts_max" });
  });

  it("決定 (e)：submit_report より後ろの呼び出しは判定せず Intent にもしない（記録だけ：llm.called の ignoredToolCalls）", async () => {
    const { db } = T();
    const w = await world(db, {
      env: {
        script: [{ parts: [mcp("c1", "store", "get_inventory", {}), report("c2"), mcp("c3", "supplier", "place_order", ORDER), call("c4", "notify", { title: "t", body: "b", priority: "normal" })], usage: USAGE }],
      },
    });
    const res = await respond(w);
    expect(res.governance.map((g) => g.toolCallId)).toEqual(["c1", "c2"]);
    expect(res.content.filter((p) => p.type === "tool_call")).toHaveLength(4);
    expect((await db.query("SELECT 1 FROM action_intents WHERE task_id = $1", [w.taskId])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM policy_decisions WHERE task_id = $1 AND subject_kind = 'tool_call'", [w.taskId])).rowCount).toBe(2);
    expect(await auditEvents(db, w.ws, "llm.called")).toEqual([expect.objectContaining({ ignoredToolCalls: 2 })]);
  });

  it("M-12 入力スキーマにない引数（最上位のキー）がある書き込みは Intent にせず、ツールのエラーで返す（allow・invalid_arguments）", async () => {
    const { db } = T();
    const w = await world(db, { env: { script: [{ parts: [mcp("c1", "supplier", "place_order", { ...ORDER, discount: 50 })], usage: USAGE }] } });
    const res = await respond(w);
    expect(res.governance).toEqual([{ toolCallId: "c1", decision: "allow", reasonCode: "invalid_arguments", matchedRule: "autonomy.mcp_write" }]);
    expect((await db.query("SELECT 1 FROM action_intents WHERE task_id = $1", [w.taskId])).rowCount).toBe(0);
    const out = await w.env.edge.callTool(w.token, "c1");
    expect(out.kind).toBe("text");
    expect(out.kind === "text" ? out.text : "").toContain("スキーマにない引数：discount");
  });

  it("M-12 中身がスキーマに合わない書き込み（数量 0）も Intent にしない", async () => {
    const { db } = T();
    const w = await world(db, { env: { script: [{ parts: [mcp("c1", "supplier", "place_order", { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 0, unit_price: 1 }] })], usage: USAGE }] } });
    const res = await respond(w);
    expect(res.governance[0]).toMatchObject({ decision: "allow", reasonCode: "invalid_arguments" });
    expect((await db.query("SELECT 1 FROM action_intents WHERE task_id = $1", [w.taskId])).rowCount).toBe(0);
  });

  it("A-85 Intent の数：5件目まで作り、6件目は deny（intent_limit。denied の Intent も数える）", async () => {
    const { db } = T();
    const parts = [1, 2, 3, 4, 5, 6].map((q) => mcp(`o${q}`, "supplier", "place_order", { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: q, unit_price: 1800 }] }));
    const w = await world(db, { env: { script: [{ parts, usage: USAGE }] } });
    const res = await respond(w);
    expect(res.governance.map((g) => g.reasonCode)).toEqual([...Array(5).fill("approval_required"), "intent_limit"]);
    expect(res.governance[5]).toMatchObject({ decision: "deny", intent: { status: "denied" } });
    expect((await db.query("SELECT 1 FROM action_intents WHERE task_id = $1", [w.taskId])).rowCount).toBe(6);
  });

  it("BR-68 同じ仕事・同じ宛先に unknown_outcome の書き込みがあれば approve（unknown_outcome_pending）", async () => {
    const { db } = T();
    const w = await ruleWorld(db, { script: [mcp("c1", "supplier", "place_order", ORDER), mcp("c2", "supplier", "place_order", { ...ORDER, items: [{ sku: "BEAN-01", quantity: 3, unit_price: 1800 }] })] });
    const argRoles = { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" } as const;
    const key = destinationKey("mcp.supplier.place_order", ORDER, argRoles);
    const prev = await seedTask(db, w.ws, w.agent, w.jobSlug, { status: "running" });
    await db.query(
      `INSERT INTO action_intents (workspace_id, task_id, job_id, connector_id, action, origin, payload, tool_hash, destination_key, option_digest, status,
                                   decision, reason_code, policy_hash, intent_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'mcp.supplier.place_order', 'agent', '{}', $5, $6, $6, 'unknown_outcome', 'allow', 'rule_matched', $6, $6, $7, $7)`,
      [w.ws.workspaceId, prev, w.agent.jobs.reorder!.jobId, w.conns.supplier!.id, w.conns.supplier!.tools.place_order!.toolHash, key, T0],
    );
    const res = await respond(w);
    expect(res.governance[0]).toMatchObject({ decision: "approve", reasonCode: "unknown_outcome_pending" });
  });

  it("モデルの ID が空・このタスクで使った ID と重なるときは作り直し、応答の部品の ID も書き換える", async () => {
    const { db } = T();
    const w = await world(db, {
      env: {
        script: [
          { parts: [mcp("same", "store", "get_inventory", {})], usage: USAGE },
          { parts: [mcp("same", "supplier", "list_products", {}), mcp("", "store", "get_inventory", { })], usage: USAGE },
        ],
      },
    });
    await respond(w);
    const second = await respond(w);
    const ids = second.content.filter((p) => p.type === "tool_call").map((p) => (p.type === "tool_call" ? p.id : ""));
    expect(ids).toEqual(["gen-1", "gen-2"]);
    expect(second.governance.map((g) => g.toolCallId)).toEqual(["gen-1", "gen-2"]);
  });
});

// ---- ルールのある仕入れ係（supplier-01 の BEAN-01 を固定、数量・単価は変わってよい、数量のガード 20） ----

async function ruleWorld(
  db: Db,
  o: { script: ReturnType<typeof call>[] },
): Promise<World> {
  const ws = await fxWorkspace(db, { kind: "guest", audit: true });
  const conns = await seedConnectors(db, ws);
  const placeHash = conns.supplier!.tools.place_order!.toolHash;
  const def = supplierDefinition(
    {
      rules: [
        {
          id: "r-0001",
          action: "mcp.supplier.place_order",
          match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-01"] },
          free: ["items[].quantity", "items[].unit_price"],
          tool_hash: placeHash,
          added_by: "owner",
          added_at: T0.toISOString(),
        },
      ],
    },
    { guards: [{ action: "mcp.supplier.place_order", arg: "items[].quantity", max: 20 }] },
  );
  const agent = await seedAgent(db, ws, def);
  const taskId = await seedTask(db, ws, agent, "reorder");
  const token = await tokenFor(db, ws, taskId);
  const env = buildEdge(db, { script: [{ parts: o.script, usage: USAGE }] });
  const ctx = await env.edge.getTaskContext(token);
  return { db, ws, conns, agent, jobSlug: "reorder", taskId, token, ctx, env };
}

