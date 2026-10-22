// 動いている仕事の登録簿（SO §3.15 の RunningTaskRegistry）
import { describe, expect, it } from "vitest";
import { createRunningTaskRegistry, StopRequested } from "./registry.ts";

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("RunningTaskRegistry", () => {
  it("abortWorkspace はそのワークスペースのものだけを中断し、中断した ID を返す（大文字小文字は区別しない）", () => {
    const r = createRunningTaskRegistry({ now: () => new Date("2026-10-14T00:00:00.000Z") });
    const a1 = new AbortController();
    const a2 = new AbortController();
    const b1 = new AbortController();
    r.register("t-2", WS_A, a2);
    r.register("t-1", WS_A.toUpperCase(), a1, "ask_generate");
    r.register("t-3", WS_B, b1);
    expect(r.abortWorkspace(WS_A, "kill_switch")).toEqual(["t-1", "t-2"]);
    expect(a1.signal.aborted && a2.signal.aborted).toBe(true);
    expect(b1.signal.aborted).toBe(false);
    expect(r.get("t-1")).toMatchObject({ stopCause: "kill_switch", stoppedAt: new Date("2026-10-14T00:00:00.000Z"), kind: "ask_generate" });
    // 中断しても登録は残る（消すのは走らせた側）。2回目は返さない
    expect(r.size).toBe(3);
    expect(r.abortWorkspace(WS_A, "kill_switch")).toEqual([]);
  });

  it("abortTask・unregister、理由は signal.reason の StopRequested", () => {
    const r = createRunningTaskRegistry();
    const c = new AbortController();
    r.register("t", WS_A, c);
    expect(r.abortTask("nope", "reset")).toBe(false);
    expect(r.abortTask("t", "reset")).toBe(true);
    expect(r.abortTask("t", "reset")).toBe(false);
    expect(c.signal.reason).toBeInstanceOf(StopRequested);
    expect((c.signal.reason as StopRequested).stopCause).toBe("reset");
    r.unregister("t");
    expect(r.size).toBe(0);
    expect(r.list()).toEqual([]);
  });

  it("同じ ID を登録し直すと置き換える（前の controller は中断しない）", () => {
    const r = createRunningTaskRegistry();
    const first = new AbortController();
    const second = new AbortController();
    r.register("t", WS_A, first);
    r.register("t", WS_A, second);
    r.abortTask("t", "shutdown");
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(true);
  });
});
