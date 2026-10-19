// 保存の選び方（M-40、SO §3.1.3）：DATABASE_URL があれば Postgres（cloud は ot_sim のロール）、なければメモリ（local だけ）。
// cloud でメモリにしない：インスタンスごとに別の状態になり（最大3インスタンス：SO §4.1）、再起動で消える

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

/** 接続の既定（SO §4.6：sim-world のプールは2本。Cloud SQL の接続数を数えた値） */
export const SIM_DB_OPTIONS: DbOptions = { max: 2, applicationName: "sim-world" };

export class SimStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimStoreConfigError";
  }
}

export function openSimStore(
  env: Pick<SimWorldEnv, "deploymentMode" | "databaseUrl">,
  opts: { createDb?: (url: string, options: DbOptions) => Db } = {},
): OpenedSimStore {
  if (env.databaseUrl) {
    const db = (opts.createDb ?? createDb)(env.databaseUrl, SIM_DB_OPTIONS);
    return { kind: "postgres", store: new PostgresSimStore(db), close: () => db.close() };
  }
  if (env.deploymentMode !== "local") {
    // readSimWorldEnv が DATABASE_URL を必須にしているので、ここに来るのは設定の組み立て違いだけ（閉じた側に倒す）
    throw new SimStoreConfigError("cloud は DATABASE_URL（ot_sim）が要る。メモリの保存では起動しない");
  }
  return { kind: "memory", store: new MemorySimStore(), close: async () => {} };
}
