// 報告（report.ts）の試験：数字は packages/rehearsal の集計と同じ、見出し・3段・止めたものの区別の文面
import type { DamageRow } from "@open-team/rehearsal";
import { summarizeRehearsal } from "@open-team/rehearsal";
import { describe, expect, it } from "vitest";
import { buildRehearsalReport, yen } from "./report.ts";

const kernel = (caseId: string, shadowJpy: number | null, over: Partial<DamageRow> = {}): DamageRow => ({
  caseId,
  outcome: "stopped",
  stoppedBy: { by: "kernel", decision: "approve", reasonCode: "approval_required", matchedRule: null },
  governedJpy: 0,
  shadow: shadowJpy === null ? null : { totalJpy: shadowJpy, harmed: shadowJpy > 0 },
  ...over,
});
const slip = (caseId: string, governedJpy: number, shadowJpy: number | null): DamageRow => ({
  caseId,
  outcome: "slipped",
  stoppedBy: { by: "none" },
  governedJpy,
  shadow: shadowJpy === null ? null : { totalJpy: shadowJpy, harmed: true },
});
const agent = (caseId: string): DamageRow => ({ caseId, outcome: "stopped", stoppedBy: { by: "agent" }, governedJpy: 0, shadow: null });
const none = (caseId: string): DamageRow => ({ caseId, outcome: "no_harm", stoppedBy: { by: "none" }, governedJpy: 0, shadow: null });

describe("yen", () => {
  it("3桁区切りの円。負・非有限は例外", () => {
    expect(yen(0)).toBe("¥0");
    expect(yen(344000)).toBe("¥344,000");
    expect(yen(1234567)).toBe("¥1,234,567");
    expect(() => yen(-1)).toThrow(RangeError);
    expect(() => yen(Number.NaN)).toThrow(RangeError);
  });
});

describe("buildRehearsalReport", () => {
  // 12件：Kernel が10件止め、2件がすり抜けた。統制なしの実害は7件
  const kernelRows = Array.from({ length: 10 }, (_, i) => kernel(`k${i}`, i < 5 ? 60_000 : 0));
  const rows = [...kernelRows, slip("s0", 20_000, 30_000), slip("s1", 18_000, 14_000)];
  const retest = [...kernelRows, slip("s0", 0, null), slip("s1", 0, null)].map((r) => (r.outcome === "slipped" ? { ...r, outcome: "stopped" as const, stoppedBy: { by: "kernel" as const, decision: "approve" as const, reasonCode: "approval_required", matchedRule: null } } : r));

  it("見出し・3段：「12件中10件は統制が止めた、2件がすり抜けた → 締める変更で0件」と、件数・損害額が集計の行と一致する", () => {
    const r = buildRehearsalReport(rows, retest);
    expect(r.headline).toBe("12件中10件は統制が止めた、2件がすり抜けた → 締める変更で0件");
    expect(r.total).toBe(12);
    expect(r.stopped).toEqual({ total: 10, kernel: 10, agent: 0 });
    expect(r.slipped).toBe(2);
    expect(r.noHarm).toBe(0);
    // 影があるのは 7 件（60,000×5 と、すり抜けた2件）。損害は 300,000 + 30,000 + 14,000
    expect(r.stages.map((s) => [s.key, s.count, s.damageJpy])).toEqual([
      ["withoutControl", 7, 344_000],
      ["withControl", 2, 38_000],
      ["afterTighten", 0, 0],
    ]);
    expect(r.stagesLine).toBe("統制なし：実害7件・¥344,000 → 統制あり：すり抜け2件・¥38,000 → 締めたあと：0件・¥0");
    // 数字は packages/rehearsal の集計そのもの
    expect(r.counts).toEqual(summarizeRehearsal(rows, retest));
    // 防いだ損害 = Σ max(0, 影 − 本番)。影があるのは 7 件：5×60,000 + max(0,30,000−20,000) + max(0,14,000−18,000)
    expect(r.preventedDamageJpy).toBe(310_000);
  });

  it("止めたものの区別：Kernel（決定論）とエージェント自身（揺れる）。エージェントが断った分があれば見出しに内訳を出す", () => {
    const r = buildRehearsalReport([kernel("a", null), kernel("b", null), agent("c"), agent("d"), slip("e", 5000, null), none("f")]);
    expect(r.stoppedBy.map((x) => [x.by, x.label, x.count])).toEqual([
      ["kernel", "Kernel（決定論）", 2],
      ["agent", "エージェント自身（揺れる）", 2],
    ]);
    expect(r.headline).toBe("6件中4件は止まった（Kernel が2件・エージェント自身が2件）、1件がすり抜けた、1件は害が出なかった");
    expect(r.noHarm).toBe(1);
    // 再試験がなければ「締めたあと」の段も確定の注記もない。影がなければ「統制なし」の段もない
    expect(r.stages.map((s) => s.key)).toEqual(["withControl"]);
    expect(r.determinismNote).toBeNull();
  });

  it("再試験があるとき、揺らぎに左右されないことの注記が付く。再試験は報告の母集団（rows の状況）にそろえる", () => {
    const r = buildRehearsalReport([kernel("a", 100), slip("b", 10, 50)], [kernel("a", null), kernel("b", null), slip("extra", 999, null)]);
    expect(r.determinismNote).toContain("Kernel の判定は呼び出しが同じなら同じ");
    // 後から足した試験（extra）は数えない
    expect(r.counts.afterTighten).toEqual({ slipped: 0, damageJpy: 0 });
    expect(buildRehearsalReport([kernel("a", 100), slip("b", 10, 50)], []).counts.afterTighten).toEqual({ slipped: 0, damageJpy: 0 });
  });

  it("再試験でまだすり抜けていれば、その件数・損害を出す（0件と言い張らない）", () => {
    const r = buildRehearsalReport([slip("a", 10_000, 20_000)], [slip("a", 4000, null)]);
    expect(r.headline).toBe("1件中0件は統制が止めた、1件がすり抜けた → 締める変更で1件");
    expect(r.stages.at(-1)).toMatchObject({ key: "afterTighten", count: 1, damageJpy: 4000 });
  });
});
