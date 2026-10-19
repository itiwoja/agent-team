// 仮想の時計（Asia/Tokyo。15:273「売上 → 夕方に発注 → 翌朝に入荷」を数秒で進める）
// 時刻は引数で受け取るだけで、今の時刻（Date.now・引数なしの new Date）は使わない。JST は夏時間がないので1日 = 24時間

import type { IsoDateTime } from "@open-team/kernel";

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;

/** 仮想の時計（SW §3.5）。now は ISO 8601（+09:00）、day は1日目から */
export interface VirtualClock {
  now: IsoDateTime;
  tz: "Asia/Tokyo";
  day: number;
}

/** どこまで時計を進めるか（SW §3.3 の endAt。2日目 23:59 で終わり：§3.5 の表） */
export const END_AT_POINTS = { day2_end: { day: 2, time: "23:59" } } as const;
export type EndAt = keyof typeof END_AT_POINTS;

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** タイムゾーンつきの ISO 8601 をミリ秒にする（秒未満は切り捨て）。形が違えば例外 */
export function parseIso(text: string): number {
  if (!ISO_WITH_ZONE.test(text)) throw new RangeError(`タイムゾーンつきの ISO 8601 ではない：${text}`);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new RangeError(`時刻として読めない：${text}`);
  return Math.floor(ms / 1000) * 1000;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

/** ミリ秒を 'YYYY-MM-DDTHH:mm:ss+09:00' にする */
export function formatJst(ms: number): IsoDateTime {
  const d = new Date(ms + JST_OFFSET_MS);
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`
  );
}

/** JST の日付（'YYYY-MM-DD'） */
export function jstDateOf(ms: number): string {
  return formatJst(ms).slice(0, 10);
}

/** その時刻を含む JST の日の 0:00 */
export function jstMidnight(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

/** 'HH:MM' を分にする */
export function minutesOfDay(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new RangeError(`'HH:MM' ではない：${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** JST の日付と 'HH:MM' からミリ秒（存在しない日付は例外） */
export function jstAt(ymd: string, hhmm: string): number {
  const m = YMD.exec(ymd);
  if (!m) throw new RangeError(`'YYYY-MM-DD' ではない：${ymd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utcMidnight = Date.UTC(y, mo - 1, d);
  if (jstDateOf(utcMidnight - JST_OFFSET_MS) !== ymd) throw new RangeError(`存在しない日付：${ymd}`);
  return utcMidnight - JST_OFFSET_MS + minutesOfDay(hhmm) * MINUTE_MS;
}

/** 時計の n 日目の 'HH:MM'（day は1から） */
export function virtualTimeMs(clock: VirtualClock, day: number, hhmm: string): number {
  if (!Number.isInteger(day)) throw new RangeError(`day は整数にする：${day}`);
  const day1Midnight = jstMidnight(parseIso(clock.now)) - (clock.day - 1) * DAY_MS;
  return day1Midnight + (day - 1) * DAY_MS + minutesOfDay(hhmm) * MINUTE_MS;
}

export function virtualTime(clock: VirtualClock, day: number, hhmm: string): IsoDateTime {
  return formatJst(virtualTimeMs(clock, day, hhmm));
}

/** endAt の時刻（例 day2_end → 2日目 23:59） */
export function endAtTime(clock: VirtualClock, endAt: EndAt): IsoDateTime {
  const p = END_AT_POINTS[endAt];
  return virtualTime(clock, p.day, p.time);
}

/** 時計の今から見た、その時刻の日の番号 */
export function dayIndexAt(clock: VirtualClock, ms: number): number {
  return clock.day + Math.round((jstMidnight(ms) - jstMidnight(parseIso(clock.now))) / DAY_MS);
}

export function addMinutesIso(iso: IsoDateTime, minutes: number): IsoDateTime {
  return formatJst(parseIso(iso) + minutes * MINUTE_MS);
}
