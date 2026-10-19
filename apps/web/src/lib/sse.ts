// SSE の購読（EventSource）のつなぎ直しの論理。api.ts の subscribeWorkspace がここを使う。
//
// ブラウザの EventSource は、サーバーが非 200 で閉じたり Cloud Run が切ったりすると readyState が CLOSED になって
// 二度とつなぎ直さない（ネットワークの切断なら CONNECTING で自動でつなぎ直す）。ここでは
// - CLOSED なら指数バックオフ（1s→2s→…最大30s）で EventSource を作り直す。受けた事象の id を覚えていれば
//   クエリ lastEventId で渡す（サーバーは Last-Event-ID かクエリ lastEventId を受ける：apps/app/src/routes/stream.ts）
// - 作り直す前に checkSession で入り直しが要るか確かめ、要るなら諦めて onUnauthorized を呼ぶ
// - 切れてすぐ「つながっていません」にせず、猶予（既定 8 秒）の間につながれば何も出さない
// EventSource はコンストラクタを注入できる（vitest では本物がないため）。

/** EventSource のうち使う部分（テストでは偽物を渡す） */
export interface EventSourceLike {
  readonly readyState: number;
  /** 受けた最後の id（ある実装だけ持つ。標準の EventSource は持たないので、そのときは事象の id で覚える） */
  readonly lastEventId?: string;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** EventSource.readyState の値（グローバルの EventSource に頼らない） */
export const ES_CONNECTING = 0;
export const ES_OPEN = 1;
export const ES_CLOSED = 2;

export interface SseSubscription {
  /** つながった（最初も、つなぎ直しも）。画面は REST で取り直す */
  onOpen?: () => void;
  /** 猶予の間につながらなかった（「つながっていません」を出す）。次に onOpen が来るまで二度は呼ばない */
  onDown?: () => void;
  /** 入り直しが要る（つなぎ直しはやめる） */
  onUnauthorized?: () => void;
  onEvent: (type: string, data: unknown) => void;
}

export interface SseOptions {
  /** クエリなしの URL */
  url: string;
  /** 受ける事象の名前 */
  eventTypes: readonly string[];
  createEventSource: EventSourceFactory;
  /** つなぎ直す前に呼ぶ。false なら入り直しが要る（401）。取れなければ true を返してつなぎ直しを続ける */
  checkSession: () => Promise<boolean>;
  /** 既定 8000 */
  graceMs?: number;
  /** 既定 1000 */
  minBackoffMs?: number;
  /** 既定 30000 */
  maxBackoffMs?: number;
}

/** つなぎ直す前の待ち（attempt は 0 から。1s→2s→4s→…→上限） */
export function backoffMs(attempt: number, min = 1000, max = 30_000): number {
  return Math.min(max, min * 2 ** Math.max(0, attempt));
}

/** 事象の id（0 以上の整数の文字列）なら返す。ほかは null */
export function eventIdOf(raw: string | undefined | null): string | null {
  return raw && /^\d{1,15}$/.test(raw) ? raw : null;
}

export function subscribeSse(opts: SseOptions, handlers: SseSubscription): () => void {
  const graceMs = opts.graceMs ?? 8000;
  let es: EventSourceLike | null = null;
  let closed = false;
  let down = false;
  let attempt = 0;
  let lastEventId: string | null = null;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const parse = (ev: MessageEvent<string>): unknown => {
    try {
      return JSON.parse(ev.data);
    } catch {
      // 本文なし
      return null;
    }
  };

  const startGrace = (): void => {
    if (down || grace !== undefined) return;
    grace = setTimeout(() => {
      grace = undefined;
      if (closed) return;
      down = true;
      handlers.onDown?.();
    }, graceMs);
  };

  const open = (): void => {
    if (closed) return;
    const u = lastEventId === null ? opts.url : `${opts.url}${opts.url.includes("?") ? "&" : "?"}lastEventId=${lastEventId}`;
    const source = opts.createEventSource(u);
    es = source;
    for (const type of opts.eventTypes) {
      source.addEventListener(type, (ev) => {
        if (closed || es !== source) return;
        const id = eventIdOf(ev.lastEventId);
        if (id !== null) lastEventId = id;
        handlers.onEvent(type, parse(ev));
      });
    }
    source.onopen = () => {
      if (closed || es !== source) return;
      attempt = 0;
      clearTimeout(grace);
      grace = undefined;
      down = false;
      handlers.onOpen?.();
    };
    source.onerror = () => {
      if (closed || es !== source) return;
      // CLOSED にして作り直す前に、ソースが覚えている id を拾う（事象が来ないうちに切れても、取りこぼしを減らす）
      const native = eventIdOf(source.lastEventId);
      if (native !== null) lastEventId = native;
      startGrace();
      if (source.readyState !== ES_CLOSED) return; // CONNECTING：ブラウザが自分でつなぎ直す
      source.close();
      es = null;
      const wait = backoffMs(attempt, opts.minBackoffMs, opts.maxBackoffMs);
      attempt += 1;
      retry = setTimeout(() => {
        retry = undefined;
        if (closed) return;
        void opts
          .checkSession()
          .catch(() => true)
          .then((ok) => {
            if (closed) return;
            if (ok) open();
            else {
              clearTimeout(grace);
              grace = undefined;
              handlers.onUnauthorized?.();
            }
          });
      }, wait);
    };
  };

  open();

  return () => {
    closed = true;
    clearTimeout(grace);
    clearTimeout(retry);
    es?.close();
    es = null;
  };
}
