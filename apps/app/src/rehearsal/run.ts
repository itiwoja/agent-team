// リハーサルの実行（FR-043）と判定（FR-044）の核：試験（rehearsal_cases の1件）を1回走らせる。
// 新しい実行系は作らない（ADR-015）。本番と同じ経路を使う：タスクを作る → タスクのトークン → runner の runTask → edge（createEdge。LLM Proxy・
// decide・Intent の記録）→ gateway（EP-49 の読み取り・EP-50 の書き込みの実行）→ sim-world。リハーサルの追加点だけを足す：
//   (a) 世界を作って状況を投入（sim-client の createExecution）、(b) rehearsal_run_id・shadow を付けてタスクを作る（insertRehearsalTask。BR-67①）、
//   (c) 承認待ちの Intent を「却下した場合」（そのまま）と「承認した場合」（fork した世界で人が承認したことにして実行）の両方に分ける、
//   (d) 終わりの状態をオラクル（O-01〜08）と損害の式で判定、(e) 誰が止めたかを Intent・判定の行から決める、(f) rehearsal_scenarios に保存して SSE に流す
// 世界の側の書き込み（tools/call）は gateway だけが行う。ここ（app）は sim-world の管理 API（走行の作成・fork・advance・damage・取得）だけを呼ぶ

import {
  appendAuditLog,
  lockWorkspace,
  type ActionIntentRow,
  type Db,
  type Queryable,
  type RehearsalCaseRow,
  type RehearsalScenarioRow,
  type ScenarioAbortReason,
  type TaskRow,
  type Uuid,
  type WsCtx,
} from "@open-team/db";
import {
  endTask,
  expireOpenIntentsOfTask,
  getTask,
  insertActionIntent,
} from "@open-team/db/edge";
import {
  finishRehearsalScenario,
  insertRehearsalScenario,
  insertRehearsalTask,
  listDecisionsOfTasks,
  listIntentsOfTasks,
  setFirstShadowDamage,
} from "@open-team/db/rehearsal";
import { createEdge, issueTaskToken, loadTaskPolicy, type EdgeDeps } from "@open-team/edge";
import type { EffectivePolicy, StoppedWrite } from "@open-team/kernel";
import { runTask } from "@open-team/runner";
import type { SimExecutionDetail } from "@open-team/sim-client";
import {
  ScenarioSchema,
  endAtTime,
  isCommittedWrite,
  virtualTime,
  type DamageBreakdown,
  type OracleVerdict,
  type Scenario,
  type ScenarioResult,
  type ShopState,
} from "@open-team/sim-core";
import type { AppDeps } from "../deps.ts";
import { TRUSTED_SKILLS } from "../packs/catalog.ts";
import { StopRequested } from "../registry.ts";
import type { BudgetInput } from "./cost.ts";
import { listAuditLogs } from "@open-team/db/app";
import { canStartCase, microToUsd, tasksCostMicroUsd, type StartDenied } from "./budget.ts";
import { buildScenarioResult, dayBudgetHaltOf, faultIdsOf, judgeVariant, kernelStopOf, oracleDecisionOf, oracleIntentOf, toJson, type VariantRecord } from "./judge.ts";
import { appendScenarioEvent, type RehearsalScenarioEventData } from "./progress.ts";
import { rehearsalWebOf, type RehearsalWebBinding } from "./web-adapter.ts";
import { f14PageReadOf } from "./web-faults.ts";
import { resolveStages, type RehearsalStage } from "./stages.ts";

// 段の決め方は stages.ts（web-grant.ts からも使うので、run.ts との循環を作らないよう分けた）
export { resolveStages, type RehearsalStage } from "./stages.ts";

// ---- 入力・出力 ----

export type RehearsalRunDeps = Pick<AppDeps, "db" | "log" | "clock" | "ids" | "llm" | "gatewayClient" | "simClient" | "registry" | "env"> & {
  /** 試験で差し替える（edge の LLM のやり直しの待ち・上限・費用の上限・仮の ID） */
  edge?: Partial<Pick<EdgeDeps, "retry" | "limits" | "spendLimits" | "newId" | "knownSecrets">>;
};

