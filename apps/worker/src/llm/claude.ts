// Claude（Anthropic の公式 SDK）の LlmClient。Worker の LLM は Claude だけに対応する（2026-10-23 の決定。ほかの提供元は持たない）。
// 呼び出しは1回だけ（SDK のやり直しは切る。やり直し・予算・費用の記録は edge/llm-call.ts の1か所）。
// - モデル：既定は claude-opus-5-5。CLAUDE_MODEL で変えられる（料金表 CLAUDE_PRICES にあるものだけ）
// - 思考：送らない（現行のモデルは adaptive が既定）。thinkingLevel は effort の low・high に写す
// - 思考のブロックは履歴に載せて返さない。全部の思考のブロックを外した履歴は受け付けられ、
//   一部だけ・書き換えた形で返すと preserved thinking の検査で 400 になる（runner の履歴は自分で組み立てるので、全部外す側を選ぶ）。
//   そのかわり、次の呼び出しでモデルは前の思考を見られない
// - temperature は送らない（2026-10-21 以降の API は 400）
// - 構造化出力（設定プランナー）は output_config.format。Claude が受け付けない制約（文字数・数の範囲など）は外して送り、受け取ったあとに zod で確かめる（planner.ts）
// - 安全の判定で断られたとき（refusal）は、サーバー側の代わりのモデル（fallbacks: "default"）に回す（Opus・Sonnet・Fable だけ）。
//   費用は応答の model（実際に答えたモデル）の単価で数える
// - 強制の tool_choice（any・tool）は使わない（Opus 5.5・Sonnet 5.5 は 400）

import Anthropic from "@anthropic-ai/sdk";
import type { AssistantPart, ChatMessage } from "@open-team/runner";
import {
  buildToolDeclarations,
  computeMicroUsd,
  fromGeminiFunctionCall,
  inputTokensUpperBound,
  LlmError,
  toGeminiFunctionCall,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type McpFunctionTable,
  type PriceEntry,
} from "@open-team/llm";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

const MTOK = (usd: number): number => Math.round(usd * 1_000_000);
const price = (model: string, input: number, output: number, long?: { over: number; input: number; output: number }): PriceEntry => ({
  model,
  inputPerMTokMicroUsd: MTOK(input),
  outputPerMTokMicroUsd: MTOK(output),
  thinkingPerMTokMicroUsd: MTOK(output),
  ...(long === undefined
    ? {}
    : { longContext: { overInputTokens: long.over, inputPerMTokMicroUsd: MTOK(long.input), outputPerMTokMicroUsd: MTOK(long.output), thinkingPerMTokMicroUsd: MTOK(long.output) } }),
});

/** 料金（Anthropic の API の通常の単価。2026-10-06 の表。思考は出力の単価）。Haiku 5.5 は入力 10万トークン超で高い単価 */
export const CLAUDE_PRICES: Readonly<Record<string, PriceEntry>> = {
  "claude-fable-5-1": price("claude-fable-5-1", 10, 50),
  "claude-opus-5-5": price("claude-opus-5-5", 4, 20),
  "claude-sonnet-5-5": price("claude-sonnet-5-5", 2, 10),
  "claude-haiku-5-5": price("claude-haiku-5-5", 0.1, 0.5, { over: 100_000, input: 0.5, output: 2.5 }),
};

/** 応答の model が表にない（代わりのモデルが答えた など）ときに使う単価：表で一番高いもの（少なく数えない） */
const HIGHEST_PRICE = CLAUDE_PRICES["claude-fable-5-1"]!;

/** 断られたときにサーバー側で代わりのモデルに回せるモデル */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Claude の構造化出力が受け付けない JSON Schema のキーワード（外して送る。受け取ったあと zod で確かめる） */
const UNSUPPORTED_SCHEMA_KEYS = new Set(["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "pattern", "default", "$schema"]);

/** 構造化出力に送る形にする：受け付けないキーワードを外し、object には additionalProperties: false を付ける */
export function claudeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(claudeJsonSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
    out[k] = k === "properties" && typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([p, s]) => [p, claudeJsonSchema(s)])) : claudeJsonSchema(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

/** runner の会話を Claude の messages にする（同じ役割が続くときはまとめる。中身のない発言は送らない） */
function toClaudeMessages(messages: readonly ChatMessage[], table: McpFunctionTable): Anthropic.Beta.BetaMessageParam[] {
  const out: Array<{ role: "user" | "assistant"; content: Anthropic.Beta.BetaContentBlockParam[] }> = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content: Anthropic.Beta.BetaContentBlockParam[] =
      m.role === "user"
        ? m.content === ""
          ? []
          : [{ type: "text", text: m.content }]
        : m.role === "tool"
          ? [{ type: "tool_result", tool_use_id: m.content.toolCallId, content: m.content.result }]
          : m.content.flatMap((p): Anthropic.Beta.BetaContentBlockParam[] => {
              if (p.type === "text") return p.text === "" ? [] : [{ type: "text", text: p.text }];
              const f = toGeminiFunctionCall(p, table);
              return [{ type: "tool_use", id: p.id, name: f.name, input: f.args }];
            });
    if (content.length === 0) continue;
    const prev = out.at(-1);
    if (prev?.role === role) prev.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}

function stopReasonOf(r: string | null): string {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "unknown";
  }
}

/** SDK の失敗を LlmError にする（429・5xx・つながらない は送り直せる。status がないものは送れたか分からない） */
function toLlmError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.APIConnectionError) return new LlmError("Claude に接続できませんでした", null, true);
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === "number" ? e.status : null;
    return new LlmError(`Claude の API がエラーを返しました（${status ?? "不明"}）`, status, status === 429 || status === 408 || (status !== null && status >= 500));
  }
  return new LlmError(`Claude の呼び出しに失敗しました：${e instanceof Error ? e.message : String(e)}`, null, false);
}

