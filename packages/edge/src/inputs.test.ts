// G-01 loadDecideInputs（判定の入力の出どころ）・checkSpend・canStartWork・callGemini（タスクの外）・issueTaskToken の試験
// （cross-check G-01・M-17・M-19・M-38、SO §3.10・§3.12、kernel-decide.md §3.4・§8-39）
import { describe, expect, it } from "vitest";
import { decide, type Subject } from "@open-team/kernel";
import { DEFAULT_AGENT_MODEL, LlmError, ScriptedLlmClient, type LlmRequest } from "@open-team/llm";
import { manualClock, memoryLogger, silentLogger } from "@open-team/platform";
import { lockWorkspace, type Db, type Uuid } from "@open-team/db";
import { fxUsage, useTestDb, type FxWorkspace } from "@open-team/db/testing";
import { lockTask } from "@open-team/db/edge";
import {
  T0,
  fxWorkspace,
  inboxDefinition,
  seedAgent,
  seedConnectors,
  seedTask,
  supplierDefinition,
  tokenFor,
  type SeededAgent,
} from "./__fixtures__/seed.ts";
import { GeminiCallError, callGemini, estimateCallMicroUsd } from "./gemini.ts";
import { loadDecideInputs } from "./inputs.ts";
import { canStartWork, checkSpend } from "./spend.ts";
import { issueTaskToken, resolveTaskByToken } from "./tokens.ts";
import { USAGE } from "./__fixtures__/env.ts";

const T = useTestDb();

async function supplierWorld(db: Db) {
  const ws = await fxWorkspace(db, { audit: true });
  const conns = await seedConnectors(db, ws);
  const agent = await seedAgent(db, ws, supplierDefinition());
  return { ws, conns, agent };
}

async function inputsFor(db: Db, ws: FxWorkspace, taskId: Uuid, subject: Subject, now: Date = T0) {
  return db.transaction(async (tx) => {
    await lockWorkspace(tx, ws.ctx);
    const task = (await lockTask(tx, ws.ctx, taskId))!;
    return loadDecideInputs(tx, ws.ctx, task, subject, now);
  });
}

const llmSubject: Subject = { kind: "llm_call", actionType: null, args: {}, paths: [], estimatedCostUsd: 0.01 };
const ORDER = { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 20, unit_price: 1800 }] };

