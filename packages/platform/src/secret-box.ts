// 保存する秘密の暗号化（16_google_calendar.md §2-2・§3.4、ADR-040）。AES-256-GCM。
// AAD に行の持ち主（"<workspace_id>:<connector_id>"）を入れ、別のワークスペースの行に写した暗号文は開けないようにする

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyOf(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("暗号の鍵は base64 の32バイトであること");
  return key;
}

/** 平文を "v1.<iv>.<暗号文＋タグ>"（base64url）にする */
export function sealSecret(keyB64: string, plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyOf(keyB64), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

/** sealSecret の逆。鍵・AAD・形が合わなければ例外 */
export function openSecret(keyB64: string, sealed: string, aad: string): string {
  const [version, ivPart, ctPart, ...rest] = sealed.split(".");
  if (version !== VERSION || ivPart === undefined || ctPart === undefined || rest.length > 0) throw new Error("暗号文の形が違う");
  const iv = Buffer.from(ivPart, "base64url");
  const body = Buffer.from(ctPart, "base64url");
  if (iv.length !== IV_BYTES || body.length <= TAG_BYTES) throw new Error("暗号文の形が違う");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(keyB64), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}
