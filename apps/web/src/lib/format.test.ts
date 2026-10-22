import { describe, expect, it } from "vitest";
import { formatTime, formatUsd } from "./format";

describe("Gemini の見せ方", () => {
  it("formatUsd", () => {
    expect(formatUsd("0.034000")).toBe("$0.03");
    expect(formatUsd("x")).toBeNull();
  });
});

describe("数と時刻の書式", () => {
  it("formatTime：今日は時:分、別の日は月/日 時:分（分は2桁）", () => {
    const now = new Date(2026, 9, 8, 20, 0, 0);
    expect(formatTime(new Date(2026, 9, 8, 7, 2).toISOString(), now)).toBe("7:02");
    expect(formatTime(new Date(2026, 9, 7, 18, 2).toISOString(), now)).toBe("10/7 18:02");
    // 年が違えば同じ月日でも別の日
    expect(formatTime(new Date(2025, 9, 8, 7, 2).toISOString(), now)).toBe("10/8 7:02");
  });
  it("formatTime：不正な日付は空文字", () => {
    expect(formatTime("")).toBe("");
    expect(formatTime("not-a-date")).toBe("");
  });
});
