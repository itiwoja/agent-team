// 試験用のデータベースを作る（@open-team/db/testing から出す。vitest に頼らない部分）。
// - TEST_DATABASE_URL があれば、そのサーバー（データベースを作れる利用者）を使う（CI のサービスのコンテナなど）
// - なければ docker で postgres:16（compose.yaml と同じ digest）のコンテナ ot-db-test を1つ起動して使い回す
//   （データは tmpfs・fsync off。止めるときは `docker rm -f ot-db-test`。プロセスやパッケージをまたいで共有する）
// - マイグレーションを流した型紙のデータベース（マイグレーションの中身のハッシュで名前を付ける）を1回だけ作り、
//   呼ぶたびにそこから CREATE DATABASE … TEMPLATE で写す（毎回マイグレーションを流すより速い。中身は同じ）

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { createDb, type Db, type DbOptions } from "./client.ts";
import { checksumOf, loadMigrations, MIGRATIONS_DIR, ROLES_FILE, runMigrations } from "./migrate.ts";

const execFileAsync = promisify(execFile);

export const TEST_CONTAINER_NAME = "ot-db-test";
/** compose.yaml が読めないときの既定（compose.yaml の db.image と同じ） */
const FALLBACK_IMAGE = "postgres:16.15-bookworm@sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67";
const COMPOSE_FILE = new URL("../../../compose.yaml", import.meta.url);
const CONTAINER_PASSWORD = "postgres";
/** 型紙の作り方を変えたら上げる（名前が変わり、古い型紙は消える） */
const TEMPLATE_FORMAT = "1";

export interface TestDatabase {
  /** postgres://…/ot_test_<乱数> */
  readonly url: string;
  readonly name: string;
  /** データベースを消す（つないだままの接続も切る） */
  drop(): Promise<void>;
}

export interface TestDb extends TestDatabase {
  readonly db: Db;
  /** db を閉じてからデータベースを消す */
  cleanup(): Promise<void>;
}

export interface CreateTestDatabaseOptions {
  /** false なら空のデータベース（マイグレーションの試験用）。既定 true */
  migrate?: boolean;
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`データベースの名前に使えない文字：${name}`);
  return `"${name}"`;
}

/** 同じサーバーの別のデータベースの URL */
export function databaseUrl(serverUrl: string, database: string): string {
  const u = new URL(serverUrl);
  u.pathname = `/${database}`;
  return u.toString();
}

async function composeImage(): Promise<string> {
  try {
    const text = await readFile(COMPOSE_FILE, "utf8");
    const m = /^\s*image:\s*(postgres:\S+@sha256:[0-9a-f]{64})\s*$/m.exec(text);
    if (m?.[1]) return m[1];
  } catch {
    // compose.yaml がない（パッケージだけ写した場合など）は既定
  }
  return FALLBACK_IMAGE;
}

async function docker(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", args, { timeout: 180_000 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: unknown };
    if (err.code === "ENOENT") {
      throw new Error("docker が見つからない。TEST_DATABASE_URL に試験用の PostgreSQL 16 の URL を入れるか、docker を入れる");
    }
    throw new Error(`docker ${args[0]} が失敗：${(err.stderr ?? err.message ?? "").trim()}`);
  }
}

async function inspectContainer(): Promise<{ running: boolean; image: string } | null> {
  try {
    const out = await docker(["inspect", "--format", "{{.State.Running}} {{.Config.Image}}", TEST_CONTAINER_NAME]);
    const [running, image] = out.trim().split(" ");
    return { running: running === "true", image: image ?? "" };
  } catch {
    return null;
  }
}

