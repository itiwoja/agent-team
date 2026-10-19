// DB の接続（postgres.js を包む）。業務のコードは Db・Tx・Queryable だけを使い、postgres.js を直接 import しない。
// 決まり（README・DB §4.1、G-14）：トランザクションの中で外部（Gemini・gateway・sim-world）を呼ばない。
// 値の変換：timestamptz → Date、numeric → 文字列（USD は小数6桁の文字列）、int8 → number（安全な整数を超えたら例外：DB I-34）、
// bytea → Buffer、jsonb → 値、配列 → 配列。jsonb の引数には JS の値をそのまま渡す（JSON.stringify した文字列を渡すと文字列が入る）

import postgres from "postgres";

export type Row = Record<string, unknown>;

export interface QueryResult<R> {
  rows: R[];
  /** INSERT・UPDATE・DELETE は変わった行の数、SELECT は返した行の数 */
  rowCount: number;
}

/** 1つの文を $1, $2… の引数つきで流せるもの（接続のプールでもトランザクションでもよい） */
export interface Queryable {
  query<R extends object = Row>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

/** BEGIN〜COMMIT の中だけで使う接続（DB §10）。業務の変更と監査ログの追記は同じ Tx で行う */
export interface Tx extends Queryable {
  readonly inTransaction: true;
  /** SAVEPOINT（中で例外が出たらそこまで戻して投げ直す） */
  savepoint<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  isolation?: IsolationLevel;
  readOnly?: boolean;
  /**
   * 40P01（デッドロック）・40001（直列化の失敗）なら1回だけやり直す（SO §3.14 の提案）。
   * fn は DB だけを触ること（G-14）。2回目も失敗したらその例外を投げる
   */
  retryOnce?: boolean;
}

export interface Listener {
  unlisten(): Promise<void>;
}

export interface Db extends Queryable {
  readonly inTransaction: false;
  transaction<T>(fn: (tx: Tx) => Promise<T>, opts?: TransactionOptions): Promise<T>;
  /** LISTEN（専用の接続を1本使う。Kill Switch・SSE：SO §3.15、AS §3.14） */
  listen(channel: string, onNotify: (payload: string) => void): Promise<Listener>;
  notify(channel: string, payload: string): Promise<void>;
  close(opts?: { timeoutSec?: number }): Promise<void>;
}

export interface DbOptions {
  /** 接続の本数の上限。既定 2（SO §4.6：app・gateway・sim-world のプールは各2） */
  max?: number;
  applicationName?: string;
  /** 既定 10 秒 */
  connectTimeoutSec?: number;
  /** 使っていない接続を閉じるまでの秒数。既定 60 秒 */
  idleTimeoutSec?: number;
  /** 名前つきの準備済みの文を使うか。既定 true */
  prepare?: boolean;
  /** NOTICE を受けたとき（既定は捨てる） */
  onNotice?: (notice: Record<string, string>) => void;
}

const INT8_OID = 20;

/** int8 を number にする。2^53 を超える値は精度が落ちるので例外（シードは uint32、金額の円は 2^53 未満：DB I-34） */
export function parseInt8(text: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 の値が安全な整数の範囲を超えた：${text}`);
  return n;
}

type AnySql = postgres.Sql<Record<string, unknown>> | postgres.TransactionSql<Record<string, unknown>>;
type UnsafeParams = Parameters<postgres.Sql["unsafe"]>[1];

function makeQuery(sql: AnySql, prepare: boolean): Queryable["query"] {
  return async function query<R extends object = Row>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    // simple: false で常に拡張プロトコルを使う（1回に1つの文だけ。引数なしでも複数の文を流せないようにする）
    const options = { prepare, simple: false } as { prepare: boolean };
    const result = await sql.unsafe(text, params as UnsafeParams, options);
    const rows = Array.from(result) as unknown as R[];
    return { rows, rowCount: typeof result.count === "number" ? result.count : rows.length };
  };
}

function makeTx(sql: postgres.TransactionSql<Record<string, unknown>>, prepare: boolean): Tx {
  return {
    inTransaction: true,
    query: makeQuery(sql, prepare),
    savepoint<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return sql.savepoint((inner) => fn(makeTx(inner, prepare))) as Promise<T>;
    },
  };
}

function beginOptions(opts: TransactionOptions): string {
  const parts: string[] = [];
  if (opts.isolation) parts.push(`isolation level ${opts.isolation}`);
  if (opts.readOnly) parts.push("read only");
  return parts.join(" ");
}

/** やり直してよい失敗か（デッドロック・直列化の失敗） */
export function isRetryableTxError(e: unknown): boolean {
  const code = pgErrorInfo(e)?.code;
  return code === PG_ERROR.deadlockDetected || code === PG_ERROR.serializationFailure;
}

/**
 * Cloud SQL の unix ソケット（postgres://user:pass@localhost/db?host=/cloudsql/<接続名>）の host を取り出す。
 * postgres.js は URL の ?host= を読まないので、オプションで渡す。ソケットでなければ undefined
 */
export function socketHostOf(url: string): string | undefined {
  try {
    const h = new URL(url).searchParams.get("host");
    return h !== null && h.startsWith("/") ? h : undefined;
  } catch {
    return undefined;
  }
}

export function withoutHostParam(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("host");
  return u.toString();
}

/** 接続を作る（プールは遅延で開く）。url は postgres://user:pass@host:port/db（?sslmode=… も可。Cloud SQL は ?host=/cloudsql/… のソケット） */
export function createDb(url: string, opts: DbOptions = {}): Db {
  const prepare = opts.prepare ?? true;
  const socketHost = socketHostOf(url);
  // ?host= を残すと postgres.js が接続の設定パラメータとして送り、サーバーに "unrecognized configuration parameter host" と拒まれる
  const sql = postgres(socketHost ? withoutHostParam(url) : url, {
    ...(socketHost ? { host: socketHost } : {}),
    max: opts.max ?? 2,
    connect_timeout: opts.connectTimeoutSec ?? 10,
    idle_timeout: opts.idleTimeoutSec ?? 60,
    prepare,
    onnotice: opts.onNotice ?? (() => {}),
    connection: { application_name: opts.applicationName ?? "open-team" },
    types: {
      int8: { to: INT8_OID, from: [INT8_OID], serialize: (x: unknown) => String(x), parse: parseInt8 },
    },
  }) as unknown as postgres.Sql<Record<string, unknown>>;

  const runTx = <T>(fn: (tx: Tx) => Promise<T>, opts: TransactionOptions): Promise<T> => {
    const begin = beginOptions(opts);
    const body = (tsql: postgres.TransactionSql<Record<string, unknown>>) => fn(makeTx(tsql, prepare));
    return (begin ? sql.begin(begin, body) : sql.begin(body)) as Promise<T>;
  };

  return {
    inTransaction: false,
    query: makeQuery(sql, prepare),
    async transaction<T>(fn: (tx: Tx) => Promise<T>, txOpts: TransactionOptions = {}): Promise<T> {
      try {
        return await runTx(fn, txOpts);
      } catch (e) {
        if (txOpts.retryOnce && isRetryableTxError(e)) return await runTx(fn, txOpts);
        throw e;
      }
    },
    async listen(channel: string, onNotify: (payload: string) => void): Promise<Listener> {
      const meta = await sql.listen(channel, onNotify);
      return { unlisten: () => meta.unlisten() };
    },
    async notify(channel: string, payload: string): Promise<void> {
      await sql.notify(channel, payload);
    },
    async close(closeOpts: { timeoutSec?: number } = {}): Promise<void> {
      await sql.end({ timeout: closeOpts.timeoutSec ?? 5 });
    },
  };
}

/** Db ならトランザクションを開き、すでに Tx ならその中でそのまま動かす */
export function withTransaction<T>(q: Db | Tx, fn: (tx: Tx) => Promise<T>, opts?: TransactionOptions): Promise<T> {
  return q.inTransaction ? fn(q) : q.transaction(fn, opts);
}

// ---- PostgreSQL のエラー ----

/** よく使う SQLSTATE */
export const PG_ERROR = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  notNullViolation: "23502",
  /** RAISE EXCEPTION（監査ログ・スナップショットの守りのトリガー） */
  raiseException: "P0001",
  insufficientPrivilege: "42501",
  deadlockDetected: "40P01",
  serializationFailure: "40001",
  lockNotAvailable: "55P03",
  inFailedTransaction: "25P02",
} as const;

export interface PgErrorInfo {
  code: string;
  message: string;
  constraint: string | null;
  table: string | null;
  column: string | null;
  detail: string | null;
}

/** PostgreSQL のエラーなら要点を返す（postgres.js の PostgresError。別の版の写しでも名前で見分ける） */
export function pgErrorInfo(e: unknown): PgErrorInfo | null {
  if (typeof e !== "object" || e === null) return null;
  const x = e as Record<string, unknown>;
  if (x.name !== "PostgresError" || typeof x.code !== "string") return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    code: x.code,
    message: typeof x.message === "string" ? x.message : "",
    constraint: str(x.constraint_name),
    table: str(x.table_name),
    column: str(x.column_name),
    detail: str(x.detail),
  };
}

function isViolation(e: unknown, code: string, constraint?: string): boolean {
  const info = pgErrorInfo(e);
  if (!info || info.code !== code) return false;
  return constraint === undefined || info.constraint === constraint;
}

/** 一意の違反（constraint を渡すとその制約・索引の名前だけ） */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  return isViolation(e, PG_ERROR.uniqueViolation, constraint);
}
export function isForeignKeyViolation(e: unknown, constraint?: string): boolean {
  return isViolation(e, PG_ERROR.foreignKeyViolation, constraint);
}
export function isCheckViolation(e: unknown, constraint?: string): boolean {
  return isViolation(e, PG_ERROR.checkViolation, constraint);
}
