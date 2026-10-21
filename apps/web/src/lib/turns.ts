// SCR-021：頼んだこと → 回答 の履歴（API-075 の turns）を画面の形に整える。
// 返事（「追加で頼む」）のたびに本番の実行が1つ増え、回答はその実行ごとに出る。どの文への回答かが分かるように、文と回答を対にして並べる
import type { AskDetail, AskTurnView } from "../api";

/** 履歴（古い順）。サーバーが turns を返さない（古い応答）ときは、今の実行だけから1つ作る */
export function turnsOf(detail: Pick<AskDetail, "ask" | "run" | "answer" | "turns">): AskTurnView[] {
  if (detail.turns !== undefined && detail.turns.length > 0) return detail.turns;
  const r = detail.run;
  if (r === null) return [];
  return [
    {
      runId: r.runId,
      runNo: r.runNo,
      kind: r.triggerType === "schedule" ? "schedule" : "ask",
      text: detail.ask.text,
      status: r.status as AskTurnView["status"],
      answer: detail.answer,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
    },
  ];
}

/** 頼んだことの行の札。最初の依頼の文は見出し（h1）が受け持つので null */
export function turnLabel(t: Pick<AskTurnView, "kind">, triggerLabel: string | null): string | null {
  switch (t.kind) {
    case "reply":
      return "追加で頼んだこと";
    case "schedule":
      return triggerLabel ? `定期の実行（${triggerLabel}）` : "定期の実行";
    default:
      return null;
  }
}

/** 頼んだことの行を出すか。最初の依頼の文は見出しにあるので出さない（やり直しなど、依頼の文のままの実行も同じ） */
export function showsRequest(t: Pick<AskTurnView, "kind" | "text">, askText: string): boolean {
  return t.kind !== "ask" || t.text !== askText;
}

/** 回答のない実行の1行（動いている間は null：窓口の名前で「〇〇がまとめています」を出す） */
export function noAnswerText(status: AskTurnView["status"]): string | null {
  switch (status) {
    case "failed":
    case "cancelled":
      return "回答はありません（止まりました）";
    case "waiting_input":
      return "途中で止まっています";
    default:
      return null;
  }
}

/**
 * 返事欄（追加で頼む）の出し方。会話の下に常に出す。動いている間も送れる（順番待ちになる）。
 * 出さないのは、並列（窓口がいない）・依頼がまだ動いていない／止まった（生成中・失敗・やめた・途中で止まって再開待ち）とき
 */
export function replyAvailability(detail: Pick<AskDetail, "ask" | "run" | "answer" | "turns">): { show: boolean; queues: boolean } {
  const { ask } = detail;
  if (ask.shape === "parallel") return { show: false, queues: false };
  if (ask.status !== "running" && ask.status !== "done") return { show: false, queues: false };
  const turns = turnsOf(detail);
  if (turns.length === 0) return { show: false, queues: false };
  // 今の実行が動いている間に送ると順番待ちになる
  const latest = turns[turns.length - 1]!;
  return { show: true, queues: latest.status === "running" || latest.status === "waiting_input" || ask.status === "running" };
}

/** 順番待ちの返事の1行（会話の末尾に出す） */
export function pendingReplyLabel(text: string): string {
  return `順番待ち：${text}`;
}

/** 返事を送った結果の1行（順番待ちに入ったときだけ知らせる。すぐ始まったときは会話にそのまま出るので不要） */
export function replySentNote(res: { queued?: boolean } | null | undefined): string | null {
  return res?.queued === true ? "順番待ちに入れました。いまの作業が終わると始まります" : null;
}