async function runContainer(image: string): Promise<void> {
  try {
    await docker([
      "run",
      "-d",
      "--name",
      TEST_CONTAINER_NAME,
      "--label",
      "open-team.test-db=1",
      "-e",
      `POSTGRES_PASSWORD=${CONTAINER_PASSWORD}`,
      "-p",
      "127.0.0.1::5432",
      "--shm-size=256m",
      "--tmpfs",
      "/var/lib/postgresql/data:rw",
      image,
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "max_connections=300",
    ]);
  } catch (e) {
    // 別のプロセスが同時に作った（名前が重なる）ならそれを使う
    if (!/already in use|Conflict/i.test(String((e as Error).message))) throw e;
  }
}

async function waitReady(url: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < timeoutMs) {
    const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {}, idle_timeout: 1 });
    try {
      await sql`SELECT 1`;
      return;
    } catch (e) {
      lastError = e;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`試験用の PostgreSQL が起動しない：${String((lastError as Error | null)?.message ?? lastError)}`);
}

async function startDockerServer(): Promise<string> {
  const image = await composeImage();
  let info = await inspectContainer();
  if (info && info.image !== image) {
    // compose.yaml の digest が変わった：作り直す
    await docker(["rm", "-f", TEST_CONTAINER_NAME]).catch(() => "");
    info = null;
  }
  if (!info) {
    await runContainer(image);
  } else if (!info.running) {
    await docker(["start", TEST_CONTAINER_NAME]).catch(() => "");
  }
  let port = "";
  for (let i = 0; i < 50 && !port; i++) {
    const out = await docker(["port", TEST_CONTAINER_NAME, "5432/tcp"]).catch(() => "");
    const line = out.split("\n").find((l) => l.startsWith("127.0.0.1:"));
    port = line ? line.slice("127.0.0.1:".length).trim() : "";
    if (!port) await new Promise((r) => setTimeout(r, 200));
  }
  if (!port) throw new Error("試験用のコンテナのポートが分からない");
  const url = `postgres://postgres:${CONTAINER_PASSWORD}@127.0.0.1:${port}/postgres`;
  await waitReady(url);
  return url;
}

let serverUrlPromise: Promise<string> | null = null;

/** 試験用のサーバーの URL（データベースを作れる利用者・保守用のデータベース）。プロセスの中で1回だけ準備する */
export function testServerUrl(): Promise<string> {
  if (!serverUrlPromise) {
    const fromEnv = process.env.TEST_DATABASE_URL;
    serverUrlPromise = fromEnv ? waitReady(fromEnv).then(() => fromEnv) : startDockerServer();
    serverUrlPromise.catch(() => {
      serverUrlPromise = null;
    });
  }
  return serverUrlPromise;
}

let admin: postgres.Sql | null = null;
function adminSql(serverUrl: string): postgres.Sql {
  if (!admin) admin = postgres(serverUrl, { max: 2, idle_timeout: 2, connect_timeout: 10, onnotice: () => {} });
  return admin;
}

async function templateName(): Promise<string> {
  const h = createHash("sha256").update(`format:${TEMPLATE_FORMAT}\n`);
  for (const m of await loadMigrations()) h.update(`${m.file}:${m.checksum}\n`);
  h.update(`${ROLES_FILE}:${checksumOf(await readFile(join(MIGRATIONS_DIR, ROLES_FILE), "utf8"))}\n`);
  return `ot_tpl_${h.digest("hex").slice(0, 16)}`;
}

