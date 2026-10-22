// 本当の時刻（実時間）の注入と、費用の「1日」の区切り（Asia/Tokyo の0時。M-59、SO §9 I-08）
// JST は夏時間がないので、1日 = 24時間・時差は固定の +09:00 で計算する（Intl に頼らない。試験で Intl と突き合わせる）

import { DAY_BOUNDARY_TIMEZONE } from "@open-team/kernel";

/** 本当の時刻を返すもの。サービスはこれを受け取り、試験は manualClock に差し替える */
export interface Clock {
  now(): Date;
}

/** 実時間（new Date()）。分割代入しても動くように矢印関数にする */
export const systemClock: Clock = { now: () => new Date() };

/** 試験用の時計（set で合わせ、advance で進める） */
export interface ManualClock extends Clock {
  set(at: Date | string | number): void;
  advance(ms: number): void;
}

function toMs(at: Date | string | number): number {
  const ms = at instanceof Date ? at.getTime() : typeof at === "string" ? Date.parse(at) : at;
  if (!Number.isFinite(ms)) throw new RangeError(`時刻として読めない：${String(at)}`);
  return ms;
}

export function manualClock(at: Date | string | number): ManualClock {
  let current = toMs(at);
  return {
    // 呼び出し側が Date を書き換えても時計が動かないよう、毎回新しい Date を返す
    now: () => new Date(current),
    set: (next) => {
      current = toMs(next);
    },
    advance: (ms) => {
      if (!Number.isFinite(ms)) throw new RangeError(`進める量が数でない：${ms}`);
      current += ms;
    },
  };
}

/** 費用の日の区切りのタイムゾーン（kernel の DAY_BOUNDARY_TIMEZONE と同じ値。M-59） */
export const BUDGET_TIME_ZONE = DAY_BOUNDARY_TIMEZONE;
export const TOKYO_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

function msOf(at: Date): number {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("不正な Date（Invalid Date）");
  return ms;
}

function startMs(ms: number): number {
  return Math.floor((ms + TOKYO_OFFSET_MS) / DAY_MS) * DAY_MS - TOKYO_OFFSET_MS;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** その時刻を含む Asia/Tokyo の日の始まり（0:00 JST。この時刻を含む） */
export function tokyoDayStart(at: Date): Date {
  return new Date(startMs(msOf(at)));
}

/** その時刻を含む Asia/Tokyo の日の終わり（翌日の 0:00 JST。この時刻を含まない：created_at < end で絞る） */
export function tokyoDayEnd(at: Date): Date {
  return new Date(startMs(msOf(at)) + DAY_MS);
}

/** 費用の日（'YYYY-MM-DD'、Asia/Tokyo。SO §3.12 の budgetDay） */
export function budgetDay(at: Date): string {
  const d = new Date(msOf(at) + TOKYO_OFFSET_MS);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 当日の区間 [start, end)。DB の「当日の usage_records」（G-01 の dayCostUsd）はこの区間で数える */
export interface TokyoDay {
  day: string;
  start: Date;
  end: Date;
}

export function tokyoDay(at: Date): TokyoDay {
  const s = startMs(msOf(at));
  return { day: budgetDay(at), start: new Date(s), end: new Date(s + DAY_MS) };
}

/**
 * 次の日の 0:00 JST までの秒数（切り上げ。最小 1）。
 * 429 DAILY_BUDGET_EXCEEDED の Retry-After に使う（SO §3.12 の 3、I-10）
 */
export function secondsUntilTokyoDayEnd(at: Date): number {
  const ms = msOf(at);
  return Math.max(1, Math.ceil((startMs(ms) + DAY_MS - ms) / 1000));
}
