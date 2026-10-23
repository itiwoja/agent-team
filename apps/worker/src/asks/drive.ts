// 依頼の実行を進める DO の側（apps/app/src/asks/run.ts の driveRun・startWhenRoom・cancelRunsOfHaltedTasks の WorkspaceDO 版）。
// Node 版はプロセスの中のループ（driving の Map）が「1歩進める → タスクを動かす → 終わりを待つ」を回し、同時実行数の空きを1秒ごとに見て待った。
// ここでは WorkspaceDO が進め役になる：
// - startable：queued のタスクを古い順に見て、始められるものを provisioning にする（取ったものは DO が TaskWorkflow を起動する）
//   Kill Switch・費用の上限なら queued のタスクを止める。同時実行数がいっぱいなら queued のまま残し、どれかが終わったときにもう一度見る
// - タスクの TaskWorkflow が終わると DO の taskFinished が後始末 → advanceTx → startable を呼ぶ
// queued のまま長く待ったタスクの打ち切り（Node 版の10分の timeout）と取りこぼしの拾い直しは、第5段の alarm で行う

import { appendAuditLog } from "../db/audit.ts";
import { claimQueuedTask, transitionAsk, transitionRun } from "../db/repo/asks.ts";
import { CODECS } from "../db/codecs.ts";
import { all, type WsDb } from "../db/sqlite.ts";
import type { TaskRow, Uuid } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";
import { canStartWork } from "../edge/spend.ts";
import { finishTaskRun, haltQueuedTask } from "../edge/task-edge.ts";
import { emitAskEvent } from "./accept.ts";

/** 依頼の実行の queued のタスク（古い順） */
function listQueuedRunTasks(db: WsDb): TaskRow[] {
  return all<TaskRow>(db, CODECS.tasks, "SELECT * FROM tasks WHERE status = 'queued' AND ask_run_id IS NOT NULL ORDER BY queued_at, id");
}

export interface StartableResult {
  /** provisioning にしたタスク（TaskWorkflow を起動する） */
  started: TaskRow[];
  /** 始める前に止めたタスクの実行（あとで1歩進める） */
  haltedRunIds: Uuid[];
}

/** 始められる queued のタスクを取る（1つのトランザクション） */
export function takeStartableTasks(db: WsDb, now: Date): StartableResult {
  return db.transaction(() => {
    const started: TaskRow[] = [];
    const haltedRunIds = new Set<Uuid>();
    for (const t of listQueuedRunTasks(db)) {
      const ws = getWorkspace(db);
      if (ws === null) break;
      const r = canStartWork(db, ws, now);
      if (!r.ok && r.reason === "concurrency") break;
      if (!r.ok) {
        haltQueuedTask(db, t.id, r.reason === "kill_switch" ? "kill_switch" : "budget", now);
        // 段の終わりの事象（ask.step.finished）。状態は止めたとおりのまま（aborted は触らない）
        finishTaskRun(db, t.id, "aborted", now);
        if (t.ask_run_id !== null) haltedRunIds.add(t.ask_run_id);
        continue;
      }
      const claimed = claimQueuedTask(db, t.id, now);
      if (claimed !== null) started.push(claimed);
    }
    return { started, haltedRunIds: [...haltedRunIds] };
  });
}

/** Kill Switch で止めたタスクの実行と依頼を cancelled にする（Node 版の hooks.tasksTerminated → cancelRunsOfHaltedTasks） */
export function cancelRunsOfHaltedTasks(db: WsDb, tasks: ReadonlyArray<{ askRunId: Uuid | null }>, now: Date): void {
  const runIds = [...new Set(tasks.flatMap((t) => (t.askRunId === null ? [] : [t.askRunId])))];
  for (const runId of runIds) {
    const run = transitionRun(db, runId, ["running", "waiting_input"], "cancelled", now);
    if (run === null) continue;
    const moved = transitionAsk(db, run.ask_id, ["running", "waiting_input"], "cancelled", now);
    if (moved !== null) emitAskEvent(db, { type: "ask.status", askId: run.ask_id, status: "cancelled" }, now);
    appendAuditLog(db, { eventType: "ask.cancelled", actorType: "system", actorId: "kill_switch", payload: { askId: run.ask_id, askRunId: runId } }, now);
  }
}
