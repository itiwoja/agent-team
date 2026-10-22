// 依頼の受け付け（FR-061・API-072・073。apps/app/src/asks/create.ts の受け付けの部分の WorkspaceDO 版）。
// 依頼を generating で作り、監査ログと SSE の事象（ask.created）を同じトランザクションで残す。冪等性は呼ぶ側（idempotency.ts の runIdempotent）。
// 設定プランナーの生成（編成を作る）は 4b で Workflow から動かす。それまでは generating のまま残る

import type { Json } from "@open-team/kernel";
import { AppError, maskSecrets } from "@open-team/platform";
import { appendAuditLog } from "../db/audit.ts";
import { appendWorkspaceEvent } from "../db/repo/app.ts";
import { findLiveAgentByIdOrName, getAsk, insertGeneratingAsk, setAskQuestionAnswer } from "../db/repo/asks.ts";
import { listPackInstalls } from "../db/repo/sandbox.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { Uuid } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";
import { canStartWork, spendDeniedAppError } from "../edge/spend.ts";
import type { AnswerAskBody, AskAcceptedResponse, AskEventData, CreateAskBody } from "../views/asks/contract.ts";
import { askSummary } from "../views/asks/format.ts";

/** 受け付けの共通の入力。secrets は利用者の文から伏せる既知の秘密（knownSecretsFromEnv） */
export interface AcceptInput {
  userId: Uuid;
  now: Date;
  secrets: readonly string[];
}

/** 利用者が書いた文の秘密情報をマスクして保存・受け渡しに使う（BR-32）。上限 2,000文字 */
export function maskUserText(text: string, secrets: readonly string[]): string {
  return maskSecrets(text, secrets).slice(0, 2000);
}

/** 依頼の SSE の事象（ask.*）を workspace_events に書く（業務の変更と同じトランザクション） */
export function emitAskEvent(db: WsDb, data: AskEventData, now: Date): void {
  appendWorkspaceEvent(db, { type: data.type, data: data as unknown as Json }, now);
}

/** 受け付けてよいか：Kill Switch・費用の上限（同時実行数は待つだけなので止めない） */
function assertCanAccept(db: WsDb, now: Date): void {
  const ws = getWorkspace(db);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  const r = canStartWork(db, ws, now);
  if (!r.ok && r.reason === "global") throw spendDeniedAppError({ scope: r.reason }, now);
}

/** API-072：依頼を作る（呼ぶ側のトランザクションの中で） */
export function acceptAsk(db: WsDb, i: AcceptInput & { body: CreateAskBody }): AskAcceptedResponse {
  const { body, now } = i;
  assertCanAccept(db, now);
  let mentionId: Uuid | null = null;
  if (body.mention !== undefined) {
    const key = body.mention.replace(/^[@＠]/, "").trim();
    const agent = key === "" ? null : findLiveAgentByIdOrName(db, key);
    if (agent === null) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "mention", reason: "指定された担当が見つかりません" }] });
    mentionId = agent.id;
  }
  // パックの作業場から出した依頼：このワークスペースに入っているパックだけ（依頼の行に残して設定プランナーのヒントにする）
  let packId: string | null = null;
  if (body.packId !== undefined) {
    if (!listPackInstalls(db).some((p) => p.pack_id === body.packId)) {
      throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "packId", reason: "入っていないパックです" }] });
    }
    packId = body.packId;
  }
  const ask = insertGeneratingAsk(db, { createdBy: i.userId, text: maskUserText(body.text, i.secrets), mentionAgentId: mentionId, packId, now });
  appendAuditLog(db, { eventType: "ask.created", actorType: "user", actorId: i.userId, payload: { askId: ask.id, mention: mentionId, packId } }, now);
  emitAskEvent(db, { type: "ask.created", askId: ask.id, text: ask.text, status: "generating" }, now);
  return { ask: askSummary(ask) };
}

/** API-073：生成中の質問に答える。質問が出ていて答えていない生成中の依頼だけ（ほかは 409 ASK_NOT_WAITING） */
export function answerAskQuestion(db: WsDb, i: AcceptInput & { askId: Uuid; body: AnswerAskBody }): AskAcceptedResponse {
  const { askId, body, now } = i;
  assertCanAccept(db, now);
  const ask = getAsk(db, askId);
  if (ask === null) throw new AppError("NOT_FOUND");
  if (ask.status !== "generating" || ask.question === null || ask.question_answer !== null) {
    throw new AppError(ask.status === "done" || ask.status === "failed" || ask.status === "cancelled" ? "ASK_ALREADY_FINISHED" : "ASK_NOT_WAITING");
  }
  let answer: string;
  if (body.choiceId !== undefined) {
    const choice = ask.question.choices.find((c) => c.id === body.choiceId);
    if (choice === undefined) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "choiceId", reason: "選択肢にありません" }] });
    answer = choice.label;
  } else {
    if (!ask.question.allowFreeText) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "text", reason: "この質問は選択肢から選んでください" }] });
    answer = maskUserText(body.text as string, i.secrets);
  }
  const updated = setAskQuestionAnswer(db, askId, answer, now);
  if (updated === null) throw new AppError("ASK_NOT_WAITING");
  appendAuditLog(db, { eventType: "ask.question_answered", actorType: "user", actorId: i.userId, payload: { askId, choiceId: body.choiceId ?? null } }, now);
  return { ask: askSummary(updated) };
}