export interface RunCaseInput {
  ctx: WsCtx;
  /** タスクの requester_id（人の操作は ctx.userId。tick からの再リハーサルなどは呼び出し側が渡す） */
  requesterId: Uuid;
  runId: Uuid;
  case: RehearsalCaseRow;
  /** 走行の中の並び（1 から） */
  ordinal: number;
  /** 省略すると試験の対象（仕事・順番の依頼）から決める（resolveStages） */
  stages?: readonly RehearsalStage[];
  /** 影の走行をするか（最初の生成の状況だけ：shadow.ts の shouldRunShadow）。既定 false */
  withShadow?: boolean;
  /** 呼び出し側が持つここまでの費用と上限（BR-62。省略すると DB の合計と既定の $3） */
  budget?: BudgetInput;
  /** true なら始めずに cancelled(budget) の行を残す（走行の中で前の状況が費用の上限で止まった：残りも同じ上限に当たる） */
  budgetExhausted?: boolean;
  signal?: AbortSignal;
}

interface BaseOutcome {
  scenarioId: Uuid;
  row: RehearsalScenarioRow;
}
export type CaseOutcome =
  | (BaseOutcome & { kind: "done"; result: ScenarioResult; costMicroUsd: number; shadow: "ran" | "skipped" | "not_requested" })
  /** 始める前に止めた（予算・Kill Switch）。cancelled の状況の行だけ残る */
  | (BaseOutcome & { kind: "not_started"; reason: StartDenied })
  /** 走らせている途中で止められた（Kill Switch・利用者）。結果は出さない */
  | (BaseOutcome & { kind: "aborted"; reason: ScenarioAbortReason; costMicroUsd: number })
  /** 基盤の失敗（LLM が再試行のあとも失敗・sim-world に届かない・想定外の例外）。合否を出さない */
  | (BaseOutcome & { kind: "error"; error: string; costMicroUsd: number });

// ---- 走行の実行（1種類ぶん） ----

type VariantName = "governed" | "shadow";
interface VariantRun {
  variant: VariantName;
  executionId: Uuid;
  /** 動かしたタスク（動かした順） */
  taskIds: Uuid[];
  end: "completed" | "llm_error" | "aborted";
  error: string | null;
}

interface CaseEnv {
  deps: RehearsalRunDeps;
  ctx: WsCtx;
  input: RunCaseInput;
  /** この状況の行（rehearsal_scenarios.id。タスクの rehearsal_scenario_id） */
  scenarioId: Uuid;
  scenario: Scenario;
  stages: readonly RehearsalStage[];
  signal: AbortSignal;
  edge: ReturnType<typeof createEdge>;
  /** リハーサルの Web（模擬の世界）。走らせるタスクの実行を bind してから runTask する */
  web: RehearsalWebBinding;
}

const now = (c: CaseEnv): Date => c.deps.clock.now();
const stateOf = (d: SimExecutionDetail): ShopState => d.state as ShopState;

async function createWorld(c: CaseEnv, variant: VariantName): Promise<Uuid> {
  const executionId = c.deps.ids.newId();
  await c.deps.simClient.createExecution(
    {
      workspaceId: c.ctx.workspaceId,
      world: c.scenario.world,
      rehearsalRunId: c.input.runId,
      executionId,
      variant,
      scenario: c.scenario,
      ...(c.input.case.sim_snapshot_id !== null ? { snapshotId: c.input.case.sim_snapshot_id } : {}),
    },
    { signal: c.signal },
  );
  return executionId;
}

async function advanceTo(c: CaseEnv, executionId: Uuid, to: (clock: ShopState["clock"]) => string): Promise<void> {
  const d = await c.deps.simClient.getExecution({ workspaceId: c.ctx.workspaceId, executionId }, { signal: c.signal });
  await c.deps.simClient.advanceExecution({ workspaceId: c.ctx.workspaceId, executionId, to: to(stateOf(d).clock) }, { signal: c.signal });
}

