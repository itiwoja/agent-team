// SSE（EP-45。AS §3.14・§6.7 の T-144〜T-146、M-53）。事象は workspace_events に書いて NOTIFY には '<ws>:<id>' だけ
import { wsCtxOf, type Db } from "@open-team/db";
import { appendWorkspaceEvent, WORKSPACE_EVENTS_CHANNEL } from "@open-team/db/app";
import { fxWorkspace, useTestDb } from "@open-team/db/testing";
import { afterEach, describe, expect, it } from "vitest";
import { formatSseEvent, parseLastEventId } from "./sse.ts";
import { T0, makeTestApp, send, signInOwner, sseReader, type TestApp } from "./test-helpers.ts";

const T = useTestDb();
const opened: TestApp[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) await t.deps.eventHub.stop();
});

async function sseApp(db: Db, sse: Partial<TestApp["deps"]["sse"]> = {}): Promise<TestApp> {
  const t = makeTestApp(db, { deps: { sse: { heartbeatMs: 60_000, maxDurationMs: 60_000, batchSize: 100, ...sse } } });
  await t.deps.eventHub.start();
  opened.push(t);
  return t;
}

async function addEvent(db: Db, workspaceId: string, type: string, data: unknown) {
  return db.transaction((tx) => appendWorkspaceEvent(tx, wsCtxOf({ id: workspaceId, kind: "owner" }), { type, data: data as never }, T0));
}

const stream = (t: TestApp, a: { cookie: string; workspaceId: string }, headers: Record<string, string> = {}, query = "") =>
  send(t, "GET", `/api/v1/workspaces/${a.workspaceId}/stream${query}`, { cookie: a.cookie, headers });

describe("形と始まり", () => {
  it("text/event-stream・no-store。Last-Event-ID なしは今の最新の id だけを送り（ブラウザの lastEventId を合わせる）、それより前の事象は送らない", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    const old = await addEvent(db, a.workspaceId, "ask.updated", { n: 1 });
    const res = await stream(t, a);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const r = sseReader(res);
    await r.until((m) => m.length >= 1, 1_000);
    expect(r.messages[0]).toEqual({ id: String(old.id), event: null, data: null, comment: null });
    // 少し待っても古い事象は来ない
    await r.until(() => false, 200);
    expect(r.messages.filter((m) => m.event !== null)).toEqual([]);
    await r.cancel();
  });

  it("書いた事象は通知で届く（id・event・data は JSON 1行）。ほかのワークスペースの事象は届かない", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    const other = await fxWorkspace(db, { second: true });
    const r = sseReader(await stream(t, a));
    await r.until((m) => m.length >= 1, 1_000);
    await addEvent(db, other.workspaceId, "ask.updated", { secret: "B の事象" });
    const e = await addEvent(db, a.workspaceId, "check.upsert", { item: { key: "answer:1", text: "改行\nを含む" } });
    await r.until((m) => m.some((x) => x.event === "check.upsert"), 3_000);
    const got = r.messages.filter((m) => m.event !== null);
    expect(got).toEqual([{ id: String(e.id), event: "check.upsert", data: JSON.stringify({ item: { key: "answer:1", text: "改行\nを含む" } }), comment: null }]);
    expect(JSON.stringify(r.messages)).not.toContain("B の事象");
    await r.cancel();
  });

  it("Kill Switch の発動は event: killswitch で届く", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    const r = sseReader(await stream(t, a));
    await r.until((m) => m.length >= 1, 1_000);
    await send(t, "POST", `/api/v1/workspaces/${a.workspaceId}/kill-switch`, { cookie: a.cookie, csrf: a.csrf, body: {} });
    await r.until((m) => m.some((x) => x.event === "killswitch"), 3_000);
    expect(JSON.parse(r.messages.find((x) => x.event === "killswitch")?.data ?? "null")).toEqual({ engaged: true, engagedAt: T0.toISOString() });
    await r.cancel();
  });
});

