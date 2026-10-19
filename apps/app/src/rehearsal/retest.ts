// 再試験（FR-045・15:124）：締める変更を適用したあと、同じシードで今の試験を走らせ直し、親の走行に紐付ける（trigger = retest・parent_run_id）。
// - 新しい状況は作らない（Gemini の生成は呼ばない）。影の走行もしない（最初の生成の状況にだけ：shouldRunShadow が retest を除く）
// - 全件合格なら合格証を出す（suite.ts → certify.ts。単独の仕事のときだけ）。締める変更そのものでは合格証を切らない（apply.ts）
// - 走行の行ができたところで呼び出し元に返し、試験の走行は裏で続く（launch.ts と同じ形。Kill Switch で中断できる）

import type { RehearsalCaseRow, RehearsalRunRow, SessionCtx, Uuid } from "@open-team/db";
import { getWorkspace } from "@open-team/db";
import { finishRehearsalRun, findActiveRehearsalRun, getConfigChange, getRehearsalRun, listActiveRehearsalCases, type CaseSubject } from "@open-team/db/rehearsal";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import { StopRequested } from "../registry.ts";
import { microToUsd, runCostMicroUsd } from "./budget.ts";
import { buildJobMaterials } from "./launch.ts";
import { createGuestReplay, orderAsPlanned } from "../guest-rehearsal/replay.ts";
import { resolveStages } from "./run.ts";
import { runRehearsalSuite } from "./suite.ts";

export interface StartRetestInput {
  /** 再試験する走行（終わっているもの）。同じシード・同じ試験の集合で走らせ直す */
  parentRunId: Uuid;
  /** 確かめる締める変更（apply.ts の結果）。走行の config_change_id に残す */
  configChangeId?: Uuid;
}

/**
 * 再試験を台本で再現するか（ゲストの用意した依頼・GUEST_RETEST_MODE=replay・試験が用意した12件のまま）。台本のときは並べ直した試験を返し、そうでなければ null。
 * 走行の表示（routes/rehearsal.ts の scripted）も同じ判定を使う：trigger = retest の走行が台本か本物かは、この関数で決まる
 */
export function guestReplayCases<C extends Pick<RehearsalCaseRow, "scenario">>(input: {
  workspaceKind: string;
  guestRetestMode: "replay" | "gemini";
  subject: CaseSubject;
  cases: readonly C[];
}): C[] | null {
  return input.guestRetestMode !== "gemini" && input.workspaceKind === "guest" && input.subject.askId !== undefined ? orderAsPlanned(input.cases) : null;
}

type RetestDeps = Pick<AppDeps, "db" | "log" | "clock" | "ids" | "llm" | "gatewayClient" | "simClient" | "registry" | "env">;

/**
 * 再試験を起動する。走行の行ができたら返す（status は running）。終わると SSE の rehearsal.run が流れる。
 * 例外：親がない 404、親か同じ対象の走行が動いている 409（details.runId）、Kill Switch 中 423、試験がない 400
 */
