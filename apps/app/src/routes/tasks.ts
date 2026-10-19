// API-016：POST /api/v1/tasks/{taskId}/cancel（やっていることの取り消し）。権限は依頼者本人か owner（403）、終了済みは 409 TASK_ALREADY_TERMINATED。
// 1つのトランザクションで、タスクを cancelled（status_detail = user）・トークン失効・未実行の Intent と待っている承認を expired（task_cancelled）・
// 監査ログ task.cancelled・SSE の事象を書き、コミットのあと動いているこのインスタンスのタスクを中断する（Kill Switch と同じ登録簿）。
// 承認の行は消える。試し実行・リハーサル・影のタスクは別の経路（リハーサルの取り消し）なので 404 にする

import { appendAuditLog, lockWorkspace, type SessionCtx } from "@open-team/db";
import { endTask, expireOpenIntentsOfTask, insertTaskEvent, lockTask } from "@open-team/db/edge";
import { isProductionTask } from "@open-team/db/check";
import { getLatestTaskSnapshot } from "@open-team/db/sandbox";
import { AppError } from "@open-team/platform";
import { type CancelTaskResponse } from "../check/contract.ts";
import { publishCheckCounts, publishCheckRemove } from "../check/events.ts";
import type { AppDeps } from "../deps.ts";
import { idParam, sessionOf } from "../http.ts";
import type { ApiRouter } from "./router.ts";

export async function cancelTask(deps: AppDeps, s: SessionCtx, taskId: string): Promise<CancelTaskResponse> {
  const now = deps.clock.now();
  const out = await deps.db.transaction(
    async (tx) => {
      const ws = await lockWorkspace(tx, s);
      if (ws === null) throw new AppError("NOT_FOUND");
      const task = await lockTask(tx, s, taskId);
      if (task === null || !isProductionTask(task)) throw new AppError("NOT_FOUND");
      if (!(s.role === "owner" || task.requester_id === s.userId)) throw new AppError("FORBIDDEN");
      // 待っていた承認の行を消すために、期限切れにする前に ID を控える
      const pending = await tx.query<{ id: string }>("SELECT id FROM approvals WHERE workspace_id = $1 AND task_id = $2 AND status = 'pending'", [s.workspaceId, taskId]);
      const ended = await endTask(tx, s, taskId, { status: "cancelled", detail: "user" }, now);
      if (ended === null) throw new AppError("TASK_ALREADY_TERMINATED");
      const expired = await expireOpenIntentsOfTask(tx, s, taskId, "task_cancelled", now);
      await insertTaskEvent(tx, s, taskId, "status_changed", { from: task.status, to: "cancelled", detail: "user" }, now);
      await insertTaskEvent(tx, s, taskId, "finished", { outcome: "cancelled", detail: "user" }, now);
      await appendAuditLog(
        tx,
        s.workspaceId,
        { eventType: "task.cancelled", actorType: "user", actorId: s.userId, taskId, payload: { taskId, from: task.status, expiredIntentIds: expired.intentIds } },
        now,
      );
      for (const a of pending.rows) await publishCheckRemove(tx, s, `approval:${a.id}`, now);
      for (const hook of deps.hooks.taskSettled ?? []) await hook(tx, s, { taskId, status: "cancelled", now });
      await publishCheckCounts(tx, deps, s, now);
      return { expiredApprovals: expired.approvals };
    },
    { retryOnce: true },
  );
  // 動いているこのインスタンスのタスクを止める（ほかのインスタンスは終了状態の見回りで止まる：registry.ts）
  deps.registry.abortTask(taskId, "task_terminated");
  deps.log.info("task.cancelled", "タスクを取り消した", { workspaceId: s.workspaceId, taskId });
  return { taskId, status: "cancelled", expiredApprovals: out.expiredApprovals };
}

export function taskRoutes(r: ApiRouter, deps: AppDeps): void {
  r.post("/tasks/:taskId/cancel", async (c) => {
    const s = sessionOf(c);
    return c.json(await cancelTask(deps, s, idParam(c, "taskId")));
  });
}

/** 作業場で作ったファイル（D-116）。タスクの最新の控えを tar.gz でそのまま返す。ワークスペースのメンバーなら誰でも（viewer を含む） */
export function taskFilesRoutes(r: ApiRouter, deps: AppDeps): void {
  r.get("/tasks/:taskId/files", async (c) => {
    const s = sessionOf(c);
    const taskId = idParam(c, "taskId");
    const snap = await getLatestTaskSnapshot(deps.db, s, taskId);
    if (snap === null) throw new AppError("NOT_FOUND");
    return new Response(new Uint8Array(snap.archive), {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="files-${taskId.slice(0, 8)}.tar.gz"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
