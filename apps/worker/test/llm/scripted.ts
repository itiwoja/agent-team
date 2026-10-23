// 試験の台本の LLM を Claude の料金表で数える（packages/llm の ScriptedLlmClient は Gemini の料金表で費用を出すため）
import { computeMicroUsd, ScriptedLlmClient, type LlmRequest, type LlmResponse } from "@open-team/llm";
import { CLAUDE_PRICES } from "../../src/llm/claude.ts";

export class ClaudeScriptedLlm extends ScriptedLlmClient {
  readonly provider = "anthropic" as const;

  priceFor(model: string) {
    return CLAUDE_PRICES[model] ?? null;
  }

  override async generate(req: LlmRequest, opts: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    const r = await super.generate(req, opts);
    const price = CLAUDE_PRICES[r.model];
    if (price === undefined) return r;
    // Claude の出力のトークンは思考を含む
    const outputTokens = r.usage.outputTokens + r.usage.thinkingTokens;
    return { ...r, usage: { inputTokens: r.usage.inputTokens, outputTokens, thinkingTokens: 0, costMicroUsd: computeMicroUsd(price, r.usage.inputTokens, outputTokens, 0) } };
  }
}
