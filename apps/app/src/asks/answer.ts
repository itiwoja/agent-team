// 依頼に1つの回答を返す（FR-063）：窓口の submit_report（kind = answer）を回答にし、手が要るもの・誰が何をしたか・汚染の1行は Kernel の composeAnswer が
// 固定の文で差し込む（LLM に書かせない：D-74）。LLM は呼ばない。回答は ask_runs.answer に保存し、窓口のタスクを answer_task_id に結ぶ。
// 送る前の確認が残っていても待たずに出し、確認が済んだら手が要るものの行だけを書き換える（回答を作り直さない：ask.answer.updated）

import type { AskMemberRow, AskRow, AskRunRow, Queryable, TaskRow, Tx, WsCtx } from "@open-team/db";
import { appendAuditLog } from "@open-team/db";
import { composeAnswer, type AnswerMember, type ComposedAnswer, type JsonObject } from "@open-team/kernel";
import { countRejectedIntentsOfTasks, listAskMessages, listPendingIntentsOfTasks, saveRunAnswer } from "@open-team/db/asks";
import type { AskAnswerView } from "./contract.ts";
import { emitAskEvent } from "./events.ts";
import { answerView } from "./format.ts";

type MemberRowN = AskMemberRow & { agent_name: string };

/** 担当ごとの最新のタスク（やり直しは新しいタスクが後ろに並ぶ。追いのターン・作り直しは回答の材料にしない：FR-064） */
export function latestTaskByMember(tasks: readonly TaskRow[]): Map<string, TaskRow> {
  const out = new Map<string, TaskRow>();
  for (const t of tasks) if (t.ask_member_id !== null && t.kind === "normal") out.set(t.ask_member_id, t);
  return out;
}

export interface AnswerSources {
  ask: Pick<AskRow, "id" | "shape">;
  run: Pick<AskRunRow, "id">;
  members: readonly MemberRowN[];
  tasks: readonly TaskRow[];
}

/**
 * 回答（Kernel の composeAnswer）に、報告のメタ（tasks.report_meta）から足すもの。
 * nextActions：回答を書いた窓口の「次の手の提案」。unchanged：見張りの担当がみな「前回から変化なし」と報告した（画面は静かに出す）
 */
export type RunAnswer = ComposedAnswer & { nextActions?: string[]; unchanged?: boolean };

/** 報告のメタから回答に足すもの（純粋関数） */
export function answerExtrasOf(answerTaskId: string | null, latest: ReadonlyMap<string, Pick<TaskRow, "id" | "report" | "report_meta">>): { nextActions?: string[]; unchanged?: boolean } {
  const tasks = [...latest.values()].filter((t) => t.report !== null);
  const writer = answerTaskId === null ? undefined : tasks.find((t) => t.id === answerTaskId);
  const nextActions = writer?.report_meta?.nextActions ?? [];
  // 変化の有無を言った担当がいて、言った担当がみな「変化なし」のとき
  const said = tasks.filter((t) => typeof t.report_meta?.changed === "boolean");
  const unchanged = said.length > 0 && said.every((t) => t.report_meta?.changed === false);
  return { ...(nextActions.length > 0 ? { nextActions: [...nextActions] } : {}), ...(unchanged ? { unchanged: true } : {}) };
}

export async function composeRunAnswer(
  q: Queryable,
  ctx: WsCtx,
  s: AnswerSources,
  o: { stoppedBeforeEnd?: { agentName: string; reason: string } } = {},
): Promise<RunAnswer> {
  const latest = latestTaskByMember(s.tasks);
  // 送る前の確認で「送らない」にしたもの（D-108）。回答の担当の行と手が要るものの行に出す
  const declined = await countRejectedIntentsOfTasks(
    q,
    ctx,
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
  const pending = await listPendingIntentsOfTasks(
    q,
    ctx,
    s.tasks.map((t) => t.id),
  );
  const messages = s.ask.shape === "single" ? [] : await listAskMessages(q, ctx, s.ask.id);
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

/** 保存した回答を画面の形にする */
export function storedAnswerView(run: Pick<AskRunRow, "answer" | "answered_at">): AskAnswerView | null {
  if (run.answer === null) return null;
  const stored = run.answer as unknown as RunAnswer & { updatedAt?: string };
  return answerView(stored, { answeredAt: run.answered_at, updatedAt: stored.updatedAt ?? (run.answered_at ?? new Date(0)).toISOString() });
}

/**
 * 回答を保存する。内容（本文のハッシュ：結論・誰が何をしたか・手が要るもの・汚染の1行）が前と同じなら何もしない。
 * 最初は ask.answered、あとからの書き換え（手が要るものの行）は ask.answer.updated。窓口のタスクを answer_task_id に結ぶ
 */
export async function persistAnswer(
  tx: Tx,
  ctx: WsCtx,
  run: Pick<AskRunRow, "id" | "ask_id" | "answer_hash" | "answered_at">,
  composed: RunAnswer,
  now: Date,
): Promise<boolean> {
  if (run.answer_hash === composed.bodyHash) return false;
  const updatedAt = now.toISOString();
  const stored = { ...composed, askRunId: run.id, updatedAt } as unknown as JsonObject;
  const saved = await saveRunAnswer(tx, ctx, run.id, { answerTaskId: composed.answerTaskId, answer: stored, answerHash: composed.bodyHash, now });
  if (saved === null) return false;
  const first = run.answered_at === null;
  const view = answerView(composed, { answeredAt: saved.answered_at, updatedAt });
  await emitAskEvent(tx, ctx, { type: first ? "ask.answered" : "ask.answer.updated", askId: run.ask_id, runId: run.id, answer: view }, now);
  await appendAuditLog(
    tx,
    ctx.workspaceId,
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
