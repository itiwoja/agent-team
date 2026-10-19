import { describe, expect, it } from "vitest";
import { avatarTraits, moodOfStage, propOf } from "./avatar";

describe("avatarTraits", () => {
  it("同じ名前ならいつも同じ見た目", () => {
    expect(avatarTraits("仕入れ係")).toEqual(avatarTraits("仕入れ係"));
  });
  it("名前が違えば、たいてい見た目も違う", () => {
    const names = ["仕入れ係", "受信箱係", "在庫係", "まとめ係", "天気係", "予定係"];
    const keys = new Set(names.map((n) => JSON.stringify(avatarTraits(n))));
    expect(keys.size).toBe(names.length);
  });
});

describe("propOf", () => {
  it("名前の語で持ち物を選ぶ", () => {
    expect(propOf("受信箱係")).toBe("envelope");
    expect(propOf("仕入れ係")).toBe("box");
    expect(propOf("ニュースのまとめ係")).toBe("news");
    expect(propOf("ふしぎ係")).toBe("sprout");
  });
});

describe("moodOfStage", () => {
  it("段の状態を表情にする", () => {
    expect(moodOfStage("running")).toBe("running");
    expect(moodOfStage("awaiting_approval")).toBe("approval");
    expect(moodOfStage("waiting")).toBe("waiting");
  });
});
