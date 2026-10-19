// 自分の言葉で悪い日を足す（FR-065・D-75・BR-78）：解釈（interpretUserBadDay）→ 保存（recordInterpretation）→ 1件だけ本番と同じ経路＋影で走らせる。
// - 作れるのは状況だけ。オラクル・ガード・ルール・Kernel は触らない（interpret.ts が出力を状況の形に限る）
// - 解釈の1行は呼び出し元に返し、走行は裏で続く（やめるときは registry の走行を中断する：routes の DELETE）
// - 走行は trigger = user_case の別の走行にする（親は押された画面の走行）。合格証の指紋は付けない（1件だけの走行で合格証は出さない）
// - 外部（Gemini・sim-world・gateway）はトランザクションの外で呼ぶ（G-14）

import type { RehearsalRunRow, RehearsalUserInputRow, SessionCtx, Uuid } from "@open-team/db";
import { getWorkspace } from "@open-team/db";
import { getAgentJobRow } from "@open-team/db/edge";
import { advanceUserInput, finishRehearsalRun, findActiveRehearsalRun, getRehearsalCase, getUserInput, listRehearsalScenarios, revokeJobCertificate, setScenarioInterpretation, type CaseSubject } from "@open-team/db/rehearsal";
import { modelForPurpose } from "@open-team/llm";
import { AppError } from "@open-team/platform";
import { randomInt } from "node:crypto";
import type { AppDeps } from "../deps.ts";
import { StopRequested } from "../registry.ts";
import { microToUsd, runCostMicroUsd } from "./budget.ts";
import { geminiCallAppError, rehearsalLlm } from "./gemini.ts";
import { interpretUserBadDay } from "./interpret.ts";
import { rehearsalGrantsOf } from "./web-grant.ts";
import { buildJobMaterials } from "./launch.ts";
import { loadUserInputCreatedAts, recordInterpretation } from "./persist.ts";
import { resolveStages } from "./run.ts";
import { runRehearsalSuite } from "./suite.ts";

/** ゲストが1日に足せる件数（D-75・A-106。数え方は packages/rehearsal の userCaseQuota） */
export const GUEST_USER_CASE_DAILY_LIMIT = 5;

type UserCaseDeps = Pick<AppDeps, "db" | "log" | "clock" | "ids" | "llm" | "gatewayClient" | "simClient" | "registry" | "env">;

export interface StartUserCaseInput {
  /** 押された画面の走行（この対象の試験に足す） */
  parent: RehearsalRunRow;
  text: string;
}

export interface StartedUserCase {
  input: RehearsalUserInputRow;
  run: RehearsalRunRow;
  /** 「こう解釈しました：F-02 …」の1行 */
  interpretation: string;
  faultIds: string[];
}

const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

/**
 * 解釈して、当てはまれば1件だけ走らせる。走行の行ができたら返す。
 * 例外：Kill Switch 中 423、動いている走行がある 409、入力が不正 400、1日の上限 429（USER_CASE_DAILY_LIMIT）、費用の上限 429、
 * カタログにない 422（NOT_IN_CATALOG。入力は候補として残す）、解釈を状況にできない 502、試験が20件で足せない 400
 */
