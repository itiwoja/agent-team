// 監査ログ（ワークスペースごとのハッシュチェーン。FR-016、BR-18・81。db-schema.md §4.2、security-ops-deploy.md §3.13）
// hash = SHA-256( prev_hash（生の32バイト）‖ u64be(seq) ‖ LP(occurred_at の ISO 8601・UTC・ミリ秒) ‖ LP(event_type)
//               ‖ LP(actor_type + ':' + (actor_id ?? '')) ‖ LP(JCS(payload)) )、LP(x) = u32be(UTF-8 のバイト数) ‖ UTF-8(x)
// 先頭の prev_hash は32バイトの0。JCS は kernel の canonicalJson（M-08）。task_id 列はハッシュに入らないので、
// タスクのイベントは payload にも taskId を入れる（DB §4.2）

import { createHash } from "node:crypto";
import { canonicalJson } from "@open-team/kernel";
import type { Db, Queryable, Tx } from "./client.ts";
import type { ActorType, AuditLogRow, JsonObject, Uuid } from "./types.ts";

/** 先頭の prevHash（32バイトの0。FR-016） */
export const AUDIT_GENESIS_PREV_HASH: Buffer = Buffer.alloc(32);

export interface AuditEventInput {
  /** 'workspace.created'・'approval.decided' など（小文字と _ を . でつないだもの） */
  eventType: string;
  actorType: ActorType;
  actorId: string | null;
  taskId?: Uuid | null;
  /** 秘密情報を入れない（ログのマスクを通した値だけ）。金額は小数6桁の文字列 */
  payload: JsonObject;
}

export interface AuditHashInput {
  prevHash: Uint8Array;
  seq: number;
  occurredAt: Date;
  eventType: string;
  actorType: ActorType;
  actorId: string | null;
  payload: JsonObject;
}

