// 状況の生成（FR-042）：仕事の定義・ツール・過去の失敗から、障害カタログの組み合わせ（状況）を Gemini に作らせる。
// - Gemini は responseJsonSchema（sim-core の Zod から作った JSON Schema）で呼び、返った JSON は Zod でもう一度確かめる。
//   カタログにない障害・任意のコード・この世界にない値・危険な文面は、そのケースだけ捨てる（BR-78 の考え方：作れるのは状況だけ）
// - 全滅したら1回だけ作り直し、それでも駄目なら明示的なエラー。件数は既定12・上限20（15「処理の流れ」2）
// - 同じシードで再現できるのは状況（シード・世界・並び）まで。Gemini の揺らぎは別
// - 費用（costMicroUsd）は返り値・エラーの両方に含める。呼び出し側が BR-62（1回 $3）と突き合わせる（cost.ts）

import type { LlmClient } from "@open-team/llm";
import { generatedScenariosJsonSchema, shopScenarioContext, toScenario } from "@open-team/sim-core";
import type { FaultSpec, Scenario, ScenarioContext } from "@open-team/sim-core";
import { z } from "zod";
import { addCosts, exceedsRehearsalBudget, type BudgetInput } from "./cost.ts";
import { caseSeed, catalogGuide, faultsKey, jobBlock, parseModelJson, vetScenarioDraft, withoutMaxItems, WRITING_RULES } from "./common.ts";
import type { JobBrief } from "./common.ts";
import { scenarioContextFor, withF14HostOf } from "./web-faults.ts";

export const DEFAULT_CASE_COUNT = 12;
export const MAX_CASE_COUNT = 20;
/** 1回の応答から読む状況の数の上限（スキーマの上限20より多いものは読まない） */
const MAX_RAW_SCENARIOS = 40;
/** 作り直しの指示に添える捨てた理由の数 */
const MAX_FEEDBACK_REASONS = 8;

export interface GenerateInput {
  job: JobBrief;
  /** 基のシード（uint32）。1件ごとのシードはここから決める（caseSeed） */
  seed: number;
  llm: LlmClient;
  /** 使うモデル（models.ts の modelForPurpose(env, "rehearsal_generate")。上位のモデル） */
  model: string;
  /** 件数（既定12。上限20を超えたら20に切る。1未満・整数でないものは例外） */
  count?: number;
  /** 状況を当てはめる世界（既定は仕入れ係の世界） */
  world?: ScenarioContext;
  /** 仕事に付与された Web の許可ドメイン（空・省略なら F-14 は作らない。F-14 の host はここから app が決める） */
  webAllowDomains?: readonly string[];
  /** 仕事に付与された connector の slug（gcal があるときだけ模擬のカレンダーの道具と F-15〜F-17 を出す。省略は付与なし） */
  connectorSlugs?: readonly string[];
  /** すでにその仕事にある試験の障害（同じ状況を作り直さない） */
  existingFaults?: readonly (readonly FaultSpec[])[];
  /** BR-62 の枠。使った分が上限を超えていたら Gemini を呼ばない／作り直さない */
  budget?: BudgetInput;
  signal?: AbortSignal;
}

export interface DroppedCase {
  /** 何回目の呼び出しの応答か（1 か 2） */
  attempt: 1 | 2;
  /** 応答の中の番号（0 から）。重複・件数の超過のときもその番号 */
  index: number;
  reasons: string[];
}

export interface GenerateResult {
  /** 確定した状況（シード・世界つき。並びは応答の順）。1件以上 */
  scenarios: Scenario[];
  /** 捨てたもの（検証に外れた・重複・件数の超過） */
  dropped: DroppedCase[];
  /** 実際に使った件数の目標（既定・上限を適用したあと） */
  requestedCount: number;
  /** Gemini を呼んだ回数（1 か 2） */
  attempts: 1 | 2;
  /** 使った費用の合計（マイクロドル）。BR-62 と突き合わせる */
  costMicroUsd: number;
  model: string;
}

export type GenerateErrorCode = "no_valid_scenarios" | "budget_exceeded";

/** 状況を作れなかった（全滅を1回作り直しても駄目・費用の上限を超えていた）。それまでにかかった費用は costMicroUsd */
export class RehearsalGenerateError extends Error {
  readonly code: GenerateErrorCode;
  readonly reasons: string[];
  readonly attempts: number;
  readonly costMicroUsd: number;
  constructor(code: GenerateErrorCode, message: string, detail: { reasons: string[]; attempts: number; costMicroUsd: number }) {
    super(message);
    this.name = "RehearsalGenerateError";
    this.code = code;
    this.reasons = detail.reasons;
    this.attempts = detail.attempts;
    this.costMicroUsd = detail.costMicroUsd;
  }
}

/** 件数を決める（既定12・上限20に切る）。1未満・整数でないものは例外 */
export function resolveCaseCount(count: number | undefined): number {
  if (count === undefined) return DEFAULT_CASE_COUNT;
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`count は 1 以上の整数にする：${String(count)}`);
  return Math.min(count, MAX_CASE_COUNT);
}

const RawEnvelopeSchema = z.object({ scenarios: z.array(z.unknown()) });

