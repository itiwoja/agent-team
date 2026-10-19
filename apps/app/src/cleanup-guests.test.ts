// POST /internal/cron/cleanup-guests（EP-48）。ot_retention の接続で掃除を呼び、数だけを返す
import { fxWorkspace, openRoleDb, useTestDb } from "@open-team/db/testing";
import { describe, expect, it } from "vitest";
import { unavailableDb } from "./deps.ts";
import { makeTestApp, sendInternal, T0 } from "./test-helpers.ts";

const T = useTestDb();
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(T0.getTime() - ms);

describe("POST /internal/cron/cleanup-guests", () => {
  it("証明なし ／ sa-gateway → 403（掃除は走らない）", async () => {
    const t = makeTestApp(unavailableDb());
    expect((await sendInternal(t, "POST", "/internal/cron/cleanup-guests", null)).status).toBe(403);
    expect((await sendInternal(t, "POST", "/internal/cron/cleanup-guests", "sa-gateway")).status).toBe(403);
  });

  it("7日を過ぎたゲストだけ消し、数を返す（ワークスペースの ID は応答に出さない）", async () => {
    const { db } = T();
    const stale = await fxWorkspace(db, { lastSeenAt: ago(8 * DAY), audit: true });
    const fresh = await fxWorkspace(db, { lastSeenAt: ago(1 * DAY), audit: true });
    const maint = await openRoleDb(T().url, "ot_retention");
    try {
      const t = makeTestApp(db, { deps: { maintDb: maint } });
      const res = await sendInternal(t, "POST", "/internal/cron/cleanup-guests");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ scanned: 1, deleted: 1, deferred: 0, failed: 0, agentsRemoved: 0 });
      expect(JSON.stringify(body)).not.toContain(stale.workspaceId);
      const left = await db.query<{ id: string }>("SELECT id FROM workspaces WHERE id = ANY($1::uuid[])", [[stale.workspaceId, fresh.workspaceId]]);
      expect(left.rows.map((r) => r.id)).toEqual([fresh.workspaceId]);
      expect(t.logs.find((r) => r.event === "cleanup.guests")).toMatchObject({ deleted: 1 });
    } finally {
      await maint.close();
    }
  });
});
