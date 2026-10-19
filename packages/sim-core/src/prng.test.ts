import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createPrng, hash32, isUint32, prngStateFor, prngStateFromSeed, type PrngState } from "./prng.ts";

describe("xoshiro128**（世界の乱数。SW §4.1.1）", () => {
  it("参照の実装と同じ列を出す（状態 [1,2,3,4]）", () => {
    const rng = createPrng([1, 2, 3, 4]);
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toEqual([11520, 0, 5927040, 70819200]);
  });

  it("引数の状態の配列を書き換えない（状態は写して使う）", () => {
    const s: PrngState = [1, 2, 3, 4];
    const rng = createPrng(s);
    rng.nextUint32();
    expect(s).toEqual([1, 2, 3, 4]);
    expect(rng.state()).not.toEqual([1, 2, 3, 4]);
  });

  it("保存した状態から続きを引ける（jsonb に持ち越す）", () => {
    const a = createPrng(prngStateFromSeed(42));
    a.nextUint32();
    const saved = JSON.parse(JSON.stringify(a.state())) as PrngState;
    const b = createPrng(saved);
    expect([b.nextUint32(), b.nextUint32()]).toEqual([a.nextUint32(), a.nextUint32()]);
  });

  it("FNV-1a の既知の値", () => {
    expect(hash32("")).toBe(0x811c9dc5);
    expect(hash32("a")).toBe(0xe40c292c);
  });

  it("目的ごとに別の列になる（seed ^ hash32(purpose)）", () => {
    expect(prngStateFor(7, "sales")).not.toEqual(prngStateFor(7, "canary"));
    expect(prngStateFor(7, "sales")).toEqual(prngStateFor(7, "sales"));
  });

  it("seed は uint32 の整数だけ（境界：0 と 2^32-1 は通る、-1・2^32・小数は例外）", () => {
    expect(() => prngStateFromSeed(0)).not.toThrow();
    expect(() => prngStateFromSeed(0xffff_ffff)).not.toThrow();
    for (const bad of [-1, 0x1_0000_0000, 1.5, Number.NaN]) expect(() => prngStateFromSeed(bad)).toThrow(RangeError);
    expect(isUint32(0xffff_ffff)).toBe(true);
    expect(isUint32("1")).toBe(false);
  });

  it("性質：同じ seed なら同じ列、nextFloat は [0, 1)、状態は4つとも0にならない", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), (seed) => {
        const s = prngStateFromSeed(seed);
        expect(s.some((x) => x !== 0)).toBe(true);
        const a = createPrng(s);
        const b = createPrng(prngStateFromSeed(seed));
        for (let i = 0; i < 20; i++) {
          const x = a.nextFloat();
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(1);
          expect(b.nextFloat()).toBe(x);
        }
      }),
      { numRuns: 200 },
    );
  });
});
