// LLM Proxy（edgeLlmPrepare・edgeLlmBegin・edgeLlmSettle・edgeLlmFail）の試験：入力の検証・回数・予算（decide と checkSpend）・
// LLM の失敗・費用の加算・応答のツール呼び出しの判定（M-14・M-15・M-12）・Intent（recordMcpIntent）・Breaker・submit_report の後ろ（決定 (e)）
// （packages/edge/src/proxy.test.ts の WorkspaceDO 版。やり直しの試験は llm-call.ts の側）
import { computeMcpIntentHash, destinationKey, optionDigest, toMicroUsd, type JsonObject } from "@open-team/kernel";
import { LlmError, type LlmRequest } from "@open-team/llm";
import { DEFAULT_CLAUDE_MODEL as DEFAULT_AGENT_MODEL } from "../../src/llm/claude.ts";
import type { TaskContext } from "@open-team/runner";
import { describe, expect, it } from "vitest";
import { all, one, run, type WsDb } from "../../src/db/sqlite.ts";
import { estimateCallMicroUsd } from "../../src/edge/llm-call.ts";
import { edgeLlmBegin, edgeLlmFail, edgeLlmPrepare, edgeTaskContext } from "../../src/edge/task-edge.ts";
import { fxUsage, inWorkspace, type FxWorkspace } from "../db/fixtures.ts";
import {
  ORDER,
  T0,
  USAGE,
  buildEdge,
  call,
  expectEdgeError,
  inboxDefinition,
  llmRequest,
  mcp,
  report,
  seedAgent,
  seedConnectors,
  seedTask,
  supplierDefinition,
  text,
  type SeededAgent,
  type SeededConnector,
  type SeedTaskOptions,
  type TestEdge,
} from "./seed.ts";

interface World {
  db: WsDb;
  ws: FxWorkspace;
  conns: Record<string, SeededConnector>;
  agent: SeededAgent;
  taskId: string;
  ctx: TaskContext;
  env: TestEdge;
}

/** 仕入れ係（既定）か受信箱係のタスクを running にして返す */
function world(db: WsDb, ws: FxWorkspace, o: { def?: "supplier" | "inbox"; defArgs?: Parameters<typeof supplierDefinition>; task?: SeedTaskOptions; env?: Parameters<typeof buildEdge>[1] } = {}): World {
  const conns = seedConnectors(db);
  const agent = seedAgent(db, o.def === "inbox" ? inboxDefinition() : supplierDefinition(...(o.defArgs ?? [])));
  const taskId = seedTask(db, ws, agent, o.def === "inbox" ? "read-supplier-mail" : "reorder", { ...o.task });
  const env = buildEdge(db, o.env);
  const ctx = edgeTaskContext(db, env.rt, taskId, T0);
  return { db, ws, conns, agent, taskId, ctx, env };
}

function taskRow(db: WsDb, taskId: string) {
  return one<{ status: string; halt_reason: string | null; fail_reason: string | null; cost_micro_usd: number; steps_used: number; denied_count: number }>(
    db,
    {},
    "SELECT status, halt_reason, fail_reason, cost_micro_usd, steps_used, denied_count FROM tasks WHERE id = ?",
    taskId,
  )!;
}

function auditEvents(db: WsDb, type: string): JsonObject[] {
  return all<{ payload: string }>(db, {}, "SELECT payload FROM audit_logs WHERE event_type = ? ORDER BY seq", type).map((r) => JSON.parse(r.payload) as JsonObject);
}

function count(db: WsDb, query: string, ...params: string[]): number {
  return all(db, {}, query, ...params).length;
}

/** ツールを渡さない要求（見積もりを試験で計算しやすくする） */
function bareRequest(maxTokens: number): LlmRequest {
  return { model: DEFAULT_AGENT_MODEL, system: "s", messages: [{ role: "user", content: "u" }], tools: [], mcpTools: [], maxTokens };
}
const BARE = { system: "s", messages: [{ role: "user" as const, content: "u" }] };

