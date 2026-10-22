import { randomUUID } from "node:crypto";
import type { AssistantPart, ChatMessage } from "@open-team/runner";
import { GeminiClient } from "./gemini.ts";
import { computeMicroUsd } from "./pricing.ts";
import { profilePrice, providerBaseUrl, providerModelIdentity, PROVIDER_KEY_NAMES, ModelProfileSchema, LlmConfigurationError, type LlmConfig, type LlmProvider, type ModelProfile } from "./provider-config.ts";
import { SessionBudgetClient } from "./session-budget.ts";
import { buildToolDeclarations, fromGeminiFunctionCall, toGeminiFunctionCall, type McpFunctionTable } from "./tools.ts";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse, type LlmUsage } from "./types.ts";

type Obj = Record<string, unknown>;
const OUTPUT_TOOL = "makase_structured_output";
const object = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (message: string): never => { throw new LlmError(message, null, false); };
const malformed = (): never => fail("LLM の応答形式または使用量が不正です（本文は非表示）");
const count = (n: unknown): number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : malformed();
const text = (s: unknown): string => typeof s === "string" ? s : malformed();
const jsonObject = (s: unknown): Obj => {
  try { const v: unknown = JSON.parse(text(s)); if (object(v)) return v; } catch { /* never expose raw arguments */ }
  return malformed();
};