export async function startUserCase(deps: UserCaseDeps, s: SessionCtx, input: StartUserCaseInput): Promise<StartedUserCase> {
  const ctx = s;
  const { parent } = input;
  const subject: CaseSubject = parent.job_id !== null ? { jobId: parent.job_id } : { askId: parent.ask_id as Uuid };
  const ws = await getWorkspace(deps.db, ctx);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  const active = await findActiveRehearsalRun(deps.db, ctx, subject);
  if (active !== null) throw new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: { runId: active.id } });

  const materials = await buildJobMaterials(deps, s, subject);
  const now = deps.clock.now();
  const seed = randomInt(0, 2 ** 32);
  const interpretModel = modelForPurpose(deps.env.gemini, "rehearsal_interpret");
  const agentModel = deps.env.gemini.agentModel;

  // 解釈の間も Kill Switch で切れるようにする（走行の ID ができたら付け替える）
  const controller = new AbortController();
  const launchKey = deps.ids.newId();
  deps.registry.register(launchKey, ctx.workspaceId, controller, "rehearsal_run");
  let registeredAs = launchKey;

  try {
    const createdAts = await loadUserInputCreatedAts(deps.db, ctx, new Date(now.getTime() - 48 * 3600_000));
    const grants = await rehearsalGrantsOf(deps.db, ctx, subject);
    const result = await interpretUserBadDay({
      text: input.text,
      job: materials.brief,
      seed,
      // 解釈の時点では走行がまだないので、費用は依頼か担当に付ける（1日の上限の集計に入れる）
      llm: rehearsalLlm(deps, ctx, subject.askId !== undefined ? { askId: subject.askId } : { agentId: await agentOfJob(deps, ctx, subject.jobId) }, "rehearsal_interpret"),
      model: interpretModel,
      workspaceKind: ws.kind,
      // F-14（Web ページに仕込まれた指示）は担当に Web の付与があるときだけ当てはめる。F-15〜F-17 と gcal.* は gcal の付与があるときだけ
      webAllowDomains: grants.webAllowDomains,
      connectorSlugs: grants.connectorSlugs,
      userInputCreatedAts: createdAts as never,
      now: now.toISOString() as never,
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new AppError("KILL_SWITCH_ENGAGED");
    switch (result.kind) {
      case "invalid_input":
        throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "text", reason: result.message }] });
      case "quota_exceeded":
        throw new AppError("USER_CASE_DAILY_LIMIT", undefined, { details: { limit: GUEST_USER_CASE_DAILY_LIMIT } });
      case "budget_exceeded":
        throw new AppError("REHEARSAL_BUDGET_EXCEEDED");
      default:
    }
    // Gemini を呼んだ結果（当てはまった・カタログにない・使えない）は入力の行に残す。1日5件はこの行で数える
    const recorded = await recordInterpretation(deps.db, { ...ctx, userId: s.userId }, { subject, result, now, workspaceKind: ws.kind });
    if (!recorded.recorded) {
      if (recorded.reason === "quota_exceeded") throw new AppError("USER_CASE_DAILY_LIMIT", undefined, { details: { limit: GUEST_USER_CASE_DAILY_LIMIT } });
      throw new AppError("INTERNAL_ERROR");
    }
    if (result.kind === "unmatched") {
      throw new AppError("NOT_IN_CATALOG", result.message, { details: { nearest: result.nearestFaultId, line: result.message, candidateId: recorded.inputId } });
    }
    if (result.kind === "rejected") throw new AppError("LLM_UPSTREAM_ERROR", result.message);
    if (recorded.status !== "matched" || recorded.caseId === null) {
      throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "text", reason: "この仕事の試験が上限（20件）に達しているので、足せません" }] });
    }
    const { inputId, caseId } = recorded;
    // 試験の追加で合格証は切れる（FR-067）。依頼の試験なら、依頼の担当の仕事ごとの合格証（D-101）をすべて切る
    const stages = await resolveStages(deps.db, ctx, subject);
    await deps.db.transaction(async (tx) => {
      for (const st of stages) await revokeJobCertificate(tx, ctx, st.jobId, "case_added", now);
    });
    const caseRow = await getRehearsalCase(deps.db, ctx, caseId);
    if (caseRow === null) throw new AppError("INTERNAL_ERROR");

    return await new Promise<StartedUserCase>((resolve, reject) => {
      const made: { run: RehearsalRunRow | null } = { run: null };
      const finishInput = async (run: RehearsalRunRow): Promise<void> => {
        const scenario = (await listRehearsalScenarios(deps.db, ctx, run.id))[0];
        if (scenario !== undefined) await setScenarioInterpretation(deps.db, ctx, scenario.id, result.interpretation);
        const status = run.status === "done" ? "done" : run.status === "cancelled" ? "cancelled" : "failed";
        await advanceUserInput(deps.db, ctx, inputId, { from: ["running", "cancelled"], status, ...(scenario ? { scenarioId: scenario.id } : {}) });
      };
      const work = async (): Promise<void> => {
        const outcome = await runRehearsalSuite(deps, {
          ctx,
          requesterId: s.userId,
          subject,
          trigger: "user_case",
          parentRunId: parent.id,
          seed,
          modelId: agentModel,
          generatorModelId: interpretModel,
          cases: [caseRow],
          // 1件だけ、本番と同じ経路と影の走行（15）
          shadowFor: () => true,
          budget: { spentMicroUsd: result.costMicroUsd },
          signal: controller.signal,
          onRunCreated: (run) => {
            made.run = run;
            deps.registry.unregister(registeredAs);
            registeredAs = run.id;
            deps.registry.register(run.id, ctx.workspaceId, controller, "rehearsal_run");
            void advanceUserInput(deps.db, ctx, inputId, { from: ["matched"], status: "running", runId: run.id })
              .then(async (row) => {
                resolve({
                  input: row ?? (await advanceUserInput(deps.db, ctx, inputId, { from: ["running"], status: "running", runId: run.id }))!,
                  run,
                  interpretation: result.interpretation,
                  faultIds: result.faultIds,
                });
              })
              .catch(reject);
          },
        });
        await finishInput(outcome.run);
      };
      work()
        .catch(async (e: unknown) => {
          if (made.run === null) {
            await advanceUserInput(deps.db, ctx, inputId, { from: ["matched"], status: "failed" }).catch(() => null);
            if (isUniqueViolation(e)) {
              const now2 = await findActiveRehearsalRun(deps.db, ctx, subject).catch(() => null);
              reject(new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: now2 ? { runId: now2.id } : undefined }));
            } else if (e instanceof AppError) reject(e);
            else if (controller.signal.aborted || controller.signal.reason instanceof StopRequested) reject(new AppError("KILL_SWITCH_ENGAGED"));
            else reject(e);
            return;
          }
          const run = made.run;
          deps.log.error("rehearsal.user_case_crashed", "自分の言葉の悪い日の走行が想定外の失敗で止まった", { workspaceId: ctx.workspaceId, runId: run.id, error: e });
          try {
            const cost = await runCostMicroUsd(deps.db, ctx, run.id);
            await finishRehearsalRun(deps.db, ctx, run.id, { status: "failed", costUsd: microToUsd(cost), error: "想定外の失敗で止まった", now: deps.clock.now() });
            await advanceUserInput(deps.db, ctx, inputId, { from: ["running"], status: "failed" });
          } catch (closing) {
            deps.log.error("rehearsal.run_close_failed", "失敗した走行を閉じられなかった", { runId: run.id, error: closing });
          }
        })
        .finally(() => deps.registry.unregister(registeredAs));
    });
  } catch (e) {
    // 走行を始める前に終わった（例外・カタログにない）ときは仮の登録を外す。走行が始まったあとは work の finally が外す
    deps.registry.unregister(registeredAs);
    throw geminiCallAppError(e) ?? e;
  }
}

