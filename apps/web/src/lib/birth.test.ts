import { describe, expect, it } from "vitest";
import { HATCH_MS, READY_MS } from "./ceremony";
import { birthDelayMs, birthLine, birthReducer as reduce, birthSeat, birthTitle, initialBirth, namedBirth, type BirthPhase, type BirthState } from "./birth";

function walk(s: BirthState): Array<[BirthPhase, number]> {
  const seen: Array<[BirthPhase, number]> = [[s.phase, s.hatched]];
  for (let i = 0; i < 50 && s.phase !== "done"; i++) {
    s = reduce(s, { type: "advance" });
    seen.push([s.phase, s.hatched]);
  }
  return seen;
}

describe("birthReducer", () => {
  it("名前が分かるまでは egg のまま（advance・skip でも動かない）", () => {
    expect(reduce(initialBirth, { type: "advance" })).toBe(initialBirth);
    expect(reduce(initialBirth, { type: "skip" })).toBe(initialBirth);
  });

  it("named → hatch（1 人ずつ）→ ready → done と進む", () => {
    expect(walk(namedBirth(2))).toEqual([
      ["hatch", 1],
      ["hatch", 2],
      ["ready", 2],
      ["done", 2],
    ]);
  });

  it("動きを抑えるときは最初から生まれた画面（ready）", () => {
    expect(namedBirth(2, true)).toEqual({ phase: "ready", hatched: 2, total: 2 });
  });

  it("0 人なら hatch を飛ばして ready", () => {
    expect(namedBirth(0).phase).toBe("ready");
  });

  it("とばすは hatch・ready から done（全員生まれた扱い）", () => {
    expect(reduce({ phase: "hatch", hatched: 1, total: 3 }, { type: "skip" })).toEqual({ phase: "done", hatched: 3, total: 3 });
    expect(reduce({ phase: "ready", hatched: 3, total: 3 }, { type: "skip" }).phase).toBe("done");
  });

  it("named は egg のときだけ効き、done は変わらない", () => {
    const hatching: BirthState = { phase: "hatch", hatched: 1, total: 2 };
    expect(reduce(hatching, { type: "named", total: 5 })).toBe(hatching);
    const done: BirthState = { phase: "done", hatched: 2, total: 2 };
    expect(reduce(done, { type: "advance" })).toBe(done);
  });
});

describe("birthDelayMs", () => {
  it("hatch は 1 人ぶん、ready は余韻、egg・done・動きを抑えるときは null", () => {
    expect(birthDelayMs({ phase: "hatch", hatched: 1, total: 2 }, false)).toBe(HATCH_MS);
    expect(birthDelayMs({ phase: "ready", hatched: 2, total: 2 }, false)).toBe(READY_MS);
    expect(birthDelayMs(initialBirth, false)).toBeNull();
    expect(birthDelayMs({ phase: "done", hatched: 2, total: 2 }, false)).toBeNull();
    expect(birthDelayMs({ phase: "ready", hatched: 2, total: 2 }, true)).toBeNull();
  });
});

describe("birthSeat・birthLine・birthTitle", () => {
  it("席の状態", () => {
    const s: BirthState = { phase: "hatch", hatched: 2, total: 3 };
    expect([0, 1, 2].map((i) => birthSeat(s, i))).toEqual(["born", "hatching", "wait"]);
    expect(birthSeat(initialBirth, 0)).toBe("wait");
    expect(birthSeat({ phase: "ready", hatched: 3, total: 3 }, 2)).toBe("born");
  });

  it("読み上げと見出し", () => {
    expect(birthLine(initialBirth, [])).toBe("エージェントを作っています");
    expect(birthLine({ phase: "hatch", hatched: 2, total: 2 }, ["ポチ", "タマ"])).toBe("タマが生まれました");
    expect(birthLine({ phase: "ready", hatched: 2, total: 2 }, ["ポチ", "タマ"])).toBe("エージェントが生まれました");
    expect(birthTitle(["ポチ"])).toBe("ポチが生まれました");
    expect(birthTitle(["ポチ", "タマ"])).toBe("2人のエージェントが生まれました");
  });
});
