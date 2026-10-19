// エージェントの見た目（アイコン）。名前から決まった形で作る（同じ名前ならいつも同じ顔。LLM は呼ばない）。
// キャラは 1 種類（まるい体・短い足・顔のスクリーン）。色は名前のハッシュ、
// 持ち物は名前の語（受信箱 → 封筒、発注 → 箱 …）で選ぶ
export type AvatarProp = "envelope" | "box" | "clipboard" | "news" | "cloud" | "calendar" | "wrench" | "coin" | "sprout";
/** 表情（担当の段の状態から決める） */
export type AvatarMood = "idle" | "waiting" | "running" | "approval" | "done" | "failed" | "stopped";

export interface AvatarPalette {
  fill: string;
  shade: string;
  line: string;
}

export interface AvatarTraits {
  palette: AvatarPalette;
  prop: AvatarProp;
}

/** くすんだ色の体と、少し濃い影・輪郭（ライト・ダークのどちらの地でも読める明るさ） */
export const PALETTES: readonly AvatarPalette[] = [
  { fill: "#d9a28c", shade: "#c98a73", line: "#8f5a47" }, // テラコッタ
  { fill: "#a9bfa5", shade: "#93ab8f", line: "#5d7559" }, // セージ
  { fill: "#a3b5c7", shade: "#8ca0b4", line: "#566a7f" }, // スモークブルー
  { fill: "#d6c08a", shade: "#c4ab70", line: "#86733f" }, // マスタード
  { fill: "#b9a7bd", shade: "#a492a9", line: "#6d5b72" }, // モーブ
  { fill: "#d1a9ab", shade: "#bf9294", line: "#855d60" }, // くすみローズ
  { fill: "#cdbba3", shade: "#b9a68c", line: "#7d6b54" }, // ベージュ
  { fill: "#9dbab6", shade: "#86a5a1", line: "#516f6b" }, // くすみティール
];


/** 名前の語 → 持ち物（上から順に見る） */
const PROP_WORDS: ReadonlyArray<readonly [RegExp, AvatarProp]> = [
  [/受信|メール|問い合わせ|手紙|連絡/, "envelope"],
  [/仕入|発注|注文|配送|荷物/, "box"],
  [/在庫|棚|点検|チェック|確認/, "clipboard"],
  [/ニュース|まとめ|報告|記事|要約/, "news"],
  [/天気|気象/, "cloud"],
  [/予定|カレンダー|日程|スケジュール/, "calendar"],
  [/更新|依存|コード|CI|リポジトリ|開発|修理/i, "wrench"],
  [/売上|値段|価格|会計|支払|振込|競合/, "coin"],
];

/** FNV-1a（32bit）。名前を種にする */
export function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function propOf(name: string): AvatarProp {
  return PROP_WORDS.find(([re]) => re.test(name))?.[1] ?? "sprout";
}

export function avatarTraits(name: string): AvatarTraits {
  const h = hashOf(name.trim());
  return {
    palette: PALETTES[h % PALETTES.length]!,
    prop: propOf(name),
  };
}

/** 担当の段の状態 → 表情 */
export function moodOfStage(state: string): AvatarMood {
  switch (state) {
    case "running":
      return "running";
    case "awaiting_approval":
      return "approval";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "waiting";
  }
}
