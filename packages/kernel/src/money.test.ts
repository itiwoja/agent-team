import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatUsd, fromMicroUsd, toMicroUsd } from "./money.ts";

describe("toMicroUsd（KD §8-12）", () => {
  it("J10：toMicroUsd(0.1) + toMicroUsd(0.2) > toMicroUsd(0.3) は偽（浮動小数のままだと真）", () => {
    expect(0.1 + 0.2 > 0.3).toBe(true);
    expect(toMicroUsd(0.1) + toMicroUsd(0.2) > toMicroUsd(0.3)).toBe(false);
    expect(toMicroUsd(0.1) + toMicroUsd(0.2)).toBe(toMicroUsd(0.3));
  });

  it("B6 の境界：0.1 + 0.2 は 0.3 を超えない", () => {
    expect(toMicroUsd(0.1) + toMicroUsd(0.2) > toMicroUsd(0.3)).toBe(false);
  });

  it("Math.round(x * 1e6) の整数にする", () => {
    expect(toMicroUsd(0)).toBe(0);
    expect(toMicroUsd(1)).toBe(1_000_000);
    expect(toMicroUsd(0.150001)).toBe(150_001);
    expect(toMicroUsd(0.012345)).toBe(12_345);
    expect(toMicroUsd(0.0000004)).toBe(0);
    expect(toMicroUsd(0.0000006)).toBe(1);
    expect(Object.is(toMicroUsd(-0), 0)).toBe(true);
    expect(Object.is(toMicroUsd(-0.0000001), 0)).toBe(true);
  });

  it("有限でない値は例外（判定できないなら許可しない：NFR-005）", () => {
    expect(() => toMicroUsd(Number.NaN)).toThrow(TypeError);
    expect(() => toMicroUsd(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => toMicroUsd(undefined as unknown as number)).toThrow(TypeError);
    expect(() => toMicroUsd("0.1" as unknown as number)).toThrow(TypeError);
  });

  it("性質：6桁までの金額は往復で戻り、足し算が整数で正確", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), fc.integer({ min: 0, max: 10_000_000_000 }), (a, b) => {
        expect(toMicroUsd(fromMicroUsd(a))).toBe(a);
        expect(toMicroUsd(fromMicroUsd(a)) + toMicroUsd(fromMicroUsd(b))).toBe(a + b);
      }),
    );
  });
});

describe("fromMicroUsd", () => {
  it("マイクロドル → USD", () => {
    expect(fromMicroUsd(1_120_000)).toBe(1.12);
    expect(fromMicroUsd(0)).toBe(0);
    expect(() => fromMicroUsd(Number.NaN)).toThrow(TypeError);
  });
});

describe("formatUsd（09_api/common.md:47 の6桁の文字列）", () => {
  it("小数点以下6桁", () => {
    expect(formatUsd(0.012345)).toBe("0.012345");
    expect(formatUsd(1.12)).toBe("1.120000");
    expect(formatUsd(0)).toBe("0.000000");
    expect(formatUsd(10)).toBe("10.000000");
    expect(formatUsd(0.1 + 0.2)).toBe("0.300000");
    expect(formatUsd(123.4567894)).toBe("123.456789");
    expect(formatUsd(-0.000001)).toBe("-0.000001");
    expect(formatUsd(-2.5)).toBe("-2.500000");
  });

  it("性質：formatUsd の文字列を読み直すと同じマイクロドル", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }), (micro) => {
        const s = formatUsd(fromMicroUsd(micro));
        expect(s).toMatch(/^-?\d+\.\d{6}$/);
        expect(toMicroUsd(Number(s))).toBe(micro);
      }),
    );
  });
});
