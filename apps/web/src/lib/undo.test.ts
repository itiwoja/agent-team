import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUndoStore } from "./undo";

describe("取り消しの猶予（5秒）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const make = () => createUndoStore({ now: () => Date.now() });

  it("猶予のあいだは送らず、5秒たってから送る", async () => {
    const s = make();
    const fire = vi.fn(() => Promise.resolve());
    s.start("approval:1", fire);
    expect(s.remainingSec("approval:1")).toBe(5);
    vi.advanceTimersByTime(4999);
    expect(fire).not.toHaveBeenCalled();
    expect(s.get("approval:1")?.status).toBe("pending");
    expect(s.remainingSec("approval:1")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fire).toHaveBeenCalledTimes(1);
    expect(s.get("approval:1")?.status).toBe("done");
  });

  it("取り消すと何も送らず、行が元に戻る（記録が消える）", async () => {
    const s = make();
    const fire = vi.fn(() => Promise.resolve());
    s.start("k", fire);
    vi.advanceTimersByTime(2000);
    expect(s.cancel("k")).toBe(true);
    expect(s.get("k")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fire).not.toHaveBeenCalled();
  });

  it("送ったあとは取り消せない", async () => {
    const s = make();
    s.start("k", () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.get("k")?.status).toBe("sending");
    expect(s.cancel("k")).toBe(false);
  });

  it("失敗したら理由を残し、もう一度始められる", async () => {
    const s = make();
    s.start("k", () => Promise.reject(new Error("内容が変わりました")));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.get("k")).toMatchObject({ status: "failed", error: "内容が変わりました" });
    const fire = vi.fn(() => Promise.resolve());
    s.start("k", fire);
    expect(s.get("k")?.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("同じ行を2回押しても二重に送らない", async () => {
    const s = make();
    const fire = vi.fn(() => Promise.resolve());
    s.start("k", fire);
    s.start("k", fire);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("送ったあと（done）にもう一度始めても何もしない（行は消えたまま）", async () => {
    const s = make();
    const first = vi.fn(() => Promise.resolve());
    s.start("k", first);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.get("k")?.status).toBe("done");
    const again = vi.fn(() => Promise.resolve());
    s.start("k", again);
    expect(s.get("k")?.status).toBe("done");
    expect(s.remainingSec("k")).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(again).not.toHaveBeenCalled();
  });

  it("失敗の表示は dismiss で消え、そのあと始め直せる", async () => {
    const s = make();
    s.start("k", () => Promise.reject(new Error("期限が切れました")));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.get("k")?.status).toBe("failed");
    const before = s.version();
    s.dismiss("k");
    expect(s.get("k")).toBeUndefined();
    expect(s.version()).toBe(before + 1);
    const fire = vi.fn(() => Promise.resolve());
    s.start("k", fire);
    expect(s.get("k")?.status).toBe("pending");
  });

  it("dismiss は failed のときだけ効く（pending・sending・done・無いキーは変えない）", async () => {
    const s = make();
    const fire = vi.fn(() => Promise.resolve());
    s.start("k", fire);
    let ver = s.version();
    s.dismiss("k");
    expect(s.get("k")?.status).toBe("pending");
    expect(s.version()).toBe(ver);
    s.dismiss("unknown");
    expect(s.version()).toBe(ver);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.get("k")?.status).toBe("done");
    ver = s.version();
    s.dismiss("k");
    expect(s.get("k")?.status).toBe("done");
    expect(s.version()).toBe(ver);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("残り秒は切り上げ：始めた直後は5、1秒たつと4、送る直前は1、送ってからは0", async () => {
    const s = make();
    s.start("k", () => new Promise(() => undefined));
    expect(s.remainingSec("k")).toBe(5);
    vi.advanceTimersByTime(1);
    expect(s.remainingSec("k")).toBe(5);
    vi.advanceTimersByTime(999);
    expect(s.remainingSec("k")).toBe(4);
    vi.advanceTimersByTime(3000);
    expect(s.remainingSec("k")).toBe(1);
    vi.advanceTimersByTime(999);
    expect(s.remainingSec("k")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.get("k")?.status).toBe("sending");
    expect(s.remainingSec("k")).toBe(0);
  });

  it("取り消したあとは同じ行をもう一度始められる", async () => {
    const s = make();
    const first = vi.fn(() => Promise.resolve());
    s.start("k", first);
    expect(s.cancel("k")).toBe(true);
    const second = vi.fn(() => Promise.resolve());
    s.start("k", second);
    expect(s.remainingSec("k")).toBe(5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("猶予の長さは ms で変えられる（取り消せる時間は remainingSec に反映される）", async () => {
    const s = createUndoStore({ now: () => Date.now(), ms: 2000 });
    const fire = vi.fn(() => Promise.resolve());
    s.start("k", fire);
    expect(s.remainingSec("k")).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
