import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GCAL_HEADER, GCAL_TOOL_DESCRIPTIONS, GCAL_TOOL_INPUT_SCHEMAS } from "@open-team/gcal-core";
import {
  ACCESS_TOKEN,
  API_BASE,
  CALENDAR_ID,
  CALL_HEADERS,
  EVENT_ID,
  GATEWAY,
  INTENT,
  connectMcp,
  fakeGoogle,
  json,
  setup,
} from "./test-helpers.ts";

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function mcp(app: Parameters<typeof connectMcp>[0], headers: Record<string, string> = { ...GATEWAY, ...CALL_HEADERS }) {
  const c = await connectMcp(app, headers);
  clients.push(c);
  return c;
}

/** callTool が投げた HTTP の失敗（401・503 など）の状態コード */
async function httpStatusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof StreamableHTTPError) return e.code ?? -1;
    throw e;
  }
  throw new Error("失敗するはずの呼び出しが通った");
}

const CAL_PATH = `/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`;
const CREATE_ARGS = {
  title: "勉強会",
  start: "2026-10-14T10:00:00+09:00",
  end: "2026-10-14T11:00:00+09:00",
  location: "会議室A",
  attendees: ["a@example.com"],
};
const CREATED = {
  id: EVENT_ID,
  summary: "勉強会",
  htmlLink: "https://www.google.com/calendar/event?eid=abc",
  start: { dateTime: "2026-10-14T10:00:00+09:00", timeZone: "Asia/Tokyo" },
  end: { dateTime: "2026-10-14T11:00:00+09:00", timeZone: "Asia/Tokyo" },
};

describe("tools/list（16 §3.2。ヘッダーなしで答える）", () => {
  it("4つのツールの名前・説明・入力スキーマ。読むだけのツールには readOnlyHint", async () => {
    const google = fakeGoogle(() => json(500));
    const { app } = setup(google);
    const c = await mcp(app, GATEWAY);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_event", "delete_event", "find_free_time", "list_events"]);
    for (const t of tools) {
      const name = t.name as keyof typeof GCAL_TOOL_DESCRIPTIONS;
      expect(t.description).toBe(GCAL_TOOL_DESCRIPTIONS[name]);
      expect(t.inputSchema).toEqual(GCAL_TOOL_INPUT_SCHEMAS[name]);
      expect(t.annotations?.readOnlyHint).toBe(name === "find_free_time" || name === "list_events" ? true : undefined);
    }
    expect(google.calls).toHaveLength(0);
  });
});

