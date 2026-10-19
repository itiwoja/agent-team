import { describe, expect, it, vi } from "vitest";
import { useTestDb } from "@open-team/db/testing";
import { HttpProviderClient, type LlmConfig } from "@open-team/llm";
import { buildEdge, llmRequest } from "./__fixtures__/env.ts";
import { fxWorkspace, seedAgent, seedShopConnectors, seedTask, supplierDefinition, tokenFor } from "./__fixtures__/shop.ts";

const T = useTestDb();
const model = "test-provider-model";
const profile = { inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 10_000_000, tools: true, structuredOutput: "tool" as const, temperature: true, reasoningEffort: false, maxOutputTokens: 8192, contextWindow: 200_000, tokenLimitParameter: "max_completion_tokens" as const };
async function world(provider: "anthropic" | "openai" | "openai-compatible", options: { haiku55?: boolean; costUsd?: string; tools?: boolean; malformed?: boolean; networkFailure?: boolean; retryDelays?: number[] } = {}) {
  const selectedModel = options.haiku55 ? "claude-haiku-5-5" : model;
  const { db } = T();
  const ws = await fxWorkspace(db, { kind: "guest", audit: true });
  await seedShopConnectors(db, ws);
  const agent = await seedAgent(db, ws, supplierDefinition());
  const taskId = await seedTask(db, ws, agent, "reorder", { ...(options.costUsd ? { costUsd: options.costUsd } : {}) });
  const token = await tokenFor(db, ws, taskId);
  const order = { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 20, unit_price: 1800 }] };
  const body = provider === "anthropic"
    ? { content: [{ type: "tool_use", id: "call_order", name: "mcp__supplier__place_order", input: order }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 30 } }
    : { choices: [{ message: { tool_calls: [{ id: "call_order", type: "function", function: { name: "mcp__supplier__place_order", arguments: JSON.stringify(order) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 30 } };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    if (options.networkFailure) throw new Error("network unavailable");
    return new Response(JSON.stringify(options.malformed ? {} : body));
  });
  const cfg: LlmConfig = { provider, apiKey: "test-only-never-real", agentModel: selectedModel, plannerModel: selectedModel, compareModels: [], profiles: { [selectedModel]: { ...profile, tools: options.tools ?? true, ...(options.haiku55 ? { temperature: false, anthropicMode: "haiku55-no-thinking" as const, inputPerMTokMicroUsd: 500000, outputPerMTokMicroUsd: 2500000 } : {}) } }, ...(provider === "openai-compatible" ? { baseUrl: "http://127.0.0.1:9999/v1" } : {}) };
  const llm = new HttpProviderClient(cfg, { fetch: fetcher });
  const env = buildEdge(db, { extra: { llm, models: { agentModel: selectedModel, plannerModel: selectedModel }, retry: { delaysMs: options.retryDelays ?? [], sleep: async () => {} } } });
  const ctx = await env.edge.getTaskContext(token);
  return { db, ws, taskId, token, env, fetcher, ctx, llm };
}
describe("provider adapters through the existing budget and approval Kernel", () => {
  it("Haiku 5.5 retains approval and records conservative long-prompt pricing", async () => {
    const w = await world("anthropic", { haiku55: true });
    const result = await w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools));
    expect(result.model).toBe("claude-haiku-5-5");
    expect(result.usage.costUsd).toBe("0.000125");
    expect(result.governance[0]).toMatchObject({ decision: "approve", reasonCode: "approval_required" });
    expect(w.env.gateway.calls).toEqual([]);
    expect(JSON.parse(w.fetcher.mock.calls[0]![1]!.body as string).thinking).toEqual({ type: "disabled" });
  });
  it("checks the cost of all allowed retry attempts before sending the first request", async () => {
    const w = await world("openai", { costUsd: "0.185000", retryDelays: [0] });
    vi.spyOn(w.llm, "estimateMicroUsd").mockReturnValue(10_000);
    await expect(w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools))).rejects.toMatchObject({ code: "TASK_HALTED" });
    expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("records every uncertain retry, not just the final failure", async () => {
    const w = await world("openai", { networkFailure: true, retryDelays: [0] });
    vi.spyOn(w.llm, "estimateMicroUsd").mockReturnValue(10_000);
    await expect(w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools))).rejects.toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
    expect(w.fetcher).toHaveBeenCalledTimes(2);
    expect((await w.db.query<{ cost: string }>("SELECT cost_usd::text AS cost FROM usage_records WHERE task_id=$1", [w.taskId])).rows[0]!.cost).toBe("0.020000");
  });
  it.each(["anthropic", "openai", "openai-compatible"] as const)("%s writes require approval and usage is recorded", async provider => {
    const w = await world(provider);
    const result = await w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools));
    expect(result.model).toBe(model);
    expect(result.usage.costUsd).toBe("0.000500");
    expect(result.governance).toEqual([expect.objectContaining({ decision: "approve", reasonCode: "approval_required", intent: expect.objectContaining({ status: "pending_approval" }) })]);
    expect(w.env.gateway.calls).toEqual([]);
    const usage = (await w.db.query<{ model: string; cost: string }>("SELECT model, cost_usd::text AS cost FROM usage_records WHERE task_id=$1", [w.taskId])).rows;
    expect(usage).toEqual([expect.objectContaining({ model, cost: "0.000500" })]);
  });
  it.each(["anthropic", "openai", "openai-compatible"] as const)("%s is stopped by the existing per-task budget before HTTP", async provider => {
    const w = await world(provider, { costUsd: "0.199999" });
    await expect(w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools))).rejects.toMatchObject({ code: "TASK_HALTED", details: expect.objectContaining({ haltReason: "budget_exceeded" }) });
    expect(w.fetcher).not.toHaveBeenCalled();
  });
  it("unsupported model capabilities fail before HTTP and terminate the task clearly", async () => {
    const w = await world("openai", { tools: false });
    await expect(w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools))).rejects.toMatchObject({ code: "LLM_UPSTREAM_ERROR", details: expect.objectContaining({ reason: "incompatible_model" }) });
    expect(w.fetcher).not.toHaveBeenCalled();
    expect((await w.db.query<{ status: string }>("SELECT status FROM tasks WHERE id=$1", [w.taskId])).rows[0]!.status).toBe("failed");
  });
  it.each([{ malformed: true }, { networkFailure: true }])("unknown usage is charged conservatively rather than zero: %j", async options => {
    const w = await world("anthropic", options);
    await expect(w.env.edge.llmMessages(w.token, llmRequest(w.ctx.tools))).rejects.toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
    const row = (await w.db.query<{ cost: string }>("SELECT cost_usd::text AS cost FROM usage_records WHERE task_id=$1", [w.taskId])).rows[0]!;
    expect(Number(row.cost)).toBeGreaterThan(0);
  });
});
