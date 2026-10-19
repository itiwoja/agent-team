// 依頼の hook と tick の手順（deps.ts が組み込む）。
// - tasksTerminated（Kill Switch で止めたタスク）：依頼の実行・依頼を cancelled にする（同じトランザクション。外部は呼ばない：G-14）
// - taskSettled（承認の API の却下・タスクの取り消しで終わったタスク）：その依頼の実行を1歩進める（次の段のタスクを queued で作る・回答の手が要るものの行を書き換える）。
//   タスクを動かすのはトランザクションの外なので、queued のタスクは tick の手順（asksTickStep）か advanceAsk（承認の API のコミットのあと）が動かす
// - tick：定期の依頼の起動（next_run_at）・生成中のまま止まった依頼を失敗にする・ハートビートの途絶えたタスクを失敗にする（sandbox_lost）・
//   動いている実行の拾い直し（queued のタスク・確認が済んだあとの続き・まとめ役の待ち時間）

import { lockWorkspace, system, wsCtxOf, type Tx, type Uuid, type WsCtx } from "@open-team/db";
import { getTask, lockTask } from "@open-team/db/edge";
import { getAsk, listMembers, markAskGenerationFailed, setAskNextRun } from "@open-team/db/asks";
import { failTask } from "@open-team/edge";
import { FORMATION_LIMITS } from "@open-team/kernel";
import type { AppDeps, TasksTerminatedHook, TickStep } from "../deps.ts";
import { nextScheduledRun } from "../schedule.ts";
import { emitAskEvent } from "./events.ts";
import { FAILURE_MESSAGES } from "./planner.ts";
import { advanceAsk, advanceTx, cancelRunsOfHaltedTasks, driveRun, emitStepFinished, startAskRun } from "./run.ts";

export const asksOnTasksTerminated: TasksTerminatedHook = async (tx, ctx, e) => {
  await cancelRunsOfHaltedTasks(tx, ctx, e.tasks, e.now);
};

/** deps.ts の TaskSettledHook と同じ形（承認の API・タスクの取り消しが、タスクを終えたトランザクションの中で呼ぶ） */
export type AskTaskSettledHook = (tx: Tx, ctx: WsCtx, e: { taskId: string; status: string; now: Date }) => Promise<void>;

export const asksOnTaskSettled: AskTaskSettledHook = async (tx, ctx, e) => {
  const task = await getTask(tx, ctx, e.taskId);
  if (task === null || task.ask_run_id === null || task.ask_id === null) return;
  const ask = await getAsk(tx, ctx, task.ask_id);
  if (ask === null) return;
  await advanceTx(tx, ctx, task.ask_run_id, { requesterId: ask.created_by, now: e.now });
};

/** 1回の tick で進める数の上限（DB の接続は2本：SO §4.6。残りは次の tick） */
export const ASK_RUNS_PER_TICK = 10;
export const DUE_ASKS_PER_TICK = 10;
/** ハートビートが途絶えたと見るまでの時間。LLM の呼び出しは1回 120 秒（上限）で、やり直しを含めても足りる長さ（ハートビートは LLM の呼び出しの終わり・タスクの出来事で更新される） */
export const STALE_TASK_MS = 10 * 60_000;
export const STALE_TASKS_PER_TICK = 20;
/** 生成中のまま更新が止まって、これだけたった依頼を失敗にする（生成の打ち切り30秒 ＋ 余裕） */
export const STUCK_GENERATION_MS = FORMATION_LIMITS.generationTimeoutMs * 2;

type TickDeps = Pick<AppDeps, "db" | "log" | "clock" | "ids" | "llm" | "gatewayClient" | "registry" | "env" | "sleep">;

/**
 * ハートビートが途絶えた本番のタスク（provisioning・running のまま）を sandbox_lost で failed にし、その依頼の実行を進める。
 * 動かしているプロセスが落ちた・止まった取りこぼしの拾い直し。この instance が動かしているもの（登録簿にあるもの）は除く。
 * 確かめは行のロックの中でもう一度（その間にハートビートが新しくなっていれば何もしない）
 */
