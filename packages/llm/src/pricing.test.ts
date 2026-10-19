import { describe, expect, it } from "vitest";
import {
  costMicroUsd,
  estimateMicroUsd,
  FALLBACK_PRICE,
  findPrice,
  normalizeModelId,
  PRICE_TABLE,
  priceFor,
  type TokenPrices,
} from "./pricing.ts";

/** 決まった種から同じ列を出す乱数（mulberry32）。性質の試験を決定論にする */
function rng(seed: number): (max: number) => number {
  let a = seed >>> 0;
  return (max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max + 1));
  };
}

const COMPONENTS = ["inputPerMTokMicroUsd", "outputPerMTokMicroUsd", "thinkingPerMTokMicroUsd"] as const;
const allPrices = (): TokenPrices[] => PRICE_TABLE.flatMap((p) => (p.longContext ? [p, p.longContext] : [p]));

describe("費用（BR-62・SO §3.12-6。整数のマイクロドル）", () => {
  it("SO-BUD-12：入力 1,000・出力 200・思考 300 → 入力×入力単価 ＋ (200＋300)×出力単価", () => {
    const p = priceFor("gemini-3.8-flash");
    const expected = Math.ceil((1_000 * p.inputPerMTokMicroUsd + (200 + 300) * p.outputPerMTokMicroUsd) / 1_000_000);
    expect(costMicroUsd("gemini-3.8-flash", { inputTokens: 1_000, outputTokens: 200, thinkingTokens: 300 })).toBe(expected);
    // 確かめた単価（入力 $1.50・出力 $7.50 / 100万）では $0.00525
    expect(expected).toBe(5_250);
  });

  it("思考のトークンは出力の単価（表のすべての行・20万トークン超も）", () => {
    for (const p of allPrices()) expect(p.thinkingPerMTokMicroUsd).toBe(p.outputPerMTokMicroUsd);
    expect(FALLBACK_PRICE.thinkingPerMTokMicroUsd).toBe(FALLBACK_PRICE.outputPerMTokMicroUsd);
  });

  it("1 マイクロドル未満は切り上げる（0.5 → 1、1.5 → 2）", () => {
    expect(costMicroUsd("gemini-3-flash-preview", { inputTokens: 1, outputTokens: 0, thinkingTokens: 0 })).toBe(1);
    expect(costMicroUsd("gemini-3.8-flash", { inputTokens: 1, outputTokens: 0, thinkingTokens: 0 })).toBe(2);
  });

  it("使った量が 0 なら 0", () => {
    expect(costMicroUsd("gemini-3.1-pro-preview", { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 })).toBe(0);
  });

  it("全部を足してから1回だけ切り上げる（0.3 ＋ 2.5 → 3。別々に切り上げると 4）", () => {
    expect(costMicroUsd("gemini-2.5-flash", { inputTokens: 1, outputTokens: 1, thinkingTokens: 0 })).toBe(3);
  });

  it("Pro 系は入力が 20万トークンを超えると、入力・出力・思考の全部を高い単価で数える（200,000 は通常）", () => {
    const usage = { outputTokens: 1_000, thinkingTokens: 1_000 };
    // 200,000 × $2 ＋ 2,000 × $12 = $0.424
    expect(costMicroUsd("gemini-3.1-pro-preview", { inputTokens: 200_000, ...usage })).toBe(424_000);
    // 200,001 × $4 ＋ 2,000 × $18 = $0.836004
    expect(costMicroUsd("gemini-3.1-pro-preview", { inputTokens: 200_001, ...usage })).toBe(836_004);
  });

  it("大きな数でも誤差なく数える（2^53 を超える途中の積）", () => {
    // 4,000,000,000 × 18,000,000 = 7.2e16 > 2^53
    expect(costMicroUsd("unknown-model", { inputTokens: 0, outputTokens: 4_000_000_000, thinkingTokens: 0 })).toBe(72_000_000_000);
    expect(costMicroUsd("unknown-model", { inputTokens: 0, outputTokens: 4_000_000_001, thinkingTokens: 0 })).toBe(72_000_000_018);
  });

  it("トークン数が負・小数・NaN・Infinity なら RangeError", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => costMicroUsd("gemini-3.8-flash", { inputTokens: bad, outputTokens: 0, thinkingTokens: 0 })).toThrow(RangeError);
      expect(() => costMicroUsd("gemini-3.8-flash", { inputTokens: 0, outputTokens: bad, thinkingTokens: 0 })).toThrow(RangeError);
      expect(() => costMicroUsd("gemini-3.8-flash", { inputTokens: 0, outputTokens: 0, thinkingTokens: bad })).toThrow(RangeError);
    }
  });

  it("費用は使用量について単調（どの項目を増やしても減らない：性質）", () => {
    const next = rng(7);
    const models = [...PRICE_TABLE.map((p) => p.model), "not-in-table"];
    for (let i = 0; i < 300; i++) {
      const model = models[next(models.length - 1)] ?? "not-in-table";
      const u = { inputTokens: next(400_000), outputTokens: next(20_000), thinkingTokens: next(20_000) };
      const base = costMicroUsd(model, u);
      expect(costMicroUsd(model, { ...u, inputTokens: u.inputTokens + 1 + next(1_000) })).toBeGreaterThanOrEqual(base);
      expect(costMicroUsd(model, { ...u, outputTokens: u.outputTokens + 1 + next(1_000) })).toBeGreaterThanOrEqual(base);
      expect(costMicroUsd(model, { ...u, thinkingTokens: u.thinkingTokens + 1 + next(1_000) })).toBeGreaterThanOrEqual(base);
    }
  });
});