describe("入力の検証（§3.10-2）・回数（§3.10-3）", () => {
  it("HL-23 phase = design・system＋messages が 1MB 超・maxTokens 0／16,001 は VALIDATION_ERROR。LLM は呼ばない", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws);
      const base = llmRequest(w.ctx.tools);
      for (const bad of [{ ...base, phase: "design" }, { ...base, system: "あ".repeat(400_000) }, { ...base, maxTokens: 0 }, { ...base, maxTokens: 16_001 }]) {
        await expectEdgeError(() => edgeLlmPrepare(db, w.env.rt, w.taskId, bad, T0), "VALIDATION_ERROR");
      }
      expect(w.env.llm.requests).toHaveLength(0);
    });
  });

  it("tools ⊆ TaskContext.tools：文脈にないツール（web_search・team_post）は 400。宣言は edge が作ったもの・モデルは Router", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws);
      const e = await expectEdgeError(() => edgeLlmPrepare(db, w.env.rt, w.taskId, llmRequest([{ name: "web_search" }, { name: "team_post" }]), T0), "VALIDATION_ERROR");
      expect(e.details).toMatchObject({ reason: "tool_not_in_context", tools: ["web_search", "team_post"] });
      const req = llmRequest(w.ctx.tools);
      req.tools = req.tools.map((t) => ({ ...t, description: "書き換えた説明" }));
      const { llmReq, phase } = edgeLlmPrepare(db, w.env.rt, w.taskId, req, T0);
      expect(phase).toBe("plan");
      expect(llmReq.model).toBe(DEFAULT_AGENT_MODEL);
      expect(llmReq.tools.map((t) => t.name)).toEqual(["mcp_call", "notify", "submit_report", "finish"]);
      expect(llmReq.tools.every((t) => t.description !== "書き換えた説明")).toBe(true);
      expect(llmReq.mcpTools.map((t) => `${t.connector}.${t.tool}`)).toEqual(["bank.register_payee", "store.get_inventory", "supplier.list_products", "supplier.place_order"]);
    });
  });

  it("HL-14 1分に上限を超えた呼び出しは 429 RATE_LIMITED（retryAfterSec つき）。60秒たてばまた呼べる", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, { env: { limits: { llmCallsPerMinute: 3 } } });
      for (let i = 0; i < 3; i++) edgeLlmPrepare(db, w.env.rt, w.taskId, llmRequest([]), new Date(T0.getTime() + i * 1_000));
      const e = await expectEdgeError(() => edgeLlmPrepare(db, w.env.rt, w.taskId, llmRequest([]), new Date(T0.getTime() + 3_000)), "RATE_LIMITED");
      expect(e.retryAfterSec).toBe(57);
      edgeLlmPrepare(db, w.env.rt, w.taskId, llmRequest([]), new Date(T0.getTime() + 60_000));
    });
  });
});

describe("費用の加算（§3.10-8、FR-013）", () => {
  it("usage_records・tasks.cost_micro_usd／steps_used・task_events・監査ログ llm.called・判定の記録（llm_call）。応答の budget は足したあとの値", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, { env: { script: [{ parts: [text("在庫を見ます")], usage: USAGE }] } });
      const res = await w.env.llmMessages(w.taskId, llmRequest([], { phase: "implement" }));
      expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 100, costUsd: "0.006000" });
      expect(res.budget).toEqual({ costUsd: "0.006000", stepsUsed: 1 });
      expect(res.governance).toEqual([]);
      const usage = all<Record<string, unknown>>(db, {}, "SELECT * FROM usage_records");
      expect(usage).toEqual([
        expect.objectContaining({ task_id: w.taskId, agent_id: w.agent.agentId, phase: "implement", input_tokens: 1000, output_tokens: 100, cost_micro_usd: 6000, model: DEFAULT_AGENT_MODEL, provider: "anthropic" }),
      ]);
      expect(taskRow(db, w.taskId)).toMatchObject({ cost_micro_usd: 6000, steps_used: 1, status: "running" });
      expect(count(db, "SELECT 1 FROM task_events WHERE task_id = ? AND type = 'llm_called'", w.taskId)).toBe(1);
      const audit = auditEvents(db, "llm.called");
      expect(audit).toEqual([expect.objectContaining({ taskId: w.taskId, model: DEFAULT_AGENT_MODEL, costUsd: "0.006000", ignoredToolCalls: 0 })]);
      expect(audit[0]).toHaveProperty("promptHash");
      const decisions = all(db, {}, "SELECT subject_kind, decision, reason_code FROM policy_decisions WHERE task_id = ?", w.taskId);
      expect(decisions).toEqual([{ subject_kind: "llm_call", decision: "allow", reason_code: "not_gated" }]);
    });
  });
});

