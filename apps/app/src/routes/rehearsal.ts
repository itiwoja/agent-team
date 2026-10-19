// リハーサルの起動・進捗・結果（15_hackathon.md「リハーサル」、ADR-033、D-55〜D-82）。パスは 09_api の流儀（/workspaces/{workspaceId}/…）に合わせた。
// - POST /workspaces/{workspaceId}/rehearsals：起動（202）。状況の生成 → 保存 → 走行を始め、走行の行ができたら返す。走行は裏で続き、Kill Switch で中断できる
// - GET  /workspaces/{workspaceId}/rehearsals：走行の一覧（新しい順）。askId のときは担当の仕事の自動の再リハーサル（trigger = recertify）も含む
// - GET  /workspaces/{workspaceId}/rehearsals/{runId}：進捗（状況の件数・状態）。リアルタイムの進捗は EP-45 の SSE の事象 rehearsal.scenario・rehearsal.run
// - GET  /workspaces/{workspaceId}/rehearsals/{runId}/result：結果（3段の集計・防いだ損害・状況ごとの行・締める提案 proposals・自分の悪い日 userCases）
// - GET  /workspaces/{workspaceId}/rehearsals/{runId}/certificate：その走行が出した合格証（なければ 404）。auditSeq は監査ログ rehearsal.certificate_issued の seq
// 評価の順（AS §3.0）：入力の検証（400）→ パスのワークスペースがセッションのものか（404）→ 権限（403）→ 処理。
// 次の担当はここに「registerXxx」を1つ足し、rehearsalRoutes の末尾で呼ぶ（関数ごとに分けてあるので、ほかのルートを触らずに足せる）

import { getWorkspace, type RehearsalCaseRow, type RehearsalRunRow, type RehearsalScenarioRow, type SessionCtx, type Uuid } from "@open-team/db";
import { getRehearsalRun, getRunCertificate, listActiveRehearsalCases, listRehearsalRuns, listRehearsalScenarios, type CaseSubject } from "@open-team/db/rehearsal";
import { AppError } from "@open-team/platform";
import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import { assertOwnWorkspace, idParam, readJsonBody, readQuery, requireRole, sessionOf } from "../http.ts";
import { startRehearsal } from "../rehearsal/launch.ts";
import { guestReplayCases } from "../rehearsal/retest.ts";
import { proposalsOfRun } from "../rehearsal/proposals.ts";
import { countsOfRun, generatorOf, rehearsalCertificateView } from "../rehearsal/result.ts";
import { incidentNotesOfRun } from "../rehearsal/incident-note.ts";
import { failedOraclesView, rehearsalScenarioView } from "../rehearsal/scenario-view.ts";
import { userCaseResultsOf } from "../rehearsal/user-case-results.ts";
import { rehearsalCaseRoutes } from "./rehearsal-cases.ts";
import type { ApiRouter } from "./router.ts";

/** 起動の本文：対象は仕事か依頼のちょうど片方 */
export const RehearsalStartBody = z
  .strictObject({
    jobId: z.guid().optional(),
    askId: z.guid().optional(),
    /** 状況の件数（既定12・上限20） */
    count: z.number().int().min(1).max(20).optional(),
    /** 基のシード（uint32。省略すると乱数） */
    seed: z.number().int().min(0).max(0xffffffff).optional(),
  })
  .refine((b) => (b.jobId === undefined) !== (b.askId === undefined), { message: "jobId か askId のどちらか一方を指定してください", path: ["jobId"] });

export const RehearsalListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  jobId: z.guid().optional(),
  askId: z.guid().optional(),
});

/**
 * 走行が台本で再現した結果か（Gemini を呼んでいない）。seed は必ず台本。retest は再試験の判定（retest.ts の guestReplayCases）と同じ条件で決める。
 * 試験の並びは今の試験で見る（再試験のあとに試験を足した・消したときは、本物の走行として出ることがある）
 */