describe("価格表にないモデル（費用の上限が甘くならない側）", () => {
  it("SO-BUD-16：表にないモデルは findPrice が null（呼ぶ前に断るなら edge がこれを見る）", () => {
    expect(findPrice("gemini-9-ultra")).toBeNull();
    expect(findPrice("")).toBeNull();
  });

  it("表にないモデルの費用は高めの既定の単価（FALLBACK_PRICE）", () => {
    expect(priceFor("gemini-9-ultra")).toBe(FALLBACK_PRICE);
    const usage = { inputTokens: 1_000, outputTokens: 100, thinkingTokens: 100 };
    expect(costMicroUsd("gemini-9-ultra", usage)).toBe(Math.ceil((1_000 * 4_000_000 + 200 * 18_000_000) / 1_000_000));
  });

  it("FALLBACK_PRICE は表のすべての単価（20万トークン超を含む）以上", () => {
    for (const p of allPrices()) {
      for (const k of COMPONENTS) expect(FALLBACK_PRICE[k]).toBeGreaterThanOrEqual(p[k]);
    }
  });

  it("同じ使用量なら、表にないモデルの費用は表のどのモデルより安くならない（性質）", () => {
    const next = rng(11);
    for (let i = 0; i < 300; i++) {
      const u = { inputTokens: next(500_000), outputTokens: next(16_000), thinkingTokens: next(16_000) };
      const unknown = costMicroUsd("not-in-table", u);
      for (const p of PRICE_TABLE) expect(unknown).toBeGreaterThanOrEqual(costMicroUsd(p.model, u));
    }
  });
});

describe("価格表", () => {
  it("単価は正の整数（マイクロドル / 100万トークン）、モデル ID は重ならない", () => {
    for (const p of [...allPrices(), FALLBACK_PRICE]) {
      for (const k of COMPONENTS) {
        expect(Number.isSafeInteger(p[k])).toBe(true);
        expect(p[k]).toBeGreaterThan(0);
      }
    }
    const ids = PRICE_TABLE.map((p) => normalizeModelId(p.model));
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PRICE_TABLE) expect(normalizeModelId(p.model)).toBe(p.model);
  });

  it("既定のモデル（gemini-3.8-flash・gemini-3.1-pro-preview）が表にある", () => {
    expect(findPrice("gemini-3.8-flash")).not.toBeNull();
    expect(findPrice("gemini-3.1-pro-preview")).not.toBeNull();
  });

  it("20万トークン超の単価は通常の単価以上", () => {
    for (const p of PRICE_TABLE) {
      if (p.longContext === undefined) continue;
      for (const k of COMPONENTS) expect(p.longContext[k]).toBeGreaterThanOrEqual(p[k]);
    }
  });

  it("モデル ID はリソース名・大文字・前後の空白をそろえて引く", () => {
    expect(normalizeModelId(" Publishers/Google/Models/Gemini-3.1-Pro ")).toBe("gemini-3.1-pro");
    expect(findPrice("projects/p/locations/global/publishers/google/models/gemini-3.1-pro-preview")?.model).toBe("gemini-3.1-pro-preview");
    expect(findPrice("google/gemini-3.8-flash")?.model).toBe("gemini-3.8-flash");
    expect(findPrice("GEMINI-2.5-FLASH")?.model).toBe("gemini-2.5-flash");
  });

  it("前方一致はしない（gemini-2.5-flash-lite を gemini-2.5-flash の単価で数えない・版の接尾辞は別のモデル）", () => {
    expect(findPrice("gemini-2.5-flash-lite")?.model).toBe("gemini-2.5-flash-lite");
    expect(findPrice("gemini-2.5-flash-001")).toBeNull();
    expect(findPrice("gemini-3.8")).toBeNull();
  });
});

describe("見積もり（SO §3.12-2：入力 × 入力単価 ＋ maxTokens × 出力単価 ＋ 思考の上限）", () => {
  it("入力・maxTokens・思考の上限から出す（思考の上限は省けば 0）", () => {
    // 10,000 × $1.5 ＋ 8,000 × $7.5 ＋ 2,000 × $7.5 = $0.09（100万トークンあたり）
    expect(estimateMicroUsd("gemini-3.8-flash", { inputTokens: 10_000, maxOutputTokens: 8_000, thinkingBudget: 2_000 })).toBe(90_000);
    expect(estimateMicroUsd("gemini-3.8-flash", { inputTokens: 10_000, maxOutputTokens: 8_000 })).toBe(75_000);
  });

  it("上限の内の実際の使用量の費用を下回らない（性質）", () => {
    const next = rng(3);
    const models = [...PRICE_TABLE.map((p) => p.model), "not-in-table"];
    for (let i = 0; i < 500; i++) {
      const model = models[next(models.length - 1)] ?? "not-in-table";
      const inputTokens = next(300_000);
      const maxOutputTokens = 1 + next(16_000);
      const thinkingBudget = next(8_000);
      const est = estimateMicroUsd(model, { inputTokens, maxOutputTokens, thinkingBudget });
      const actual = costMicroUsd(model, {
        inputTokens: next(inputTokens),
        outputTokens: next(maxOutputTokens),
        thinkingTokens: next(thinkingBudget),
      });
      expect(est).toBeGreaterThanOrEqual(actual);
    }
  });

  it("負の思考の上限（-1＝自動）は RangeError（上限が分からない見積もりは作らない）", () => {
    expect(() => estimateMicroUsd("gemini-3.8-flash", { inputTokens: 1, maxOutputTokens: 1, thinkingBudget: -1 })).toThrow(RangeError);
  });
});
