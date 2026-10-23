// チャット（`/`）：依頼をひとつの会話に並べる（純粋な関数。画面は screens/Chat.tsx）。
// 送った文は、直前の依頼が続けられて、最後のやり取りから間がなければその依頼への返事（API-077）、そうでなければ新しい依頼（API-072）にする
import type { AskDetail, AskSummary } from "../api";
import { replyAvailability } from "./turns";

/** 直前の依頼に続けるのは、最後に動いてからこの時間まで */
export const CONTINUE_MS = 30 * 60 * 1000;

/** 会話に出す依頼の数（新しいほうから） */
export const CHAT_LIMIT = 20;

export type ChatRoute = { kind: "new" } | { kind: "reply"; askId: string };

/** 送った文の行き先。latest は会話のいちばん下の依頼 */
export function routeOf(latest: Pick<AskDetail, "ask" | "run" | "answer" | "turns"> | null, nowMs: number): ChatRoute {
  if (latest === null) return { kind: "new" };
  if (!replyAvailability(latest).show) return { kind: "new" };
  const updated = Date.parse(latest.ask.updatedAt);
  if (!Number.isFinite(updated) || nowMs - updated > CONTINUE_MS) return { kind: "new" };
  return { kind: "reply", askId: latest.ask.id };
}

/** 一覧（新しい順）を会話の順（古い順）にする */
export function chatOrder(asks: AskSummary[]): AskSummary[] {
  return [...asks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 動いている（取り直しが要る）依頼か */
export function isLive(status: AskSummary["status"]): boolean {
  return status === "generating" || status === "running" || status === "waiting_input";
}
