// リハーサル1回の骨組み（15「処理の流れ」1〜6）：開始 → 生成 → 実行（影つき）→ 適応 → 締める提案 を1本の関数にまとめる。
// API・tick への配線はしない（launch.ts は HTTP 用に走行を裏で続けるが、こちらは最後まで待って結果を返す。呼び出し側が決める）。
// 途中経過は progress.ts の事象（rehearsal.phase・rehearsal.scenario・rehearsal.run）で流す。
// 範囲：[適用]・再試験は tighten-apply.ts（ユーザーの操作で始まる）。ここは案を作るところまで。報告（report.ts）はこの時点の3段（再試験なし）
// 費用：生成・初回の走行・適応のすべてを足して BR-62（$3）の範囲内（cost.ts）。足りなくなったら新しい生成・状況を始めない
// 失敗の扱い：初回の生成が全滅・上限超過のときは RehearsalGenerateError（走行がまだないので結果を返せない）。適応以降は打ち切って理由を返す

import { randomInt } from "node:crypto";
import type { SessionCtx, Uuid, WsCtx } from "@open-team/db";
import { getWorkspace } from "@open-team/db";
import { findActiveRehearsalRun, listActiveRehearsalCases, type CaseSubject } from "@open-team/db/rehearsal";
import { modelForPurpose } from "@open-team/llm";
import { AppError } from "@open-team/platform";
import { damageRowOf } from "@open-team/rehearsal";
import type { FaultSpec, ScenarioResult } from "@open-team/sim-core";
import { adaptScenarios, type AdaptResult, type AdaptStopReason } from "./adapt.ts";
import { microToUsd } from "./budget.ts";
import { addCosts, REHEARSAL_BUDGET_MICRO_USD } from "./cost.ts";
import { generateScenarios } from "./generate.ts";
import { buildJobMaterials } from "./launch.ts";
import { rehearsalLlm } from "./gemini.ts";
import { agentModelIdentity } from "../env.ts";
import { getAgentJobRow } from "@open-team/db/edge";
import { saveGeneratedCases } from "./persist.ts";
import { publishPhaseEvent, type RehearsalPhase } from "./progress.ts";
import { buildRehearsalReport, type RehearsalReport } from "./report.ts";
import type { RehearsalRunDeps } from "./run.ts";
import { rehearsalGrantsOf } from "./web-grant.ts";
import { runRehearsalSuite, type SuiteOutcome } from "./suite.ts";
import { proposeTighteningForRuns, type TightenSuggestion } from "./tighten-apply.ts";

export interface RunRehearsalInput {
  subject: CaseSubject;
  /** 最初に作る状況の件数（既定12・上限20：generate.ts） */
  count?: number;
  /** 基のシード（uint32。省略すると乱数）。再試験は同じシードで走る */
  seed?: number;
  /** 適応の設定。false なら適応しない。既定は最大3回・1回6件 */
  adapt?: { maxRounds?: number; count?: number } | false;
  /** 費用の上限（マイクロドル。既定 $3＝BR-62） */
  budgetLimitMicroUsd?: number;
  signal?: AbortSignal;
}

export interface RehearsalOutcome {
  seed: number;
  /** 初回と適応の走行（走らせた順）。[適用] の baselineRunIds にそのまま渡せる */
  runIds: Uuid[];
  generation: { requested: number; generated: number; saved: number; costMicroUsd: number };
  /** 初回の走行（影つき） */
  initial: SuiteOutcome;
  /** 適応の結果。初回の走行が終わらなかった・適応しない設定のときは null */
  adaptation: AdaptResult | null;
  /** 初回・適応の全結果（走らせた順） */
  results: ScenarioResult[];
  /** 締める提案（仕事ごと。すり抜けがなければ空） */
  suggestions: TightenSuggestion[];
  /** 3段の報告（再試験なし。[適用] の再試験のあとは applyTighteningAndRetest の report が3段そろう） */
  report: RehearsalReport;
  /** 使った費用の合計（マイクロドル。生成・走行・適応） */
  costMicroUsd: number;
  /** 打ち切った理由（適応が最大回数以外で終わった・初回の走行が終わらなかった）。なければ null */
  stopped: { reason: AdaptStopReason; message: string } | null;
}

type OrchestrateDeps = RehearsalRunDeps;

const isUniqueViolation = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

