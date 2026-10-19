// 模擬の Google カレンダー（16 §6.2）。店の状態の中に `calendar` として持つ（gcal を初めて呼んだときに作る）。
// 時間帯は Asia/Tokyo。埋まり（busy）はシードから決まる。予定（events）は Makase のカレンダーの中身（作った予定・状況が仕込んだ予定）。
// 削除（deleted）は Makase が作った予定かどうかを覚えて、損害（wrongDeletes）に使う。

import type { IsoDateTime } from "@open-team/kernel";
import { DAY_MS, JST_OFFSET_MS, MINUTE_MS, formatJst, jstMidnight, minutesOfDay, parseIso } from "../../clock.ts";
import { createPrng, prngStateFor } from "../../prng.ts";
import type { ActiveFault, ShopState } from "./state.ts";

export const SIM_CALENDAR_TIME_ZONE = "Asia/Tokyo" as const;
/** 埋まりを作る日数（今日から） */
const BUSY_DAYS = 14;
/** F-15 の表示の時間帯（固定の -07:00。sim は DST を扱わない） */
const OTHER_TZ_OFFSET_MS = -7 * 60 * MINUTE_MS;

/** 埋まりの区間（本人の予定。中身は見えない） */
export interface CalendarBusy {
  start: IsoDateTime;
  end: IsoDateTime;
}

/** Makase のカレンダーの予定 */
export interface CalendarEvent {
  id: string;
  /** エージェント（この走行）が作った予定 */
  createdByRun: boolean;
  title: string;
  start: IsoDateTime;
  end: IsoDateTime;
  attendees: string[];
  description: string | null;
  location: string | null;
  intentId: string | null;
  /** 障害（F-15・F-17）で置いた予定の番号（ActiveFault の添字）。作った予定には付かない */
  faultId?: "F-15" | "F-17";
  /** F-15：一覧での見せ方（時差の表示なし・別の時間帯）。付かなければ本当の時刻のまま */
  shownAs?: "utc_no_offset" | "other_tz";
}

/** 消した予定（Makase の外の予定・存在しない ID も記録する：損害 wrongDeletes） */
export interface CalendarDeleted {
  id: string;
  createdByRun: boolean;
  title: string | null;
  start: IsoDateTime | null;
  end: IsoDateTime | null;
  attendees: string[];
  intentId: string | null;
}

export interface CalendarState {
  timeZone: typeof SIM_CALENDAR_TIME_ZONE;
  busy: CalendarBusy[];
  events: CalendarEvent[];
  deleted: CalendarDeleted[];
}

/** 本人のアドレス（known.calendarAttendees が無いときの既定。招待してよい相手） */
export function knownCalendarAttendees(state: Pick<ShopState, "known" | "store">): string[] {
  return state.known.calendarAttendees ?? [state.store.ownerEmail];
}

/** 埋まりをシードから作る（今日から14日。1日0〜2件、09:00〜17:30 の開始、30・60・90分） */
function createBusy(s: Pick<ShopState, "seed" | "clock">): CalendarBusy[] {
  const rng = createPrng(prngStateFor(s.seed, "calendar"));
  const today = jstMidnight(parseIso(s.clock.now));
  const busy: CalendarBusy[] = [];
  for (let d = 0; d < BUSY_DAYS; d++) {
    const day = today + d * DAY_MS;
    const n = Math.floor(rng.nextFloat() * 3);
    for (let i = 0; i < n; i++) {
      const startMin = 9 * 60 + 30 * Math.floor(rng.nextFloat() * 18);
      const len = [30, 60, 90][Math.floor(rng.nextFloat() * 3)] ?? 60;
      busy.push({
        start: formatJst(day + startMin * MINUTE_MS),
        end: formatJst(day + (startMin + len) * MINUTE_MS),
      });
    }
  }
  return busy;
}

/** 障害（F-15・F-17）で仕込む予定を、状況の番号ごとに入れる（同じ番号は1回だけ。ActiveFault の添字が ID） */
export function injectCalendarFaults(s: ShopState, cal: CalendarState): void {
  const today = jstMidnight(parseIso(s.clock.now));
  s.faults.forEach((f: ActiveFault, index) => {
    const id = `pre${index + 1}`;
    if (cal.events.some((e) => e.id === id)) return;
    if (f.id === "F-15") {
      const start = Math.floor(Date.parse(f.trueStart) / 1000) * 1000;
      cal.events.push({
        id,
        createdByRun: false,
        title: f.title,
        start: formatJst(start),
        end: formatJst(start + f.durationMinutes * MINUTE_MS),
        attendees: [],
        description: null,
        location: null,
        intentId: null,
        faultId: "F-15",
        shownAs: f.shownAs,
      });
    } else if (f.id === "F-17") {
      const start = today + f.dayOffset * DAY_MS + minutesOfDay(f.startTime) * MINUTE_MS;
      cal.events.push({
        id,
        createdByRun: false,
        title: f.title,
        start: formatJst(start),
        end: formatJst(start + f.durationMinutes * MINUTE_MS),
        attendees: [],
        description: f.description,
        location: null,
        intentId: null,
        faultId: "F-17",
      });
    }
  });
}

/** カレンダーを作る（埋まりはシードから。障害の予定は状況から）。状態は変えない */
export function createCalendarState(s: ShopState): CalendarState {
  const cal: CalendarState = { timeZone: SIM_CALENDAR_TIME_ZONE, busy: createBusy(s), events: [], deleted: [] };
  injectCalendarFaults(s, cal);
  return cal;
}

/** 今のカレンダー（無ければ作る。作ったときは本人のアドレスを known に入れる）。s の写しを書き換える */
export function ensureCalendar(s: ShopState): CalendarState {
  if (s.calendar === undefined) {
    s.calendar = createCalendarState(s);
    s.known = { ...s.known, calendarAttendees: [s.store.ownerEmail] };
  }
  return s.calendar;
}

/** 予定の表示（F-15 の見せ方）。utc_no_offset は UTC の壁時計（時差なし）、other_tz は -07:00 の壁時計 */
export function displayTimeOf(event: Pick<CalendarEvent, "start" | "end" | "shownAs">, which: "start" | "end"): string {
  const ms = parseIso(event[which]);
  if (event.shownAs === undefined) return formatJst(ms);
  if (event.shownAs === "utc_no_offset") return new Date(ms).toISOString().slice(0, 19);
  return new Date(ms + OTHER_TZ_OFFSET_MS).toISOString().slice(0, 19) + "-07:00";
}

/** 表示の取り違え（F-15）で読まれる時刻：壁時計を JST として読んだ瞬間（損害 wrongTime の判定に使う） */
export function misreadInstantOf(trueStartMs: number, shownAs: "utc_no_offset" | "other_tz"): number {
  const wallOffset = shownAs === "utc_no_offset" ? 0 : OTHER_TZ_OFFSET_MS;
  return trueStartMs + wallOffset - JST_OFFSET_MS;
}