export class ClaudeClient implements LlmClient {
  readonly provider = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(o: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number }) {
    // やり直しは callLlm の1か所で数える（SDK の既定の2回は切る）
    this.client = new Anthropic({ apiKey: o.apiKey, maxRetries: 0, timeout: o.timeoutMs ?? 600_000, ...(o.fetch === undefined ? {} : { fetch: o.fetch }) });
  }

  priceFor(model: string): PriceEntry | null {
    return CLAUDE_PRICES[model] ?? null;
  }

  preflight(req: LlmRequest): void {
    if (CLAUDE_PRICES[req.model] === undefined) throw new LlmError(`料金表にない Claude のモデルです：${req.model}`, null, false);
    if (req.googleSearch === true) throw new LlmError("Google 検索の Grounding は Claude では使えません", null, false);
  }

  estimateMicroUsd(req: LlmRequest): number {
    return computeMicroUsd(CLAUDE_PRICES[req.model] ?? HIGHEST_PRICE, inputTokensUpperBound(req), req.maxTokens, 0);
  }

  async generate(req: LlmRequest, opts: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    this.preflight(req);
    const { declarations, table } = buildToolDeclarations(req.tools, req.mcpTools);
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: toClaudeMessages(req.messages, table),
      stream: true,
      ...(declarations.length === 0
        ? {}
        : {
            // 宣言の名前・説明は buildToolDeclarations が必ず入れる（型は Gemini の FunctionDeclaration なので省略可になっている）
            tools: declarations.map((d) => ({
              name: d.name ?? "",
              description: d.description ?? "",
              input_schema: (d.parametersJsonSchema ?? { type: "object", properties: {} }) as Anthropic.Beta.BetaTool.InputSchema,
            })),
          }),
      ...(req.responseJsonSchema === undefined && req.thinkingLevel === undefined
        ? {}
        : {
            output_config: {
              ...(req.responseJsonSchema === undefined ? {} : { format: { type: "json_schema" as const, schema: claudeJsonSchema(req.responseJsonSchema) as Record<string, unknown> } }),
              ...(req.thinkingLevel === undefined ? {} : { effort: req.thinkingLevel }),
            },
          }),
      ...(FALLBACK_MODELS.has(req.model) ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
    };
    let message: Anthropic.Beta.BetaMessage;
    try {
      // 長い出力でも HTTP の打ち切りにかからないよう stream で受けて、最後にまとめる
      message = await this.client.beta.messages.stream(params, opts.signal === undefined ? {} : { signal: opts.signal }).finalMessage();
    } catch (e) {
      throw toLlmError(e);
    }
    const parts: AssistantPart[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text !== "") parts.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        const input = typeof block.input === "object" && block.input !== null && !Array.isArray(block.input) ? (block.input as Record<string, unknown>) : {};
        const call = fromGeminiFunctionCall(block.name, input, table);
        parts.push({ type: "tool_call", id: block.id, name: call.name, arguments: call.arguments });
      }
      // 思考（thinking・redacted_thinking）は返さない（先頭のコメント）。代わりのモデルへの切り替えの印（fallback）なども使わない
    }
    const u = message.usage;
    const inputTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    // output_tokens は思考を含む（思考の分を別に数えない）
    const outputTokens = u.output_tokens;
    const priceOfServed = CLAUDE_PRICES[message.model] ?? HIGHEST_PRICE;
    return {
      model: message.model,
      parts,
      stopReason: stopReasonOf(message.stop_reason),
      usage: { inputTokens, outputTokens, thinkingTokens: 0, costMicroUsd: computeMicroUsd(priceOfServed, inputTokens, outputTokens, 0) },
    };
  }
}
