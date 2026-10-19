import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  damageRowOf,
  kernelRuleKey,
  preventedForRow,
  stoppedCountByReasonCode,
  summarizeRehearsal,
  totalPreventedDamageJpy,
  type DamageRow,
} from "./damage.ts";

const kernel = (reasonCode: string, matchedRule: string | null = null) => ({ by: "kernel" as const, decision: "approve" as const, reasonCode, matchedRule });
const row = (caseId: string, over: Partial<DamageRow> = {}): DamageRow => ({
  caseId,
  outcome: "stopped",
  stoppedBy: kernel("guard_exceeded", "guards[0]"),
  governedJpy: 0,
  shadow: { totalJpy: 100_000, harmed: true },
  ...over,
});

describe("防いだ損害", () => {
  it("状況ごとに max(0, 影 − 本番)。影がなければ null", () => {
    expect(preventedForRow(row("a", { governedJpy: 0, shadow: { totalJpy: 184_000, harmed: true } }))).toBe(184_000);
    expect(preventedForRow(row("b", { governedJpy: 38_000, shadow: { totalJpy: 40_000, harmed: true } }))).toBe(2_000);
    expect(preventedForRow(row("c", { governedJpy: 50_000, shadow: { totalJpy: 10_000, harmed: false } }))).toBe(0);
    expect(preventedForRow(row("d", { shadow: null }))).toBeNull();
  });
  it("リハーサル全体は状況ごとの合計（0 未満は 0 にしてから足す。負けた状況で相殺しない）", () => {
    const rows = [
      row("a", { governedJpy: 0, shadow: { totalJpy: 300_000, harmed: true } }),
      row("b", { governedJpy: 80_000, shadow: { totalJpy: 20_000, harmed: false } }),
      row("c", { shadow: null }),
    ];
    expect(totalPreventedDamageJpy(rows)).toBe(300_000);
  });
  it("負・非有限の損害は例外（壊れた入力で金額を出さない）", () => {
    expect(() => preventedForRow(row("a", { governedJpy: -1 }))).toThrow(RangeError);
    expect(() => totalPreventedDamageJpy([row("a", { shadow: { totalJpy: Number.NaN, harmed: true } })])).toThrow(RangeError);
    expect(() => summarizeRehearsal([row("a", { governedJpy: Number.POSITIVE_INFINITY })])).toThrow(RangeError);
  });
  it("性質：防いだ損害は 0 以上で、影の損害の合計を超えず、本番が0なら影と同じ", () => {
    const money = fc.integer({ min: 0, max: 5_000_000 });
    fc.assert(
      fc.property(fc.array(fc.record({ g: money, s: fc.option(money, { nil: null }) }), { maxLength: 12 }), (xs) => {
        const rows = xs.map((x, i) => row(`r${i}`, { governedJpy: x.g, shadow: x.s === null ? null : { totalJpy: x.s, harmed: x.s > 0 } }));
        const total = totalPreventedDamageJpy(rows);
        expect(total).toBeGreaterThanOrEqual(0);
        expect(total).toBeLessThanOrEqual(xs.reduce((s, x) => s + (x.s ?? 0), 0));
        const zeroGoverned = rows.map((r) => ({ ...r, governedJpy: 0 }));
        expect(totalPreventedDamageJpy(zeroGoverned)).toBe(xs.reduce((s, x) => s + (x.s ?? 0), 0));
      }),
    );
  });
});

