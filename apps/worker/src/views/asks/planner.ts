// 生成に失敗したときの画面の1行（apps/app/src/asks/planner.ts の表示の部分の WorkspaceDO 版。FAILURE_MESSAGES だけ）。
// 設定プランナー（Gemini の呼び出し・編成の検査）は src/asks/planner.ts（そこから FAILURE_MESSAGES を re-export する）

import type { AskFailureReason } from "./contract.ts";

/** 画面に出す1行（失敗の理由ごとの固定の文） */
export const FAILURE_MESSAGES: Readonly<Record<AskFailureReason, string>> = {
  formation_invalid: "うまく決められませんでした。言い方を変えてみてください",
  // 時間切れ・Gemini の失敗は依頼の言い方のせいではない（混雑・一時的な失敗）。言い方を変えるよう促さない
  timeout: "Gemini が混み合っていて、時間内に決められませんでした。もう一度送ってください",
  budget_exceeded: "今日の予算を使い切りました",
  agent_limit: "エージェントが上限に達しています。使っていない担当を整理してください",
  planner_error: "Gemini の呼び出しに失敗しました。もう一度送ってください",
};
