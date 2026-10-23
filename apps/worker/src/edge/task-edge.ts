// 担当のタスクの edge（runner の EdgePort の DB 側。packages/edge/src/edge.ts の createEdge の WorkspaceDO 版。formation-runtime.md §2.6・§3.10〜3.12・§3.15）。
// WorkspaceDO の RPC から呼ぶ同期の関数を集めたもの。失敗は runner の EdgeError を投げる（DO の側が fault.ts の captureEdge で値にする）。
// Node 版との違い：
// - タスクの「トークン」の代わりに taskId を使う（Workflow の引数に秘密を載せない。tokens.ts の resolveTask）
// - llmMessages を4つに分けた（proxy.ts：edgeLlmPrepare・edgeLlmBegin・edgeLlmSettle・edgeLlmFail）。LLM は Workflow の側が呼ぶ
// - 時計・ログ・あとで呼ぶ処理（EdgeHooks）は持たない。時刻は呼ぶ側が now で渡す
// - TaskWorkflow の前後の処理（apps/app/src/asks/run.ts の executeTask の「始める前に止める」と「後始末」）もここに置く

import { EdgeError, type RunTaskEnd, type TaskContext } from "@open-team/runner";
import { appendAuditLog } from "../db/audit.ts";
import { getTask, insertTaskEvent, listAskMembers, markTaskRunning, touchTaskHeartbeat } from "../db/repo/edge.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { TaskRow, Uuid } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";
import { emitAskEvent } from "../asks/accept.ts";
import { stageStateOf } from "../views/asks/format.ts";
import { buildTaskContext, loadTaskSetup } from "./context.ts";
import { failTask, haltTask } from "./halt.ts";
import type { TaskEdgeRuntime } from "./runtime.ts";
import { haltedDetails, isTerminalStatus, resolveTask } from "./tokens.ts";

export { createTaskEdgeRuntime, type TaskEdgeRuntime } from "./runtime.ts";
export { edgeLlmBegin, edgeLlmFail, edgeLlmPrepare, edgeLlmSettle } from "./proxy.ts";
export { edgePostEvents } from "./events.ts";
export { edgeCallTool } from "./tools.ts";
export { resolveTask } from "./tokens.ts";

/**
 * API-036 相当：最初の呼び出しでタスクを running にする（si:43）。queued・provisioning・running のタスクだけ
 * （同時実行数・予算の確かめは DO が始める前に canStartWork で行う）。
 * 連絡板の「始まる前に届いていた連絡」（deliverAtStart）は 4f。それまで teamMessages は空
 */
export function edgeTaskContext(db: WsDb, rt: TaskEdgeRuntime, taskId: string, now: Date): TaskContext {
  const resolved = resolveTask(db, taskId, now, ["queued", "provisioning", "running"]);
  const { workspace } = resolved;
  let task = resolved.task;
  if (task.status === "queued" || task.status === "provisioning") {
    const before = task.status;
    task = db.transaction(() => {
      const ws = getWorkspace(db);
      const current = getTask(db, taskId);
      if (current === null) throw new EdgeError("UNAUTHORIZED");
      if (ws?.kill_switch_engaged === true) throw new EdgeError("TASK_HALTED", haltedDetails(current, ws));
      if (current.status === "running") return current;
      const running = markTaskRunning(db, current.id, now);
      if (running === null) throw new EdgeError("TASK_HALTED", haltedDetails(current, ws ?? undefined));
      appendAuditLog(
        db,
        { eventType: "task.status_changed", actorType: "system", actorId: "edge", taskId: running.id, payload: { taskId: running.id, from: before, to: "running" } },
        now,
      );
      insertTaskEvent(db, running.id, "status_changed", { from: before, to: "running" }, now);
      return running;
    });
  } else {
    touchTaskHeartbeat(db, task.id, now);
  }
  const setup = loadTaskSetup(db, task, workspace, undefined, { sandboxProvider: false, trustedSkills: rt.trustedSkills });
  return buildTaskContext(db, setup, { now, knownSecrets: rt.knownSecrets, maxTokens: rt.limits.maxTokensDefault, teamMessages: [] });
}

/** 段の終わりを SSE に出す（apps/app/src/asks/run.ts の emitStepFinished。追いのターンは段の状態を変えないので出さない：FR-064）。トランザクションの中で */
function emitStepFinished(db: WsDb, task: TaskRow, now: Date): void {
  if (task.kind !== "normal" || task.ask_id === null) return;
  const members = listAskMembers(db, task.ask_id);
  const member = members.find((m) => m.id === task.ask_member_id) ?? members.find((m) => m.job_id === task.job_id);
  if (member === undefined) return;
  const st = stageStateOf(task);
  emitAskEvent(
    db,
    {
      type: "ask.step.finished",
      askId: task.ask_id,
      runId: task.ask_run_id ?? "",
      memberId: member.id,
      agentName: member.agent_name,
      taskId: task.id,
      state: st.state,
      stateText: st.text,
    },
    now,
  );
}

/**
 * TaskWorkflow が終わったあとの後始末（executeTask の「後始末」と emitStepFinished）。
 * 終わっていない（終了状態・awaiting_approval・executing 以外）タスクは failed にする（ended が llm_unavailable なら llm_unavailable、ほかは agent_unable）。
 * ended が "aborted" なら状態は触らない（止めた側が決めている）。Node 版の停止（shutdown）による sandbox_lost は、Workflow は止まっても続きから動くので持たない。
 * そのあと ask.step.finished の事象。戻り値は後のタスクの行（見つからなければ null）
 */
export function finishTaskRun(db: WsDb, taskId: Uuid, ended: RunTaskEnd | "error", now: Date): TaskRow | null {
  return db.transaction(() => {
    const t = getTask(db, taskId);
    if (t === null) return null;
    const open = !isTerminalStatus(t.status) && t.status !== "awaiting_approval" && t.status !== "executing";
    if (open && ended !== "aborted") failTask(db, t, ended === "llm_unavailable" ? "llm_unavailable" : "agent_unable", now, { cleanup: "ask_run" });
    const after = getTask(db, taskId) ?? t;
    emitStepFinished(db, after, now);
    return after;
  });
}

/**
 * 始める前に止める（executeTask の start.kind === "halt" の分岐）：queued のときだけ halted（kill_switch／budget_exceeded／timeout）。
 * 段の終わりの事象は出さない（Node 版は続く後始末が出していた。呼ぶ側が finishTaskRun か実行を進める処理でつなぐ）
 */
export function haltQueuedTask(db: WsDb, taskId: Uuid, gate: "kill_switch" | "budget" | "timeout", now: Date): void {
  db.transaction(() => {
    const t = getTask(db, taskId);
    if (t === null || t.status !== "queued") return;
    if (gate === "kill_switch") haltTask(db, t, { reason: "kill_switch" }, now);
    else haltTask(db, t, { reason: gate === "budget" ? "budget_exceeded" : "timeout", audit: { scope: "ask_start", gate } }, now);
  });
}