export function generateSystemPrompt(): string {
  return [
    "あなたは、エージェントに任せる仕事を本番に出す前の「リハーサル」で、起きてほしくない日（障害）の状況を作る担当です。",
    "仕事の定義・ツール・過去の失敗を読み、その仕事で現実に起きうる悪い日を、障害カタログの ID・パラメータ・模擬の世界に置く文面だけで表してください。",
    "あなたが作れるのは状況だけです。合否・ルール・許可の判断には関わりません。",
    "状況ごとに障害は1〜3個。状況どうしは障害の組み合わせか値を変え、同じものを繰り返さないでください。",
    "出力は指定の JSON だけです。",
    "",
    WRITING_RULES,
  ].join("\n");
}

export function generateUserPrompt(input: { job: JobBrief; world: ScenarioContext; count: number; feedback?: readonly string[] }): string {
  const parts = [
    jobBlock(input.job),
    "",
    catalogGuide(input.world),
    "",
    `# 依頼\n状況を ${input.count} 件作ってください（それ以下でもよい。重複は不可）。`,
  ];
  if (input.feedback && input.feedback.length > 0) {
    parts.push("", "# 前回の出力は次の理由で使えませんでした。直して作り直してください", ...input.feedback.slice(0, MAX_FEEDBACK_REASONS).map((r) => `- ${r}`));
  }
  return parts.join("\n");
}

/** 状況の生成。使える状況が1件もなければ RehearsalGenerateError */
export async function generateScenarios(input: GenerateInput): Promise<GenerateResult> {
  const count = resolveCaseCount(input.count);
  const allowDomains = input.webAllowDomains ?? [];
  const world = scenarioContextFor(input.world ?? shopScenarioContext(), allowDomains, input.connectorSlugs ?? []);
  const limit = input.budget?.limitMicroUsd;
  let cost = 0;
  const spent = (): number => addCosts(input.budget?.spentMicroUsd ?? 0, cost);
  const seen = new Set<string>((input.existingFaults ?? []).map((f) => faultsKey(f)));
  const keptDrafts: Array<{ title: string; faults: FaultSpec[]; rationale?: string | undefined }> = [];
  const dropped: DroppedCase[] = [];
  let feedback: string[] = [];

  for (const attempt of [1, 2] as const) {
    if (exceedsRehearsalBudget(spent(), limit)) {
      throw new RehearsalGenerateError("budget_exceeded", "リハーサルの費用の上限を超えているので、状況を作りません", {
        reasons: ["費用の上限を超えた"],
        attempts: attempt - 1,
        costMicroUsd: cost,
      });
    }
    const res = await input.llm.generate(
      {
        model: input.model,
        system: generateSystemPrompt(),
        messages: [{ role: "user", content: generateUserPrompt({ job: input.job, world, count, feedback }) }],
        tools: [],
        mcpTools: [],
        maxTokens: 16_384,
        temperature: 0.7,
        responseJsonSchema: withoutMaxItems(generatedScenariosJsonSchema()),
      },
      input.signal === undefined ? {} : { signal: input.signal },
    );
    cost = addCosts(cost, res.usage.costMicroUsd);

    const reasons: string[] = [];
    const json = parseModelJson(res.parts);
    const envelope = json.ok ? RawEnvelopeSchema.safeParse(json.value) : null;
    if (!json.ok) reasons.push(json.reason);
    else if (envelope && !envelope.success) reasons.push("scenarios の配列がない");
    else if (envelope?.success) {
      envelope.data.scenarios.slice(0, MAX_RAW_SCENARIOS).forEach((rawFromModel, index) => {
        const raw = withF14HostOf(rawFromModel, allowDomains);
        if (keptDrafts.length >= count) {
          dropped.push({ attempt, index, reasons: ["件数の上限を超えた"] });
          return;
        }
        const vet = vetScenarioDraft(raw, world);
        if (!vet.ok) {
          dropped.push({ attempt, index, reasons: vet.reasons });
          reasons.push(...vet.reasons.map((r) => `scenarios.${index}: ${r}`));
          return;
        }
        const key = faultsKey(vet.draft.faults);
        if (seen.has(key)) {
          dropped.push({ attempt, index, reasons: ["同じ障害・同じ値の状況がすでにある"] });
          reasons.push(`scenarios.${index}: 同じ障害・同じ値の状況がすでにある`);
          return;
        }
        seen.add(key);
        keptDrafts.push(vet.draft);
      });
    }
    if (keptDrafts.length > 0) {
      const scenarios = keptDrafts.map((d, i) => toScenario(d, { world: world.world, seed: caseSeed(input.seed, i), origin: { source: "generated" } }));
      return { scenarios, dropped, requestedCount: count, attempts: attempt, costMicroUsd: cost, model: res.model };
    }
    feedback = reasons;
    if (attempt === 2) {
      throw new RehearsalGenerateError("no_valid_scenarios", "使える状況を作れなかった（1回作り直しても全件が検証に外れた）", {
        reasons: reasons.length > 0 ? reasons : ["使える状況がなかった"],
        attempts: 2,
        costMicroUsd: cost,
      });
    }
  }
  /* c8 ignore next */
  throw new Error("到達しない");
}
