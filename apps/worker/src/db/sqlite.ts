// WorkspaceDO の SQLite を読み書きする小さな道具（packages/db の client.ts の代わり）。DO の中は1本の流れなので、すべて同期。
// - 引数：Date → ISO 8601、真偽 → 0/1、Uint8Array → BLOB、配列・オブジェクト → JSON の文字列。undefined は渡せない
// - 戻り値：codec（codecs.ts）に書いた列だけ Date・真偽・JSON の値・Buffer に戻す
// - 読んで判断して書く処理は db.transaction(() => …) の中に書く（中で例外が出ればまとめて戻る。入れ子は savepoint）

import { Buffer } from "node:buffer";

export type ColumnKind = "date" | "bool" | "json" | "blob";
export type Codec = Readonly<Record<string, ColumnKind>>;

export type Param = string | number | boolean | null | Date | Uint8Array | ArrayBuffer | readonly unknown[] | { readonly [k: string]: unknown };

export interface WsDb {
  readonly sql: SqlStorage;
  /** 同期のトランザクション（ctx.storage.transactionSync）。fn が投げたらすべて戻す */
  transaction<T>(fn: () => T): T;
}

export function wsDbOf(storage: DurableObjectStorage): WsDb {
  return { sql: storage.sql, transaction: (fn) => storage.transactionSync(fn) };
}

export function newId(): string {
  return crypto.randomUUID();
}

function encode(v: Param, i: number): SqlStorageValue {
  if (v === null || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`${i + 1}番目の引数が有限の数でない`);
    return v;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError(`${i + 1}番目の引数が正しい Date でない`);
    return v.toISOString();
  }
  if (v instanceof ArrayBuffer) return v;
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  if (typeof v === "object") return JSON.stringify(v);
  throw new TypeError(`${i + 1}番目の引数を SQLite に渡せない（${typeof v}）`);
}

function encodeAll(params: readonly Param[]): SqlStorageValue[] {
  return params.map((p, i) => {
    if (p === undefined) throw new TypeError(`${i + 1}番目の引数が undefined`);
    return encode(p, i);
  });
}

function decode<T>(row: Record<string, SqlStorageValue>, codec: Codec): T {
  const out: Record<string, unknown> = { ...row };
  for (const [col, kind] of Object.entries(codec)) {
    const v = row[col];
    if (v === undefined || v === null) continue;
    switch (kind) {
      case "date":
        out[col] = new Date(v as string);
        break;
      case "bool":
        out[col] = v === 1;
        break;
      case "json":
        out[col] = JSON.parse(v as string);
        break;
      case "blob":
        out[col] = Buffer.from(v as ArrayBuffer);
        break;
    }
  }
  return out as T;
}

/** 全部の行 */
export function all<T>(db: WsDb, codec: Codec, query: string, ...params: Param[]): T[] {
  return db.sql
    .exec<Record<string, SqlStorageValue>>(query, ...encodeAll(params))
    .toArray()
    .map((r) => decode<T>(r, codec));
}

/** 先頭の1行（なければ null） */
export function one<T>(db: WsDb, codec: Codec, query: string, ...params: Param[]): T | null {
  const rows = all<T>(db, codec, query, ...params);
  return rows[0] ?? null;
}

/** 書くだけの文。変わった行の数を返す */
export function run(db: WsDb, query: string, ...params: Param[]): number {
  db.sql.exec(query, ...encodeAll(params));
  return db.sql.exec<{ n: number }>("SELECT changes() AS n").one().n;
}

/** 1つの数（count(*) など）。行がなければ 0 */
export function count(db: WsDb, query: string, ...params: Param[]): number {
  const row = db.sql.exec<Record<string, SqlStorageValue>>(query, ...encodeAll(params)).toArray()[0];
  if (!row) return 0;
  const v = Object.values(row)[0];
  return typeof v === "number" ? v : 0;
}

// ===== 制約の違反の見分け =====
// SQLite のメッセージ：'UNIQUE constraint failed: agents.name: SQLITE_CONSTRAINT …'・'CHECK constraint failed: <制約の名前>: …'

function constraintTarget(e: unknown, kind: "UNIQUE" | "CHECK" | "FOREIGN KEY"): string | null {
  if (!(e instanceof Error)) return null;
  const prefix = `${kind} constraint failed`;
  const at = e.message.indexOf(prefix);
  if (at < 0) return null;
  const rest = e.message.slice(at + prefix.length);
  if (!rest.startsWith(": ")) return "";
  const end = rest.indexOf(": SQLITE_");
  return (end < 0 ? rest.slice(2) : rest.slice(2, end)).trim();
}

/** 一意の違反か。target は '表.列'（複数の列は '表.列1, 表.列2'）。省くと何でも */
export function isUniqueViolation(e: unknown, target?: string): boolean {
  const t = constraintTarget(e, "UNIQUE");
  return t !== null && (target === undefined || t === target);
}

/** CHECK の違反か。name は制約の名前（schema.ts の CONSTRAINT …）。省くと何でも */
export function isCheckViolation(e: unknown, name?: string): boolean {
  const t = constraintTarget(e, "CHECK");
  return t !== null && (name === undefined || t === name);
}

export function isForeignKeyViolation(e: unknown): boolean {
  return constraintTarget(e, "FOREIGN KEY") !== null;
}

/** トリガーの RAISE(ABORT, …) で止められたか */
export function isTriggerAbort(e: unknown, message?: string): boolean {
  if (!(e instanceof Error) || !e.message.includes("SQLITE_CONSTRAINT_TRIGGER")) return false;
  return message === undefined || e.message.startsWith(message);
}
