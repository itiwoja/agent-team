import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

const t = (text: string) => ({ kind: "text", text });

describe("parseMarkdown", () => {
  it("記法のない文は1つの段落のまま（改行も残す）", () => {
    expect(parseMarkdown("在庫を見ました。\n発注しました。")).toEqual([{ kind: "paragraph", inline: [t("在庫を見ました。\n発注しました。")] }]);
  });

  it("見出し・水平線・段落を分ける", () => {
    expect(parseMarkdown("結論です。\n\n---\n\n### 今週の予定の確認結果\n確認したところ、以下の通りでした。")).toEqual([
      { kind: "paragraph", inline: [t("結論です。")] },
      { kind: "rule" },
      { kind: "heading", level: 3, inline: [t("今週の予定の確認結果")] },
      { kind: "paragraph", inline: [t("確認したところ、以下の通りでした。")] },
    ]);
  });

  it("表は区切り行（:---）があるときだけ表にする", () => {
    const md = "| 商品名 | SKU | 在庫数 |\n| :--- | :--- | :--- |\n| コーヒー豆 | BEAN-HOUSE | 2 kg |\n| 牛乳 1L | MILK-1L | 30 本 |";
    expect(parseMarkdown(md)).toEqual([
      {
        kind: "table",
        header: [[t("商品名")], [t("SKU")], [t("在庫数")]],
        rows: [
          [[t("コーヒー豆")], [t("BEAN-HOUSE")], [t("2 kg")]],
          [[t("牛乳 1L")], [t("MILK-1L")], [t("30 本")]],
        ],
      },
    ]);
    expect(parseMarkdown("| ただの縦棒 |")).toEqual([{ kind: "paragraph", inline: [t("| ただの縦棒 |")] }]);
  });

  it("箇条書きは太字とコードを含めて項目に分け、字下げは depth になる", () => {
    const md = "- **発注先**: 山田珈琲（`supplier-01`）\n- **数量**: 20 kg\n  - 内訳";
    expect(parseMarkdown(md)).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          { depth: 0, inline: [{ kind: "strong", text: "発注先" }, t(": 山田珈琲（"), { kind: "code", text: "supplier-01" }, t("）")] },
          { depth: 0, inline: [{ kind: "strong", text: "数量" }, t(": 20 kg")] },
          { depth: 1, inline: [t("内訳")] },
        ],
      },
    ]);
    expect(parseMarkdown("1. 読む\n2) 見る")).toEqual([{ kind: "list", ordered: true, items: [{ depth: 0, inline: [t("読む")] }, { depth: 0, inline: [t("見る")] }] }]);
  });

  it("水平線は3つ以上の - * _ だけ（箇条書きの - は水平線にしない）", () => {
    expect(parseMarkdown("---")).toEqual([{ kind: "rule" }]);
    expect(parseMarkdown("* * *")).toEqual([{ kind: "rule" }]);
    expect(parseMarkdown("- 一つ")).toEqual([{ kind: "list", ordered: false, items: [{ depth: 0, inline: [t("一つ")] }] }]);
  });
});

describe("parseInline", () => {
  it("太字・コード・リンクを拾う。[題名](URL) は題名だけを見せる", () => {
    expect(parseInline("**強調** と `code` と [外部](https://example.com)")).toEqual([
      { kind: "strong", text: "強調" },
      t(" と "),
      { kind: "code", text: "code" },
      t(" と "),
      { kind: "link", text: "外部", url: "https://example.com/" },
    ]);
    expect(parseInline("閉じていない **太字")).toEqual([t("閉じていない **太字")]);
  });

  it("生の URL はホスト名（www. を除く）を見せ、検索の転送の URL は「出典」にする。末尾の句読点は URL に含めない", () => {
    expect(parseInline("出典：https://www.anthropic.com/news/claude-opus-5-5。")).toEqual([
      t("出典："),
      { kind: "link", text: "anthropic.com", url: "https://www.anthropic.com/news/claude-opus-5-5" },
      t("。"),
    ]);
    expect(parseInline("see https://example.com/a.")).toEqual([t("see "), { kind: "link", text: "example.com", url: "https://example.com/a" }, t(".")]);
    expect(parseInline("https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC")).toEqual([
      { kind: "link", text: "出典", url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC" },
    ]);
  });

  it("URL の中の対応の取れた括弧は含める（題名のリンクも生の URL も）。外側の括弧は含めない", () => {
    expect(parseInline("[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) 他")).toEqual([
      { kind: "link", text: "Foo", url: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      t(" 他"),
    ]);
    expect(parseInline("参考（https://en.wikipedia.org/wiki/Foo_(bar)）")).toEqual([
      t("参考（"),
      { kind: "link", text: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      t("）"),
    ]);
    expect(parseInline("see (https://en.wikipedia.org/wiki/Foo_(bar)).")).toEqual([
      t("see ("),
      { kind: "link", text: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      t(")."),
    ]);
  });

  it("http・https 以外はリンクにしない", () => {
    expect(parseInline("[押して](javascript:alert(1)) と ftp://x.example/")).toEqual([t("[押して](javascript:alert(1)) と ftp://x.example/")]);
  });
});