export async function scriptedOf(deps: AppDeps, s: SessionCtx, runs: readonly RehearsalRunRow[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>(runs.map((r) => [r.id, r.trigger === "seed"]));
  const retests = runs.filter((r) => r.trigger === "retest");
  if (retests.length === 0) return out;
  const ws = await getWorkspace(deps.db, s);
  const casesBySubject = new Map<string, RehearsalCaseRow[]>();
  for (const run of retests) {
    // 再試験の走行の行は、親と同じ対象（job_id か ask_id）を持つ
    const subject: CaseSubject = run.job_id !== null ? { jobId: run.job_id } : { askId: run.ask_id as Uuid };
    const key = run.job_id ?? run.ask_id ?? "";
    let cases = casesBySubject.get(key);
    if (cases === undefined) {
      cases = await listActiveRehearsalCases(deps.db, s, subject);
      casesBySubject.set(key, cases);
    }
    out.set(run.id, ws !== null && guestReplayCases({ workspaceKind: ws.kind, guestRetestMode: deps.env.guestRetestMode, subject, cases }) !== null);
  }
  return out;
}

/** 1件の走行が台本で再現した結果か（scriptedOf の1件版） */
export async function isScripted(deps: AppDeps, s: SessionCtx, run: RehearsalRunRow): Promise<boolean> {
  return (await scriptedOf(deps, s, [run])).get(run.id) === true;
}

/** 画面に出す走行の行（AS の流儀：camelCase・日時は ISO・金額は USD の文字列）。scripted は isScripted で決めて渡す（既定は seed だけ true） */
export function rehearsalRunView(r: RehearsalRunRow, scripted: boolean = r.trigger === "seed") {
  return {
    id: r.id,
    jobId: r.job_id,
    askId: r.ask_id,
    trigger: r.trigger,
    // 台本で再現した結果か（Gemini の費用 0）。web の印と「本物で走らせる」の出し分けに使う
    scripted,
    status: r.status,
    seed: r.seed,
    modelId: r.model_id,
    adaptRound: r.adapt_round,
    damageJpy: r.damage_jpy,
    // 統制なしの損害（影の走行。結果の画面にだけ出す：BR-67③）
    withoutControlDamageJpy: r.shadow_damage_jpy,
    preventedDamageJpy: r.prevented_damage_jpy,
    costUsd: r.cost_usd,
    budgetUsd: r.budget_usd,
    certificateId: r.certificate_id,
    // 合格証が出なかった理由（not_job・no_fingerprint・not_all_passed・stale など。出た・まだ終わっていない・古い走行は null）
    certificateReason: typeof r.summary?.certificateReason === "string" ? r.summary.certificateReason : null,
    error: r.error,
    createdAt: r.created_at.toISOString(),
    startedAt: r.started_at?.toISOString() ?? null,
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

// ---- ルート（1つずつ関数にしてある） ----

/** 試験を走らせてよい役割：owner・maintainer（Kill Switch の発動と同じ。viewer は見るだけ） */
const RUNNERS = ["owner", "maintainer"] as const;

/** POST /workspaces/{workspaceId}/rehearsals */
export function registerStartRehearsal(r: ApiRouter, deps: AppDeps): void {
  r.post("/workspaces/:workspaceId/rehearsals", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const body = await readJsonBody(c, RehearsalStartBody);
    assertOwnWorkspace(s, workspaceId);
    requireRole(s, RUNNERS);
    const subject: CaseSubject = body.jobId !== undefined ? { jobId: body.jobId.toLowerCase() } : { askId: (body.askId as string).toLowerCase() };
    const run = await startRehearsal(deps, s, {
      subject,
      ...(body.count !== undefined ? { count: body.count } : {}),
      ...(body.seed !== undefined ? { seed: body.seed } : {}),
    });
    return c.json({ run: rehearsalRunView(run, await isScripted(deps, s, run)) }, 202);
  });
}

/** GET /workspaces/{workspaceId}/rehearsals */
export function registerListRehearsals(r: ApiRouter, deps: AppDeps): void {
  r.get("/workspaces/:workspaceId/rehearsals", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const q = readQuery(c, RehearsalListQuery);
    assertOwnWorkspace(s, workspaceId);
    if (q.jobId !== undefined && q.askId !== undefined) {
      throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "jobId", reason: "jobId と askId は同時に指定できません" }] });
    }
    const subject: CaseSubject | undefined =
      q.jobId !== undefined ? { jobId: q.jobId.toLowerCase() } : q.askId !== undefined ? { askId: q.askId.toLowerCase() } : undefined;
    // askId：依頼の走行に、担当の仕事の自動の再リハーサル（job_id だけの走行）も足す（依頼のページの「再リハーサル中」と結果のため）
    const runs = await listRehearsalRuns(deps.db, s, { ...(subject ? { subject } : {}), limit: q.limit, withMemberRecertify: q.askId !== undefined });
    const scripted = await scriptedOf(deps, s, runs);
    return c.json({ items: runs.map((r) => rehearsalRunView(r, scripted.get(r.id) === true)) });
  });
}

