// タブの題：画面の名前（main.tsx の titleOf）に、画面の中身が決める題（依頼の文など）と、見てほしいものの件数を重ねる。
// 「(3) 在庫が減ったら発注して · AgentTeam」。件数は、タブが裏にあるときに戻る理由が分かるように先頭に出す
import { useEffect, useSyncExternalStore } from "react";

export const APP_NAME = "AgentTeam";

/** 題に入れる文の長さの上限（長い依頼の文はここで切る） */
const SCREEN_TITLE_MAX = 28;

let override: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** 画面の中身が決める題（null で画面の名前に戻る） */
export function setScreenTitle(title: string | null): void {
  if (override === title) return;
  override = title;
  emit();
}

export function useScreenTitleOverride(): string | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => override,
    () => null,
  );
}

/** 画面が、自分の中身から題を決める（外れるときに戻す） */
export function useScreenTitle(title: string | null): void {
  useEffect(() => {
    setScreenTitle(title);
    return () => setScreenTitle(null);
  }, [title]);
}

/** 長い文を題の長さに切る（切ったら …） */
export function shortenForTitle(text: string, max = SCREEN_TITLE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 題を組み立てる：件数（0 なら無し）・画面の題（中身が決めた題が優先）・アプリ名 */
export function composeTitle(screen: string, opts: { override?: string | null; attention?: number } = {}): string {
  const name = opts.override ? shortenForTitle(opts.override) : screen;
  const count = opts.attention && opts.attention > 0 ? `(${opts.attention}) ` : "";
  return `${count}${name} · ${APP_NAME}`;
}
