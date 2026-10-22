// Kill Switch（EP-27・28。FR-015、SO §3.15、AS §3.9、09_api/policies.md:71-83）
// 発動：maintainer 以上。1つのトランザクションで、ワークスペースの行 → タスク → 承認 → Intent の順にロックし（M-21）、
//   全タスクを halted(kill_switch)・タスクのトークンを失効、承認待ちと未実行の Intent を expired、
//   終了したタスクの処理（順番の進め方：hooks.tasksTerminated）、監査ログ killswitch.engaged、
//   SSE の事象 killswitch、NOTIFY ot_kill_switch（コミットで届く）。コミットのあと、このインスタンスの登録簿もすぐ中断する
// 解除：owner だけ（BR-17）。理由は1〜500文字。止めたタスクは再開しない。監査ログ killswitch.released、SSE の事象 killswitch
// どちらも冪等（発動中の発動・解除中の解除は何もせず今の状態を返し、監査ログも増やさない：09_api/policies.md:75）

import { appendAuditLog, system, type SessionCtx, type Tx } from "@open-team/db";
import { appendWorkspaceEvent, engageKillSwitchTx, releaseKillSwitchTx } from "@open-team/db/app";
import { AppError } from "@open-team/platform";
import type { AppDeps, InTxResult } from "./deps.ts";

/** AS §2.7 の応答 */
export type KillSwitchEngageResponse = {
  engaged: true;
  engagedAt: string;
  affectedTaskIds: string[];
};
export type KillSwitchReleaseResponse = {
  engaged: false;
};

/** SSE の事象（AS §2.11：{ type: "killswitch"; data: { engaged; engagedAt } }） */
export const KILLSWITCH_EVENT = "killswitch";

type EngageDeps = Pick<AppDeps, "log" | "registry" | "hooks">;

/** 発動の中身（呼び出し側のトランザクションで。冪等性のキーの記録と同じトランザクションにするため） */
export async function engageKillSwitchInTx(
  tx: Tx,
  deps: EngageDeps,
  s: SessionCtx,
  input: { reason: string | null },
  now: Date,
): Promise<InTxResult<KillSwitchEngageResponse>> {
  if (s.role !== "owner" && s.role !== "maintainer") throw new AppError("FORBIDDEN");
  const res = await engageKillSwitchTx(tx, s, { by: s.userId, reason: input.reason, now });
  if (!res) throw new AppError("NOT_FOUND");
  const affectedTaskIds = res.haltedTasks.map((t) => t.id);
  const body: KillSwitchEngageResponse = { engaged: true, engagedAt: res.engagedAt.toISOString(), affectedTaskIds };
  if (res.alreadyEngaged) return { body };
  if (res.haltedTasks.length > 0) {
    for (const hook of deps.hooks.tasksTerminated) await hook(tx, s, { tasks: res.haltedTasks, cause: "kill_switch", now });
  }
  await appendAuditLog(
    tx,
    s.workspaceId,
    {
      eventType: "killswitch.engaged",
      actorType: "user",
      actorId: s.userId,
      payload: {
        reason: input.reason,
        affectedTaskIds,
        expiredIntentIds: res.expiredIntentIds,
      },
    },
    now,
  );
  await appendWorkspaceEvent(tx, s, { type: KILLSWITCH_EVENT, data: { engaged: true, engagedAt: now.toISOString() } }, now);
  await tx.query("SELECT pg_notify($1, $2)", [system.KILL_SWITCH_CHANNEL, s.workspaceId]);
  return {
    body,
    afterCommit: () => {
      // ほかのインスタンスは NOTIFY で、このインスタンスはここで止める（通知の往復を待たない）
      const stopped = deps.registry.abortWorkspace(s.workspaceId, "kill_switch");
      deps.log.log({
        severity: "NOTICE",
        event: "killswitch.engaged",
        message: "Kill Switch を発動した",
        workspaceId: s.workspaceId,
        affectedTaskIds,
        stoppedHere: stopped,
      });
    },
  };
}

/** 解除の中身（呼び出し側のトランザクションで） */
export async function releaseKillSwitchInTx(
  tx: Tx,
  deps: Pick<AppDeps, "log">,
  s: SessionCtx,
  input: { reason: string },
  now: Date,
): Promise<InTxResult<KillSwitchReleaseResponse>> {
  if (s.role !== "owner") throw new AppError("FORBIDDEN");
  const res = await releaseKillSwitchTx(tx, s, now);
  if (!res) throw new AppError("NOT_FOUND");
  const body: KillSwitchReleaseResponse = { engaged: false };
  if (!res.wasEngaged) return { body };
  await appendAuditLog(tx, s.workspaceId, { eventType: "killswitch.released", actorType: "user", actorId: s.userId, payload: { reason: input.reason } }, now);
  await appendWorkspaceEvent(tx, s, { type: KILLSWITCH_EVENT, data: { engaged: false, engagedAt: null } }, now);
  return {
    body,
    afterCommit: () =>
      deps.log.log({ severity: "NOTICE", event: "killswitch.released", message: "Kill Switch を解除した", workspaceId: s.workspaceId }),
  };
}

/** 発動（自分でトランザクションを開く版。ロックの順は守っているが、デッドロックなら1回だけやり直す：SO §3.14） */
export async function engageKillSwitch(
  deps: Pick<AppDeps, "db" | "clock"> & EngageDeps,
  s: SessionCtx,
  input: { reason: string | null },
): Promise<KillSwitchEngageResponse> {
  const now = deps.clock.now();
  const r = await deps.db.transaction((tx) => engageKillSwitchInTx(tx, deps, s, input, now), { retryOnce: true });
  r.afterCommit?.();
  return r.body;
}

export async function releaseKillSwitch(deps: Pick<AppDeps, "db" | "clock" | "log">, s: SessionCtx, input: { reason: string }): Promise<KillSwitchReleaseResponse> {
  const now = deps.clock.now();
  const r = await deps.db.transaction((tx) => releaseKillSwitchInTx(tx, deps, s, input, now), { retryOnce: true });
  r.afterCommit?.();
  return r.body;
}
