import { describe, expect, it } from "vitest";
import { backOf, titleOf } from "./screen";

describe("backOf（ヘッダーの戻る）", () => {
  it("チャットでは出さない", () => {
    expect(backOf({ name: "home" })).toBeNull();
  });
  it("ひとつ上の階層へ：依頼→チャット、パックの作業場→棚、済んだもの→チェック", () => {
    expect(backOf({ name: "ask", askId: "a" })).toEqual({ to: "/", label: "チャット" });
    expect(backOf({ name: "pack", packId: "x" })).toEqual({ to: "/packs", label: "パック" });
    expect(backOf({ name: "done" })).toEqual({ to: "/check", label: "チェック" });
  });
  it("それ以外はチャットへ", () => {
    expect(backOf({ name: "check", item: null })).toEqual({ to: "/", label: "チャット" });
    expect(backOf({ name: "agents" })).toEqual({ to: "/", label: "チャット" });
    expect(backOf({ name: "packs", q: "", category: null })).toEqual({ to: "/", label: "チャット" });
    expect(backOf({ name: "notFound" })).toEqual({ to: "/", label: "チャット" });
  });
});

describe("titleOf", () => {
  it("画面の名前（アプリ名は composeTitle が足す）", () => {
    expect(titleOf({ name: "home" })).toBe("チャット");
    expect(titleOf({ name: "agents" })).toBe("エージェント");
    expect(titleOf({ name: "ask", askId: "a" })).toBe("依頼");
    expect(titleOf({ name: "pack", packId: "x" })).toBe("パックの作業場");
    expect(titleOf({ name: "asks", q: "", status: null })).toBe("依頼の一覧");
  });
});
