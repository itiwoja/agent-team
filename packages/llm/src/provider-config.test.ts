import { describe, expect, it } from "vitest";
import { compatibleBaseUrl, readLlmEnv } from "./provider-config.ts";
import { readGeminiEnv } from "./models.ts";

import { PROFILE } from "./__fixtures__/provider.ts";
describe("provider configuration", () => {
  it("preserves legacy Gemini defaults and overrides", () => {
    const env = { GEMINI_API_KEY: "test-not-a-key", GEMINI_MODEL_AGENT: "gemini-2.5-flash" };
    expect(readLlmEnv(env)).toMatchObject({ ...readGeminiEnv(env), provider: "gemini" });
    expect(readLlmEnv({ ...env, LLM_MODEL_AGENT: "gemini-2.5-pro" }).agentModel).toBe("gemini-2.5-pro");
  });
  it.each(["anthropic", "openai", "openai-compatible"])("selects %s without borrowing another provider's key", provider => {
    const config = readLlmEnv({ LLM_PROVIDER: provider, LLM_MODEL_AGENT: "test-model", LLM_MODELS_JSON: JSON.stringify({ "test-model": PROFILE }), OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:9000/v1", GEMINI_API_KEY: "should-not-be-used" });
    expect(config.apiKey).toBeUndefined();
    expect(config.plannerModel).toBe("test-model");
  });
  it.each([undefined, "{}", "{bad-secret-value", JSON.stringify({ m: { ...PROFILE, inputPerMTokMicroUsd: 0 } })])("rejects missing/invalid prices without echoing configuration", json => {
    expect(() => readLlmEnv({ LLM_PROVIDER: "openai", LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: json })).toThrow(/LLM_MODELS_JSON/);
    try { readLlmEnv({ LLM_PROVIDER: "openai", LLM_MODEL_AGENT: "m", LLM_MODELS_JSON: json }); } catch (e) { expect(String(e)).not.toContain("bad-secret-value"); }
  });
  it("uses exact provider model IDs, checks planner and comparison profiles", () => {
    const env = { LLM_PROVIDER: "openai", LLM_MODEL_AGENT: "vendor/m", LLM_MODELS_JSON: JSON.stringify({ "vendor/m": PROFILE }) };
    expect(readLlmEnv(env).agentModel).toBe("vendor/m");
    expect(() => readLlmEnv({ ...env, LLM_MODEL_PLANNER: "m" })).toThrow(/登録/);
    expect(() => readLlmEnv({ ...env, LLM_MODELS_COMPARE: "unknown" })).toThrow(/登録/);
    expect(() => readLlmEnv({ LLM_PROVIDER: "typo" })).toThrow(/未対応/);
  });
  it.each(["http://remote.test/v1", "https://user:secret@remote.test/v1", "https://remote.test/v1?key=secret", "file:///tmp/a", "https://remote.test/#fragment"])("rejects unsafe endpoint %s", url => {
    expect(() => compatibleBaseUrl(url)).toThrow(/BASE_URL/);
  });
  it("accepts HTTPS and loopback HTTP without rewriting the path", () => {
    expect(compatibleBaseUrl("https://service.test/api/v1/")).toBe("https://service.test/api/v1");
    expect(compatibleBaseUrl("http://[::1]:8080/v1")).toBe("http://[::1]:8080/v1");
  });
});
