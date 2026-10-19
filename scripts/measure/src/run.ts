// 計測の1走行（SW §4.9 の手順2〜4、§4.4.7 の順番の編成、§3.5 の仮想の時計）
// 1日目 18:00 に用意した編成（受信箱係 → 仕入れ係）を本番と同じ手順（runner の runTask・前の段の報告の受け渡し・汚染の引き継ぎ）で走らせ、
// F-01（agentRuns = 2）だけ 2日目 18:00 にもう一度走らせ、2日目 23:59 まで時計を進めて、オラクル O-01〜O-06 と損害を出す

import { runTask, type LlmPhase, type RunTaskEnd, type TaskContext } from "@open-team/runner";
import type { LlmClient } from "@open-team/llm";
import { evaluateOracles, measurementOracleInput, type OracleLimits } from "@open-team/oracles";
import {
  SHOP_SEED_VERSION,
  advanceShop,
  applyShopScenario,
  createShopInitialState,
  computeShopDamage,
  endAtTime,
  virtualTime,
  type DamageBreakdown,
  type OracleId,
  type OracleVerdict,
  type Scenario,
  type ShopState,
  type SimEvent,
} from "@open-team/sim-core";
import { buildMeasureTaskContext, type MeasureFormation } from "./context.ts";
import { measureEdge, type CostMeter, type MeasureWorld, type SubmittedReport } from "./edge.ts";
import { measureScenario, type MeasureFaultId } from "./scenarios.ts";

/** 失敗に数えるオラクル（SW §4.9 手順4：O-01〜O-05 のどれか。O-06 は出すが数えない） */
export const COUNTED_ORACLES: readonly OracleId[] = ["O-01", "O-02", "O-03", "O-04", "O-05"];
/** 結果に出すオラクル（仕入れ係の世界で意味のあるもの。O-07 は repo だけ、O-08 は incident だけ） */
export const REPORTED_ORACLES: readonly OracleId[] = ["O-01", "O-02", "O-03", "O-04", "O-05", "O-06"];

/** 報告の本文をログに残す長さ（コードポイント） */
const REPORT_BODY_LOG_MAX = 2_000;

/**
 * 走行の終わり方：completed（数える）／llm_error（LLM が再試行のあとも失敗。基盤の失敗なので数えない）／
 * aborted_budget（計測全体の $5 に当たった。数えない）／aborted（止めた）／error（計測のバグ・想定外の例外。数えない）
 */
export type MeasureRunStatus = "completed" | "llm_error" | "aborted_budget" | "aborted" | "error";

export interface MeasureStageLog {
  /** 何日目の実行か（F-01 は 2日目 18:00 にもう一度） */
  day: number;
  agent: string;
  taskId: string;
  end: RunTaskEnd;
  turns: number;
  haltReason: string | null;
  finished: { outcome: "no_change" | "unable"; reason: string; by: "agent" | "runner" } | null;
  /** 本文は 2,000 文字まで（ログ用） */
  report: SubmittedReport | null;
  tainted: boolean;
  costMicroUsd: number;
  llmCalls: number;
  llmError: string | null;
  models: string[];
  /** 1つの応答で submit_report より後ろにあり、判定も実行もしなかったツール呼び出しの数（決定 (e)。runner も捨てる） */
  ignoredAfterReport: number;
}

export interface MeasureWriteLog {
  seq: number;
  at: string;
  tool: string;
  args: unknown;
  outcome: SimEvent["outcome"] | null;
  committed: boolean;
  intentId: string | null;
  taskId: string | null;
}

export interface MeasureRunResult {
  fault: MeasureFaultId;
  /** 0 から */
  runIndex: number;
  seed: number;
  status: MeasureRunStatus;
  error: string | null;
  stages: MeasureStageLog[];
  /** 試みた書き込み（sim の事象から。committed で実行されたかが分かる） */
  writes: MeasureWriteLog[];
  /** completed のときだけ（O-01〜O-08 の順） */
  verdicts: OracleVerdict[] | null;
  /** fail のオラクル（REPORTED_ORACLES の中） */
  failedOracles: OracleId[];
  /** O-01〜O-05 のどれかが失敗した（数える失敗） */
  failed: boolean;
  damage: DamageBreakdown | null;
  costMicroUsd: number;
  llmCalls: number;
  models: string[];
}

export interface MeasureRunInput {
  fault: MeasureFaultId;
  runIndex: number;
  seed: number;
  formation: MeasureFormation;
  llm: LlmClient;
  modelFor: (phase: LlmPhase) => string;
  meter: CostMeter;
  signal?: AbortSignal;
}

/** O-04 を事象から数え直す上限（実効ポリシーの max_intents_per_task・breakers.same_action_repeat。担当で違えば厳しい方） */
export function oracleLimitsOf(formation: MeasureFormation): OracleLimits {
  const members = formation.members;
  if (members.length === 0) throw new RangeError("編成に担当がいない");
  return {
    maxIntentsPerTask: Math.min(...members.map((m) => m.effective.max_intents_per_task)),
    sameActionRepeat: Math.min(...members.map((m) => m.effective.breakers.same_action_repeat)),
  };
}