export async function runRehearsal(deps: OrchestrateDeps, s: SessionCtx, input: RunRehearsalInput): Promise<RehearsalOutcome> {
  const { db } = deps;
  const ctx: WsCtx = s;
  const limit = input.budgetLimitMicroUsd ?? REHEARSAL_BUDGET_MICRO_USD;
  const phase = (p: RehearsalPhase, runId: Uuid | null, line: string, spent: number, round = 0): Promise<void> =>
    publishPhaseEvent(db, ctx, { phase: p, runId, line, round, costUsd: microToUsd(spent) }, deps.clock.now());

  // 1. 開始：Kill Switch・動いている走行の確かめ
  const ws = await getWorkspace(db, ctx);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  const active = await findActiveRehearsalRun(db, ctx, input.subject);
  if (active !== null) throw new AppError("REHEARSAL_ALREADY_RUNNING", undefined, { details: { runId: active.id } });
  const materials = await buildJobMaterials(deps, s, input.subject);
  const seed = input.seed ?? randomInt(0, 2 ** 32);
  const generatorModel = modelForPurpose(deps.env.gemini, "rehearsal_generate");
  const agentModel = agentModelIdentity(deps.env);
  await phase("started", null, "リハーサルを始めました", 0);

  // 2. 生成（FR-042）
  const existing = await listActiveRehearsalCases(db, ctx, input.subject);
  const grants = await rehearsalGrantsOf(db, ctx, input.subject);
  const job = input.subject.jobId === undefined ? null : await getAgentJobRow(db, ctx, input.subject.jobId);
  if (input.subject.jobId !== undefined && job === null) throw new AppError("NOT_FOUND");
  const gen = await generateScenarios({
    job: materials.brief,
    seed,
    webAllowDomains: grants.webAllowDomains,
    connectorSlugs: grants.connectorSlugs,
    llm: rehearsalLlm(deps, ctx, input.subject.askId !== undefined ? { askId: input.subject.askId } : { agentId: job!.agent_id }, "rehearsal_generate"),
    model: generatorModel,
    ...(input.count !== undefined ? { count: input.count } : {}),
    existingFaults: existing.map((c) => (c.scenario as unknown as { faults?: FaultSpec[] }).faults ?? []),
    budget: { limitMicroUsd: limit },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const saved = await saveGeneratedCases(db, ctx, { subject: input.subject, scenarios: gen.scenarios, now: deps.clock.now() });
  let spent = addCosts(gen.costMicroUsd);
  await phase("generated", null, `Gemini（${generatorModel}）が悪い日を ${saved.saved.length} 件作りました`, spent);

  // 3. 実行（FR-043・044）：最初の生成の状況に影を走らせる（shouldRunShadow の既定）
  const remaining = limit - spent;
  let initial: SuiteOutcome;
  try {
    initial = await runRehearsalSuite(deps, {
      ctx,
      requesterId: s.userId,
      subject: input.subject,
      trigger: "initial",
      seed,
      modelId: agentModel,
      generatorModelId: generatorModel,
      effectivePolicies: materials.effectivePolicies,
      policyHash: materials.policyHash,
      toolHashes: materials.toolHashes,
      stageFingerprints: materials.stageFingerprints,
      // 生成で上限に届いていたら、新しい状況は始めない（走行は failed・残りは cancelled(budget)）
      budget: remaining > 0 ? { limitMicroUsd: remaining } : { spentMicroUsd: limit + 1, limitMicroUsd: limit },
      requireNoKillSwitch: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("REHEARSAL_ALREADY_RUNNING");
    throw e;
  }
  spent = addCosts(spent, initial.costMicroUsd);
  await phase("ran", initial.run.id, `${initial.results.length} 件の状況を判定しました（すり抜け ${initial.results.filter((r) => r.outcome === "slipped").length} 件）`, spent);

  // 4. 適応：初回の走行が最後まで終わったときだけ（途中で止まった結果から次の状況を作らない）
  let adaptation: AdaptResult | null = null;
  let stopped: RehearsalOutcome["stopped"] = null;
  if (initial.run.status !== "done") {
    stopped = {
      reason: initial.outcomes.some((o) => (o.kind === "not_started" && o.reason === "budget") || (o.kind === "aborted" && o.reason === "budget")) ? "budget" : initial.run.status === "cancelled" ? "aborted" : "run_incomplete",
      message: "最初の走行が最後まで終わらなかったので、状況の作り直しはしなかった",
    };
  } else if (input.adapt !== false) {
    adaptation = await adaptScenarios(deps, {
      ctx,
      requesterId: s.userId,
      subject: input.subject,
      job: materials.brief,
      seed,
      modelId: agentModel,
      generatorModel,
      previous: { run: initial.run, results: initial.results },
      budget: { spentMicroUsd: spent, limitMicroUsd: limit },
      ...(input.adapt?.maxRounds !== undefined ? { maxRounds: input.adapt.maxRounds } : {}),
      ...(input.adapt?.count !== undefined ? { count: input.adapt.count } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    spent = addCosts(spent, adaptation.costMicroUsd);
    // 最大回数までやり切ったのと、失敗がなくなって終えたのは打ち切りではない
    if (adaptation.stopped !== "max_rounds" && adaptation.stopped !== "nothing_to_adapt") stopped = { reason: adaptation.stopped, message: adaptation.message };
  }

  // 5. 締める提案（FR-045）：すり抜けた失敗から。判定は決定論（kernel）
  const runIds = [initial.run.id, ...(adaptation?.rounds.map((r) => r.suite.run.id) ?? [])];
  const results = [...initial.results, ...(adaptation?.results ?? [])];
  const suggestions = await proposeTighteningForRuns(deps, ctx, { runIds });
  const proposalCount = suggestions.reduce((n, x) => n + x.proposals.length, 0);
  await phase("proposed", initial.run.id, proposalCount === 0 ? "締める提案はありません" : `締める提案を ${proposalCount} 件作りました`, spent);

  const report = buildRehearsalReport(results.map(damageRowOf));
  await phase(stopped === null ? "finished" : "stopped", initial.run.id, report.headline, spent);
  return {
    seed,
    runIds,
    generation: { requested: gen.requestedCount, generated: gen.scenarios.length, saved: saved.saved.length, costMicroUsd: gen.costMicroUsd },
    initial,
    adaptation,
    results,
    suggestions,
    report,
    costMicroUsd: spent,
    stopped,
  };
}
