import { describe, expect, it } from "vitest";
import { FIRST_VISIT_NOTE, FIRST_VISIT_SELF, JUDGE_TOKEN_NOTE, formatTime, formatUsd, formatYen } from "./format";
import { GLOSSARY, glossaryText, splitAtTerm } from "./glossary";

describe("Gemini の見せ方", () => {
  it("formatUsd", () => {
    expect(formatUsd("0.034000")).toBe("$0.03");
    expect(formatUsd("x")).toBeNull();
  });
});

describe("数と時刻の書式", () => {
  it("formatYen：¥ と3桁区切り。小数は丸める", () => {
    expect(formatYen(344000)).toBe("¥344,000");
    expect(formatYen(0)).toBe("¥0");
    expect(formatYen(1234.5)).toBe("¥1,235");
  });
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

describe("用語の説明", () => {
  it("4語に決まった文がある", () => {
    expect(glossaryText("Kernel")).toBe("実行の前に許可・確認・拒否を決める、LLM でないコード");
    expect(glossaryText("合否の判定")).toContain("AI は関わらない");
    expect(glossaryText("ガード")).toBe("数量や単価の上限など、超えたら確認に回す条件");
    expect(glossaryText("安全チェック済み")).toContain("自動にせずあなたに確認する");
    expect(glossaryText("x")).toBeNull();
  });
  it("splitAtTerm は最初の1か所で分ける", () => {
    expect(splitAtTerm("数量のガードを足す", "ガード")).toEqual({ before: "数量の", term: "ガード", after: "を足す" });
    expect(splitAtTerm("止める", "ガード")).toBeNull();
  });
});

describe("審査員向けと初めての方の案内・用語（#10・設計書との対応）", () => {
  it("入口のトークン欄の下の審査員向けの1行", () => {
    expect(JUDGE_TOKEN_NOTE).toBe("審査員の方へ：入口のトークンは提出フォームに記載しています");
  });

  it("用意した依頼の初めての方の案内は「リハーサル」を含まない", () => {
    expect(FIRST_VISIT_NOTE + FIRST_VISIT_SELF).toBe("初めての方は、この用意した依頼の結果から見てください。自分で頼むこともできます");
    expect(FIRST_VISIT_NOTE + FIRST_VISIT_SELF).not.toContain("リハーサル");
  });

  it("用語の説明には「リハーサル」「合格証」「汚染」「オラクル」「締め」を出さない（#16 B案）", () => {
    for (const g of GLOSSARY) expect(`${g.term} ${g.text}`).not.toMatch(/リハーサル|合格証|汚染|オラクル|締め/);
  });
});
