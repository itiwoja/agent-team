// Worker の LLM（docs/cloudflare-design.md）。Claude だけに対応する（llm/claude.ts）。
// キーは Workers secrets の ANTHROPIC_API_KEY（ローカルは .dev.vars）、モデルは vars の CLAUDE_MODEL（省けば claude-opus-5-5。設定プランナーも担当も同じモデル）。
// キーがなければ呼ぶ前に断るクライアントにする。やり直しは edge/llm-call.ts の callLlm の1か所で数える。
// 試験は setLlmForTest で ScriptedLlmClient に差し替える（Workflow も試験と同じ isolate で動くので、モジュールの変数が見える）

import { LlmError, type LlmClient } from "@open-team/llm";
import { CLAUDE_PRICES, ClaudeClient, DEFAULT_CLAUDE_MODEL } from "./llm/claude.ts";

/** 設定プランナー・担当が使うモデル（modelForPurpose・modelForPhase に渡す形） */
export interface LlmModels {
  agentModel: string;
  plannerModel: string;
}

export interface LlmSetup {
  client: LlmClient;
  config: LlmModels;
}

let testClient: LlmClient | null = null;

/** 試験だけ：LLM を差し替える（null で戻す） */
export function setLlmForTest(client: LlmClient | null): void {
  testClient = client;
}

/** キーがないとき。呼ぶ前に断る（status null・やり直さない） */
const unavailableLlm: LlmClient = {
  provider: "anthropic",
  priceFor: (model) => CLAUDE_PRICES[model] ?? null,
  preflight: () => {
    throw new LlmError("ANTHROPIC_API_KEY が設定されていないので LLM を呼べない", null, false);
  },
  async generate() {
    throw new LlmError("ANTHROPIC_API_KEY が設定されていないので LLM を呼べない", null, false);
  },
};

/** env から Claude のクライアントとモデルを作る */
export function llmOf(env: Env): LlmSetup {
  const vars = env as unknown as Record<string, string | undefined>;
  const model = vars.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
  const config = { agentModel: model, plannerModel: model };
  if (testClient !== null) return { client: testClient, config };
  const apiKey = vars.ANTHROPIC_API_KEY?.trim();
  return { client: apiKey ? new ClaudeClient({ apiKey }) : unavailableLlm, config };
}
