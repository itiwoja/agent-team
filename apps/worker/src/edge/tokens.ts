// タスクの引き直し（packages/edge/src/tokens.ts の resolveTaskByToken の WorkspaceDO 版。SO §3.10）。
// Node 版はタスクのトークン（256ビットの乱数。DB には SHA-256）からワークスペース・タスクを引き直していた（runner の値を信じない：15:486）。
// WorkspaceDO 版は Workflow の引数に秘密を載せないため、トークンの代わりに taskId を使う（task_token_hash の列は使わない）。
// ワークスペースは DO そのもの（別のワークスペースのタスクは、その DO の SQLite にないので引けない）。状態の確かめは Node 版と同じ。
// トークンの失効の代わり：Node 版は報告の受け付け（submit_report）でトークンを失効させ、以後の呼び出しを 401 にしていた（BD-06）。
// ここでは報告が保存済みのタスクを UNAUTHORIZED にする

import { EdgeError } from "@open-team/runner";
import { getTask } from "../db/repo/edge.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { TaskRow, TaskStatus, WorkspaceRow } from "../db/types.ts";
import { TASK_TERMINAL } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(TASK_TERMINAL);

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

/** taskId の長さの上限（UUID は36文字。長すぎる値で問い合わせない） */
const TASK_ID_MAX_LENGTH = 64;

export interface ResolvedTask {
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
 * taskId からタスクを引き直す（SO §3.10 resolveTaskByToken の代わり）。
 * 空・形が違う・見つからない・報告が保存済み → 401 UNAUTHORIZED。終了状態・Kill Switch 発動中 → 409 TASK_HALTED。
 * allow（既定は running だけ）にない状態も TASK_HALTED（LLM の呼び出しは running のタスクだけ：si:106）。
 * now は Node 版のトークンの期限の確かめに使っていた（max_minutes の超過は decide(llm_call) の timeout が止める）
 */
export function resolveTask(db: WsDb, taskId: unknown, now: Date, allow: readonly TaskStatus[] = ["running"]): ResolvedTask {
  void now;
  if (typeof taskId !== "string" || taskId === "" || taskId.length > TASK_ID_MAX_LENGTH) throw new EdgeError("UNAUTHORIZED");
  const task = getTask(db, taskId);
  const workspace = getWorkspace(db);
  if (task === null || workspace === null || task.report !== null) throw new EdgeError("UNAUTHORIZED");
  if (TERMINAL.has(task.status) || workspace.kill_switch_engaged) throw new EdgeError("TASK_HALTED", haltedDetails(task, workspace));
  if (!allow.includes(task.status)) throw new EdgeError("TASK_HALTED", haltedDetails(task, workspace));
  return { task, workspace };
}
