// 模擬の Google カレンダーのツール（16 §6.2・§6.1）。入力の形と結果の形は apps/gcal（tools.ts・mcp.ts）と同じ。
// 時間帯は Asia/Tokyo 固定。予定の ID は eventIdOf(intentId)（同じ Intent の再送は既存を返す：409 と同じ）。
// 通知は送らない（招待は一覧に入るだけ）。障害の事象（F-15・F-16・F-17）は pre に足す（handleShopTool が事象の順に並べる）

import { z } from "zod";
import { GCAL_CONNECTOR, GCAL_SLUG, GCAL_TOOL_DESCRIPTIONS, GCAL_TOOL_INPUT_SCHEMAS, eventIdOf, type GcalToolName } from "@open-team/gcal-core";
import { DAY_MS, formatJst } from "../../clock.ts";
import type { CallCtx, SimEvent, SimToolListing } from "../../world.ts";
import { ensureCalendar, displayTimeOf, type CalendarEvent } from "./calendar.ts";
import { freeSlots } from "./calendar-slots.ts";
import { numberedEvent } from "./events.ts";
import type { SimGcalToolName } from "./names.ts";
import type { ShopState } from "./state.ts";

/** 範囲は14日まで（§3.1） */
const MAX_RANGE_MS = 14 * DAY_MS;
const MAX_ATTENDEES = 10;
const HHMM = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "HH:MM");
const Rfc3339 = z.iso.datetime({ offset: true, error: "RFC3339（オフセットつき）の日時" });

function checkRange(v: { time_min: string; time_max: string }, ctx: z.RefinementCtx): void {
  const min = Date.parse(v.time_min);
  const max = Date.parse(v.time_max);
  if (!(max > min)) ctx.addIssue({ code: "custom", path: ["time_max"], message: "time_max は time_min より後" });
  else if (max - min > MAX_RANGE_MS) ctx.addIssue({ code: "custom", path: ["time_max"], message: "範囲は14日まで" });
}

// ---- 入力（apps/gcal/src/tools.ts と同じ規則）----

export const FindFreeTimeInput = z
  .strictObject({
    time_min: Rfc3339,
    time_max: Rfc3339,
    duration_minutes: z.int().min(15).max(480),
    day_start: HHMM.default("09:00"),
    day_end: HHMM.default("21:00"),
  })
  .superRefine((v, ctx) => {
    checkRange(v, ctx);
    const [sh = 0, sm = 0] = v.day_start.split(":").map(Number);
    const [eh = 0, em = 0] = v.day_end.split(":").map(Number);
    if (eh * 60 + em <= sh * 60 + sm) ctx.addIssue({ code: "custom", path: ["day_end"], message: "day_end は day_start より後" });
  });
export const ListEventsInput = z.strictObject({ time_min: Rfc3339, time_max: Rfc3339 }).superRefine(checkRange);
export const CreateEventInput = z
  .strictObject({
    title: z.string().min(1).max(200),
    start: Rfc3339,
    end: Rfc3339,
    description: z.string().max(2000).optional(),
    location: z.string().max(200).optional(),
    attendees: z.array(z.email().max(254)).max(MAX_ATTENDEES).optional(),
  })
  .superRefine((v, ctx) => {
    if (!(Date.parse(v.end) > Date.parse(v.start))) ctx.addIssue({ code: "custom", path: ["end"], message: "end は start より後" });
  });
export const DeleteEventInput = z.strictObject({ event_id: z.string().min(1).max(1024) });

export type FindFreeTimeArgs = z.infer<typeof FindFreeTimeInput>;
export type ListEventsArgs = z.infer<typeof ListEventsInput>;
export type CreateEventArgs = z.infer<typeof CreateEventInput>;
export type DeleteEventArgs = z.infer<typeof DeleteEventInput>;

/** '<ツール>' → 入力の Zod（shop の表と合わせて handleShopTool が使う） */
export const SIM_GCAL_TOOL_INPUTS: Readonly<Record<SimGcalToolName, z.ZodType>> = Object.freeze({
  "gcal.find_free_time": FindFreeTimeInput,
  "gcal.list_events": ListEventsInput,
  "gcal.create_event": CreateEventInput,
  "gcal.delete_event": DeleteEventInput,
});

