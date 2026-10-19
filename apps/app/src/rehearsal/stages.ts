// リハーサルで走らせる段の決め方（仕事は1段、順番（chain）の依頼は担当の順）。
// run.ts と web-grant.ts の両方から使うので、循環しないよう別のファイルにした。

import type { Queryable, Uuid, WsCtx } from "@open-team/db";
import { getAskRow, listAskMembers } from "@open-team/db/edge";
import { getJobStage } from "@open-team/db/rehearsal";

/** 走らせる1段（ひとりの仕事は1段、順番の編成は担当の順に複数段） */
export interface RehearsalStage {
  agentId: Uuid;
  agentSnapshotId: Uuid;
  jobId: Uuid;
  /** 依頼（順番の編成）の担当の行。ひとりの仕事は null */
  askMemberId: Uuid | null;
}

/** 試験の対象から走らせる段を決める。仕事は1段、順番（chain）の依頼は担当の順。並列・まとめは担当ごとに別の試験で走らせる（15:127） */
export async function resolveStages(db: Queryable, ctx: WsCtx, subject: { jobId?: Uuid | null; askId?: Uuid | null }): Promise<RehearsalStage[]> {
  if (subject.jobId) {
    const j = await getJobStage(db, ctx, subject.jobId);
    if (j === null) throw new Error(`仕事 ${subject.jobId} が見つからない（か、エージェントに今のスナップショットがない）`);
    return [{ agentId: j.agent_id, agentSnapshotId: j.agent_snapshot_id, jobId: j.job_id, askMemberId: null }];
  }
  if (subject.askId) {
    const ask = await getAskRow(db, ctx, subject.askId);
    if (ask === null) throw new Error(`依頼 ${subject.askId} が見つからない`);
    if (ask.shape !== "chain") throw new Error(`依頼の形が chain ではない（${String(ask.shape)}）：並列・まとめは担当ごとの仕事を試験の対象にする`);
    const members = (await listAskMembers(db, ctx, ask.id)).filter((m) => !m.is_aggregator).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const stages: RehearsalStage[] = [];
    for (const m of members) {
      const j = await getJobStage(db, ctx, m.job_id);
      if (j === null) throw new Error(`担当 ${m.agent_name} の仕事が見つからない`);
      stages.push({ agentId: j.agent_id, agentSnapshotId: j.agent_snapshot_id, jobId: j.job_id, askMemberId: m.id });
    }
    if (stages.length === 0) throw new Error("依頼に担当がいない");
    return stages;
  }
  throw new TypeError("試験の対象は仕事か依頼のどちらか");
}
