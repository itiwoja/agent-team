// history API の小さなルーター（ライブラリは足さない）。
// `/`=SCR-020、`/check`=SCR-019（?item=）、`/done`、`/asks`＝依頼の一覧（?q=・?status=）、`/asks/:askId`=SCR-021、`/agents`=SCR-014、`/packs`＝パック（D-116。?q=・?cat=）、`/packs/:packId`＝パックの詳しい中身、`/audit`=SCR-010（?seq=）
import { createElement, useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { parseSeq } from "./audit";
import { createScrollMemory, keyOfState, newHistoryKey } from "./scrollMemory";

export type Route =
  | { name: "home" }
  | { name: "check"; item: string | null }
  | { name: "done" }
  | { name: "audit"; seq: number | null }
  | { name: "ask"; askId: string }
  | { name: "agents" }
  | { name: "asks"; q: string; status: string | null }
  | { name: "packs"; q: string; category: string | null }
  | { name: "pack"; packId: string }
  | { name: "notFound" };

/** パスとクエリから画面を決める（末尾の / は無視） */
export function parseLocation(pathname: string, search = ""): Route {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/" || path === "") return { name: "home" };
  if (path === "/check") return { name: "check", item: new URLSearchParams(search).get("item") };
  if (path === "/done") return { name: "done" };
  if (path === "/agents") return { name: "agents" };
  if (path === "/asks") {
    const qs = new URLSearchParams(search);
    return { name: "asks", q: qs.get("q") ?? "", status: qs.get("status") };
  }
  if (path === "/packs") {
    const qs = new URLSearchParams(search);
    return { name: "packs", q: qs.get("q") ?? "", category: qs.get("cat") };
  }
  if (path === "/audit") return { name: "audit", seq: parseSeq(new URLSearchParams(search).get("seq")) };
  const pk = /^\/packs\/([^/]+)$/.exec(path);
  if (pk?.[1]) {
    try {
      return { name: "pack", packId: decodeURIComponent(pk[1]) };
    } catch {
      return { name: "notFound" };
    }
  }
  const m = /^\/asks\/([^/]+)$/.exec(path);
  if (m?.[1]) {
    try {
      return { name: "ask", askId: decodeURIComponent(m[1]) };
    } catch {
      return { name: "notFound" };
    }
  }
  return { name: "notFound" };
}

const NAVIGATE_EVENT = "ot:navigate";

// 戻る・進むで同じ所に戻る（lib/scrollMemory.ts）。履歴の項目ごとに鍵を history.state に持ち、離れるときの位置を鍵で覚える。
// ブラウザの自動の復元は、画面を作り直して中身を読み込む間に合わないので止める
const scrollMemory = createScrollMemory();
let currentKey: string | null = null;
let pendingScroll: number | null = null;

/** いまの履歴の項目の鍵（無ければ付ける） */
function ensureKey(): string {
  const k = keyOfState(history.state);
  if (k) return k;
  const fresh = newHistoryKey();
  history.replaceState({ key: fresh }, "", location.href);
  return fresh;
}

/** 起動時に1度呼ぶ：自動の復元を止め、戻る・進むで覚えた位置を取り出せるようにする */
export function installHistory(): void {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  currentKey = ensureKey();
  window.addEventListener("popstate", () => {
    // 離れる項目の位置を覚え（画面はまだ前のまま）、戻る先の位置を取り出す
    if (currentKey) scrollMemory.remember(currentKey, window.scrollY);
    currentKey = ensureKey();
    pendingScroll = scrollMemory.take(currentKey);
  });
}

/** 戻る・進むで戻る先の位置（画面が切り替わった後に1度だけ取り出す） */
export function takePendingScroll(): number | null {
  const y = pendingScroll;
  pendingScroll = null;
  return y;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) {
    history.replaceState({ key: ensureKey() }, "", to);
  } else {
    if (currentKey) scrollMemory.remember(currentKey, window.scrollY);
    currentKey = newHistoryKey();
    history.pushState({ key: currentKey }, "", to);
  }
  pendingScroll = null;
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo(0, 0);
}

/** URL だけ書き換える（画面は動かさない。絞り込みを URL に残す・読んだクエリを消すとき）。履歴の鍵は保つ */
export function replaceUrl(to: string): void {
  history.replaceState({ key: ensureKey() }, "", to);
}

function subscribe(fn: () => void): () => void {
  window.addEventListener("popstate", fn);
  window.addEventListener(NAVIGATE_EVENT, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(NAVIGATE_EVENT, fn);
  };
}

const snapshot = (): string => location.pathname + location.search;

/** URL の hash（通常の hashchange と navigate() による変更の両方） */
export function useLocationHash(): string {
  return useSyncExternalStore((fn) => {
    window.addEventListener("hashchange", fn);
    window.addEventListener(NAVIGATE_EVENT, fn);
    return () => {
      window.removeEventListener("hashchange", fn);
      window.removeEventListener(NAVIGATE_EVENT, fn);
    };
  }, () => location.hash, () => "");
}

export function useRoute(): Route {
  const loc = useSyncExternalStore(subscribe, snapshot, () => "/");
  return useMemo(() => {
    const q = loc.indexOf("?");
    return q < 0 ? parseLocation(loc) : parseLocation(loc.slice(0, q), loc.slice(q));
  }, [loc]);
}

/** 通常のクリックだけ横取りする（新しいタブ・修飾キーはブラウザに任せる） */
export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return createElement("a", {
    ...rest,
    href: to,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    },
  });
}