describe("呼ぶ前の確かめ（edgeLlmBegin：decide(llm_call) と checkSpend）", () => {
  it("HL-10・HL-11 per_task_usd 0.2：0.15＋見積もりは通す、0.16＋見積もりは halted(budget_exceeded)・監査ログ budget.exceeded・判定の記録", async () => {
    await inWorkspace(async (db, ws) => {
      // 出力 2,400 × $20/M ＝ $0.048 ＋ 入力の上限の分（Opus 5.5）
      const est = estimateCallMicroUsd(bareRequest(2400));
      expect(est).toBeGreaterThan(40_000);
      expect(est).toBeLessThan(50_000);
      const ok = world(db, ws, { task: { status: "running", costMicroUsd: 150_000 } });
      edgeLlmBegin(db, ok.env.rt, ok.taskId, { budgetEstimateMicroUsd: est, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0);
      expect(taskRow(db, ok.taskId).status).toBe("running");

      const ngTask = seedTask(db, ws, ok.agent, "reorder", { status: "running", costMicroUsd: 160_000 });
      const e = await expectEdgeError(() => edgeLlmBegin(db, ok.env.rt, ngTask, { budgetEstimateMicroUsd: est, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0), "TASK_HALTED");
      expect(e.details).toMatchObject({ haltReason: "budget_exceeded", reasonCode: "budget_exceeded", matchedRule: "budget.per_task_usd" });
      expect(taskRow(db, ngTask)).toMatchObject({ status: "halted", halt_reason: "budget_exceeded" });
      expect(auditEvents(db, "budget.exceeded")).toEqual([expect.objectContaining({ taskId: ngTask, item: "per_task_usd", limitUsd: "0.200000", usedUsd: "0.160000" })]);
      // 止めた判定もコミットしてから投げる
      expect(all(db, {}, "SELECT decision FROM policy_decisions WHERE task_id = ? AND subject_kind = 'llm_call'", ngTask)).toEqual([{ decision: "halt" }]);
      // 止めたあとは呼べない
      await expectEdgeError(() => edgeLlmPrepare(db, ok.env.rt, ngTask, llmRequest([]), T0), "TASK_HALTED");
    });
  });

  it("境界：使った額＋見積もり＝上限ちょうどは通す、1マイクロドルでも超えれば止める", async () => {
    await inWorkspace(async (db, ws) => {
      const est = estimateCallMicroUsd(bareRequest(1000));
      const a = world(db, ws, { task: { status: "running", costMicroUsd: toMicroUsd(0.2) - est } });
      edgeLlmBegin(db, a.env.rt, a.taskId, { budgetEstimateMicroUsd: est, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0);
      const b = seedTask(db, ws, a.agent, "reorder", { status: "running", costMicroUsd: toMicroUsd(0.2) - est + 1 });
      await expectEdgeError(() => edgeLlmBegin(db, a.env.rt, b, { budgetEstimateMicroUsd: est, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0), "TASK_HALTED");
    });
  });

  it("HL-12 max_steps 40：40 は halt（budget.max_steps）／max_minutes（15分）超は halted(timeout)", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, { task: { status: "running", stepsUsed: 40 } });
      const e = await expectEdgeError(() => edgeLlmBegin(db, w.env.rt, w.taskId, { budgetEstimateMicroUsd: 1000, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0), "TASK_HALTED");
      expect(e.details).toMatchObject({ matchedRule: "budget.max_steps" });
      const late = seedTask(db, ws, w.agent, "reorder", { status: "running", startedAt: new Date(T0.getTime() - 15 * 60_000 - 1_000) });
      const t = await expectEdgeError(() => edgeLlmBegin(db, w.env.rt, late, { budgetEstimateMicroUsd: 1000, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0), "TASK_HALTED");
      expect(t.details).toMatchObject({ haltReason: "timeout", matchedRule: "budget.max_minutes" });
      expect(taskRow(db, late).halt_reason).toBe("timeout");
    });
  });

  it("agent_day_usd（1日 $1）：同じエージェントの別のタスクの今日の費用も数える（G-01）", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws);
      const other = seedTask(db, ws, w.agent, "reorder", { status: "running" });
      fxUsage(db, { taskId: other, costMicroUsd: 999_000, createdAt: T0 });
      const e = await expectEdgeError(() => edgeLlmBegin(db, w.env.rt, w.taskId, { budgetEstimateMicroUsd: 10_000, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0), "TASK_HALTED");
      expect(e.details).toMatchObject({ matchedRule: "budget.agent_day_usd" });
    });
  });

  it("BR-62 今日の費用＋見積もり > $15 → decide の前に halted(budget_exceeded)、監査ログに scope: global（ちょうどは checkSpend を通る）", async () => {
    // DO の中では「全体」はこのワークスペースの今日の費用（spend.ts）。費用の行を足すと per_day_usd（$1）が先に止めるので、見積もりで確かめる
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws);
      const e = await expectEdgeError(() => edgeLlmBegin(db, w.env.rt, w.taskId, { budgetEstimateMicroUsd: 15_000_001, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0), "TASK_HALTED");
      expect(e.details).toEqual({ haltReason: "budget_exceeded", scope: "global" });
      expect(taskRow(db, w.taskId)).toMatchObject({ status: "halted", halt_reason: "budget_exceeded" });
      expect(auditEvents(db, "budget.exceeded")).toEqual([expect.objectContaining({ scope: "global", limitUsd: "15.000000" })]);
      // decide(llm_call) まで行かない（判定の記録がない）
      expect(count(db, "SELECT 1 FROM policy_decisions WHERE task_id = ?", w.taskId)).toBe(0);
      // ちょうど $15 は checkSpend を通り、decide の per_task_usd が止める
      const other = seedTask(db, ws, w.agent, "reorder", { status: "running" });
      const d = await expectEdgeError(() => edgeLlmBegin(db, w.env.rt, other, { budgetEstimateMicroUsd: 15_000_000, model: DEFAULT_AGENT_MODEL, phase: "plan" }, T0), "TASK_HALTED");
      expect(d.details).toMatchObject({ matchedRule: "budget.per_task_usd" });
    });
  });
});