describe("T-144 つなぎ直し（Last-Event-ID）", () => {
  it("切って Last-Event-ID: n でつなぎ直すと n+1 から重複なく届く（ヘッダーでもクエリ lastEventId でも）", async () => {
    const { db } = T();
    const t = await sseApp(db, { batchSize: 2 });
    const a = await signInOwner(t);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await addEvent(db, a.workspaceId, "ask.updated", { i })).id);
    for (const [headers, query] of [
      [{ "last-event-id": String(ids[1]) }, ""],
      [{}, `?lastEventId=${ids[1]}`],
    ] as const) {
      const r = sseReader(await stream(t, a, headers, query));
      await r.until((m) => m.filter((x) => x.event).length >= 3, 3_000);
      expect(r.messages.filter((x) => x.event).map((x) => Number(x.id))).toEqual(ids.slice(2));
      await r.cancel();
    }
  });

  it("Last-Event-ID: 0 は残っている事象をすべて", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    const e1 = await addEvent(db, a.workspaceId, "ask.updated", { i: 1 });
    const e2 = await addEvent(db, a.workspaceId, "ask.updated", { i: 2 });
    const r = sseReader(await stream(t, a, { "last-event-id": "0" }));
    await r.until((m) => m.filter((x) => x.event).length >= 2, 3_000);
    expect(r.messages.filter((x) => x.event).map((x) => Number(x.id))).toEqual([e1.id, e2.id]);
    await r.cancel();
  });

  it("T-146 保持期間より古い（行が消えた）Last-Event-ID → event: reset（id は今の最新）、そのあとの事象は続けて届く", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    const gone = await addEvent(db, a.workspaceId, "ask.updated", { i: 1 });
    const kept = await addEvent(db, a.workspaceId, "ask.updated", { i: 2 });
    await db.query("DELETE FROM workspace_events WHERE id = $1", [gone.id]);
    const r = sseReader(await stream(t, a, { "last-event-id": String(gone.id) }));
    await r.until((m) => m.length >= 1, 1_000);
    expect(r.messages[0]).toEqual({ id: String(kept.id), event: "reset", data: "{}", comment: null });
    const next = await addEvent(db, a.workspaceId, "ask.updated", { i: 3 });
    await r.until((m) => m.some((x) => x.event === "ask.updated"), 3_000);
    expect(r.messages.filter((x) => x.event === "ask.updated").map((x) => Number(x.id))).toEqual([next.id]);
    await r.cancel();
  });

  it("ほかのワークスペースの事象の id を Last-Event-ID にしても、その続きは読めない（reset）", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    const other = await fxWorkspace(db, { second: true });
    const foreign = await addEvent(db, other.workspaceId, "ask.updated", { x: 1 });
    const r = sseReader(await stream(t, a, { "last-event-id": String(foreign.id) }));
    await r.until((m) => m.length >= 1, 1_000);
    expect(r.messages[0]?.event).toBe("reset");
    await r.cancel();
  });

  it("Last-Event-ID が整数でない → 400", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    expect((await stream(t, a, { "last-event-id": "abc" })).status).toBe(400);
    expect((await stream(t, a, { "last-event-id": "-1" })).status).toBe(400);
  });
});

describe("T-145 ハートビートと切断", () => {
  it("間隔ごとに ': heartbeat'、決めた時間でサーバーが切る（既定 15秒・55分）", async () => {
    const { db } = T();
    const t = await sseApp(db, { heartbeatMs: 40, maxDurationMs: 300 });
    const a = await signInOwner(t);
    const r = sseReader(await stream(t, a));
    await r.until(() => false, 3_000);
    expect(r.ended).toBe(true);
    expect(r.messages.filter((m) => m.comment === "heartbeat").length).toBeGreaterThanOrEqual(2);
    expect(t.deps.eventHub.subscriberCount).toBe(0);
  });

  it("通知が届かなくても、ハートビートのたびに続きを読む（見回り）", async () => {
    const { db } = T();
    const t = makeTestApp(db, { deps: { sse: { heartbeatMs: 50, maxDurationMs: 60_000, batchSize: 100 } } });
    // LISTEN を張らない（通知が落ちた状態）
    const a = await signInOwner(t);
    const r = sseReader(await stream(t, a));
    await r.until((m) => m.length >= 1, 1_000);
    const e = await addEvent(db, a.workspaceId, "ask.updated", { i: 1 });
    await r.until((m) => m.some((x) => x.event === "ask.updated"), 3_000);
    expect(r.messages.find((x) => x.event === "ask.updated")?.id).toBe(String(e.id));
    await r.cancel();
  });

  it("クライアントが切ると購読を外す", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    const r = sseReader(await stream(t, a));
    await r.until((m) => m.length >= 1, 1_000);
    expect(t.deps.eventHub.subscriberCount).toBe(1);
    await r.cancel();
    expect(t.deps.eventHub.subscriberCount).toBe(0);
  });
});

describe("守り", () => {
  it("セッションなし → 401、別のワークスペース → 404", async () => {
    const { db } = T();
    const t = await sseApp(db);
    const a = await signInOwner(t);
    expect((await send(t, "GET", `/api/v1/workspaces/${a.workspaceId}/stream`)).status).toBe(401);
    const other = await fxWorkspace(db, { second: true });
    expect((await stream(t, { cookie: a.cookie, workspaceId: other.workspaceId })).status).toBe(404);
  });

  it("NOTIFY の payload は '<workspaceId>:<id>'（本文を載せない）", async () => {
    const { db } = T();
    const t = makeTestApp(db);
    const a = await signInOwner(t);
    const got: string[] = [];
    const l = await db.listen(WORKSPACE_EVENTS_CHANNEL, (p) => got.push(p));
    try {
      const e = await addEvent(db, a.workspaceId, "ask.updated", { big: "x".repeat(100) });
      for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(got).toEqual([`${a.workspaceId}:${e.id}`]);
    } finally {
      await l.unlisten();
    }
  });

  it("type の形が違う事象は書けない", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db);
    await expect(addEvent(db, ws.workspaceId, "Bad Type\nevent: x", {})).rejects.toThrow(/type/);
  });
});

describe("部品", () => {
  it("parseLastEventId：なし → null、整数 → 数、それ以外 → undefined（ヘッダーが先）", () => {
    expect(parseLastEventId(undefined, undefined)).toBeNull();
    expect(parseLastEventId("", undefined)).toBeNull();
    expect(parseLastEventId("12", "5")).toBe(12);
    expect(parseLastEventId(undefined, "5")).toBe(5);
    expect(parseLastEventId("1.5", undefined)).toBeUndefined();
    expect(parseLastEventId("9".repeat(16), undefined)).toBeUndefined();
  });

  it("formatSseEvent：id・event・data（JSON 1行）と空行", () => {
    expect(formatSseEvent({ id: 3, type: "check.remove", data: { key: "a\nb" } })).toBe('id: 3\nevent: check.remove\ndata: {"key":"a\\nb"}\n\n');
  });
});
