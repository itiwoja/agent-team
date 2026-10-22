// ワークスペースごとの Durable Object（docs/cloudflare-design.md）。ワークスペースの状態をすべて自分の SQLite に持つ。
// 中の処理は1本の流れで進むので、読んで判断して書く処理は transactionSync の中に書けば、行のロック（Postgres の M-21）は要らない。
// スキーマは作られたとき・起き直したときに blockConcurrencyWhile の中で MIGRATIONS を順に当てる（当てた版は schema_migrations に残す）

import { DurableObject } from "cloudflare:workers";

/** 番号の順に当てる。当てたあとの中身は書き換えない（直すときは新しい番号を足す） */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "init",
    sql: `CREATE TABLE workspace_meta (
            id              INTEGER PRIMARY KEY CHECK (id = 1),
            workspace_id    TEXT    NOT NULL,
            owner_user_id   TEXT    NOT NULL,
            created_at      TEXT    NOT NULL
          )`,
  },
];

export class WorkspaceDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
                version     INTEGER PRIMARY KEY,
                name        TEXT    NOT NULL,
                applied_at  TEXT    NOT NULL
              )`);
    const applied = new Set(sql.exec<{ version: number }>("SELECT version FROM schema_migrations").toArray().map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.ctx.storage.transactionSync(() => {
        sql.exec(m.sql);
        sql.exec("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", m.version, m.name, new Date().toISOString());
      });
    }
  }

  /** 初めてならワークスペースの持ち主を入れる（2回目以降は何もしない。違う持ち主なら例外） */
  init(workspaceId: string, ownerUserId: string): void {
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ workspace_id: string; owner_user_id: string }>("SELECT workspace_id, owner_user_id FROM workspace_meta WHERE id = 1").toArray()[0];
    if (row === undefined) {
      sql.exec("INSERT INTO workspace_meta (id, workspace_id, owner_user_id, created_at) VALUES (1, ?, ?, ?)", workspaceId, ownerUserId, new Date().toISOString());
      return;
    }
    if (row.workspace_id !== workspaceId || row.owner_user_id !== ownerUserId) throw new Error("ワークスペースの持ち主が違う");
  }

  /** 当てたスキーマの版（新しい順の先頭。なければ 0） */
  schemaVersion(): number {
    const row = this.ctx.storage.sql.exec<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations").one();
    return row.v ?? 0;
  }
}
