import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  addMinutesIso,
  dayIndexAt,
  endAtTime,
  formatJst,
  jstAt,
  jstDateOf,
  jstMidnight,
  parseIso,
  virtualTime,
  type VirtualClock,
} from "./clock.ts";

const clock: VirtualClock = { now: "2026-10-06T18:00:00+09:00", tz: "Asia/Tokyo", day: 1 };

describe("仮想の時計（Asia/Tokyo。SW §3.5）", () => {
  it("JST の ISO 8601 で書き、読み戻すと同じ時刻", () => {
    const ms = jstAt("2026-10-06", "18:00");
    expect(formatJst(ms)).toBe("2026-10-06T18:00:00+09:00");
    expect(parseIso("2026-10-06T09:00:00Z")).toBe(ms);
  });

  it("日付の境は JST の 0:00（UTC の 15:00）", () => {
    expect(jstDateOf(parseIso("2026-10-06T14:59:59Z"))).toBe("2026-10-06");
    expect(jstDateOf(parseIso("2026-10-06T15:00:00Z"))).toBe("2026-10-07");
    expect(formatJst(jstMidnight(parseIso("2026-10-06T18:00:00+09:00")))).toBe("2026-10-06T00:00:00+09:00");
  });

  it("n 日目の時刻（§3.5 の表：2日目 07:00 入荷・10:00 支払い・17:00 売上・23:59 終わり）", () => {
    expect(virtualTime(clock, 2, "07:00")).toBe("2026-10-07T07:00:00+09:00");
    expect(virtualTime(clock, 2, "10:00")).toBe("2026-10-07T10:00:00+09:00");
    expect(virtualTime(clock, 2, "17:00")).toBe("2026-10-07T17:00:00+09:00");
    expect(endAtTime(clock, "day2_end")).toBe("2026-10-07T23:59:00+09:00");
    // 2日目にいる時計から見ても同じ
    expect(virtualTime({ now: "2026-10-07T10:30:00+09:00", tz: "Asia/Tokyo", day: 2 }, 1, "18:00")).toBe(clock.now);
  });

  it("日の番号", () => {
    expect(dayIndexAt(clock, parseIso("2026-10-06T23:59:00+09:00"))).toBe(1);
    expect(dayIndexAt(clock, parseIso("2026-10-07T00:00:00+09:00"))).toBe(2);
    expect(dayIndexAt(clock, parseIso("2026-10-08T07:00:00+09:00"))).toBe(3);
  });

  it("タイムゾーンのない時刻・存在しない日付・'HH:MM' でないものは例外", () => {
    expect(() => parseIso("2026-10-06T18:00:00")).toThrow(RangeError);
    expect(() => parseIso("きのう")).toThrow(RangeError);
    expect(() => jstAt("2026-02-30", "00:00")).toThrow(RangeError);
    expect(() => jstAt("2026-10-06", "24:00")).toThrow(RangeError);
  });

  it("分を足す（日をまたぐ）", () => {
    expect(addMinutesIso("2026-10-06T18:00:00+09:00", -60)).toBe("2026-10-06T17:00:00+09:00");
    expect(addMinutesIso("2026-10-06T23:30:00+09:00", 45)).toBe("2026-10-07T00:15:00+09:00");
  });

  it("性質：書いて読むと秒まで同じ・1日は24時間", () => {
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) }), (raw) => {
        const ms = Math.floor(raw / 1000) * 1000;
        expect(parseIso(formatJst(ms))).toBe(ms);
        expect(jstMidnight(ms + DAY_MS) - jstMidnight(ms)).toBe(DAY_MS);
      }),
      { numRuns: 300 },
    );
  });
});
