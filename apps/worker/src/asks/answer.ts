// 依頼に1つの回答を返す（FR-063。apps/app/src/asks/answer.ts の組み立てと保存の部分の WorkspaceDO 版）：窓口の submit_report（kind = answer）を回答にし、
// 手が要るもの・誰が何をしたか・汚染の1行は Kernel の composeAnswer が固定の文で差し込む（LLM に書かせない：D-74）。LLM は呼ばない。
// 回答は ask_runs.answer に保存し、窓口のタスクを answer_task_id に結ぶ。
// 送る前の確認が残っていても待たずに出し、確認が済んだら手が要るものの行だけを書き換える（回答を作り直さない：ask.answer.updated）。
// 表示の部分（latestTaskByMember・answerExtrasOf・storedAnswerView・RunAnswer）は views/asks/answer.ts にあり、ここはそれを使う（重複させない）

import { composeAnswer, type AnswerMember } from "@open-team/kernel";
import { appendAuditLog } from "../db/audit.ts";
import { countRejectedIntentsOfTasks, listAskMessages, listPendingIntentsOfTasks, saveRunAnswer } from "../db/repo/asks.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { AskMemberRow, AskRow, AskRunRow, JsonObject, TaskRow } from "../db/types.ts";
import { answerExtrasOf, latestTaskByMember, type RunAnswer } from "../views/asks/answer.ts";
import { answerView } from "../views/asks/format.ts";
import { emitAskEvent } from "./accept.ts";

type MemberRowN = AskMemberRow & { agent_name: string };

export interface AnswerSources {
  ask: Pick<AskRow, "id" | "shape">;
  run: Pick<AskRunRow, "id">;
  members: readonly MemberRowN[];
  tasks: readonly TaskRow[];
}

export function composeRunAnswer(db: WsDb, s: AnswerSources, o: { stoppedBeforeEnd?: { agentName: string; reason: string } } = {}): RunAnswer {
  const latest = latestTaskByMember(s.tasks);
  // 送る前の確認で「送らない」にしたもの（D-108）。回答の担当の行と手が要るものの行に出す
  const declined = countRejectedIntentsOfTasks(
    db,
    [...latest.values()].map((t) => t.id),
  );
  const members: AnswerMember[] = s.members.map((m, i) => {
    const t = latest.get(m.id) ?? null;
    return {
      agentId: m.agent_id,
      agentName: m.agent_name,
      position: m.position ?? i + 1,
      isAggregator: m.is_aggregator,
      isSpokesperson: m.is_spokesperson,
      task:
        t === null
          ? null
          : {
              id: t.id,
              status: t.status,
              failReason: t.fail_reason,
              haltReason: t.halt_reason,
              taint: { tainted: t.tainted, sources: t.taint_sources },
              report: t.report === null ? null : { title: t.report_title ?? "", body: t.report },
              declinedWrites: declined.get(t.id) ?? 0,
            },
    };
  });
  const pending = listPendingIntentsOfTasks(
    db,
    s.tasks.map((t) => t.id),
  );
  const messages = s.ask.shape === "single" ? [] : listAskMessages(db, s.ask.id);
  const boardFacts = messages
    .filter((m) => m.kind === "question" && m.to_agent_name !== null)
    .map((m) => ({ fromAgentName: m.from_agent_name, toAgentName: m.to_agent_name as string, replied: messages.some((r) => r.kind === "reply" && r.in_reply_to === m.id) }));
  const composed = composeAnswer({
    shape: s.ask.shape ?? "single",
    members,
    pendingApprovals: pending.length,
    boardFacts,
    ...(o.stoppedBeforeEnd === undefined ? {} : { stoppedBeforeEnd: o.stoppedBeforeEnd }),
  });
  return o.stoppedBeforeEnd === undefined ? { ...composed, ...answerExtrasOf(composed.answerTaskId, latest) } : composed;
}

/**
 * 回答を保存する。内容（本文のハッシュ：結論・誰が何をしたか・手が要るもの・汚染の1行）が前と同じなら何もしない。
 * 最初は ask.answered、あとからの書き換え（手が要るものの行）は ask.answer.updated。窓口のタスクを answer_task_id に結ぶ。
 * 呼ぶ側のトランザクションの中で呼ぶ
 */
export function persistAnswer(
  db: WsDb,
  run: Pick<AskRunRow, "id" | "ask_id" | "answer_hash" | "answered_at">,
  composed: RunAnswer,
  now: Date,
): boolean {
  if (run.answer_hash === composed.bodyHash) return false;
  const updatedAt = now.toISOString();
  const stored = { ...composed, askRunId: run.id, updatedAt } as unknown as JsonObject;
  const saved = saveRunAnswer(db, run.id, { answerTaskId: composed.answerTaskId, answer: stored, answerHash: composed.bodyHash, now });
  if (saved === null) return false;
  const first = run.answered_at === null;
  const view = answerView(composed, { answeredAt: saved.answered_at, updatedAt });
  emitAskEvent(db, { type: first ? "ask.answered" : "ask.answer.updated", askId: run.ask_id, runId: run.id, answer: view }, now);
  appendAuditLog(
    db,
    {
      eventType: first ? "ask.answered" : "ask.answer.updated",
      actorType: "system",
      actorId: "asks",
      taskId: composed.answerTaskId,
      payload: { askId: run.ask_id, askRunId: run.id, answerTaskId: composed.answerTaskId, bodyHash: composed.bodyHash },
    },
    now,
  );
  return true;
}
