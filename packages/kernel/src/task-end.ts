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
  /** リハーサルの走行のタスク（rehearsal_run_id あり）。is_dry_run でも Intent は sim-world に実行される（15:121） */
  rehearsal: boolean;
  intents: ReadonlyArray<{ status: IntentStatus }>;
}

/**
 * タスクの終わり方（IA §3.18、intents.md:201-206 の表を上から）：
 * 1 試し実行（リハーサルでない）→ completed(dry_run)／2 Intent がない → completed(report)／
 * 3 failed・unknown_outcome を1つでも含む → failed(action_failed)／4 rejected・expired・denied を含む → completed(actions_declined)／
 * 5 すべて executed・verified → succeeded。
 * denied は表にないので「断られた」に入れる（IA §8-8）。それ以外の残り（simulated・まだ動いている Intent）は
 * 「すべて実行された」と言えないので completed(actions_declined)（succeeded にしない）
 */
export function computeTaskEnding(t: TaskEndingInput): TaskEnding {
  if (t.isDryRun && !t.rehearsal) return { status: "completed", detail: "dry_run" };
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

// ここから止まった書き込み（BR-80・O-08）

/** 止まり方（IA §2.9 stoppedBy。rehearsal_cases.incident_kind と同じ値：M-27 で user_reject） */
export const STOPPED_WRITE_KINDS = ["kernel_approve", "kernel_deny", "user_reject", "kill_switch"] as const;
export type StoppedWriteKind = (typeof STOPPED_WRITE_KINDS)[number];

/** 本番で止まった書き込み（IA §2.9）。rehearsal_cases.stopped_writes に入れ、O-08 が action・destinationKey・optionDigest で照合する */
export interface StoppedWrite {
  intentId: Uuid;
  sourceTaskId: Uuid;
  jobId: Uuid;
  action: string;
  destinationKey: Hex64;
  /** free を含む全 option の正規形のハッシュ（G-05。content は含まない） */
  optionDigest: Hex64;
  /** 元の引数の写し（マスク済みのものを呼び出し側が渡す）。タスクの保持より長く残すため写す */
  argumentsSnapshot: JsonObject;
  stoppedBy: StoppedWriteKind;
  /** decide の reasonCode。却下は元の Intent の reasonCode（障害 ID を引くため：SW §4.7-5）、Kill Switch は 'kill_switch' */
  reasonCode: string;
  occurredAt: IsoDateTime;
}

export interface TaskEndIntent {
  id: Uuid;
  action: string;
  /** payload.arguments（マスク済み） */
  arguments: JsonObject;
  destinationKey: Hex64;
  optionDigest: Hex64;
  decision: Decision;
  reasonCode: string;
  status: IntentStatus;
  /** action_intents.expire_reason（kill_switch など） */
  expireReason: string | null;
  createdAt: IsoDateTime;
  /** 承認の decided_at（却下の時刻）。なければ createdAt を使う */
  decidedAt: IsoDateTime | null;
}

export interface TaskEndInput {
  task: {
    id: Uuid;
    jobId: Uuid;
    isDryRun: boolean;
    shadow: boolean;
    rehearsalRunId: Uuid | null;
    status: TaskStatus;
    haltReason: string | null;
    /** 動き始めた時刻（running になった時刻）。null は queued・provisioning のまま止まったもの */
    startedAt: IsoDateTime | null;
    /** 終了状態になった時刻（Kill Switch の時刻に使う） */
    finishedAt: IsoDateTime | null;
  };
  intents: readonly TaskEndIntent[];
}

export interface TaskStopRecord {
  /** BR-80 のきっかけがあった（incident の試験を1件作る） */
  incident: boolean;
  /** 実行中（running・awaiting_approval・executing）に Kill Switch で止まった */
  killSwitch: boolean;
  stoppedWrites: StoppedWrite[];
  /** 試験の reason_code・incident_kind に入れる代表（いちばん早く止まったもの。Kill Switch だけなら kill_switch） */
  primary: { kind: StoppedWriteKind; reasonCode: string } | null;
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function timeOf(t: IsoDateTime): number {
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * タスクが終了状態になった時に、そのタスクの止まった書き込みをまとめる（M-26、IA §3.21、SW §4.7、15:190-193）。
 * 本番（!is_dry_run・!shadow・rehearsal_run_id なし）だけ。Intent ごとに1件で、強い順に：
 * 1 却下（status = rejected）→ user_reject／2 decision = deny（handoff も Intent にならないので同じ扱い）→ kernel_deny／
 * 3 decision = approve → kernel_approve（certificate_missing は記録しない：合格証の切れと確認が繰り返すため。IA §3.21-2）／
 * 4 実行中に Kill Switch で止まったタスクの、Kill Switch で失効した・halt(kill_switch) の Intent → kill_switch。
 * 人が承認して実行された approve も kernel_approve に入る（同じ書き込みが次から確認なしで出ないことを O-08 で確かめる）。
 * 予算・Breaker の halt は BR-80 のきっかけに入れない（障害 ID はタスクの halt_reason から rehearsal が決める）
 */
export function stoppedWritesOfTask(input: TaskEndInput): TaskStopRecord {
  const t = input.task;
  if (t.isDryRun !== false || t.shadow !== false || t.rehearsalRunId !== null) {
    return { incident: false, killSwitch: false, stoppedWrites: [], primary: null };
  }
  // 実行中＝ running・awaiting_approval・executing（IA §8-18）。動き始めていない queued・provisioning は除く
  const killSwitch = t.status === "halted" && t.haltReason === "kill_switch" && t.startedAt !== null;
  const stoppedWrites: StoppedWrite[] = [];
  for (const i of input.intents) {
    let kind: StoppedWriteKind | null = null;
    let reasonCode = i.reasonCode;
    let occurredAt = i.createdAt;
    if (i.status === "rejected") {
      kind = "user_reject";
      occurredAt = i.decidedAt ?? i.createdAt;
    } else if (i.decision === "deny" || i.decision === "handoff") {
      kind = "kernel_deny";
    } else if (i.decision === "approve" && i.reasonCode !== "certificate_missing") {
      kind = "kernel_approve";
    } else if (
      killSwitch &&
      ((i.status === "expired" && i.expireReason === "kill_switch") || (i.decision === "halt" && i.reasonCode === "kill_switch"))
    ) {
      kind = "kill_switch";
      reasonCode = "kill_switch";
      occurredAt = t.finishedAt ?? i.createdAt;
    }
    if (kind === null) continue;
    stoppedWrites.push({
      intentId: i.id,
      sourceTaskId: t.id,
      jobId: t.jobId,
      action: i.action,
      destinationKey: i.destinationKey,
      optionDigest: i.optionDigest,
      argumentsSnapshot: cloneJson(i.arguments),
      stoppedBy: kind,
      reasonCode,
      occurredAt,
    });
  }
  let primary: TaskStopRecord["primary"] = null;
  let best = Number.POSITIVE_INFINITY;
  for (const s of stoppedWrites) {
    const ms = timeOf(s.occurredAt);
    if (primary === null || ms < best) {
      primary = { kind: s.stoppedBy, reasonCode: s.reasonCode };
      best = ms;
    }
  }
  if (primary === null && killSwitch) primary = { kind: "kill_switch", reasonCode: "kill_switch" };
  return { incident: stoppedWrites.length > 0 || killSwitch, killSwitch, stoppedWrites, primary };
}