async function terminateConnections(sql: postgres.Sql, database: string): Promise<void> {
  await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${database} AND pid <> pg_backend_pid()`;
}

/** 型紙を（なければ）作る。サーバー全体で直列にする（保守用のデータベースのアドバイザリロック） */
async function ensureTemplate(serverUrl: string): Promise<string> {
  const tpl = await templateName();
  const sql = postgres(serverUrl, { max: 1, idle_timeout: 0, connect_timeout: 10, onnotice: () => {} });
  try {
    await sql`SELECT pg_advisory_lock(hashtext('open-team.test-template'))`;
    try {
      const exists = await sql`SELECT 1 FROM pg_database WHERE datname = ${tpl}`;
      if (exists.length > 0) return tpl;
      // 古い版の型紙と、作りかけで残ったものを消す
      const old = await sql<{ datname: string }[]>`
        SELECT datname FROM pg_database WHERE datname LIKE 'ot\_tpl\_%' OR datname LIKE 'ot\_tplbuild\_%'`;
      for (const r of old) {
        await sql.unsafe(`ALTER DATABASE ${quoteIdent(r.datname)} IS_TEMPLATE false`);
        await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(r.datname)} WITH (FORCE)`);
      }
      const build = `ot_tplbuild_${randomBytes(6).toString("hex")}`;
      await sql.unsafe(`CREATE DATABASE ${quoteIdent(build)}`);
      await runMigrations(databaseUrl(serverUrl, build));
      await terminateConnections(sql, build);
      await sql.unsafe(`ALTER DATABASE ${quoteIdent(build)} RENAME TO ${quoteIdent(tpl)}`);
      await sql.unsafe(`ALTER DATABASE ${quoteIdent(tpl)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
      return tpl;
    } finally {
      await sql`SELECT pg_advisory_unlock(hashtext('open-team.test-template'))`.catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

let templatePromise: Promise<string> | null = null;

/** 新しいデータベースを作る（既定はマイグレーション済み）。終わったら drop() を呼ぶ */
export async function createTestDatabase(opts: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const serverUrl = await testServerUrl();
  const sql = adminSql(serverUrl);
  const name = `ot_test_${randomBytes(8).toString("hex")}`;
  if (opts.migrate === false) {
    await sql.unsafe(`CREATE DATABASE ${quoteIdent(name)}`);
  } else {
    if (!templatePromise) {
      templatePromise = ensureTemplate(serverUrl);
      templatePromise.catch(() => {
        templatePromise = null;
      });
    }
    const tpl = await templatePromise;
    await sql.unsafe(`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(tpl)}`);
  }
  return {
    url: databaseUrl(serverUrl, name),
    name,
    async drop() {
      await sql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    },
  };
}

/** 新しいデータベースと、それにつないだ Db（既定 max 4）。cleanup() で閉じて消す */
export async function openTestDb(opts: CreateTestDatabaseOptions & { db?: DbOptions } = {}): Promise<TestDb> {
  const t = await createTestDatabase(opts);
  const db = createDb(t.url, { max: 4, idleTimeoutSec: 5, applicationName: "open-team-test", ...opts.db });
  return {
    db,
    url: t.url,
    name: t.name,
    drop: t.drop,
    async cleanup() {
      await db.close({ timeoutSec: 2 }).catch(() => {});
      await t.drop();
    },
  };
}

export type AppRole = "ot_app" | "ot_gateway" | "ot_sim" | "ot_retention";
const TEST_LOGIN_PASSWORD = "ot-test-login";

/**
 * そのロールの権限でつないだ Db（権限の試験用）。ロール（NOLOGIN）のメンバーのログイン用の利用者 <role>_test_login を
 * サーバーに（なければ）作ってつなぐ。試験用のサーバーでだけ使う（ロールはクラスタ全体で共有）
 */
export async function openRoleDb(url: string, role: AppRole, opts: DbOptions = {}): Promise<Db> {
  const serverUrl = await testServerUrl();
  const login = `${role}_test_login`;
  await adminSql(serverUrl).unsafe(
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN
         CREATE ROLE ${login} LOGIN PASSWORD '${TEST_LOGIN_PASSWORD}' IN ROLE ${role};
       END IF;
     EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
     END $$`,
  );
  const u = new URL(url);
  u.username = login;
  u.password = TEST_LOGIN_PASSWORD;
  return createDb(u.toString(), { max: 2, idleTimeoutSec: 5, applicationName: `open-team-test-${role}`, ...opts });
}

/** 試験用のサーバーと型紙を用意する（最初の1回だけコンテナの起動・マイグレーションで数秒〜数十秒かかる） */
export async function warmUpTestDatabase(): Promise<void> {
  const t = await createTestDatabase();
  await t.drop();
}
