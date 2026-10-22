// ワークスペースごとの Durable Object（docs/cloudflare-design.md）。ワークスペースの状態をすべて自分の SQLite に持つ。
// 中の処理は1本の流れで進むので、読んで判断して書く処理は db.transaction の中に書けば、行のロック（Postgres の M-21）は要らない。
// スキーマ（db/schema.ts）は作られたとき・起き直したときに blockConcurrencyWhile の中で MIGRATIONS を順に当てる（当てた版は schema_migrations に残す）。
// 表の読み書きは db/repo/*.ts の同期の関数（WsDb を受け取る）。画面の表示用ビューは views/*（RPC で返す。JSON にできる素の値で、時刻は ISO の文字列）

import { DurableObject } from "cloudflare:workers";
import { MIGRATIONS } from "./db/schema.ts";
import { wsDbOf, type WsDb } from "./db/sqlite.ts";
import { initWorkspace } from "./db/workspace.ts";
import type { AgentLibraryResponse } from "./views/agents/contract.ts";
import { buildAgentLibrary } from "./views/agents/view.ts";
import type { AskDetailResponse, AskStatus, ListAskMessagesResponse, ListAsksResponse } from "./views/asks/contract.ts";
import { buildAskDetail, listAskSummaries, listMessages } from "./views/asks/view.ts";

export { MIGRATIONS };

export class WorkspaceDO extends DurableObject<Env> {
  private readonly db: WsDb;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = wsDbOf(ctx.storage);
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
    initWorkspace(this.db, { workspaceId, ownerUserId, now: new Date() });
  }

  /** 当てたスキーマの版（新しい順の先頭。なければ 0） */
  schemaVersion(): number {
    const row = this.ctx.storage.sql.exec<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations").one();
    return row.v ?? 0;
  }

  // ---- 画面の表示用ビュー（読むだけ。GET /api/v1/*） ----

  /** エージェントの一覧（GET /agents） */
  agentLibrary(): AgentLibraryResponse {
    return buildAgentLibrary(this.db, new Date());
  }

  /** 入口（SCR-020）の依頼の一覧（GET /asks） */
  listAsks(o: { limit: number; status?: AskStatus }): ListAsksResponse {
    return listAskSummaries(this.db, o);
  }

  /** 依頼のページ（API-075）。依頼がなければ null */
  askDetail(askId: string): AskDetailResponse | null {
    return buildAskDetail(this.db, askId, new Date());
  }

  /** 連絡板（API-076）。依頼がなければ null */
  askMessages(askId: string): ListAskMessagesResponse | null {
    return listMessages(this.db, askId);
  }
}