/** One HTTP attempt. Edge owns retries, budget checks, usage records and Kernel decisions. */
export class HttpProviderClient implements LlmClient {
  private readonly config: LlmConfig;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  readonly provider: LlmProvider;
  constructor(config: LlmConfig, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    if (config.provider === "gemini") throw new Error("HttpProviderClient does not handle Gemini");
    if (!config.apiKey?.trim()) throw new Error(`${PROVIDER_KEY_NAMES[config.provider]} が設定されていません`);
    let profiles: Record<string, ModelProfile>;
    try { profiles = Object.fromEntries(Object.entries(config.profiles).map(([name, p]) => [name, ModelProfileSchema.parse(p)])); }
    catch { throw new LlmConfigurationError("モデルの正の料金・能力・上限設定を確認してください"); }
    // 接続先は provider から決まる固定値（custom だけ config.baseUrl を検査して使う）。readLlmEnv と同じ値にそろえる（認証の識別子に使う）
    this.provider = config.provider;
    this.config = { ...config, profiles, baseUrl: providerBaseUrl(config.provider, config.baseUrl) };
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }
  private profile(model: string): ModelProfile {
    if (!Object.hasOwn(this.config.profiles, model)) return fail("モデルの料金・能力が未登録です。LLM_MODELS_JSON を確認してください");
    return this.config.profiles[model]!;
  }
  priceFor(model: string) { return Object.hasOwn(this.config.profiles, model) ? profilePrice(model, this.profile(model)) : null; }
  modelIdentity(model: string) { return providerModelIdentity(this.config, model); }
  preflight(req: LlmRequest): void {
    const p = this.profile(req.model);
    const haiku55 = this.config.provider === "anthropic" && req.model === "claude-haiku-5-5";
    if (haiku55 && (p.anthropicMode !== "haiku55-no-thinking" || p.temperature || p.reasoningEffort)) fail("Haiku 5.5 は anthropicMode=haiku55-no-thinking、temperature=false、reasoningEffort=false を明示してください");
    if (p.anthropicMode && !haiku55) fail("anthropicMode は Claude API の claude-haiku-5-5 専用です");
    if (haiku55 && (p.inputPerMTokMicroUsd < 500000 || p.outputPerMTokMicroUsd < 2500000)) fail("Haiku 5.5 の上限単価には10万入力トークン超の料金を設定してください");
    if (haiku55 && req.messages.at(-1)?.role === "assistant") fail("Haiku 5.5 は assistant prefill に対応していません");
    if (!Number.isSafeInteger(req.maxTokens) || req.maxTokens <= 0 || req.maxTokens > p.maxOutputTokens) fail("モデルの出力トークン上限を超えています");
    if (req.messages.length === 0) fail("LLM に送る会話がありません");
    if (req.googleSearch) fail("このプロバイダーでは Google 検索 Grounding を利用できません");
    if (req.tools.length > 0 && !p.tools) fail("選択モデルはツール呼び出しに対応していません");
    if (req.responseJsonSchema !== undefined) {
      if (req.tools.length > 0) fail("構造化出力と業務ツールは同じ呼び出しで使えません");
      if (!object(req.responseJsonSchema)) fail("構造化出力にはオブジェクトの JSON Schema が必要です");
      if (p.structuredOutput === "none" || (p.structuredOutput === "tool" && !p.tools)) fail("選択モデルは構造化出力に対応していません");
    }
    // The explicit Haiku mode opts into dropping application sampling hints (planner 0.2 / simulator 0.7).
    if (req.temperature !== undefined && !p.temperature && !haiku55) fail("選択モデルは temperature 指定に対応していません");
    // low is a latency hint, not a semantic requirement. Non-Gemini backends may use their default.
    if (req.thinkingLevel === "high" && (this.config.provider === "anthropic" || !p.reasoningEffort)) fail("選択モデルは要求された思考設定に対応していません");
    validateHistory(req.messages);
    if (this.inputBound(req) + req.maxTokens > p.contextWindow) fail("モデルのコンテキスト上限を超える可能性があります（保守的なバイト数見積もり）");
  }
  private inputBound(req: LlmRequest): number {
    // Include the actual wire schema and provider tool/system overhead. No guessed token discounts.
    return Buffer.byteLength(JSON.stringify(this.request(req).body), "utf8") + 4096;
  }
  estimateMicroUsd(req: LlmRequest): number {
    return computeMicroUsd(profilePrice(req.model, this.profile(req.model)), this.inputBound(req), req.maxTokens, 0);
  }
  private request(req: LlmRequest): { body: Obj; table: McpFunctionTable } {
    const p = this.profile(req.model);
    const { declarations, table } = buildToolDeclarations(req.tools, req.mcpTools);
    const structuredTool = req.responseJsonSchema !== undefined && p.structuredOutput === "tool";
    const tools = structuredTool ? [{ name: OUTPUT_TOOL, description: "Return the requested structured result", parametersJsonSchema: req.responseJsonSchema }] : declarations;
    if (this.config.provider === "anthropic") {
      const body: Obj = { model: req.model, system: req.system, max_tokens: req.maxTokens, messages: anthropicMessages(req.messages, table) };
      if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parametersJsonSchema ?? { type: "object", properties: {} } }));
      if (structuredTool) body.tool_choice = { type: "tool", name: OUTPUT_TOOL, disable_parallel_tool_use: true };
      else if (req.responseJsonSchema !== undefined) body.output_config = { format: { type: "json_schema", schema: req.responseJsonSchema } };
      if (p.anthropicMode === "haiku55-no-thinking") {
        body.thinking = { type: "disabled" };
        body.output_config = { ...(object(body.output_config) ? body.output_config : {}), effort: req.thinkingLevel === "low" ? "low" : "medium" };
      } else if (req.temperature !== undefined) body.temperature = req.temperature;
      return { body, table };
    }
    const body: Obj = { model: req.model, messages: [{ role: "system", content: req.system }, ...openAiMessages(req.messages, table)], [p.tokenLimitParameter]: req.maxTokens, stream: false };
    if (tools.length) body.tools = tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parametersJsonSchema ?? { type: "object", properties: {} }, strict: false } }));
    if (structuredTool) {
      body.tool_choice = { type: "function", function: { name: OUTPUT_TOOL } };
      body.parallel_tool_calls = false;
    } else if (req.responseJsonSchema !== undefined) body.response_format = { type: "json_schema", json_schema: { name: "makase_result", schema: req.responseJsonSchema, strict: false } };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.thinkingLevel && p.reasoningEffort) body.reasoning_effort = req.thinkingLevel;
    return { body, table };
  }
  async generate(req: LlmRequest, opts: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    this.preflight(req);
    if (opts.signal?.aborted) fail("LLM の呼び出しを中断しました");
    const { body, table } = this.request(req);
    const anthropic = this.config.provider === "anthropic";
    const endpoint = anthropic ? "https://api.anthropic.com/v1/messages" : `${this.config.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (anthropic) { headers["x-api-key"] = this.config.apiKey!; headers["anthropic-version"] = "2023-06-01"; }
    else headers.authorization = `Bearer ${this.config.apiKey}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let raw: unknown;
    try {
      const res = await this.fetcher(endpoint, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal });
      if (!res.ok) {
        // Never echo provider error bodies, headers or URLs (may contain prompts or credentials).
        await res.body?.cancel();
        throw new LlmError(`LLM API が HTTP ${res.status} を返しました。認証・モデル・能力設定を確認してください`, res.status, res.status === 429 || res.status >= 500);
      }
      raw = await res.json();
    } catch (e) {
      if (opts.signal?.aborted) fail("LLM の呼び出しを中断しました");
      if (e instanceof LlmError) throw e;
      if (e instanceof SyntaxError) return malformed();
      throw new LlmError(timeout.aborted ? "LLM API がタイムアウトしました" : "LLM API との通信に失敗しました", null, true);
    }
    if (!object(raw)) return malformed();
    const parsed = anthropic ? parseAnthropic(raw) : parseOpenAi(raw);
    const usage = this.usage(req, raw, anthropic);
    const usedIds = new Set(req.messages.flatMap(m => m.role === "assistant" ? m.content.filter(p => p.type === "tool_call").map(p => p.id) : []));
    let parts: AssistantPart[] = parsed.parts.map(part => {
      if (part.type !== "tool_call") return part;
      let id = part.id;
      if (!id || usedIds.has(id) || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) id = `call_${randomUUID().replaceAll("-", "")}`;
      usedIds.add(id);
      return { type: "tool_call", id, ...fromGeminiFunctionCall(part.name, part.arguments as Obj, table) };
    });
    // Do not execute partial calls on refusals, truncation or unknown stop reasons.
    if (!["stop", "tool_calls"].includes(parsed.stopReason)) parts = parts.filter(p => p.type === "text");
    if (req.responseJsonSchema !== undefined && ["stop", "tool_calls"].includes(parsed.stopReason)) {
      if (this.profile(req.model).structuredOutput === "tool") {
        const calls = parts.filter(p => p.type === "tool_call");
        if (calls.length !== 1 || calls[0]!.name !== OUTPUT_TOOL) return malformed();
        parts = [{ type: "text", text: JSON.stringify(calls[0]!.arguments) }];
      } else {
        const content = parts.filter(p => p.type === "text").map(p => p.text).join("");
        try { JSON.parse(content); } catch { return malformed(); }
      }
    }
    if (req.responseJsonSchema !== undefined && !["stop", "tool_calls"].includes(parsed.stopReason)) parts = [];
    // Caller validates the original schema (Zod) and Kernel validates all tool arguments.
    const stopReason = parsed.stopReason === "tool_calls" ? (req.responseJsonSchema !== undefined ? "stop" : "tool_call") : parsed.stopReason;
    return { model: req.model, parts, stopReason, usage };
  }
  private usage(req: LlmRequest, raw: Obj, anthropic: boolean): LlmUsage {
    if (!object(raw.usage)) return malformed();
    const u = raw.usage;
    let inputTokens: number, outputTokens: number, thinkingTokens = 0;
    if (anthropic) {
      // We don't request prompt caching. Count unexpected cache creation conservatively at 2x input rate.
      inputTokens = count(u.input_tokens) + count(u.cache_read_input_tokens ?? 0) + 2 * count(u.cache_creation_input_tokens ?? 0);
      outputTokens = count(u.output_tokens); // includes thinking, never count it twice
    } else {
      inputTokens = count(u.prompt_tokens);
      const completion = count(u.completion_tokens);
      if (object(u.completion_tokens_details)) thinkingTokens = count(u.completion_tokens_details.reasoning_tokens ?? 0);
      if (thinkingTokens > completion) return malformed();
      outputTokens = completion - thinkingTokens;
    }
    if (!Number.isSafeInteger(inputTokens)) return malformed();
    const cost = computeMicroUsd(profilePrice(req.model, this.profile(req.model)), inputTokens, outputTokens, thinkingTokens);
    return { inputTokens, outputTokens, thinkingTokens, costMicroUsd: cost };
  }
}

