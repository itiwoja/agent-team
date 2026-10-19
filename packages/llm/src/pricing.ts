// モデルごとの単価と費用（BR-62。金額は整数のマイクロドルで比べる：SO §2.6・§3.12、SW U-16）
// 単価は「100万トークンあたりの整数のマイクロドル」（$0.50/100万 → 500_000）。思考のトークンは出力の単価で数える（SO §3.12-6）。
// 費用は全部を足してから 1 マイクロドル未満を切り上げる（費用の上限が甘くならない側）。
// 07_architecture.md:284 の価格表（pricing.json）に当たる。単価は 2026-10-03 に Cloud Billing Catalog API（Vertex AI、サービス C7E2-9256-1C43、
// global・通常の呼び出し）で確かめた値。3 系の SKU に思考の別の行はなく「Text Output」に含まれるので、思考は出力の単価で数える

export interface TokenPrices {
  inputPerMTokMicroUsd: number;
  outputPerMTokMicroUsd: number;
  thinkingPerMTokMicroUsd: number;
}

export interface PriceEntry extends TokenPrices {
  /** モデル ID（normalizeModelId の形） */
  model: string;
  /** 入力がこのトークン数を超える呼び出しは、入力・出力・思考の全部をこの単価で数える（Pro 系の 20万トークン超） */
  longContext?: TokenPrices & { overInputTokens: number };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

const PRO_LONG_CONTEXT = {
  overInputTokens: 200_000,
  inputPerMTokMicroUsd: 4_000_000,
  outputPerMTokMicroUsd: 18_000_000,
  thinkingPerMTokMicroUsd: 18_000_000,
} as const;

export const PRICE_TABLE: readonly PriceEntry[] = [
  // 既定のエージェント（Flash 系。models.ts）。SKU「Gemini 3.8 Flash Global Text Input / Output - Predictions」
  { model: "gemini-3.8-flash", inputPerMTokMicroUsd: 1_500_000, outputPerMTokMicroUsd: 7_500_000, thinkingPerMTokMicroUsd: 7_500_000 },
  // 既定の上位のモデル（設定プランナー・状況の生成）。SKU「Gemini 3.0 / 3.1 Pro Text Input / Output (Long)」（gemini-3.1-pro は 404。preview だけ）
  { model: "gemini-3.1-pro-preview", inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 12_000_000, thinkingPerMTokMicroUsd: 12_000_000, longContext: PRO_LONG_CONTEXT },
  { model: "gemini-3-pro-preview", inputPerMTokMicroUsd: 2_000_000, outputPerMTokMicroUsd: 12_000_000, thinkingPerMTokMicroUsd: 12_000_000, longContext: PRO_LONG_CONTEXT },
  // 比べる候補・替え（FR-068。費用を抑えるときの Flash 系）
  { model: "gemini-3.5-flash", inputPerMTokMicroUsd: 1_500_000, outputPerMTokMicroUsd: 9_000_000, thinkingPerMTokMicroUsd: 9_000_000 },
  { model: "gemini-3-flash-preview", inputPerMTokMicroUsd: 500_000, outputPerMTokMicroUsd: 3_000_000, thinkingPerMTokMicroUsd: 3_000_000 },
  { model: "gemini-3.5-flash-lite", inputPerMTokMicroUsd: 300_000, outputPerMTokMicroUsd: 2_500_000, thinkingPerMTokMicroUsd: 2_500_000 },
  { model: "gemini-3.1-flash-lite", inputPerMTokMicroUsd: 250_000, outputPerMTokMicroUsd: 1_500_000, thinkingPerMTokMicroUsd: 1_500_000 },
  {
    model: "gemini-2.5-pro",
    inputPerMTokMicroUsd: 1_250_000,
    outputPerMTokMicroUsd: 10_000_000,
    thinkingPerMTokMicroUsd: 10_000_000,
    longContext: { overInputTokens: 200_000, inputPerMTokMicroUsd: 2_500_000, outputPerMTokMicroUsd: 15_000_000, thinkingPerMTokMicroUsd: 15_000_000 },
  },
  // asia-northeast1 にもある（3 系は global だけ。2026-10-03 に確かめた）
  { model: "gemini-2.5-flash", inputPerMTokMicroUsd: 300_000, outputPerMTokMicroUsd: 2_500_000, thinkingPerMTokMicroUsd: 2_500_000 },
  { model: "gemini-2.5-flash-lite", inputPerMTokMicroUsd: 100_000, outputPerMTokMicroUsd: 400_000, thinkingPerMTokMicroUsd: 400_000 },
];

/**
 * 価格表にないモデルの単価。表のどの単価（20万トークン超を含む）より低くしない（費用の上限が甘くならない側。試験で確かめる）。
 * 07_architecture.md:284・SO-BUD-16 は「表にないモデルは呼ばない」：GeminiClient は既定で呼ばず（LlmError）、edge の callGemini も
 * 呼ぶ前に findPrice() の null で断る（SO §3.12-2）。allowUnpricedModels を明示したとき（計測の --allow-unpriced）だけ、この単価で数えて呼ぶ
 */
export const FALLBACK_PRICE: PriceEntry = {
  model: "*",
  inputPerMTokMicroUsd: 4_000_000,
  outputPerMTokMicroUsd: 18_000_000,
  thinkingPerMTokMicroUsd: 18_000_000,
};

/** 'publishers/google/models/gemini-x'・'google/gemini-x'・大文字を 'gemini-x' にそろえる（版の接尾辞は外さない：別のモデルとして数える） */
export function normalizeModelId(model: string): string {
  const id = model.trim().toLowerCase();
  return id.slice(id.lastIndexOf("/") + 1);
}

const PRICE_BY_MODEL: ReadonlyMap<string, PriceEntry> = new Map(PRICE_TABLE.map((p) => [normalizeModelId(p.model), p]));

/** 価格表の行。表にないモデルは null（前方一致はしない：gemini-2.5-flash-lite を gemini-2.5-flash の単価で数えない） */
export function findPrice(model: string): PriceEntry | null {
  return PRICE_BY_MODEL.get(normalizeModelId(model)) ?? null;
}

/** Google 検索の Grounding の1回の検索（Gemini 3 系：1,000回 $14。トークンとは別に数える） */
export const GROUNDING_QUERY_MICRO_USD = 14_000;
/** 呼ぶ前の見積もりで数える検索の回数（1回の呼び出しでモデルが投げる検索の上限の目安。超えた分も実費には数える） */
export const GROUNDING_QUERIES_ESTIMATE = 5;

/** 価格表の行。表にないモデルは FALLBACK_PRICE */
export function priceFor(model: string): PriceEntry {
  return findPrice(model) ?? FALLBACK_PRICE;
}

/** 実費（整数のマイクロドル。切り上げ）。usageMetadata から出したトークン数で数える */
export function costMicroUsd(model: string, usage: TokenUsage): number {
  return computeMicroUsd(priceFor(model), usage.inputTokens, usage.outputTokens, usage.thinkingTokens);
}

/**
 * 呼ぶ前の見積もり（SO §3.12-2：入力 × 入力単価 ＋ maxTokens × 出力単価 ＋ 思考の上限 × 思考の単価。04_functional_spec/runtime.md:139）。
 * 実際の使用量が inputTokens 以下・出力 maxOutputTokens 以下・思考 thinkingBudget 以下なら、実費はこれを超えない
 */
export function estimateMicroUsd(
  model: string,
  e: { inputTokens: number; maxOutputTokens: number; thinkingBudget?: number },
): number {
  return computeMicroUsd(priceFor(model), e.inputTokens, e.maxOutputTokens, e.thinkingBudget ?? 0);
}

function computeMicroUsd(price: PriceEntry, input: number, output: number, thinking: number): number {
  assertTokens("inputTokens", input);
  assertTokens("outputTokens", output);
  assertTokens("thinkingTokens", thinking);
  const p = price.longContext !== undefined && input > price.longContext.overInputTokens ? price.longContext : price;
  // 2^53 を超えうるので BigInt で掛けて足し、最後に1回だけ切り上げる
  const total =
    BigInt(input) * BigInt(p.inputPerMTokMicroUsd) +
    BigInt(output) * BigInt(p.outputPerMTokMicroUsd) +
    BigInt(thinking) * BigInt(p.thinkingPerMTokMicroUsd);
  return Number((total + 999_999n) / 1_000_000n);
}

function assertTokens(name: string, n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} は0以上の整数（${String(n)}）`);
}
