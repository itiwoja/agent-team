// 定期の依頼の次の時刻（asks.next_run_at。D-70 の毎日18時 Asia/Tokyo）
import { describe, expect, it } from "vitest";
import { nextScheduledRun, UnsupportedScheduleError } from "./schedule.ts";

const daily18 = { cron: "0 18 * * *", timezone: "Asia/Tokyo" };

describe("nextScheduledRun", () => {
  it("18時（JST）より前なら同じ日の18時、ちょうど・過ぎたら翌日の18時", () => {
    expect(nextScheduledRun(daily18, new Date("2026-10-14T01:00:00.000Z"))).toEqual(new Date("2026-10-14T09:00:00.000Z"));
    expect(nextScheduledRun(daily18, new Date("2026-10-14T08:59:59.999Z"))).toEqual(new Date("2026-10-14T09:00:00.000Z"));
    expect(nextScheduledRun(daily18, new Date("2026-10-14T09:00:00.000Z"))).toEqual(new Date("2026-10-15T09:00:00.000Z"));
    expect(nextScheduledRun(daily18, new Date("2026-10-14T14:59:59.000Z"))).toEqual(new Date("2026-10-15T09:00:00.000Z"));
  });

  it("JST の日付で数える（UTC では前の日の 15:00 以降が JST の翌日）", () => {
    // 2026-10-14 15:30 UTC = 2026-10-15 00:30 JST → その日の 18:00 JST
    expect(nextScheduledRun(daily18, new Date("2026-10-14T15:30:00.000Z"))).toEqual(new Date("2026-10-15T09:00:00.000Z"));
  });

  it("1日に複数の時刻（'0,30 9,18 * * *'）は次の一番近いもの", () => {
    const t = { cron: "0,30 9,18 * * *", timezone: "Asia/Tokyo" };
    expect(nextScheduledRun(t, new Date("2026-10-14T00:10:00.000Z"))).toEqual(new Date("2026-10-14T00:30:00.000Z"));
    expect(nextScheduledRun(t, new Date("2026-10-14T00:30:00.000Z"))).toEqual(new Date("2026-10-14T09:00:00.000Z"));
    expect(nextScheduledRun(t, new Date("2026-10-14T09:30:00.000Z"))).toEqual(new Date("2026-10-15T00:00:00.000Z"));
  });

  it("Asia/Tokyo 以外・毎日でない cron・読めない cron は 0-H では扱わない", () => {
    expect(() => nextScheduledRun({ cron: "0 18 * * *", timezone: "UTC" }, new Date())).toThrow(UnsupportedScheduleError);
    expect(() => nextScheduledRun({ cron: "0 18 * * 1", timezone: "Asia/Tokyo" }, new Date())).toThrow(UnsupportedScheduleError);
    expect(() => nextScheduledRun({ cron: "0 25 * * *", timezone: "Asia/Tokyo" }, new Date())).toThrow(UnsupportedScheduleError);
    expect(() => nextScheduledRun({ cron: "0 18 * *", timezone: "Asia/Tokyo" }, new Date())).toThrow(UnsupportedScheduleError);
    expect(() => nextScheduledRun(daily18, new Date(Number.NaN))).toThrow(RangeError);
  });
});
