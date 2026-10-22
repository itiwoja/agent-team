import { describe, expect, it, vi } from "vitest";
import { HttpProviderClient, createLlmClient } from "./http-provider.ts";
import { readLlmEnv, type LlmConfig, type LlmProvider } from "./provider-config.ts";
import { LlmError, type LlmRequest } from "./types.ts";
import { GeminiClient } from "./gemini.ts";
import { withRetry } from "./retry.ts";
import { PROFILE } from "./__fixtures__/provider.ts";

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({ model: "test-model", system: "System", messages: [{ role: "user", content: "Make a fictional page" }], tools: [], mcpTools: [], maxTokens: 1024, ...over });
const config = (provider: LlmProvider = "deepseek"): LlmConfig => ({ provider, apiKey: "test-secret-never-real", agentModel: "test-model", plannerModel: "test-model", compareModels: [], profiles: { "test-model": { ...PROFILE } } });
const openai = (message: unknown = { content: "done" }, reason = "stop") => ({ choices: [{ message, finish_reason: reason }], usage: { prompt_tokens: 100, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 10 } } });
const claude = (content: unknown = [{ type: "text", text: "done" }], reason = "end_turn") => ({ content, stop_reason: reason, usage: { input_tokens: 100, output_tokens: 30 } });
const transport = (body: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }));
const sent = (f: ReturnType<typeof transport>): Record<string, any> => JSON.parse(f.mock.calls[0]![1]!.body as string);
const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false };

