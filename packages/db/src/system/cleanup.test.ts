// 古い行の掃除の試験（db-schema.md §7.2 の T-38）。ot_retention の権限で流す
import { describe, expect, it } from "vitest";
import type { Db } from "../client.ts";
import { fxWorkspace, openRoleDb, useTestDb } from "../testing.ts";
import { purgeExpiredRows } from "./cleanup.ts";
import { recordEntryAttempt } from "./entry.ts";

const T = useTestDb();
const NOW = new Date("2026-10-20T09:00:00.000Z");
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

async function withMaint<R>(fn: (maint: Db) => Promise<R>): Promise<R> {
  const maint = await openRoleDb(T().url, "ot_retention");
  try {
    return await fn(maint);
  } finally {
    await maint.close();
  }
}

describe("古い行の掃除", () => {
  it("T-38 24時間より古い entry_attempts・idempotency_keys・workspace_events を消す", async () => {
    const { db } = T();
    const ws = await fxWorkspace(db, { lastSeenAt: NOW });
    const ip = "a".repeat(64);
    await recordEntryAttempt(db, { ipHash: ip, outcome: "wrong_token", now: ago(25 * 60 * MIN) });
    await recordEntryAttempt(db, { ipHash: ip, outcome: "wrong_token", now: ago(23 * 60 * MIN) });
    await db.query(
      "INSERT INTO idempotency_keys (workspace_id, key, method, path, request_hash, response_status, response_body, created_at) VALUES ($1, gen_random_uuid(), 'POST', '/x', $2, 200, '{}', $3)",
      [ws.workspaceId, "b".repeat(64), ago(25 * 60 * MIN)],
    );
    await db.query("INSERT INTO workspace_events (workspace_id, type, data, created_at) VALUES ($1, 'counts', '{}', $2), ($1, 'counts', '{}', $3)", [
      ws.workspaceId,
      ago(25 * 60 * MIN),
      ago(MIN),
    ]);
    const r = await withMaint((m) => purgeExpiredRows(m, NOW));
    expect(r).toEqual({ entryAttempts: 1, idempotencyKeys: 1, workspaceEvents: 1 });
    const left = await db.query<{ n: number }>("SELECT count(*) AS n FROM entry_attempts");
    expect(left.rows[0]?.n).toBe(1);
  });

});
