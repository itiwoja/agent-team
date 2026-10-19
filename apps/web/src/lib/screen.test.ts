import { describe, expect, it } from "vitest";
import { backOf, titleOf } from "./screen";

describe("backOf（ヘッダーの戻る）", () => {
  it("入口では出さない", () => {
    expect(backOf({ name: "home" })).toBeNull();
  });
  it("ひとつ上の階層へ：パックの作業場→棚、済んだもの→チェック", () => {
    expect(backOf({ name: "pack", packId: "x" })).toEqual({ to: "/packs", label: "パック" });
    expect(backOf({ name: "done" })).toEqual({ to: "/check", label: "チェック" });
  });
  it("それ以外は入口へ", () => {
    expect(backOf({ name: "check", item: null })).toEqual({ to: "/", label: "任せる" });
    expect(backOf({ name: "ask", askId: "a" })).toEqual({ to: "/", label: "任せる" });
    expect(backOf({ name: "packs", q: "", category: null })).toEqual({ to: "/", label: "任せる" });
    expect(backOf({ name: "notFound" })).toEqual({ to: "/", label: "任せる" });
  });
});

describe("titleOf", () => {
  it("画面の名前（アプリ名は composeTitle が足す）", () => {
    expect(titleOf({ name: "home" })).toBe("任せる");
    expect(titleOf({ name: "ask", askId: "a" })).toBe("依頼");
    expect(titleOf({ name: "pack", packId: "x" })).toBe("パックの作業場");
    expect(titleOf({ name: "asks", q: "", status: null })).toBe("依頼の一覧");
  });
});