/** 世界の中でエージェントを動かす（1日目 18:00 から。F-01 は 2日目 18:00 にもう一度）。本番と同じ経路：タスク → トークン → runTask */
async function runVariant(c: CaseEnv, variant: VariantName): Promise<VariantRun> {
  const executionId = await createWorld(c, variant);
  c.web.bind(executionId);
  const out: VariantRun = { variant, executionId, taskIds: [], end: "completed", error: null };
  for (let day = 1; day <= c.scenario.agentRuns; day++) {
    if (day > 1) await advanceTo(c, executionId, (clock) => virtualTime(clock, day, "18:00"));
    let previous: Uuid[] = [];
    for (const stage of c.stages) {
      if (c.signal.aborted) return { ...out, end: "aborted" };
      const task = await insertRehearsalTask(c.deps.db, c.ctx, {
        runId: c.input.runId,
        scenarioId: c.scenarioId,
        simExecutionId: executionId,
        variant,
        agentId: stage.agentId,
        agentSnapshotId: stage.agentSnapshotId,
        jobId: stage.jobId,
        requesterId: c.input.requesterId,
        askId: c.input.case.ask_id,
        askMemberId: stage.askMemberId,
        inputTaskIds: previous,
        now: now(c),
      });
      out.taskIds.push(task.id);
      const token = await c.deps.db.transaction((tx) => issueTaskToken(tx, c.ctx, task.id, now(c)));
      const r = await runTask(c.edge, token, { signal: c.signal });
      if (r.end === "aborted") return { ...out, end: "aborted" };
      if (r.end === "llm_unavailable") return { ...out, end: "llm_error", error: "LLM の呼び出しが再試行のあとも失敗した" };
      // 前の段が報告を出さなければ次の段は始めない（measure と同じ：agt:227）
      if (r.end !== "report_submitted") break;
      previous = [task.id];
    }
  }
  return out;
}

// ---- 走行の後始末・承認した分岐 ----

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "completed", "rejected", "failed", "cancelled", "halted"]);

/** まだ終わっていないタスク（承認待ち・実行中のまま）を終える：承認待ちの Intent は「却下した場合」として失効（rehearsal_end）。ロックの順はワークスペース → タスク → Intent（M-21） */
async function settleTasks(c: CaseEnv, taskIds: readonly Uuid[], detail: string): Promise<void> {
  const { db } = c.deps;
  for (const id of taskIds) {
    await db.transaction(async (tx) => {
      const at = now(c);
      await lockWorkspace(tx, c.ctx);
      const before = await getTask(tx, c.ctx, id);
      if (before === null || TERMINAL_STATUSES.has(before.status)) return;
      await expireOpenIntentsOfTask(tx, c.ctx, id, "rehearsal_end", at);
      const ended = await endTask(tx, c.ctx, id, { status: "completed", detail }, at);
      if (ended !== null) {
        await appendAuditLog(
          tx,
          c.ctx.workspaceId,
          {
            eventType: "task.status_changed",
            actorType: "system",
            actorId: "rehearsal",
            taskId: id,
            payload: { taskId: id, from: before.status, to: ended.status, detail },
          },
          at,
        );
      }
    });
  }
}

interface ApproveRun {
  executionId: Uuid;
  /** 承認した分岐のタスク */
  taskIds: Uuid[];
  /** 人が承認したことにして実行した Intent の写し（元の Intent の id → 写し） */
  copies: ActionIntentRow[];
}

/**
 * 承認した分岐（SW §4.4.3 の4）：本番の経路で承認待ちになった Intent があれば、その時点の世界を fork し、承認待ちの Intent を
 * 人が承認したことにして（status = approved の写し）gateway に実行させる。承認待ちがなければ分岐しない（null）。
 * 承認の行は作らない（リハーサルのタスクは承認の行を持たない：DB §4.6）。写しは元と同じ内容（intentHash・宛先・option・汚染の印）
 */
