// マイグレーションの試験：2度流しても変わらない・書き換えの検出・同時に流す・全表の workspace_id（CASCADE）
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, type Queryable } from "./client.ts";
import { checksumOf, loadMigrations, MIGRATIONS_DIR, MigrationChecksumError, rolesEnabledByEnv, runMigrations } from "./migrate.ts";
import { createTestDatabase, useTestDb } from "./testing.ts";
import { WORKSPACE_TABLES } from "./types.ts";

const T = useTestDb({ migrate: false });

/** スキーマの写し（列・制約・索引・トリガー・権限） */
async function schemaDump(q: Queryable): Promise<unknown> {
  const cols = await q.query(
    `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, is_generated
       FROM information_schema.columns WHERE table_schema IN ('public','sim') ORDER BY 1, 2, ordinal_position`,
  );
  const cons = await q.query(
    `SELECT n.nspname, c.conrelid::regclass::text AS rel, c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname IN ('public','sim') ORDER BY 1, 2, 3`,
  );
  const idx = await q.query("SELECT schemaname, indexname, indexdef FROM pg_indexes WHERE schemaname IN ('public','sim') ORDER BY 1, 2");
  const trg = await q.query(
    `SELECT event_object_schema, event_object_table, trigger_name, event_manipulation, action_timing
       FROM information_schema.triggers WHERE trigger_schema IN ('public','sim') ORDER BY 1, 2, 3, 4`,
  );
  const acl = await q.query(
    `SELECT n.nspname, c.relname, c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public','sim') AND c.relkind = 'r' ORDER BY 1, 2`,
  );
  return { cols: cols.rows, cons: cons.rows, idx: idx.rows, trg: trg.rows, acl: acl.rows };
}

