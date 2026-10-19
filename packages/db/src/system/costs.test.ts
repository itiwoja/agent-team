// 全体の費用の試験（BR-62 の全体1日 $10、DB §4.10・§7.8 の T-112・T-117、SO I-08 の Asia/Tokyo の0時）
import { describe, expect, it } from "vitest";
import { fxAgent, fxUsage, fxWorkspace, useTestDb } from "../testing.ts";
import { dayRange, getPlatformDayCostUsd, microToUsd, usdToMicro } from "./costs.ts";

const T = useTestDb();

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

describe("全体の今日の費用（Asia/Tokyo の0時から）", () => {
  it("ワークスペースをまたいで合計し、JST の前の日の行は入れない", async () => {
    const { db } = T();
    const a = await fxWorkspace(db);
    const b = await fxWorkspace(db);
    const agentA = await fxAgent(db, a);
    const agentB = await fxAgent(db, b);
    // JST 2026-10-13 00:00 = 2026-10-12T15:00Z
    const midnight = new Date("2026-10-12T15:00:00.000Z");
    await fxUsage(db, a, { agentId: agentA.agentId, costUsd: "0.100000", createdAt: midnight });
    await fxUsage(db, b, { agentId: agentB.agentId, costUsd: "0.200000", createdAt: new Date(midnight.getTime() + 60_000) });
    await fxUsage(db, b, { agentId: agentB.agentId, costUsd: "9.000000", createdAt: new Date(midnight.getTime() - 1) });
    const now = new Date("2026-10-12T20:00:00.000Z");
    expect(await getPlatformDayCostUsd(db, now)).toBe("0.300000");
    // JST の前の日（10/12）の中なら 9.000000 だけ
    expect(await getPlatformDayCostUsd(db, new Date(midnight.getTime() - 1))).toBe("9.000000");
    // 行がない日は 0.000000
    expect(await getPlatformDayCostUsd(db, new Date("2026-11-01T00:00:00Z"))).toBe("0.000000");
    // UTC で区切ると別の値になる（区切りのタイムゾーンを引数で選べる）
    expect(await getPlatformDayCostUsd(db, now, "UTC")).toBe("9.300000");
  });

  it("日の範囲は [JST 0時, 翌0時)", async () => {
    const { db } = T();
    const r = await dayRange(db, new Date("2026-10-12T15:00:00.000Z"));
    expect(r).toEqual({ start: new Date("2026-10-12T15:00:00.000Z"), end: new Date("2026-10-13T15:00:00.000Z") });
    const r2 = await dayRange(db, new Date("2026-10-12T14:59:59.999Z"));
    expect(r2.start).toEqual(new Date("2026-10-11T15:00:00.000Z"));
  });
});