/** 走行を取る（別のワークスペースのものは 404） */
async function loadRun(deps: AppDeps, s: ReturnType<typeof sessionOf>, runId: Uuid): Promise<RehearsalRunRow> {
  const run = await getRehearsalRun(deps.db, s, runId);
  if (run === null) throw new AppError("NOT_FOUND");
  return run;
}

/** GET /workspaces/{workspaceId}/rehearsals/{runId}：進捗（再接続した画面の現在地。つづきは SSE） */
export function registerRehearsalProgress(r: ApiRouter, deps: AppDeps): void {
  r.get("/workspaces/:workspaceId/rehearsals/:runId", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const runId = idParam(c, "runId");
    assertOwnWorkspace(s, workspaceId);
    const run = await loadRun(deps, s, runId);
    const scenarios = await listRehearsalScenarios(deps.db, s, run.id);
    const count = (...st: Array<RehearsalScenarioRow["status"]>): number => scenarios.filter((x) => st.includes(x.status)).length;
    const total = typeof run.summary?.total === "number" ? run.summary.total : scenarios.length;
    return c.json({
      run: rehearsalRunView(run, await isScripted(deps, s, run)),
      progress: {
        total,
        done: count("done"),
        running: count("queued", "running", "judging"),
        cancelled: count("cancelled"),
        error: count("error"),
        scenarios: scenarios.map((x) => ({ id: x.id, caseId: x.case_id, ordinal: x.ordinal, status: x.status, verdict: x.verdict, abortReason: x.abort_reason, stoppedBy: x.stopped_by, failedOracles: failedOraclesView(x.branch_results) })),
      },
    });
  });
}

/** GET /workspaces/{workspaceId}/rehearsals/{runId}/result：結果（3段の集計・防いだ損害・状況ごとの行） */
export function registerRehearsalResult(r: ApiRouter, deps: AppDeps): void {
  r.get("/workspaces/:workspaceId/rehearsals/:runId/result", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const runId = idParam(c, "runId");
    assertOwnWorkspace(s, workspaceId);
    const run = await loadRun(deps, s, runId);
    const scenarios = await listRehearsalScenarios(deps.db, s, run.id);
    const { counts, provisional } = countsOfRun(run, scenarios);
    const [proposals, userCases, notes] = await Promise.all([proposalsOfRun(deps, s, run), userCaseResultsOf(deps, s, run), incidentNotesOfRun(deps, s, run, scenarios)]);
    return c.json({
      run: rehearsalRunView(run, await isScripted(deps, s, run)),
      // 悪い日を作った Gemini（用意した走行は null）
      generator: await generatorOf(deps.db, s, run),
      counts,
      provisional,
      preventedDamageJpy: run.prevented_damage_jpy,
      // incidentNote：却下した書き込みの試験で、同じ宛先・違う内容がルールで確認なしに送られたときの注記（D-110。合否は変えない）
      scenarios: scenarios.map((x) => ({ ...rehearsalScenarioView(x), incidentNote: notes.get(x.id) ?? null })),
      // 締める提案（D-93。id は POST …/tightening の proposalId）と、この走行の画面から足した自分の悪い日
      proposals,
      userCases,
    });
  });
}

/** GET /workspaces/{workspaceId}/rehearsals/{runId}/certificate：その走行が出した合格証 */
export function registerRehearsalCertificate(r: ApiRouter, deps: AppDeps): void {
  r.get("/workspaces/:workspaceId/rehearsals/:runId/certificate", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const runId = idParam(c, "runId");
    assertOwnWorkspace(s, workspaceId);
    const run = await loadRun(deps, s, runId);
    const cert = await getRunCertificate(deps.db, s, run.id);
    if (cert === null) throw new AppError("NOT_FOUND");
    return c.json({ certificate: rehearsalCertificateView(cert) });
  });
}

export function rehearsalRoutes(r: ApiRouter, deps: AppDeps): void {
  registerStartRehearsal(r, deps);
  registerListRehearsals(r, deps);
  registerRehearsalProgress(r, deps);
  registerRehearsalResult(r, deps);
  registerRehearsalCertificate(r, deps);
  rehearsalCaseRoutes(r, deps);
}
