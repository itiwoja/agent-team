// 使うモデルと Vertex AI の場所（15_hackathon.md:587、SO §2.2・§9 I-03）
// エージェントの推論・要約は Flash 系、設定プランナー・状況の生成（解釈・締める提案を含む）は上位のモデル。
// モデル ID は 2026-10-03 に Vertex AI（global）へ実際に呼んで確かめた。版つきの ID にする（別名が裏で替わると、合格証の「モデルの変更」が働かない：SO I-03）

import type { LlmPhase } from "@open-team/runner";

/** エージェントの推論（GEMINI_MODEL_AGENT の既定） */
export const DEFAULT_AGENT_MODEL = "gemini-3.8-flash";
/** 設定プランナー・状況の生成（GEMINI_MODEL_PLANNER の既定）。エージェントと同じ gemini-3.8-flash に固定している */
export const DEFAULT_PLANNER_MODEL = "gemini-3.8-flash";
/** GOOGLE_CLOUD_LOCATION の既定。3 系は global だけで、asia-northeast1 には 2.5 Flash までしかない（2026-10-03 に確かめた。SO I-03） */
export const DEFAULT_GEMINI_LOCATION = "global";

export interface GeminiEnv {
  /** GOOGLE_CLOUD_PROJECT */
  project: string | undefined;
  /** GOOGLE_CLOUD_LOCATION */
  location: string;
  /** GEMINI_MODEL_AGENT */
  agentModel: string;
  /** GEMINI_MODEL_PLANNER */
  plannerModel: string;
  /** GEMINI_MODELS_COMPARE（カンマ区切り。FR-068 のモデルの比較。Should） */
  compareModels: string[];
}

export function readGeminiEnv(source: NodeJS.ProcessEnv = process.env): GeminiEnv {
  return {
    project: valueOf(source.GOOGLE_CLOUD_PROJECT),
    location: valueOf(source.GOOGLE_CLOUD_LOCATION) ?? DEFAULT_GEMINI_LOCATION,
    agentModel: valueOf(source.GEMINI_MODEL_AGENT) ?? DEFAULT_AGENT_MODEL,
    plannerModel: valueOf(source.GEMINI_MODEL_PLANNER) ?? DEFAULT_PLANNER_MODEL,
    compareModels: [...new Set((source.GEMINI_MODELS_COMPARE ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""))],
  };
}

/** 置いてはいけない変数（Gemini は IAM で呼び、鍵の経路を作らない：ADR-032、SO §2.2） */
export const FORBIDDEN_GEMINI_ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/** 足りない・置いてはいけない変数の名前だけを返す（値は出さない：D-47。public では準備中の理由にする：SO-ENV-07） */
export function missingGeminiEnv(source: NodeJS.ProcessEnv = process.env): string[] {
  const names: string[] = [];
  if (valueOf(source.GOOGLE_CLOUD_PROJECT) === undefined) names.push("GOOGLE_CLOUD_PROJECT");
  for (const name of FORBIDDEN_GEMINI_ENV) if (valueOf(source[name]) !== undefined) names.push(name);
  return names;
}

/** 上位のモデル ／ Flash 系（SO §2.6 GeminiModelRole） */
export type GeminiModelRole = "agent" | "planner";
/** Gemini を呼ぶ目的（SO §2.6）。model_comparison（FR-068）は比べるモデルを呼ぶ側が compareModels から選ぶ */
export type GeminiPurpose =
  | "agent"
  | "summary"
  | "planner"
  | "rehearsal_generate"
  | "rehearsal_interpret"
  | "rehearsal_tighten"
  | "model_comparison";

/** LLM Proxy の phase。0-H はどの段階も Flash 系（formation-runtime.md §8-7） */
export const MODEL_ROLE_BY_PHASE: Readonly<Record<LlmPhase, GeminiModelRole>> = {
  investigate: "agent",
  plan: "agent",
  implement: "agent",
  review: "agent",
  report: "agent",
};

/** 状況の生成・解釈・締める提案は上位（SW:766・855・916）、要約は Flash 系（15_hackathon.md:587） */
export const MODEL_ROLE_BY_PURPOSE: Readonly<Record<Exclude<GeminiPurpose, "model_comparison">, GeminiModelRole>> = {
  agent: "agent",
  summary: "agent",
  planner: "planner",
  rehearsal_generate: "planner",
  rehearsal_interpret: "planner",
  rehearsal_tighten: "planner",
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
