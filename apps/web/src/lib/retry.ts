// チェックの失敗の行の「やり直す」：どの操作を呼ぶかの判断だけを持つ（API は呼ばない）
import type { AskDetail, AskStatus, ReportItem } from "../api";

/** 失敗の行でやり直すときに呼ぶ操作。null は「やり直すボタンを出さない」 */
export type RetryPlan = "rehearsal" | "ask" | null;

/** 失敗の行（failed）で、依頼（askId）があり、リハーサル・依頼・担当の仕事のどれかの失敗なら対応する操作を返す */
export function retryPlanFor(item: Pick<ReportItem, "failed" | "reportKind" | "link">): RetryPlan {
  if (!item.failed || !item.link.askId) return null;
  if (item.reportKind === "rehearsal") return "rehearsal";
  if (item.reportKind === "answer" || item.reportKind === "task") return "ask";
  return null;
}

/**
 * 依頼のやり直し方：順番で止まっていて再開できる（waiting_input かつ resume がある）なら止まった段から（resume）、
 * 終わっていない依頼（waiting_input で再開先がない・generating・running）は作り直さずに依頼のページを開くだけ（open。頼み直すと同じ依頼が二重に動く）、
 * それ以外（failed・done・cancelled など）は同じ文で頼み直して編成から作り直す（reask）
 */
export function askRetryAction(detail: {
  ask: { status: AskStatus };
  resume: AskDetail["resume"];
}): "resume" | "open" | "reask" {
  if (detail.ask.status === "waiting_input") return detail.resume ? "resume" : "open";
  if (detail.ask.status === "generating" || detail.ask.status === "running") return "open";
  return "reask";
}

/**
 * 頼み直しの冪等キー（Idempotency-Key）。元の依頼（askId）から決まる UUID 形の値にする。
 * 同じ依頼の失敗の行が複数あっても、同じキーで頼むので依頼は1つだけ作られ、2回目は最初の依頼の応答が返る
 */
export async function reaskKeyFor(askId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`reask:${askId}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
