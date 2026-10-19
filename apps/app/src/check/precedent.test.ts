// 送る前の確認の前例（precedent.ts）の純粋関数の試験。DB の取得（loadPrecedentRows）は approvals の試験が通す
import { describe, expect, it } from "vitest";
import { precedentOf, precedentSummaryOf, precedentText, precedentView, type PrecedentRow } from "./precedent.ts";
import { Precedent } from "./contract.ts";

const row = (id: string, shadowDamageJpy: number | null): PrecedentRow => ({ scenarioId: id, shadowDamageJpy });

describe("precedentOf（件数と影の損害の最大）", () => {
  it("試験が0件なら undefined（画面は何も出さない）", () => {
    expect(precedentOf([])).toBeUndefined();
  });

  it("件数は試験の数、最大は影の損害の最大", () => {
    const rows = [row("a", 1200), row("b", 48000), row("c", 0)];
    expect(precedentOf(rows)).toEqual({ trials: 3, maxShadowDamageJpy: 48000 });
  });

  it("影を走らせていない試験は件数に入るが、最大の対象には入らない", () => {
    expect(precedentOf([row("a", null), row("b", 300)])).toEqual({ trials: 2, maxShadowDamageJpy: 300 });
  });

  it("影の損害がどれも無いときの最大は null（件数だけ出す）", () => {
    expect(precedentOf([row("a", null)])).toEqual({ trials: 1, maxShadowDamageJpy: null });
  });

  it("同じ状況の行が重なっても1件として数える", () => {
    expect(precedentOf([row("a", 100), row("a", 100), row("b", null)])).toEqual({ trials: 2, maxShadowDamageJpy: 100 });
  });
});

describe("precedentSummaryOf（SQL 集計行）", () => {
  it("0件は表示しない", () => {
    expect(precedentSummaryOf({ trials: 0, maxShadowDamageJpy: null })).toBeUndefined();
  });

  it("COUNT と MAX をカードの集計として保つ", () => {
    expect(precedentSummaryOf({ trials: 3, maxShadowDamageJpy: 48000 })).toEqual({ trials: 3, maxShadowDamageJpy: 48000 });
    expect(precedentSummaryOf({ trials: 2, maxShadowDamageJpy: null })).toEqual({ trials: 2, maxShadowDamageJpy: null });
  });
});

describe("precedentText（1行の文）", () => {
  it("例の文の形：件数・承認した場合の最大損害（円は3桁区切り）", () => {
    const text = precedentText("mcp.supplier.place_order", { trials: 12, maxShadowDamageJpy: 48000 });
    expect(text).toBe("練習で同じ種類の発注を12件試し、承認した場合の最大損害は ¥48,000");
  });

  it("影の損害がないときは件数だけ", () => {
    expect(precedentText("mcp.supplier.place_order", { trials: 2, maxShadowDamageJpy: null })).toBe("練習で同じ種類の発注を2件試しました");
  });

  it("知らない action は汎用の名詞（書き込み）", () => {
    expect(precedentText("mcp.unknown.do_thing", { trials: 1, maxShadowDamageJpy: 0 })).toBe("練習で同じ種類の書き込みを1件試し、承認した場合の最大損害は ¥0");
  });
});

describe("precedentView（承認のカードに付ける形）", () => {
  it("0件なら undefined、ありなら契約の形に合う", () => {
    expect(precedentView("mcp.supplier.place_order", [])).toBeUndefined();
    const view = precedentView("mcp.supplier.place_order", [row("a", 48000), row("b", 0)]);
    expect(view).toEqual({
      trials: 2,
      maxShadowDamageJpy: 48000,
      text: "練習で同じ種類の発注を2件試し、承認した場合の最大損害は ¥48,000",
    });
    expect(Precedent.safeParse(view).success).toBe(true);
  });
});
