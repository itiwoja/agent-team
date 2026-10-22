import { describe, expect, it } from "vitest";
import { PROVIDER_BASE_URLS, readLlmEnv } from "./provider-config.ts";
import { readGeminiEnv } from "./models.ts";

import { PROFILE } from "./__fixtures__/provider.ts";
describe("provider configuration", () => {
  it("preserves legacy Gemini defaults and overrides", () => {
    const env = { GEMINI_API_KEY: "test-not-a-key", GEMINI_MODEL_AGENT: "gemini-2.5-flash" };
    expect(readLlmEnv(env)).toMatchObject({ ...readGeminiEnv(env), provider: "gemini" });
    expect(readLlmEnv({ ...env, LLM_MODEL_AGENT: "gemini-2.5-pro" }).agentModel).toBe("gemini-2.5-pro");
  });
  it.each([
    ["anthropic", "ANTHROPIC_API_KEY", "test-anthropic-key"],
    ["deepseek", "DEEPSEEK_API_KEY", "test-deepseek-key"],
    ["openrouter", "OPENROUTER_API_KEY", "test-openrouter-key"],
  ] as const)("selects %s with its own key only", (provider, keyName, key) => {
    const config = readLlmEnv({ LLM_PROVIDER: provider, LLM_MODEL_AGENT: "test-model", LLM_MODELS_JSON: JSON.stringify({ "test-model": PROFILE }), [keyName]: key, GEMINI_API_KEY: "should-not-be-used" });
    expect(config.apiKey).toBe(key);
    expect(config.plannerModel).toBe("test-model");
    expect(config.baseUrl).toBe(PROVIDER_BASE_URLS[provider]);
  });
  it("fixes the endpoint of DeepSeek and OpenRouter; Claude has none in config", () => {
    expect(PROVIDER_BASE_URLS).toEqual({ deepseek: "https://api.deepseek.com", openrouter: "https://openrouter.ai/api/v1" });
    expect(readLlmEnv({ LLM_PROVIDER: "anthropic", LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: JSON.stringify({ m: PROFILE }) }).baseUrl).toBeUndefined();
  });
  it.each(["openai", "openai-compatible", "typo"])("rejects the removed or unknown provider %s", provider => {
    expect(() => readLlmEnv({ LLM_PROVIDER: provider })).toThrow(/未対応/);
  });
  it.each([undefined, "{}", "{bad-secret-value", JSON.stringify({ m: { ...PROFILE, inputPerMTokMicroUsd: 0 } })])("rejects missing/invalid prices without echoing configuration", json => {
    expect(() => readLlmEnv({ LLM_PROVIDER: "deepseek", LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: json })).toThrow(/LLM_MODELS_JSON/);
    try { readLlmEnv({ LLM_PROVIDER: "deepseek", LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: json }); } catch (e) { expect(String(e)).not.toContain("bad-secret-value"); }
  });
  it("uses exact provider model IDs, checks planner and comparison profiles", () => {
    const env = { LLM_PROVIDER: "openrouter", LLM_MODEL_AGENT: "vendor/m", LLM_MODELS_JSON: JSON.stringify({ "vendor/m": PROFILE }) };
    expect(readLlmEnv(env).agentModel).toBe("vendor/m");
    expect(() => readLlmEnv({ ...env, LLM_MODEL_PLANNER: "m" })).toThrow(/登録/);
    expect(() => readLlmEnv({ ...env, LLM_MODELS_COMPARE: "unknown" })).toThrow(/登録/);
    expect(() => readLlmEnv({ LLM_PROVIDER: "typo" })).toThrow(/未対応/);
  });
});
