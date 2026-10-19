import { describe, expect, it } from "vitest";
import { DAY_BOUNDARY_TIMEZONE } from "@open-team/kernel";
import {
  BUDGET_TIME_ZONE,
  DAY_MS,
  budgetDay,
  manualClock,
  secondsUntilTokyoDayEnd,
  systemClock,
  tokyoDay,
  tokyoDayEnd,
  tokyoDayStart,
} from "./time.ts";

const jst = (s: string): Date => new Date(`${s}+09:00`);

describe("費用の日の区切り（Asia/Tokyo の0時。M-59・SO I-08）", () => {
  it("M-59 区切りのタイムゾーンは kernel の DAY_BOUNDARY_TIMEZONE（Asia/Tokyo）と同じ", () => {
    expect(BUDGET_TIME_ZONE).toBe("Asia/Tokyo");
    expect(BUDGET_TIME_ZONE).toBe(DAY_BOUNDARY_TIMEZONE);
  });

  it("23:59:59.999 JST はその日、0:00:00.000 JST は次の日（UTC の 15:00 が境目）", () => {
    expect(budgetDay(new Date("2026-10-07T14:59:59.999Z"))).toBe("2026-10-07");
    expect(budgetDay(new Date("2026-10-07T15:00:00.000Z"))).toBe("2026-10-08");
    // UTC ではまだ 10/7 でも JST では 10/8
    expect(budgetDay(jst("2026-10-08T08:59:59"))).toBe("2026-10-08");
  });

  it("日の始まりは含み、終わり（翌日の0時）は含まない [start, end)", () => {
    const at = jst("2026-10-08T00:30:00");
    expect(tokyoDayStart(at).toISOString()).toBe("2026-10-07T15:00:00.000Z");
    expect(tokyoDayEnd(at).toISOString()).toBe("2026-10-08T15:00:00.000Z");
    // ちょうど0時はその日の始まり
    const midnight = jst("2026-10-08T00:00:00");
    expect(tokyoDayStart(midnight).getTime()).toBe(midnight.getTime());
    expect(tokyoDayEnd(midnight).getTime()).toBe(midnight.getTime() + DAY_MS);
    // 終わりの1ミリ秒前は同じ日、終わりちょうどは次の日
    const end = tokyoDayEnd(at);
    expect(budgetDay(new Date(end.getTime() - 1))).toBe("2026-10-08");
    expect(budgetDay(end)).toBe("2026-10-09");
    expect(tokyoDay(at)).toEqual({ day: "2026-10-08", start: tokyoDayStart(at), end });
  });

  it("年・うるう日をまたぐ", () => {
    expect(budgetDay(new Date("2026-12-31T15:00:00.000Z"))).toBe("2027-01-01");
    expect(budgetDay(new Date("2026-12-31T14:59:59.999Z"))).toBe("2026-12-31");
    expect(budgetDay(jst("2028-02-29T12:00:00"))).toBe("2028-02-29");
    expect(tokyoDayEnd(jst("2028-02-29T12:00:00")).toISOString()).toBe("2028-02-29T15:00:00.000Z");
  });

  it("Intl（Asia/Tokyo）で数えた日付と、1年分の時刻ですべて一致する（固定の +09:00 で正しい）", () => {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    // 素数の刻みで、境目の前後を含むいろいろな時刻を見る
    for (let i = 0; i < 2000; i++) {
      const at = new Date(base + i * 4_405_517);
      expect(budgetDay(at)).toBe(fmt.format(at));
      expect(budgetDay(tokyoDayStart(at))).toBe(fmt.format(at));
      expect(budgetDay(new Date(tokyoDayEnd(at).getTime() - 1))).toBe(fmt.format(at));
    }
  });

  it("I-10 次の0時までの秒数（Retry-After）は切り上げで最小1", () => {
    expect(secondsUntilTokyoDayEnd(jst("2026-10-08T00:00:00"))).toBe(86_400);
    expect(secondsUntilTokyoDayEnd(jst("2026-10-08T12:00:00"))).toBe(43_200);
    expect(secondsUntilTokyoDayEnd(new Date(jst("2026-10-08T23:59:59").getTime() + 500))).toBe(1);
    expect(secondsUntilTokyoDayEnd(new Date(jst("2026-10-09T00:00:00").getTime() - 1))).toBe(1);
  });

  it("Invalid Date は例外（黙って 1970 年の日にしない）", () => {
    expect(() => budgetDay(new Date("not a date"))).toThrow(RangeError);
    expect(() => tokyoDayStart(new Date(Number.NaN))).toThrow(RangeError);
    expect(() => secondsUntilTokyoDayEnd(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe("Clock（本当の時刻の注入）", () => {
  it("systemClock は実時間", () => {
    const before = Date.now();
    const t = systemClock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
    // 分割代入しても動く
    const { now } = systemClock;
    expect(now()).toBeInstanceOf(Date);
  });

  it("manualClock は set・advance で動き、返した Date を書き換えても時計は変わらない", () => {
    const clock = manualClock("2026-10-08T09:00:00+09:00");
    expect(clock.now().toISOString()).toBe("2026-10-08T00:00:00.000Z");
    clock.now().setTime(0);
    expect(clock.now().toISOString()).toBe("2026-10-08T00:00:00.000Z");
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe("2026-10-08T00:01:00.000Z");
    clock.set(new Date("2026-10-09T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-10-09T00:00:00.000Z");
    clock.set(0);
    expect(clock.now().getTime()).toBe(0);
  });

  it("manualClock に読めない時刻・数でない量を渡すと例外", () => {
    expect(() => manualClock("yesterday")).toThrow(RangeError);
    const clock = manualClock(0);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(() => clock.set(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
