// タスクの止め方と終わり方（FR-013・FR-014・FR-015、formation-runtime.md §3.10-6・§3.12、IA §3.18・§8-7）
// 止める・終えるときは同じトランザクションで：タスクの状態・トークンの失効・未実行の Intent と承認の失効（IA §8-7）・監査ログ・task_events。
// ワークスペースの行を先にロックしてから呼ぶ（監査ログの採番もワークスペースの行を取る：M-21）

import {
  formatUsd,
  nextTaskStatus,
  type DecideResult,
  type JsonObject,
} from "@open-team/kernel";
import {
  appendAuditLog,
  type HaltReason,
  type TaskFailReason,
  type TaskRow,
  type TaskStatus,
  type Tx,
  type WsCtx,
} from "@open-team/db";
import {
  endTask,
  expireOpenIntentsOfTask,
  insertTaskEvent,
  listTaskIntentStatuses,
  setTaskWaitingStatus,
  type TaskEndChange,
} from "@open-team/db/edge";
import type { SpendDenied } from "./spend.ts";

/** 止めた理由（tasks.halt_reason と、監査ログの中身） */
export type HaltCause =
  | { reason: "kill_switch" }
  | { reason: "budget_exceeded" | "timeout"; audit: JsonObject }
  | { reason: "breaker_tripped"; audit: JsonObject };

/** decide の halt から止めた理由へ（task_terminated は状態を変えない：KD §3.4-6）。max_minutes の超過は timeout（FR §8-31） */
export function haltCauseOf(result: DecideResult): HaltCause | null {
  if (result.decision !== "halt") return null;
  switch (result.reasonCode) {
    case "kill_switch":
      return { reason: "kill_switch" };
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

async function recordStatusChange(
  tx: Tx,
  ctx: WsCtx,
  before: TaskStatus,
  after: TaskRow,
  extra: JsonObject,
  now: Date,
  actor: { type: "system" | "agent"; id: string | null },
): Promise<void> {
  const payload: JsonObject = { taskId: after.id, from: before, to: after.status, ...extra };
  await appendAuditLog(tx, ctx.workspaceId, { eventType: "task.status_changed", actorType: actor.type, actorId: actor.id, taskId: after.id, payload }, now);
  await insertTaskEvent(tx, ctx, after.id, "status_changed", { from: before, to: after.status, ...extra }, now);
}

/**
 * タスクを halted にする（トークンの失効・未実行の Intent と承認の失効・監査ログ）。Kill Switch の Intent は expired(kill_switch)、
 * ほかは expired(task_ended)（IA §8-7）。すでに終了状態なら何もしないで null
 */
export async function haltTask(tx: Tx, ctx: WsCtx, task: Pick<TaskRow, "id" | "status">, cause: HaltCause, now: Date): Promise<TaskRow | null> {
  const ended = await endTask(tx, ctx, task.id, { status: "halted", haltReason: cause.reason as HaltReason }, now);
  if (ended === null) return null;
  const expired = await expireOpenIntentsOfTask(tx, ctx, task.id, cause.reason === "kill_switch" ? "kill_switch" : "task_ended", now);
  await recordStatusChange(tx, ctx, task.status, ended, { haltReason: cause.reason, expiredIntents: expired.intentIds.length }, now, {
    type: "system",
    id: "edge",
  });
  if (cause.reason === "budget_exceeded" || cause.reason === "timeout") {
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      { eventType: "budget.exceeded", actorType: "system", actorId: "edge", taskId: task.id, payload: { taskId: task.id, ...cause.audit } },
      now,
    );
  } else if (cause.reason === "breaker_tripped") {
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      { eventType: "breaker.tripped", actorType: "system", actorId: "edge", taskId: task.id, payload: { taskId: task.id, ...cause.audit } },
      now,
    );
  }
  return ended;
}

/** タスクを failed にする（llm_unavailable・agent_no_change・agent_unable など）。トークンの失効と Intent の失効（task_ended）も */
export async function failTask(
  tx: Tx,
  ctx: WsCtx,
  task: Pick<TaskRow, "id" | "status">,
  failReason: TaskFailReason,
  now: Date,
  extra: JsonObject = {},
  actor: { type: "system" | "agent"; id: string | null } = { type: "system", id: "edge" },
): Promise<TaskRow | null> {
  const ended = await endTask(tx, ctx, task.id, { status: "failed", failReason }, now);
  if (ended === null) return null;
  const expired = await expireOpenIntentsOfTask(tx, ctx, task.id, "task_ended", now);
  await recordStatusChange(tx, ctx, task.status, ended, { failReason, expiredIntents: expired.intentIds.length, ...extra }, now, actor);
  return ended;
}

/**
 * エージェントのループが終わった（submit_report）あとのタスクの状態（formation-runtime.md §3.12 finalizeTaskAfterLoop、IA §3.18）。
 * pending_approval → awaiting_approval、approved・executing → executing、どちらもない → computeTaskEnding で終了状態。
 * 終了状態になったら terminal: true（呼び出し側は onTaskTerminal を呼ぶ）
 */
export async function finalizeTaskAfterLoop(tx: Tx, ctx: WsCtx, task: TaskRow, now: Date): Promise<{ status: TaskStatus; terminal: boolean; row: TaskRow | null }> {
  const intents = (await listTaskIntentStatuses(tx, ctx, task.id)).map((status) => ({ status }));
  const next = nextTaskStatus({
    status: task.status,
    loopEnded: true,
    isDryRun: task.is_dry_run,
    intents,
  });
  if (next.ending !== null) {
    const e = next.ending;
    const change: TaskEndChange =
      e.status === "succeeded"
        ? { status: "succeeded" }
        : e.status === "completed"
          ? { status: "completed", detail: e.detail }
          : { status: "failed", failReason: e.failReason };
    const ended = await endTask(tx, ctx, task.id, change, now);
    if (ended !== null) {
      const extra: JsonObject = e.status === "completed" ? { detail: e.detail } : e.status === "failed" ? { failReason: e.failReason } : {};
      await recordStatusChange(tx, ctx, task.status, ended, extra, now, { type: "system", id: "edge" });
    }
    return { status: ended?.status ?? task.status, terminal: ended !== null, row: ended };
  }
  if (next.status === "awaiting_approval" || next.status === "executing") {
    const row = await setTaskWaitingStatus(tx, ctx, task.id, next.status, now);
    if (row !== null && row.status !== task.status) await recordStatusChange(tx, ctx, task.status, row, {}, now, { type: "system", id: "edge" });
    return { status: row?.status ?? task.status, terminal: false, row };
  }
  return { status: next.status, terminal: false, row: null };
}
