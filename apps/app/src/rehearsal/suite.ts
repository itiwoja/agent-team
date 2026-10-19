// リハーサルの走行（rehearsal_runs）の骨組み：試験を順に1件ずつ走らせ（runRehearsalCase）、走行の行を作って集計する。
// 全試験を順に走らせて走行を終え、全件合格なら合格証を出す（certify.ts）。
// 範囲外（次の担当）：適応（状況の作り直し）・締める提案の適用・合格証の失効と再リハーサル・incident の自動追加。
// 費用は走行ごとに集計し、上限（BR-62：1回 $3）に当たったら新しい状況を始めない（残りは cancelled(budget) の行として残す）

import type { CandidateRule, EffectivePolicies, RehearsalCaseRow, RehearsalRunRow, RehearsalScenarioRow, RevokeReason, RunTrigger, ToolHashEntry, Uuid, WsCtx } from "@open-team/db";
import { appendAuditLog, lockWorkspace } from "@open-team/db";
import { activateReservedRun, listActiveRehearsalCases, type CaseSubject, finishRehearsalRun, getRehearsalRun, insertRehearsalRun, listRehearsalScenarios, mergeRehearsalRunSummary } from "@open-team/db/rehearsal";
import { summarizeRehearsal, type DamageRow } from "@open-team/rehearsal";
import type { ScenarioResult } from "@open-team/sim-core";
import { damageRowOf } from "@open-team/rehearsal";
import { certifyRun, type CertifyOutcome } from "./certify.ts";
import { microToUsd, runCostMicroUsd } from "./budget.ts";
import type { BudgetInput } from "./cost.ts";
import { toJson } from "./judge.ts";
import { publishRunEvent } from "./progress.ts";
import { runRehearsalCase, type CaseOutcome, type RehearsalRunDeps, type RehearsalStage } from "./run.ts";
import { shouldRunShadow, totalPrevented } from "./shadow.ts";

/** 走行の開始の直前に Kill Switch が入っていた（走行の行は作っていない） */
export class KillSwitchBeforeStart extends Error {
  constructor() {
    super("Kill Switch が入っているので走行を始めない");
    this.name = "KillSwitchBeforeStart";
  }
}

export interface RunSuiteInput {
  ctx: WsCtx;
  requesterId: Uuid;
  subject: CaseSubject;
  trigger: RunTrigger;
  reason?: Exclude<RevokeReason, "superseded"> | null;
  parentRunId?: Uuid | null;
  /** 再試験が確かめる締める変更（agent_config_changes.id） */
  configChangeId?: Uuid | null;
  /** 適応で状況を作り直した回（0 が最初の生成） */
  adaptRound?: number;
  seed: number;
  modelId: string;
  generatorModelId?: string | null;
  /** 走らせる試験（省略すると、その対象の外されていない試験すべて） */
  cases?: readonly RehearsalCaseRow[];
  /** 影の走行を試験ごとに選ぶ（既定は shouldRunShadow：最初の生成の状況にだけ） */
  shadowFor?: (c: RehearsalCaseRow) => boolean;
  stages?: readonly RehearsalStage[];
  // 走行の行に残すもの（次の担当が決める）
  candidateRules?: readonly CandidateRule[] | null;
  effectivePolicies?: EffectivePolicies | null;
  policyHash?: string | null;
  toolHashes?: readonly ToolHashEntry[] | null;
  /** 依頼の走行の開始時に計算した担当ごとの指紋 */
  stageFingerprints?: readonly import("@open-team/db").StageFingerprint[] | null;
  caseSetHash?: string | null;
  /** 費用の上限（USD。既定は DB の列の既定 0.5。実際の上限は edge の SPEND_LIMITS で、この列は表示用） */
  budgetUsd?: string;
  budget?: BudgetInput;
  signal?: AbortSignal;
  /** true なら、走行の行を作る同じトランザクション（ワークスペースのロックの下）で Kill Switch を確かめ、入っていれば行を作らず KillSwitchBeforeStart を投げる（再リハーサル） */
  requireNoKillSwitch?: boolean;
  /** 起動の予約（generating の走行）。あれば新しく作らず、これを running にして走らせる（launch.ts：生成の前に同じ対象を直列化する） */
  reservedRunId?: Uuid;
  /** 走行の行を作った直後に呼ぶ（HTTP の起動が runId を返すため。例外は握りつぶす） */
  onRunCreated?: (run: RehearsalRunRow) => void;
}

