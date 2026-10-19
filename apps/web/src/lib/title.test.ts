import { describe, expect, it } from "vitest";
import { composeTitle, shortenForTitle } from "./title";

describe("composeTitle", () => {
  it("画面の名前とアプリ名", () => {
    expect(composeTitle("チェック")).toBe("チェック · Makase");
  });
  it("見てほしいものがあれば件数を先頭に出す（0 なら出さない）", () => {
    expect(composeTitle("任せる", { attention: 3 })).toBe("(3) 任せる · Makase");
    expect(composeTitle("任せる", { attention: 0 })).toBe("任せる · Makase");
  });
  it("中身が決めた題は画面の名前より優先し、長ければ切る", () => {
    expect(composeTitle("依頼", { override: "在庫が減ったら発注して" })).toBe("在庫が減ったら発注して · Makase");
    const long = "あ".repeat(40);
    expect(composeTitle("依頼", { override: long, attention: 2 })).toBe(`(2) ${"あ".repeat(27)}… · Makase`);
    expect(composeTitle("依頼", { override: "" })).toBe("依頼 · Makase");
  });
});

describe("shortenForTitle", () => {
  it("改行や連続した空白は1つにし、前後の空白を落とす", () => {
    expect(shortenForTitle("  仕入れ先の\n\nメールを  読んで ")).toBe("仕入れ先の メールを 読んで");
  });
});
