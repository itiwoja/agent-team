import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backoffMs, ES_CLOSED, ES_CONNECTING, ES_OPEN, eventIdOf, subscribeSse, type EventSourceLike } from "./sse";

/** 偽の EventSource：テストから open / error / 事象を起こせる */
class FakeSource implements EventSourceLike {
  readyState = ES_CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  lastEventId = "";
  private listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
    this.readyState = ES_CLOSED;
  }
  open(): void {
    this.readyState = ES_OPEN;
    this.onopen?.(new Event("open"));
  }
  /** readyState を変えてから onerror（CLOSED＝ブラウザが諦めた、CONNECTING＝自動でつなぎ直し中） */
  fail(state: number): void {
    this.readyState = state;
    this.onerror?.(new Event("error"));
  }
  emit(type: string, data: string, lastEventId = ""): void {
    this.listeners.get(type)?.({ data, lastEventId } as MessageEvent<string>);
  }
}

function setup(over: { checkSession?: () => Promise<boolean>; graceMs?: number } = {}) {
  const sources: FakeSource[] = [];
  const onOpen = vi.fn();
  const onDown = vi.fn();
  const onUnauthorized = vi.fn();
  const onEvent = vi.fn();
  const close = subscribeSse(
    {
      url: "/api/v1/workspaces/w1/stream",
      eventTypes: ["check.counts", "reset"],
      createEventSource: (url) => {
        const s = new FakeSource(url);
        sources.push(s);
        return s;
      },
      checkSession: over.checkSession ?? (() => Promise.resolve(true)),
      graceMs: over.graceMs,
    },
    { onOpen, onDown, onUnauthorized, onEvent },
  );
  return { sources, onOpen, onDown, onUnauthorized, onEvent, close };
}

describe("subscribeSse", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("CLOSED のあと、バックオフして EventSource を作り直す", async () => {
    const t = setup();
    expect(t.sources).toHaveLength(1);
    t.sources[0]!.open();
    t.sources[0]!.fail(ES_CLOSED);
    expect(t.sources[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(t.sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sources).toHaveLength(2);
    // 2 回目は 2 秒待つ
    t.sources[1]!.fail(ES_CLOSED);
    await vi.advanceTimersByTimeAsync(1999);
    expect(t.sources).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sources).toHaveLength(3);
    // つながればバックオフは最初に戻る
    t.sources[2]!.open();
    t.sources[2]!.fail(ES_CLOSED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources).toHaveLength(4);
    t.close();
  });

  it("受けた事象の id を覚えて、作り直すときクエリ lastEventId で渡す", async () => {
    const t = setup();
    expect(t.sources[0]!.url).toBe("/api/v1/workspaces/w1/stream");
    t.sources[0]!.open();
    t.sources[0]!.emit("check.counts", '{"attention":1}', "42");
    expect(t.onEvent).toHaveBeenCalledWith("check.counts", { attention: 1 });
    t.sources[0]!.fail(ES_CLOSED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources[1]!.url).toBe("/api/v1/workspaces/w1/stream?lastEventId=42");
    t.close();
  });

  it("事象が来ないうちに切れても、ソースが覚えている id を作り直すときの lastEventId に使う", async () => {
    const t = setup();
    t.sources[0]!.open();
    t.sources[0]!.lastEventId = "77";
    t.sources[0]!.fail(ES_CLOSED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources[1]!.url).toBe("/api/v1/workspaces/w1/stream?lastEventId=77");
    t.close();
  });

  it("ソースの id が数字でなければ無視する（前の id を保つ）", async () => {
    const t = setup();
    t.sources[0]!.open();
    t.sources[0]!.emit("check.counts", "{}", "42");
    t.sources[0]!.lastEventId = "abc";
    t.sources[0]!.fail(ES_CLOSED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources[1]!.url).toBe("/api/v1/workspaces/w1/stream?lastEventId=42");
    t.close();
  });

  it("入り直しが要るなら作り直さず onUnauthorized を呼ぶ", async () => {
    const t = setup({ checkSession: () => Promise.resolve(false) });
    t.sources[0]!.fail(ES_CLOSED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources).toHaveLength(1);
    expect(t.onUnauthorized).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.onDown).not.toHaveBeenCalled();
    t.close();
  });

  it("セッションの確認が失敗しても（ネットワーク）つなぎ直しは続ける", async () => {
    const t = setup({ checkSession: () => Promise.reject(new Error("offline")) });
    t.sources[0]!.fail(ES_CLOSED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sources).toHaveLength(2);
    expect(t.onUnauthorized).not.toHaveBeenCalled();
    t.close();
  });

  it("CONNECTING（自動のつなぎ直し中）は猶予の間 onDown を呼ばず、open で猶予が消える", async () => {
    const t = setup({ graceMs: 8000 });
    t.sources[0]!.open();
    expect(t.onOpen).toHaveBeenCalledTimes(1);
    t.sources[0]!.fail(ES_CONNECTING);
    expect(t.sources).toHaveLength(1); // 作り直さない
    await vi.advanceTimersByTimeAsync(7999);
    expect(t.onDown).not.toHaveBeenCalled();
    t.sources[0]!.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.onDown).not.toHaveBeenCalled();
    expect(t.onOpen).toHaveBeenCalledTimes(2);
    t.close();
  });

  it("猶予を過ぎたら onDown を 1 回だけ呼び、つながったら onOpen", async () => {
    const t = setup({ graceMs: 8000 });
    t.sources[0]!.open();
    t.sources[0]!.fail(ES_CONNECTING);
    await vi.advanceTimersByTimeAsync(8000);
    expect(t.onDown).toHaveBeenCalledTimes(1);
    t.sources[0]!.fail(ES_CONNECTING);
    await vi.advanceTimersByTimeAsync(8000);
    expect(t.onDown).toHaveBeenCalledTimes(1);
    t.sources[0]!.open();
    expect(t.onOpen).toHaveBeenCalledTimes(2);
    t.close();
  });

  it("閉じたあとはタイマーも事象も無視する", async () => {
    const t = setup();
    t.sources[0]!.fail(ES_CLOSED);
    t.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.sources).toHaveLength(1);
    expect(t.onDown).not.toHaveBeenCalled();
    expect(t.sources[0]!.closed).toBe(true);
  });
});

describe("backoffMs / eventIdOf", () => {
  it("1s→2s→4s… と増え、30s で止まる", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });
  it("事象の id は 0 以上の整数の文字列だけ", () => {
    expect(eventIdOf("42")).toBe("42");
    expect(eventIdOf("0")).toBe("0");
    expect(eventIdOf("")).toBeNull();
    expect(eventIdOf(undefined)).toBeNull();
    expect(eventIdOf("abc")).toBeNull();
    expect(eventIdOf("-1")).toBeNull();
  });
});
