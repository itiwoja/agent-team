// 4つのツールの中身（16 §3.1）。入力は zod で確かめ（GCAL_TOOL_INPUT_SCHEMAS と同じ形）、Google へは calendar.ts のクライアントだけを使う。
// 読むのは予定の中身だけ（list_events。説明は500字まで：DESCRIPTION_MAX_CHARS）。find_free_time は埋まりの時間だけ（freebusy）。
// 結果の形：成功は structuredContent、入力の誤り・Google の4xx（409・404・410 以外）は isError の結果（ツールの結果として返す）。
// 401/403・429・5xx は投げる（mcp.ts が HTTP の状態コードにする）。

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eventIdOf } from "@open-team/gcal-core";
import { GoogleApiError, type CalendarClient, type EventInsertBody, type GcalEvent } from "./calendar.ts";
import { freeSlots, minutesOf } from "./slots.ts";

export const GCAL_TOOL_NAMES = ["find_free_time", "list_events", "create_event", "delete_event"] as const;
export type GcalToolName = (typeof GCAL_TOOL_NAMES)[number];

const DAY_MS = 86_400_000;
/** 範囲は14日まで（§3.1） */
const MAX_RANGE_MS = 14 * DAY_MS;
const MAX_ATTENDEES = 10;

/** RFC3339（オフセットつき）。GCAL_TOOL_INPUT_SCHEMAS の date-time と同じ */
const Rfc3339 = z.iso.datetime({ offset: true, error: "RFC3339（オフセットつき）の日時" });
const HHMM = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "HH:MM");

/** 範囲（time_min < time_max、14日以内）を見る */
function checkRange(v: { time_min: string; time_max: string }, ctx: z.RefinementCtx): void {
  const min = Date.parse(v.time_min);
  const max = Date.parse(v.time_max);
  if (!(max > min)) ctx.addIssue({ code: "custom", path: ["time_max"], message: "time_max は time_min より後" });
  else if (max - min > MAX_RANGE_MS) ctx.addIssue({ code: "custom", path: ["time_max"], message: "範囲は14日まで" });
}

const FindFreeTimeInput = z
  .strictObject({
    time_min: Rfc3339,
    time_max: Rfc3339,
    duration_minutes: z.int().min(15).max(480),
    day_start: HHMM.default("09:00"),
    day_end: HHMM.default("21:00"),
  })
  .superRefine((v, ctx) => {
    checkRange(v, ctx);
    if (minutesOf(v.day_end) <= minutesOf(v.day_start)) ctx.addIssue({ code: "custom", path: ["day_end"], message: "day_end は day_start より後" });
  });

const ListEventsInput = z.strictObject({ time_min: Rfc3339, time_max: Rfc3339 }).superRefine(checkRange);

const CreateEventInput = z
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

const DeleteEventInput = z.strictObject({ event_id: z.string().min(1).max(1024) });

/** ツールの呼び出しの文脈（mcp.ts がヘッダーから作る） */
export interface ToolContext {
  calendar: CalendarClient;
  /** Makase のカレンダーの id（x-ot-gcal-calendar-id） */
  calendarId: string;
  /** 利用者の時間帯（IANA。x-ot-gcal-time-zone） */
  timeZone: string;
  /** 予定の ID を決める Intent の ID（x-ot-idempotency-key。create_event だけ要る、UUID） */
  idempotencyKey: string | null;
}

const okResult = (value: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});

const toolError = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** zod の誤りを1行の日本語にする（どの欄かだけ返す。値は返さない） */
function inputError(error: z.ZodError): CallToolResult {
  const first = error.issues[0];
  const field = first && first.path.length > 0 ? first.path.join(".") : "入力";
  return toolError(`入力が正しくありません（${field}）`);
}

const GOOGLE_ERROR_TEXT = "Google カレンダーがこの操作を受け付けませんでした";

/** 4xx（409・404・410 以外）は結果の文に、それ以外は投げ直す */
function googleFailure(e: unknown, text: string = GOOGLE_ERROR_TEXT): CallToolResult {
  if (e instanceof GoogleApiError) return toolError(`${text}（${e.status}）`);
  throw e;
}

