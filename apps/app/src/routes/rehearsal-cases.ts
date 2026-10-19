// リハーサルの試験の一覧と、外す操作（FR-066・BR-80。09_api にはまだ定義がないので、09 の流儀（/workspaces/{workspaceId}/…）に合わせた）
// - GET    /workspaces/{workspaceId}/rehearsal-cases?jobId|askId[&includeRemoved=true]：その対象の試験（generated・user・incident）
// - DELETE /workspaces/{workspaceId}/rehearsal-cases/{caseId}：試験を外す（owner・maintainer。ユーザーの操作だけが外せる。監査ログ rehearsal.case_removed）
// 評価の順（AS §3.0）：入力の検証（400）→ パスのワークスペースがセッションのものか（404）→ 権限（403）→ 処理

import type { RehearsalCaseRow } from "@open-team/db";
import { listRehearsalCases, removeRehearsalCaseByUser, type CaseSubject } from "@open-team/db/rehearsal";
import { AppError } from "@open-team/platform";
import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import { plainIncidentTitle } from "../rehearsal/incident-title.ts";
import { assertOwnWorkspace, idParam, readQuery, requireRole, sessionOf } from "../http.ts";
import type { ApiRouter } from "./router.ts";

export const RehearsalCasesQuery = z.strictObject({
  jobId: z.guid().optional(),
  askId: z.guid().optional(),
  includeRemoved: z.enum(["true", "false"]).default("false"),
});

/** 画面に出す試験の行（状況の中身は title・障害 ID だけ。元の文は user のときだけ） */
export function rehearsalCaseView(r: RehearsalCaseRow) {
  const scenario = r.scenario as { title?: unknown };
  return {
    id: r.id,
    jobId: r.job_id,
    askId: r.ask_id,
    source: r.source,
    title: typeof scenario.title === "string" ? plainIncidentTitle(scenario.title) : null,
    faultIds: r.fault_ids,
    seed: r.seed,
    userText: r.user_text,
    sourceTaskId: r.source_task_id,
    reasonCode: r.reason_code,
    incidentKind: r.incident_kind,
    stoppedWriteCount: r.stopped_writes?.length ?? null,
    createdAt: r.created_at.toISOString(),
    removedAt: r.removed_at?.toISOString() ?? null,
    removedReason: r.removed_reason,
  };
}

const EDITORS = ["owner", "maintainer"] as const;

/** GET /workspaces/{workspaceId}/rehearsal-cases */
export function registerListRehearsalCases(r: ApiRouter, deps: AppDeps): void {
  r.get("/workspaces/:workspaceId/rehearsal-cases", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const q = readQuery(c, RehearsalCasesQuery);
    assertOwnWorkspace(s, workspaceId);
    if ((q.jobId === undefined) === (q.askId === undefined)) {
      throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "jobId", reason: "jobId か askId のどちらか一方を指定してください" }] });
    }
    const subject: CaseSubject = q.jobId !== undefined ? { jobId: q.jobId.toLowerCase() } : { askId: (q.askId as string).toLowerCase() };
    const rows = await listRehearsalCases(deps.db, s, subject, { includeRemoved: q.includeRemoved === "true" });
    return c.json({ items: rows.map(rehearsalCaseView) });
  });
}

/** DELETE /workspaces/{workspaceId}/rehearsal-cases/{caseId} */
export function registerRemoveRehearsalCase(r: ApiRouter, deps: AppDeps): void {
  r.delete("/workspaces/:workspaceId/rehearsal-cases/:caseId", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const caseId = idParam(c, "caseId");
    assertOwnWorkspace(s, workspaceId);
    requireRole(s, EDITORS);
    const now = deps.clock.now();
    const removed = await deps.db.transaction((tx) => removeRehearsalCaseByUser(tx, s, caseId, s.userId, now), { retryOnce: true });
    // 別のワークスペースの試験・すでに外した試験は「ない」と同じ（404）
    if (removed === null) throw new AppError("NOT_FOUND");
    return c.json({ case: rehearsalCaseView(removed) });
  });
}

export function rehearsalCaseRoutes(r: ApiRouter, deps: AppDeps): void {
  registerListRehearsalCases(r, deps);
  registerRemoveRehearsalCase(r, deps);
}
