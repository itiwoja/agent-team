import { describe, expect, it, vi } from "vitest";
import type { Db } from "@open-team/db";
import { MemorySimStore } from "./memory-store.ts";
import { SIM_DB_OPTIONS, openSimStore } from "./open-store.ts";
import { PostgresSimStore } from "./postgres-store.ts";

/** 接続しない偽の Db（close だけ数える） */
function fakeDb() {
  const close = vi.fn(async () => {});
  return { db: { close } as unknown as Db, close };
}

describe("openSimStore（M-40、SO §3.1.3：DATABASE_URL があれば Postgres、なければメモリ）", () => {
  it("DATABASE_URL がなければメモリ（close は何もしない）", async () => {
    const createDb = vi.fn();
    const s = openSimStore({ databaseUrl: undefined }, { createDb });
    expect(s.kind).toBe("memory");
    expect(s.store).toBeInstanceOf(MemorySimStore);
    await s.close();
    expect(createDb).not.toHaveBeenCalled();
  });

  it("DATABASE_URL があれば Postgres。プールは2本・application_name は sim-world、close で接続を閉じる", async () => {
    const { db, close } = fakeDb();
    const createDb = vi.fn(() => db);
    const s = openSimStore({ databaseUrl: "postgres://ot_sim@/open_team" }, { createDb });
    expect(s.kind).toBe("postgres");
    expect(s.store).toBeInstanceOf(PostgresSimStore);
    expect(createDb).toHaveBeenCalledWith("postgres://ot_sim@/open_team", SIM_DB_OPTIONS);
    expect(SIM_DB_OPTIONS).toEqual({ max: 2, applicationName: "sim-world" });
    await s.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