export async function callGcalTool(name: GcalToolName, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  switch (name) {
    case "find_free_time": {
      const parsed = FindFreeTimeInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      const ids = ["primary", ctx.calendarId];
      try {
        const calendars = await ctx.calendar.freeBusy(input.time_min, input.time_max, ids, ctx.timeZone);
        const parts = ids.map((id) => calendars[id]);
        // 片方でも読めなければ、空きを確かめられないので答えない（予定の有無を推測させない）
        if (parts.some((p) => p === undefined || (p.errors?.length ?? 0) > 0)) {
          return toolError("空き時間を確かめられませんでした（カレンダーの読み取りに失敗）");
        }
        const busy = parts.flatMap((p) => p!.busy.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const));
        const result = freeSlots({
          timeMin: Date.parse(input.time_min),
          timeMax: Date.parse(input.time_max),
          busy,
          durationMinutes: input.duration_minutes,
          dayStart: input.day_start,
          dayEnd: input.day_end,
          timeZone: ctx.timeZone,
        });
        return okResult({ slots: result.slots, busy_count: result.busyCount, time_zone: ctx.timeZone });
      } catch (e) {
        return googleFailure(e, "空き時間を確かめられませんでした");
      }
    }

    case "list_events": {
      const parsed = ListEventsInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      try {
        const result = await ctx.calendar.listEvents(ctx.calendarId, input.time_min, input.time_max);
        return okResult({ events: result.events.map(eventView), truncated: result.truncated });
      } catch (e) {
        return googleFailure(e, "予定を読めませんでした");
      }
    }

    case "create_event": {
      const parsed = CreateEventInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      // 予定の ID は Intent から決まる（§2-7）。mcp.ts が UUID を確かめてから来る
      if (ctx.idempotencyKey === null) return toolError("予定の登録に必要な識別子がありません");
      const eventId = eventIdOf(ctx.idempotencyKey);
      const body: EventInsertBody = {
        id: eventId,
        summary: input.title,
        start: { dateTime: input.start, timeZone: ctx.timeZone },
        end: { dateTime: input.end, timeZone: ctx.timeZone },
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.location !== undefined ? { location: input.location } : {}),
        // 宛先は招待の欄に入れるが、通知は送らない（sendUpdates=none。§2-6）
        ...(input.attendees && input.attendees.length > 0 ? { attendees: input.attendees.map((email) => ({ email })) } : {}),
      };
      try {
        let event: GcalEvent;
        let alreadyExisted = false;
        try {
          event = await ctx.calendar.insertEvent(ctx.calendarId, eventId, body);
        } catch (e) {
          // 再送で同じ ID が既にある（§2-7）：読んで、成功として返す
          if (!(e instanceof GoogleApiError && e.status === 409)) throw e;
          event = await ctx.calendar.getEvent(ctx.calendarId, eventId);
          alreadyExisted = true;
        }
        return okResult({
          event_id: event.id,
          html_link: event.htmlLink ?? null,
          start: event.start?.dateTime ?? input.start,
          end: event.end?.dateTime ?? input.end,
          title: event.summary ?? input.title,
          ...(alreadyExisted ? { already_existed: true } : {}),
        });
      } catch (e) {
        return googleFailure(e);
      }
    }

    case "delete_event": {
      const parsed = DeleteEventInput.safeParse(args ?? {});
      if (!parsed.success) return inputError(parsed.error);
      const input = parsed.data;
      try {
        await ctx.calendar.deleteEvent(ctx.calendarId, input.event_id);
        return okResult({ event_id: input.event_id });
      } catch (e) {
        // 既に消えている（404・410）は成功（再送で二度消しても同じ結果）
        if (e instanceof GoogleApiError && (e.status === 404 || e.status === 410)) {
          return okResult({ event_id: input.event_id, already_deleted: true });
        }
        return googleFailure(e);
      }
    }
  }
}

/** 説明の長さの上限（字。コードポイント単位）。sim-core の calendar-tools.ts と同じ値・同じ規則（結果の形を揃える） */
export const DESCRIPTION_MAX_CHARS = 500;

/**
 * 説明を返す形にする。長いものは先頭の500字で切り、切ったことを description_truncated で示す。
 * 説明は読んだ側の文脈に入るので（F-17：既存の予定の説明に指示が書かれうる）、中身は返すが、切ったことは必ず見せる。
 */
export function descriptionView(description: string | null): { description: string | null; description_truncated?: true } {
  if (description === null) return { description: null };
  const chars = [...description];
  if (chars.length <= DESCRIPTION_MAX_CHARS) return { description };
  return { description: chars.slice(0, DESCRIPTION_MAX_CHARS).join(""), description_truncated: true };
}

/** list_events の1件（予定の中身のうち、要る欄だけ） */
function eventView(e: GcalEvent) {
  return {
    id: e.id,
    title: e.summary ?? null,
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    location: e.location ?? null,
    html_link: e.htmlLink ?? null,
    ...descriptionView(e.description ?? null),
  };
}
