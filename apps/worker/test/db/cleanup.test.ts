// 古い行の掃除の試験（packages/db/src/system/cleanup.test.ts の WorkspaceDO 版。db-schema.md §7.2 の T-38）。
// entry_attempts は D1 の表なので、ここでは試さない
import { describe, expect, it } from "vitest";
import { purgeExpiredRows } from "../../src/db/repo/cleanup.ts";
import { count, newId, run } from "../../src/db/sqlite.ts";
import { inWorkspace } from "./fixtures.ts";

const NOW = new Date("2026-10-20T09:00:00.000Z");
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("古い行の掃除", () => {
  it("T-38 24時間より古い idempotency_keys・workspace_events を消す", async () => {
    await inWorkspace((db) => {
      const key = (at: Date) =>
        run(
          db,
          "INSERT INTO idempotency_keys (key, method, path, request_hash, response_status, response_body, created_at) VALUES (?, 'POST', '/x', ?, 200, '{}', ?)",
          newId(),
          "b".repeat(64),
          at,
        );
      key(ago(25 * 60 * MIN));
      key(ago(23 * 60 * MIN));
      run(db, "INSERT INTO workspace_events (type, data, created_at) VALUES ('counts', '{}', ?), ('counts', '{}', ?)", ago(25 * 60 * MIN), ago(MIN));
      expect(purgeExpiredRows(db, NOW)).toEqual({ idempotencyKeys: 1, workspaceEvents: 1 });
      expect(count(db, "SELECT count(*) FROM idempotency_keys")).toBe(1);
      expect(count(db, "SELECT count(*) FROM workspace_events")).toBe(1);
      expect(purgeExpiredRows(db, NOW)).toEqual({ idempotencyKeys: 0, workspaceEvents: 0 });
    });
  });
});
