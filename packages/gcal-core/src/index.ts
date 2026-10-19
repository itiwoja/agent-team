// @open-team/gcal-core：本物の Google カレンダーのコネクタの約束（16_google_calendar.md §3.1、D-113、ADR-040）
// アダプター（apps/gcal）・gateway・app が同じ定義を使う。ここは純粋な定数と関数だけ（HTTP・DB・秘密なし）

import type { ArgPath, ArgRoleMap, JsonObject, ToolClassification, ToolScope } from "@open-team/kernel";

export const GCAL_SLUG = "gcal";
export const GCAL_DISPLAY_NAME = "Google カレンダー";
/** 本人のアカウントに作る専用のカレンダーの名前（calendar.app.created で触れるのはこれだけ） */
export const GCAL_CALENDAR_SUMMARY = "Makase";
export const GCAL_MCP_PATH = "/mcp/gcal";

export const GCAL_SCOPE_APP_CREATED = "https://www.googleapis.com/auth/calendar.app.created";
export const GCAL_SCOPE_FREEBUSY = "https://www.googleapis.com/auth/calendar.freebusy";
/** 同意画面で求める scope（§2-1。最小） */
export const GCAL_SCOPES = ["openid", "email", GCAL_SCOPE_APP_CREATED, GCAL_SCOPE_FREEBUSY] as const;
/** これが揃わなければつながない */
export const GCAL_REQUIRED_SCOPES = [GCAL_SCOPE_APP_CREATED, GCAL_SCOPE_FREEBUSY] as const;

/** gateway → アダプターのヘッダー（値は gateway が DB の行と復号したトークンから作る） */
export const GCAL_HEADER = {
  accessToken: "x-ot-google-access-token",
  calendarId: "x-ot-gcal-calendar-id",
  timeZone: "x-ot-gcal-time-zone",
  idempotencyKey: "x-ot-idempotency-key",
} as const;

export interface GcalToolManifest {
  name: string;
  classification: ToolClassification;
  argRoles: ArgRoleMap;
  scope: ToolScope;
  verify: "none";
  /** 操作の名前（確認の行・理由の文） */
  actionNoun: string;
  units: Readonly<Record<ArgPath, string>>;
}

export interface GcalConnectorManifest {
  slug: string;
  displayName: string;
  tools: readonly GcalToolManifest[];
}

export type GcalToolName = "find_free_time" | "list_events" | "create_event" | "delete_event";

const RFC3339: JsonObject = { type: "string", format: "date-time", maxLength: 40 };
const HHMM: JsonObject = { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" };

/** ツールの入力スキーマ（tools/list でアダプターが返すもの） */
export const GCAL_TOOL_INPUT_SCHEMAS: Readonly<Record<GcalToolName, JsonObject>> = {
  find_free_time: {
    type: "object",
    properties: {
      time_min: RFC3339,
      time_max: RFC3339,
      duration_minutes: { type: "integer", minimum: 15, maximum: 480 },
      day_start: HHMM,
      day_end: HHMM,
    },
    required: ["time_min", "time_max", "duration_minutes"],
    additionalProperties: false,
  },
  list_events: {
    type: "object",
    properties: { time_min: RFC3339, time_max: RFC3339 },
    required: ["time_min", "time_max"],
    additionalProperties: false,
  },
  create_event: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      start: RFC3339,
      end: RFC3339,
      description: { type: "string", maxLength: 2000 },
      location: { type: "string", maxLength: 200 },
      attendees: { type: "array", items: { type: "string", format: "email", maxLength: 254 }, maxItems: 10 },
    },
    required: ["title", "start", "end"],
    additionalProperties: false,
  },
  delete_event: {
    type: "object",
    properties: { event_id: { type: "string", minLength: 1, maxLength: 1024 } },
    required: ["event_id"],
    additionalProperties: false,
  },
};

export const GCAL_TOOL_DESCRIPTIONS: Readonly<Record<GcalToolName, string>> = {
  find_free_time: "本人の Google カレンダーの空き時間を探す（予定の中身は見えない。埋まっている時間だけ）",
  list_events: "Makase のカレンダーに入っている予定を見る",
  create_event: "Makase のカレンダーに予定を入れる（招待の通知は送らない）",
  delete_event: "Makase のカレンダーの予定を消す",
};

export const GCAL_CONNECTOR: GcalConnectorManifest = {
  slug: GCAL_SLUG,
  displayName: GCAL_DISPLAY_NAME,
  tools: [
    { name: "find_free_time", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "空き時間の確認", units: {} },
    { name: "list_events", classification: "read", argRoles: {}, scope: null, verify: "none", actionNoun: "予定の確認", units: {} },
    {
      name: "create_event",
      classification: "write",
      argRoles: { title: "content", description: "content", location: "content", start: "option", end: "option", attendees: "destination" },
      scope: null,
      verify: "none",
      actionNoun: "予定の登録",
      units: {},
    },
    { name: "delete_event", classification: "write", argRoles: { event_id: "destination" }, scope: null, verify: "none", actionNoun: "予定の削除", units: {} },
  ],
};

/**
 * Intent から決まるイベント ID（§2-7。再送で二重に入らない）。
 * Calendar の ID は base32hex（a〜v・0〜9）の5〜1024文字。UUID の16進（0〜9・a〜f）はその部分集合なので、そのまま使える
 */
export function eventIdOf(intentId: string): string {
  const hex = intentId.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("intentId は UUID であること");
  return `mk${hex}`;
}
