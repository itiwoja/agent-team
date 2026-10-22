// 使うモデル（SO §2.2・§9 I-03）
// エージェントの推論・要約は Flash 系、設定プランナーは上位のモデル。
// 版つきの ID にする（別名が裏で替わると、同じ名前で中身の違うモデルを呼ぶことになる：SO I-03）

import type { LlmPhase } from "@open-team/runner";

/** エージェントの推論（GEMINI_MODEL_AGENT の既定） */
export const DEFAULT_AGENT_MODEL = "gemini-3.8-flash";
/** 設定プランナー・状況の生成（GEMINI_MODEL_PLANNER の既定）。エージェントと同じ gemini-3.8-flash に固定している */
export const DEFAULT_PLANNER_MODEL = "gemini-3.8-flash";

export interface GeminiEnv {
  /** GEMINI_API_KEY（ログ・応答に出さない。platform の SECRET_ENV_NAMES でマスクする） */
  apiKey: string | undefined;
  /** GEMINI_MODEL_AGENT */
  agentModel: string;
  /** GEMINI_MODEL_PLANNER */
  plannerModel: string;
  /** GEMINI_MODELS_COMPARE（カンマ区切り。FR-068 のモデルの比較。Should） */
  compareModels: string[];
}

export function readGeminiEnv(source: NodeJS.ProcessEnv = process.env): GeminiEnv {
  return {
    apiKey: valueOf(source.GEMINI_API_KEY),
    agentModel: valueOf(source.GEMINI_MODEL_AGENT) ?? DEFAULT_AGENT_MODEL,
    plannerModel: valueOf(source.GEMINI_MODEL_PLANNER) ?? DEFAULT_PLANNER_MODEL,
    compareModels: [...new Set((source.GEMINI_MODELS_COMPARE ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""))],
  };
}

/** 足りない変数の名前だけを返す（値は出さない：D-47） */
export function missingGeminiEnv(source: NodeJS.ProcessEnv = process.env): string[] {
  return valueOf(source.GEMINI_API_KEY) === undefined ? ["GEMINI_API_KEY"] : [];
}

/** 上位のモデル ／ Flash 系（SO §2.6 GeminiModelRole） */
export type GeminiModelRole = "agent" | "planner";
/** Gemini を呼ぶ目的（SO §2.6）。model_comparison（FR-068）は比べるモデルを呼ぶ側が compareModels から選ぶ */
export type GeminiPurpose =
  | "agent"
  | "summary"
  | "planner"
  | "model_comparison";

/** LLM Proxy の phase。0-H はどの段階も Flash 系（formation-runtime.md §8-7） */
export const MODEL_ROLE_BY_PHASE: Readonly<Record<LlmPhase, GeminiModelRole>> = {
  investigate: "agent",
  plan: "agent",
  implement: "agent",
  review: "agent",
  report: "agent",
};

/** 設定プランナーは上位、要約は Flash 系（15_hackathon.md:587） */
export const MODEL_ROLE_BY_PURPOSE: Readonly<Record<Exclude<GeminiPurpose, "model_comparison">, GeminiModelRole>> = {
  agent: "agent",
  summary: "agent",
  planner: "planner",
};

export function modelForRole(env: Pick<GeminiEnv, "agentModel" | "plannerModel">, role: GeminiModelRole): string {
  return role === "planner" ? env.plannerModel : env.agentModel;
}

/** LLM Proxy（edge の llmMessages）の Router：phase → モデル（formation-runtime.md §3.10-4） */
export function modelForPhase(env: Pick<GeminiEnv, "agentModel" | "plannerModel">, phase: LlmPhase): string {
  return modelForRole(env, MODEL_ROLE_BY_PHASE[phase]);
}

export function modelForPurpose(
  env: Pick<GeminiEnv, "agentModel" | "plannerModel">,
  purpose: Exclude<GeminiPurpose, "model_comparison">,
): string {
  return modelForRole(env, MODEL_ROLE_BY_PURPOSE[purpose]);
}

/** 前後の空白を除き、空は「ない」とみなす */
function valueOf(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  return v === undefined || v === "" ? undefined : v;
}