describe("G-01 loadDecideInputs：判定の入力の出どころ", () => {
  it("policy はスナップショットの effective_policies[仕事の slug]（hash も）。counters は tasks・usage_records・action_intents から", async () => {
    const { db } = T();
    const { ws, conns, agent } = await supplierWorld(db);
    const taskId = await seedTask(db, ws, agent, "reorder", { status: "running", costUsd: "0.012345", stepsUsed: 3, deniedCount: 1, startedAt: new Date(T0.getTime() - 90_500) });
    // 今日（Asia/Tokyo）の費用：このタスク 0.01、同じエージェントの別のタスク 0.02、別のエージェント 0.04、昨日の分は数えない
    const other = await seedTask(db, ws, agent, "reorder", { status: "running" });
    const inbox = await seedAgent(db, ws, inboxDefinition());
    await fxUsage(db, ws, { taskId, costUsd: "0.010000", createdAt: T0 });
    await fxUsage(db, ws, { taskId: other, costUsd: "0.020000", createdAt: T0 });
    await fxUsage(db, ws, { agentId: inbox.agentId, costUsd: "0.040000", createdAt: T0 });
    await fxUsage(db, ws, { agentId: agent.agentId, costUsd: "0.300000", createdAt: new Date("2026-10-11T14:59:59.999Z") });
    const i = await inputsFor(db, ws, taskId, llmSubject);
    expect(i.policyHash).toBe(agent.jobs.reorder!.policyHash);
    expect(i.policy).toEqual(agent.jobs.reorder!.policy);
    expect(i.counters).toEqual({
      stepsUsed: 3,
      costUsd: 0.012345,
      dayCostUsd: 0.07,
      agentDayCostUsd: 0.03,
      elapsedSec: 90,
      deniedCount: 1,
      repeatKey: null,
      repeatCount: 0,
      intentsCount: 0,
      unknownOutcomeKeys: [],
    });
    expect(i.flags).toEqual({ killSwitchEngaged: false, taskStatus: "running" });
    expect(i.taint).toEqual({ tainted: false, sources: [] });
    void conns;
  });

  it("mcp_call の subject は DB のツールから ToolInfo を作る（effectiveArgRoles・connectorEnabled・toolHash）。無効のコネクタは connector_disabled", async () => {
    const { db } = T();
    const { ws, conns, agent } = await supplierWorld(db);
    const taskId = await seedTask(db, ws, agent, "reorder", { status: "running" });
    const subject: Subject = { kind: "tool_call", actionType: "mcp_call", action: "mcp.supplier.place_order", args: ORDER, paths: [] };
    const i = await inputsFor(db, ws, taskId, subject);
    expect(i.subject.tool).toEqual({
      classification: "write",
      status: "ok",
      connectorEnabled: true,
      argRoles: { "items[].quantity": "option", "items[].sku": "option", "items[].unit_price": "option", note: "content", supplier_id: "destination" },
      scope: null,
      toolHash: conns.supplier!.tools.place_order!.toolHash,
    });
    expect(i.mcp?.connector.id).toBe(conns.supplier!.id);
    await db.query("UPDATE connectors SET enabled = false WHERE id = $1", [conns.supplier!.id]);
    const j = await inputsFor(db, ws, taskId, subject);
    expect(decide(j.policy, j.subject, j.counters, j.flags, j.taint)).toMatchObject({ decision: "deny", reasonCode: "connector_disabled" });
    // 見つからないツールは tool なし（unknown_action）
    const k = await inputsFor(db, ws, taskId, { ...subject, action: "mcp.supplier.no_such" });
    expect(k.subject.tool).toBeUndefined();
    expect(decide(k.policy, k.subject, k.counters, k.flags, k.taint)).toMatchObject({ decision: "deny", reasonCode: "unknown_action" });
  });

  it("M-17 unknownOutcomeKeys は同じ仕事のタスクの unknown_outcome（別の仕事は混ぜない）。intentsCount はそのタスクの行数", async () => {
    const { db } = T();
    const { ws, conns, agent } = await supplierWorld(db);
    const taskId = await seedTask(db, ws, agent, "reorder", { status: "running" });
    const liveOther = await seedTask(db, ws, agent, "reorder", { status: "running" });
    const ins = (task: Uuid, key: string, status: string) =>
      db.query(
        `INSERT INTO action_intents (workspace_id, task_id, job_id, connector_id, action, origin, payload, tool_hash, destination_key, option_digest, status,
                                     decision, reason_code, policy_hash, intent_hash, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'mcp.supplier.place_order', 'agent', '{}', $5, $6, $6, $7, 'allow', 'rule_matched', $6, $6,
                 CASE WHEN $7 = 'pending_approval' THEN $8::timestamptz END, $8, $8)`,
        [ws.workspaceId, task, agent.jobs.reorder!.jobId, conns.supplier!.id, conns.supplier!.tools.place_order!.toolHash, key, status, T0],
      );
    const k1 = "1".repeat(64);
    const k2 = "2".repeat(64);
    await ins(liveOther, k1, "unknown_outcome");
    // 別の仕事（受信箱係）のタスクの unknown_outcome は数えない
    const inbox = await seedAgent(db, ws, inboxDefinition());
    const otherJobTask = await seedTask(db, ws, inbox, "read-supplier-mail", { status: "running" });
    await db.query(
      `INSERT INTO action_intents (workspace_id, task_id, job_id, connector_id, action, origin, payload, tool_hash, destination_key, option_digest, status,
                                   decision, reason_code, policy_hash, intent_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'mcp.supplier.place_order', 'agent', '{}', $5, $6, $6, 'unknown_outcome', 'allow', 'rule_matched', $6, $6, $7, $7)`,
      [ws.workspaceId, otherJobTask, inbox.jobs["read-supplier-mail"]!.jobId, conns.supplier!.id, conns.supplier!.tools.place_order!.toolHash, k2, T0],
    );
    await ins(taskId, "3".repeat(64), "pending_approval");
    await ins(taskId, "4".repeat(64), "denied");
    const live = await inputsFor(db, ws, taskId, llmSubject);
    expect(live.counters.unknownOutcomeKeys).toEqual([k1]);
    expect(live.counters.intentsCount).toBe(2);
  });

});

describe("checkSpend（SO §3.12：呼ぶ前、spent + est > limit）", () => {
  it("全体の上限。ちょうどは通す", async () => {
    const { db } = T();
    const { ws, agent } = await supplierWorld(db);
    await fxUsage(db, ws, { agentId: agent.agentId, costUsd: "3.900000", createdAt: T0 });
    const target = { workspaceId: ws.workspaceId, workspaceKind: "owner" as const };
    const limits = { platformDayMicroUsd: 4_000_000 };
    expect(await checkSpend(db, target, 100_000, T0, limits)).toEqual({ ok: true });
    expect(await checkSpend(db, target, 100_001, T0, limits)).toEqual({ ok: false, scope: "global", limitMicroUsd: 4_000_000, spentMicroUsd: 3_900_000, estimatedMicroUsd: 100_001 });
    // 既定の上限（$15）なら通す
    expect(await checkSpend(db, target, 100_001, T0)).toEqual({ ok: true });
  });
});