async function failStaleTasks(deps: TickDeps, now: Date): Promise<void> {
  const staleBefore = new Date(now.getTime() - STALE_TASK_MS);
  for (const hit of await system.scanStaleLiveTasks(deps.db, staleBefore, STALE_TASKS_PER_TICK)) {
    if (deps.registry.get(hit.id) !== undefined) continue;
    const ctx = wsCtxOf({ id: hit.workspaceId, kind: hit.workspaceKind });
    try {
      const askId = await deps.db.transaction(async (tx) => {
        await lockWorkspace(tx, ctx);
        const t = await lockTask(tx, ctx, hit.id);
        if (t === null || (t.status !== "provisioning" && t.status !== "running")) return null;
        if ((t.last_heartbeat_at ?? t.updated_at).getTime() > staleBefore.getTime()) return null;
        const failed = await failTask(tx, ctx, t, "sandbox_lost", now, { cleanup: "stale_heartbeat" });
        if (failed === null || failed.ask_id === null) return null;
        const member = (await listMembers(tx, ctx, failed.ask_id)).find((m) => m.id === failed.ask_member_id);
        if (member !== undefined) await emitStepFinished(tx, ctx, failed, member, now);
        return failed.ask_id;
      });
      if (askId !== null) {
        void advanceAsk(deps, ctx, askId).catch((error) => deps.log.error("asks.stale_advance_failed", "止まったタスクの依頼を進められなかった", { workspaceId: hit.workspaceId, askId, error }));
      }
    } catch (error) {
      deps.log.warn("asks.stale_fail_failed", "止まったタスクを失敗にできなかった", { workspaceId: hit.workspaceId, taskId: hit.id, error });
    }
  }
}

export async function runAsksTick(deps: TickDeps, now: Date): Promise<{ scheduled: number; dispatched: number }> {
  let scheduled = 0;
  let dispatched = 0;

  // 定期の依頼の起動（next_run_at が来た）。動いている実行があれば起動せず、次の時刻だけ進める（積み重ねない）
  for (const hit of await system.scanDueAsks(deps.db, now, DUE_ASKS_PER_TICK)) {
    const ctx = wsCtxOf({ id: hit.workspaceId, kind: hit.workspaceKind });
    try {
      const ask = await getAsk(deps.db, ctx, hit.id);
      if (ask === null || ask.trigger === null || ask.next_run_at === null) continue;
      await setAskNextRun(deps.db, ctx, ask.id, nextScheduledRun(ask.trigger, now), now);
      if (ask.status !== "running" && ask.status !== "done") continue;
      const started = await startAskRun(deps, ctx, ask.id, { requesterId: ask.created_by, trigger: "schedule" });
      if (started !== null) {
        scheduled += 1;
        void started.done;
      }
    } catch (error) {
      deps.log.warn("asks.schedule_failed", "定期の依頼を起動できなかった", { workspaceId: hit.workspaceId, askId: hit.id, error });
    }
  }

  // 生成中のまま止まった依頼（プロセスが落ちた・時間切れの取りこぼし）
  for (const hit of await system.scanStuckGeneratingAsks(deps.db, new Date(now.getTime() - STUCK_GENERATION_MS))) {
    if (deps.registry.get(hit.id) !== undefined) continue;
    const ctx = wsCtxOf({ id: hit.workspaceId, kind: hit.workspaceKind });
    try {
      await deps.db.transaction(async (tx) => {
        const failed = await markAskGenerationFailed(tx, ctx, hit.id, "timeout", now);
        if (failed !== null) await emitAskEvent(tx, ctx, { type: "ask.failed", askId: hit.id, reason: "timeout", message: FAILURE_MESSAGES.timeout }, now);
      });
    } catch (error) {
      deps.log.warn("asks.stuck_close_failed", "止まった生成を閉じられなかった", { workspaceId: hit.workspaceId, askId: hit.id, error });
    }
  }

  await failStaleTasks(deps, now);

  // 動いている実行の拾い直し（queued のタスクを動かす・確認が済んだあとの続き・まとめ役の待ち時間）。動かすのは裏で続け、tick は待たない
  // （同じ実行を動かしているものがあれば「もう一度見る」印だけ付く：driveRun）。拾った実行は印を付けて、次の tick では後回しにする（詰まらないように）
  const active = await system.scanActiveAskRuns(deps.db, ASK_RUNS_PER_TICK);
  await system.markAskRunsScanned(deps.db, active.map((h) => h.id), now);
  for (const hit of active) {
    const ctx = wsCtxOf({ id: hit.workspaceId, kind: hit.workspaceKind });
    void driveRun(deps, ctx, hit.id as Uuid, { requesterId: hit.createdBy });
    dispatched += 1;
  }
  return { scheduled, dispatched };
}

export const asksTickStep: TickStep = {
  name: "asks",
  async run(deps, now) {
    return runAsksTick(deps, now);
  },
};
