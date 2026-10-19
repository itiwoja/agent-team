// LLM の呼び出しの型（Gemini API で呼ぶ）
// runner の会話の形（ChatMessage）をそのまま受け取り、モデルの応答を AssistantPart に戻す。
// 使えるのは edge（app）と scripts だけ。runner はこのパッケージを import しない（D-52）。

import type { AssistantPart, ChatMessage, McpToolSpec, ToolSpec } from "@open-team/runner";
import type { PriceEntry } from "./pricing.ts";

export interface LlmRequest {
  model: string;
  system: string;
  messages: readonly ChatMessage[];
  /** カタログのツール。mcp_call はここでは宣言せず、mcpTools をツールごとの関数に展開してモデルに見せる（展開と戻しはこのパッケージの中だけ） */
  tools: readonly ToolSpec[];
  /** mcp_call で呼べるツール（付与されたもの）。tools に mcp_call がないときは無視する */
  mcpTools: readonly McpToolSpec[];
  maxTokens: number;
  temperature?: number;
  /** 構造化出力（状況の生成・設定プランナー）。指定したら tools は空にする */
  responseJsonSchema?: unknown;
  /** 思考の深さ（Gemini 3 の thinkingLevel）。省けばモデルの既定。急ぐ構造化出力（設定プランナー）は low */
  thinkingLevel?: "low" | "high";
  /** Google 検索の Grounding で答えさせる（edge の web_search の中の呼び出し）。指定したら tools・構造化出力は使わない */
  googleSearch?: boolean;
}

/** Grounding で使った検索と出典（googleSearch を指定した呼び出しだけ） */
export interface LlmGrounding {
  /** モデルが投げた検索の語句（回数が費用になる） */
  queries: string[];
  /** 出典（url は Grounding の転送の URL のことがある。開くと元のページに移る） */
  sources: { title: string; url: string }[];
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** 思考のトークン（出力の単価で数える） */
  thinkingTokens: number;
  /** 価格表から計算した実費（整数のマイクロドル） */
  costMicroUsd: number;
}

export interface LlmResponse {
  model: string;
  /** 関数呼び出しは mcp_call の形（{ connector, tool, arguments }）に戻したもの */
  parts: AssistantPart[];
  stopReason: string;
  usage: LlmUsage;
  /** googleSearch を指定した呼び出しの検索と出典 */
  grounding?: LlmGrounding;
}

export interface LlmClient {
  /** Stable policy/certificate identity, distinct from the model ID sent to an API. */
  modelIdentity?(model: string): string;
  /** Provider-scoped pricing; no fallback to another provider's model names. */
  priceFor?(model: string): PriceEntry | null;
  /** Check capabilities and estimate before budget checks and any network I/O. */
  preflight?(req: LlmRequest): void;
  estimateMicroUsd?(req: LlmRequest): number;
  generate(req: LlmRequest, opts?: { signal?: AbortSignal }): Promise<LlmResponse>;
}

/** LLM の呼び出しの失敗。retryable は 429・5xx・ネットワーク */
export class LlmError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryable = retryable;
  }
}
