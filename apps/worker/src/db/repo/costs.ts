// 費用の道具（packages/db/src/system/costs.ts の WorkspaceDO 版）。金額は整数のマイクロドルで比べる（浮動小数で足さない：T-117）。
// 「1日」の区切りは SQL の AT TIME ZONE をやめて JS（Intl）で計算する（夏時間でもずれない：DB §4.10）。
// 全ワークスペースの今日の費用（getPlatformDayCostUsd。BR-62 の全体1日 $10）は DO の中では出せないので移さない。
// 第5段で D1 などに置く（各 DO が費用を書いたときに全体の合計へ足す）

import type { MicroUsd } from "../types.ts";

/** 小数6桁までの USD の10進の文字列（'0.950000' など。Postgres の numeric を text にしたもの） */
export type UsdDecimal = string;

/** 「1日」の区切り（SO I-08。全体の $10 も Asia/Tokyo の0時） */
export const BUDGET_TIME_ZONE = "Asia/Tokyo";

const USD_RE = /^(-?)(\d+)(?:\.(\d{1,6}))?$/;

/** '0.950000' → 950000（文字列のまま10進で読む。小数7桁以上・指数表記は例外） */
export function usdToMicro(usd: UsdDecimal): MicroUsd {
  const m = USD_RE.exec(usd.trim());
  if (!m) throw new RangeError(`USD の形ではない：${usd}`);
  const micro = Number(m[2]) * 1_000_000 + Number((m[3] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micro)) throw new RangeError(`USD が大きすぎる：${usd}`);
  return m[1] === "-" && micro !== 0 ? -micro : micro;
}

/** 950000 → '0.950000' */
export function microToUsd(micro: MicroUsd): UsdDecimal {
  if (!Number.isSafeInteger(micro)) throw new RangeError(`マイクロドルが整数ではない：${micro}`);
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0");
  return `${micro < 0 ? "-" : ""}${whole}.${frac}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // 知らないタイムゾーンはここで RangeError
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** instant の timeZone での暦の日付と時刻（秒まで） */
function wallClock(instantMs: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour!, mi: parts.minute!, s: parts.second! };
}

/** instant での timeZone の UTC からのずれ（ミリ秒。東が正） */
function offsetMs(instantMs: number, timeZone: string): number {
  const at = Math.floor(instantMs / 1000) * 1000;
  const w = wallClock(at, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - at;
}

/** timeZone の y-m-d 0時の瞬間（0時が夏時間で飛ぶ日は、飛んだ先の最初の瞬間） */
function zonedMidnight(y: number, m: number, d: number, timeZone: string): number {
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetMs(wall, timeZone);
  const second = wall - offsetMs(first, timeZone);
  if (first === second) return first;
  // ずれが変わる日：その日の0時に当たる方、なければ遅い方（0時が飛んだ日）
  for (const c of [Math.min(first, second), Math.max(first, second)]) {
    const w = wallClock(c, timeZone);
    if (w.y === y && w.m === m && w.d === d && w.h === 0 && w.mi === 0 && w.s === 0) return c;
  }
  return Math.max(first, second);
}

/** now を含む timeZone の1日 [start, end)（夏時間でもずれない：DB §4.10） */
export function dayRange(now: Date, timeZone: string = BUDGET_TIME_ZONE): { start: Date; end: Date } {
  if (Number.isNaN(now.getTime())) throw new TypeError("now が正しい Date でない");
  const w = wallClock(now.getTime(), timeZone);
  const next = new Date(Date.UTC(w.y, w.m - 1, w.d + 1));
  return {
    start: new Date(zonedMidnight(w.y, w.m, w.d, timeZone)),
    end: new Date(zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timeZone)),
  };
}