describe("canStartWork（SO §3.12：始める前、spent ≥ limit。見積もりなし：M-38）", () => {
  it("Kill Switch → kill_switch、本番の running が max_concurrent_tasks 以上 → concurrency", async () => {
    const { db } = T();
    const { ws, agent } = await supplierWorld(db);
    const row = async () => (await db.query<{ id: Uuid; kind: "owner"; kill_switch_engaged: boolean; max_concurrent_tasks: number }>("SELECT id, kind, kill_switch_engaged, max_concurrent_tasks FROM workspaces WHERE id = $1", [ws.workspaceId])).rows[0]!;
    expect(await canStartWork(db, await row(), T0)).toEqual({ ok: true });
    await seedTask(db, ws, agent, "reorder", { status: "running" });
    expect(await canStartWork(db, await row(), T0)).toEqual({ ok: true });
    await seedTask(db, ws, agent, "reorder", { status: "running" });
    expect(await canStartWork(db, await row(), T0)).toEqual({ ok: true });
    await seedTask(db, ws, agent, "reorder", { status: "running" });
    expect(await canStartWork(db, await row(), T0)).toEqual({ ok: false, reason: "concurrency" });
    await db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2 WHERE id = $1", [ws.workspaceId, T0]);
    expect(await canStartWork(db, await row(), T0)).toEqual({ ok: false, reason: "kill_switch" });
  });

  it("全体の今日の費用 = 上限ちょうどで始めない（≥）。1マイクロドル下なら始める", async () => {
    const { db } = T();
    const { ws, agent } = await supplierWorld(db);
    const wsRow = { id: ws.workspaceId, kind: "owner" as const, kill_switch_engaged: false, max_concurrent_tasks: 3 };
    const limits = { platformDayMicroUsd: 4_000_000 };
    await fxUsage(db, ws, { agentId: agent.agentId, costUsd: "3.999999", createdAt: T0 });
    expect(await canStartWork(db, wsRow, T0, limits)).toEqual({ ok: true });
    await fxUsage(db, ws, { agentId: agent.agentId, costUsd: "0.000001", createdAt: T0 });
    expect(await canStartWork(db, wsRow, T0, limits)).toEqual({ ok: false, reason: "global" });
  });
});

