// MCP の結果を文字にして、秘密情報をマスクし、64KB で切る（A-86、MT §3.10 の3・§3.12.5 の8・§3.12.6 の7）。
// 読み取りの応答（EP-49 の content）と、書き込みの result（action_intents.result）の両方で同じ関数を使う。
// マスクは platform の maskSecrets（既知の値＋決まった形）

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson } from "@open-team/kernel";
import { maskSecrets } from "@open-team/platform";

/** 返す・保存する本文の上限（A-86。読み取りも同じ：MT §2.1 の readResultMaxBytes） */
export const RESULT_MAX_BYTES = 64 * 1024;
/** マスクの前に切る文字数（巨大な応答に正規表現をかけない。64KB より十分長いので、切り口は最後の 64KB の切り詰めで捨てられる） */
const PRE_MASK_MAX_CHARS = RESULT_MAX_BYTES * 4;

export const OMITTED_IMAGE = "（画像は省略）";
export const OMITTED_AUDIO = "（音声は省略）";

/**
 * 結果の content[] を1つの文字にする（MT §3.10 の3）：text はそのまま、image・audio は省略の印、resource は文字のものだけ本文、
 * resource_link は本文がないので入れない。文字の部分が1つもなく structuredContent があれば、その正規形 JSON
 * （text と structuredContent に同じ値を入れるサーバーがあり、両方を入れると二重になる）。部分は改行でつなぐ
 */
export function toolResultText(result: Pick<CallToolResult, "content" | "structuredContent">): string {
  const parts: string[] = [];
  let textual = false;
  for (const c of Array.isArray(result.content) ? result.content : []) {
    switch (c.type) {
      case "text":
        parts.push(c.text);
        textual = true;
        break;
      case "image":
        parts.push(OMITTED_IMAGE);
        break;
      case "audio":
        parts.push(OMITTED_AUDIO);
        break;
      case "resource":
        if ("text" in c.resource && typeof c.resource.text === "string") {
          parts.push(c.resource.text);
          textual = true;
        }
        break;
      default:
        break;
    }
  }
  if (!textual && result.structuredContent !== undefined && result.structuredContent !== null) {
    try {
      parts.push(canonicalJson(result.structuredContent));
    } catch {
      // 正規形にできない値（JSON から来たものなら起きない）は入れない
    }
  }
  return parts.join("\n");
}

/** UTF-8 で maxBytes 以内に切る（文字の途中で切らない） */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // 続きのバイト（10xxxxxx）の途中なら、文字の先頭まで戻る
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** マスクしてから 64KB で切る（切り口で秘密の一部が残らないよう、先にマスクする） */
export function maskAndLimit(text: string, knownSecrets: readonly string[], maxBytes = RESULT_MAX_BYTES): { text: string; truncated: boolean } {
  const pre = text.length > PRE_MASK_MAX_CHARS ? text.slice(0, PRE_MASK_MAX_CHARS) : text;
  const masked = maskSecrets(pre, knownSecrets);
  const limited = truncateUtf8(masked, maxBytes);
  return { text: limited.text, truncated: limited.truncated || pre.length !== text.length };
}
