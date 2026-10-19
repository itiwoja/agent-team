// ○ のあとの取り消しの猶予（A-91：5秒）。猶予が過ぎてから承認を送る。
// 画面を移っても止まらないよう、React の外（モジュールのストア）にタイマーを置く。ページを閉じたときは送らず、行が残る。
import { useEffect, useState, useSyncExternalStore } from "react";

export const UNDO_MS = 5000;

export type UndoStatus = "pending" | "sending" | "failed" | "done";

export interface UndoEntry {
  status: UndoStatus;
  /** 送る時刻（pending のとき） */
  deadline: number;
  /** failed のときの1行 */
  error: string | null;
}

export interface UndoStoreOptions {
  ms?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export interface UndoStore {
  /** 猶予を始める。すでに pending / sending / done のキーは何もしない（failed のあとだけ始め直せる） */
  start(key: string, fire: () => Promise<void>): void;
  /** 猶予のうちに取り消す。取り消せたら true（サーバーには何も送っていない） */
  cancel(key: string): boolean;
  get(key: string): UndoEntry | undefined;
  /** 残り秒（切り上げ）。pending でなければ 0 */
  remainingSec(key: string): number;
  /** 失敗の表示を消す */
  dismiss(key: string): void;
  subscribe(fn: () => void): () => void;
  version(): number;
}

export function createUndoStore(opts: UndoStoreOptions = {}): UndoStore {
  const ms = opts.ms ?? UNDO_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, t) => setTimeout(fn, t));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const entries = new Map<string, UndoEntry>();
  const handles = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let ver = 0;
  const emit = () => {
    ver++;
    listeners.forEach((fn) => fn());
  };

  return {
    start(key, fire) {
      const cur = entries.get(key);
      if (cur && (cur.status === "pending" || cur.status === "sending" || cur.status === "done")) return;
      entries.set(key, { status: "pending", deadline: now() + ms, error: null });
      handles.set(
        key,
        setTimer(() => {
          handles.delete(key);
          entries.set(key, { status: "sending", deadline: 0, error: null });
          emit();
          fire().then(
            () => {
              entries.set(key, { status: "done", deadline: 0, error: null });
              emit();
            },
            (e: unknown) => {
              entries.set(key, { status: "failed", deadline: 0, error: e instanceof Error ? e.message : "送れませんでした" });
              emit();
            },
          );
        }, ms),
      );
      emit();
    },
    cancel(key) {
      const e = entries.get(key);
      if (!e || e.status !== "pending") return false;
      clearTimer(handles.get(key));
      handles.delete(key);
      entries.delete(key);
      emit();
      return true;
    },
    get: (key) => entries.get(key),
    remainingSec(key) {
      const e = entries.get(key);
      if (!e || e.status !== "pending") return 0;
      return Math.max(0, Math.ceil((e.deadline - now()) / 1000));
    },
    dismiss(key) {
      if (entries.get(key)?.status === "failed") {
        entries.delete(key);
        emit();
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    version: () => ver,
  };
}

/** 画面全体で1つ */
export const undoStore = createUndoStore();

/** 行ごとの猶予の状態（残り秒は 250ms ごとに更新） */
export function useUndo(key: string): { entry: UndoEntry | undefined; remaining: number } {
  useSyncExternalStore(undoStore.subscribe, undoStore.version);
  const entry = undoStore.get(key);
  const [, tick] = useState(0);
  const pending = entry?.status === "pending";
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [pending]);
  return { entry, remaining: undoStore.remainingSec(key) };
}