export async function startRetest(deps: RetestDeps, s: SessionCtx, input: StartRetestInput): Promise<RehearsalRunRow> {
  const ctx = s;
  const parent = await getRehearsalRun(deps.db, ctx, input.parentRunId);
  if (parent === null) throw new AppError("NOT_FOUND");
  if (input.configChangeId !== undefined) {
    const change = await getConfigChange(deps.db, ctx, input.configChangeId);
    if (change === null) throw new AppError("NOT_FOUND");
    // 適用済みの変更だけ。かつ親の走行と同じ仕事のもの（別の仕事の変更を紐付けない）
    if (change.status !== "applied") throw new AppError("CHANGE_NOT_PENDING", "適用済みの変更ではありません");
    const jobIds = parent.job_id !== null ? [parent.job_id] : (await resolveStages(deps.db, ctx, { askId: parent.ask_id as Uuid })).map((x) => x.jobId);
    if (change.job_id === null || !jobIds.includes(change.job_id)) {
      throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "configChangeId", reason: "再試験する仕事の変更ではありません" }] });
    }
  }
  const ws = await getWorkspace(deps.db, ctx);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  const subject: CaseSubject = parent.job_id !== null ? { jobId: parent.job_id } : { askId: parent.ask_id as Uuid };
  const active = await findActiveRehearsalRun(deps.db, ctx, subject);
  if (active !== null) throw new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: { runId: active.id } });
  const cases = await listActiveRehearsalCases(deps.db, ctx, subject);
  if (cases.length === 0) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "parentRunId", reason: "再試験する試験がありません" }] });

  // 今のスナップショット（締める変更のあと）の指紋で走らせる：合格証の policyHash・toolHashes になる
  const materials = await buildJobMaterials(deps, s, subject);

  const controller = new AbortController();
  const launchKey = deps.ids.newId();
  deps.registry.register(launchKey, ctx.workspaceId, controller, "rehearsal_run");
  let registeredAs = launchKey;

  // ゲストの用意した依頼（試験が用意した12件のまま）は、エージェントの振る舞いを台本にして再現する（D-101）。それ以外は本物の Gemini
  // GUEST_RETEST_MODE=gemini のときは台本に差し替えない（既定は replay）
  const replayCases = guestReplayCases({ workspaceKind: ws.kind, guestRetestMode: deps.env.guestRetestMode, subject, cases });
  if (replayCases !== null) deps.log.info("rehearsal.retest_replay", "用意した依頼の再試験を台本で再現する", { workspaceId: ctx.workspaceId, parentRunId: parent.id });
  const replay = replayCases !== null ? createGuestReplay() : null;
  const runDeps = replay !== null ? { ...deps, llm: replay.llm } : deps;

  return new Promise<RehearsalRunRow>((resolve, reject) => {
    const made: { run: RehearsalRunRow | null } = { run: null };
    runRehearsalSuite(runDeps, {
      ctx,
      requesterId: s.userId,
      subject,
      trigger: "retest",
      parentRunId: parent.id,
      ...(input.configChangeId !== undefined ? { configChangeId: input.configChangeId } : {}),
      cases: replayCases ?? cases,
      // 再現では、試験ごとに台本を選ぶ（影の走行はしない：再試験は最初の生成の状況にだけ影をつける）
      ...(replay !== null ? { shadowFor: (c: RehearsalCaseRow) => (replay.select(c), false) } : {}),
      // 同じ条件：シード・モデル・試した候補のルールは親のまま
      seed: parent.seed,
      modelId: parent.model_id,
      generatorModelId: parent.generator_model_id,
      candidateRules: parent.candidate_rules,
      effectivePolicies: materials.effectivePolicies,
      policyHash: materials.policyHash,
      toolHashes: materials.toolHashes,
      stageFingerprints: materials.stageFingerprints,
      signal: controller.signal,
      onRunCreated: (run) => {
        made.run = run;
        // Kill Switch の見回り・通知は登録簿の ID で探す。走行の ID に付け替える（同じ controller）
        deps.registry.unregister(registeredAs);
        registeredAs = run.id;
        deps.registry.register(run.id, ctx.workspaceId, controller, "rehearsal_run");
        resolve(run);
      },
    })
      .catch(async (e: unknown) => {
        if (made.run === null) {
          // 走行の行ができる前の失敗（同時の起動は DB の一意制約）。呼び出し元に返す
          if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505") {
            const now = await findActiveRehearsalRun(deps.db, ctx, subject).catch(() => null);
            reject(new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: now ? { runId: now.id } : undefined }));
          } else if (e instanceof AppError) reject(e);
          else if (controller.signal.aborted || controller.signal.reason instanceof StopRequested) reject(new AppError("KILL_SWITCH_ENGAGED"));
          else reject(e);
          return;
        }
        // 走行の途中の想定外の失敗：走行を failed で閉じる（running のまま残さない）
        const run: RehearsalRunRow = made.run;
        deps.log.error("rehearsal.retest_crashed", "再試験が想定外の失敗で止まった", { workspaceId: ctx.workspaceId, runId: run.id, error: e });
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
