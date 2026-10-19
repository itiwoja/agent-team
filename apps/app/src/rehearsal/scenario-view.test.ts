import type { RehearsalScenarioRow } from "@open-team/db";
import { describe, expect, it } from "vitest";
import { failedOraclesView, rehearsalScenarioView } from "./scenario-view.ts";

const fail = { oracle: "O-02", status: "fail", failures: [{ oracle: "O-02", detail: "決まった文", writes: [] }] };
const pass = { oracle: "O-01", status: "pass", failures: [] };
const dmg = {
  wrongPayee: { amountJpy: 0, payments: [] },
  duplicateOrder: { amountJpy: 0, orders: [] },
  overOrder: { amountJpy: 0, lines: [] },
  overpriced: { amountJpy: 0, applied: false, lines: [] },
  secretLeaks: { count: 0, writes: [] },
  totalJpy: 0,
};

function row(over: Partial<RehearsalScenarioRow>): RehearsalScenarioRow {
  return { id: "s1", case_id: "c1", ordinal: 1, status: "done", fault_ids: [], verdict: "fail", stopped_by: "none", damage_jpy: 0, ...over } as unknown as RehearsalScenarioRow;
}

describe("rehearsalScenarioView（なぜ fail か）", () => {
  it("fail のオラクルを分岐つきで出し、保存した値をそのまま返す", () => {
    const v = rehearsalScenarioView(
      row({
        oracle_results: { governed: [pass, fail], shadow: null } as never,
        branch_results: { rejected: [pass], approved: [pass, fail] } as never,
        approve_branch_damage_jpy: 0 as never,
        approve_branch_damage_breakdown: dmg as never,
      }),
    );
    expect(v.failedOracles).toEqual([{ oracle: "O-02", branch: "approved", details: ["決まった文"] }]);
    expect(v.branchResults).toEqual({ rejected: [pass], approved: [pass, fail] });
    expect(v.oracleResults).toEqual({ governed: [pass, fail], shadow: null });
    expect(v.approveBranchDamageJpy).toBe(0);
    expect(v.approveBranchDamageBreakdown?.totalJpy).toBe(0);
    expect(v.stoppedBy).toBe("none");
  });

  it("未保存・形が違う値でも落ちない", () => {
    const v = rehearsalScenarioView(row({ oracle_results: null, branch_results: null, approve_branch_damage_breakdown: null }));
    expect(v.failedOracles).toEqual([]);
    expect(v.branchResults).toEqual({ rejected: null, approved: null });
    expect(v.approveBranchDamageBreakdown).toBeNull();
    expect(failedOraclesView("x")).toEqual([]);
  });

  it("rejected でも approved でも落ちたら両方並べる", () => {
    expect(failedOraclesView({ rejected: [fail], approved: [fail] }).map((f) => f.branch)).toEqual(["rejected", "approved"]);
  });
});
