import { describe, expect, it } from "vitest";
import { createCalendarClient } from "./calendar.ts";

describe("listEvents のページング", () => {
  it("最大4ページを取得し、続きが残る場合に truncated を返す", async () => {
    const urls: URL[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      urls.push(url);
      const page = Number(url.searchParams.get("pageToken")?.replace("p", "") ?? "1");
      return new Response(JSON.stringify({ items: [{ id: `e${page}` }], ...(page < 5 ? { nextPageToken: `p${page + 1}` } : {}) }), { status: 200 });
    }) as typeof fetch;
    const client = createCalendarClient(fetchFn, "https://www.googleapis.com/calendar/v3", "token");
    const result = await client.listEvents("calendar", "a", "b");
    expect(result.events.map((event) => event.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(result.truncated).toBe(true);
    expect(urls).toHaveLength(4);
    expect(urls[3]?.searchParams.get("pageToken")).toBe("p4");
  });
});
