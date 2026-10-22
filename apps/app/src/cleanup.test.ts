// POST /internal/cron/cleanup（EP-48）。ot_retention の接続で古い記録を消し、数だけを返す
import { fxWorkspace, openRoleDb, useTestDb } from "@open-team/db/testing";
import { system } from "@open-team/db";
import { describe, expect, it } from "vitest";
import { unavailableDb } from "./deps.ts";
import { makeTestApp, sendInternal, T0 } from "./test-helpers.ts";

const T = useTestDb();
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(T0.getTime() - ms);

describe("POST /internal/cron/cleanup", () => {
  it("証明なし ／ sa-gateway → 403（掃除は走らない）", async () => {
    const t = makeTestApp(unavailableDb());
    expect((await sendInternal(t, "POST", "/internal/cron/cleanup", null)).status).toBe(403);
    expect((await sendInternal(t, "POST", "/internal/cron/cleanup", "sa-gateway")).status).toBe(403);
  });

  it("24時間より古い入口の試行・SSE の事象だけ消し、数を返す", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { audit: true });
    const ip = "a".repeat(64);
    await system.recordEntryAttempt(db, { ipHash: ip, outcome: "wrong_token", now: ago(25 * HOUR) });
    await system.recordEntryAttempt(db, { ipHash: ip, outcome: "wrong_token", now: ago(1 * HOUR) });
    await db.query("INSERT INTO workspace_events (workspace_id, type, data, created_at) VALUES ($1, 'counts', '{}', $2)", [ws.workspaceId, ago(25 * HOUR)]);
    const maint = await openRoleDb(T().url, "ot_retention");
    try {
      const t = makeTestApp(db, { deps: { maintDb: maint } });
      const res = await sendInternal(t, "POST", "/internal/cron/cleanup");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ purged: { entryAttempts: 1, idempotencyKeys: 0, workspaceEvents: 1 }, agentsRemoved: 0 });
      const left = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM entry_attempts");
      expect(left.rows[0]?.n).toBe(1);
      expect(t.logs.find((r) => r.event === "cleanup.purged")).toMatchObject({ entryAttempts: 1 });
    } finally {
      await maint.close();
    }
  });
});
