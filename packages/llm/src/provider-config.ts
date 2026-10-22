import { z } from "zod";
import { createHash } from "node:crypto";
import { readGeminiEnv, type GeminiEnv } from "./models.ts";
import type { PriceEntry } from "./pricing.ts";

/** 接続先が固定の OpenAI 互換（Chat Completions）の提供元 */
export const OPENAI_COMPATIBLE_PROVIDERS = ["openai", "deepseek", "openrouter", "xai", "groq", "mistral", "together", "fireworks", "cerebras", "moonshot", "zai", "qwen"] as const;
/** custom は運用者が接続先（LLM_BASE_URL）を決める OpenAI 互換。上の一覧にない API キーはこれで使う */
export type LlmProvider = "gemini" | "anthropic" | (typeof OPENAI_COMPATIBLE_PROVIDERS)[number] | "custom";
const positive = z.number().int().positive().max(1_000_000_000);
/** Rates are administrator-supplied upper bounds in micro USD / million tokens. */
export const ModelProfileSchema = z.object({
  inputPerMTokMicroUsd: positive,
  outputPerMTokMicroUsd: positive,
  tools: z.boolean(),
  structuredOutput: z.enum(["tool", "json_schema", "none"]),
  temperature: z.boolean(),
  anthropicMode: z.literal("haiku55-no-thinking").optional(),
  reasoningEffort: z.boolean().default(false),
  maxOutputTokens: positive,
  contextWindow: positive,
  // OpenAI 互換の多くは max_tokens を受ける（OpenAI の推論モデルなどは max_completion_tokens を明示）
  tokenLimitParameter: z.enum(["max_completion_tokens", "max_tokens"]).default("max_tokens"),
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;
export interface LlmConfig extends GeminiEnv {
  provider: LlmProvider;
  baseUrl?: string;
  profiles: Readonly<Record<string, ModelProfile>>;
  /** Optional process-local trial cap; not persisted and not a provider invoice guarantee. */
  sessionBudgetMicroUsd?: number;
  trialLedgerPath?: string;
}
export class LlmConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "LlmConfigurationError"; }
}
const value = (s: string | undefined): string | undefined => s?.trim() || undefined;
export const PROVIDER_KEY_NAMES: Record<LlmProvider, string> = {
  gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY", groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY", together: "TOGETHER_API_KEY", fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY", moonshot: "MOONSHOT_API_KEY", zai: "ZAI_API_KEY", qwen: "DASHSCOPE_API_KEY", custom: "LLM_API_KEY",
};

/** 名前のある OpenAI 互換の接続先は固定（利用者は変えられない。鍵の送り先を限る）。Claude は HTTP アダプターの固定 URL を使う */
export const PROVIDER_BASE_URLS: Partial<Record<LlmProvider, string>> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  cerebras: "https://api.cerebras.ai/v1",
  moonshot: "https://api.moonshot.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * custom の接続先（LLM_BASE_URL）。https のみ（手元のサーバー localhost・127.0.0.1・[::1] は http も可）。
 * 鍵を URL に混ぜないよう、ユーザー名・パスワード・クエリ・フラグメントは拒否する。末尾の / は外す
 */
export function customBaseUrl(raw: string | undefined): string {
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { throw new LlmConfigurationError("LLM_PROVIDER=custom には LLM_BASE_URL（https://…/v1 など）が必要です"); }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) throw new LlmConfigurationError("LLM_BASE_URL は https（手元のサーバーのみ http 可）で、認証情報・クエリを含めないでください");
  return url.href.replace(/\/+$/, "");
}

/** provider の接続先。custom だけ設定値を検査して使う。Claude と Gemini は undefined（アダプター側の固定 URL） */
export function providerBaseUrl(provider: LlmProvider, customUrl: string | undefined): string | undefined {
  return provider === "custom" ? customBaseUrl(customUrl) : PROVIDER_BASE_URLS[provider];
}

export function readLlmEnv(source: NodeJS.ProcessEnv = process.env): LlmConfig {
  const raw = value(source.LLM_PROVIDER) ?? "gemini";
  if (!Object.hasOwn(PROVIDER_KEY_NAMES, raw)) throw new LlmConfigurationError("LLM_PROVIDER が未対応です");
  const provider = raw as LlmProvider;
  const budgetRaw = value(source.LLM_SESSION_BUDGET_MICRO_USD);
  const budget = budgetRaw === undefined ? undefined : Number(budgetRaw);
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) throw new LlmConfigurationError("LLM_SESSION_BUDGET_MICRO_USD は正の整数にしてください");
  const trialLedgerPath = value(source.LLM_TRIAL_LEDGER_PATH);
  if (trialLedgerPath && budget === undefined) throw new LlmConfigurationError("LLM_TRIAL_LEDGER_PATH には試験上限の指定も必要です");
  const budgetConfig = budget === undefined ? {} : { sessionBudgetMicroUsd: budget, ...(trialLedgerPath ? { trialLedgerPath } : {}) };
  const legacy = readGeminiEnv(source);
  if (provider === "gemini") return { ...legacy, provider, profiles: {}, ...budgetConfig, agentModel: value(source.LLM_MODEL_AGENT) ?? legacy.agentModel, plannerModel: value(source.LLM_MODEL_PLANNER) ?? legacy.plannerModel };
  const agentModel = value(source.LLM_MODEL_AGENT);
  const plannerModel = value(source.LLM_MODEL_PLANNER) ?? agentModel;
  if (!agentModel || !plannerModel) throw new LlmConfigurationError("LLM_MODEL_AGENT（任意でLLM_MODEL_PLANNER）を設定してください");
  let profiles: Record<string, ModelProfile>;
  try {
    profiles = z.record(z.string().min(1).max(200), ModelProfileSchema).parse(JSON.parse(source.LLM_MODELS_JSON ?? ""));
  } catch { throw new LlmConfigurationError("LLM_MODELS_JSON にモデルごとの正の料金・能力・上限を明示してください（設定値は非表示）"); }
  const compareModels = [...new Set((source.LLM_MODELS_COMPARE ?? "").split(",").map(s => s.trim()).filter(Boolean))];
  for (const model of [agentModel, plannerModel, ...compareModels]) {
    if (!Object.hasOwn(profiles, model)) throw new LlmConfigurationError("選択モデルが LLM_MODELS_JSON に登録されていません");
  }
  return { provider, apiKey: value(source[PROVIDER_KEY_NAMES[provider]]), agentModel, plannerModel, compareModels, profiles, ...budgetConfig,
    baseUrl: providerBaseUrl(provider, value(source.LLM_BASE_URL)),
  };
}

/** Certificates must not survive a provider/endpoint/capability switch under the same model name. */
export function providerModelIdentity(config: LlmConfig | undefined, model: string): string {
  if (!config || config.provider === "gemini") return model;
  const hash = createHash("sha256").update(JSON.stringify([config.provider, config.baseUrl ?? null, config.profiles[model] ?? null])).digest("hex").slice(0, 20);
  return `${config.provider}:${model}:${hash}`;
}

export function profilePrice(model: string, profile: ModelProfile): PriceEntry {
  return { model, inputPerMTokMicroUsd: profile.inputPerMTokMicroUsd, outputPerMTokMicroUsd: profile.outputPerMTokMicroUsd, thinkingPerMTokMicroUsd: profile.outputPerMTokMicroUsd };
}
