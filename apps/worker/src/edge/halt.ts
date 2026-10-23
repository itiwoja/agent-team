// タスクの止め方と終わり方（packages/edge/src/halt.ts の WorkspaceDO 版。FR-013・FR-014・FR-015、formation-runtime.md §3.10-6・§3.12、IA §3.18・§8-7）
// 止める・終えるときは同じトランザクションで：タスクの状態・トークンの失効・未実行の Intent と承認の失効（IA §8-7）・監査ログ・task_events。
// Node 版との違い：どれも同期で、呼ぶ側の db.transaction の中で呼ぶ（ワークスペースの行のロックは要らない：DO の中は1本の流れ）。
// endTask はトークンの列も空にする（WorkspaceDO 版はトークンを使わないが、列は残っている）

import { formatUsd, nextTaskStatus, type DecideResult, type JsonObject } from "@open-team/kernel";
import { appendAuditLog } from "../db/audit.ts";
import { endTask, expireOpenIntentsOfTask, insertTaskEvent, listTaskIntentStatuses, setTaskWaitingStatus, type TaskEndChange } from "../db/repo/edge.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { HaltReason, TaskFailReason, TaskRow, TaskStatus } from "../db/types.ts";
import type { SpendDenied } from "./spend.ts";

/** 止めた理由（tasks.halt_reason と、監査ログの中身） */
export type HaltCause =
  | { reason: "budget_exceeded" | "timeout"; audit: JsonObject }
  | { reason: "breaker_tripped"; audit: JsonObject };

/** decide の halt から止めた理由へ（task_terminated は状態を変えない：KD §3.4-6）。max_minutes の超過は timeout（FR §8-31） */
export function haltCauseOf(result: DecideResult): HaltCause | null {
  if (result.decision !== "halt") return null;
  switch (result.reasonCode) {
    case "budget_exceeded": {
      const d = result.detail;
      if (d?.kind === "budget") {
        const audit: JsonObject = {
          item: d.item,
          matchedRule: result.matchedRule,
          ...(d.item === "max_steps" || d.item === "max_minutes"
            ? { used: d.used, adding: d.adding, limit: d.limit }
            : { usedUsd: formatUsd(d.used), addingUsd: formatUsd(d.adding), limitUsd: formatUsd(d.limit) }),
        };
        return { reason: d.item === "max_minutes" ? "timeout" : "budget_exceeded", audit };
      }
      return { reason: "budget_exceeded", audit: { matchedRule: result.matchedRule } };
    }
    case "breaker_tripped": {
      const d = result.detail;
      const audit: JsonObject =
        d?.kind === "breaker" ? { breaker: d.breaker, value: d.value, threshold: d.threshold } : { matchedRule: result.matchedRule };
      return { reason: "breaker_tripped", audit };
    }
    default:
      return null;
  }
}

/** checkSpend の拒否から止めた理由へ（全体 $15：BR-62。SO §3.12-3） */
export function haltCauseOfSpend(d: SpendDenied): HaltCause {
  return {
    reason: "budget_exceeded",
    audit: {
      scope: d.scope,
      limitUsd: formatUsd(d.limitMicroUsd / 1_000_000),
      spentUsd: formatUsd(d.spentMicroUsd / 1_000_000),
      estimatedUsd: formatUsd(d.estimatedMicroUsd / 1_000_000),
    },
  };
}

function recordStatusChange(
  db: WsDb,
  before: TaskStatus,
  after: TaskRow,
  extra: JsonObject,
  now: Date,
  actor: { type: "system" | "agent"; id: string | null },
): void {
  const payload: JsonObject = { taskId: after.id, from: before, to: after.status, ...extra };
  appendAuditLog(db, { eventType: "task.status_changed", actorType: actor.type, actorId: actor.id, taskId: after.id, payload }, now);
  insertTaskEvent(db, after.id, "status_changed", { from: before, to: after.status, ...extra }, now);
}