/** 仕事の担当（解釈の費用の持ち主） */
async function agentOfJob(deps: Pick<UserCaseDeps, "db">, ctx: SessionCtx, jobId: Uuid): Promise<Uuid> {
  const job = await getAgentJobRow(deps.db, ctx, jobId);
  if (job === null) throw new AppError("NOT_FOUND");
  return job.agent_id;
}

/** 入力の行（画面の「こんな日も試す」の1件） */
export function userCaseView(r: RehearsalUserInputRow) {
  const line = r.interpretation?.line;
  return {
    id: r.id,
    status: r.status,
    // 「こう解釈しました：F-02 …」の1行
    interpretation: typeof line === "string" ? line : null,
    caseId: r.case_id,
    runId: r.rehearsal_run_id,
    scenarioId: r.scenario_id,
    createdAt: r.created_at.toISOString(),
  };
}

/** 走っている1件をやめる（試験は残す）。走っていない（終わった・始まる前・カタログにない・別のインスタンスで走っている）ものは 409、別の対象の入力は 404 */
export async function cancelUserCase(deps: Pick<UserCaseDeps, "db" | "registry">, s: SessionCtx, parent: RehearsalRunRow, inputId: Uuid): Promise<RehearsalUserInputRow> {
  const input = await getUserInput(deps.db, s, inputId);
  // 親の走行と同じ対象の入力だけ
  if (input === null || input.job_id !== parent.job_id || input.ask_id !== parent.ask_id) throw new AppError("NOT_FOUND");
  if (input.status !== "running" || input.rehearsal_run_id === null) throw new AppError("REHEARSAL_NOT_RUNNING");
  if (!deps.registry.abortTask(input.rehearsal_run_id, "task_terminated")) throw new AppError("REHEARSAL_NOT_RUNNING");
  // 走行の後始末は裏で続く。先に cancelled にしておく
  return (await advanceUserInput(deps.db, s, input.id, { from: ["running"], status: "cancelled" })) ?? input;
}