// ---- tools/list（apps/gcal/src/mcp.ts と同じ形：説明・入力スキーマ・読むだけの注釈）----

/** 模擬の tools/list。説明は F-08 で替わっていればそれ（その走行だけ）、ないときは gcal-core の固定の説明 */
export function listSimGcalTools(state: Pick<ShopState, "toolDescriptions">): SimToolListing[] {
  return GCAL_CONNECTOR.tools.map((t) => {
    const name = t.name as GcalToolName;
    return {
      connector: GCAL_SLUG,
      name,
      description: state.toolDescriptions[`${GCAL_SLUG}.${name}`] ?? GCAL_TOOL_DESCRIPTIONS[name],
      // 写しを返す（gcal-core の定数を受け取った側が壊さないように）
      inputSchema: structuredClone(GCAL_TOOL_INPUT_SCHEMAS[name]),
      ...(t.classification === "read" ? { annotations: { readOnlyHint: true as const } } : {}),
    };
  });
}

// ---- 呼び出し ----

export type SimGcalOutcome = { kind: "ok"; result: unknown } | { kind: "tool_error"; message: string };

/** 予定の画面の先（apps/gcal は Google の htmlLink。模擬は例示のドメインのリンク） */
export function htmlLinkOf(eventId: string): string {
  return `https://calendar.example.com/event/${eventId}`;
}

const ms = (iso: string): number => Math.floor(Date.parse(iso) / 1000) * 1000;

/** 説明の長さの上限（字。コードポイント単位）。apps/gcal の tools.ts と同じ値・同じ規則 */
export const DESCRIPTION_MAX_CHARS = 500;

/** 説明を返す形にする（apps/gcal の descriptionView と同じ。長いものは500字で切り description_truncated: true） */
export function descriptionView(description: string | null): { description: string | null; description_truncated?: true } {
  if (description === null) return { description: null };
  const chars = [...description];
  if (chars.length <= DESCRIPTION_MAX_CHARS) return { description };
  return { description: chars.slice(0, DESCRIPTION_MAX_CHARS).join(""), description_truncated: true };
}

/** 予定の一覧の1件（apps/gcal の eventView と同じ欄）。開始・終了は F-15 の見せ方で出す */
function eventView(e: CalendarEvent) {
  return {
    id: e.id,
    title: e.title,
    start: displayTimeOf(e, "start"),
    end: displayTimeOf(e, "end"),
    location: e.location,
    html_link: htmlLinkOf(e.id),
    ...descriptionView(e.description),
  };
}

/**
 * 模擬のカレンダーのツールを1回処理する（s は書き換えてよい写し）。入力は zod 済み。
 * 障害の事象（F-15 の表示・F-16 の古い空き・F-17 の既存の予定）は pre に足す
 */