describe("Haiku 5.5 explicit compatibility mode", () => {
  const model = "claude-haiku-5-5";
  const cfg = (): LlmConfig => ({ ...config("anthropic"), agentModel: model, plannerModel: model, profiles: { [model]: { ...PROFILE, inputPerMTokMicroUsd: 500000, outputPerMTokMicroUsd: 2500000, temperature: false, anthropicMode: "haiku55-no-thinking", reasoningEffort: false, contextWindow: 1000000, maxOutputTokens: 128000 } } });
  it.each([0.2, 0.7])("omits application temperature %s and disables default thinking", async temperature => {
    const f = transport(claude());
    await new HttpProviderClient(cfg(), { fetch: f }).generate(req({ model, temperature, thinkingLevel: "low" }));
    expect(sent(f)).toMatchObject({ model, thinking: { type: "disabled" }, output_config: { effort: "low" } });
    for (const k of ["temperature", "top_p", "top_k"]) expect(sent(f)).not.toHaveProperty(k);
  });
  it("keeps forced structured output separate from business actions", async () => {
    const f = transport(claude([{ type: "tool_use", id: "out1", name: "makase_structured_output", input: { title: "fiction" } }], "tool_use"));
    const out = await new HttpProviderClient(cfg(), { fetch: f }).generate(req({ model, responseJsonSchema: schema }));
    expect(out.parts).toEqual([{ type: "text", text: '{"title":"fiction"}' }]);
    expect(sent(f).tool_choice.name).toBe("makase_structured_output");
    expect(sent(f).output_config.effort).toBe("medium");
  });
  it("retains native JSON schema when adding effort", async () => {
    const c = cfg(); c.profiles[model]!.structuredOutput = "json_schema";
    const f = transport(claude([{ type: "text", text: '{"title":"fiction"}' }]));
    await new HttpProviderClient(c, { fetch: f }).generate(req({ model, responseJsonSchema: schema }));
    expect(sent(f).output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema } });
  });
  it("preserves business call IDs and tool results across turns", async () => {
    const f = transport(claude([{ type: "tool_use", id: "haiku_call", name: "read_file", input: { path: "draft.html" } }], "tool_use"));
    const c = new HttpProviderClient(cfg(), { fetch: f });
    const first = await c.generate(req({ model, tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }] }));
    f.mockResolvedValueOnce(new Response(JSON.stringify(claude())));
    await c.generate(req({ model, messages: [{ role: "user", content: "review" }, { role: "assistant", content: first.parts }, { role: "tool", content: { toolCallId: "haiku_call", name: "read_file", result: "fictional HTML" } }] }));
    const second = JSON.parse(f.mock.calls[1]![1]!.body as string);
    expect(second.messages[1].content[0].id).toBe("haiku_call");
    expect(second.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "haiku_call", content: "fictional HTML" });
  });
  it.each(["refusal", "model_context_window_exceeded"])("never executes calls on %s", async reason => {
    const f = transport(claude([{ type: "tool_use", id: "unsafe", name: "write_file", input: {} }], reason));
    const out = await new HttpProviderClient(cfg(), { fetch: f }).generate(req({ model }));
    expect(out.parts).toEqual([]);
    expect(out.stopReason).toBe(reason === "refusal" ? "refusal" : "max_tokens");
  });
  it.each([100000, 100001])("uses conservative long-prompt prices at %s input tokens", async n => {
    const f = transport({ ...claude(), usage: { input_tokens: n, output_tokens: 100 } });
    const out = await new HttpProviderClient(cfg(), { fetch: f }).generate(req({ model }));
    expect(out.usage.costMicroUsd).toBe(Math.ceil(n * 0.5 + 250));
  });
  it("fails before transport on prefill, high thinking, missing mode or underpriced profile", async () => {
    const f = transport(claude()); const c = new HttpProviderClient(cfg(), { fetch: f });
    await expect(c.generate(req({ model, thinkingLevel: "high" }))).rejects.toThrow(/思考/);
    await expect(c.generate(req({ model, messages: [{ role: "assistant", content: [{ type: "text", text: "prefix" }] }] }))).rejects.toThrow(/prefill/);
    const missing = cfg(); delete missing.profiles[model]!.anthropicMode;
    await expect(new HttpProviderClient(missing, { fetch: f }).generate(req({ model }))).rejects.toThrow(/anthropicMode/);
    const cheap = cfg(); cheap.profiles[model]!.inputPerMTokMicroUsd = 100000;
    await expect(new HttpProviderClient(cheap, { fetch: f }).generate(req({ model }))).rejects.toThrow(/単価/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("provider contracts (no real API)", () => {
  it("validates programmatic profiles too, preventing zero-price bypass", () => {
    const cfg = config(); cfg.profiles["test-model"]!.inputPerMTokMicroUsd = 0;
    expect(() => new HttpProviderClient(cfg)).toThrow(/料金/);
  });
  it("sends max_tokens only for the OpenAI-compatible providers; max_completion_tokens when explicitly configured", async () => {
    // 未指定のプロファイル（既定値に任せる）。コンストラクターが ModelProfileSchema で既定値を入れる
    const { tokenLimitParameter: _explicit, ...bare } = PROFILE;
    const cfg = { ...config("openrouter"), profiles: { "test-model": bare } } as unknown as LlmConfig;
    const f = transport(openai());
    await new HttpProviderClient(cfg, { fetch: f }).generate(req());
    expect(sent(f).max_tokens).toBe(1024);
    expect(sent(f).max_completion_tokens).toBeUndefined();
    cfg.profiles["test-model"]!.tokenLimitParameter = "max_completion_tokens";
    f.mockResolvedValueOnce(new Response(JSON.stringify(openai())));
    await new HttpProviderClient(cfg, { fetch: f }).generate(req());
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string).max_completion_tokens).toBe(1024);
  });
  it("rejects unexpected extended-thinking continuation instead of silently losing signatures", async () => {
    await expect(new HttpProviderClient(config("anthropic"), { fetch: transport(claude([{ type: "thinking", thinking: "private", signature: "opaque" }])) }).generate(req())).rejects.toThrow(/拡張思考/);
  });
  it("times out a hanging transport and supports cancellation in flight", async () => {
    const f = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("raw secret")), { once: true });
    }));
    await expect(new HttpProviderClient(config(), { fetch: f, timeoutMs: 5 }).generate(req())).rejects.toMatchObject({ retryable: true, message: "LLM API がタイムアウトしました" });
    const controller = new AbortController();
    const pending = new HttpProviderClient(config(), { fetch: f }).generate(req(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ retryable: false, message: "LLM の呼び出しを中断しました" });
  });
  it("keeps Gemini as the default implementation", () => expect(createLlmClient(readLlmEnv({ GEMINI_API_KEY: "fake" }))).toBeInstanceOf(GeminiClient));
  it.each(["deepseek", "openrouter", "anthropic"] as const)("%s uses the selected endpoint and headers; one attempt only", async provider => {
    const f = transport(provider === "anthropic" ? claude() : openai());
    const c = new HttpProviderClient(config(provider), { fetch: f });
    const result = await c.generate(req());
    expect(result.parts).toEqual([{ type: "text", text: "done" }]);
    expect(result.usage.costMicroUsd).toBe(500);
    expect(result.usage.outputTokens + result.usage.thinkingTokens).toBe(30);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![1]!.redirect).toBe("error");
    if (provider === "anthropic") {
      expect(f.mock.calls[0]![0]).toBe("https://api.anthropic.com/v1/messages");
      expect(f.mock.calls[0]![1]!.headers).toMatchObject({ "x-api-key": "test-secret-never-real", "anthropic-version": "2023-06-01" });
      expect(sent(f).max_tokens).toBe(1024);
    } else {
      expect(f.mock.calls[0]![0]).toBe(provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://openrouter.ai/api/v1/chat/completions");
      expect(sent(f).max_completion_tokens).toBe(1024);
    }
    expect(c.estimateMicroUsd(req())).toBeGreaterThan(result.usage.costMicroUsd);
  });
  it.each(["deepseek", "anthropic"] as const)("%s expands MCP calls and roundtrips IDs/results without gaining permissions", async provider => {
    const r = req({ tools: [{ name: "mcp_call", description: "MCP", inputSchema: {} }], mcpTools: [{ connector: "calendar", tool: "list", description: "List", classification: "read", inputSchema: { type: "object" } }] });
    const f = transport(provider === "anthropic" ? claude([{ type: "tool_use", id: "call_1", name: "mcp__calendar__list", input: { n: 1 } }], "tool_use") : openai({ tool_calls: [{ type: "function", id: "call_1", function: { name: "mcp__calendar__list", arguments: '{"n":1}' } }] }, "tool_calls"));
    const c = new HttpProviderClient(config(provider), { fetch: f });
    const result = await c.generate(r);
    expect(result.stopReason).toBe("tool_call");
    expect(result.parts).toEqual([{ type: "tool_call", id: "call_1", name: "mcp_call", arguments: { connector: "calendar", tool: "list", arguments: { n: 1 } } }]);
    f.mockResolvedValueOnce(new Response(JSON.stringify(provider === "anthropic" ? claude() : openai())));
    await c.generate({ ...r, messages: [...r.messages, { role: "assistant", content: result.parts }, { role: "tool", content: { toolCallId: "call_1", name: "mcp_call", result: "untrusted result" } }] });
    const body = JSON.parse(f.mock.calls[1]![1]!.body as string);
    expect(JSON.stringify(body.messages)).toContain("call_1");
    expect(JSON.stringify(body.messages)).toContain("untrusted result");
    expect(JSON.stringify(body.messages)).toContain("mcp__calendar__list");
  });
  it.each(["deepseek", "anthropic"] as const)("%s groups parallel results correctly and preserves unknown tool names for Kernel denial", async provider => {
    const r = req({ messages: [{ role: "user", content: "Go" }, { role: "assistant", content: [ { type: "tool_call", id: "a", name: "list_files", arguments: {} }, { type: "tool_call", id: "b", name: "read_file", arguments: { path: "index.html" } }] }, { role: "tool", content: { toolCallId: "a", name: "list_files", result: "one" } }, { role: "tool", content: { toolCallId: "b", name: "read_file", result: "two" } }] });
    const raw = provider === "anthropic" ? claude([{ type: "tool_use", id: "a", name: "invented_action", input: {} }], "tool_use") : openai({ tool_calls: [{ type: "function", id: "a", function: { name: "invented_action", arguments: "{}" } }] }, "tool_calls");
    const f = transport(raw), c = new HttpProviderClient(config(provider), { fetch: f });
    const result = await c.generate(r);
    expect(result.parts[0]).toMatchObject({ type: "tool_call", name: "invented_action" });
    expect((result.parts[0] as { id: string }).id).not.toBe("a");
    if (provider === "anthropic") expect(sent(f).messages.at(-1).content).toHaveLength(2);
  });
  it.each(["deepseek", "anthropic"] as const)("%s converts forced structured tool into JSON text (never an executable tool)", async provider => {
    const body = provider === "anthropic" ? claude([{ type: "tool_use", id: "x", name: "makase_structured_output", input: { title: "Demo" } }], "tool_use") : openai({ tool_calls: [{ type: "function", id: "x", function: { name: "makase_structured_output", arguments: '{"title":"Demo"}' } }] }, "tool_calls");
    const f = transport(body), c = new HttpProviderClient(config(provider), { fetch: f });
    expect(await c.generate(req({ responseJsonSchema: schema, thinkingLevel: "low" }))).toMatchObject({ parts: [{ type: "text", text: '{"title":"Demo"}' }], stopReason: "stop" });
    expect(sent(f).tool_choice).toBeDefined();
  });
  it.each(["deepseek", "anthropic"] as const)("%s supports explicit native schema mode", async provider => {
    const cfg = config(provider); cfg.profiles["test-model"]!.structuredOutput = "json_schema";
    const f = transport(provider === "anthropic" ? claude([{ type: "text", text: '{"title":"Demo"}' }]) : openai({ content: '{"title":"Demo"}' }));
    await new HttpProviderClient(cfg, { fetch: f }).generate(req({ responseJsonSchema: schema }));
    expect(provider === "anthropic" ? sent(f).output_config.format.schema : sent(f).response_format.json_schema.schema).toEqual(schema);
  });
  it.each(["deepseek", "anthropic"] as const)("%s discards executable calls and structured partial output on refusal/truncation", async provider => {
    for (const reason of provider === "anthropic" ? ["refusal", "max_tokens", "new_reason"] : ["content_filter", "length", "new_reason"]) {
      const f = transport(provider === "anthropic" ? claude([{ type: "text", text: '{"title":"partial"}' }, { type: "tool_use", id: "x", name: "run_command", input: {} }], reason) : openai({ content: '{"title":"partial"}', tool_calls: [{ type: "function", id: "x", function: { name: "run_command", arguments: "{" } }] }, reason));
      expect((await new HttpProviderClient(config(provider), { fetch: f }).generate(req({ responseJsonSchema: schema }))).parts).toEqual([]);
    }
  });
  it("fails locally for missing capabilities, pricing and broken history", async () => {
    const f = transport(openai()), cfg = config(); cfg.profiles["test-model"]!.tools = false;
    const c = new HttpProviderClient(cfg, { fetch: f });
    for (const r of [req({ model: "gemini-2.5-flash" }), req({ googleSearch: true }), req({ maxTokens: 9000 }), req({ tools: [{ name: "finish", description: "", inputSchema: {} }] }), req({ responseJsonSchema: schema }), req({ thinkingLevel: "high" }), req({ messages: [{ role: "tool", content: { toolCallId: "unknown", name: "finish", result: "x" } }] })]) await expect(c.generate(r)).rejects.toBeInstanceOf(LlmError);
    expect(f).not.toHaveBeenCalled();
    expect(c.priceFor("gemini-2.5-flash")).toBeNull();
  });
  it("does not silently drop temperature and checks context length", async () => {
    const cfg = config(), f = transport(openai()); cfg.profiles["test-model"]!.temperature = false;
    await expect(new HttpProviderClient(cfg, { fetch: f }).generate(req({ temperature: 0.2 }))).rejects.toThrow(/temperature/);
    cfg.profiles["test-model"]!.contextWindow = 100;
    await expect(new HttpProviderClient(cfg, { fetch: f }).generate(req())).rejects.toThrow(/コンテキスト/);
    expect(f).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 429, 500, 529])("normalizes HTTP %s without echoing bodies or secrets", async status => {
    const f = transport({ error: "test-secret-never-real private prompt" }, status);
    try { await new HttpProviderClient(config(), { fetch: f }).generate(req()); throw new Error("expected failure"); }
    catch (e) { expect(e).toBeInstanceOf(LlmError); expect((e as LlmError).retryable).toBe(status === 429 || status >= 500); expect(String(e)).not.toContain("test-secret"); expect(String(e)).not.toContain("private prompt"); }
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("delegates retries to the shared retry layer", async () => {
    const f = transport({ error: "busy" }, 429);
    f.mockResolvedValueOnce(new Response("{}", { status: 429 })).mockResolvedValueOnce(new Response(JSON.stringify(openai())));
    await withRetry(() => new HttpProviderClient(config(), { fetch: f }).generate(req()), { delaysMs: [0], sleep: async () => {} });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("does not send an aborted request or expose network errors", async () => {
    const f = vi.fn<typeof fetch>().mockRejectedValue(new Error("private prompt test-secret-never-real"));
    const c = new HttpProviderClient(config(), { fetch: f });
    await expect(c.generate(req(), { signal: AbortSignal.abort() })).rejects.toThrow(/中断/);
    expect(f).not.toHaveBeenCalled();
    await expect(c.generate(req())).rejects.toThrow("LLM API との通信に失敗しました");
  });
  it.each([{}, { choices: [], usage: {} }, openai({ tool_calls: [{ type: "function", id: "a", function: { name: "run_command", arguments: "{bad-private" } }] }, "tool_calls"), { ...openai(), usage: { prompt_tokens: -1, completion_tokens: 1 } }, { ...openai(), usage: undefined }])("rejects malformed or unmetered responses, never prices missing usage at zero", async body => {
    await expect(new HttpProviderClient(config(), { fetch: transport(body) }).generate(req())).rejects.toMatchObject({ status: null, retryable: false });
  });
  it("accounts for Anthropic cache input conservatively and OpenAI reasoning once", async () => {
    const a = { ...claude(), usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 30 } };
    expect((await new HttpProviderClient(config("anthropic"), { fetch: transport(a) }).generate(req())).usage).toMatchObject({ inputTokens: 140, outputTokens: 30, thinkingTokens: 0, costMicroUsd: 580 });
    expect((await new HttpProviderClient(config(), { fetch: transport(openai()) }).generate(req())).usage).toMatchObject({ inputTokens: 100, outputTokens: 20, thinkingTokens: 10, costMicroUsd: 500 });
  });
});
