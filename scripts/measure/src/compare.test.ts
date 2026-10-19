// モデル比較の表（compare.ts）の試験。既存の計測結果の形（trap-rate・governed）から、1モデル1行の表を作る
import { describe, expect, it } from "vitest";
import { loadCompareEntry, renderCompareMarkdown, type CompareEntry } from "./compare.ts";

const trapRate = (over: Record<string, unknown> = {}) => ({
  conditions: { date: "2026-10-06", llm: "gemini", model: "gemini-3.8-flash", unpricedModels: [] },
  rows: [
    { fault: "F-01", runs: 2, failedRuns: 1, totalDamageJpy: 15_600 },
    { fault: "F-02", runs: 2, failedRuns: 0, totalDamageJpy: 0 },
  ],
  costUsd: "0.123456",
  complete: true,
  ...over,
});

// 実データに近い形：影（shadow）は no_rule の走行だけに付く（計測の作りのとおり）
const governed = () => ({
  conditions: { date: "2026-10-06", llm: "gemini", model: "gemini-3.1-pro-preview", costMicroUsd: 2_000_000 },
  records: [
    { config: "no_rule", fault: "F-01", outcome: "stopped", shadow: { failed: true, damageJpy: 15_600 }, governed: { failed: false, damageJpy: 0 } },
    { config: "no_rule", fault: "F-02", outcome: "no_harm", shadow: { failed: false, damageJpy: 0 }, governed: { failed: false, damageJpy: 0 } },
    { config: "tightened", fault: "F-01", outcome: "stopped", shadow: null, governed: { failed: false, damageJpy: 0 } },
    { config: "tightened", fault: "F-01", outcome: "slipped", shadow: null, governed: { failed: true, damageJpy: 31_200 } },
    { config: "tightened", fault: "F-02", outcome: "no_harm", shadow: null, governed: { failed: false, damageJpy: 0 } },
  ],
});

function entry(over: Partial<CompareEntry> = {}): CompareEntry {
  return {
    source: "a.json",
    kind: "trap-rate",
    model: "gemini-3.8-flash",
    date: "2026-10-06",
    llm: "gemini",
    scripted: false,
    unpriced: false,
    complete: true,
    perFault: [{ fault: "F-01", runs: 2, failedRuns: 1 }],
    ungovernedDamageJpy: 15_600,
    costUsd: 0.5,
    governed: null,
    ...over,
  };
}

describe("loadCompareEntry", () => {
  it("trap-rate：状況ごとの失敗の回数・統制なしの損害の合計・費用（JSON の文字列を数にする）", () => {
    const e = loadCompareEntry(trapRate(), "trap.json");
    expect(e).toEqual({
      source: "trap.json",
      kind: "trap-rate",
      model: "gemini-3.8-flash",
      date: "2026-10-06",
      llm: "gemini",
      scripted: false,
      unpriced: false,
      complete: true,
      perFault: [
        { fault: "F-01", runs: 2, failedRuns: 1 },
        { fault: "F-02", runs: 2, failedRuns: 0 },
      ],
      ungovernedDamageJpy: 15_600,
      costUsd: 0.123456,
      governed: null,
    });
  });

  it("trap-rate：scripted・価格表にないモデル・途中までを印として読む", () => {
    const e = loadCompareEntry(
      trapRate({ conditions: { date: "2026-10-06", llm: "scripted", model: "scripted-trap", unpricedModels: ["x"] }, complete: false }),
      "s.json",
    );
    expect(e).toMatchObject({ scripted: true, unpriced: true, complete: false });
  });

  it("governed：既定は tightened の設定。統制なしの失敗と損害は影の走行、止めた件数と統制ありの損害は統制の走行、費用は全体", () => {
    const e = loadCompareEntry(governed(), "gov.json");
    expect(e).toMatchObject({
      kind: "governed",
      model: "gemini-3.1-pro-preview",
      costUsd: 2,
      perFault: [
        { fault: "F-01", runs: 1, failedRuns: 1 },
        { fault: "F-02", runs: 1, failedRuns: 0 },
      ],
      ungovernedDamageJpy: 15_600,
      governed: { config: "tightened", runs: 3, stopped: 1, damageJpy: 31_200 },
    });
  });

  it("governed：--governed-config で設定を選ぶ。影は設定を問わず集める。ない設定は例外", () => {
    const e = loadCompareEntry(governed(), "gov.json", { governedConfig: "no_rule" });
    expect(e.governed).toEqual({ config: "no_rule", runs: 2, failed: 0, stopped: 1, damageJpy: 0 });
    expect(e.ungovernedDamageJpy).toBe(15_600);
    expect(() => loadCompareEntry(governed(), "gov.json", { governedConfig: "candidate_rule" })).toThrow(/設定 candidate_rule がない/);
  });

  it("governed：影の記録がなければ統制なしの損害は null（0 円とは書かない）", () => {
    const g = governed();
    g.records = g.records.map((r) => ({ ...r, shadow: null }));
    expect(loadCompareEntry(g, "n.json")).toMatchObject({ ungovernedDamageJpy: null, perFault: [] });
  });

  it("governed：生成処理どおりの error/null 記録を失敗として数え、損害を欠測にする", () => {
    const g: { conditions: Record<string, unknown>; records: Record<string, unknown>[] } = governed();
    g.records = g.records.map((r) => r.config === "tightened" ? { ...r, status: "error", outcome: null, governed: null } : r);
    const e = loadCompareEntry(g, "failed.json");
    expect(e.governed).toEqual({ config: "tightened", runs: 0, failed: 3, stopped: 0, damageJpy: 0 });
    expect(e.complete).toBe(false);
  });

  it("governed：budget で予定件数に届かない結果は未完了", () => {
    const g: { conditions: Record<string, unknown>; records: Record<string, unknown>[] } = governed();
    g.conditions = { ...g.conditions, stopped: "budget", faultParams: { "F-01": {}, "F-02": {} }, runsPerScenario: 2 };
    expect(loadCompareEntry(g, "budget.json").complete).toBe(false);
  });

  it("形が違う JSON は例外（何のファイルか分かる文）", () => {
    expect(() => loadCompareEntry({ conditions: {} }, "x.json")).toThrow(/x\.json：計測結果の形ではない/);
    expect(() => loadCompareEntry(trapRate({ rows: "oops" }), "y.json")).toThrow(/y\.json の rows が配列ではない/);
  });
});