async function runApproveBranch(c: CaseEnv, governed: VariantRun, pending: readonly ActionIntentRow[]): Promise<ApproveRun | null> {
  if (pending.length === 0) return null;
  const { db, simClient, gatewayClient } = c.deps;
  const executionId = c.deps.ids.newId();
  await simClient.forkExecution({ workspaceId: c.ctx.workspaceId, sourceExecutionId: governed.executionId, executionId }, { signal: c.signal });
  const out: ApproveRun = { executionId, taskIds: [], copies: [] };
  const copyIds: Uuid[] = [];
  const byTask = new Map<Uuid, ActionIntentRow[]>();
  for (const i of pending) byTask.set(i.task_id, [...(byTask.get(i.task_id) ?? []), i]);
  for (const [sourceTaskId, intents] of byTask) {
    const source = await getTask(db, c.ctx, sourceTaskId);
    if (source === null) throw new Error(`承認待ちの Intent のタスク ${sourceTaskId} が見つからない`);
    await db.transaction(async (tx) => {
      const at = now(c);
      const branchTask = await insertRehearsalTask(tx, c.ctx, {
        runId: c.input.runId,
        scenarioId: c.scenarioId,
        simExecutionId: executionId,
        variant: "governed_approve",
        agentId: source.agent_id,
        agentSnapshotId: source.agent_snapshot_id,
        jobId: source.job_id,
        requesterId: c.input.requesterId,
        askId: source.ask_id,
        askMemberId: source.ask_member_id,
        inputTaskIds: source.input_task_ids,
        taint: { tainted: source.tainted, sources: source.taint_sources },
        // gateway は終了状態のタスクの Intent を実行しない。実行が終わるまで running にしておく
        status: "running",
        now: at,
      });
      out.taskIds.push(branchTask.id);
      for (const i of intents) {
        const copyId = await insertActionIntent(
          tx,
          c.ctx,
          {
            taskId: branchTask.id,
            jobId: i.job_id,
            connectorId: i.connector_id,
            action: i.action,
            origin: i.origin,
            payload: i.payload,
            toolHash: i.tool_hash,
            destinationKey: i.destination_key,
            optionDigest: i.option_digest,
            taintSnapshot: i.taint_snapshot,
            status: "approved",
            decision: i.decision,
            reasonCode: i.reason_code,
            matchedRule: i.matched_rule,
            decisionDetail: (i.decision_detail ?? null) as never,
            enforced: true,
            policyHash: i.policy_hash,
            intentHash: i.intent_hash,
            expiresAt: null,
          },
          at,
        );
        copyIds.push(copyId);
      }
    });
  }
  // 作った順に実行する（元の Intent の作成順）。失敗は Intent の行に残り、オラクルが終わりの状態から判定する
  for (const id of copyIds) {
    try {
      await gatewayClient.executeIntent(id, { signal: c.signal });
    } catch (error) {
      if (c.signal.aborted) throw error;
      c.deps.log.warn("rehearsal.approve_branch_execute_failed", "承認した分岐の Intent を実行できなかった", { intentId: id, error });
    }
  }
  out.copies = (await listIntentsOfTasks(db, c.ctx, out.taskIds)).filter((i) => copyIds.includes(i.id));
  await settleTasks(c, out.taskIds, "approved_branch");
  return out;
}

// ---- 1件を走らせる ----

function abortReasonOf(signal: AbortSignal): ScenarioAbortReason {
  const r: unknown = signal.reason;
  if (r instanceof StopRequested && r.stopCause === "kill_switch") return "kill_switch";
  return "user";
}

/** 終わりの状態・事象・損害を取る（sim-world の管理 API。損害の式は sim-world が持つ：BR-79） */
async function collect(c: CaseEnv, executionId: Uuid): Promise<{ detail: SimExecutionDetail; damage: DamageBreakdown }> {
  const ref = { workspaceId: c.ctx.workspaceId, executionId };
  await advanceTo(c, executionId, (clock) => endAtTime(clock, c.scenario.endAt));
  const detail = await c.deps.simClient.getExecution(ref, { signal: c.signal });
  const { damage } = await c.deps.simClient.computeDamage(ref, { signal: c.signal });
  return { detail, damage };
}

