// 保存の選び方（M-40、SO §3.1.3）：DATABASE_URL があれば Postgres、なければメモリ

import { createDb, type Db, type DbOptions } from "@open-team/db";
import type { SimWorldEnv } from "./env.ts";
import { MemorySimStore } from "./memory-store.ts";
import { PostgresSimStore } from "./postgres-store.ts";
import type { SimStore } from "./store.ts";

export type SimStoreKind = "postgres" | "memory";

export interface OpenedSimStore {
  kind: SimStoreKind;
  store: SimStore;
  /** 接続を閉じる（終わるとき。メモリは何もしない） */
  close(): Promise<void>;
}

/** 接続の既定（SO §4.6：sim-world のプールは2本） */
export const SIM_DB_OPTIONS: DbOptions = { max: 2, applicationName: "sim-world" };

export function openSimStore(
  env: Pick<SimWorldEnv, "databaseUrl">,
  opts: { createDb?: (url: string, options: DbOptions) => Db } = {},
): OpenedSimStore {
  if (env.databaseUrl) {
    const db = (opts.createDb ?? createDb)(env.databaseUrl, SIM_DB_OPTIONS);
    return { kind: "postgres", store: new PostgresSimStore(db), close: () => db.close() };
  }
  return { kind: "memory", store: new MemorySimStore(), close: async () => {} };
}