describe("マイグレーションの実行器", () => {
  it("空のデータベースにファイルの番号の順で全部流し、2度目は何もしない（スキーマ・権限が変わらない）", async () => {
    const { db, url } = T();
    // 番号の飛びは正しい（0006 などを欠いても流れる）。期待値はディレクトリから読む
    const all = await loadMigrations(MIGRATIONS_DIR);
    const versions = all.map((m) => m.version);
    const first = await runMigrations(url);
    expect(first.applied).toEqual(versions);
    expect(first.alreadyApplied).toEqual([]);
    const before = await schemaDump(db);
    const second = await runMigrations(url);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(versions);
    expect(await schemaDump(db)).toEqual(before);
    const rows = await db.query<{ version: string; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version");
    expect(rows.rows).toEqual(all.map((m) => ({ version: m.version, name: m.name })));
  });

  it("流したあとのファイルが書き換えられていたら止める（MigrationChecksumError。新しい番号で直す）", async () => {
    const { db, url } = T();
    await runMigrations(url);
    await db.query("UPDATE schema_migrations SET checksum = 'changed' WHERE version = '0002'");
    await expect(runMigrations(url)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it("同時に2つ流しても1回だけ流れる（アドバイザリロック）", async () => {
    const { db, url } = T();
    const [a, b] = await Promise.all([runMigrations(url), runMigrations(url)]);
    expect([...a.applied, ...b.applied].sort()).toEqual((await loadMigrations(MIGRATIONS_DIR)).map((m) => m.version));
    const n = await db.query<{ n: number }>("SELECT count(*) AS n FROM schema_migrations");
    expect(n.rows[0]?.n).toBe((await loadMigrations(MIGRATIONS_DIR)).length);
  });

  it("途中で失敗したファイルは丸ごと戻り、記録も残らない", async () => {
    const { db, url } = T();
    const dir = await mkdtemp(join(tmpdir(), "ot-migrate-"));
    try {
      await writeFile(join(dir, "0001_ok.sql"), "CREATE TABLE t_ok (id int);\n");
      await writeFile(join(dir, "0002_broken.sql"), "CREATE TABLE t_half (id int);\nSELECT * FROM no_such_table;\n");
      await writeFile(join(dir, "roles.sql"), "SELECT 1;\n");
      await expect(runMigrations(url, { dir })).rejects.toThrow();
      const tables = await db.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_name LIKE 't\\_%' ORDER BY 1");
      expect(tables.rows.map((r) => r.t)).toEqual(["t_ok"]);
      const v = await db.query<{ version: string }>("SELECT version FROM schema_migrations");
      expect(v.rows.map((r) => r.version)).toEqual(["0001"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("名前の形が違う・番号が重なる・BEGIN を書いたファイルは読まない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ot-migrate-"));
    try {
      await writeFile(join(dir, "1_bad.sql"), "SELECT 1;");
      await expect(loadMigrations(dir)).rejects.toThrow(/NNNN_名前/);
      await rm(join(dir, "1_bad.sql"));
      await writeFile(join(dir, "0001_a.sql"), "SELECT 1;");
      await writeFile(join(dir, "0001_b.sql"), "SELECT 1;");
      await expect(loadMigrations(dir)).rejects.toThrow(/重なっている/);
      await rm(join(dir, "0001_b.sql"));
      await writeFile(join(dir, "0002_tx.sql"), "BEGIN;\nSELECT 1;\nCOMMIT;\n");
      await expect(loadMigrations(dir)).rejects.toThrow(/BEGIN/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("チェックサムは改行を LF にそろえてから計算する（Windows の checkout でも同じ）", () => {
    expect(checksumOf("a\r\nb\r\n")).toBe(checksumOf("a\nb\n"));
    expect(checksumOf("a\nb")).not.toBe(checksumOf("a\nc"));
  });

  it("roles: false・OT_DB_SKIP_ROLES=1 でロールの SQL を飛ばす", async () => {
    const { url } = T();
    expect((await runMigrations(url, { roles: false })).roles).toBe("skipped");
    expect((await runMigrations(url, { roles: true })).roles).toBe("applied");
    expect(rolesEnabledByEnv({ OT_DB_SKIP_ROLES: "1" })).toBe(false);
    expect(rolesEnabledByEnv({ OT_DB_SKIP_ROLES: "true" })).toBe(false);
    expect(rolesEnabledByEnv({})).toBe(true);
  });
});

describe("スキーマの形（DB §2・15:368・15:384）", () => {
  // 以下はマイグレーション済みのデータベースで見る
  async function migrated(): Promise<{ q: Queryable; close: () => Promise<void> }> {
    const t = await createTestDatabase();
    const db = createDb(t.url, { max: 1 });
    return {
      q: db,
      close: async () => {
        await db.close();
        await t.drop();
      },
    };
  }

  it("users・entry_attempts 以外の全表に workspace_id NOT NULL と workspaces への ON DELETE CASCADE がある", async () => {
    const { q, close } = await migrated();
    try {
      const tables = await q.query<{ name: string }>(
        `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN ('public','sim') AND c.relkind = 'r'
            AND c.relname NOT IN ('users','workspaces','entry_attempts','schema_migrations') ORDER BY 1`,
      );
      const expected = WORKSPACE_TABLES.map((t) => (t.includes(".") ? t : `public.${t}`)).sort();
      expect(tables.rows.map((r) => r.name)).toEqual(expected);
      const fk = await q.query<{ name: string; nullable: string }>(
        `SELECT n.nspname || '.' || c.relname AS name, col.is_nullable AS nullable
           FROM pg_constraint k
           JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
           JOIN information_schema.columns col ON col.table_schema = n.nspname AND col.table_name = c.relname AND col.column_name = 'workspace_id'
          WHERE k.contype = 'f' AND k.confrelid = 'public.workspaces'::regclass AND cardinality(k.conkey) = 1
            AND a.attname = 'workspace_id' AND k.confdeltype = 'c'
          ORDER BY 1`,
      );
      expect(fk.rows.map((r) => r.name)).toEqual(expected);
      expect(fk.rows.every((r) => r.nullable === "NO")).toBe(true);
      // entry_attempts はワークスペースが消えても数え続ける（SET NULL）
      const ea = await q.query<{ t: string }>(
        `SELECT confdeltype::text AS t FROM pg_constraint WHERE conrelid = 'entry_attempts'::regclass AND contype = 'f'`,
      );
      expect(ea.rows).toEqual([{ t: "n" }]);
    } finally {
      await close();
    }
  });

  it("ワークスペースの中どうしの FK はすべて workspace_id を含む複合 FK（別のワークスペースの行を指せない：DB I-41）", async () => {
    const { q, close } = await migrated();
    try {
      const bad = await q.query<{ conname: string }>(
        `SELECT k.conname
           FROM pg_constraint k
          WHERE k.contype = 'f'
            AND k.confrelid <> 'public.workspaces'::regclass AND k.confrelid <> 'public.users'::regclass
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.conrelid AND a.attname = 'workspace_id')
            AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.conrelid AND a.attname = 'workspace_id' AND a.attnum = ANY(k.conkey))
            AND k.conname <> 'sessions_membership_fk'
          ORDER BY 1`,
      );
      expect(bad.rows).toEqual([]);
      // sessions は (workspace_id, user_id) で memberships を指す
      const s = await q.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'sessions_membership_fk'");
      expect(s.rows[0]?.def).toContain("(workspace_id, user_id)");
    } finally {
      await close();
    }
  });

  it("ロール ot_app・ot_gateway・ot_sim・ot_retention がある（作れる利用者で流したとき）", async () => {
    const { q, close } = await migrated();
    try {
      const r = await q.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname IN ('ot_app','ot_gateway','ot_sim','ot_retention') ORDER BY 1",
      );
      expect(r.rows.map((x) => x.rolname)).toEqual(["ot_app", "ot_gateway", "ot_retention", "ot_sim"]);
    } finally {
      await close();
    }
  });
});
