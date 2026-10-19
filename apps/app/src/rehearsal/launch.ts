// リハーサルの起動（HTTP の POST から呼ぶ）：状況の生成（generateScenarios）→ 試験の保存（saveGeneratedCases）→ 走行（runRehearsalSuite）。
// - 走行の行ができたところで呼び出し元に返し、試験の走行は裏で続ける（非同期）。生成の失敗・費用の上限は呼び出し元に例外で返す
// - 裏の走行は registry に rehearsal_run として登録し、Kill Switch（通知・見回り）で中断できる。生成の途中で止められても同じ controller で切れる
// - 走らせる順番は first-batch.ts（F-05・F-03・F-01 の順で先に）。集合と合格証の条件は変えない
// - 外部（Gemini・sim-world・gateway）はトランザクションの外で呼ぶ（G-14）。この層では DB のトランザクションを張らない

import { type RehearsalRunRow, type SessionCtx, type Uuid } from "@open-team/db";
import { getAskRow } from "@open-team/db/edge";
import { finishRehearsalRun, findActiveRehearsalRun, getJobStage, insertRehearsalRun, listActiveRehearsalCases, type CaseSubject } from "@open-team/db/rehearsal";
import { getWorkspace } from "@open-team/db";
import { LlmError, modelForPurpose } from "@open-team/llm";
import { AppError } from "@open-team/platform";
import { randomInt } from "node:crypto";
import type { AppDeps } from "../deps.ts";
import { StopRequested } from "../registry.ts";
import { microToUsd, runCostMicroUsd } from "./budget.ts";
import { generateScenarios, RehearsalGenerateError } from "./generate.ts";
import { geminiCallAppError, rehearsalLlm } from "./gemini.ts";
import { orderFirstBatch } from "./first-batch.ts";
import { saveGeneratedCases } from "./persist.ts";
import { buildJobMaterials } from "./job-materials.ts";
import { rehearsalGrantsOf } from "./web-grant.ts";
import { runRehearsalSuite } from "./suite.ts";

export interface StartRehearsalInput {
  subject: CaseSubject;
  /** 状況の件数（既定12・上限20：generate.ts） */
  count?: number;
  /** 基のシード（uint32。省略すると乱数） */
  seed?: number;
}

type LaunchDeps = Pick<AppDeps, "db" | "log" | "clock" | "ids" | "llm" | "gatewayClient" | "simClient" | "registry" | "env">;

/** 対象（仕事か依頼）が見つからなければ 404、依頼の形が合わなければ 400 */
async function assertSubject(deps: LaunchDeps, s: SessionCtx, subject: CaseSubject): Promise<void> {
  const ctx = s;
  if (subject.jobId !== undefined) {
    if ((await getJobStage(deps.db, ctx, subject.jobId)) === null) throw new AppError("NOT_FOUND");
    return;
  }
  const ask = await getAskRow(deps.db, ctx, subject.askId);
  if (ask === null) throw new AppError("NOT_FOUND");
  if (ask.shape !== "chain") {
    throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "askId", reason: "順番（chain）の依頼だけを対象にできます。並列・まとめは担当の仕事を指定してください" }] });
  }
}

export { buildJobMaterials } from "./job-materials.ts";

/** 生成・保存・走行の途中の失敗を、HTTP のエラーにそろえる */
function toAppError(e: unknown, signal: AbortSignal): unknown {
  if (e instanceof AppError) return e;
  if (signal.aborted || signal.reason instanceof StopRequested) return new AppError("KILL_SWITCH_ENGAGED");
  if (e instanceof RehearsalGenerateError) {
    if (e.code === "budget_exceeded") return new AppError("REHEARSAL_BUDGET_EXCEEDED");
    return new AppError("LLM_UPSTREAM_ERROR", "状況を作れませんでした。もう一度試してください", { cause: e });
  }
  if (e instanceof LlmError) return new AppError("LLM_UPSTREAM_ERROR", undefined, { cause: e });
  return geminiCallAppError(e) ?? e;
}

const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

/**
 * リハーサルを起動する。走行の行ができたら返す（status は running）。試験の走行は裏で続き、終わると SSE の rehearsal.run が流れる。
 * 例外：Kill Switch 中 423、動いている走行がある 409（details.runId）、対象がない 404、費用の上限 429、Gemini の失敗 502
 */
