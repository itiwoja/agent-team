import { describe, expect, it } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDERS, PROVIDER_BASE_URLS, readLlmEnv } from "./provider-config.ts";
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
    ["openai", "OPENAI_API_KEY", "test-openai-key"],
    ["xai", "XAI_API_KEY", "test-xai-key"],
    ["groq", "GROQ_API_KEY", "test-groq-key"],
    ["mistral", "MISTRAL_API_KEY", "test-mistral-key"],
    ["together", "TOGETHER_API_KEY", "test-together-key"],
    ["fireworks", "FIREWORKS_API_KEY", "test-fireworks-key"],
    ["cerebras", "CEREBRAS_API_KEY", "test-cerebras-key"],
    ["moonshot", "MOONSHOT_API_KEY", "test-moonshot-key"],
    ["zai", "ZAI_API_KEY", "test-zai-key"],
    ["qwen", "DASHSCOPE_API_KEY", "test-dashscope-key"],
  ] as const)("selects %s with its own key only", (provider, keyName, key) => {
    const config = readLlmEnv({ LLM_PROVIDER: provider, LLM_MODEL_AGENT: "test-model", LLM_MODELS_JSON: JSON.stringify({ "test-model": PROFILE }), [keyName]: key, GEMINI_API_KEY: "should-not-be-used" });
    expect(config.apiKey).toBe(key);
    expect(config.plannerModel).toBe("test-model");
    expect(config.baseUrl).toBe(PROVIDER_BASE_URLS[provider]);
  });
  it("fixes every named OpenAI-compatible endpoint to https; Claude has none in config", () => {
    for (const provider of OPENAI_COMPATIBLE_PROVIDERS) expect(PROVIDER_BASE_URLS[provider]).toMatch(/^https:\/\/[^/]+/);
    expect(readLlmEnv({ LLM_PROVIDER: "anthropic", LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: JSON.stringify({ m: PROFILE }) }).baseUrl).toBeUndefined();
    // 名前のある提供元では LLM_BASE_URL を無視する（鍵の送り先は変えられない）
    expect(readLlmEnv({ LLM_PROVIDER: "openai", LLM_BASE_URL: "https://evil.example/v1", LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: JSON.stringify({ m: PROFILE }) }).baseUrl).toBe("https://api.openai.com/v1");
  });
  it.each([
    ["https://api.example.com/v1/", "https://api.example.com/v1"],
    ["http://localhost:11434/v1", "http://localhost:11434/v1"],
    ["http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1"],
  ])("custom uses LLM_API_KEY and the checked LLM_BASE_URL %s", (url, expected) => {
    const config = readLlmEnv({ LLM_PROVIDER: "custom", LLM_BASE_URL: url, LLM_API_KEY: "test-custom-key", LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: JSON.stringify({ m: PROFILE }) });
    expect(config).toMatchObject({ provider: "custom", apiKey: "test-custom-key", baseUrl: expected });
  });
  it.each([undefined, "not a url", "http://api.example.com/v1", "ftp://localhost/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?key=secret-value", "https://api.example.com/v1#x"])("custom rejects the unsafe base URL %s without echoing it", url => {
    const env = { LLM_PROVIDER: "custom", LLM_BASE_URL: url, LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: JSON.stringify({ m: PROFILE }) };
    expect(() => readLlmEnv(env)).toThrow(/LLM_BASE_URL/);
    try { readLlmEnv(env); } catch (e) { expect(String(e)).not.toContain("secret-value"); expect(String(e)).not.toContain("pass"); }
  });
  it.each(["openai-compatible", "typo"])("rejects the removed or unknown provider %s", provider => {
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
