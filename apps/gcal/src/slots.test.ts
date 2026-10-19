import { describe, expect, it } from "vitest";
import { MAX_SLOTS, freeSlots, offsetMsAt, toRfc3339, wallToEpoch } from "./slots.ts";

const ms = (s: string) => Date.parse(s);

describe("時間帯（Intl）", () => {
  it("東京は +09:00、インドは +05:30、ニューヨークは夏時間で -04:00", () => {
    expect(offsetMsAt("Asia/Tokyo", ms("2026-10-14T00:00:00Z"))).toBe(9 * 3600_000);
    expect(toRfc3339(ms("2026-10-14T00:00:00Z"), "Asia/Kolkata")).toBe("2026-10-14T05:30:00+05:30");
    expect(toRfc3339(ms("2026-10-14T13:00:00Z"), "America/New_York")).toBe("2026-10-14T09:00:00-04:00");
  });

  it("壁時計の日時から epoch に直す（東京の 9:00 は UTC の 0:00）", () => {
    expect(wallToEpoch("Asia/Tokyo", 2026, 10, 14, 9, 0)).toBe(ms("2026-10-14T00:00:00Z"));
    expect(wallToEpoch("America/New_York", 2026, 10, 14, 9, 0)).toBe(ms("2026-10-14T13:00:00Z"));
  });

  it("春の欠落時刻は最初の有効な時刻へ進め、秋の重複時刻は早い方を選ぶ", () => {
    expect(wallToEpoch("America/New_York", 2026, 3, 8, 2, 30)).toBe(ms("2026-03-08T07:00:00Z"));
    expect(toRfc3339(wallToEpoch("America/New_York", 2026, 3, 8, 2, 30), "America/New_York")).toBe("2026-03-08T03:00:00-04:00");
    expect(wallToEpoch("America/New_York", 2026, 11, 1, 1, 30)).toBe(ms("2026-11-01T05:30:00Z"));
  });
});

describe("freeSlots（16 §3.1 find_free_time）", () => {
  it("東京の1日：10:00〜11:00 が埋まり。09:00 と 11:00 からの枠を返す。busy_count は1", () => {
    const r = freeSlots({
      timeMin: ms("2026-10-14T00:00:00+09:00"),
      timeMax: ms("2026-10-15T00:00:00+09:00"),
      busy: [[ms("2026-10-14T10:00:00+09:00"), ms("2026-10-14T11:00:00+09:00")]],
      durationMinutes: 60,
      dayStart: "09:00",
      dayEnd: "21:00",
      timeZone: "Asia/Tokyo",
    });
    expect(r.busyCount).toBe(1);
    expect(r.slots[0]).toEqual({ start: "2026-10-14T09:00:00+09:00", end: "2026-10-14T10:00:00+09:00" });
    expect(r.slots[1]).toEqual({ start: "2026-10-14T11:00:00+09:00", end: "2026-10-14T12:00:00+09:00" });
    // 09 は 1枠、11〜21 は 10枠
    expect(r.slots).toHaveLength(11);
    expect(r.slots.at(-1)).toEqual({ start: "2026-10-14T20:00:00+09:00", end: "2026-10-14T21:00:00+09:00" });
  });

  it("2日にまたがる範囲：それぞれの日の 09:00〜21:00 の中だけ。夜の時間は入らない", () => {
    const r = freeSlots({
      timeMin: ms("2026-10-14T00:00:00+09:00"),
      timeMax: ms("2026-10-16T00:00:00+09:00"),
      busy: [],
      durationMinutes: 240,
      dayStart: "09:00",
      dayEnd: "21:00",
      timeZone: "Asia/Tokyo",
    });
    // 1日に4時間の枠が3つずつ（09・13・17）、2日で6つ
    expect(r.slots.map((s) => s.start)).toEqual([
      "2026-10-14T09:00:00+09:00",
      "2026-10-14T13:00:00+09:00",
      "2026-10-14T17:00:00+09:00",
      "2026-10-15T09:00:00+09:00",
      "2026-10-15T13:00:00+09:00",
      "2026-10-15T17:00:00+09:00",
    ]);
    expect(r.slots.at(-1)?.end).toBe("2026-10-15T21:00:00+09:00");
  });

  it("夜をまたぐ埋まりは日ごとに効く。枠は最大 20 件で止まる", () => {
    const r = freeSlots({
      timeMin: ms("2026-10-14T00:00:00+09:00"),
      timeMax: ms("2026-10-16T00:00:00+09:00"),
      busy: [[ms("2026-10-14T20:00:00+09:00"), ms("2026-10-15T10:00:00+09:00")]],
      durationMinutes: 60,
      dayStart: "09:00",
      dayEnd: "21:00",
      timeZone: "Asia/Tokyo",
    });
    expect(r.busyCount).toBe(1);
    expect(r.slots).toHaveLength(MAX_SLOTS);
    // 14日は 09〜20 の 11枠。その次は 15日の 10:00 から（埋まりの後）
    expect(r.slots[10]).toEqual({ start: "2026-10-14T19:00:00+09:00", end: "2026-10-14T20:00:00+09:00" });
    expect(r.slots[11]).toEqual({ start: "2026-10-15T10:00:00+09:00", end: "2026-10-15T11:00:00+09:00" });
  });

  it("範囲の外の埋まりは数えない。窓に入らない長さ（480分）は枠にならない日もある", () => {
    const r = freeSlots({
      timeMin: ms("2026-10-14T00:00:00+09:00"),
      timeMax: ms("2026-10-15T00:00:00+09:00"),
      busy: [[ms("2026-10-20T10:00:00+09:00"), ms("2026-10-20T11:00:00+09:00")]],
      durationMinutes: 480,
      dayStart: "09:00",
      dayEnd: "21:00",
      timeZone: "Asia/Tokyo",
    });
    expect(r.busyCount).toBe(0);
    expect(r.slots).toEqual([{ start: "2026-10-14T09:00:00+09:00", end: "2026-10-14T17:00:00+09:00" }]);
  });

  it("ニューヨークの時間帯でも、その土地の 09:00 から", () => {
    const r = freeSlots({
      timeMin: ms("2026-10-14T00:00:00-04:00"),
      timeMax: ms("2026-10-15T00:00:00-04:00"),
      busy: [],
      durationMinutes: 60,
      dayStart: "09:00",
      dayEnd: "10:00",
      timeZone: "America/New_York",
    });
    expect(r.slots).toEqual([{ start: "2026-10-14T09:00:00-04:00", end: "2026-10-14T10:00:00-04:00" }]);
  });
});
