// 費用の道具の試験（packages/db/src/system/costs.test.ts の WorkspaceDO 版。DB §4.10・§7.8 の T-117、SO I-08 の Asia/Tokyo の0時）。
// 全体の今日の費用（getPlatformDayCostUsd）は第5段で D1 などに置くので、ここでは試さない
import { describe, expect, it } from "vitest";
import { dayRange, microToUsd, usdToMicro } from "../../src/db/repo/costs.ts";

describe("金額（整数のマイクロドル）", () => {
  it("T-117 0.1 ＋ 0.2 は 0.300000（浮動小数で足さない）", () => {
    expect(microToUsd(usdToMicro("0.1") + usdToMicro("0.2"))).toBe("0.300000");
    expect(usdToMicro("0.950000")).toBe(950_000);
    expect(usdToMicro("10")).toBe(10_000_000);
    expect(usdToMicro("0.000001")).toBe(1);
    expect(usdToMicro("-0.5")).toBe(-500_000);
    expect(microToUsd(1_000_000)).toBe("1.000000");
    expect(microToUsd(-1)).toBe("-0.000001");
    expect(() => usdToMicro("0.0000001")).toThrow(RangeError);
    expect(() => usdToMicro("1e-6")).toThrow(RangeError);
    expect(() => microToUsd(0.5)).toThrow(RangeError);
  });
});

describe("日の範囲（JS の Intl で計算）", () => {
  it("[JST 0時, 翌0時)。0時ちょうどはその日、1ミリ秒前は前の日", () => {
    expect(dayRange(new Date("2026-10-12T15:00:00.000Z"))).toEqual({
      start: new Date("2026-10-12T15:00:00.000Z"),
      end: new Date("2026-10-13T15:00:00.000Z"),
    });
    expect(dayRange(new Date("2026-10-12T14:59:59.999Z")).start).toEqual(new Date("2026-10-11T15:00:00.000Z"));
  });

  it("UTC・月末・年末をまたいでも正しい", () => {
    expect(dayRange(new Date("2026-10-12T20:00:00.000Z"), "UTC")).toEqual({
      start: new Date("2026-10-12T00:00:00.000Z"),
      end: new Date("2026-10-13T00:00:00.000Z"),
    });
    expect(dayRange(new Date("2026-12-31T16:00:00.000Z"))).toEqual({
      start: new Date("2026-12-31T15:00:00.000Z"),
      end: new Date("2027-01-01T15:00:00.000Z"),
    });
  });

  it("夏時間の変わる日は23時間・25時間（America/New_York）", () => {
    // 2026-03-08 は EST → EDT（23時間）、2026-11-01 は EDT → EST（25時間）
    const spring = dayRange(new Date("2026-03-08T12:00:00.000Z"), "America/New_York");
    expect(spring).toEqual({ start: new Date("2026-03-08T05:00:00.000Z"), end: new Date("2026-03-09T04:00:00.000Z") });
    const fall = dayRange(new Date("2026-11-01T12:00:00.000Z"), "America/New_York");
    expect(fall).toEqual({ start: new Date("2026-11-01T04:00:00.000Z"), end: new Date("2026-11-02T05:00:00.000Z") });
  });

  it("0時が飛ぶ日は、飛んだ先の最初の瞬間から（America/Santiago）", () => {
    // チリは 2026-09-06 の 0時 → 1時に進む（-04 → -03）
    const r = dayRange(new Date("2026-09-06T12:00:00.000Z"), "America/Santiago");
    expect(r.start).toEqual(new Date("2026-09-06T04:00:00.000Z"));
    expect(r.end).toEqual(new Date("2026-09-07T03:00:00.000Z"));
  });

  it("知らないタイムゾーンは例外", () => {
    expect(() => dayRange(new Date(), "Mars/Olympus")).toThrow(RangeError);
  });
});