function validateHistory(messages: readonly ChatMessage[]): void {
  const seen = new Set<string>(), pending = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      if (!pending.delete(m.content.toolCallId)) fail("ツール結果に対応する呼び出しがありません");
      continue;
    }
    if (pending.size) fail("ツール結果が不足しています");
    if (m.role === "assistant") for (const p of m.content) if (p.type === "tool_call") {
      if (!p.id || seen.has(p.id)) fail("ツール呼び出しIDが重複しています");
      seen.add(p.id); pending.add(p.id);
    }
  }
  if (pending.size) fail("ツール結果が不足しています");
}
function openAiMessages(messages: readonly ChatMessage[], table: McpFunctionTable): Obj[] {
  return messages.map(m => {
    if (m.role === "user") return { role: "user", content: m.content };
    if (m.role === "tool") return { role: "tool", tool_call_id: m.content.toolCallId, content: m.content.result };
    const calls = m.content.filter(p => p.type === "tool_call").map(p => { const f = toGeminiFunctionCall(p, table); return { id: p.id, type: "function", function: { name: f.name, arguments: JSON.stringify(f.args) } }; });
    return { role: "assistant", content: m.content.filter(p => p.type === "text").map(p => p.text).join("\n") || null, ...(calls.length ? { tool_calls: calls } : {}) };
  });
}
function anthropicMessages(messages: readonly ChatMessage[], table: McpFunctionTable): Obj[] {
  const out: Array<{ role: string; content: Obj[] }> = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content: Obj[] = m.role === "user" ? [{ type: "text", text: m.content }] : m.role === "tool" ? [{ type: "tool_result", tool_use_id: m.content.toolCallId, content: m.content.result }] : m.content.map(p => {
      if (p.type === "text") return { type: "text", text: p.text };
      const f = toGeminiFunctionCall(p, table);
      return { type: "tool_use", id: p.id, name: f.name, input: f.args };
    });
    const prev = out.at(-1);
    if (prev?.role === role) prev.content.push(...content); else out.push({ role, content });
  }
  return out;
}
interface Parsed { parts: AssistantPart[]; stopReason: string }
function parseOpenAi(raw: Obj): Parsed {
  if (!Array.isArray(raw.choices) || raw.choices.length !== 1 || !object(raw.choices[0])) return malformed();
  const choice = raw.choices[0], msg = choice.message;
  if (!object(msg)) return malformed();
  const stopReason = msg.refusal || choice.finish_reason === "content_filter" ? "refusal" : choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "stop" ? "stop" : choice.finish_reason === "tool_calls" ? "tool_calls" : "unknown";
  const parts: AssistantPart[] = [];
  if (typeof msg.content === "string" && msg.content) parts.push({ type: "text", text: msg.content });
  if (stopReason === "tool_calls") {
    if (!Array.isArray(msg.tool_calls) || !msg.tool_calls.length) return malformed();
    for (const call of msg.tool_calls) {
      if (!object(call) || call.type !== "function" || !object(call.function)) return malformed();
      parts.push({ type: "tool_call", id: typeof call.id === "string" ? call.id : "", name: text(call.function.name), arguments: jsonObject(call.function.arguments) });
    }
  }
  return { parts, stopReason };
}
function parseAnthropic(raw: Obj): Parsed {
  if (!Array.isArray(raw.content)) return malformed();
  const stopReason = raw.stop_reason === "end_turn" || raw.stop_reason === "stop_sequence" ? "stop" : raw.stop_reason === "tool_use" ? "tool_calls" : raw.stop_reason === "max_tokens" || raw.stop_reason === "model_context_window_exceeded" ? "max_tokens" : raw.stop_reason === "refusal" ? "refusal" : "unknown";
  const parts: AssistantPart[] = [];
  for (const block of raw.content) {
    if (!object(block)) return malformed();
    if (block.type === "text") parts.push({ type: "text", text: text(block.text) });
    else if (block.type === "tool_use" && stopReason === "tool_calls") {
      if (!object(block.input)) return malformed();
      parts.push({ type: "tool_call", id: typeof block.id === "string" ? block.id : "", name: text(block.name), arguments: block.input });
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      return fail("このモデルは拡張思考の継続データを要求します。このアダプターでは非対応です");
    } else if (block.type !== "tool_use") return malformed();
  }
  if (stopReason === "tool_calls" && !parts.some(p => p.type === "tool_call")) return malformed();
  return { parts, stopReason };
}

export function createLlmClient(config: LlmConfig, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): LlmClient {
  const client = config.provider === "gemini" ? new GeminiClient({ apiKey: config.apiKey, retry: { delaysMs: [] } }) : new HttpProviderClient(config, options);
  return config.sessionBudgetMicroUsd === undefined ? client : new SessionBudgetClient(client, config.sessionBudgetMicroUsd, config.trialLedgerPath);
}