describe("callGemini（タスクの外：設定プランナー・状況の生成。M-19）", () => {
  function deps(db: Db, llm: ScriptedLlmClient) {
    return { db, llm, clock: manualClock(T0), log: silentLogger, retry: { sleep: async () => {} } };
  }
  const req: LlmRequest = { model: DEFAULT_AGENT_MODEL, system: "s", messages: [{ role: "user", content: "編成案を作って" }], tools: [], mcpTools: [], maxTokens: 500 };

  it("usage_records に持ち主（agent・ask）と phase で費用を残す", async () => {
    const { db } = T();
    const { ws, agent } = await supplierWorld(db);
    const llm = new ScriptedLlmClient([{ parts: [{ type: "text", text: "{}" }], usage: USAGE }]);
    const out = await callGemini(deps(db, llm), { workspaceId: ws.workspaceId, workspaceKind: "owner", taskId: null, agentId: agent.agentId, askId: null, purpose: "planner", phase: "planner" }, req);
    expect(out.usage.costMicroUsd).toBe(2250);
    expect(out.usage.estimatedMicroUsd).toBe(estimateCallMicroUsd(req));
    const u = (await db.query<{ agent_id: Uuid; task_id: Uuid | null; phase: string; cost_usd: string }>("SELECT agent_id, task_id, phase, cost_usd FROM usage_records WHERE workspace_id = $1", [ws.workspaceId])).rows;
    expect(u).toEqual([{ agent_id: agent.agentId, task_id: null, phase: "planner", cost_usd: "0.002250" }]);
  });

  it("予算を超えるなら呼ばない：GeminiCallError(budget)。toAppError は 429 DAILY_BUDGET_EXCEEDED（scope・Retry-After）", async () => {
    const { db } = T();
    const { ws, agent } = await supplierWorld(db);
    await fxUsage(db, ws, { agentId: agent.agentId, costUsd: "15.000000", createdAt: T0 });
    const llm = new ScriptedLlmClient([]);
    const e = await callGemini(deps(db, llm), { workspaceId: ws.workspaceId, workspaceKind: "owner", taskId: null, agentId: agent.agentId, askId: null, purpose: "planner", phase: "planner" }, req).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(GeminiCallError);
    expect((e as GeminiCallError).kind).toBe("budget");
    const app = (e as GeminiCallError).toAppError(T0);
    expect(app.code).toBe("DAILY_BUDGET_EXCEEDED");
    expect(app.details).toEqual({ scope: "global" });
    // 2026-10-12 18:00 JST → 翌日 0:00 まで 6時間
    expect(app.headers).toEqual({ "Retry-After": String(6 * 3600) });
    expect(llm.requests).toHaveLength(0);
  });

  it("やり直すたびに llm.retry を出し、llm.called に attempts と latencyMs を出す（504 の待ちが空白に見えないように）", async () => {
    const { db } = T();
    const { ws, agent } = await supplierWorld(db);
    let n = 0;
    const llm = new ScriptedLlmClient(() => {
      n += 1;
      if (n === 1) throw new LlmError("deadline exceeded", 504, true);
      return { parts: [{ type: "text", text: "{}" }], usage: USAGE };
    });
    const mem = memoryLogger();
    await callGemini({ ...deps(db, llm), log: mem.logger }, { workspaceId: ws.workspaceId, workspaceKind: "owner", taskId: null, agentId: agent.agentId, askId: null, purpose: "planner", phase: "planner" }, req);
    const retry = mem.records.find((r) => r.event === "llm.retry");
    expect(retry).toMatchObject({ retry: 1, status: 504, purpose: "planner" });
    expect(mem.records.find((r) => r.event === "llm.called")).toMatchObject({ attempts: 2, latencyMs: expect.any(Number) });
  });

  it("Kill Switch 中は呼ばない（423 KILL_SWITCH_ENGAGED）。持ち主がなければ例外。LLM の失敗は GeminiCallError(llm)", async () => {
    const { db } = T();
    const { ws, agent } = await supplierWorld(db);
    const ctx = { workspaceId: ws.workspaceId, workspaceKind: "owner" as const, taskId: null, agentId: agent.agentId, askId: null, purpose: "planner" as const, phase: "planner" as const };
    await expect(callGemini(deps(db, new ScriptedLlmClient([])), { ...ctx, agentId: null }, req)).rejects.toThrow(/持ち主/);
    const failing = new ScriptedLlmClient(() => {
      throw new LlmError("bad request", 400, false);
    });
    const e = await callGemini(deps(db, failing), ctx, req).then(
      () => null,
      (x: unknown) => x,
    );
    expect((e as GeminiCallError).kind).toBe("llm");
    expect(failing.requests).toHaveLength(1);
    await db.query("UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2 WHERE id = $1", [ws.workspaceId, T0]);
    const k = await callGemini(deps(db, new ScriptedLlmClient([])), ctx, req).then(
      () => null,
      (x: unknown) => x,
    );
    expect((k as GeminiCallError).toAppError(T0).code).toBe("KILL_SWITCH_ENGAGED");
  });
});

describe("issueTaskToken・resolveTaskByToken（SO §3.10）", () => {
  it("生の値を返し DB にはハッシュだけ。期限は max_minutes（15）＋5分。終了状態のタスクには付けない", async () => {
    const { db } = T();
    const { ws, agent } = await supplierWorld(db);
    const taskId = await seedTask(db, ws, agent, "reorder");
    const token = await tokenFor(db, ws, taskId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = (await db.query<{ task_token_hash: Buffer; task_token_expires_at: Date }>("SELECT task_token_hash, task_token_expires_at FROM tasks WHERE id = $1", [taskId])).rows[0]!;
    expect(row.task_token_hash.toString("utf8")).not.toContain(token);
    expect(row.task_token_expires_at.getTime()).toBe(T0.getTime() + 20 * 60_000);
    const r = await resolveTaskByToken(db, token, T0, { allow: ["queued"] });
    expect(r.task.id).toBe(taskId);
    expect(r.ctx).toEqual({ workspaceId: ws.workspaceId, kind: "owner", userId: null });
    await db.query("UPDATE tasks SET status = 'cancelled', finished_at = $2 WHERE id = $1", [taskId, T0]);
    await expect(db.transaction((tx) => issueTaskToken(tx, ws.ctx, taskId, T0))).rejects.toThrow(/トークン/);
  });
});

void (null as unknown as SeededAgent);
