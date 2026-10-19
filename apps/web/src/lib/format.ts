const yen = new Intl.NumberFormat("ja-JP");

/** ¥344,000 */
export function formatYen(n: number): string {
  return `¥${yen.format(Math.round(n))}`;
}

/** $0.003（1セント未満は小数3桁、それ以上は2桁）。壊れた値は null */
export function formatUsd(v: string | number): string | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return `$${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** 用意した依頼に出す、正直な1行 */
export const PREPARED_NOTE = "この依頼の編成と結果は事前に用意したものです";

/** 入口のトークン欄の下の1行（審査員向け。#10） */
export const JUDGE_TOKEN_NOTE = "審査員の方へ：入口のトークンは提出フォームに記載しています";

/** 用意した依頼のページの、初めての方への1行（#10）。続けて FIRST_VISIT_SELF のリンクを置く */
export const FIRST_VISIT_NOTE = "初めての方は、この用意した依頼の結果から見てください。";
/** FIRST_VISIT_NOTE の後ろに置くリンクの文字（入口へ） */
export const FIRST_VISIT_SELF = "自分で頼むこともできます";

/** 7:02（今日）／10/8 18:02（それ以外） */
export function formatTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
