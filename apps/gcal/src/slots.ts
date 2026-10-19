// 空き時間の計算（16 §3.1 find_free_time）。純粋な関数だけ（HTTP・Google に触れない）。
// 時刻は epoch のミリ秒。時間帯の差は Intl（IANA の名前）から求める。日をまたぐ幅でも、日ごとに「その日の時間帯」の境界を作り直す。

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** 1回の応答の上限（§3.1） */
export const MAX_SLOTS = 20;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
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
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** IANA の時間帯が使えるか（不正な名前は Intl が投げる） */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterOf(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** その瞬間の時間帯の UTC からのずれ（ミリ秒。東が正） */
export function offsetMsAt(timeZone: string, epochMs: number): number {
  const parts = formatterOf(timeZone).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  // 表示は秒まで。ミリ秒の端数は外して比べる
  return wallAsUtc - (epochMs - (((epochMs % 1000) + 1000) % 1000));
}

/** 時間帯の壁時計を epoch に直す。重複時刻は早い方、欠落時刻は最初の有効時刻へ進める */
export function wallToEpoch(timeZone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = new Set<number>();
  for (const probe of [wall - 36 * 60 * MINUTE_MS, wall, wall + 36 * 60 * MINUTE_MS]) {
    const offset = offsetMsAt(timeZone, probe);
    candidates.add(wall - offset);
  }
  const same = [...candidates].filter((epoch) => {
    const local = new Date(epoch + offsetMsAt(timeZone, epoch));
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes()) === wall;
  }).sort((a, b) => a - b);
  if (same.length) return same[0]!;
  // 欠落区間では境界を前へ進め、要求時刻以降で最初に有効な壁時計分を選ぶ。
  for (let epoch = Math.min(...candidates) - 3 * 60 * MINUTE_MS; epoch <= Math.max(...candidates) + 3 * 60 * MINUTE_MS; epoch += MINUTE_MS) {
    const local = new Date(epoch + offsetMsAt(timeZone, epoch));
    const localWall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), local.getUTCHours(), local.getUTCMinutes());
    if (localWall >= wall) return epoch;
  }
  throw new RangeError("壁時計の時刻を時間帯に変換できない");
}

/** epoch を RFC3339（時間帯のオフセットつき。例 2026-10-14T09:00:00+09:00） */
export function toRfc3339(epochMs: number, timeZone: string): string {
  const offset = offsetMsAt(timeZone, epochMs);
  const wall = new Date(epochMs + offset);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset) / MINUTE_MS;
  return (
    `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** "HH:MM" を分に（検証は zod 側で済んでいる前提） */
export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 区間を並べて重なりをまとめる（半開区間 [start, end)） */
export function mergeIntervals(intervals: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = intervals.map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export interface FreeSlotsInput {
  /** 範囲（epoch ミリ秒。end > start） */
  timeMin: number;
  timeMax: number;
  /** 忙しい区間（RFC3339 を epoch にしたもの。範囲の外・重なりは問わない） */
  busy: ReadonlyArray<readonly [number, number]>;
  durationMinutes: number;
  /** "HH:MM"（その時間帯の壁時計） */
  dayStart: string;
  dayEnd: string;
  timeZone: string;
}

export interface FreeSlotsResult {
  /** 空き時間の候補（RFC3339）。各空き区間の頭から duration ずつ、先頭から最大 MAX_SLOTS */
  slots: Array<{ start: string; end: string }>;
  /** 範囲の中の忙しい区間の数（予定の中身は含まない） */
  busyCount: number;
}

/**
 * 日ごとの時間帯（dayStart〜dayEnd）を範囲で切り、忙しい区間を引いた空きに duration の枠を並べる。
 * 日は時間帯の壁時計で数える（UTC の日付で切らない）ので、東京と UTC の違いも日またぎも正しく扱う。
 */
export function freeSlots(input: FreeSlotsInput): FreeSlotsResult {
  const { timeMin, timeMax, timeZone } = input;
  const durationMs = input.durationMinutes * MINUTE_MS;
  const busy = mergeIntervals(input.busy.map(([s, e]) => [Math.max(s, timeMin), Math.min(e, timeMax)] as const).filter(([s, e]) => e > s));
  const busyCount = busy.length;

  // 範囲の両端の壁時計の日付（1日の余裕を足して、境目の日を落とさない）
  const localDay = (epochMs: number) => {
    const wall = new Date(epochMs + offsetMsAt(timeZone, epochMs));
    return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  };
  const [sh, sm] = [Math.floor(minutesOf(input.dayStart) / 60), minutesOf(input.dayStart) % 60];
  const [eh, em] = [Math.floor(minutesOf(input.dayEnd) / 60), minutesOf(input.dayEnd) % 60];

  const slots: Array<{ start: string; end: string }> = [];
  const last = localDay(timeMax - 1);
  for (let day = localDay(timeMin) - DAY_MS; day <= last + DAY_MS && slots.length < MAX_SLOTS; day += DAY_MS) {
    const d = new Date(day);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const dd = d.getUTCDate();
    const windowStart = Math.max(wallToEpoch(timeZone, y, mo, dd, sh, sm), timeMin);
    const windowEnd = Math.min(wallToEpoch(timeZone, y, mo, dd, eh, em), timeMax);
    if (windowEnd <= windowStart) continue;

    // 空き区間 = 窓から忙しい区間を引いたもの
    let cursor = windowStart;
    const gaps: Array<[number, number]> = [];
    for (const [bs, be] of busy) {
      if (be <= cursor) continue;
      if (bs >= windowEnd) break;
      if (bs > cursor) gaps.push([cursor, bs]);
      cursor = Math.max(cursor, be);
    }
    if (cursor < windowEnd) gaps.push([cursor, windowEnd]);

    for (const [gs, ge] of gaps) {
      for (let t = gs; t + durationMs <= ge && slots.length < MAX_SLOTS; t += durationMs) {
        slots.push({ start: toRfc3339(t, timeZone), end: toRfc3339(t + durationMs, timeZone) });
      }
    }
  }
  return { slots, busyCount };
}
