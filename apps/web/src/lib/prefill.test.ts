import { describe, expect, it } from "vitest";
import { PREFILL_MAX, pickExamples, readPrefill, readPrepared } from "./prefill";

describe("readPrepared（審査用のトークンで入った直後の、用意した依頼の id：D-118）", () => {
  it("?prepared= の id を返す。無い・空のときは null", () => {
    expect(readPrepared("?prepared=00000000-0000-4000-8000-000000000001")).toBe("00000000-0000-4000-8000-000000000001");
    expect(readPrepared("?prepared=%20")).toBeNull();
    expect(readPrepared("")).toBeNull();
    expect(readPrepared("?text=abc")).toBeNull();
  });
});

describe("readPrefill（頼み直しの文）", () => {
  it("?text= の文を URL デコードして返す", () => {
    expect(readPrefill(`?text=${encodeURIComponent("在庫を見て、発注して")}`)).toBe("在庫を見て、発注して");
  });

  it("前後の空白は落とす", () => {
    expect(readPrefill(`?text=${encodeURIComponent("  毎朝7時に  ")}`)).toBe("毎朝7時に");
  });

  it("無い・空・空白だけのときは null", () => {
    expect(readPrefill("")).toBeNull();
    expect(readPrefill("?other=1")).toBeNull();
    expect(readPrefill("?text=")).toBeNull();
    expect(readPrefill(`?text=${encodeURIComponent(" \n　 ")}`)).toBeNull();
  });

  it("2000字を超える分は切り詰める", () => {
    const long = "あ".repeat(PREFILL_MAX + 5);
    const got = readPrefill(`?text=${encodeURIComponent(long)}`);
    expect(got).toHaveLength(PREFILL_MAX);
    expect(got).toBe("あ".repeat(PREFILL_MAX));
  });

  it("ちょうど2000字はそのまま", () => {
    const exact = "い".repeat(PREFILL_MAX);
    expect(readPrefill(`?text=${encodeURIComponent(exact)}`)).toBe(exact);
  });
});

describe("pickExamples（例文の選び方）", () => {
  const pool = ["a", "b", "c", "d", "e"];

  it("重複なく n 個を選ぶ", () => {
    const got = pickExamples(pool, 3, [], () => 0.5);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
    for (const s of got) expect(pool).toContain(s);
  });

  it("exclude に入ったものは選ばない", () => {
    for (let k = 0; k < 20; k++) {
      const got = pickExamples(pool, 3, ["a", "b"]);
      expect(got).not.toContain("a");
      expect(got).not.toContain("b");
    }
  });

  it("候補が足りないときは有るだけ返す", () => {
    expect(pickExamples(pool, 10, ["a"], () => 0.3)).toHaveLength(4);
    expect(pickExamples([], 3)).toEqual([]);
  });

  it("rand を固定すると同じ結果になる（元の配列は変えない）", () => {
    const copy = [...pool];
    const first = pickExamples(pool, 3, [], () => 0);
    const second = pickExamples(pool, 3, [], () => 0);
    expect(first).toEqual(second);
    expect(pool).toEqual(copy);
  });
});
