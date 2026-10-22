// Kill Switch（EP-27・28。FR-015、SO §3.15、AS §3.9。apps/app/src/kill-switch.ts の WorkspaceDO 版）
// 発動：1つのトランザクションで全タスクを halted(kill_switch)・トークンを失効、承認待ちと未実行の Intent を expired、監査ログ killswitch.engaged、SSE の事象 killswitch。
// 解除：理由は1〜500文字。止めたタスクは再開しない（BR-17）。監査ログ killswitch.released、SSE の事象 killswitch。
// どちらも冪等（発動中の発動・解除中の解除は何もせず今の状態を返し、監査ログも増やさない：09_api/policies.md:75）。
// 止めたタスクの依頼の進め方（hooks.tasksTerminated）と、動いている Workflow の停止は、実行を移す 4c で足す

import { AppError } from "@open-team/platform";
import { appendAuditLog } from "./db/audit.ts";
import { appendWorkspaceEvent, engageKillSwitchTx, releaseKillSwitchTx } from "./db/repo/app.ts";
import type { WsDb } from "./db/sqlite.ts";
import type { Uuid } from "./db/types.ts";

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

/** 発動（呼ぶ側のトランザクションの中で。冪等性のキーの記録と同じトランザクションにするため） */
export function engageKillSwitch(db: WsDb, i: { userId: Uuid; reason: string | null; now: Date }): KillSwitchEngageResponse {
  const res = engageKillSwitchTx(db, { by: i.userId, reason: i.reason, now: i.now });
  if (!res) throw new AppError("NOT_FOUND");
  const affectedTaskIds = res.haltedTasks.map((t) => t.id);
  const body: KillSwitchEngageResponse = { engaged: true, engagedAt: res.engagedAt.toISOString(), affectedTaskIds };
  if (res.alreadyEngaged) return body;
  appendAuditLog(
    db,
    {
      eventType: "killswitch.engaged",
      actorType: "user",
      actorId: i.userId,
      payload: { reason: i.reason, affectedTaskIds, expiredIntentIds: res.expiredIntentIds },
    },
    i.now,
  );
  appendWorkspaceEvent(db, { type: KILLSWITCH_EVENT, data: { engaged: true, engagedAt: i.now.toISOString() } }, i.now);
  return body;
}

/** 解除 */
export function releaseKillSwitch(db: WsDb, i: { userId: Uuid; reason: string; now: Date }): KillSwitchReleaseResponse {
  return db.transaction(() => {
    const res = releaseKillSwitchTx(db, i.now);
    if (!res) throw new AppError("NOT_FOUND");
    if (!res.wasEngaged) return { engaged: false };
    appendAuditLog(db, { eventType: "killswitch.released", actorType: "user", actorId: i.userId, payload: { reason: i.reason } }, i.now);
    appendWorkspaceEvent(db, { type: KILLSWITCH_EVENT, data: { engaged: false, engagedAt: null } }, i.now);
    return { engaged: false };
  });
}