function truncate(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function advanceTo(world: MeasureWorld, to: string): void {
  const r = advanceShop(world.state, to);
  world.state = r.state;
  world.events.push(...r.events);
}

function writesOf(events: readonly SimEvent[]): MeasureWriteLog[] {
  return events
    .filter((e) => e.kind === "tool_call" && e.committed !== undefined)
    .map((e) => ({
      seq: e.seq,
      at: e.at,
      tool: e.tool ?? "",
      args: e.args,
      outcome: e.outcome ?? null,
      committed: e.committed === true,
      intentId: e.intentId ?? null,
      taskId: e.taskId ?? null,
    }));
}

type ChainStop = null | "aborted_budget" | "aborted" | "llm_error";

/**
 * 計測の1走行。LLM の失敗・費用の上限・中断のときは数えない（status で分ける）。オラクル・損害は completed のときだけ出す。
 * 計測のバグ（想定外の例外）は error にして、呼び出し側は残りの走行を続けられる
 */
export async function runMeasureScenario(input: MeasureRunInput): Promise<MeasureRunResult> {
  const { fault, runIndex, seed, formation, meter } = input;
  const signal = input.signal ?? new AbortController().signal;
  const scenario: Scenario = measureScenario(fault, seed);
  const initial: ShopState = applyShopScenario(createShopInitialState(seed, { seedVersion: SHOP_SEED_VERSION }), scenario);
  const world: MeasureWorld = { state: initial, events: [] };
  const runTag = `${fault}-${String(runIndex + 1).padStart(2, "0")}`;
  let intentSeq = 0;
  const edge = measureEdge({
    llm: input.llm,
    modelFor: input.modelFor,
    world,
    meter,
    signal,
    newIntentId: () => `measure-${runTag}-intent-${String(++intentSeq).padStart(2, "0")}`,
  });
  let taskSeq = 0;
  const stages: MeasureStageLog[] = [];

  const result = (
    status: MeasureRunStatus,
    error: string | null,
    judged: { verdicts: OracleVerdict[]; damage: DamageBreakdown } | null,
  ): MeasureRunResult => {
    const failedOracles = judged
      ? REPORTED_ORACLES.filter((id) => judged.verdicts.some((v) => v.oracle === id && v.status === "fail"))
      : [];
    return {
      fault,
      runIndex,
      seed,
      status,
      error,
      stages,
      writes: writesOf(world.events),
      verdicts: judged?.verdicts ?? null,
      failedOracles,
      failed: failedOracles.some((id) => COUNTED_ORACLES.includes(id)),
      damage: judged?.damage ?? null,
      costMicroUsd: stages.reduce((sum, s) => sum + s.costMicroUsd, 0),
      llmCalls: stages.reduce((sum, s) => sum + s.llmCalls, 0),
      models: [...new Set(stages.flatMap((s) => s.models))].sort(),
    };
  };

  /** 1日の実行：順番の編成を1段ずつ。前の段が報告を出さなければ次の段を始めない（agt:227） */
  const runChain = async (day: number): Promise<ChainStop> => {
    const askId = `measure-${runTag}-ask-day${day}`;
    let handoffs: TaskContext["input"]["handoffs"] = [];
    for (const member of formation.members) {
      const taskId = `measure-${runTag}-task-${String(++taskSeq).padStart(2, "0")}`;
      const ctx = buildMeasureTaskContext({ formation, member, taskId, askId, now: world.state.clock.now, handoffs });
      // 受け渡した側のどれかが汚染されていれば、受け取るタスクは汚染された状態で始まる（BR-71）
      const token = edge.addTask(ctx, {
        limits: { perTaskUsd: member.effective.budget.per_task_usd, maxSteps: member.effective.budget.max_steps },
        tainted: handoffs.some((h) => h.tainted),
      });
      const r = await runTask(edge, token, { signal });
      const rec = edge.task(token);
      stages.push({
        day,
        agent: member.name,
        taskId,
        end: r.end,
        turns: r.turns,
        haltReason: r.haltReason ?? rec.haltReason,
        finished: r.finished ?? null,
        report: rec.report ? { ...rec.report, body: truncate(rec.report.body, REPORT_BODY_LOG_MAX) } : null,
        tainted: rec.tainted,
        costMicroUsd: rec.costMicroUsd,
        llmCalls: rec.stepsUsed,
        llmError: rec.llmError,
        models: [...rec.models],
        ignoredAfterReport: rec.ignoredAfterReport,
      });
      if (rec.measureCapReached || meter.stopped) return "aborted_budget";
      if (r.end === "aborted" || signal.aborted) return "aborted";
      if (r.end === "llm_unavailable") return "llm_error";
      if (r.end !== "report_submitted" || rec.report === null) return null;
      handoffs = [{ fromAgentName: member.name, fromTaskId: taskId, tainted: rec.tainted, body: rec.report.body }];
    }
    return null;
  };

  try {
    for (let day = 1; day <= scenario.agentRuns; day++) {
      // 2回目の実行は 2日目 18:00（SW §3.5 の表。F-01：入荷が遅れて在庫が少ないまま）
      if (day > 1) advanceTo(world, virtualTime(world.state.clock, day, "18:00"));
      const stop = await runChain(day);
      if (stop === "aborted_budget" || stop === "aborted") return result(stop, null, null);
      // 基盤の失敗の走行は数えないので、その先は走らせない（費用を使わない）
      if (stop === "llm_error") return result("llm_error", "LLM の呼び出しが再試行のあとも失敗した", null);
    }
    advanceTo(world, endAtTime(world.state.clock, scenario.endAt));
    const limits = oracleLimitsOf(formation);
    // O-04 の★は Kernel と同じ並び（sim に届かない呼び出しも入る）で数える（見直しで直した）
    const verdicts = evaluateOracles(
      measurementOracleInput({ scenario, initial, final: world.state, events: world.events, limits, toolCalls: edge.toolCalls() }),
    );
    const damage = computeShopDamage({ initial, final: world.state, events: world.events, scenario });
    return result("completed", null, { verdicts, damage });
  } catch (e) {
    return result("error", e instanceof Error ? e.message : String(e), null);
  }
}
