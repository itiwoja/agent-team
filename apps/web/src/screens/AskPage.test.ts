import { describe, expect, it } from "vitest";
import { targetIdOf } from "./AskPage";

describe("targetIdOf", () => {
  it("# の後ろの要素 ID を取り出す", () => {
    expect(targetIdOf("#approvals")).toBe("approvals");
    expect(targetIdOf("#rehearsal")).toBe("rehearsal");
  });
  it("空の # や無いハッシュは null", () => {
    expect(targetIdOf("")).toBeNull();
    expect(targetIdOf("#")).toBeNull();
  });
  it("パーセント符号を戻し、壊れていれば null", () => {
    expect(targetIdOf("#a%20b")).toBe("a b");
    expect(targetIdOf("#%E0%A4%A")).toBeNull();
  });
});