describe("create_event（16 §2-6・§2-7、§3.1）", () => {
  it("予定を入れる：ID は Intent から決まる・通知は送らない・宛先は招待の欄", async () => {
    const google = fakeGoogle(() => json(200, CREATED));
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({ name: "create_event", arguments: CREATE_ARGS });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      event_id: EVENT_ID,
      html_link: CREATED.htmlLink,
      start: "2026-10-14T10:00:00+09:00",
      end: "2026-10-14T11:00:00+09:00",
      title: "勉強会",
    });
    expect(google.calls).toHaveLength(1);
    const call = google.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.origin + call.url.pathname).toBe(API_BASE.replace("/calendar/v3", "") + CAL_PATH);
    expect(call.url.searchParams.get("sendUpdates")).toBe("none");
    expect(call.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call.body).toMatchObject({
      id: EVENT_ID,
      summary: "勉強会",
      location: "会議室A",
      start: { dateTime: "2026-10-14T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-10-14T11:00:00+09:00", timeZone: "Asia/Tokyo" },
      attendees: [{ email: "a@example.com" }],
    });
  });

  it("409（既にある）→ 既存の予定を読んで、成功として already_existed を返す", async () => {
    const google = fakeGoogle((call) => {
      if (call.method === "POST") return json(409, { error: { code: 409 } });
      return json(200, CREATED);
    });
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({ name: "create_event", arguments: { title: "勉強会", start: CREATE_ARGS.start, end: CREATE_ARGS.end } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ event_id: EVENT_ID, html_link: CREATED.htmlLink, already_existed: true });
    expect(google.calls.map((x) => `${x.method} ${x.url.pathname}`)).toEqual([
      `POST ${CAL_PATH}`,
      `GET ${CAL_PATH}/${EVENT_ID}`,
    ]);
  });

  it("Google の 400 → ツールの結果（isError）。HTTP のエラーにはしない", async () => {
    const google = fakeGoogle(() => json(400, { error: { message: "bad" } }));
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({ name: "create_event", arguments: CREATE_ARGS });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("400");
  });

  it("入力が誤り（end が start より前・招待が10人超）→ isError で、Google は呼ばない", async () => {
    const google = fakeGoogle(() => json(200, CREATED));
    const { app } = setup(google);
    const c = await mcp(app);
    const badOrder = await c.callTool({ name: "create_event", arguments: { ...CREATE_ARGS, end: "2026-10-14T09:00:00+09:00" } });
    expect(badOrder.isError).toBe(true);
    const tooMany = await c.callTool({
      name: "create_event",
      arguments: { ...CREATE_ARGS, attendees: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`) },
    });
    expect(tooMany.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });
});

describe("Google の失敗の写し（16 §2・§3.2）", () => {
  it.each([
    ["401", 401, 401],
    ["403", 403, 401],
    ["429", 429, 429],
    ["503", 503, 503],
    ["500", 500, 500],
  ])("Google の %s → HTTP %s", async (_label, upstream, expected) => {
    const google = fakeGoogle(() => json(upstream, { error: { message: "x" } }));
    const { app } = setup(google);
    const c = await mcp(app);
    expect(await httpStatusOf(c.callTool({ name: "create_event", arguments: CREATE_ARGS }))).toBe(expected);
  });

  it("Google に届かない（fetch が投げる）→ HTTP 503（送ったかどうか分からない＝unknown_outcome）", async () => {
    const google = { fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch, calls: [] };
    const { app } = setup(google);
    const c = await mcp(app);
    expect(await httpStatusOf(c.callTool({ name: "list_events", arguments: { time_min: "2026-10-14T00:00:00+09:00", time_max: "2026-10-15T00:00:00+09:00" } }))).toBe(503);
  });
});

describe("ヘッダー（16 §3.2：無ければ HTTP 401）", () => {
  it.each([GCAL_HEADER.accessToken, GCAL_HEADER.calendarId, GCAL_HEADER.timeZone])("%s が無い tools/call → 401", async (missing) => {
    const google = fakeGoogle(() => json(200, CREATED));
    const { app } = setup(google);
    const headers: Record<string, string> = { ...GATEWAY, ...CALL_HEADERS };
    delete headers[missing];
    const c = await mcp(app, headers);
    expect(await httpStatusOf(c.callTool({ name: "list_events", arguments: { time_min: "2026-10-14T00:00:00+09:00", time_max: "2026-10-15T00:00:00+09:00" } }))).toBe(401);
    expect(google.calls).toHaveLength(0);
  });

  it("時間帯が IANA の名前でない → 401", async () => {
    const google = fakeGoogle(() => json(200, CREATED));
    const { app } = setup(google);
    const c = await mcp(app, { ...GATEWAY, ...CALL_HEADERS, [GCAL_HEADER.timeZone]: "Mars/Olympus" });
    expect(await httpStatusOf(c.callTool({ name: "list_events", arguments: { time_min: "2026-10-14T00:00:00+09:00", time_max: "2026-10-15T00:00:00+09:00" } }))).toBe(401);
  });

  it("create_event で予定の ID の元（idempotencyKey）が無い → 401", async () => {
    const google = fakeGoogle(() => json(200, CREATED));
    const { app } = setup(google);
    const headers: Record<string, string> = { ...GATEWAY, ...CALL_HEADERS };
    delete headers[GCAL_HEADER.idempotencyKey];
    const c = await mcp(app, headers);
    expect(await httpStatusOf(c.callTool({ name: "create_event", arguments: CREATE_ARGS }))).toBe(401);
    expect(google.calls).toHaveLength(0);
  });
});

describe("delete_event（16 §3.1）", () => {
  it("消す：通知は送らない", async () => {
    const google = fakeGoogle(() => new Response(null, { status: 204 }));
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({ name: "delete_event", arguments: { event_id: EVENT_ID } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ event_id: EVENT_ID });
    expect(google.calls[0]!.method).toBe("DELETE");
    expect(google.calls[0]!.url.searchParams.get("sendUpdates")).toBe("none");
  });

  it.each([404, 410])("%s（もう無い）→ 成功。already_deleted", async (status) => {
    const google = fakeGoogle(() => json(status, { error: { code: status } }));
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({ name: "delete_event", arguments: { event_id: EVENT_ID } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ event_id: EVENT_ID, already_deleted: true });
  });
});

describe("list_events の説明（500字で切る・F-17 の指示は読める形で返す）", () => {
  const range = { time_min: "2026-10-14T00:00:00+09:00", time_max: "2026-10-15T00:00:00+09:00" };

  it("500字を超える説明は先頭500字で切り、description_truncated: true を付ける（字はコードポイント単位）", async () => {
    const long = "あ".repeat(499) + "😀" + "い".repeat(10);
    const google = fakeGoogle(() =>
      json(200, { items: [{ id: EVENT_ID, summary: "勉強会", start: { dateTime: "2026-10-14T10:00:00+09:00" }, end: { dateTime: "2026-10-14T11:00:00+09:00" }, description: long }] }),
    );
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({ name: "list_events", arguments: range });
    const ev = (res.structuredContent as { events: Array<{ description: string; description_truncated?: true }> }).events[0]!;
    expect(ev.description).toBe("あ".repeat(499) + "😀");
    expect([...ev.description]).toHaveLength(500);
    expect(ev.description_truncated).toBe(true);
  });

  it("ちょうど500字は切らず、フラグも付けない。説明がない予定は description: null", async () => {
    const google = fakeGoogle(() =>
      json(200, {
        items: [
          { id: EVENT_ID, summary: "a", start: { dateTime: "2026-10-14T10:00:00+09:00" }, end: { dateTime: "2026-10-14T11:00:00+09:00" }, description: "x".repeat(500) },
          { id: "other-event", summary: "b", start: { dateTime: "2026-10-14T12:00:00+09:00" }, end: { dateTime: "2026-10-14T13:00:00+09:00" } },
        ],
      }),
    );
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({ name: "list_events", arguments: range });
    const [a, b] = (res.structuredContent as { events: Array<Record<string, unknown>> }).events;
    expect(a).not.toHaveProperty("description_truncated");
    expect(a!.description).toBe("x".repeat(500));
    expect(b!.description).toBeNull();
    expect(b).not.toHaveProperty("description_truncated");
  });
});

describe("find_free_time・list_events（16 §3.1）", () => {
  it("find_free_time：primary と Makase の埋まりを合わせて、東京の時間で空きを返す（予定の中身は見ない）", async () => {
    const google = fakeGoogle(() =>
      json(200, {
        calendars: {
          primary: { busy: [{ start: "2026-10-14T01:00:00Z", end: "2026-10-14T02:00:00Z" }] },
          [CALENDAR_ID]: { busy: [] },
        },
      }),
    );
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({
      name: "find_free_time",
      arguments: { time_min: "2026-10-14T00:00:00+09:00", time_max: "2026-10-15T00:00:00+09:00", duration_minutes: 60 },
    });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { slots: Array<{ start: string; end: string }>; busy_count: number };
    expect(sc.busy_count).toBe(1);
    // 10:00〜11:00（JST）が埋まり。09:00 の枠と 11:00 から
    expect(sc.slots[0]).toEqual({ start: "2026-10-14T09:00:00+09:00", end: "2026-10-14T10:00:00+09:00" });
    expect(sc.slots[1]).toEqual({ start: "2026-10-14T11:00:00+09:00", end: "2026-10-14T12:00:00+09:00" });
    expect(google.calls[0]!.url.pathname).toBe("/calendar/v3/freeBusy");
    expect(google.calls[0]!.body).toMatchObject({ timeZone: "Asia/Tokyo", items: [{ id: "primary" }, { id: CALENDAR_ID }] });
  });

  it("find_free_time：範囲が14日を超える・終わりが始まりより前 → isError（Google は呼ばない）", async () => {
    const google = fakeGoogle(() => json(200, { calendars: {} }));
    const { app } = setup(google);
    const c = await mcp(app);
    const tooLong = await c.callTool({
      name: "find_free_time",
      arguments: { time_min: "2026-10-01T00:00:00+09:00", time_max: "2026-10-20T00:00:00+09:00", duration_minutes: 60 },
    });
    expect(tooLong.isError).toBe(true);
    const reversed = await c.callTool({
      name: "find_free_time",
      arguments: { time_min: "2026-10-15T00:00:00+09:00", time_max: "2026-10-14T00:00:00+09:00", duration_minutes: 60 },
    });
    expect(reversed.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it("list_events：Makase のカレンダーの予定を、要る欄だけ返す", async () => {
    const google = fakeGoogle(() =>
      json(200, {
        items: [
          {
            id: EVENT_ID,
            summary: "勉強会",
            location: "会議室A",
            htmlLink: CREATED.htmlLink,
            start: { dateTime: "2026-10-14T10:00:00+09:00" },
            end: { dateTime: "2026-10-14T11:00:00+09:00" },
            description: "持ち物：ノート",
          },
        ],
      }),
    );
    const { app } = setup(google);
    const c = await mcp(app);
    const res = await c.callTool({
      name: "list_events",
      arguments: { time_min: "2026-10-14T00:00:00+09:00", time_max: "2026-10-15T00:00:00+09:00" },
    });
    expect(res.structuredContent).toEqual({
      events: [
        {
          id: EVENT_ID,
          title: "勉強会",
          start: "2026-10-14T10:00:00+09:00",
          end: "2026-10-14T11:00:00+09:00",
          location: "会議室A",
          html_link: CREATED.htmlLink,
          description: "持ち物：ノート",
        },
      ],
      truncated: false,
    });
    const u = google.calls[0]!.url;
    expect(u.pathname).toBe(CAL_PATH);
    expect(u.searchParams.get("singleEvents")).toBe("true");
    expect(u.searchParams.get("orderBy")).toBe("startTime");
    expect(u.searchParams.get("maxResults")).toBe("50");
  });
});

describe("ログ（16 §2-1：トークンは出さない）", () => {
  it("アクセストークンはログのどの行にも出ない", async () => {
    const google = fakeGoogle((call) => (call.method === "POST" ? json(503, {}) : json(200, CREATED)));
    const { app, lines } = setup(google);
    const c = await mcp(app);
    await httpStatusOf(c.callTool({ name: "create_event", arguments: CREATE_ARGS }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(ACCESS_TOKEN);
  });
});
