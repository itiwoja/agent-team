import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay } from "./dayGroup";

// ローカル時刻で作る（テストの TZ に依らないように）
const local = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const now = new Date(2026, 9, 8, 15, 30); // 2026/10/8 15:30（ローカル）

describe("dayLabel", () => {
  it("今日・昨日・それ以前の日付", () => {
    expect(dayLabel(local(2026, 10, 8, 0, 5), now)).toBe("今日");
    expect(dayLabel(local(2026, 10, 7, 23, 59), now)).toBe("昨日");
    expect(dayLabel(local(2026, 10, 3), now)).toBe("10月3日");
  });
  it("別の年は年を付ける", () => {
    expect(dayLabel(local(2025, 12, 31), now)).toBe("2025年12月31日");
  });
  it("壊れた日付は「日付不明」", () => {
    expect(dayLabel("not-a-date", now)).toBe("日付不明");
  });
  it("日付の境目はローカル 0 時", () => {
    // 今日の 0 時ちょうどは今日、前日の 23:59:59.999 は昨日
    expect(dayLabel(new Date(2026, 9, 8, 0, 0, 0).toISOString(), now)).toBe("今日");
    expect(dayLabel(new Date(2026, 9, 7, 23, 59, 59, 999).toISOString(), now)).toBe("昨日");
  });
});

describe("groupByDay", () => {
  it("新しい順の並びを保って、同じ日の行をまとめる", () => {
    const isos = [local(2026, 10, 8, 14), local(2026, 10, 8, 9), local(2026, 10, 7, 20), local(2026, 10, 3, 8), local(2026, 10, 3, 7)];
    const groups = groupByDay(isos, (s) => s, now);
    expect(groups.map((g) => g.label)).toEqual(["今日", "昨日", "10月3日"]);
    expect(groups.map((g) => g.items.length)).toEqual([2, 1, 2]);
    expect(groups[0]?.items[0]).toBe(isos[0]);
  });
  it("オブジェクトの配列も at で日付を取り出せる", () => {
    const rows = [{ id: "a", at: local(2026, 10, 8) }, { id: "b", at: local(2026, 10, 6) }];
    const groups = groupByDay(rows, (r) => r.at, now);
    expect(groups).toEqual([
      { label: "今日", items: [rows[0]] },
      { label: "10月6日", items: [rows[1]] },
    ]);
  });
  it("空の配列は空の結果", () => {
    expect(groupByDay([], (s: string) => s, now)).toEqual([]);
  });
});
