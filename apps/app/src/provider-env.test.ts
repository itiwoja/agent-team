import { expect, it, vi } from "vitest";
import { readAppEnv } from "./env.ts";
import { createAppDeps } from "./deps.ts";
import { HttpProviderClient } from "@open-team/llm";
import { planFormation } from "./asks/planner.ts";

it("uses the selected provider's models in every existing routing path, without a Gemini key", () => {
  const profile = { inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 10_000_000, tools: true, structuredOutput: "tool", temperature: true, maxOutputTokens: 8192, contextWindow: 200000 };
  const { env, missing } = readAppEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "fake-test-only", LLM_MODEL_AGENT: "test-agent", LLM_MODEL_PLANNER: "test-planner", LLM_MODELS_JSON: JSON.stringify({ "test-agent": profile, "test-planner": profile }) });
  expect(env.gemini.agentModel).toBe("test-agent");
  expect(env.gemini.plannerModel).toBe("test-planner");
  expect(env.llm?.provider).toBe("anthropic");
  expect(createAppDeps(env, missing).llm).toBeInstanceOf(HttpProviderClient);
  const noKey = { ...env, llm: { ...env.llm!, apiKey: undefined } };
  const unavailable = createAppDeps(noKey, missing).llm;
  expect(unavailable.priceFor?.("test-agent")).not.toBeNull();
  expect(() => unavailable.preflight?.({ model: "test-agent", system: "", messages: [], tools: [], mcpTools: [], maxTokens: 1 })).toThrow(/ANTHROPIC_API_KEY/);
});

it.each(["anthropic", "deepseek", "openrouter"] as const)("%s composes the same chain through the existing planner and handoff rules", async provider => {
  const draft = { formation: { shape: "chain", members: ["文章", "デザイン", "実装", "チェック"].map(name => ({ newName: `${name}担当`, role: "assist", summary: name, template: "assistant", instructions: `${name}を担当し、結果を次へ渡す`, grants: [] })) } };
  const body = provider === "anthropic" ? { content: [{ type: "tool_use", id: "result", name: "makase_structured_output", input: draft }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 100 } } : { choices: [{ message: { tool_calls: [{ id: "result", type: "function", function: { name: "makase_structured_output", arguments: JSON.stringify(draft) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 100 } };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(body)));
  const llm = new HttpProviderClient({ provider, apiKey: "fake-test-only", agentModel: "m", plannerModel: "m", compareModels: [], profiles: { m: { inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 10_000_000, tools: true, structuredOutput: "tool", temperature: true, reasoningEffort: false, maxOutputTokens: 8192, contextWindow: 200000, tokenLimitParameter: "max_completion_tokens" } } }, { fetch: fetcher });
  const result = await planFormation({ text: "架空の告知ページを4担当で制作", mention: null, pack: null, agents: [], connectors: [], policyLines: [], answered: null }, { llm, model: "m" });
  expect(result.kind).toBe("formation");
  if (result.kind !== "formation") throw new Error("Expected formation");
  expect(result.formation.members.map(m => m.proposed.dependsOn)).toEqual([[], [1], [2], [3]]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
