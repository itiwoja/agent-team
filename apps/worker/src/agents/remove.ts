// エージェントの削除（API-081。DELETE /agents/:agentId）。論理削除（agents.status = 'removed'）で、履歴（依頼・タスク・監査ログ）は消さない。
// - 動いているなら断る（409 AGENT_BUSY。何も変えない）：判定は db/repo/agents.ts の isAgentBusy
// - 定期の依頼（asks.trigger がある）の編成に入っていれば、その依頼の next_run_at を null にして定期を止める（毎分の起こしは next_run_at が入った依頼だけを拾う）。依頼の状態は変えない
// - そのエージェントの仕事（agent_jobs）は done にする
// 呼ぶ側のトランザクション（runIdempotent なし。削除は何度やっても結果が同じなので、2回目は 404）の中で呼ぶ

import { AppError } from "@open-team/platform";
import { appendAuditLog } from "../db/audit.ts";
import { appendWorkspaceEvent, getAgent } from "../db/repo/app.ts";
import { isAgentBusy, listOpenJobIds, listScheduledAskIdsOf, markAgentRemoved } from "../db/repo/agents.ts";
import { markJobsDone, setAskNextRun } from "../db/repo/asks.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { Uuid } from "../db/types.ts";
import type { DeleteAgentResponse } from "../views/agents/contract.ts";

export function removeAgent(db: WsDb, a: { userId: Uuid; agentId: Uuid; now: Date }): DeleteAgentResponse {
  const { agentId, now } = a;
  const agent = getAgent(db, agentId);
  if (agent === null || agent.status === "removed") throw new AppError("NOT_FOUND");
  if (isAgentBusy(db, agentId)) throw new AppError("AGENT_BUSY");

  const stoppedAskIds = listScheduledAskIdsOf(db, agentId);
  for (const askId of stoppedAskIds) setAskNextRun(db, askId, null, now);
  const jobIds = listOpenJobIds(db, agentId);
  markJobsDone(db, jobIds, now);
  markAgentRemoved(db, agentId, now);

  appendAuditLog(
    db,
    {
      eventType: "agent.removed",
      actorType: "user",
      actorId: a.userId,
      payload: { agentId, name: agent.name, stoppedAsks: stoppedAskIds, jobs: jobIds.length },
    },
    now,
  );
  appendWorkspaceEvent(db, { type: "agent.removed", data: { agentId } }, now);
  return { agentId, stoppedAsks: stoppedAskIds.length };
}