describe("renderCompareMarkdown", () => {
  it("同一モデルの複数ファイルと同じ入力の重複を1行にまとめ、shadow を重複加算しない", () => {
    const trap = loadCompareEntry(trapRate(), "trap.json");
    const govRaw = governed();
    govRaw.conditions.model = "gemini-3.8-flash";
    const gov = loadCompareEntry(govRaw, "gov.json");
    const md = renderCompareMarkdown([trap, gov, trap]);
    expect(md.match(/\| gemini-3\.8-flash/g)).toHaveLength(1);
    expect(md).toContain("trap.json・gov.json");
    expect(md).toContain("| F-01 失敗 | F-02 失敗 | 統制なしの損害 |");
  });
  it("1モデル1行：状況ごとの失敗の回数（失敗/回）・統制なしの損害・統制ありで止めた件数・統制ありの損害・費用", () => {
    const md = renderCompareMarkdown([loadCompareEntry(trapRate(), "trap.json"), loadCompareEntry(governed(), "gov.json")]);
    expect(md).toContain("| モデル | 出典 | 日付 | F-01 失敗 | F-02 失敗 | 統制なしの損害 | 統制ありで止めた件数 | 統制ありの損害 | 費用 |");
    expect(md).toContain("| gemini-3.8-flash | trap.json | 2026-10-06 | 1/2 | 0/2 | ¥15,600 | — | — | $0.1235 |");
    expect(md).toContain("| gemini-3.1-pro-preview | gov.json | 2026-10-06 | 1/1 | 0/1 | ¥15,600 | 1/3（tightened） | ¥31,200 | $2.0000 |");
    expect(renderCompareMarkdown([entry({ ungovernedDamageJpy: null })])).toContain("| gemini-3.8-flash | a.json | 2026-10-06 | 1/2 | — |");
  });

  it("偽物・価格表にないモデル・途中までの結果には、それぞれ注意を出す", () => {
    const md = renderCompareMarkdown([
      entry({ scripted: true, unpriced: true, complete: false }),
    ]);
    expect(md).toContain("偽物のエージェント（scripted）の結果を含む");
    expect(md).toContain("価格表にないモデルを高めの単価で数えた結果を含む");
    expect(md).toContain("途中までの結果を含む");
  });

  it("注意がない結果には注意の行を出さない", () => {
    expect(renderCompareMarkdown([entry()])).not.toMatch(/偽物|価格表にない|途中まで/);
  });

  it("状況の列は全部の結果の和。ある結果に状況がなければ —", () => {
    const md = renderCompareMarkdown([entry({ perFault: [{ fault: "F-03", runs: 1, failedRuns: 1 }] }), entry({ model: "b", perFault: [] })]);
    expect(md).toContain("| モデル | 出典 | 日付 | F-03 失敗 |");
    expect(md).toContain("| b | a.json | 2026-10-06 | — |");
  });

  it("空の入力は、比べる結果がないと一文だけ出す", () => {
    expect(renderCompareMarkdown([])).toContain("比べる結果がない");
  });
});
