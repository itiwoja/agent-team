// 担当から利用者への質問（ask_user）に答える（POST /asks/:askId/questions/:questionId/answer）。
// 答えは agent_questions に書くだけで、待っている担当（edge の askUser）が見に来て受け取る。担当が待ちを終えていたら 409

import { appendAuditLog, lockWorkspace, type SessionCtx, type Uuid } from "@open-team/db";
import { answerAgentQuestion, getAgentQuestion } from "@open-team/db/asks";
import { sha256Hex } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import type { AnswerAgentQuestionBody } from "./contract.ts";
import { maskUserText } from "./create.ts";
import { emitAskEvent } from "./events.ts";

/** 押した選択肢と書いた文から、担当に渡す答えの文を作る（純粋関数）。選べない選択肢・書けない自由記述は null */
export function answerOf(
  q: { choices: ReadonlyArray<{ id: string; label: string }>; allow_free_text: boolean },
  body: AnswerAgentQuestionBody,
): string | null {
  const choice = body.choiceId === undefined ? null : (q.choices.find((c) => c.id === body.choiceId) ?? null);
  if (body.choiceId !== undefined && choice === null) return null;
  if (body.text !== undefined && !q.allow_free_text) return null;
  const parts = [choice?.label, body.text].filter((x): x is string => x !== undefined && x.trim() !== "");
  return parts.length === 0 ? null : parts.join("。").slice(0, 500);
}

export async function answerQuestion(deps: Pick<AppDeps, "db" | "clock">, s: SessionCtx, askId: Uuid, questionId: Uuid, body: AnswerAgentQuestionBody): Promise<void> {
  const found = await getAgentQuestion(deps.db, s, questionId);
  if (found === null || found.ask_id !== askId) throw new AppError("NOT_FOUND");
  const answer = answerOf(found, { ...body, ...(body.text === undefined ? {} : { text: maskUserText(body.text) }) });
  if (answer === null) throw new AppError("VALIDATION_ERROR", "この質問には、その答え方はできません", { details: [{ field: "choiceId", reason: "選択肢にないか、自由に書けない質問です" }] });
  await deps.db.transaction(
    async (tx) => {
      const now = deps.clock.now();
      await lockWorkspace(tx, s);
      const saved = await answerAgentQuestion(tx, s, questionId, { answer, userId: s.userId, now });
      if (saved === null) throw new AppError("ASK_NOT_WAITING", "担当はもう待っていません（自分で決めて進めています）");
      await appendAuditLog(
        tx,
        s.workspaceId,
        {
          eventType: "ask.agent_question.answered",
          actorType: "user",
          actorId: s.userId,
          taskId: saved.task_id,
          payload: { taskId: saved.task_id, askId, questionId, answerHash: sha256Hex(answer), choiceId: body.choiceId ?? null },
        },
        now,
      );
      await emitAskEvent(tx, s, { type: "ask.agent_question", askId, questionId, status: "answered" }, now);
    },
    { retryOnce: true },
  );
}
