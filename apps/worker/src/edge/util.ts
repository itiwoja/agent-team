// 小さな道具（JSON の形の確かめ・文字数・バイト数・JST の時刻）。packages/edge/src/util.ts の写し（バイト数は Buffer の代わりに TextEncoder で数える）

import type { Json, JsonObject } from "@open-team/kernel";

const encoder = new TextEncoder();

function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isJson(v: unknown, depth: number): v is Json {
  if (depth > 64) return false;
  if (v === null || typeof v === "boolean" || typeof v === "string") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  if (isPlainObject(v)) return Object.values(v).every((x) => x === undefined || isJson(x, depth + 1));
  return false;
}

/**
 * LLM・DB から来た値を JSON のオブジェクトとして受け取る（判定・ハッシュの入力。NaN・関数・Date などがあれば null）。
 * 写しを返す（呼び出し側と値を共有しない）。undefined のキーは落とす
 */
export function toJsonObject(v: unknown): JsonObject | null {
  if (!isPlainObject(v) || !isJson(v, 0)) return null;
  return JSON.parse(JSON.stringify(v)) as JsonObject;
}

/** JSON の UTF-8 のバイト数（JSON にできなければ Infinity） */
export function jsonBytes(v: unknown): number {
  try {
    const text = JSON.stringify(v);
    return text === undefined ? 0 : utf8Bytes(text);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Unicode のコードポイントで数えた文字数（IA §8-28） */
export function charCount(s: string): number {
  return [...s].length;
}

/** コードポイントで max 文字まで（切ったら末尾を「…」にする） */
export function truncateChars(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** UTF-8 で maxBytes まで（文字の途中で切らない） */
export function capBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(s) <= maxBytes) return { text: s, truncated: false };
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return { text: out, truncated: true };
}

/** 'YYYY-MM-DDTHH:mm:ss+09:00'（JST。夏時間はない：platform の time.ts と同じ考え方） */
export function toJstIso(d: Date): string {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("不正な Date");
  const shifted = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
  return `${shifted.slice(0, 19)}+09:00`;
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
