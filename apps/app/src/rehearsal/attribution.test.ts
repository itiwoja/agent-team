import { describe, expect, it } from "vitest";
import { type AttributionRow, attributionOf, guardLabelOf } from "./attribution.ts";

const stop = (reasonCode: string, rule: string | null, prevented: number | null, verdict: "pass" | "fail" = "pass"): AttributionRow => ({
  verdict,
  stopped_by: verdict === "fail" ? "none" : "kernel",
  stopped_by_reason_code: verdict === "fail" ? null : reasonCode,
  stopped_by_rule: verdict === "fail" ? null : rule,
  prevented_damage_jpy: prevented,
});
const none: AttributionRow = { verdict: "pass", stopped_by: "none", stopped_by_reason_code: null, stopped_by_rule: null, prevented_damage_jpy: 0 };
const agent: AttributionRow = { verdict: "pass", stopped_by: "agent", stopped_by_reason_code: null, stopped_by_rule: null, prevented_damage_jpy: 500 };

describe("attributionOf", () => {
  it("止めた規則ごとに件数と防いだ額を足し、防いだ額の降順に並べる", () => {
    const rows = [
      stop("guard_exceeded", "guards[0]", 50000),
      stop("guard_exceeded", "guards[0]", 40000),
      stop("guard_exceeded", "guards[0]", 66000),
      stop("approval_required", "autonomy.mcp_write", 120000),
      stop("approval_required", "rules.items[2]", 10000),
    ];
    const r = attributionOf(rows);
    expect(r.contributions).toEqual([
      { ruleLabel: "値の上限を超えた", reasonCode: "guard_exceeded", stoppedCount: 3, preventedDamageJpy: 156000 },
      { ruleLabel: "人の確認が必要", reasonCode: "approval_required", stoppedCount: 1, preventedDamageJpy: 120000 },
      { ruleLabel: "人の確認が必要", reasonCode: "approval_required", stoppedCount: 1, preventedDamageJpy: 10000 },
    ]);
    expect(r.unfiredGuards).toBeNull();
  });

  it("止めた行だけ数える（fail の行・エージェントが止めた行・止めなかった行は入らない）", () => {
    const rows = [stop("guard_exceeded", "guards[0]", 1000, "fail"), agent, none, stop("guard_exceeded", "guards[0]", 300)];
    const r = attributionOf(rows);
    expect(r.contributions).toEqual([{ ruleLabel: "値の上限を超えた", reasonCode: "guard_exceeded", stoppedCount: 1, preventedDamageJpy: 300 }]);
  });

  it("防いだ額が出ていない行（null）は 0 円として件数だけ数える", () => {
    const r = attributionOf([stop("kill_switch", null, null)]);
    expect(r.contributions).toEqual([{ ruleLabel: "全部止めていた", reasonCode: "kill_switch", stoppedCount: 1, preventedDamageJpy: 0 }]);
  });

  it("同じ額なら止めた件数の多い順、そのあとは名前の順", () => {
    const r = attributionOf([stop("budget_exceeded", null, 100), stop("kill_switch", null, 100), stop("kill_switch", null, 0)]);
    expect(r.contributions.map((c) => c.reasonCode)).toEqual(["kill_switch", "budget_exceeded"]);
    expect(r.contributions[0]).toMatchObject({ stoppedCount: 2, preventedDamageJpy: 100 });
  });

  it("行がなければ空。発動状態が正確に復元できないため未発動一覧は出さない", () => {
    expect(attributionOf([])).toEqual({ contributions: [], unfiredGuards: null });
    const guards = [{ arg: "items[].unit_price", max: 1170 }, { arg: "items[].quantity", max: 60 }];
    expect(attributionOf([], guards).unfiredGuards).toBeNull();
  });

  it("fail の保存形は stopped_by=none なので未発動一覧に使わない", () => {
    const guards = [{ arg: "items[].unit_price", max: 1170 }, { arg: "items[].quantity", max: 60 }, { arg: "x.unknown", max: 5 }];
    const rows = [stop("guard_exceeded", "guards[1]", 300, "fail"), stop("guard_exceeded", "guards[1]", 300)];
    const r = attributionOf(rows, guards);
    expect(r.unfiredGuards).toBeNull();
    expect(r.contributions).toEqual([{ ruleLabel: "数量の上限 60個", reasonCode: "guard_exceeded", stoppedCount: 1, preventedDamageJpy: 300 }]);
  });

  it("ガードの名前は引数の上限を使い、ほかは理由の名前に任せる", () => {
    const guards = [{ arg: "items[].unit_price", max: 1170 }];
    const r = attributionOf([stop("guard_exceeded", "guards[0]", 156000), stop("guard_exceeded", "guards[0]", 0)], guards);
    expect(r.contributions[0]!.ruleLabel).toBe("単価の上限 1,170円");
  });

  it("上下限があるガードは範囲として表示する", () => {
    expect(guardLabelOf({ arg: "items[].quantity", min: 1, max: 60 })).toBe("数量の範囲 1〜60個");
  });
});

describe("guardLabelOf", () => {
  it("上限・下限の文。どちらもないか引数が分からなければ null", () => {
    expect(guardLabelOf({ arg: "items[].unit_price", max: 1170 })).toBe("単価の上限 1,170円");
    expect(guardLabelOf({ arg: "items[].quantity", min: 1 })).toBe("数量の下限 1個");
    expect(guardLabelOf({ arg: "items[].quantity" })).toBeNull();
    expect(guardLabelOf({ arg: "x.unknown", max: 5 })).toBeNull();
  });
});
