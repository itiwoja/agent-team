import { describe, expect, it } from "vitest";
import { ceremonyReducer as reduce, deskStage, initialCeremony, kitTags, liveLine, nextDelayMs, totalMs, type CeremonyPhase, type CeremonyState } from "./ceremony";

const advance = (s: CeremonyState) => reduce(s, { type: "advance" });

/** done になるまで advance を送り、通った (phase, hatched) を返す */
function walk(s: CeremonyState): Array<[CeremonyPhase, number]> {
  const seen: Array<[CeremonyPhase, number]> = [[s.phase, s.hatched]];
  for (let i = 0; i < 50 && s.phase !== "done"; i++) {
    s = advance(s);
    seen.push([s.phase, s.hatched]);
  }
  return seen;
}

describe("ceremonyReducer", () => {
  it("prepare → hatch（1 人ずつ）→ equip → ready → done と進む", () => {
    expect(walk(initialCeremony(3))).toEqual([
      ["prepare", 0],
      ["hatch", 1],
      ["hatch", 2],
      ["hatch", 3],
      ["equip", 3],
      ["ready", 3],
      ["done", 3],
    ]);
  });

  it("担当がいなければたまごの段を飛ばす", () => {
    expect(walk(initialCeremony(0)).map(([p]) => p)).toEqual(["prepare", "equip", "ready", "done"]);
  });

  it("とばすはどの段からでも done（全員生まれた扱い）", () => {
    for (const phase of ["prepare", "hatch", "equip", "ready"] as const) {
      const s: CeremonyState = { phase, hatched: 1, total: 4 };
      expect(reduce(s, { type: "skip" })).toEqual({ phase: "done", hatched: 4, total: 4 });
    }
  });

  it("done は何を送っても変わらない（同じ参照を返す）", () => {
    const done = reduce(initialCeremony(2), { type: "skip" });
    expect(advance(done)).toBe(done);
    expect(reduce(done, { type: "skip" })).toBe(done);
  });

  it("動きを抑えるときは最初から ready で全員そろっている", () => {
    expect(initialCeremony(3, true)).toEqual({ phase: "ready", hatched: 3, total: 3 });
  });
});

describe("nextDelayMs", () => {
  it("各段の待ち（prepare 1.2s・hatch 1 人 1.1s・equip 1.4s・ready 1.8s）", () => {
    const s = initialCeremony(2);
    expect(nextDelayMs(s, 2, false)).toBe(1200);
    expect(nextDelayMs({ ...s, phase: "hatch", hatched: 1 }, 2, false)).toBe(1100);
    expect(nextDelayMs({ ...s, phase: "equip", hatched: 2 }, 2, false)).toBe(1400);
    expect(nextDelayMs({ ...s, phase: "ready", hatched: 2 }, 2, false)).toBe(1800);
    expect(nextDelayMs({ ...s, phase: "done", hatched: 2 }, 2, false)).toBeNull();
  });

  it("動きを抑えるときはどの段も自動では進まない", () => {
    for (const phase of ["prepare", "hatch", "equip", "ready", "done"] as const) {
      expect(nextDelayMs({ phase, hatched: 1, total: 2 }, 2, true)).toBeNull();
    }
  });

  it("待ちの合計が totalMs と一致する", () => {
    for (const n of [0, 1, 3, 6]) {
      let s = initialCeremony(n);
      let sum = 0;
      for (let i = 0; i < 50; i++) {
        const d = nextDelayMs(s, n, false);
        if (d === null) break;
        sum += d;
        s = advance(s);
      }
      expect(s.phase).toBe("done");
      expect(sum).toBe(totalMs(n));
    }
  });
});

describe("totalMs", () => {
  it("人数ぶんの合計（固定値）", () => {
    expect(totalMs(0)).toBe(4400);
    expect(totalMs(1)).toBe(5500);
    expect(totalMs(3)).toBe(7700);
    expect(totalMs(5)).toBe(9900);
  });
});

describe("deskStage", () => {
  it("prepare は全員待ち、hatch は 1 人ずつかえり、equip 以降は全員生まれている", () => {
    expect(deskStage(initialCeremony(3), 0)).toBe("wait");
    const hatch = (hatched: number): CeremonyState => ({ phase: "hatch", hatched, total: 3 });
    expect([0, 1, 2].map((i) => deskStage(hatch(1), i))).toEqual(["hatching", "wait", "wait"]);
    expect([0, 1, 2].map((i) => deskStage(hatch(2), i))).toEqual(["born", "hatching", "wait"]);
    expect([0, 1, 2].map((i) => deskStage(hatch(3), i))).toEqual(["born", "born", "hatching"]);
    expect([0, 1, 2].map((i) => deskStage({ phase: "equip", hatched: 3, total: 3 }, i))).toEqual(["born", "born", "born"]);
  });
});

describe("kitTags", () => {
  it("スキル → スクリプトの順で 4 枚まで、残りは more", () => {
    expect(kitTags(["a", "b"], ["x.sh"])).toEqual({
      tags: [
        { label: "a", kind: "skill" },
        { label: "b", kind: "skill" },
        { label: "x.sh", kind: "file" },
      ],
      more: 0,
    });
    const r = kitTags(["a", "b", "c"], ["x.sh", "y.sh", "z.sh"]);
    expect(r.tags.map((t) => t.label)).toEqual(["a", "b", "c", "x.sh"]);
    expect(r.more).toBe(2);
  });

  it("空なら札なし", () => {
    expect(kitTags([], [])).toEqual({ tags: [], more: 0 });
  });
});

describe("liveLine", () => {
  const names = ["調べ屋", "まとめ屋"];
  it("段ごとの読み上げ", () => {
    expect(liveLine({ phase: "prepare", hatched: 0, total: 2 }, names)).toBe("作業場を用意しています");
    expect(liveLine({ phase: "hatch", hatched: 1, total: 2 }, names)).toBe("調べ屋が生まれました");
    expect(liveLine({ phase: "hatch", hatched: 2, total: 2 }, names)).toBe("まとめ屋が生まれました");
    expect(liveLine({ phase: "equip", hatched: 2, total: 2 }, names)).toBe("道具を配っています");
    expect(liveLine({ phase: "ready", hatched: 2, total: 2 }, names)).toBe("チームがそろいました");
  });
});
