// createEdge：runner の唯一の出口（EdgePort）の本番の実装（formation-runtime.md §2.6・§3.10〜3.12・§3.15、D-52）。
// runner は EdgePort の型だけを持ち、app がこれを渡す。edge は DB・Gemini・gateway に届く（runner は届かない）

import type { EdgePort, LlmMessagesRequest, ProgressEvent, TaskContext } from "@open-team/runner";
import { EdgeError } from "@open-team/runner";
import { appendAuditLog, lockWorkspace } from "@open-team/db";
import { insertTaskEvent, lockTask, markTaskRunning, touchTaskHeartbeat } from "@open-team/db/edge";
import { buildTaskContext, loadTaskSetup } from "./context.ts";
import { postEvents } from "./events.ts";
import { llmMessages } from "./proxy.ts";
import { deliverAtStart } from "./team.ts";
import { createRuntime, type EdgeDeps, type EdgeRuntime } from "./runtime.ts";
import { haltedDetails, resolveTaskByToken } from "./tokens.ts";
import { callTool } from "./tools.ts";

/**
 * API-036 相当：最初の呼び出しでタスクを running にする（si:43）。queued・provisioning・running のタスクだけ
 * （同時実行数・予算の確かめは app が始める前に canStartWork で行う）
 */
async function getTaskContext(rt: EdgeRuntime, token: string): Promise<TaskContext> {
  const now = rt.clock.now();
  const resolved = await resolveTaskByToken(rt.db, token, now, { allow: ["queued", "provisioning", "running"] });
  const { ctx, workspace } = resolved;
  let task = resolved.task;
  if (task.status === "queued" || task.status === "provisioning") {
    const before = task.status;
    task = await rt.db.transaction(
      async (tx) => {
        const at = rt.clock.now();
        const ws = await lockWorkspace(tx, ctx);
        const locked = await lockTask(tx, ctx, task.id);
        if (locked === null) throw new EdgeError("UNAUTHORIZED");
        if (ws?.kill_switch_engaged === true) throw new EdgeError("TASK_HALTED", haltedDetails(locked, ws));
        if (locked.status === "running") return locked;
        const running = await markTaskRunning(tx, ctx, locked.id, at);
        if (running === null) throw new EdgeError("TASK_HALTED", haltedDetails(locked, ws ?? undefined));
        await appendAuditLog(
          tx,
          ctx.workspaceId,
          { eventType: "task.status_changed", actorType: "system", actorId: "edge", taskId: running.id, payload: { taskId: running.id, from: before, to: "running" } },
          at,
        );
        await insertTaskEvent(tx, ctx, running.id, "status_changed", { from: before, to: "running" }, at);
        return running;
      },
      { retryOnce: true },
    );
  } else {
    await touchTaskHeartbeat(rt.db, ctx, task.id, now);
  }
  const setup = await loadTaskSetup(rt.db, ctx, task, workspace, undefined, { sandboxProvider: rt.sandbox !== null, trustedSkills: rt.trustedSkills });
  const virtualNow = rt.virtualNow === undefined ? null : await rt.virtualNow(ctx, task);
  // 始まる前に届いていた連絡（連絡板。ひとりの編成・依頼でないタスクでは空）
  const teamMessages = setup.formation === null ? [] : await deliverAtStart(rt, ctx, task);
  return buildTaskContext(rt.db, ctx, setup, { now, virtualNow, knownSecrets: rt.knownSecrets, maxTokens: rt.limits.maxTokensDefault, teamMessages });
}

/** 本番の EdgePort（app が runner の runTask に渡す）。インスタンスごとに回数の数え（60回/分・10件/秒）を持つ */
export function createEdge(deps: EdgeDeps): EdgePort {
  const rt = createRuntime(deps);
  return {
    getTaskContext: (token: string) => getTaskContext(rt, token),
    llmMessages: (token: string, req: LlmMessagesRequest) => llmMessages(rt, token, req),
    postEvents: (token: string, events: ProgressEvent[]) => postEvents(rt, token, events),
    callTool: (token: string, toolCallId: string) => callTool(rt, token, toolCallId),
  };
}
