// マイグレーションの実行器（DB §2・I-32）と CLI（pnpm --filter @open-team/db migrate。DATABASE_URL を読む）
// - migrations/NNNN_名前.sql を番号の順に、1ファイル1トランザクションで流す。流したものは public.schema_migrations に残し、2度流さない
// - 同時に流さない：セッションのアドバイザリロック（同じデータベースの中で直列）
// - 流したあとのファイルを書き換えたら止める（チェックサムが違う。新しい番号のファイルで直す）
// - 最後に roles.sql（ロールと GRANT。冪等）を毎回流す。OT_DB_SKIP_ROLES=1 か roles: false で飛ばす

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/** packages/db/migrations の絶対パス */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
export const ROLES_FILE = "roles.sql";

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
/** ファイルの中で BEGIN・COMMIT を書かない（実行器がトランザクションで包む） */
const TX_CONTROL_RE = /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im;

export interface Migration {
  /** '0001' */
  version: string;
  /** 'users_workspaces' */
  name: string;
  file: string;
  sql: string;
  /** 改行を LF にそろえた中身の SHA-256（Windows の checkout で CRLF になっても同じ値） */
  checksum: string;
}

export interface MigrateOptions {
  dir?: string;
  /** roles.sql を流すか。既定は環境変数 OT_DB_SKIP_ROLES が '1'・'true' でなければ流す */
  roles?: boolean;
  log?: (line: string) => void;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
  roles: "applied" | "skipped";
}

export class MigrationChecksumError extends Error {
  readonly version: string;
  constructor(version: string, file: string) {
    super(`流したあとのマイグレーションが書き換えられている：${file}（新しい番号のファイルで直す）`);
    this.name = "MigrationChecksumError";
    this.version = version;
  }
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function checksumOf(text: string): string {
  return createHash("sha256").update(normalize(text), "utf8").digest("hex");
}

/** 番号つきの SQL を読み、番号の順に並べる。名前の形・番号の重なり・BEGIN/COMMIT は例外 */
export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql") && f !== ROLES_FILE).sort();
  const seen = new Set<string>();
  const out: Migration[] = [];
  for (const file of files) {
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`マイグレーションの名前が NNNN_名前.sql ではない：${file}`);
    const version = m[1] as string;
    if (seen.has(version)) throw new Error(`マイグレーションの番号が重なっている：${version}`);
    seen.add(version);
    const sql = normalize(await readFile(join(dir, file), "utf8"));
    if (TX_CONTROL_RE.test(sql)) throw new Error(`マイグレーションに BEGIN / COMMIT を書かない：${file}`);
    out.push({ version, name: m[2] as string, file, sql, checksum: checksumOf(sql) });
  }
  return out;
}

export function rolesEnabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.OT_DB_SKIP_ROLES ?? "").trim().toLowerCase();
  return !(v === "1" || v === "true" || v === "yes");
}

/** url のデータベースにマイグレーションを流す（接続は1本だけ使い、終わったら閉じる） */
export async function runMigrations(url: string, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});
  const withRoles = opts.roles ?? rolesEnabledByEnv();
  const migrations = await loadMigrations(dir);
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    // roles.sql の「ロールを作る権限がないので飛ばす」などを残す
    onnotice: (n) => log(`notice: ${n.message ?? ""}`),
    connect_timeout: 10,
    idle_timeout: 0,
  });
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  let locked = false;
  try {
    await sql`SELECT pg_advisory_lock(hashtext('open-team.migrate'))`;
    locked = true;
    const [table] = await sql<{ t: string | null }[]>`SELECT to_regclass('public.schema_migrations')::text AS t`;
    if (!table?.t) {
      await sql.unsafe(`CREATE TABLE public.schema_migrations (
        version     text        PRIMARY KEY,
        name        text        NOT NULL,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    }
    const done = new Map<string, string>();
    for (const r of await sql<{ version: string; checksum: string }[]>`SELECT version, checksum FROM public.schema_migrations`) {
      done.set(r.version, r.checksum);
    }
    for (const m of migrations) {
      const prev = done.get(m.version);
      if (prev !== undefined) {
        if (prev !== m.checksum) throw new MigrationChecksumError(m.version, m.file);
        alreadyApplied.push(m.version);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`INSERT INTO public.schema_migrations (version, name, checksum) VALUES (${m.version}, ${m.name}, ${m.checksum})`;
      });
      applied.push(m.version);
      log(`applied ${m.file}`);
    }
    let roles: MigrateResult["roles"] = "skipped";
    if (withRoles) {
      const text = normalize(await readFile(join(dir, ROLES_FILE), "utf8"));
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
      });
      roles = "applied";
      log(`applied ${ROLES_FILE}`);
    }
    return { applied, alreadyApplied, roles };
  } finally {
    if (locked) await sql`SELECT pg_advisory_unlock(hashtext('open-team.migrate'))`.catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // 値は出さない（D-47）。名前だけ
    console.error("DATABASE_URL がありません");
    process.exitCode = 2;
    return;
  }
  const r = await runMigrations(url, { log: (line) => console.log(line) });
  console.log(JSON.stringify({ event: "db.migrated", applied: r.applied, alreadyApplied: r.alreadyApplied, roles: r.roles }));
}

if (isMain()) {
  main().catch((e: unknown) => {
    // 接続の URL（パスワード）を出さない：メッセージとコードだけ
    const err = e as { message?: unknown; code?: unknown };
    console.error(JSON.stringify({ event: "db.migrate_failed", message: String(err?.message ?? e), code: err?.code ?? null }));
    process.exitCode = 1;
  });
}