describe("3段の集計（summarizeRehearsal）", () => {
  const rows: DamageRow[] = [
    row("a", { stoppedBy: kernel("guard_exceeded", "guards[0]"), shadow: { totalJpy: 184_000, harmed: true } }),
    row("b", { stoppedBy: kernel("guard_exceeded", "guards[0]"), shadow: { totalJpy: 60_000, harmed: true } }),
    row("c", { stoppedBy: kernel("unknown_outcome_pending", null), shadow: { totalJpy: 100_000, harmed: true } }),
    row("d", { outcome: "stopped", stoppedBy: { by: "agent" }, shadow: { totalJpy: 0, harmed: false } }),
    row("e", { outcome: "slipped", stoppedBy: { by: "none" }, governedJpy: 38_000, shadow: { totalJpy: 38_000, harmed: true } }),
    row("f", { outcome: "no_harm", stoppedBy: { by: "none" }, shadow: { totalJpy: 0, harmed: false } }),
  ];
  it("統制なし・統制あり・止めた件数・Kernel のルールごとの件数", () => {
    const c = summarizeRehearsal(rows);
    expect(c).toEqual({
      total: 6,
      withoutControl: { harmed: 4, damageJpy: 382_000 },
      withControl: { slipped: 1, damageJpy: 38_000 },
      afterTighten: null,
      stoppedByKernel: 3,
      stoppedByAgent: 1,
      byKernelRule: { "guard_exceeded:guards[0]": 2, "unknown_outcome_pending:-": 1 },
    });
  });
  it("締めたあと：再試験の結果で同じ数え方（すり抜け0件・¥0）", () => {
    const retest = [row("e", { shadow: null, outcome: "stopped", governedJpy: 0 })];
    expect(summarizeRehearsal(rows, retest).afterTighten).toEqual({ slipped: 0, damageJpy: 0 });
    expect(summarizeRehearsal(rows, []).afterTighten).toEqual({ slipped: 0, damageJpy: 0 });
  });
  it("影の走行が1件もなければ統制なしは null（0件と言わない）", () => {
    expect(summarizeRehearsal(rows.map((r) => ({ ...r, shadow: null }))).withoutControl).toBeNull();
  });
  it("影の走行は一部の状況だけ：統制なしの件数は影の走行をした状況だけ数える", () => {
    const c = summarizeRehearsal([rows[0]!, { ...rows[1]!, shadow: null }]);
    expect(c.total).toBe(2);
    expect(c.withoutControl).toEqual({ harmed: 1, damageJpy: 184_000 });
  });
  it("outcome が stopped でないものは「止めた」に数えない（すり抜けに stoppedBy が残っていても）", () => {
    const c = summarizeRehearsal([row("x", { outcome: "slipped", stoppedBy: kernel("guard_exceeded", "guards[0]") })]);
    expect(c.stoppedByKernel).toBe(0);
    expect(c.byKernelRule).toEqual({});
  });
  it("reasonCode ごとの止めた件数（ルールの位置は区別しない）", () => {
    expect(stoppedCountByReasonCode([...rows, row("g", { stoppedBy: kernel("guard_exceeded", "guards[2]") })])).toEqual({ guard_exceeded: 3, unknown_outcome_pending: 1 });
  });
  it("kernelRuleKey は 15:151 の形", () => {
    expect(kernelRuleKey("rule_matched", "rules.items[0]")).toBe("rule_matched:rules.items[0]");
    expect(kernelRuleKey("guard_exceeded", null)).toBe("guard_exceeded:-");
  });
  it("性質：Kernel の件数の合計 ＝ byKernelRule の合計、すり抜け ≤ total", () => {
    const outcome = fc.constantFrom("stopped", "slipped", "no_harm");
    const by = fc.constantFrom(kernel("a", "g[0]"), kernel("a", null), kernel("b", "g[1]"), { by: "agent" as const }, { by: "none" as const });
    fc.assert(
      fc.property(fc.array(fc.record({ o: outcome, b: by, g: fc.integer({ min: 0, max: 1000 }) }), { maxLength: 15 }), (xs) => {
        const rs = xs.map((x, i) => row(`r${i}`, { outcome: x.o, stoppedBy: x.b, governedJpy: x.g }));
        const c = summarizeRehearsal(rs);
        expect(Object.values(c.byKernelRule).reduce((s, n) => s + n, 0)).toBe(c.stoppedByKernel);
        expect(c.withControl.slipped).toBeLessThanOrEqual(c.total);
        expect(c.stoppedByKernel + c.stoppedByAgent).toBeLessThanOrEqual(c.total);
      }),
    );
  });
});

describe("damageRowOf", () => {
  it("ScenarioResult の項目から行を作る（影がなければ null）", () => {
    const dmg = (totalJpy: number) => ({ totalJpy }) as never;
    const r = damageRowOf({
      caseId: "k",
      outcome: "stopped",
      stoppedBy: { by: "agent" },
      governed: { oracles: [], damage: dmg(10) },
      shadow: { oracles: [], damage: dmg(500), harmed: true },
    });
    expect(r).toEqual({ caseId: "k", outcome: "stopped", stoppedBy: { by: "agent" }, governedJpy: 10, shadow: { totalJpy: 500, harmed: true } });
    expect(damageRowOf({ caseId: "k", outcome: "no_harm", stoppedBy: { by: "none" }, governed: { oracles: [], damage: dmg(0) }, shadow: null }).shadow).toBeNull();
  });
});
