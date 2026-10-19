// 動いている仕事の登録簿と Kill Switch の見張り（SO §3.15 の「止まり方」、NFR-012 の p95 10秒、G-02）
// 0-H のタスク・依頼の生成・リハーサルは app のインスタンスの中のリクエストで動き、どのインスタンスかは分からない。
// 1. 各インスタンスは LISTEN ot_kill_switch を1本持ち、通知（payload はワークスペースの ID）で登録簿のそのワークスペースを中断する
// 2. 通知が落ちたときの見回り：登録のあるワークスペースごとに2秒おきに Kill Switch と終了状態を読み、当たったものを中断する
// 3. ループは LLM・ツールを呼ぶたびに decide() の手順1でも止まる（ここの外）
// 中断は AbortController.abort(StopRequested)。走っている Gemini・gateway の呼び出しは signal で切れる

import { system, wsCtxOf, type Db, type Listener, type Uuid } from "@open-team/db";
import { findStoppedTasks } from "@open-team/db/app";
import type { Logger } from "@open-team/platform";

/** 何を走らせているか（タスク＝EP-46、依頼の生成・リハーサルの走行＝G-02 の内部のリクエスト） */
export type RunningKind = "task" | "ask_generate" | "rehearsal_run";
/** 止めた理由（SO §3.15 の reason に、終了状態・終わりの処理を足した） */
export type StopCause = "kill_switch" | "task_terminated" | "reset" | "cleanup" | "shutdown";

/** controller.abort() に渡す理由。signal.reason で受け取れる */
export class StopRequested extends Error {
  readonly stopCause: StopCause;
  constructor(cause: StopCause) {
    super(`止めた：${cause}`);
    this.name = "StopRequested";
    this.stopCause = cause;
  }
}

export interface RunningEntry {
  id: string;
  workspaceId: Uuid;
  kind: RunningKind;
  controller: AbortController;
  registeredAt: Date;
  /** 中断した時刻（killswitch.task_stopped の latencyMs の起点に使える） */
  stoppedAt: Date | null;
  stopCause: StopCause | null;
}

export interface RunningTaskRegistry {
  /** 同じ ID を2回登録すると前のものを置き換える（前の controller は中断しない） */
  register(id: string, workspaceId: Uuid, controller: AbortController, kind?: RunningKind): RunningEntry;
  /** そのワークスペースの登録をすべて中断し、中断した ID を返す（登録は残す。消すのは走らせた側の unregister） */
  abortWorkspace(workspaceId: Uuid, cause: StopCause): string[];
  abortTask(id: string, cause: StopCause): boolean;
  unregister(id: string): void;
  get(id: string): RunningEntry | undefined;
  list(): RunningEntry[];
  readonly size: number;
}

export function createRunningTaskRegistry(opts: { now?: () => Date } = {}): RunningTaskRegistry {
  const now = opts.now ?? (() => new Date());
  const entries = new Map<string, RunningEntry>();
  const stop = (e: RunningEntry, cause: StopCause): boolean => {
    if (e.controller.signal.aborted) return false;
    e.stoppedAt = now();
    e.stopCause = cause;
    e.controller.abort(new StopRequested(cause));
    return true;
  };
  return {
    register(id, workspaceId, controller, kind = "task") {
      const e: RunningEntry = { id, workspaceId: workspaceId.toLowerCase(), kind, controller, registeredAt: now(), stoppedAt: null, stopCause: null };
      entries.set(id, e);
      return e;
    },
    abortWorkspace(workspaceId, cause) {
      const ws = workspaceId.toLowerCase();
      const out: string[] = [];
      for (const e of entries.values()) if (e.workspaceId === ws && stop(e, cause)) out.push(e.id);
      return out.sort();
    },
    abortTask(id, cause) {
      const e = entries.get(id);
      return e !== undefined && stop(e, cause);
    },
    unregister(id) {
      entries.delete(id);
    },
    get(id) {
      return entries.get(id);
    },
    list() {
      return [...entries.values()];
    },
    get size() {
      return entries.size;
    },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KillWatchOptions {
  db: Db;
  registry: RunningTaskRegistry;
  log: Logger;
  /** 見回りの間隔（SO LIMITS.killPollIntervalMs。既定 2秒） */
  pollMs?: number;
  /** LISTEN を張らない（見回りだけ。試験用） */
  listen?: boolean;
}

export interface KillWatch {
  /** 見回りを1回すぐ行う（試験・起動の直後） */
  pollNow(): Promise<void>;
  stop(): Promise<void>;
}

/** インスタンスごとに1つ（SO §3.15 の startKillListener）。止めるときは stop() */
export async function startKillWatch(o: KillWatchOptions): Promise<KillWatch> {
  const pollMs = o.pollMs ?? 2_000;
  let listener: Listener | null = null;
  if (o.listen !== false) {
    listener = await o.db.listen(system.KILL_SWITCH_CHANNEL, (payload) => {
      const ws = payload.trim();
      if (!UUID_RE.test(ws)) return;
      const stopped = o.registry.abortWorkspace(ws, "kill_switch");
      if (stopped.length > 0) o.log.info("killswitch.notified", "Kill Switch の通知で止めた", { workspaceId: ws, stopped });
    });
  }

  let running: Promise<void> | null = null;
  const pollOnce = async (): Promise<void> => {
    const byWorkspace = new Map<string, string[]>();
    for (const e of o.registry.list()) {
      if (e.controller.signal.aborted) continue;
      const ids = byWorkspace.get(e.workspaceId) ?? [];
      // タスクの ID（uuid）だけ終了状態を見る。ほかの登録はワークスペースの Kill Switch だけを見る
      if (e.kind === "task" && UUID_RE.test(e.id)) ids.push(e.id);
      byWorkspace.set(e.workspaceId, ids);
    }
    for (const [ws, taskIds] of byWorkspace) {
      try {
        const r = await findStoppedTasks(o.db, wsCtxOf({ id: ws, kind: "owner" }), taskIds);
        if (r.killSwitchEngaged) {
          const stopped = o.registry.abortWorkspace(ws, "kill_switch");
          if (stopped.length > 0) o.log.info("killswitch.poll_stopped", "見回りで Kill Switch を見つけて止めた", { workspaceId: ws, stopped });
          continue;
        }
        for (const id of r.terminalTaskIds) {
          if (o.registry.abortTask(id, "task_terminated")) {
            o.log.info("task.poll_stopped", "見回りで終了状態のタスクを止めた", { workspaceId: ws, taskId: id });
          }
        }
      } catch (error) {
        o.log.warn("killswitch.poll_failed", "Kill Switch の見回りに失敗した", { workspaceId: ws, error });
      }
    }
  };
  const poll = (): Promise<void> => {
    // 前の見回りが終わっていなければ重ねない
    if (running) return running;
    running = pollOnce().finally(() => {
      running = null;
    });
    return running;
  };
  const timer = setInterval(() => void poll(), pollMs);
  timer.unref?.();

  return {
    pollNow: poll,
    async stop() {
      clearInterval(timer);
      await running;
      await listener?.unlisten().catch(() => {});
    },
  };
}
