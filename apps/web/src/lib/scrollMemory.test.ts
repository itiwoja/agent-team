import { describe, expect, it } from "vitest";
import { createScrollMemory, keyOfState, newHistoryKey, restoreWhenTall } from "./scrollMemory";

describe("createScrollMemory", () => {
  it("覚えた位置を鍵で取り出せ、取り出したら消える", () => {
    const m = createScrollMemory();
    m.remember("a", 120.6);
    expect(m.take("a")).toBe(121);
    expect(m.take("a")).toBeNull();
    expect(m.take("b")).toBeNull();
  });
  it("負の位置は 0 にし、同じ鍵は上書きする", () => {
    const m = createScrollMemory();
    m.remember("a", -5);
    expect(m.take("a")).toBe(0);
    m.remember("a", 10);
    m.remember("a", 20);
    expect(m.take("a")).toBe(20);
  });
  it("古いものから忘れる（50 件まで）", () => {
    const m = createScrollMemory();
    for (let i = 0; i < 51; i++) m.remember(`k${i}`, i);
    expect(m.take("k0")).toBeNull();
    expect(m.take("k1")).toBe(1);
    expect(m.take("k50")).toBe(50);
  });
});

describe("keyOfState / newHistoryKey", () => {
  it("state の key を取り出す（無ければ null）", () => {
    expect(keyOfState({ key: "h1" })).toBe("h1");
    expect(keyOfState({ key: "" })).toBeNull();
    expect(keyOfState({ key: 1 })).toBeNull();
    expect(keyOfState(null)).toBeNull();
    expect(keyOfState("x")).toBeNull();
  });
  it("新しい鍵は毎回違う", () => {
    expect(newHistoryKey(() => 0.1)).not.toBe(newHistoryKey(() => 0.2));
  });
});

describe("restoreWhenTall", () => {
  function harness(y: number, heights: number[], timeoutMs = 1500) {
    const calls: number[] = [];
    let height = heights[0] ?? 0;
    let tick: (() => void) | null = null;
    let t = 0;
    const stop = restoreWhenTall(y, {
      scrollTo: (v) => calls.push(v),
      maxScroll: () => height,
      observe: (fn) => {
        tick = fn;
        return () => {
          tick = null;
        };
      },
      now: () => t,
      timeoutMs,
    });
    const grow = (h: number, dt = 0) => {
      height = h;
      t += dt;
      tick?.();
    };
    return { calls, grow, stop, observing: () => tick !== null };
  }
  it("高さが足りたら戻し、監視をやめる", () => {
    const h = harness(300, [0]);
    expect(h.calls).toEqual([]);
    h.grow(200);
    expect(h.calls).toEqual([]);
    h.grow(400);
    expect(h.calls).toEqual([300]);
    expect(h.observing()).toBe(false);
  });
  it("最初から足りていれば、すぐ戻す", () => {
    const h = harness(100, [500]);
    expect(h.calls).toEqual([100]);
    expect(h.observing()).toBe(false);
  });
  it("待ちすぎたら、その時点の高さで戻す", () => {
    const h = harness(300, [0]);
    h.grow(50, 2000);
    expect(h.calls).toEqual([300]);
  });
  it("止めたら何もしない", () => {
    const h = harness(300, [0]);
    h.stop();
    h.grow(400);
    expect(h.calls).toEqual([]);
  });
});
