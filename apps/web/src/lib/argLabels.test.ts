import { describe, expect, it } from "vitest";
import { argLabel } from "./argLabels";

describe("argLabel", () => {
  it("内部のキーを日本語にする", () => {
    expect(argLabel("supplier_id")).toBe("仕入れ先");
    expect(argLabel("note")).toBe("備考");
    expect(argLabel("to")).toBe("宛先");
    expect(argLabel("account")).toBe("振込先口座");
  });
  it("配列のパス（添字なし）", () => {
    expect(argLabel("items[].quantity")).toBe("品目の数量");
    expect(argLabel("items[].sku")).toBe("品目の商品コード");
    expect(argLabel("items[].unit_price")).toBe("品目の単価");
  });
  it("配列のパス（添字つき）は1から数える", () => {
    expect(argLabel("items[0].quantity")).toBe("品目1の数量");
    expect(argLabel("items[2].unit_price")).toBe("品目3の単価");
    expect(argLabel("items[0]")).toBe("品目1");
  });
  it("未知のキーはそのまま出す", () => {
    expect(argLabel("foo_bar")).toBe("foo_bar");
    expect(argLabel("items[0].weird_key")).toBe("品目1のweird_key");
    expect(argLabel("")).toBe("");
    expect(argLabel("constructor")).toBe("constructor");
  });
});
