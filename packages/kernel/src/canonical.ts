// 正規形 JSON とハッシュ（RFC 8785 / JCS 相当。kernel-decide.md §3.3-1・3.3-2）
// intentHash・effective_policy_hash・tool_hash・destinationKey・監査ログの payload はすべてこの関数で計算する

import { createHash } from "node:crypto";
import type { Hex64 } from "./types.ts";

/** キーを UTF-16 のコード単位の順に並べた、空白のない JSON。NaN・Infinity・undefined の要素・関数・bigint・Date などは例外 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: 有限でない数値は扱えない");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((v) => {
            if (v === undefined) throw new TypeError("canonicalJson: 配列に undefined は入れられない");
            return canonicalJson(v);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJson: プレーンなオブジェクト以外は扱えない");
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof value} は扱えない`);
  }
}

/** UTF-8 のバイト列の SHA-256（小文字16進64桁） */
export function sha256Hex(text: string): Hex64 {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256Hex(canonicalJson(value)) */
export function hashCanonical(value: unknown): Hex64 {
  return sha256Hex(canonicalJson(value));
}
