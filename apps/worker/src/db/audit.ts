// 監査ログ（ワークスペースごとのハッシュチェーン。FR-016、BR-18・81）。packages/db/src/audit.ts の WorkspaceDO 版。
// hash = SHA-256( prev_hash（生の32バイト）‖ u64be(seq) ‖ LP(occurred_at の ISO 8601・UTC・ミリ秒) ‖ LP(event_type)
//               ‖ LP(actor_type + ':' + (actor_id ?? '')) ‖ LP(JCS(payload)) )、LP(x) = u32be(UTF-8 のバイト数) ‖ UTF-8(x)
// 先頭の prev_hash は32バイトの0。JCS は kernel の canonicalJson。task_id 列はハッシュに入らないので、
// タスクのイベントは payload にも taskId を入れる。ハッシュの作り方は Postgres 版と同じ（移した行もそのまま確かめられる）

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { canonicalJson } from "@open-team/kernel";
import { CODECS } from "./codecs.ts";
import { all, one, run, type WsDb } from "./sqlite.ts";
import type { ActorType, AuditLogRow, JsonObject, Uuid } from "./types.ts";

/** 先頭の prevHash（32バイトの0。FR-016） */
export const AUDIT_GENESIS_PREV_HASH: Buffer = Buffer.alloc(32);

export interface AuditEventInput {
  /** 'workspace.created'・'approval.decided' など（小文字と _ を . でつないだもの） */
  eventType: string;
  actorType: ActorType;
  actorId: string | null;
  taskId?: Uuid | null;
  /** 秘密情報を入れない（ログのマスクを通した値だけ） */
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

/** 'YYYY-MM-DDTHH:mm:ss.sssZ' */
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
/** 単独のサロゲート（JSON にして読み戻すと変わる） */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * JSON にして読み戻してもハッシュが変わらない値だけを通す（SO §3.13 の1）。
 * 数値は有限で、整数なら安全な整数。文字列は \u0000 と単独のサロゲートを含まない（Postgres 版と同じ条件にそろえる）
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
    if (LONE_SURROGATE_RE.test(payload)) throw new TypeError(`${path}：単独のサロゲートを含む文字列`);
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
      if (k.includes("\u0000") || LONE_SURROGATE_RE.test(k)) throw new TypeError(`${path}：使えないキー`);
      assertAuditPayload(v, `${path}.${k}`);
    }
    return;
  }
  throw new TypeError(`${path}：JSON にできない値（${typeof payload}）`);
}

const AUDIT_COLUMNS = "seq, occurred_at, event_type, actor_type, actor_id, task_id, payload, prev_hash, hash";

/**
 * 監査ログを1件足す。業務の変更と同じトランザクション（db.transaction の中）で呼ぶ。
 * occurred_at は now（ミリ秒）。ワークスペースの行（init のあと）がなければ例外
 */
export function appendAuditLog(db: WsDb, e: AuditEventInput, now: Date): AuditLogRow {
  if (!EVENT_TYPE_RE.test(e.eventType) || e.eventType.length > 100) throw new TypeError(`イベントの名前の形が違う：${e.eventType}`);
  if (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload)) throw new TypeError("payload はオブジェクト");
  assertAuditPayload(e.payload);
  const payload = JSON.parse(JSON.stringify(e.payload)) as JsonObject;
  const occurredAt = new Date(auditTimestamp(now));

  return db.transaction(() => {
    const head = one<{ audit_seq: number; audit_last_hash: Buffer }>(
      db,
      CODECS.workspace,
      "SELECT audit_seq, audit_last_hash FROM workspace WHERE id = 1",
    );
    if (!head) throw new Error("監査ログを書くワークスペースの行がない（init の前）");
    const seq = head.audit_seq + 1;
    const hash = computeAuditHash({
      prevHash: head.audit_last_hash,
      seq,
      occurredAt,
      eventType: e.eventType,
      actorType: e.actorType,
      actorId: e.actorId,
      payload,
    });
    const row = one<AuditLogRow>(
      db,
      CODECS.audit_logs,
      `INSERT INTO audit_logs (${AUDIT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${AUDIT_COLUMNS}`,
      seq,
      occurredAt,
      e.eventType,
      e.actorType,
      e.actorId,
      e.taskId ?? null,
      payload,
      head.audit_last_hash,
      hash,
    );
    run(db, "UPDATE workspace SET audit_seq = ?, audit_last_hash = ? WHERE id = 1", seq, hash);
    if (!row) throw new Error("監査ログを足せなかった");
    return row;
  });
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
 * ハッシュチェーンを確かめる（EP-44）。範囲がなければ1から最後まで。
 * 各行で seq の連続・prev_hash が前の行の hash・再計算した hash を確かめ、最初に外れた seq で止める。
 * 範囲がチェーンの最後まで（toSeq を渡さない・audit_seq 以上）なら、最後の行が workspace の audit_seq・audit_last_hash と
 * 一致することも確かめる（末尾の削除を見つける）。DO の中は1本の流れなので、途中で追記されて食い違うことはない
 */
export function verifyAuditChain(db: WsDb, range: { fromSeq?: number; toSeq?: number } = {}): AuditVerifyResult {
  const head = one<{ audit_seq: number; audit_last_hash: Buffer }>(db, CODECS.workspace, "SELECT audit_seq, audit_last_hash FROM workspace WHERE id = 1");
  if (!head) throw new Error("ワークスペースの行がない（init の前）");
  const fromSeq = range.fromSeq ?? 1;
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) throw new RangeError("fromSeq は1以上の整数");
  const toEnd = range.toSeq === undefined || range.toSeq >= head.audit_seq;
  const toSeq = toEnd ? head.audit_seq : (range.toSeq as number);
  const beyondHead = (): boolean => one(db, {}, "SELECT 1 FROM audit_logs WHERE seq > ? LIMIT 1", head.audit_seq) !== null;
  if (toSeq < fromSeq) {
    if (toEnd && beyondHead()) return { ok: false, checkedCount: 0, firstBrokenSeq: head.audit_seq + 1 };
    return { ok: true, checkedCount: 0, firstBrokenSeq: null };
  }

  let prevHash: Buffer = AUDIT_GENESIS_PREV_HASH;
  if (fromSeq > 1) {
    const before = one<{ hash: Buffer }>(db, CODECS.audit_logs, "SELECT hash FROM audit_logs WHERE seq = ?", fromSeq - 1);
    if (!before) return { ok: false, checkedCount: 0, firstBrokenSeq: fromSeq - 1 };
    prevHash = before.hash;
  }

  let expected = fromSeq;
  let checked = 0;
  let lastHash: Buffer | null = null;
  let lastSeq = fromSeq - 1;
  for (;;) {
    const batch = all<AuditLogRow>(
      db,
      CODECS.audit_logs,
      `SELECT ${AUDIT_COLUMNS} FROM audit_logs WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?`,
      expected,
      toSeq,
      VERIFY_BATCH,
    );
    for (const row of batch) {
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
    if (batch.length < VERIFY_BATCH || expected > toSeq) break;
  }
  if (expected <= toSeq) return { ok: false, checkedCount: checked, firstBrokenSeq: expected };
  if (toEnd) {
    if (lastSeq !== head.audit_seq || !lastHash || !lastHash.equals(head.audit_last_hash)) {
      return { ok: false, checkedCount: checked, firstBrokenSeq: lastSeq + 1 };
    }
    if (beyondHead()) return { ok: false, checkedCount: checked, firstBrokenSeq: head.audit_seq + 1 };
  }
  return { ok: true, checkedCount: checked, firstBrokenSeq: null };
}