describe("呼んだあと・失敗（edgeLlmSettle・edgeLlmFail）", () => {
  it("呼んでいる間にタスクが止まった：費用は数え、ツール呼び出しは判定せず TASK_HALTED", async () => {
    await inWorkspace(async (db, ws) => {
      let taskId = "";
      const w = world(db, ws, {
        env: {
          script: [
            () => {
              run(db, "UPDATE tasks SET status = 'halted', halt_reason = 'budget_exceeded', finished_at = ? WHERE id = ?", T0, taskId);
              return { parts: [mcp("c1", "supplier", "place_order", ORDER)], usage: USAGE };
            },
          ],
        },
      });
      taskId = w.taskId;
      await expectEdgeError(() => w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools)), "TASK_HALTED");
      expect(taskRow(db, w.taskId).cost_micro_usd).toBe(6000);
      expect(count(db, "SELECT 1 FROM usage_records WHERE task_id = ?", w.taskId)).toBe(1);
      expect(count(db, "SELECT 1 FROM action_intents WHERE task_id = ?", w.taskId)).toBe(0);
    });
  });

  it("HL-13 やり直しのあとも失敗（llm）→ LLM_UPSTREAM_ERROR、failed(llm_unavailable)。数えた費用（送れたか分からない回）は記録する", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws);
      const { llmReq, phase } = edgeLlmPrepare(db, w.env.rt, w.taskId, llmRequest([]), T0);
      const usage = { model: llmReq.model, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, costMicroUsd: 3000, estimatedMicroUsd: 3000, latencyMs: 5, attempts: 4 };
      const e = await expectEdgeError(
        () => edgeLlmFail(db, w.env.rt, w.taskId, { llmReq, phase, kind: "llm", llmStatus: 503, message: "混んでいる", usage, provider: "anthropic" }, T0),
        "LLM_UPSTREAM_ERROR",
      );
      expect(e.details).toEqual({ status: 503 });
      expect(taskRow(db, w.taskId)).toMatchObject({ status: "failed", fail_reason: "llm_unavailable", cost_micro_usd: 3000, steps_used: 0 });
      expect(all(db, {}, "SELECT cost_micro_usd FROM usage_records WHERE task_id = ?", w.taskId)).toEqual([{ cost_micro_usd: 3000 }]);
      expect(auditEvents(db, "task.status_changed").at(-1)).toMatchObject({ to: "failed", failReason: "llm_unavailable", llmStatus: 503 });
    });
  });

  it("決定 (d) 価格表にないモデル → LLM_UPSTREAM_ERROR（reason: unpriced_model）、failed(llm_unavailable)。aborted はタスクを変えない", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws);
      const { llmReq, phase } = edgeLlmPrepare(db, w.env.rt, w.taskId, llmRequest([]), T0);
      const aborted = await expectEdgeError(
        () => edgeLlmFail(db, w.env.rt, w.taskId, { llmReq, phase, kind: "aborted", llmStatus: null, message: "中断", usage: null, provider: "anthropic" }, T0),
        "TASK_HALTED",
      );
      expect(aborted.details).toEqual({ haltReason: "aborted" });
      expect(taskRow(db, w.taskId).status).toBe("running");
      const e = await expectEdgeError(
        () => edgeLlmFail(db, w.env.rt, w.taskId, { llmReq, phase, kind: "unpriced_model", llmStatus: null, message: "価格表にないモデルは呼びません", usage: null, provider: "anthropic" }, T0),
        "LLM_UPSTREAM_ERROR",
      );
      expect(e.details).toMatchObject({ reason: "unpriced_model" });
      expect(taskRow(db, w.taskId)).toMatchObject({ status: "failed", fail_reason: "llm_unavailable" });
      expect(count(db, "SELECT 1 FROM usage_records")).toBe(0);
    });
  });

  it("台本の LLM が投げた失敗も同じ道（seed の llmMessages）", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, {
        env: {
          script: () => {
            throw new LlmError("混んでいる", 503, true);
          },
        },
      });
      await expectEdgeError(() => w.env.llmMessages(w.taskId, llmRequest([])), "LLM_UPSTREAM_ERROR");
      expect(taskRow(db, w.taskId)).toMatchObject({ status: "failed", fail_reason: "llm_unavailable" });
    });
  });
});

