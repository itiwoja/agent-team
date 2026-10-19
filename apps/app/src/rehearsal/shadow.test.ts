// 影の判定の選び方と防いだ損害（shadow.ts）の試験。純粋な関数
import type { DamageBreakdown, ScenarioResult } from "@open-team/sim-core";
import { describe, expect, it } from "vitest";
import { preventedOf, shouldRunShadow, totalPrevented } from "./shadow.ts";

const first = { trigger: "initial", adaptRound: 0, caseSource: "generated", hasFirstShadow: false } as const;

describe("shouldRunShadow（最初の生成の状況にだけ：15:162）", () => {
  it("初回・手動・シード・自分の言葉の1件で、適応の0回目の生成・自分の言葉の試験は走らせる", () => {
    for (const trigger of ["initial", "manual", "seed", "user_case"] as const) expect(shouldRunShadow({ ...first, trigger })).toBe(true);
    expect(shouldRunShadow({ ...first, caseSource: "user", trigger: "user_case" })).toBe(true);
  });
  it("適応で作り直した状況・再試験・再リハーサル・モデルの比較・incident・すでに影を走らせた試験は走らせない", () => {
    expect(shouldRunShadow({ ...first, adaptRound: 1 })).toBe(false);
    expect(shouldRunShadow({ ...first, trigger: "retest" })).toBe(false);
    expect(shouldRunShadow({ ...first, trigger: "recertify" })).toBe(false);
    expect(shouldRunShadow({ ...first, trigger: "model_compare" })).toBe(false);
    expect(shouldRunShadow({ ...first, caseSource: "incident" })).toBe(false);
    expect(shouldRunShadow({ ...first, hasFirstShadow: true })).toBe(false);
  });
});

const damage = (totalJpy: number): DamageBreakdown => ({ totalJpy }) as DamageBreakdown;
const result = (governed: number, shadow: number | null): Pick<ScenarioResult, "caseId" | "outcome" | "stoppedBy" | "governed" | "shadow"> => ({
  caseId: "c",
  outcome: "stopped",
  stoppedBy: { by: "none" },
  governed: { oracles: [], damage: damage(governed) },
  shadow: shadow === null ? null : { oracles: [], damage: damage(shadow), harmed: shadow > 0 },
});

describe("preventedOf・totalPrevented（max(0, 影 − 本番) と状況の合計）", () => {
  it("影 − 本番。0 未満は 0。影がなければ null（残した値があればそれで）", () => {
    expect(preventedOf(result(10_000, 184_000))).toBe(174_000);
    expect(preventedOf(result(300_000, 184_000))).toBe(0);
    expect(preventedOf(result(0, null))).toBeNull();
    expect(preventedOf(result(10_000, null), 50_000)).toBe(40_000);
  });
  it("走行全体は状況ごとの合計（影のない状況は足さない）", () => {
    expect(totalPrevented([result(0, 100), result(20, 120), result(5, null)])).toBe(200);
  });
});