/**
 * タスクを halted にする（トークンの失効・未実行の Intent と承認の失効・監査ログ）。Intent は expired(task_ended)（IA §8-7）。すでに終了状態なら何もしないで null
 */
export function haltTask(db: WsDb, task: Pick<TaskRow, "id" | "status">, cause: HaltCause, now: Date): TaskRow | null {
  const ended = endTask(db, task.id, { status: "halted", haltReason: cause.reason as HaltReason }, now);
  if (ended === null) return null;
  const expired = expireOpenIntentsOfTask(db, task.id, "task_ended", now);
  recordStatusChange(db, task.status, ended, { haltReason: cause.reason, expiredIntents: expired.intentIds.length }, now, { type: "system", id: "edge" });
  if (cause.reason === "budget_exceeded" || cause.reason === "timeout") {
    appendAuditLog(db, { eventType: "budget.exceeded", actorType: "system", actorId: "edge", taskId: task.id, payload: { taskId: task.id, ...cause.audit } }, now);
  } else if (cause.reason === "breaker_tripped") {
    appendAuditLog(db, { eventType: "breaker.tripped", actorType: "system", actorId: "edge", taskId: task.id, payload: { taskId: task.id, ...cause.audit } }, now);
  }
  return ended;
}

/** タスクを failed にする（llm_unavailable・agent_no_change・agent_unable など）。トークンの失効と Intent の失効（task_ended）も */
export function failTask(
  db: WsDb,
  task: Pick<TaskRow, "id" | "status">,
  failReason: TaskFailReason,
  now: Date,
  extra: JsonObject = {},
  actor: { type: "system" | "agent"; id: string | null } = { type: "system", id: "edge" },
): TaskRow | null {
  const ended = endTask(db, task.id, { status: "failed", failReason }, now);
  if (ended === null) return null;
  const expired = expireOpenIntentsOfTask(db, task.id, "task_ended", now);
  recordStatusChange(db, task.status, ended, { failReason, expiredIntents: expired.intentIds.length, ...extra }, now, actor);
  return ended;
}

/**
 * エージェントのループが終わった（submit_report）あとのタスクの状態（formation-runtime.md §3.12 finalizeTaskAfterLoop、IA §3.18）。
 * pending_approval → awaiting_approval、approved・executing → executing、どちらもない → computeTaskEnding で終了状態。
 * 終了状態になったら terminal: true
 */
export function finalizeTaskAfterLoop(db: WsDb, task: TaskRow, now: Date): { status: TaskStatus; terminal: boolean; row: TaskRow | null } {
  const intents = listTaskIntentStatuses(db, task.id).map((status) => ({ status }));
  const next = nextTaskStatus({ status: task.status, loopEnded: true, isDryRun: task.is_dry_run, intents });
  if (next.ending !== null) {
    const e = next.ending;
    const change: TaskEndChange =
      e.status === "succeeded"
        ? { status: "succeeded" }
        : e.status === "completed"
          ? { status: "completed", detail: e.detail }
          : { status: "failed", failReason: e.failReason };
    const ended = endTask(db, task.id, change, now);
    if (ended !== null) {
      const extra: JsonObject = e.status === "completed" ? { detail: e.detail } : e.status === "failed" ? { failReason: e.failReason } : {};
      recordStatusChange(db, task.status, ended, extra, now, { type: "system", id: "edge" });
    }
    return { status: ended?.status ?? task.status, terminal: ended !== null, row: ended };
  }
  if (next.status === "awaiting_approval" || next.status === "executing") {
    const row = setTaskWaitingStatus(db, task.id, next.status, now);
    if (row !== null && row.status !== task.status) recordStatusChange(db, task.status, row, {}, now, { type: "system", id: "edge" });
    return { status: row?.status ?? task.status, terminal: false, row };
  }
  return { status: next.status, terminal: false, row: null };
}