describe("応答のツール呼び出しの判定（M-14：tool_call で1回。§3.10-9）", () => {
  it("HL-05 仕入れ係の place_order（ルールなし）→ Intent pending_approval と承認（期限24時間・承認者・初めての宛先）。governance に intent", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, { env: { script: [{ parts: [text("発注します"), mcp("c1", "supplier", "place_order", ORDER)], usage: USAGE }] } });
      const res = await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      const intent = one<Record<string, unknown> & { id: string }>(db, {}, "SELECT * FROM action_intents WHERE task_id = ?", w.taskId)!;
      expect(res.governance).toEqual([
        { toolCallId: "c1", decision: "approve", reasonCode: "approval_required", matchedRule: "autonomy.mcp_write", intent: { intentId: intent.id, status: "pending_approval" } },
      ]);
      const job = w.agent.jobs.reorder!;
      const argRoles = { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" } as const;
      const supplier = w.conns.supplier!;
      expect(intent).toMatchObject({
        status: "pending_approval",
        decision: "approve",
        action: "mcp.supplier.place_order",
        origin: "agent",
        job_id: job.jobId,
        connector_id: supplier.id,
        tool_hash: supplier.tools.place_order!.toolHash,
        policy_hash: job.policyHash,
        destination_key: destinationKey("mcp.supplier.place_order", ORDER, argRoles),
        option_digest: optionDigest("mcp.supplier.place_order", ORDER, argRoles),
        intent_hash: computeMcpIntentHash({ connectorId: supplier.id, tool: "place_order", arguments: ORDER, toolHash: supplier.tools.place_order!.toolHash, effectivePolicyHash: job.policyHash }),
        expires_at: new Date(T0.getTime() + 24 * 3600_000).toISOString(),
      });
      const approval = one<Record<string, unknown>>(db, {}, "SELECT * FROM approvals WHERE intent_id = ?", intent.id)!;
      expect(approval).toMatchObject({ status: "pending", risk_level: "medium", expiry_cause: "ttl", first_destination: 1 });
      expect(JSON.parse(approval.approver_ids as string)).toEqual([ws.userId]);
      const pd = one<{ intent_id: string; action_type: string; decision: string; subject: string }>(db, {}, "SELECT * FROM policy_decisions WHERE task_id = ? AND subject_kind = 'tool_call'", w.taskId)!;
      expect(pd).toMatchObject({ intent_id: intent.id, action_type: "mcp_write", decision: "approve" });
      expect(JSON.parse(pd.subject).args).toEqual(ORDER);
      expect(auditEvents(db, "intent.proposed")).toEqual([expect.objectContaining({ intentId: intent.id, status: "pending_approval" })]);
      expect(auditEvents(db, "approval.requested")).toHaveLength(1);
      expect(auditEvents(db, "decision.made")).toEqual([expect.objectContaining({ intentId: intent.id, decision: "approve" })]);
    });
  });

  it("HL-07 受信箱係（researcher）が supplier.place_order → deny（not_granted）、Intent は denied。deniedCount に数える", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, { def: "inbox", env: { script: [{ parts: [mcp("c1", "supplier", "place_order", ORDER)], usage: USAGE }] } });
      const res = await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      expect(res.governance[0]).toMatchObject({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.grants.supplier", intent: { status: "denied" } });
      expect(taskRow(db, w.taskId).denied_count).toBe(1);
      expect(all(db, {}, "SELECT status, decision FROM action_intents WHERE task_id = ?", w.taskId)).toEqual([{ status: "denied", decision: "deny" }]);
    });
  });

  it("HL-01・BR-09 remember → not_granted、カタログにない名前 → unknown_action。読み取り・notify・submit_report は allow で Intent にしない", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, {
        env: {
          script: [
            {
              parts: [call("c1", "remember", { content: "x" }), call("c2", "drop_database", {}), mcp("c3", "store", "get_inventory", {}), call("c4", "notify", { title: "t", body: "b", priority: "normal" }), report("c5")],
              usage: USAGE,
            },
          ],
        },
      });
      const res = await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      expect(res.governance).toEqual([
        { toolCallId: "c1", decision: "deny", reasonCode: "not_granted", matchedRule: "tools" },
        { toolCallId: "c2", decision: "deny", reasonCode: "unknown_action", matchedRule: null },
        { toolCallId: "c3", decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.mcp_read" },
        { toolCallId: "c4", decision: "allow", reasonCode: "autonomy_auto", matchedRule: "autonomy.notify" },
        expect.objectContaining({ toolCallId: "c5", decision: "allow" }),
      ]);
      expect(taskRow(db, w.taskId).denied_count).toBe(2);
      expect(count(db, "SELECT 1 FROM action_intents WHERE task_id = ?", w.taskId)).toBe(0);
    });
  });

  it("FR-014 同じ呼び出しの5回目で Breaker → halt、タスクは halted(breaker_tripped)・監査ログ breaker.tripped。残りは判定しない", async () => {
    await inWorkspace(async (db, ws) => {
      const parts = [1, 2, 3, 4, 5, 6].map((i) => mcp(`a${i}`, "store", "get_inventory", {}));
      const w = world(db, ws, { env: { script: [{ parts, usage: USAGE }] } });
      const res = await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      expect(res.governance.map((g) => g.decision)).toEqual(["allow", "allow", "allow", "allow", "halt"]);
      expect(taskRow(db, w.taskId)).toMatchObject({ status: "halted", halt_reason: "breaker_tripped" });
      expect(auditEvents(db, "breaker.tripped")).toEqual([expect.objectContaining({ breaker: "same_action_repeat", value: 5, threshold: 5 })]);
    });
  });

  it("決定 (e)：submit_report より後ろの呼び出しは判定せず Intent にもしない（llm.called の ignoredToolCalls）", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, {
        env: { script: [{ parts: [mcp("c1", "store", "get_inventory", {}), report("c2"), mcp("c3", "supplier", "place_order", ORDER), call("c4", "notify", { title: "t", body: "b" })], usage: USAGE }] },
      });
      const res = await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      expect(res.governance.map((g) => g.toolCallId)).toEqual(["c1", "c2"]);
      expect(res.content.filter((p) => p.type === "tool_call")).toHaveLength(4);
      expect(count(db, "SELECT 1 FROM action_intents WHERE task_id = ?", w.taskId)).toBe(0);
      expect(auditEvents(db, "llm.called")).toEqual([expect.objectContaining({ ignoredToolCalls: 2 })]);
    });
  });

  it("M-12 入力スキーマにない引数がある書き込みは Intent にせず allow（invalid_arguments）", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, { env: { script: [{ parts: [mcp("c1", "supplier", "place_order", { ...ORDER, discount: 50 })], usage: USAGE }] } });
      const res = await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      expect(res.governance).toEqual([{ toolCallId: "c1", decision: "allow", reasonCode: "invalid_arguments", matchedRule: "autonomy.mcp_write" }]);
      expect(count(db, "SELECT 1 FROM action_intents WHERE task_id = ?", w.taskId)).toBe(0);
    });
  });

  it("HL-06 ルールに一致・ガード内 → allow（rule_matched）、Intent approved（accepted）。承認の行は作らない", async () => {
    await inWorkspace(async (db, ws) => {
      const conns = seedConnectors(db);
      const def = supplierDefinition({
        rules: [
          {
            id: "r-0001",
            action: "mcp.supplier.place_order",
            match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-01"] },
            free: ["items[].quantity", "items[].unit_price"],
            tool_hash: conns.supplier!.tools.place_order!.toolHash,
            added_by: "owner",
            added_at: T0.toISOString(),
          },
        ],
      } as never);
      const agent = seedAgent(db, def);
      const taskId = seedTask(db, ws, agent, "reorder");
      const env = buildEdge(db, { script: [{ parts: [mcp("c1", "supplier", "place_order", { ...ORDER, items: [{ sku: "BEAN-01", quantity: 10, unit_price: 1900 }] })], usage: USAGE }] });
      const ctx = edgeTaskContext(db, env.rt, taskId, T0);
      const res = await env.llmMessages(taskId, llmRequest(ctx.tools));
      expect(res.governance[0]).toMatchObject({ decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]", intent: { status: "accepted" } });
      expect(all(db, {}, "SELECT status FROM action_intents WHERE task_id = ?", taskId)).toEqual([{ status: "approved" }]);
      expect(count(db, "SELECT 1 FROM approvals WHERE task_id = ?", taskId)).toBe(0);
      expect(all(db, {}, "SELECT matched_rule_id FROM policy_decisions WHERE task_id = ? AND subject_kind = 'tool_call'", taskId)).toEqual([{ matched_rule_id: "r-0001" }]);
    });
  });

  it("モデルの ID が空・このタスクで使った ID と重なるときは作り直し、応答の部品の ID も書き換える", async () => {
    await inWorkspace(async (db, ws) => {
      const w = world(db, ws, {
        env: {
          script: [
            { parts: [mcp("same", "store", "get_inventory", {})], usage: USAGE },
            { parts: [mcp("same", "supplier", "list_products", {}), mcp("", "store", "get_inventory", {})], usage: USAGE },
          ],
        },
      });
      await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      const second = await w.env.llmMessages(w.taskId, llmRequest(w.ctx.tools));
      const ids = second.content.flatMap((p) => (p.type === "tool_call" ? [p.id] : []));
      expect(ids).toEqual(["gen-1", "gen-2"]);
      expect(second.governance.map((g) => g.toolCallId)).toEqual(["gen-1", "gen-2"]);
    });
  });
});