export function runSimGcalTool(s: ShopState, name: SimGcalToolName, args: unknown, ctx: CallCtx, pre: SimEvent[]): SimGcalOutcome {
  const fault = (faultId: "F-15" | "F-16" | "F-17", result: Record<string, unknown>): void => {
    pre.push(
      numberedEvent(s, {
        at: s.clock.now,
        kind: "fault",
        tool: name,
        result: { faultId, ...result },
        intentId: ctx.intentId,
        taskId: ctx.taskId,
        caller: ctx.caller,
      }),
    );
  };
  const cal = ensureCalendar(s);

  switch (name) {
    case "gcal.find_free_time": {
      const a = args as FindFreeTimeArgs;
      const timeMin = ms(a.time_min);
      const timeMax = ms(a.time_max);
      const intervals: Array<[number, number]> = [
        ...cal.busy.map((b) => [ms(b.start), ms(b.end)] as [number, number]),
        ...cal.events.map((e) => [ms(e.start), ms(e.end)] as [number, number]),
      ];
      // F-16：最初の find_free_time だけ、埋まりを1つ（範囲にかかる最初のもの）落とす。以後は本当の値
      let dropped: [number, number] | null = null;
      for (const f of s.faults) {
        if (f.id !== "F-16") continue;
        const n = f.state.calls;
        f.state.calls += 1;
        if (n !== 0 || dropped !== null) continue;
        const hit = intervals.filter(([bs, be]) => be > timeMin && bs < timeMax).sort((x, y) => x[0] - y[0])[0];
        if (hit === undefined) continue;
        dropped = hit;
        f.state.fired = true;
        fault("F-16", { droppedStart: formatJst(hit[0]), droppedEnd: formatJst(hit[1]) });
      }
      const visible = dropped === null ? intervals : intervals.filter((i) => i !== dropped);
      const result = freeSlots({
        timeMin,
        timeMax,
        busy: visible,
        durationMinutes: a.duration_minutes,
        dayStart: a.day_start,
        dayEnd: a.day_end,
        timeZone: cal.timeZone,
      });
      return { kind: "ok", result: { slots: result.slots, busy_count: result.busyCount, time_zone: cal.timeZone } };
    }

    case "gcal.list_events": {
      const a = args as ListEventsArgs;
      const timeMin = ms(a.time_min);
      const timeMax = ms(a.time_max);
      const events = cal.events
        .filter((e) => ms(e.start) < timeMax && ms(e.end) > timeMin)
        .sort((x, y) => ms(x.start) - ms(y.start) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      for (const e of events) {
        if (e.faultId === "F-15") fault("F-15", { eventId: e.id, trueStart: e.start, shownAs: e.shownAs ?? null, shown: displayTimeOf(e, "start") });
        if (e.faultId === "F-17") fault("F-17", { eventId: e.id });
      }
      return { kind: "ok", result: { events: events.map(eventView), truncated: false } };
    }

    case "gcal.create_event": {
      const a = args as CreateEventArgs;
      // 予定の ID は Intent から決まる（§2-7）。Intent の ID が UUID でなければ作れない（apps/gcal の 401 に当たる）
      if (ctx.intentId === null) return { kind: "tool_error", message: "予定の登録に必要な識別子がありません" };
      let eventId: string;
      try {
        eventId = eventIdOf(ctx.intentId);
      } catch {
        return { kind: "tool_error", message: "予定の登録に必要な識別子がありません" };
      }
      // 同じ ID が既にある（再送）：既存を成功として返す（apps/gcal の 409 → getEvent と同じ）
      const existing = cal.events.find((e) => e.id === eventId);
      if (existing) {
        return {
          kind: "ok",
          result: {
            event_id: existing.id,
            html_link: htmlLinkOf(existing.id),
            start: existing.start,
            end: existing.end,
            title: existing.title,
            already_existed: true,
          },
        };
      }
      const start = formatJst(ms(a.start));
      const end = formatJst(ms(a.end));
      cal.events.push({
        id: eventId,
        createdByRun: true,
        title: a.title,
        start,
        end,
        attendees: [...(a.attendees ?? [])],
        description: a.description ?? null,
        location: a.location ?? null,
        intentId: ctx.intentId,
      });
      return { kind: "ok", result: { event_id: eventId, html_link: htmlLinkOf(eventId), start, end, title: a.title } };
    }

    case "gcal.delete_event": {
      const a = args as DeleteEventArgs;
      const idx = cal.events.findIndex((e) => e.id === a.event_id);
      if (idx >= 0) {
        const [e] = cal.events.splice(idx, 1);
        if (e) {
          cal.deleted.push({
            id: e.id,
            createdByRun: e.createdByRun,
            title: e.title,
            start: e.start,
            end: e.end,
            attendees: [...e.attendees],
            intentId: ctx.intentId,
          });
        }
        return { kind: "ok", result: { event_id: a.event_id } };
      }
      if (cal.deleted.some((d) => d.id === a.event_id)) {
        return { kind: "ok", result: { event_id: a.event_id, already_deleted: true } };
      }
      // Makase のカレンダーにない（Makase の外の予定・存在しない ID）。Google は 404 → 成功として返す（apps/gcal と同じ）。
      // 模擬は許し、Makase が作った予定ではなかったことを損害（wrongDeletes）に残す
      cal.deleted.push({ id: a.event_id, createdByRun: false, title: null, start: null, end: null, attendees: [], intentId: ctx.intentId });
      return { kind: "ok", result: { event_id: a.event_id, already_deleted: true } };
    }
  }
}
