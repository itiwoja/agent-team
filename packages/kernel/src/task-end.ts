// タスクの状態の決め直しと終わり方（IA §3.18、intents.md:197-206）、止まった書き込み（IA §2.9・§3.21、M-26）
// 止まった書き込みは途中で保存せず、タスクが終了状態になった時に action_intents（decision・status・reason_code・
// destination_key・option_digest）・却下・タスクの halt から作る（M-26）。回帰の試験（FR-066）は1タスク1件で、その入力になる

import type { Decision, Hex64, IsoDateTime, JsonObject, TaskStatus, Uuid } from "./types.ts";

/** action_intents.status（IA §2.2、04/status.md） */
export const INTENT_STATUSES = [
  "proposed",
  "simulated",
  "denied",
  "pending_approval",
  "approved",
  "rejected",
  "expired",
  "executing",
  "executed",
  "verified",
  "failed",
  "unknown_outcome",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];
/** タスクの終わり方を決めるときに「まだ動いている」とみなす Intent（IA §2.2 INTENT_OPEN） */
export const INTENT_OPEN_STATUSES: readonly IntentStatus[] = ["proposed", "pending_approval", "approved", "executing"];

/** 終了状態（st:27）。終了状態は最終で、あとから変えない */
export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = ["succeeded", "completed", "rejected", "failed", "cancelled", "halted"];
/** completed の内訳（04/status.md:54） */
export const TASK_COMPLETED_DETAILS = ["dry_run", "report", "actions_declined"] as const;
export type TaskCompletedDetail = (typeof TASK_COMPLETED_DETAILS)[number];
/** failed の理由（04/status.md:53。runner_lost ではなく sandbox_lost：M-32） */
export const TASK_FAIL_REASONS = [
  "sandbox_lost",
  "provision_failed",
  "repo_too_large",
  "llm_unavailable",
  "diff_invalid",
  "base_conflict",
  "verify_mismatch",
  "precondition_failed",
  "agent_no_change",
  "agent_unable",
  "action_failed",
] as const;
export type TaskFailReason = (typeof TASK_FAIL_REASONS)[number];
/** halted の理由（04/status.md:52） */
export const TASK_HALT_REASONS = [
  "budget_exceeded",
  "breaker_tripped",
  "timeout",
  "kill_switch",
  "policy_violation",
  "approval_expired",
  "installation_removed",
  "agent_disabled",
] as const;
export type TaskHaltReason = (typeof TASK_HALT_REASONS)[number];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status);
}

/** Intent の結果で決まるタスクの終わり方 */
export type TaskEnding =
  | { status: "succeeded" }
  | { status: "completed"; detail: TaskCompletedDetail }
  | { status: "failed"; failReason: "action_failed" };

export interface TaskEndingInput {
  /** tasks.is_dry_run */
  isDryRun: boolean;
  intents: ReadonlyArray<{ status: IntentStatus }>;
}

/**
 * タスクの終わり方（IA §3.18、intents.md:201-206 の表を上から）：
 * 1 試し実行 → completed(dry_run)／2 Intent がない → completed(report)／
 * 3 failed・unknown_outcome を1つでも含む → failed(action_failed)／4 rejected・expired・denied を含む → completed(actions_declined)／
 * 5 すべて executed・verified → succeeded。
 * denied は表にないので「断られた」に入れる（IA §8-8）。それ以外の残り（simulated・まだ動いている Intent）は
 * 「すべて実行された」と言えないので completed(actions_declined)（succeeded にしない）
 */
export function computeTaskEnding(t: TaskEndingInput): TaskEnding {
  if (t.isDryRun) return { status: "completed", detail: "dry_run" };
  if (t.intents.length === 0) return { status: "completed", detail: "report" };
  const has = (...statuses: IntentStatus[]) => t.intents.some((i) => statuses.includes(i.status));
  if (has("failed", "unknown_outcome")) return { status: "failed", failReason: "action_failed" };
  if (t.intents.every((i) => i.status === "executed" || i.status === "verified")) return { status: "succeeded" };
  return { status: "completed", detail: "actions_declined" };
}

export interface NextTaskStatusInput extends TaskEndingInput {
  /** 今のタスクの状態 */
  status: TaskStatus;
  /** エージェントのループが終わった（submit_report・ループの終了）。awaiting_approval・executing は終わっている扱い */
  loopEnded: boolean;
}

/**
 * Intent の状態が変わるたび（承認・却下・期限切れ・置き換え・実行の結果）に呼ぶ、タスクの状態の決め直し（IA §3.18 nextTaskStatus）。
 * 1 終了状態なら変えない（unknown_outcome をあとで確定しても変えない）／2 ループが終わっていなければそのまま（running）／
 * 3 proposed・pending_approval がある → awaiting_approval、approved・executing がある → executing、どちらもない → computeTaskEnding。
 * ending は今回の呼び出しで終了状態に決まったときだけ入る（呼び出し側は status_detail・fail_reason と finished_at を書く）
 */
export function nextTaskStatus(t: NextTaskStatusInput): { status: TaskStatus; ending: TaskEnding | null } {
  if (isTerminalTaskStatus(t.status)) return { status: t.status, ending: null };
  const loopEnded = t.loopEnded === true || t.status === "awaiting_approval" || t.status === "executing";
  if (!loopEnded) return { status: t.status, ending: null };
  if (t.intents.some((i) => i.status === "proposed" || i.status === "pending_approval")) return { status: "awaiting_approval", ending: null };
  if (t.intents.some((i) => i.status === "approved" || i.status === "executing")) return { status: "executing", ending: null };
  const ending = computeTaskEnding(t);
  return { status: ending.status, ending };
}
