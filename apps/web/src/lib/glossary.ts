// 用語の1行説明（安全チェックの区画の「用語の説明」と、権限を絞る提案の行の「ガード」で同じ文を使う）。
// 利用者に見える文なので「リハーサル」「合格証」「汚染」「オラクル」「締める」は使わない（#16 B案。設計書の用語との対応は README §もう少し詳しく）

export interface GlossaryEntry {
  term: string;
  text: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: "安全チェック", text: "任せる前に、Gemini が作った悪い日を本番と同じ経路で試し、止まるかを確かめること" },
  { term: "Kernel", text: "実行の前に許可・確認・拒否を決める、LLM でないコード" },
  { term: "合否の判定", text: "悪い日の結果が合格か不合格かを決める、決まったルールで動く検査（AI は関わらない）" },
  { term: "ガード", text: "数量や単価の上限など、超えたら確認に回す条件" },
  { term: "安全チェック済み", text: "悪い日をすべて止められたときの記録（設定と試験のハッシュつき）。この記録がないあいだは、ルールがあっても自動にせずあなたに確認する" },
  // README §仕組み・15_hackathon.md §影の判定 の定義に合わせる
  { term: "統制", text: "Kernel とガードで、送る前に止める・確認に回す仕組み" },
  { term: "すり抜けた", text: "統制があっても実害が出た状況" },
  { term: "影の走行", text: "統制なしで同じ状況を走らせた、比較用の記録" },
];

/** 用語の説明。なければ null */
export function glossaryText(term: string): string | null {
  return GLOSSARY.find((g) => g.term === term)?.text ?? null;
}

/** 文の中の用語（最初に出た1か所）を前・用語・後ろに分ける。含まなければ null */
export function splitAtTerm(text: string, term: string): { before: string; term: string; after: string } | null {
  const i = text.indexOf(term);
  if (i < 0) return null;
  return { before: text.slice(0, i), term, after: text.slice(i + term.length) };
}
