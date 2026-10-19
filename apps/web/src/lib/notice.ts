// 届いた知らせ（依頼の回答が出たとき、どの画面にいても上から出るカード）の文を決める。
// 決まった文だけで作る（LLM の文を見出しにしない）。本文の1行目だけは回答の結論から取る

import type { AskAnswerView, StageView } from "../api";

/**
 * 見出し（担当の口調）。やったことの名前 → 頼んだ文の言葉 → 「終わったよ！」の順に当てる。
 * やったことは、外に作用するもの（発注）を先に見る。メールを読むのは前段の下調べのことが多いので最後
 */
const BY_ACTIVITY: Array<[RegExp, string]> = [
  [/発注/, "発注の準備をしたよ！"],
  [/Web の検索|Web のページを読む/, "リサーチしたよ！"],
  [/予定|カレンダー/, "予定を見ておいたよ！"],
  [/在庫/, "在庫を見ておいたよ！"],
  [/メール|受信箱/, "メールを見ておいたよ！"],
];

const BY_TEXT: Array<[RegExp, string]> = [
  [/調べ|リサーチ|ニュース|探し|競合/, "リサーチしたよ！"],
  [/発注|注文|仕入れ/, "発注の準備をしたよ！"],
  [/メール|問い合わせ/, "メールを見ておいたよ！"],
  [/予定|スケジュール/, "予定を見ておいたよ！"],
  [/比べ|比較/, "比べておいたよ！"],
  [/まとめ|一覧|表に/, "まとめたよ！"],
  [/在庫/, "在庫を見ておいたよ！"],
];

export interface NoticeInput {
  askText: string | null;
  answer: Pick<AskAnswerView, "conclusion" | "memberLines" | "needsYou">;
  stages?: Pick<StageView, "activity">[];
}

/** 「リサーチしたよ！」。確認待ち・止まった担当があれば、そちらを先に言う */
export function noticeHeadline({ askText, answer, stages = [] }: NoticeInput): string {
  if (answer.needsYou.stoppedMembers.length > 0 || answer.memberLines.some((m) => m.failed)) return "途中で止まっちゃった";
  // 済んだもの・あなたの確認へ回したもの（＝準備はできた）だけ。統制や安全装置が止めたものは数えない
  const labels = stages.flatMap((s) => (s.activity ?? []).filter((a) => a.outcome === "done" || a.outcome === "approval").map((a) => a.label)).join(" ");
  const done = BY_ACTIVITY.find(([re]) => re.test(labels))?.[1] ?? BY_TEXT.find(([re]) => re.test(askText ?? ""))?.[1] ?? "終わったよ！";
  return answer.needsYou.pendingApprovals > 0 ? `${done.replace(/！$/, "")}。確認してね` : done;
}

/** [題名](URL) は題名だけにする */
const LINK = /\[([^\]\n]+)\]\(https?:\/\/(?:[^\s()]|\([^\s()]*\))+\)/g;

/** 結論の Markdown から、記号を外した最初の1文（カードの2行目） */
export function noticeLead(conclusion: string, max = 60): string {
  const line =
    conclusion
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(#{1,6}\s+|[-*・]\s+|\d+[.)]\s+|>\s*)/, "")
          .replace(/\*\*(.+?)\*\*/g, "$1")
          .replace(/`([^`]+)`/g, "$1")
          .replace(LINK, "$1")
          .replace(/^\|.*\|$/, "")
          .trim(),
      )
      .find((l) => l.length > 0 && !/^[-*_|:\s]+$/.test(l)) ?? "";
  const first = line.split(/(?<=[。！？])/)[0] ?? line;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** 結論の箇条書きのうち先頭の n 件（シートで「ひと目で」見せる要点）。箇条書きがなければ空 */
export function noticePoints(conclusion: string, n = 3): string[] {
  return conclusion
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => /^\s{0,1}[-*・]\s+(.*)$/.exec(l)?.[1] ?? /^\s{0,1}\d+[.)]\s+(.*)$/.exec(l)?.[1] ?? null)
    .filter((x): x is string => x !== null && x.trim() !== "")
    .map((x) => x.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(LINK, "$1").trim())
    .slice(0, n);
}
