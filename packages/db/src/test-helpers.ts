// vitest の道具（@open-team/db/testing から出す）。名前が test-helpers.ts なので dependency-cruiser の
// not-to-dev-dep（本番のコードから devDependencies を使わない）の対象外（本番では読み込まれない）
import { afterEach, beforeAll, beforeEach } from "vitest";
import type { DbOptions } from "./client.ts";
import { openTestDb, warmUpTestDatabase, type CreateTestDatabaseOptions, type TestDb } from "./test-database.ts";

/**
 * vitest で、試験（it）ごとに新しいデータベース（マイグレーション済み）と Db を用意し、終わったら消す。
 *   const t = useTestDb();  it("…", async () => { const { db } = t(); … });
 * describe の外か中で1回呼ぶ（beforeAll・beforeEach・afterEach を登録する）
 */
export function useTestDb(opts: CreateTestDatabaseOptions & { db?: DbOptions } = {}): () => TestDb {
  let current: TestDb | null = null;
  beforeAll(warmUpTestDatabase, 180_000);
  beforeEach(async () => {
    current = await openTestDb(opts);
  }, 60_000);
  afterEach(async () => {
    const t = current;
    current = null;
    await t?.cleanup();
  }, 60_000);
  return () => {
    if (!current) throw new Error("useTestDb のデータベースは試験（it）の中でだけ使える");
    return current;
  };
}
