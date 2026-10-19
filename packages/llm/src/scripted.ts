// 決まった応答を返す LLM（試験・CI・オフラインのデモ用。ネットワークを使わず、同じ入力なら同じ出力）
// 応答の列か「要求 → 応答」の関数を受ける。使用量は指定がなければ文字数からの目安（UTF-8 のバイト数 ÷ 4 の切り上げ）にし、
// 費用は本物と同じ価格表で出す（計測の費用の数え方を本番と同じにする）

import type { AssistantPart } from "@open-team/runner";
import { costMicroUsd, GROUNDING_QUERY_MICRO_USD, type TokenUsage } from "./pricing.ts";
import { llmAbortedError } from "./retry.ts";
import { LlmError, type LlmClient, type LlmGrounding, type LlmRequest, type LlmResponse, type LlmUsage } from "./types.ts";

export interface ScriptedReply {
  /** 返す部品（関数呼び出しは mcp_call の形のまま書く） */
  parts: AssistantPart[];
  /** 既定は GeminiClient と同じ言葉（ツール呼び出しがあれば "tool_call"、なければ "stop"） */
  stopReason?: string;
  /** 指定したら、ない項目は 0。指定しなければ文字数からの目安 */
  usage?: Partial<Pick<LlmUsage, "inputTokens" | "outputTokens" | "thinkingTokens">>;
  /** 既定は要求の model（費用はこのモデルの単価） */
  model?: string;
  /** Google 検索の Grounding の検索と出典（web_search の試験。検索の回数は費用に足す） */
  grounding?: LlmGrounding;
}

/** index は 0 から数えた呼び出しの番号 */
export type ScriptedResponder = (req: LlmRequest, index: number) => ScriptedReply | Promise<ScriptedReply>;
export type ScriptedStep = ScriptedReply | ScriptedResponder;

export class ScriptedLlmClient implements LlmClient {
  /** 受けた要求（呼ばれた順。試験で確かめる用） */
  readonly requests: LlmRequest[] = [];
  private readonly respond: ScriptedResponder;

  /** 列なら1回に1つずつ使い、尽きたら LlmError（やり直さない）。関数なら毎回呼ぶ */
  constructor(script: readonly ScriptedStep[] | ScriptedResponder) {
    this.respond = typeof script === "function" ? script : respondInOrder(script);
  }

  async generate(req: LlmRequest, opts: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    if (opts.signal?.aborted) throw llmAbortedError();
    const index = this.requests.length;
    this.requests.push(req);
    const reply = await this.respond(req, index);
    if (opts.signal?.aborted) throw llmAbortedError();
    const model = reply.model ?? req.model;
    // 呼び出し側が書き換えても台本が変わらないように写す
    const parts = structuredClone(reply.parts);
    const tokens: TokenUsage =
      reply.usage === undefined
        ? { inputTokens: approxTokens([req.system, req.messages, req.tools, req.mcpTools, req.responseJsonSchema ?? null]), outputTokens: approxTokens(parts), thinkingTokens: 0 }
        : { inputTokens: reply.usage.inputTokens ?? 0, outputTokens: reply.usage.outputTokens ?? 0, thinkingTokens: reply.usage.thinkingTokens ?? 0 };
    return {
      model,
      parts,
      stopReason: reply.stopReason ?? (parts.some((p) => p.type === "tool_call") ? "tool_call" : "stop"),
      usage: { ...tokens, costMicroUsd: costMicroUsd(model, tokens) + (reply.grounding?.queries.length ?? 0) * GROUNDING_QUERY_MICRO_USD },
      ...(reply.grounding !== undefined ? { grounding: structuredClone(reply.grounding) } : {}),
    };
  }
}

function respondInOrder(steps: readonly ScriptedStep[]): ScriptedResponder {
  return (req, index) => {
    const step = steps[index];
    if (step === undefined) {
      throw new LlmError(`ScriptedLlmClient: 応答の列が尽きました（${index + 1}回目の呼び出し）`, null, false);
    }
    return typeof step === "function" ? step(req, index) : step;
  };
}

/** トークン数の目安：JSON の UTF-8 のバイト数 ÷ 4 の切り上げ（決定論） */
function approxTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") / 4);
}
