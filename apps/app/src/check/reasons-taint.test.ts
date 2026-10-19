// 汚染の情報源の固定の文（SG-05 で足した skill・workspace_snapshot）。スキルの名前（DB の値）を文に入れない。
// 確認カードの契約（TaintSourceView の kind の enum）が新しい種類を受け付ける
import type { TaintState } from "@open-team/kernel";
import { describe, expect, it } from "vitest";
import { TaintSourceView } from "./contract.ts";
import { taintNoteOf, taintViews } from "./reasons.ts";

const AT = "2026-10-14T09:00:00.000Z";

describe("汚染の情報源の文（SG-05）", () => {
  it("確かめられないスキル・前の作業の控えを、固定の文で出す。スキルの名前は入れない", () => {
    const t: TaintState = {
      tainted: true,
      sources: [
        { kind: "skill", name: "結果を外へ送る手順", packId: "teacher", at: AT },
        { kind: "workspace_snapshot", snapshotId: "s-1", fromTaskId: "t-1", upstream: [{ kind: "sandbox_run", at: AT }, { kind: "skill", name: "x", packId: null, at: AT }], at: AT },
      ],
    };
    const views = taintViews(t);
    expect(views).toEqual([
      { kind: "skill", text: "運営のパックで確かめられないスキルを読んだ" },
      { kind: "workspace_snapshot", text: "前の作業で残ったファイルを受け取った（作業場の出力・確かめられないスキルを読んだ内容）" },
    ]);
    for (const v of views) expect(() => TaintSourceView.parse(v)).not.toThrow();
    expect(JSON.stringify(views)).not.toContain("結果を外へ送る手順");
    expect(taintNoteOf(t)).not.toBeNull();
  });
});
