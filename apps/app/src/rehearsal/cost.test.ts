import { describe, expect, it } from "vitest";
import { addCosts, exceedsRehearsalBudget, REHEARSAL_BUDGET_MICRO_USD } from "./cost.ts";

describe("リハーサルの費用の上限（BR-62）", () => {
  it("上限は $3（3,000,000 マイクロドル。D-106）。累計が上限を超えたら true、ちょうど上限は false", () => {
    expect(REHEARSAL_BUDGET_MICRO_USD).toBe(3_000_000);
    expect(exceedsRehearsalBudget(0)).toBe(false);
    expect(exceedsRehearsalBudget(3_000_000)).toBe(false);
    expect(exceedsRehearsalBudget(3_000_001)).toBe(true);
  });

  it("上限を引数で替えられる（ゲストの1日 $4 など）", () => {
    expect(exceedsRehearsalBudget(1_000_000, 1_000_000)).toBe(false);
    expect(exceedsRehearsalBudget(1_000_001, 1_000_000)).toBe(true);
  });

  it("壊れた値（負・小数・NaN・Infinity）は超えたとみなす（締める側）", () => {
    for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(exceedsRehearsalBudget(bad)).toBe(true);
      expect(exceedsRehearsalBudget(0, bad)).toBe(true);
    }
  });

  it("addCosts は整数のマイクロドルを足す。壊れた値は例外", () => {
    expect(addCosts()).toBe(0);
    expect(addCosts(100, 250, 0)).toBe(350);
    expect(() => addCosts(1, -1)).toThrow(RangeError);
    expect(() => addCosts(1.5)).toThrow(RangeError);
  });
});
