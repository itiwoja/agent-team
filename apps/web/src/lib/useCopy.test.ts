import { describe, expect, it } from "vitest";
import { copyLabel } from "./useCopy";

describe("copyLabel", () => {
  it("状態ごとの文", () => {
    expect(copyLabel("idle")).toBe("コピー");
    expect(copyLabel("copied")).toBe("コピーしました");
    expect(copyLabel("failed")).toBe("コピーできませんでした");
  });
});
