// タスクのトークン（SO §3.10、rt:98、si:35）：256ビットの乱数、DB には SHA-256 だけ、期限 max_minutes + 5分。
// edge・gateway はトークンからワークスペース・タスク・kind を引き直す（runner の値を信じない：15:486）

import { EdgeError } from "@open-team/runner";
import { hashTaskToken, newSecretToken, wsCtxOf, type Queryable, type TaskRow, type TaskStatus, type Tx, type WorkspaceRow, type WsCtx } from "@open-team/db";
import { findTaskByTokenHash, getTask, setTaskToken } from "@open-team/db/edge";
import { EDGE_LIMITS } from "./limits.ts";
import { EdgeDataError, loadTaskPolicy } from "./inputs.ts";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["succeeded", "completed", "rejected", "failed", "cancelled", "halted"]);

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

/** トークンの長さの上限（base64url 43文字。長すぎる値でハッシュの計算に時間を使わせない） */
const TOKEN_MAX_LENGTH = 512;

/**
 * タスクにトークンを付ける（app の /internal/tasks/:id/run が runTask の前に呼ぶ）。生の値を返し、DB にはハッシュだけを入れる。
 * maxMinutes を省くと、タスクの仕事の実効ポリシーの budget.max_minutes。終了状態のタスクには付けない（例外）
 */
export async function issueTaskToken(tx: Tx, ctx: WsCtx, taskId: string, now: Date, opts: { maxMinutes?: number } = {}): Promise<string> {
  let maxMinutes = opts.maxMinutes;
  if (maxMinutes === undefined) {
    const task = await getTask(tx, ctx, taskId);
    if (task === null) throw new EdgeDataError(`タスク ${taskId} が見つからない`);
    maxMinutes = (await loadTaskPolicy(tx, ctx, task)).policy.budget.max_minutes;
  }
  if (!Number.isFinite(maxMinutes) || maxMinutes < 0) throw new RangeError(`max_minutes が正しくない：${String(maxMinutes)}`);
  const raw = newSecretToken();
  const expiresAt = new Date(now.getTime() + (maxMinutes + EDGE_LIMITS.tokenTtlExtraMinutes) * 60_000);
  const ok = await setTaskToken(tx, ctx, taskId, hashTaskToken(raw), expiresAt, now);
  if (!ok) throw new EdgeDataError(`タスク ${taskId} にトークンを付けられない（終了状態か、見つからない）`);
  return raw;
}

export interface ResolvedTask {
  ctx: WsCtx;
  task: TaskRow;
  workspace: WorkspaceRow;
}

/** TASK_HALTED の details（runner は details.haltReason を読む） */
export function haltedDetails(task: Pick<TaskRow, "status" | "halt_reason" | "fail_reason">, workspace?: Pick<WorkspaceRow, "kill_switch_engaged">): {
  haltReason: string;
  status: TaskStatus;
} {
  const haltReason =
    task.halt_reason ?? (workspace?.kill_switch_engaged ? "kill_switch" : null) ?? task.fail_reason ?? (TERMINAL.has(task.status) ? "task_terminated" : task.status);
  return { haltReason, status: task.status };
}

/**
 * トークンからタスクを引き直す（SO §3.10 resolveTaskByToken）。
 * 空・形が違う・見つからない・期限切れ（ちょうども）→ 401 UNAUTHORIZED。終了状態・Kill Switch 発動中 → 409 TASK_HALTED。
 * allow（既定は running だけ）にない状態も TASK_HALTED（LLM の呼び出しは running のタスクだけ：si:106）
 */
export async function resolveTaskByToken(
  q: Queryable,
  rawToken: unknown,
  now: Date,
  opts: { allow?: readonly TaskStatus[] } = {},
): Promise<ResolvedTask> {
  if (typeof rawToken !== "string" || rawToken === "" || rawToken.length > TOKEN_MAX_LENGTH) throw new EdgeError("UNAUTHORIZED");
  const hit = await findTaskByTokenHash(q, hashTaskToken(rawToken), now);
  if (hit === null) throw new EdgeError("UNAUTHORIZED");
  const { task, workspace } = hit;
  if (TERMINAL.has(task.status) || workspace.kill_switch_engaged) throw new EdgeError("TASK_HALTED", haltedDetails(task, workspace));
  const allow = opts.allow ?? ["running"];
  if (!allow.includes(task.status)) throw new EdgeError("TASK_HALTED", haltedDetails(task, workspace));
  return { ctx: wsCtxOf(workspace), task, workspace };
}
