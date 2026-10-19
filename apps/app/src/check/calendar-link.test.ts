// 「カレンダーで開く」のリンク（calendar-link.ts）の試験：予定の登録の結果から https の Google カレンダーの URL だけを取り出す
import { describe, expect, it } from "vitest";
import { calendarLinkOf } from "./calendar-link.ts";

const ACTION = "mcp.gcal.create_event";
const stored = (link: unknown) => ({ content: JSON.stringify({ event_id: "e1", html_link: link, start: "2026-10-10T10:00:00+09:00", end: "2026-10-10T11:00:00+09:00", title: "打ち合わせ" }), isError: false, truncated: false });

describe("calendarLinkOf：予定の登録の結果から「カレンダーで開く」のリンクを取り出す", () => {
  it("https://www.google.com の予定のリンクを返す", () => {
    expect(calendarLinkOf(ACTION, stored("https://www.google.com/calendar/event?eid=abc"))).toBe("https://www.google.com/calendar/event?eid=abc");
  });

  it("https://calendar.google.com のリンクを返す", () => {
    expect(calendarLinkOf(ACTION, stored("https://calendar.google.com/calendar/event?eid=abc"))).toBe("https://calendar.google.com/calendar/event?eid=abc");
  });

  it("javascript: は拒否する", () => {
    expect(calendarLinkOf(ACTION, stored("javascript:alert(1)"))).toBeNull();
  });

  it("http: は拒否する", () => {
    expect(calendarLinkOf(ACTION, stored("http://www.google.com/calendar/event?eid=abc"))).toBeNull();
  });

  it("別のホストは拒否する（部分一致・サブドメインの偽装も含む）", () => {
    expect(calendarLinkOf(ACTION, stored("https://evil.example.com/calendar"))).toBeNull();
    expect(calendarLinkOf(ACTION, stored("https://www.google.com.evil.example/calendar"))).toBeNull();
    expect(calendarLinkOf(ACTION, stored("https://evil.example/?www.google.com"))).toBeNull();
    expect(calendarLinkOf(ACTION, stored("https://mail.google.com/calendar"))).toBeNull();
  });

  it("ユーザー情報やポートの付いたものは拒否する", () => {
    expect(calendarLinkOf(ACTION, stored("https://user@www.google.com/calendar"))).toBeNull();
    expect(calendarLinkOf(ACTION, stored("https://www.google.com:8443/calendar"))).toBeNull();
  });

  it("予定の登録以外の操作は、リンクがあっても返さない", () => {
    expect(calendarLinkOf("mcp.gcal.list_events", stored("https://www.google.com/calendar/event?eid=abc"))).toBeNull();
    expect(calendarLinkOf("mcp.shop.send_mail", stored("https://www.google.com/calendar/event?eid=abc"))).toBeNull();
  });

  it("html_link がない・壊れた結果は null", () => {
    expect(calendarLinkOf(ACTION, { content: "（本文）", isError: false, truncated: false })).toBeNull();
    expect(calendarLinkOf(ACTION, { content: "{not json", isError: false, truncated: false })).toBeNull();
    expect(calendarLinkOf(ACTION, stored(null))).toBeNull();
    expect(calendarLinkOf(ACTION, stored(42))).toBeNull();
    expect(calendarLinkOf(ACTION, stored(""))).toBeNull();
    expect(calendarLinkOf(ACTION, stored("not a url"))).toBeNull();
    expect(calendarLinkOf(ACTION, null)).toBeNull();
    expect(calendarLinkOf(ACTION, "https://www.google.com/calendar/event")).toBeNull();
  });

  it("結果に html_link が直接入っている形も読む", () => {
    expect(calendarLinkOf(ACTION, { html_link: "https://calendar.google.com/calendar/event?eid=x" })).toBe("https://calendar.google.com/calendar/event?eid=x");
    expect(calendarLinkOf(ACTION, { html_link: "javascript:alert(1)" })).toBeNull();
  });
});