function lengthPrefixed(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

/** 'YYYY-MM-DDTHH:mm:ss.sssZ'。ミリ秒より細かい時刻は表せない（JS の Date）ので、DB にもミリ秒で入る */
export function auditTimestamp(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new TypeError("監査ログの時刻が正しい Date ではない");
  return d.toISOString();
}

export function computeAuditHash(i: AuditHashInput): Buffer {
  if (i.prevHash.length !== 32) throw new RangeError("prevHash は32バイト");
  if (!Number.isSafeInteger(i.seq) || i.seq < 1) throw new RangeError(`seq は1以上の整数：${i.seq}`);
  const seq = Buffer.alloc(8);
  seq.writeBigUInt64BE(BigInt(i.seq));
  return createHash("sha256")
    .update(i.prevHash)
    .update(seq)
    .update(lengthPrefixed(auditTimestamp(i.occurredAt)))
    .update(lengthPrefixed(i.eventType))
    .update(lengthPrefixed(`${i.actorType}:${i.actorId ?? ""}`))
    .update(lengthPrefixed(canonicalJson(i.payload)))
    .digest();
}

const EVENT_TYPE_RE = /^[a-z_]+(\.[a-z_]+)*$/;
/** 単独のサロゲート（jsonb に入らない。String.prototype.isWellFormed は ES2024 なので正規表現で見る） */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
function isWellFormed(s: string): boolean {
  return !LONE_SURROGATE_RE.test(s);
}

/**
 * jsonb に入れて読み戻してもハッシュが変わらない値だけを通す（SO §3.13 の1）。
 * 数値は有限で、整数なら安全な整数。文字列は \u0000 と単独のサロゲートを含まない（jsonb に入らない）
 */
export function assertAuditPayload(payload: unknown, path = "payload"): void {
  if (payload === null || typeof payload === "boolean") return;
  if (typeof payload === "number") {
    if (!Number.isFinite(payload)) throw new TypeError(`${path}：有限でない数値`);
    if (Number.isInteger(payload) && !Number.isSafeInteger(payload)) throw new TypeError(`${path}：安全な整数の範囲を超えた数値`);
    return;
  }
  if (typeof payload === "string") {
    if (payload.includes("\u0000")) throw new TypeError(`${path}：\\u0000 を含む文字列`);
    if (!isWellFormed(payload)) throw new TypeError(`${path}：単独のサロゲートを含む文字列`);
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertAuditPayload(v, `${path}[${i}]`));
    return;
  }
  if (typeof payload === "object") {
    const proto = Object.getPrototypeOf(payload);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path}：プレーンなオブジェクトではない`);
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined) continue;
      if (k.includes("\u0000") || !isWellFormed(k)) throw new TypeError(`${path}：使えないキー`);
      assertAuditPayload(v, `${path}.${k}`);
    }
    return;
  }
  throw new TypeError(`${path}：JSON にできない値（${typeof payload}）`);
}

/** jsonb から読んだ・JS で作った payload を、undefined を落とした JSON の値にそろえる */
function toJsonObject(payload: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(payload)) as JsonObject;
}

/**
 * 監査ログを1件足す（DB §4.2）。業務の変更と同じトランザクションで呼ぶ。
 * ワークスペースの行を FOR NO KEY UPDATE で取って採番する（ロックの順はワークスペースが最初：M-21）。
 * occurred_at は now（ミリ秒）。DB の now() は使わない
 */
export async function appendAuditLog(tx: Tx, workspaceId: Uuid, e: AuditEventInput, now: Date): Promise<AuditLogRow> {
  if (!EVENT_TYPE_RE.test(e.eventType) || e.eventType.length > 100) throw new TypeError(`イベントの名前の形が違う：${e.eventType}`);
  if (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload)) throw new TypeError("payload はオブジェクト");
  assertAuditPayload(e.payload);
  const payload = toJsonObject(e.payload);
  const occurredAt = new Date(auditTimestamp(now));

  const ws = await tx.query<{ audit_seq: number; audit_last_hash: Buffer }>(
    "SELECT audit_seq, audit_last_hash FROM workspaces WHERE id = $1 FOR NO KEY UPDATE",
    [workspaceId],
  );
  const head = ws.rows[0];
  if (!head) throw new Error(`監査ログを書くワークスペースがない：${workspaceId}`);
  const seq = head.audit_seq + 1;
  const prevHash = head.audit_last_hash;
  const hash = computeAuditHash({
    prevHash,
    seq,
    occurredAt,
    eventType: e.eventType,
    actorType: e.actorType,
    actorId: e.actorId,
    payload,
  });
  const inserted = await tx.query<AuditLogRow>(
    `INSERT INTO audit_logs (workspace_id, seq, occurred_at, event_type, actor_type, actor_id, task_id, payload, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING workspace_id, seq, occurred_at, event_type, actor_type, actor_id, task_id, payload, prev_hash, hash`,
    [workspaceId, seq, occurredAt, e.eventType, e.actorType, e.actorId, e.taskId ?? null, payload, prevHash, hash],
  );
  await tx.query("UPDATE workspaces SET audit_seq = $2, audit_last_hash = $3 WHERE id = $1", [workspaceId, seq, hash]);
  const row = inserted.rows[0];
  if (!row) throw new Error("監査ログを足せなかった");
  return row;
}

export interface AuditVerifyResult {
  ok: boolean;
  /** 正しいと確かめられた行の数（ok なら範囲の行の数） */
  checkedCount: number;
  /** 最初に外れた seq（抜けた番号・書き換えられた行・末尾が消えた場合は最後の行の次） */
  firstBrokenSeq: number | null;
}

const VERIFY_BATCH = 1000;

/**
 * ハッシュチェーンを確かめる（DB §4.2、SO §3.13。EP-44）。範囲がなければ1から最後まで。
 * 各行で seq の連続・prev_hash が前の行の hash・再計算した hash を確かめ、最初に外れた seq で止める。
 * 範囲がチェーンの最後まで（toSeq を渡さない・workspaces.audit_seq 以上）なら、最後の行が workspaces の
 * audit_seq・audit_last_hash と一致することも確かめる（末尾の削除を見つける）。
 * Db を渡すと REPEATABLE READ の読み取り専用トランザクションで読む（検証の途中の追記で食い違わない）。Tx を渡すならその中で読む
 */
export async function verifyAuditChain(
  q: Db | Tx,
  workspaceId: Uuid,
  range: { fromSeq?: number; toSeq?: number } = {},
): Promise<AuditVerifyResult> {
  if (q.inTransaction) return verifyIn(q, workspaceId, range);
  return q.transaction((tx) => verifyIn(tx, workspaceId, range), { isolation: "repeatable read", readOnly: true });
}

async function verifyIn(q: Queryable, workspaceId: Uuid, range: { fromSeq?: number; toSeq?: number }): Promise<AuditVerifyResult> {
  const head = (
    await q.query<{ audit_seq: number; audit_last_hash: Buffer }>("SELECT audit_seq, audit_last_hash FROM workspaces WHERE id = $1", [
      workspaceId,
    ])
  ).rows[0];
  if (!head) throw new Error(`ワークスペースがない：${workspaceId}`);
  const fromSeq = range.fromSeq ?? 1;
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) throw new RangeError("fromSeq は1以上の整数");
  const toEnd = range.toSeq === undefined || range.toSeq >= head.audit_seq;
  const toSeq = toEnd ? head.audit_seq : (range.toSeq as number);
  if (toSeq < fromSeq) {
    if (toEnd) {
      const beyond = await q.query("SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND seq > $2 LIMIT 1", [workspaceId, head.audit_seq]);
      if (beyond.rows.length > 0) return { ok: false, checkedCount: 0, firstBrokenSeq: head.audit_seq + 1 };
    }
    return { ok: true, checkedCount: 0, firstBrokenSeq: null };
  }

  let prevHash: Buffer = AUDIT_GENESIS_PREV_HASH;
  if (fromSeq > 1) {
    const before = (
      await q.query<{ hash: Buffer }>("SELECT hash FROM audit_logs WHERE workspace_id = $1 AND seq = $2", [workspaceId, fromSeq - 1])
    ).rows[0];
    if (!before) return { ok: false, checkedCount: 0, firstBrokenSeq: fromSeq - 1 };
    prevHash = before.hash;
  }

  let expected = fromSeq;
  let checked = 0;
  let lastHash: Buffer | null = null;
  let lastSeq = fromSeq - 1;
  for (;;) {
    const batch = await q.query<AuditLogRow>(
      `SELECT workspace_id, seq, occurred_at, event_type, actor_type, actor_id, task_id, payload, prev_hash, hash
         FROM audit_logs WHERE workspace_id = $1 AND seq >= $2 AND seq <= $3 ORDER BY seq LIMIT $4`,
      [workspaceId, expected, toSeq, VERIFY_BATCH],
    );
    for (const row of batch.rows) {
      if (row.seq !== expected) return { ok: false, checkedCount: checked, firstBrokenSeq: expected };
      if (!row.prev_hash.equals(prevHash)) return { ok: false, checkedCount: checked, firstBrokenSeq: row.seq };
      const recomputed = computeAuditHash({
        prevHash,
        seq: row.seq,
        occurredAt: row.occurred_at,
        eventType: row.event_type,
        actorType: row.actor_type,
        actorId: row.actor_id,
        payload: row.payload,
      });
      if (!recomputed.equals(row.hash)) return { ok: false, checkedCount: checked, firstBrokenSeq: row.seq };
      prevHash = row.hash;
      lastHash = row.hash;
      lastSeq = row.seq;
      checked += 1;
      expected += 1;
    }
    if (batch.rows.length < VERIFY_BATCH || expected > toSeq) break;
  }
  if (expected <= toSeq) {
    // 範囲の途中から先がない（末尾の削除か抜け）
    return { ok: false, checkedCount: checked, firstBrokenSeq: expected };
  }
  if (toEnd) {
    // 最後の行が workspaces の先頭（audit_seq・audit_last_hash）と一致し、その先に行がないこと
    if (lastSeq !== head.audit_seq || !lastHash || !lastHash.equals(head.audit_last_hash)) {
      return { ok: false, checkedCount: checked, firstBrokenSeq: lastSeq + 1 };
    }
    const beyond = await q.query("SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND seq > $2 LIMIT 1", [workspaceId, head.audit_seq]);
    if (beyond.rows.length > 0) return { ok: false, checkedCount: checked, firstBrokenSeq: head.audit_seq + 1 };
  }
  return { ok: true, checkedCount: checked, firstBrokenSeq: null };
}
