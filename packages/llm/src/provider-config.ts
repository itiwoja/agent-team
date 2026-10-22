import { z } from "zod";
import { createHash } from "node:crypto";
import { readGeminiEnv, type GeminiEnv } from "./models.ts";
import type { PriceEntry } from "./pricing.ts";

export type LlmProvider = "gemini" | "anthropic" | "deepseek" | "openrouter";
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
  // DeepSeek と OpenRouter（OpenAI 互換）はどちらも max_tokens を受ける
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
  gemini: "GEMINI_API_KEY", anthropic: "ANTHROPIC_API_KEY", deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY",
};

/** OpenAI 互換の接続先は固定（利用者は変えられない。鍵の送り先を限る）。Claude は HTTP アダプターの固定 URL を使う */
export const PROVIDER_BASE_URLS: Partial<Record<LlmProvider, string>> = {
  deepseek: "https://api.deepseek.com",
  openrouter: "https://openrouter.ai/api/v1",
};

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
    baseUrl: PROVIDER_BASE_URLS[provider],
  };
}

/** 同じモデル名でも提供元・接続先・能力が変われば別のモデルとして見分ける識別子（API キーは含めない） */
export function providerModelIdentity(config: LlmConfig | undefined, model: string): string {
  if (!config || config.provider === "gemini") return model;
  const hash = createHash("sha256").update(JSON.stringify([config.provider, config.baseUrl ?? null, config.profiles[model] ?? null])).digest("hex").slice(0, 20);
  return `${config.provider}:${model}:${hash}`;
}

export function profilePrice(model: string, profile: ModelProfile): PriceEntry {
  return { model, inputPerMTokMicroUsd: profile.inputPerMTokMicroUsd, outputPerMTokMicroUsd: profile.outputPerMTokMicroUsd, thinkingPerMTokMicroUsd: profile.outputPerMTokMicroUsd };
}