export interface SuiteOutcome {
  run: RehearsalRunRow;
  outcomes: CaseOutcome[];
  /** 判定まで終わった状況の結果（並び順） */
  results: ScenarioResult[];
  /** 3段の集計（15:161）。結果が1件もなければ null */
  counts: ReturnType<typeof summarizeRehearsal> | null;
  /** このリハーサルで防いだ損害（状況ごとの max(0, 影 − 本番) の合計） */
  preventedDamageJpy: number;
  /** 走行の費用（マイクロドル） */
  costMicroUsd: number;
  /** 費用の上限・Kill Switch で走らせなかった試験の数 */
  notRun: number;
  /** 合格証の発行の結果（全件合格のときだけ issued）。走行が終わらなかったときは null */
  certificate: CertifyOutcome | null;
}

/**
 * 試験を順に（1件ずつ。DB の接続は2本：SO §4.6）走らせて走行を終える。
 * 走行の終わり方：すべて判定できた → done／止められた（Kill Switch・利用者）→ cancelled／基盤の失敗・費用の上限で走らせなかった試験がある → failed
 * （failed の走行では合格証を出さない。次の担当が status と summary.notRun で見る）。Kill Switch が先に走行を cancelled にしていれば、残りは始めない
 */
export async function runRehearsalSuite(deps: RehearsalRunDeps, input: RunSuiteInput): Promise<SuiteOutcome> {
  const { db } = deps;
  const ctx = input.ctx;
  const cases = [...(input.cases ?? (await listActiveRehearsalCases(db, ctx, input.subject)))];
  const now = deps.clock.now();
  // 走行の行（作る・予約を running にする）と起動の監査は同じトランザクション（誰が・何を起動したかを残す：FR-016）
  const run = await db.transaction(async (tx) => {
    let row: RehearsalRunRow | null;
    if (input.requireNoKillSwitch) {
      const ws = await lockWorkspace(tx, ctx);
      if (ws === null || ws.kill_switch_engaged) throw new KillSwitchBeforeStart();
    }
    if (input.reservedRunId !== undefined) {
      row = await activateReservedRun(tx, ctx, input.reservedRunId, now);
      if (row === null) throw new Error("予約した走行がすでに閉じられている（Kill Switch など）");
    } else {
      row = await insertRehearsalRun(tx, ctx, {
        subject: input.subject,
        trigger: input.trigger,
        reason: input.reason ?? null,
        parentRunId: input.parentRunId ?? null,
        configChangeId: input.configChangeId ?? null,
        candidateRules: input.candidateRules ?? null,
        effectivePolicies: input.effectivePolicies ?? null,
        policyHash: input.policyHash ?? null,
        toolHashes: input.toolHashes ?? null,
        stageFingerprints: input.stageFingerprints ?? null,
        caseSetHash: input.caseSetHash ?? null,
        seed: input.seed,
        modelId: input.modelId,
        generatorModelId: input.generatorModelId ?? null,
        adaptRound: input.adaptRound ?? 0,
        ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
        requestedBy: input.requesterId,
        now,
      });
    }
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      {
        eventType: "rehearsal.run_started",
        // 利用者が押した起動は利用者。見回り（recertify）が起こした再リハーサルはシステム（起動を頼んだ人は payload に残す）
        actorType: input.trigger === "recertify" ? "system" : "user",
        actorId: input.trigger === "recertify" ? "rehearsal" : input.requesterId,
        payload: {
          runId: row.id,
          trigger: input.trigger,
          ...(input.subject.jobId !== undefined ? { jobId: input.subject.jobId } : { askId: input.subject.askId as Uuid }),
          requestedBy: input.requesterId,
          seed: input.seed,
          caseCount: cases.length,
          ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
          ...(input.configChangeId ? { configChangeId: input.configChangeId } : {}),
        },
      },
      now,
    );
    return row;
  });
  try {
    input.onRunCreated?.(run);
  } catch {
    // 通知の失敗で走行を止めない
  }

  const outcomes: CaseOutcome[] = [];
  let stopped: "cancelled" | null = null;
  // 前の状況が費用の上限で止まったら、残りは始めない（cancelled(budget)。edge の費用ゲートは見積もり込みなので、実費だけでは上限に見えない）
  let budgetExhausted = false;
  for (const [i, c] of cases.entries()) {
    // Kill Switch は走っている走行を cancelled にする。それ以降は始めない
    const current = await getRehearsalRun(db, ctx, run.id);
    if (current === null || current.status !== "running") {
      stopped = "cancelled";
      break;
    }
    const withShadow =
      input.shadowFor?.(c) ??
      shouldRunShadow({ trigger: input.trigger, adaptRound: input.adaptRound ?? 0, caseSource: c.source, hasFirstShadow: c.first_shadow_damage_jpy !== null });
    const outcome = await runRehearsalCase(deps, {
      ctx,
      requesterId: input.requesterId,
      runId: run.id,
      case: c,
      ordinal: i + 1,
      ...(input.stages ? { stages: input.stages } : {}),
      withShadow,
      ...(budgetExhausted ? { budgetExhausted } : {}),
      ...(input.budget ? { budget: input.budget } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    outcomes.push(outcome);
    if ((outcome.kind === "aborted" && outcome.reason === "budget") || (outcome.kind === "not_started" && outcome.reason === "budget")) budgetExhausted = true;
    if (outcome.kind === "aborted" && outcome.reason !== "budget") {
      stopped = "cancelled";
      break;
    }
  }

  const rows = await listRehearsalScenarios(db, ctx, run.id);
  const results = outcomes.flatMap((o) => (o.kind === "done" ? [o.result] : []));
  const damageRows: DamageRow[] = results.map(damageRowOf);
  const counts = results.length === 0 ? null : summarizeRehearsal(damageRows);
  const prevented = totalPrevented(results);
  const notRun = cases.length - results.length;
  const hadError = outcomes.some((o) => o.kind === "error");
  const status: "done" | "failed" | "cancelled" = stopped === "cancelled" ? "cancelled" : hadError || notRun > 0 ? "failed" : "done";
  const cost = await runCostMicroUsd(db, ctx, run.id);
  const error =
    status === "failed"
      ? hadError
        ? "基盤の失敗で判定できなかった状況がある"
        : "費用の上限（または Kill Switch）で、走らせなかった試験がある"
      : null;
  const finished = await finishRehearsalRun(db, ctx, run.id, {
    status,
    summary: toJson({ counts, total: cases.length, notRun, scenarios: rows.map(scenarioSummaryOf) }),
    damageJpy: results.reduce((sum, r) => sum + r.governed.damage.totalJpy, 0),
    shadowDamageJpy: results.some((r) => r.shadow !== null) ? results.reduce((sum, r) => sum + (r.shadow?.damage.totalJpy ?? 0), 0) : null,
    preventedDamageJpy: results.some((r) => r.shadow !== null) ? prevented : null,
    costUsd: microToUsd(cost),
    error,
    now: deps.clock.now(),
  });
  // Kill Switch が先に cancelled にしていれば finish は null（行はそのまま）。最新の行を返す
  const latest = finished ?? (await getRehearsalRun(db, ctx, run.id)) ?? run;
  const publish = () =>
    publishRunEvent(db, ctx, { runId: run.id, status: latest.status === "running" ? status : (latest.status as "done" | "failed" | "cancelled"), total: cases.length, preventedDamageJpy: prevented, costUsd: microToUsd(cost) }, deps.clock.now());
  // 終わった事象は合格証を出したあとに流す（画面は事象を受けて取り直すので、先に流すと「合格証なし」のまま残る）
  let certificate: CertifyOutcome | null;
  let withReason: RehearsalRunRow | null;
  try {
    certificate = latest.status === "done" ? await certifyRun(deps, { ctx, run: latest, cases, results }) : null;
    // 合格証が出なかった理由を summary に残す（結果の API の certificateReason。出たときは null）。判定・発行には関わらない
    const certificateReason = certificate === null ? "not_done" : certificate.issued ? null : certificate.reason;
    withReason = await mergeRehearsalRunSummary(db, ctx, run.id, { certificateReason });
  } catch (e) {
    await publish();
    throw e;
  }
  await publish();
  return { run: withReason ?? latest, outcomes, results, counts, preventedDamageJpy: prevented, costMicroUsd: cost, notRun, certificate };
}

function scenarioSummaryOf(r: RehearsalScenarioRow): { id: string; caseId: string; ordinal: number; status: string; verdict: string | null; abortReason: string | null } {
  return { id: r.id, caseId: r.case_id, ordinal: r.ordinal, status: r.status, verdict: r.verdict, abortReason: r.abort_reason };
}