async function recordOf(
  c: CaseEnv,
  variant: VariantRecord["variant"],
  got: { detail: SimExecutionDetail },
  taskIds: readonly Uuid[],
  extraIntents: readonly ReturnType<typeof oracleIntentOf>[] = [],
  baseIntents: readonly ActionIntentRow[] | null = null,
): Promise<VariantRecord> {
  const intents = baseIntents ?? (await listIntentsOfTasks(c.deps.db, c.ctx, taskIds));
  const decisions = await listDecisionsOfTasks(c.deps.db, c.ctx, taskIds);
  return {
    variant,
    initial: got.detail.initialState as ShopState,
    final: stateOf(got.detail),
    events: got.detail.events,
    intents: [...intents.map((i) => oracleIntentOf(i)), ...extraIntents],
    decisions: decisions.map(oracleDecisionOf),
  };
}

/**
 * 試験を1件走らせる（FR-043・044）。流れ：始めてよいか（Kill Switch・費用）→ 状況の行 → 本番の経路（governed）→ 承認した分岐 → 影（任意）→
 * 判定 → 保存・SSE。LLM・世界・gateway の失敗は error、止められたら aborted（結果は出さない）。
 * 影の走行は最後（費用の上限に当たったら影を捨てて、本番の経路の結果を守る）
 */