export async function startRehearsal(deps: LaunchDeps, s: SessionCtx, input: StartRehearsalInput): Promise<RehearsalRunRow> {
  const ctx = s;
  const ws = await getWorkspace(deps.db, ctx);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  await assertSubject(deps, s, input.subject);
  const active = await findActiveRehearsalRun(deps.db, ctx, input.subject);
  if (active !== null) throw new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: { runId: active.id } });

  const materials = await buildJobMaterials(deps, s, input.subject);
  const seed = input.seed ?? randomInt(0, 2 ** 32);
  const generatorModel = modelForPurpose(deps.env.gemini, "rehearsal_generate");
  const agentModel = deps.env.gemini.agentModel;

  // 生成の前に走行の行を generating で予約する：同じ対象の二重 POST は一意制約（rehearsal_runs_one_active_uq）で
  // Gemini を呼ぶ前に 409 になる（生成費用・試験の二重保存を防ぐ）
  let reserved: RehearsalRunRow;
  try {
    reserved = await insertRehearsalRun(deps.db, ctx, {
      subject: input.subject,
      trigger: "initial",
      effectivePolicies: materials.effectivePolicies,
      policyHash: materials.policyHash,
      toolHashes: materials.toolHashes,
      // 依頼の走行は担当ごとの指紋を行に残す（走行のあとで広げた・ツールが変わったときに合格証を出さないため：certify.ts）
      stageFingerprints: materials.stageFingerprints,
      seed,
      modelId: agentModel,
      generatorModelId: generatorModel,
      requestedBy: s.userId,
      status: "generating",
      now: deps.clock.now(),
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      const now = await findActiveRehearsalRun(deps.db, ctx, input.subject).catch(() => null);
      throw new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: now ? { runId: now.id } : undefined });
    }
    throw e;
  }

  const controller = new AbortController();
  deps.registry.register(reserved.id, ctx.workspaceId, controller, "rehearsal_run");
  const registeredAs = reserved.id;

  return new Promise<RehearsalRunRow>((resolve, reject) => {
    const made: { run: RehearsalRunRow | null } = { run: null };
    const work = async (): Promise<void> => {
      const existing = await listActiveRehearsalCases(deps.db, ctx, input.subject);
      const grants = await rehearsalGrantsOf(deps.db, ctx, input.subject);
      const gen = await generateScenarios({
        job: materials.brief,
        seed,
        webAllowDomains: grants.webAllowDomains,
        connectorSlugs: grants.connectorSlugs,
        // 生成の費用は予約した走行に付ける（走行 $3・1日の上限の集計と、画面の「悪い日を作りました · $x」）
        llm: rehearsalLlm(deps, ctx, { rehearsalRunId: reserved.id }, "rehearsal_generate"),
        model: generatorModel,
        ...(input.count !== undefined ? { count: input.count } : {}),
        existingFaults: existing.map((c) => (c.scenario as unknown as { faults: never[] }).faults ?? []),
        signal: controller.signal,
      });
      // origin_run_id は画面の「悪い日を N 件作りました」の N（generatorOf）に使う
      await saveGeneratedCases(deps.db, ctx, { subject: input.subject, scenarios: gen.scenarios, now: deps.clock.now(), originRunId: reserved.id });
      // まず3件（F-05 → F-03 → F-01 の順で優先）を先に走らせ、途中の結果を早く出す（Issue #12）。
      // 走らせる試験の集合は今までどおり「外されていない試験すべて」で、順番だけを変える（合格証の条件は変わらない）
      const cases = orderFirstBatch(await listActiveRehearsalCases(deps.db, ctx, input.subject));
      await runRehearsalSuite(deps, {
        ctx,
        cases,
        requesterId: s.userId,
        subject: input.subject,
        trigger: "initial",
        seed,
        modelId: agentModel,
        generatorModelId: generatorModel,
        effectivePolicies: materials.effectivePolicies,
        policyHash: materials.policyHash,
        toolHashes: materials.toolHashes,
        budget: { spentMicroUsd: gen.costMicroUsd },
        reservedRunId: reserved.id,
        signal: controller.signal,
        onRunCreated: (run) => {
          made.run = run;
          resolve(run);
        },
      });
    };
    work()
      .catch(async (e: unknown) => {
        if (made.run === null) {
          // 走り始める前の失敗（生成・保存）。予約した行を閉じて（次の起動を止めない）、呼び出し元に返す
          const aborted = controller.signal.aborted || controller.signal.reason instanceof StopRequested;
          await finishRehearsalRun(deps.db, ctx, reserved.id, {
            status: aborted ? "cancelled" : "failed",
            costUsd: microToUsd(0),
            error: aborted ? "止められた" : "走る前に失敗した",
            now: deps.clock.now(),
          }).catch((closing: unknown) => deps.log.error("rehearsal.run_close_failed", "予約した走行を閉じられなかった", { runId: reserved.id, error: closing }));
          reject(toAppError(e, controller.signal));
          return;
        }
        // 走行の途中の想定外の失敗：走行を failed で閉じる（running のまま残さない）
        const run: RehearsalRunRow = made.run;
        deps.log.error("rehearsal.run_crashed", "リハーサルの走行が想定外の失敗で止まった", { workspaceId: ctx.workspaceId, runId: run.id, error: e });
        try {
          const cost = await runCostMicroUsd(deps.db, ctx, run.id);
          await finishRehearsalRun(deps.db, ctx, run.id, { status: "failed", costUsd: microToUsd(cost), error: "想定外の失敗で止まった", now: deps.clock.now() });
        } catch (closing) {
          deps.log.error("rehearsal.run_close_failed", "失敗した走行を閉じられなかった", { runId: run.id, error: closing });
        }
      })
      .finally(() => deps.registry.unregister(registeredAs));
  });
}
