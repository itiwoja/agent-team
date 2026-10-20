import { describe, expect, it } from "vitest";
import { chainLevels, shapeLineOf } from "./shape";

const m = (agentName: string, position: number | null = null, isAggregator = false) => ({ agentName, position, isAggregator });

describe("shapeLineOf（形の1行）", () => {
  it("ひとりは出さない", () => {
    expect(shapeLineOf("single", [m("仕入れ係")])).toBeNull();
    expect(shapeLineOf(null, [])).toBeNull();
  });
  it("並列", () => {
    expect(shapeLineOf("parallel", [m("A"), m("B")])).toBe("2人がそれぞれ動いて、答えを1つにして届けます");
  });
  it("まとめ：まとめ役は人数に数えない", () => {
    expect(shapeLineOf("aggregate", [m("A"), m("B"), m("C"), m("まとめ役", null, true)])).toBe("3人が調べて、まとめ役が1つにして届けます");
  });
  it("順番：同時に動く担当は「・」でつなぎ、同時に動くことを添える", () => {
    const ms = [
      { ...m("文章", 1), dependsOn: [] },
      { ...m("デザイン", 2), dependsOn: [] },
      { ...m("実装", 3), dependsOn: [1, 2] },
      { ...m("チェック", 4), dependsOn: [3] },
    ];
    expect(shapeLineOf("chain", ms)).toBe("文章・デザイン → 実装 → チェック の順に進めて（文章とデザインは同時に動きます）、チェックが答えます");
    expect([...chainLevels(ms).entries()]).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 3],
    ]);
  });
  it("順番：段の順に並べ、最後が答える", () => {
    expect(shapeLineOf("chain", [m("仕入れ係", 2), m("受信箱係", 1)])).toBe("受信箱係 → 仕入れ係 の順に進めて、仕入れ係が答えます");
  });
});