export async function runRehearsalCase(deps: RehearsalRunDeps, input: RunCaseInput): Promise<CaseOutcome> {
  const { db } = deps;
  const ctx = input.ctx;
  const scenario = ScenarioSchema.parse(input.case.scenario);
  const at = deps.clock.now();
  const spendLimits = deps.edge?.spendLimits;

  const start = input.budgetExhausted
    ? { ok: false as const, reason: "budget" as const }
    : await canStartCase(db, ctx, input.runId, at, { ...(input.budget ? { budget: input.budget } : {}), ...(spendLimits ? { spendLimits } : {}) });
  if (!start.ok) {
    const row = await insertRehearsalScenario(db, ctx, { runId: input.runId, caseRow: input.case, ordinal: input.ordinal, cancelled: start.reason === "budget" ? "budget" : "kill_switch", now: at });
    await publish(db, ctx, row, { status: "cancelled", result: null, costMicroUsd: 0, now: at });
    return { kind: "not_started", reason: start.reason, scenarioId: row.id, row };
  }

  const stages = input.stages ?? (await resolveStages(db, ctx, { jobId: input.case.job_id, askId: input.case.ask_id }));
  const row = await insertRehearsalScenario(db, ctx, { runId: input.runId, caseRow: input.case, ordinal: input.ordinal, now: at });
  const controller = new AbortController();
  const link = (): void => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) link();
  else input.signal?.addEventListener("abort", link, { once: true });
  deps.registry.register(row.id, ctx.workspaceId, controller, "rehearsal_run");

  const c: CaseEnv = {
    deps,
    ctx,
    input,
    scenarioId: row.id,
    scenario,
    stages,
    signal: controller.signal,
    edge: undefined as never,
    web: rehearsalWebOf(deps.simClient, ctx.workspaceId),
  };
  c.edge = createEdge({
    db,
    llm: deps.llm,
    gateway: deps.gatewayClient,
    clock: deps.clock,
    log: deps.log,
    models: { agentModel: deps.env.gemini.agentModel, plannerModel: deps.env.gemini.plannerModel },
    signalFor: () => controller.signal,
    // 取得・検索は模擬の世界へ（本番と同じ統制。F-14 のページを読ませる口）
    rehearsalWeb: c.web.web,
    // load_skill が信頼して渡すスキル（本番と同じ：SG-05）
    trustedSkills: TRUSTED_SKILLS,
    // 仮想の時計の世界では「今」は世界の時刻（デモ店舗と同じ：G-07）
    virtualNow: async (_ctx, task: TaskRow) => {
      if (task.sim_execution_id === null) return null;
      const d = await deps.simClient.getExecution({ workspaceId: ctx.workspaceId, executionId: task.sim_execution_id }, { signal: controller.signal });
      return stateOf(d).clock.now;
    },
    hooks: {
      // 本番では app の intents が EP-50 を起こす。リハーサルは同じ gateway の実行を、書き込みが approved になったらすぐ起こす
      // （allow・影の走行。pending_approval は起こさない：承認した分岐だけが人の承認として実行する）
      onIntentRecorded: async (_c, e) => {
        if (e.status !== "approved") return;
        await deps.gatewayClient.executeIntent(e.intentId, { signal: controller.signal });
      },
    },
    ...deps.edge,
  });

  const allTaskIds: Uuid[] = [];
  const track = (...ids: Uuid[]): void => void allTaskIds.push(...ids);
  const executionIds: { governed?: Uuid; approve?: Uuid; shadow?: Uuid } = {};
  const costOf = async (): Promise<number> => tasksCostMicroUsd(db, ctx, allTaskIds);
  const finishFailure = async (kind: "aborted" | "error", reason: ScenarioAbortReason | null, error: string | null): Promise<CaseOutcome> => {
    const cost = await costOf();
    const finishedAt = deps.clock.now();
    const done = await db.transaction(async (tx) => {
      const r = await finishRehearsalScenario(tx, ctx, row.id, {
        status: kind === "aborted" ? "cancelled" : "error",
        abortReason: reason,
        error,
        costUsd: microToUsd(cost),
        governedExecutionId: executionIds.governed ?? null,
        approveExecutionId: executionIds.approve ?? null,
        shadowExecutionId: executionIds.shadow ?? null,
        now: finishedAt,
      });
      const final = r ?? row;
      await appendScenarioEvent(tx, ctx, eventData(final, kind === "aborted" ? "cancelled" : "error", null, cost), finishedAt);
      return final;
    });
    if (kind === "aborted") return { kind: "aborted", reason: reason ?? "user", scenarioId: row.id, row: done, costMicroUsd: cost };
    return { kind: "error", error: error ?? "", scenarioId: row.id, row: done, costMicroUsd: cost };
  };

  try {
    // 1. 本番の経路（統制あり）
    const governed = await runVariant(c, "governed");
    track(...governed.taskIds);
    executionIds.governed = governed.executionId;
    if (governed.end === "aborted") return await finishFailure("aborted", abortReasonOf(controller.signal), null);
    if (governed.end === "llm_error") return await finishFailure("error", null, governed.error);
    if (await runLimitReached(c, governed.taskIds)) return await finishFailure("aborted", "budget", "リハーサルの費用の上限に達したので、この状況は判定しない");

    // 2. 承認した分岐（承認待ちがあったときだけ）。fork は、世界を終わりまで進める前の状態から
    const governedIntents = await listIntentsOfTasks(db, ctx, governed.taskIds);
    const pending = governedIntents.filter((i) => i.status === "pending_approval" && i.decision === "approve");
    const approve = await runApproveBranch(c, governed, pending);
    if (approve !== null) {
      track(...approve.taskIds);
      executionIds.approve = approve.executionId;
      if (await runLimitReached(c, approve.taskIds)) return await finishFailure("aborted", "budget", "リハーサルの費用の上限に達したので、この状況は判定しない");
    }
    await settleTasks(c, governed.taskIds, "actions_declined");

    // 3. 世界を終わりまで進めて、終わりの状態・損害を取る
    const g = await collect(c, governed.executionId);
    const a = approve === null ? null : await collect(c, approve.executionId);

    // 4. 影（任意。最後：費用の上限に当たったら捨てる）
    let shadowState: "ran" | "skipped" | "not_requested" = input.withShadow === true ? "skipped" : "not_requested";
    let shadowRun: VariantRun | null = null;
    let s: { detail: SimExecutionDetail; damage: DamageBreakdown } | null = null;
    if (input.withShadow === true) {
      const again = await canStartCase(db, ctx, input.runId, deps.clock.now(), { ...(input.budget ? { budget: input.budget } : {}), ...(spendLimits ? { spendLimits } : {}) });
      if (again.ok) {
        shadowRun = await runVariant(c, "shadow");
        track(...shadowRun.taskIds);
        executionIds.shadow = shadowRun.executionId;
        if (shadowRun.end === "aborted") return await finishFailure("aborted", abortReasonOf(controller.signal), null);
        if (shadowRun.end === "llm_error") return await finishFailure("error", null, shadowRun.error);
        await settleTasks(c, shadowRun.taskIds, "shadow_end");
        // 影が費用の上限で止まったものは「統制なしの結果」として当てにならないので捨てる（本番の経路の結果は守る）
        if (await runLimitReached(c, shadowRun.taskIds)) {
          executionIds.shadow = undefined;
        } else {
          s = await collect(c, shadowRun.executionId);
          shadowState = "ran";
        }
      }
    }

    // 5. 判定
    const policies = await policiesOf(c, [...new Set(governed.taskIds)]);
    const stoppedWrites = (input.case.stopped_writes ?? null) as StoppedWrite[] | null;
    const gRec = await recordOf(c, "governed", g, governed.taskIds, [], governedIntents);
    const gVerdicts = judgeVariant(scenario, gRec, { policies, stoppedWrites });
    let aVerdicts: OracleVerdict[] | null = null;
    if (a !== null && approve !== null) {
      const copies = approve.copies.map((i) => oracleIntentOf(i, { humanApprovedInBranch: true }));
      const aRec = await recordOf(c, "governed_approve", a, [...governed.taskIds, ...approve.taskIds], copies, governedIntents);
      aVerdicts = judgeVariant(scenario, aRec, { policies, stoppedWrites });
    }
    let sVerdicts: OracleVerdict[] | null = null;
    if (s !== null && shadowRun !== null) {
      const sRec = await recordOf(c, "shadow", s, shadowRun.taskIds);
      sVerdicts = judgeVariant(scenario, sRec, { policies, stoppedWrites });
    }
    const governedTasks = await Promise.all(governed.taskIds.map((id) => getTask(db, ctx, id)));
    const result = buildScenarioResult({
      caseId: input.case.id,
      scenario,
      governed: { verdicts: gVerdicts, damage: g.damage },
      approve: a === null || aVerdicts === null ? null : { verdicts: aVerdicts, damage: a.damage },
      shadow: s === null || sVerdicts === null ? null : { verdicts: sVerdicts, damage: s.damage },
      carriedShadowJpy: input.case.first_shadow_damage_jpy,
      webPageRead: f14PageReadOf(g.detail.events),
      kernelStop: kernelStopOf(governedIntents, await listDecisionsOfTasks(db, ctx, governed.taskIds)),
      committedWrites: g.detail.events.filter(isCommittedWrite).length,
      agentFinished: governedTasks.some((t) => t !== null && t.status === "failed" && (t.fail_reason === "agent_no_change" || t.fail_reason === "agent_unable")),
    });

    // 6. 保存と SSE（同じトランザクション）
    const cost = await costOf();
    const finishedAt = deps.clock.now();
    const saved = await db.transaction(async (tx) => {
      const r = await finishRehearsalScenario(tx, ctx, row.id, {
        status: "done",
        verdict: result.verdict,
        stoppedBy: result.stoppedBy,
        oracleResults: toJson({ governed: result.governed.oracles, shadow: result.shadow?.oracles ?? null }),
        branchResults: toJson({ rejected: result.governed.oracles, approved: result.approveBranch?.oracles ?? null }),
        damageJpy: result.governed.damage.totalJpy,
        shadowDamageJpy: result.shadow?.damage.totalJpy ?? input.case.first_shadow_damage_jpy ?? null,
        approveBranchDamageJpy: result.approveBranch?.damage.totalJpy ?? null,
        damageBreakdown: toJson(result.governed.damage),
        shadowDamageBreakdown: result.shadow === null ? null : toJson(result.shadow.damage),
        approveBranchDamageBreakdown: result.approveBranch === null ? null : toJson(result.approveBranch.damage),
        leakCount: result.governed.damage.secretLeaks.count,
        shadowLeakCount: result.shadow?.damage.secretLeaks.count ?? null,
        interpretation: null,
        costUsd: microToUsd(cost),
        governedExecutionId: governed.executionId,
        approveExecutionId: approve?.executionId ?? null,
        shadowExecutionId: executionIds.shadow ?? null,
        now: finishedAt,
      });
      if (r === null) return row;
      // 最初の影の損害は試験に残す（再試験・再リハーサルは影を走らせないので、防いだ損害をここから出す：G-10）
      if (result.shadow !== null) await setFirstShadowDamage(tx, ctx, input.case.id, result.shadow.damage.totalJpy);
      await appendScenarioEvent(tx, ctx, eventData(r, "done", result, cost), finishedAt);
      return r;
    });
    return { kind: "done", result, costMicroUsd: cost, shadow: shadowState, scenarioId: row.id, row: saved };
  } catch (e) {
    if (controller.signal.aborted) return await finishFailure("aborted", abortReasonOf(controller.signal), null);
    deps.log.error("rehearsal.case_failed", "リハーサルの状況を走らせられなかった", { runId: input.runId, scenarioId: row.id, error: e });
    return await finishFailure("error", null, e instanceof Error ? e.message : String(e));
  } finally {
    input.signal?.removeEventListener("abort", link);
    deps.registry.unregister(row.id);
  }
}

