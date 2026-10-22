// Worker の LLM（docs/cloudflare-design.md）。キーと設定は Workers secrets・vars（ローカルは .dev.vars）から、Node 版と同じ readLlmEnv で読む
// （LLM_PROVIDER・GEMINI_API_KEY・LLM_MODEL_AGENT など。apps/app/src/deps.ts の組み立てと同じ）。キーがなければ呼ぶ前に断るクライアントにする。
// やり直しは edge/llm-call.ts の callLlm の1か所で数えるので、クライアントは「1回だけ呼ぶ」設定で作る。
// 試験は setLlmForTest で ScriptedLlmClient に差し替える（Workflow も試験と同じ isolate で動くので、モジュールの変数が見える）

import { createLlmClient, findPrice, LlmError, PROVIDER_KEY_NAMES, profilePrice, readLlmEnv, type LlmClient, type LlmConfig } from "@open-team/llm";

export interface LlmSetup {
  client: LlmClient;
  config: LlmConfig;
}

let testClient: LlmClient | null = null;

/** 試験だけ：LLM を差し替える（null で戻す） */
export function setLlmForTest(client: LlmClient | null): void {
  testClient = client;
}

/** キーがないとき。呼ぶ前に断る（status null・やり直さない） */
function unavailableLlm(config: LlmConfig): LlmClient {
  const keyName = PROVIDER_KEY_NAMES[config.provider];
  const unavailable = (): never => {
    throw new LlmError(`${keyName} が設定されていないので LLM を呼べない`, null, false);
  };
  return {
    priceFor: (model) => (config.provider === "gemini" ? findPrice(model) : Object.hasOwn(config.profiles, model) ? profilePrice(model, config.profiles[model]!) : null),
    preflight: unavailable,
    async generate() {
      return unavailable();
    },
  };
}

/** env から LLM のクライアントと設定を作る（設定が壊れていれば LlmConfigurationError） */
export function llmOf(env: Env): LlmSetup {
  const config = readLlmEnv(env as unknown as NodeJS.ProcessEnv);
  if (testClient !== null) return { client: testClient, config };
  return { client: config.apiKey ? createLlmClient(config) : unavailableLlm(config), config };
}
