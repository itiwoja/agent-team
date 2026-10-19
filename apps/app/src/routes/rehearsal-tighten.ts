// 締める変更の適用と再試験（15_hackathon.md「リハーサル」6・FR-045、D-82）。パスは rehearsal.ts と同じ流儀（/workspaces/{workspaceId}/…）
// - POST /workspaces/{workspaceId}/rehearsals/{runId}/tightening：案（JSON Patch）を kernel の checkTighteningProposal に通し、通れば設定変更（TBL-025）として保存して、
//   同じシードで再試験を始める（202）。締める変更では合格証を切らない。再試験が始められなくても適用は済み（200、retestError に理由）
// - POST /workspaces/{workspaceId}/rehearsals/{runId}/retest：適用済みの設定で、同じシードの再試験だけをもう一度始める（202）
// 評価の順（AS §3.0）：入力の検証（400）→ パスのワークスペースがセッションのものか（404）→ 権限（403）→ 処理

import type { AgentConfigChangeRow } from "@open-team/db";
import { getRehearsalRun } from "@open-team/db/rehearsal";
import { AppError } from "@open-team/platform";
import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import { assertOwnWorkspace, idParam, readJsonBody, requireRole, sessionOf } from "../http.ts";
import { applyTightening } from "../rehearsal/apply.ts";
import { proposalsOfRun } from "../rehearsal/proposals.ts";
import { startRetest } from "../rehearsal/retest.ts";
import { isScripted, rehearsalRunView } from "./rehearsal.ts";
import type { ApiRouter } from "./router.ts";

// 締める提案が使う差分は add・replace・remove だけ（packages/rehearsal の PatchOp）
const PatchOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: z.string().startsWith("/").max(200), value: z.json() }),
  z.strictObject({ op: z.literal("replace"), path: z.string().startsWith("/").max(200), value: z.json() }),
  z.strictObject({ op: z.literal("remove"), path: z.string().startsWith("/").max(200) }),
]);

export const TighteningBody = z
  .strictObject({
  /** 差分を直接渡す（proposalId とどちらか一方） */
  patch: z.array(PatchOpSchema).min(1).max(20).optional(),
  /** 結果の proposals[].id。その走行の今の提案から差分と仕事を引いて適用する（D-93。提案がなければ 404） */
  proposalId: z.string().min(1).max(64).optional(),
  /** 依頼（chain）の走行のとき、締める担当の仕事 */
  jobId: z.guid().optional(),
  /** false にすると適用だけ（再試験は /retest で別に始める）。既定は true */
  retest: z.boolean().optional(),
  })
  .refine((b) => (b.patch === undefined) !== (b.proposalId === undefined), { message: "patch か proposalId のどちらか一方を指定してください", path: ["patch"] });

export const RetestBody = z.strictObject({
  /** 確かめる締める変更（apply の結果の change.id） */
  configChangeId: z.guid().optional(),
});

/** 設定変更の行（画面に出す形：camelCase・日時は ISO） */
export function configChangeView(c: AgentConfigChangeRow, runId: string) {
  return {
    id: c.id,
    agentId: c.agent_id,
    jobId: c.job_id,
    origin: c.origin,
    classification: c.classification,
    status: c.status,
    snapshotId: c.snapshot_id,
    runId,
    patch: c.patch,
    decidedBy: c.decided_by,
    createdAt: c.created_at.toISOString(),
    decidedAt: c.decided_at?.toISOString() ?? null,
  };
}

/** 締める変更を適用してよい役割：owner・maintainer（試験を走らせる役割と同じ。viewer は見るだけ） */
const RUNNERS = ["owner", "maintainer"] as const;

/** POST /workspaces/{workspaceId}/rehearsals/{runId}/tightening */
export function registerApplyTightening(r: ApiRouter, deps: AppDeps): void {
  r.post("/workspaces/:workspaceId/rehearsals/:runId/tightening", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const runId = idParam(c, "runId");
    const body = await readJsonBody(c, TighteningBody);
    assertOwnWorkspace(s, workspaceId);
    requireRole(s, RUNNERS);
    let patch = body.patch;
    let jobId = body.jobId?.toLowerCase();
    if (body.proposalId !== undefined) {
      const run = await getRehearsalRun(deps.db, s, runId);
      if (run === null) throw new AppError("NOT_FOUND");
      const found = (await proposalsOfRun(deps, s, run)).find((p) => p.id === body.proposalId);
      if (found === undefined) throw new AppError("NOT_FOUND");
      patch = found.patch;
      jobId = found.jobId;
    }
    const applied = await applyTightening(deps, s, { runId, patch: patch as NonNullable<typeof patch>, ...(jobId !== undefined ? { jobId } : {}) });
    const change = configChangeView(applied.change, runId);
    if (body.retest === false) return c.json({ change, run: null }, 200);
    try {
      const run = await startRetest(deps, s, { parentRunId: runId, configChangeId: applied.change.id });
      return c.json({ change, run: rehearsalRunView(run, await isScripted(deps, s, run)) }, 202);
    } catch (e) {
      // 適用は済んでいる。再試験を始められなかった理由（動いている走行・Kill Switch など）を添えて返し、/retest でやり直せる
      if (e instanceof AppError) return c.json({ change, run: null, retestError: { code: e.code, message: e.message } }, 200);
      throw e;
    }
  });
}

/** POST /workspaces/{workspaceId}/rehearsals/{runId}/retest */
export function registerRetestRehearsal(r: ApiRouter, deps: AppDeps): void {
  r.post("/workspaces/:workspaceId/rehearsals/:runId/retest", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const runId = idParam(c, "runId");
    const body = await readJsonBody(c, RetestBody);
    assertOwnWorkspace(s, workspaceId);
    requireRole(s, RUNNERS);
    const run = await startRetest(deps, s, {
      parentRunId: runId,
      ...(body.configChangeId !== undefined ? { configChangeId: body.configChangeId.toLowerCase() } : {}),
    });
    return c.json({ run: rehearsalRunView(run, await isScripted(deps, s, run)) }, 202);
  });
}

export function rehearsalTightenRoutes(r: ApiRouter, deps: AppDeps): void {
  registerApplyTightening(r, deps);
  registerRetestRehearsal(r, deps);
}