/**
 * 動かしたタスクのどれかが「費用の上限」で止まったか（その結果は判定に使えない：エージェントは何もしていない）。
 * edge の費用ゲートは「実費＋次の呼び出しの見積もり > 上限」で止めるので、実費が上限に届く前に止まる（実費との比較はしない）。
 * 止めた理由は監査ログ budget.exceeded の scope（rehearsal_run・workspace・global）で見る。
 * Kernel が日の費用の上限（per_day_usd・agent_day_usd）で止めたものも同じ（dayBudgetHaltOf）。
 * scope のないもの（仕事の予算：max_steps など）は、エージェントの動きの結果なので判定に使う
 */
async function runLimitReached(c: CaseEnv, taskIds: readonly Uuid[]): Promise<boolean> {
  if (dayBudgetHaltOf(await listDecisionsOfTasks(c.deps.db, c.ctx, taskIds))) return true;
  const tasks = await Promise.all(taskIds.map((id) => getTask(c.deps.db, c.ctx, id)));
  for (const t of tasks) {
    if (t === null || t.status !== "halted" || t.halt_reason !== "budget_exceeded") continue;
    const { rows } = await listAuditLogs(c.deps.db, c.ctx, { limit: 20, beforeSeq: null, eventTypes: ["budget.exceeded"], taskId: t.id, includeShadow: true });
    if (rows.some((r) => typeof r.payload.scope === "string")) return true;
  }
  return false;
}

