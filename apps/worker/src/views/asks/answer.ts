// 依頼の回答（FR-063）の表示の部分（apps/app/src/asks/answer.ts の表示の部分の WorkspaceDO 版）。
// 保存した回答（ask_runs.answer）を画面の形にするところと、担当ごとの最新のタスクだけ。
// 回答を組み立てて保存する（composeRunAnswer・persistAnswer）は実行と一緒に第4段で移す

import type { ComposedAnswer } from "@open-team/kernel";
import type { AskRunRow, TaskRow } from "../../db/types.ts";
import type { AskAnswerView } from "./contract.ts";
import { answerView } from "./format.ts";

/** 担当ごとの最新のタスク（やり直しは新しいタスクが後ろに並ぶ。追いのターン・作り直しは回答の材料にしない：FR-064） */
export function latestTaskByMember(tasks: readonly TaskRow[]): Map<string, TaskRow> {
  const out = new Map<string, TaskRow>();
  for (const t of tasks) if (t.ask_member_id !== null && t.kind === "normal") out.set(t.ask_member_id, t);
  return out;
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

/** 保存した回答を画面の形にする */
export function storedAnswerView(run: Pick<AskRunRow, "answer" | "answered_at">): AskAnswerView | null {
  if (run.answer === null) return null;
  const stored = run.answer as unknown as RunAnswer & { updatedAt?: string };
  return answerView(stored, { answeredAt: run.answered_at, updatedAt: stored.updatedAt ?? (run.answered_at ?? new Date(0)).toISOString() });
}