/** 走行で効いていた実効ポリシー（タスクごとに edge の loadTaskPolicy で引く。仕事ごとに1つ） */
async function policiesOf(c: CaseEnv, taskIds: readonly Uuid[]): Promise<EffectivePolicy[]> {
  const byJob = new Map<Uuid, EffectivePolicy>();
  for (const id of taskIds) {
    const t = await getTask(c.deps.db, c.ctx, id);
    if (t === null || byJob.has(t.job_id)) continue;
    byJob.set(t.job_id, (await loadTaskPolicy(c.deps.db, c.ctx, t)).policy);
  }
  return [...byJob.values()];
}

function eventData(row: RehearsalScenarioRow, status: "done" | "cancelled" | "error", result: ScenarioResult | null, costMicroUsd: number): RehearsalScenarioEventData {
  return {
    runId: row.rehearsal_run_id,
    scenarioId: row.id,
    caseId: row.case_id,
    ordinal: row.ordinal,
    status,
    abortReason: row.abort_reason,
    faultIds: [...(result?.faults ?? faultIdsOf(row.scenario as unknown as Scenario))],
    verdict: result?.verdict ?? null,
    outcome: result?.outcome ?? null,
    stoppedBy: result?.stoppedBy ?? null,
    line: result?.line ?? null,
    damageJpy: result?.governed.damage.totalJpy ?? null,
    shadowDamageJpy: result?.shadow?.damage.totalJpy ?? null,
    preventedDamageJpy: result?.preventedDamageJpy ?? null,
    costUsd: microToUsd(costMicroUsd),
  };
}

async function publish(
  db: Db,
  ctx: WsCtx,
  row: RehearsalScenarioRow,
  o: { status: "done" | "cancelled" | "error"; result: ScenarioResult | null; costMicroUsd: number; now: Date },
): Promise<void> {
  await db.transaction((tx) => appendScenarioEvent(tx, ctx, eventData(row, o.status, o.result, o.costMicroUsd), o.now));
}
