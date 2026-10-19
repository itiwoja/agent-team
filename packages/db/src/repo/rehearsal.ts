// リハーサルの試験（rehearsal_cases）と自分の言葉の悪い日の入力（rehearsal_user_inputs）の問い合わせ（FR-042・065。持ち主は app のリハーサル）
// - README §1 の約束に従い、SQL を必ず workspace_id で絞る。見つからなければ null
// - 試験の上限（20件）・まとめ方・ゲストの1日の上限は packages/rehearsal の純粋関数で決める。ここは決まったことを書くだけ
// - トランザクションの中で外部（Gemini など）を呼ばない（G-14）。Gemini を呼ぶ前に insertUserInput で行を作る（呼んだ回数を行で数える：M-51）

import type { Json, JsonObject } from "@open-team/kernel";
import { appendAuditLog } from "../audit.ts";
import type { Queryable, Tx } from "../client.ts";
import type {
  ActionIntentRow,
  AgentConfigChangeRow,
  AgentSnapshotRow,
  CandidateRule,
  CaseRemovedReason,
  CaseSource,
  EffectivePolicies,
  ExecutionVariant,
  FaultId,
  Hex64,
  IncidentKind,
  Jpy,
  PolicyDecisionRow,
  RehearsalCaseRow,
  RehearsalCertificateRow,
  RehearsalRunRow,
  RehearsalScenarioRow,
  RehearsalUserInputRow,
  RevokeReason,
  RunStatus,
  RunTrigger,
  ScenarioAbortReason,
  StageFingerprint,
  StoppedWrite,
  TaskRow,
  ToolHashEntry,
  UsdDecimal,
  UserInputStatus,
  Uuid,
} from "../types.ts";
import type { WsCtx } from "../workspace.ts";

/** 試験の対象：仕事か依頼のちょうど片方（DB の subject_chk） */
export type CaseSubject = { jobId: Uuid; askId?: undefined } | { askId: Uuid; jobId?: undefined };

function subjectParams(s: CaseSubject): [Uuid | null, Uuid | null] {
  if ((s.jobId === undefined) === (s.askId === undefined)) throw new TypeError("試験の対象は jobId か askId のちょうど片方");
  return [s.jobId ?? null, s.askId ?? null];
}

async function one<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T> {
  const r = await q.query<T>(text, params);
  const row = r.rows[0];
  if (!row) throw new Error(`行を書けなかった：${text.trim().slice(0, 60)}`);
  return row;
}

const CASE_COLUMNS = `id, workspace_id, job_id, ask_id, source, fault_ids, scenario, seed, sim_snapshot_id, user_text, source_task_id,
  reason_code, incident_kind, stopped_writes, first_shadow_damage_jpy, origin_run_id, created_by, removed_at, removed_by,
  removed_reason, created_at`;

/** 外されていない試験（古い順）。上限の数え方・まとめの計画（planAddCase）の入力 */
export async function listActiveRehearsalCases(q: Queryable, ctx: WsCtx, subject: CaseSubject): Promise<RehearsalCaseRow[]> {
  const [jobId, askId] = subjectParams(subject);
  const r = await q.query<RehearsalCaseRow>(
    `SELECT ${CASE_COLUMNS} FROM rehearsal_cases
      WHERE workspace_id = $1 AND job_id IS NOT DISTINCT FROM $2 AND ask_id IS NOT DISTINCT FROM $3 AND removed_at IS NULL
      ORDER BY created_at, id`,
    [ctx.workspaceId, jobId, askId],
  );
  return r.rows;
}

export interface InsertRehearsalCaseInput {
  subject: CaseSubject;
  /** FR-042 は generated、FR-065 は user、FR-066 は incident（incident フィールドが要る） */
  source: CaseSource;
  faultIds: readonly FaultId[];
  /** sim-core の Scenario（M-45） */
  scenario: JsonObject;
  seed: number;
  /** source = user のとき必須（マスク済みの元の文。1〜500文字）。generated は null */
  userText?: string | null;
  originRunId?: Uuid | null;
  /** source = incident のとき必須（DB の rehearsal_cases_incident_chk）。ほかは付けない */
  incident?: {
    simSnapshotId: Uuid;
    sourceTaskId: Uuid;
    reasonCode: string;
    incidentKind: IncidentKind;
    stoppedWrites: readonly StoppedWrite[];
  };
  createdBy?: Uuid | null;
  /** 作成時刻（app の時計。なければ DB の now()） */
  createdAt?: Date;
}

/** 試験を1件足す（generated・user）。DB の CHECK（障害 ID が1つ以上・user_text は user だけ）が最後の守り */
export async function insertRehearsalCase(q: Queryable, ctx: WsCtx, input: InsertRehearsalCaseInput): Promise<RehearsalCaseRow> {
  const [jobId, askId] = subjectParams(input.subject);
  if ((input.source === "incident") !== (input.incident !== undefined)) throw new TypeError("incident の項目は source = incident のときだけ付ける");
  const inc = input.incident;
  return one<RehearsalCaseRow>(
    q,
    `INSERT INTO rehearsal_cases (workspace_id, job_id, ask_id, source, fault_ids, scenario, seed, user_text, origin_run_id, created_by, created_at,
                                  sim_snapshot_id, source_task_id, reason_code, incident_kind, stopped_writes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, COALESCE($11::timestamptz, now()), $12, $13, $14, $15, $16::jsonb)
     RETURNING ${CASE_COLUMNS}`,
    [
      ctx.workspaceId,
      jobId,
      askId,
      input.source,
      [...input.faultIds],
      input.scenario,
      input.seed,
      input.source === "user" ? (input.userText ?? null) : null,
      input.originRunId ?? null,
      input.createdBy ?? ctx.userId,
      input.createdAt ?? null,
      inc?.simSnapshotId ?? null,
      inc?.sourceTaskId ?? null,
      inc?.reasonCode ?? null,
      inc?.incidentKind ?? null,
      inc === undefined ? null : [...inc.stoppedWrites],
    ],
  );
}

export interface CaseMergeWrite {
  /** 残す試験（新しいほう） */
  keepId: Uuid;
  /** まとめて外す試験（removed_reason = 'merged'） */
  mergedIds: readonly Uuid[];
}

/**
 * 同じ reasonCode の古い incident を新しいほうへまとめる（planAddCase の merges を反映する。A-107）。
 * まとめた試験の stopped_writes を残す1件に足す（O-08 が見る止まった書き込みを減らさない）。まとめるのは外されていない incident だけ。
 * 反映できたら、外した試験の id を返す
 */
export async function applyCaseMerges(tx: Tx, ctx: WsCtx, merges: readonly CaseMergeWrite[], now: Date): Promise<Uuid[]> {
  const removed: Uuid[] = [];
  for (const m of merges) {
    if (m.mergedIds.length === 0) continue;
    await tx.query(
      `UPDATE rehearsal_cases k
          SET stopped_writes = COALESCE(k.stopped_writes, '[]'::jsonb) || COALESCE(
                (SELECT jsonb_agg(w.elem ORDER BY c.created_at, c.id, w.ord)
                   FROM rehearsal_cases c, jsonb_array_elements(COALESCE(c.stopped_writes, '[]'::jsonb)) WITH ORDINALITY AS w(elem, ord)
                  WHERE c.workspace_id = $1 AND c.id = ANY($3::uuid[]) AND c.source = 'incident' AND c.removed_at IS NULL),
                '[]'::jsonb)
        WHERE k.workspace_id = $1 AND k.id = $2 AND k.source = 'incident' AND k.removed_at IS NULL`,
      [ctx.workspaceId, m.keepId, [...m.mergedIds]],
    );
    const reason: CaseRemovedReason = "merged";
    const r = await tx.query<{ id: Uuid }>(
      `UPDATE rehearsal_cases SET removed_at = $3, removed_reason = $4
        WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND source = 'incident' AND removed_at IS NULL RETURNING id`,
      [ctx.workspaceId, [...m.mergedIds], now, reason],
    );
    removed.push(...r.rows.map((x) => x.id));
  }
  return removed;
}

// ---- 自分の言葉の悪い日の入力 ----

const INPUT_COLUMNS = `id, workspace_id, job_id, ask_id, text, status, interpretation, nearest_fault_id, case_id, rehearsal_run_id,
  scenario_id, created_by, created_at`;

/** Gemini を呼ぶ前に行を作る（status = interpreting）。1日5件は、この表の行の数で数える（呼んだ回数。M-51） */
export async function insertUserInput(
  q: Queryable,
  ctx: WsCtx & { userId: Uuid },
  input: { subject: CaseSubject; text: string; /** app の時計（なければ DB の now()） */ createdAt?: Date },
): Promise<RehearsalUserInputRow> {
  const [jobId, askId] = subjectParams(input.subject);
  return one<RehearsalUserInputRow>(
    q,
    `INSERT INTO rehearsal_user_inputs (workspace_id, job_id, ask_id, text, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now())) RETURNING ${INPUT_COLUMNS}`,
    [ctx.workspaceId, jobId, askId, input.text, ctx.userId, input.createdAt ?? null],
  );
}

/** 解釈の結果を入力の行に書く（interpreting のものだけ。すでに結果が入っていれば null）。状態は matched・no_match・failed */
export async function finishUserInput(
  q: Queryable,
  ctx: WsCtx,
  inputId: Uuid,
  result: {
    status: Extract<UserInputStatus, "matched" | "no_match" | "failed">;
    interpretation: JsonObject | null;
    nearestFaultId: FaultId | null;
    caseId: Uuid | null;
  },
): Promise<RehearsalUserInputRow | null> {
  const r = await q.query<RehearsalUserInputRow>(
    `UPDATE rehearsal_user_inputs SET status = $3, interpretation = $4::jsonb, nearest_fault_id = $5, case_id = $6
      WHERE workspace_id = $1 AND id = $2 AND status = 'interpreting' RETURNING ${INPUT_COLUMNS}`,
    [ctx.workspaceId, inputId, result.status, result.interpretation, result.nearestFaultId, result.caseId],
  );
  return r.rows[0] ?? null;
}

/**
 * ワークスペースの入力の作成時刻（新しい順の全件ではなく since 以降。since がなければ全件）。
 * ゲストの1日5件の数え方（countOnSameJstDay）に渡す。失敗・カタログにないものも数える（Gemini を呼んだので）
 */
export async function listUserInputCreatedAts(q: Queryable, ctx: WsCtx, since?: Date): Promise<Date[]> {
  const r = await q.query<{ created_at: Date }>(
    `SELECT created_at FROM rehearsal_user_inputs WHERE workspace_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2) ORDER BY created_at`,
    [ctx.workspaceId, since ?? null],
  );
  return r.rows.map((x) => x.created_at);
}

// ---- 走行（rehearsal_runs）と状況（rehearsal_scenarios）の実行側（FR-043・044）----
// 走行・状況の行を作る・終わらせる、試験の最初の影の損害を残す、タスクの Intent・判定を読む。業務の判定（合否・損害）はここに持たない。
// リハーサルのタスクを作れる唯一の関数 insertRehearsalTask もここ（BR-67①：rehearsal_run_id・shadow を付けられるのはこの関数だけ）


async function maybe<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T | null> {
  const r = await q.query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function getRehearsalCase(q: Queryable, ctx: WsCtx, caseId: Uuid): Promise<RehearsalCaseRow | null> {
  return maybe<RehearsalCaseRow>(q, `SELECT ${CASE_COLUMNS} FROM rehearsal_cases WHERE workspace_id = $1 AND id = $2`, [ctx.workspaceId, caseId]);
}

/** 走行で Gemini が作った悪い日の件数（source = generated・origin_run_id = 走行。あとで外したものも数える） */
export async function countGeneratedCasesOfRun(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<number> {
  const r = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM rehearsal_cases WHERE workspace_id = $1 AND origin_run_id = $2 AND source = 'generated'`,
    [ctx.workspaceId, runId],
  );
  return r.rows[0]?.n ?? 0;
}

/** 最初の影の走行の損害を試験に残す（G-10：再試験・再リハーサルは影を走らせない）。入っていれば変えない（最初の1回だけ）。入れたら true */
export async function setFirstShadowDamage(q: Queryable, ctx: WsCtx, caseId: Uuid, damageJpy: Jpy): Promise<boolean> {
  const r = await q.query(
    `UPDATE rehearsal_cases SET first_shadow_damage_jpy = $3
      WHERE workspace_id = $1 AND id = $2 AND first_shadow_damage_jpy IS NULL`,
    [ctx.workspaceId, caseId, damageJpy],
  );
  return r.rowCount > 0;
}

export async function getRehearsalRun(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<RehearsalRunRow | null> {
  return maybe<RehearsalRunRow>(q, "SELECT * FROM rehearsal_runs WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, runId]);
}

export interface InsertRehearsalRunInput {
  subject: CaseSubject;
  trigger: RunTrigger;
  /** trigger = recertify のときだけ（DB の CHECK） */
  reason?: Exclude<RevokeReason, "superseded"> | null;
  parentRunId?: Uuid | null;
  candidateRules?: readonly CandidateRule[] | null;
  /** 走行の実効ポリシー（なければタスクのスナップショットのもの：edge の loadTaskPolicy） */
  effectivePolicies?: EffectivePolicies | null;
  policyHash?: string | null;
  toolHashes?: readonly ToolHashEntry[] | null;
  /** 依頼の走行だけ：担当ごとの開始時の指紋（合格証の発行のとき今と比べる） */
  stageFingerprints?: readonly StageFingerprint[] | null;
  caseSetHash?: string | null;
  seed: number;
  modelId: string;
  generatorModelId?: string | null;
  adaptRound?: number;
  /** 費用の上限（既定 DB の 0.5。BR-62） */
  budgetUsd?: UsdDecimal;
  isSeed?: boolean;
  requestedBy?: Uuid | null;
  /** 再試験（trigger = retest）が確かめる、締める変更（agent_config_changes.id） */
  configChangeId?: Uuid | null;
  /** 既定 running。generating は起動の予約（生成の前に行を取り、同じ対象の二重起動を直列化する。activateReservedRun で running にする） */
  status?: "running" | "generating";
  now: Date;
}

/** 予約した走行（generating）を running にする。Kill Switch などで先に閉じられていれば null */
export async function activateReservedRun(q: Queryable, ctx: WsCtx, runId: Uuid, now: Date): Promise<RehearsalRunRow | null> {
  return maybe<RehearsalRunRow>(
    q,
    "UPDATE rehearsal_runs SET status = 'running', started_at = $3 WHERE workspace_id = $1 AND id = $2 AND status = 'generating' RETURNING *",
    [ctx.workspaceId, runId, now],
  );
}

/** 走行を作る（status = running。同じ対象で動いている走行は1つ：rehearsal_runs_one_active_uq に当たると例外） */
export async function insertRehearsalRun(q: Queryable, ctx: WsCtx, input: InsertRehearsalRunInput): Promise<RehearsalRunRow> {
  const [jobId, askId] = subjectParams(input.subject);
  return one<RehearsalRunRow>(
    q,
    `INSERT INTO rehearsal_runs (workspace_id, job_id, ask_id, trigger, reason, requested_by, parent_run_id, candidate_rules, effective_policies,
                                 policy_hash, tool_hashes, case_set_hash, status, seed, model_id, generator_model_id, adapt_round,
                                 budget_usd, is_seed, config_change_id, created_at, started_at, stage_fingerprints)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb, $12, $21::text, $13, $14, $15, $16,
             COALESCE($17::numeric, 0.5), $18, $20, $19, CASE WHEN $21::text = 'running' THEN $19::timestamptz END, $22::jsonb)
     RETURNING *`,
    [
      ctx.workspaceId,
      jobId,
      askId,
      input.trigger,
      input.reason ?? null,
      input.requestedBy ?? ctx.userId,
      input.parentRunId ?? null,
      input.candidateRules ?? null,
      input.effectivePolicies ?? null,
      input.policyHash ?? null,
      input.toolHashes ?? null,
      input.caseSetHash ?? null,
      input.seed,
      input.modelId,
      input.generatorModelId ?? null,
      input.adaptRound ?? 0,
      input.budgetUsd ?? null,
      input.isSeed ?? false,
      input.now,
      input.configChangeId ?? null,
      input.status ?? "running",
      input.stageFingerprints ? [...input.stageFingerprints] : null,
    ],
  );
}

export interface FinishRehearsalRunInput {
  status: Extract<RunStatus, "done" | "failed" | "cancelled">;
  summary?: Json | null;
  damageJpy?: Jpy | null;
  shadowDamageJpy?: Jpy | null;
  preventedDamageJpy?: Jpy | null;
  /** この走行の費用の合計（USD。小数6桁まで） */
  costUsd: UsdDecimal;
  error?: string | null;
  now: Date;
}

/** 走行を終わらせる（動いている走行だけ。Kill Switch が先に cancelled にしていれば変えず null） */
export async function finishRehearsalRun(q: Queryable, ctx: WsCtx, runId: Uuid, f: FinishRehearsalRunInput): Promise<RehearsalRunRow | null> {
  return maybe<RehearsalRunRow>(
    q,
    `UPDATE rehearsal_runs SET status = $3, summary = $4::jsonb, damage_jpy = $5, shadow_damage_jpy = $6, prevented_damage_jpy = $7,
                               cost_usd = $8::numeric, error = $9, finished_at = $10
      WHERE workspace_id = $1 AND id = $2 AND status IN ('queued','generating','running')
      RETURNING *`,
    [
      ctx.workspaceId,
      runId,
      f.status,
      f.summary ?? null,
      f.damageJpy ?? null,
      f.shadowDamageJpy ?? null,
      f.preventedDamageJpy ?? null,
      f.costUsd,
      f.error ?? null,
      f.now,
    ],
  );
}

/** 走行の summary に項目を足す（既存の項目は残す。合格証が出なかった理由など、終わった後に分かることの保存用。列は増やさない） */
export async function mergeRehearsalRunSummary(q: Queryable, ctx: WsCtx, runId: Uuid, patch: Json): Promise<RehearsalRunRow | null> {
  return maybe<RehearsalRunRow>(
    q,
    `UPDATE rehearsal_runs SET summary = COALESCE(summary, '{}'::jsonb) || $3::jsonb
      WHERE workspace_id = $1 AND id = $2
      RETURNING *`,
    [ctx.workspaceId, runId, patch],
  );
}

export interface InsertRehearsalScenarioInput {
  runId: Uuid;
  caseRow: Pick<RehearsalCaseRow, "id" | "fault_ids" | "scenario" | "seed">;
  /** 走行の中の並び（1 から） */
  ordinal: number;
  /** 始めない（予算・Kill Switch）なら cancelled と理由 */
  cancelled?: ScenarioAbortReason;
  now: Date;
}

/** 状況を作る（running。予算・Kill Switch で始めない状況は cancelled の行として残す） */
export async function insertRehearsalScenario(q: Queryable, ctx: WsCtx, i: InsertRehearsalScenarioInput): Promise<RehearsalScenarioRow> {
  const cancelled = i.cancelled ?? null;
  return one<RehearsalScenarioRow>(
    q,
    `INSERT INTO rehearsal_scenarios (workspace_id, rehearsal_run_id, case_id, ordinal, fault_ids, scenario, seed, status, abort_reason, created_at, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      ctx.workspaceId,
      i.runId,
      i.caseRow.id,
      i.ordinal,
      [...i.caseRow.fault_ids],
      i.caseRow.scenario,
      i.caseRow.seed,
      cancelled === null ? "running" : "cancelled",
      cancelled,
      i.now,
      cancelled === null ? i.now : null,
      cancelled === null ? null : i.now,
    ],
  );
}

export interface FinishRehearsalScenarioInput {
  status: "done" | "cancelled" | "error";
  abortReason?: ScenarioAbortReason | null;
  /** status = done のときだけ */
  verdict?: "pass" | "fail" | null;
  stoppedBy?: { by: "kernel" | "agent" | "none"; decision?: "approve" | "deny" | "halt"; reasonCode?: string; matchedRule?: string | null } | null;
  oracleResults?: Json | null;
  branchResults?: Json | null;
  damageJpy?: Jpy | null;
  shadowDamageJpy?: Jpy | null;
  approveBranchDamageJpy?: Jpy | null;
  damageBreakdown?: Json | null;
  shadowDamageBreakdown?: Json | null;
  approveBranchDamageBreakdown?: Json | null;
  leakCount?: number | null;
  shadowLeakCount?: number | null;
  interpretation?: string | null;
  costUsd: UsdDecimal;
  governedExecutionId?: Uuid | null;
  approveExecutionId?: Uuid | null;
  shadowExecutionId?: Uuid | null;
  error?: string | null;
  now: Date;
}

/** 状況の結果を書く（running・judging の状況だけ）。status = done と verdict、kernel と stopped_by_decision は DB の CHECK で揃える */
export async function finishRehearsalScenario(
  q: Queryable,
  ctx: WsCtx,
  scenarioId: Uuid,
  f: FinishRehearsalScenarioInput,
): Promise<RehearsalScenarioRow | null> {
  const stopped = f.stoppedBy ?? null;
  const json = (v: Json | null | undefined): Json | null => v ?? null;
  return maybe<RehearsalScenarioRow>(
    q,
    `UPDATE rehearsal_scenarios SET status = $3, abort_reason = $4, verdict = $5, stopped_by = $6, stopped_by_decision = $7,
            stopped_by_reason_code = $8, stopped_by_rule = $9, oracle_results = $10::jsonb, branch_results = $11::jsonb,
            damage_jpy = $12, shadow_damage_jpy = $13, approve_branch_damage_jpy = $14, damage_breakdown = $15::jsonb,
            shadow_damage_breakdown = $16::jsonb, approve_branch_damage_breakdown = $17::jsonb, leak_count = $18, shadow_leak_count = $19,
            interpretation = $20, cost_usd = $21::numeric, governed_execution_id = $22, approve_execution_id = $23,
            shadow_execution_id = $24, error = $25, finished_at = $26
      WHERE workspace_id = $1 AND id = $2 AND status IN ('queued','running','judging')
      RETURNING *`,
    [
      ctx.workspaceId,
      scenarioId,
      f.status,
      f.abortReason ?? null,
      f.status === "done" ? (f.verdict ?? null) : null,
      stopped?.by ?? null,
      stopped?.by === "kernel" ? (stopped.decision ?? null) : null,
      stopped?.by === "kernel" ? (stopped.reasonCode ?? null) : null,
      stopped?.by === "kernel" ? (stopped.matchedRule ?? null) : null,
      json(f.oracleResults),
      json(f.branchResults),
      f.damageJpy ?? null,
      f.shadowDamageJpy ?? null,
      f.approveBranchDamageJpy ?? null,
      json(f.damageBreakdown),
      json(f.shadowDamageBreakdown),
      json(f.approveBranchDamageBreakdown),
      f.leakCount ?? null,
      f.shadowLeakCount ?? null,
      f.interpretation ?? null,
      f.costUsd,
      f.governedExecutionId ?? null,
      f.approveExecutionId ?? null,
      f.shadowExecutionId ?? null,
      f.error ?? null,
      f.now,
    ],
  );
}

/** 走行の状況（並び順）。集計・合格証の入力 */
export async function listRehearsalScenarios(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<RehearsalScenarioRow[]> {
  const r = await q.query<RehearsalScenarioRow>(
    "SELECT * FROM rehearsal_scenarios WHERE workspace_id = $1 AND rehearsal_run_id = $2 ORDER BY ordinal",
    [ctx.workspaceId, runId],
  );
  return r.rows;
}

// ---- リハーサルのタスク（BR-67①の唯一の入口）----

export interface InsertRehearsalTaskInput {
  runId: Uuid;
  scenarioId: Uuid;
  /** この種類の sim の走行（sim-world が先に作ったもの） */
  simExecutionId: Uuid;
  /** shadow だけ tasks.shadow = true（DB の CHECK：shadow ⇔ execution_variant = 'shadow'） */
  variant: Exclude<ExecutionVariant, "live">;
  agentId: Uuid;
  agentSnapshotId: Uuid;
  jobId: Uuid;
  requesterId: Uuid;
  askId?: Uuid | null;
  askMemberId?: Uuid | null;
  /** 順番の前の段のタスク（受け渡し：BR-71） */
  inputTaskIds?: readonly Uuid[];
  prompt?: string | null;
  /** 初めから汚染された状態（承認した分岐のタスク：元のタスクの汚染を引き継ぐ） */
  taint?: { tainted: boolean; sources: readonly unknown[] };
  /** 作ったときの状態。既定 queued。承認した分岐のタスクは、gateway が実行できる running */
  status?: "queued" | "running";
  now: Date;
}

/**
 * リハーサルのタスクを作る（is_dry_run = true・trigger_type = dry_run・rehearsal_run_id・rehearsal_scenario_id・sim_execution_id・
 * execution_variant、shadow は variant = shadow のときだけ true）。BR-67①：これらを付けられるのはこの関数だけ。
 * タスクの作成の API・設定プランナー・エージェントのツールには入れない（apps/app/src/rehearsal/boundary.test.ts が呼び出し元を固定する）
 */
export async function insertRehearsalTask(q: Queryable, ctx: WsCtx, i: InsertRehearsalTaskInput): Promise<TaskRow> {
  const shadow = i.variant === "shadow";
  const taint = i.taint ?? { tainted: false, sources: [] };
  return one<TaskRow>(
    q,
    `INSERT INTO tasks (workspace_id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_member_id, input_task_ids,
                        trigger_type, is_dry_run, rehearsal_run_id, rehearsal_scenario_id, shadow, sim_execution_id, execution_variant,
                        prompt, tainted, taint_sources, status, started_at, queued_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], 'dry_run', true, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17,
             CASE WHEN $17 = 'running' THEN $18::timestamptz ELSE NULL END, $18, $18, $18)
     RETURNING *`,
    [
      ctx.workspaceId,
      i.requesterId,
      i.agentId,
      i.agentSnapshotId,
      i.jobId,
      i.askId ?? null,
      i.askMemberId ?? null,
      [...(i.inputTaskIds ?? [])],
      i.runId,
      i.scenarioId,
      shadow,
      i.simExecutionId,
      i.variant,
      i.prompt ?? null,
      taint.tainted,
      [...taint.sources],
      i.status ?? "queued",
      i.now,
    ],
  );
}

/** タスクの Intent（作成順）。オラクルの入力・止めた者の判定の材料 */
export async function listIntentsOfTasks(q: Queryable, ctx: WsCtx, taskIds: readonly Uuid[]): Promise<ActionIntentRow[]> {
  if (taskIds.length === 0) return [];
  const r = await q.query<ActionIntentRow>(
    "SELECT * FROM action_intents WHERE workspace_id = $1 AND task_id = ANY($2::uuid[]) ORDER BY created_at, id",
    [ctx.workspaceId, [...taskIds]],
  );
  return r.rows;
}

/** タスクの判定の記録（作成順）。O-04 の入力・止めた者の判定の材料 */
export async function listDecisionsOfTasks(q: Queryable, ctx: WsCtx, taskIds: readonly Uuid[]): Promise<PolicyDecisionRow[]> {
  if (taskIds.length === 0) return [];
  const r = await q.query<PolicyDecisionRow>(
    "SELECT * FROM policy_decisions WHERE workspace_id = $1 AND task_id = ANY($2::uuid[]) ORDER BY created_at, id",
    [ctx.workspaceId, [...taskIds]],
  );
  return r.rows;
}

/** タスクの費用の合計（マイクロドル。tasks.cost_usd の合計） */
export async function sumTaskCostMicroUsd(q: Queryable, ctx: WsCtx, taskIds: readonly Uuid[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  const r = await q.query<{ micro: string }>(
    "SELECT COALESCE(SUM(round(cost_usd * 1000000)), 0)::text AS micro FROM tasks WHERE workspace_id = $1 AND id = ANY($2::uuid[])",
    [ctx.workspaceId, [...taskIds]],
  );
  return Number(r.rows[0]?.micro ?? "0");
}

/** タスクを動かすための材料：仕事 → エージェント・今のスナップショット（リハーサルの対象の1段） */
export interface JobStageRow {
  job_id: Uuid;
  slug: string;
  agent_id: Uuid;
  agent_snapshot_id: Uuid;
}

export async function getJobStage(q: Queryable, ctx: WsCtx, jobId: Uuid): Promise<JobStageRow | null> {
  return maybe<JobStageRow>(
    q,
    `SELECT j.id AS job_id, j.slug, j.agent_id, a.current_snapshot_id AS agent_snapshot_id
       FROM agent_jobs j JOIN agents a ON a.workspace_id = j.workspace_id AND a.id = j.agent_id
      WHERE j.workspace_id = $1 AND j.id = $2 AND a.current_snapshot_id IS NOT NULL`,
    [ctx.workspaceId, jobId],
  );
}

// ---- 合格証（rehearsal_certificates。FR-067・BR-81）。中身は packages/rehearsal の buildCertificate が決める。ここは決まったことを書くだけ ----

export interface IssueCertificateInput {
  jobId: Uuid;
  askId?: Uuid | null;
  runId: Uuid;
  policyHash: Hex64;
  toolHashes: readonly ToolHashEntry[];
  modelId: string;
  caseSetHash: Hex64;
  caseCount: number;
  summary: JsonObject;
  costUsd: UsdDecimal;
  certificateHash: Hex64;
  now: Date;
}

/**
 * 合格証を発行する。同じ仕事の有効な合格証は superseded で切ってから足す（有効なものは1つ：T-06）。
 * 監査ログ rehearsal.certificate_issued にハッシュを入れ（BR-81）、その seq を行に持たせ、走行の certificate_id を結ぶ。
 * 呼び出し側のトランザクションの中で呼ぶ（外部は呼ばない：G-14）
 */
export async function issueCertificate(tx: Tx, ctx: WsCtx, i: IssueCertificateInput): Promise<RehearsalCertificateRow> {
  await tx.query(
    `UPDATE rehearsal_certificates SET revoked_at = $3, revoke_reason = 'superseded'
      WHERE workspace_id = $1 AND job_id = $2 AND revoked_at IS NULL`,
    [ctx.workspaceId, i.jobId, i.now],
  );
  const audit = await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "rehearsal.certificate_issued",
      actorType: "system",
      actorId: "rehearsal",
      payload: {
        jobId: i.jobId,
        runId: i.runId,
        certificateHash: i.certificateHash,
        policyHash: i.policyHash,
        caseSetHash: i.caseSetHash,
        caseCount: i.caseCount,
        modelId: i.modelId,
      },
    },
    i.now,
  );
  const row = await one<RehearsalCertificateRow>(
    tx,
    `INSERT INTO rehearsal_certificates (workspace_id, job_id, ask_id, rehearsal_run_id, policy_hash, tool_hashes, model_id, case_set_hash,
                                         case_count, summary, cost_usd, certificate_hash, audit_seq, issued_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11::numeric, $12, $13, $14)
     RETURNING *`,
    [
      ctx.workspaceId,
      i.jobId,
      i.askId ?? null,
      i.runId,
      i.policyHash,
      i.toolHashes as never,
      i.modelId,
      i.caseSetHash,
      i.caseCount,
      i.summary as never,
      i.costUsd,
      i.certificateHash,
      audit.seq,
      i.now,
    ],
  );
  await tx.query("UPDATE rehearsal_runs SET certificate_id = $3 WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, i.runId, row.id]);
  return row;
}

export type IssueIfCurrentResult =
  | { issued: true; certificate: RehearsalCertificateRow }
  | { issued: false; reason: "already_issued" | "run_not_done" | "stale"; detail?: string };

/**
 * 走行が終わってから発行するまでに状況が変わっていないことを、ワークスペースのロックの下で確かめて発行する（FR-067・BR-81）。
 * - 走行を読み直し、done でない・すでに合格証がある（certificate_id）なら発行しない（二重の発行・監査ログの二重記録を防ぐ）
 * - 今の外されていない試験を `isCurrent` に渡し、走行の開始時と食い違う（試験・ポリシー・ツールが走行中に変わった）と stale で発行しない。
 *   発行しなかった走行は done のまま残り、切れた合格証は再リハーサル待ちに残る（scanPendingRecertifications）
 * 呼び出し側のトランザクションの中で呼ぶ（外部は呼ばない：G-14）
 */
export async function issueCertificateIfCurrent(
  tx: Tx,
  ctx: WsCtx,
  i: IssueCertificateInput,
  isCurrent: (activeCases: RehearsalCaseRow[]) => Promise<string | null> | string | null,
): Promise<IssueIfCurrentResult> {
  await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [ctx.workspaceId]);
  const run = await getRehearsalRun(tx, ctx, i.runId);
  if (run === null || run.status !== "done") return { issued: false, reason: "run_not_done" };
  // 依頼の走行（job_id が空）は担当ごとに1枚ずつ出す（D-101）：走行の certificate_id は最後の1枚を指すので、発行済みかは担当で見る。
  // 試験の集合も依頼の試験（仕事の試験とは別）で確かめる
  const askScoped = run.job_id === null && i.askId != null;
  if (askScoped) {
    const done = await tx.query("SELECT 1 FROM rehearsal_certificates WHERE workspace_id = $1 AND rehearsal_run_id = $2 AND job_id = $3 LIMIT 1", [ctx.workspaceId, i.runId, i.jobId]);
    if (done.rows.length > 0) return { issued: false, reason: "already_issued" };
  } else if (run.certificate_id !== null) return { issued: false, reason: "already_issued" };
  const active = await listActiveRehearsalCases(tx, ctx, askScoped ? { askId: i.askId as Uuid } : { jobId: i.jobId });
  const stale = await isCurrent(active);
  if (stale !== null) return { issued: false, reason: "stale", detail: stale };
  return { issued: true, certificate: await issueCertificate(tx, ctx, i) };
}

/** 仕事の有効な合格証を切る（広げる変更・モデルの変更・試験の追加。ツールの変化は gateway が切る）。切れたものがなければ null。監査ログ rehearsal.certificate_revoked */
export async function revokeJobCertificate(
  tx: Tx,
  ctx: WsCtx,
  jobId: Uuid,
  reason: Exclude<RevokeReason, "superseded">,
  now: Date,
): Promise<RehearsalCertificateRow | null> {
  const r = await tx.query<RehearsalCertificateRow>(
    `UPDATE rehearsal_certificates SET revoked_at = $3, revoke_reason = $4
      WHERE workspace_id = $1 AND job_id = $2 AND revoked_at IS NULL RETURNING *`,
    [ctx.workspaceId, jobId, now, reason],
  );
  const row = r.rows[0] ?? null;
  if (row !== null) {
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      { eventType: "rehearsal.certificate_revoked", actorType: "system", actorId: "rehearsal", payload: { certificateIds: [row.id], jobIds: [jobId], reason } },
      now,
    );
  }
  return row;
}

// ---- 走行の一覧・動いている走行（HTTP の起動・進捗・結果：routes/rehearsal.ts） ----

/** その対象で動いている走行（queued・generating・running。rehearsal_runs_one_active_uq により高々1件）。なければ null */
export async function findActiveRehearsalRun(q: Queryable, ctx: WsCtx, subject: CaseSubject): Promise<RehearsalRunRow | null> {
  const [jobId, askId] = subjectParams(subject);
  return maybe<RehearsalRunRow>(
    q,
    `SELECT * FROM rehearsal_runs
      WHERE workspace_id = $1 AND job_id IS NOT DISTINCT FROM $2 AND ask_id IS NOT DISTINCT FROM $3 AND status IN ('queued','generating','running')
      LIMIT 1`,
    [ctx.workspaceId, jobId, askId],
  );
}

/**
 * 走行の一覧（新しい順）。subject を渡すとその対象の走行だけ。
 * withMemberRecertify（askId のときだけ効く）：依頼の担当の仕事（ask_members.job_id）の自動の再リハーサル（trigger = recertify）も含める。
 * 合格証は担当の仕事ごとに出し、切れたときの再リハーサルも仕事ごとの走行（job_id だけ。DB の rehearsal_runs_subject_chk）なので、
 * 依頼の走行の一覧には出ない（D-101）。依頼のページが「再リハーサル中」とその結果を出せるように、依頼の新しい走行（user_case 以外）より後のものだけ足す
 */
export async function listRehearsalRuns(
  q: Queryable,
  ctx: WsCtx,
  o: { subject?: CaseSubject; limit: number; withMemberRecertify?: boolean },
): Promise<RehearsalRunRow[]> {
  const [jobId, askId] = o.subject ? subjectParams(o.subject) : [null, null];
  const r = await q.query<RehearsalRunRow>(
    `SELECT * FROM rehearsal_runs x
      WHERE x.workspace_id = $1
        AND ((($2::uuid IS NULL OR x.job_id = $2) AND ($3::uuid IS NULL OR x.ask_id = $3))
          OR ($5 AND $3::uuid IS NOT NULL AND x.trigger = 'recertify'
              AND x.job_id IN (SELECT m.job_id FROM ask_members m WHERE m.workspace_id = $1 AND m.ask_id = $3)
              AND x.created_at >= (SELECT max(a.created_at) FROM rehearsal_runs a WHERE a.workspace_id = $1 AND a.ask_id = $3 AND a.trigger <> 'user_case')))
      ORDER BY x.created_at DESC, x.id DESC LIMIT $4`,
    [ctx.workspaceId, jobId, askId, o.limit, o.withMemberRecertify === true],
  );
  return r.rows;
}

/** 走行が出した合格証（走行の certificate_id が指すもの）。出していなければ null。失効していても返す（revoked_at で見分ける） */
export async function getRunCertificate(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<RehearsalCertificateRow | null> {
  return maybe<RehearsalCertificateRow>(
    q,
    `SELECT c.* FROM rehearsal_certificates c
       JOIN rehearsal_runs r ON r.workspace_id = c.workspace_id AND r.certificate_id = c.id
      WHERE r.workspace_id = $1 AND r.id = $2`,
    [ctx.workspaceId, runId],
  );
}

/**
 * 仕事ごとの「現行」の合格証（仕事ごとに発行の新しい1枚。失効していても返す：revoked_at で見分ける）。
 * 仕事の有効な合格証は1つで、発行のたびに前のものは superseded で切れるので、新しい1枚が現行（依頼の画面が担当の仕事の分を引く）
 */
export async function listCurrentCertificatesOfJobs(q: Queryable, ctx: WsCtx, jobIds: readonly Uuid[]): Promise<RehearsalCertificateRow[]> {
  if (jobIds.length === 0) return [];
  const r = await q.query<RehearsalCertificateRow>(
    `SELECT DISTINCT ON (job_id) * FROM rehearsal_certificates
      WHERE workspace_id = $1 AND job_id = ANY($2::uuid[])
      ORDER BY job_id, issued_at DESC, id DESC`,
    [ctx.workspaceId, jobIds as Uuid[]],
  );
  return r.rows;
}

/**
 * 仕事の現行の合格証が切れていて、切れたあとの最新の走行（自動の再リハーサル・最初・再試験）が費用の上限で止まった
 * （failed で、状況に abort_reason = budget がある）仕事があるか（D-107）。画面の「費用の上限で再リハーサルが止まっています」に使う。
 * 自動の再リハーサルはその日は拾い直さず、翌日にやり直す（system.scanPendingRecertifications）
 */
export async function hasBudgetStoppedRecertification(q: Queryable, ctx: WsCtx, jobIds: readonly Uuid[]): Promise<boolean> {
  if (jobIds.length === 0) return false;
  const r = await q.query(
    `SELECT 1
       FROM (SELECT DISTINCT ON (c.job_id) c.job_id, c.revoked_at FROM rehearsal_certificates c
              WHERE c.workspace_id = $1 AND c.job_id = ANY($2::uuid[])
              ORDER BY c.job_id, c.issued_at DESC, c.id DESC) cur
       CROSS JOIN LATERAL (SELECT x.id, x.status FROM rehearsal_runs x
              WHERE x.workspace_id = $1 AND x.job_id = cur.job_id AND x.trigger IN ('recertify','initial','retest') AND x.created_at >= cur.revoked_at
              ORDER BY x.created_at DESC, x.id DESC LIMIT 1) last
      WHERE cur.revoked_at IS NOT NULL AND last.status = 'failed'
        AND EXISTS (SELECT 1 FROM rehearsal_scenarios s WHERE s.workspace_id = $1 AND s.rehearsal_run_id = last.id AND s.abort_reason = 'budget')
      LIMIT 1`,
    [ctx.workspaceId, jobIds as Uuid[]],
  );
  return r.rows.length > 0;
}

/** 走行（押された画面の走行）から足した、自分の言葉の悪い日（trigger = user_case の子の走行）と入力の行。古い順 */
export async function listUserCaseRunsOf(q: Queryable, ctx: WsCtx, parentRunId: Uuid): Promise<Array<{ run: RehearsalRunRow; input: RehearsalUserInputRow | null }>> {
  const runs = await q.query<RehearsalRunRow>(
    `SELECT * FROM rehearsal_runs WHERE workspace_id = $1 AND parent_run_id = $2 AND trigger = 'user_case' ORDER BY created_at, id`,
    [ctx.workspaceId, parentRunId],
  );
  if (runs.rows.length === 0) return [];
  const inputs = await q.query<RehearsalUserInputRow>(
    `SELECT ${INPUT_COLUMNS} FROM rehearsal_user_inputs WHERE workspace_id = $1 AND rehearsal_run_id = ANY($2::uuid[])`,
    [ctx.workspaceId, runs.rows.map((x) => x.id)],
  );
  return runs.rows.map((run) => ({ run, input: inputs.rows.find((i) => i.rehearsal_run_id === run.id) ?? null }));
}

// ---- 自分の言葉の悪い日の実行（POST …/user-cases・DELETE：routes/rehearsal-user-cases.ts） ----

export async function getUserInput(q: Queryable, ctx: WsCtx, inputId: Uuid): Promise<RehearsalUserInputRow | null> {
  return maybe<RehearsalUserInputRow>(q, `SELECT ${INPUT_COLUMNS} FROM rehearsal_user_inputs WHERE workspace_id = $1 AND id = $2`, [ctx.workspaceId, inputId]);
}

/**
 * 入力の行の実行側の状態を進める（matched → running → done・cancelled・failed）。from に当たらなければ null（終わった行は戻さない）。
 * runId・scenarioId は渡したものだけ書く
 */
export async function advanceUserInput(
  q: Queryable,
  ctx: WsCtx,
  inputId: Uuid,
  f: { from: readonly UserInputStatus[]; status: Extract<UserInputStatus, "running" | "done" | "cancelled" | "failed">; runId?: Uuid; scenarioId?: Uuid },
): Promise<RehearsalUserInputRow | null> {
  return maybe<RehearsalUserInputRow>(
    q,
    `UPDATE rehearsal_user_inputs SET status = $4, rehearsal_run_id = COALESCE($5, rehearsal_run_id), scenario_id = COALESCE($6, scenario_id)
      WHERE workspace_id = $1 AND id = $2 AND status = ANY($3::text[]) RETURNING ${INPUT_COLUMNS}`,
    [ctx.workspaceId, inputId, f.from, f.status, f.runId ?? null, f.scenarioId ?? null],
  );
}

/** 状況の行に「こう解釈しました」の1行を残す（自分の言葉の悪い日。結果の画面に出る） */
export async function setScenarioInterpretation(q: Queryable, ctx: WsCtx, scenarioId: Uuid, line: string): Promise<void> {
  await q.query("UPDATE rehearsal_scenarios SET interpretation = $3 WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, scenarioId, line]);
}

// ---- 本番の停止を試験にする（FR-066：apps/app の incident-hook）・試験の一覧と外す（routes/rehearsal.ts） ----

/** 同じ停止がすでに試験になっているか（外された試験も数える：外したものを黙って戻さない）。intentId なしは Kill Switch（タスクごとに1件） */
export async function findIncidentCase(
  q: Queryable,
  ctx: WsCtx,
  o: { sourceTaskId: Uuid; incidentKind: IncidentKind; intentId: Uuid | null },
): Promise<RehearsalCaseRow | null> {
  return maybe<RehearsalCaseRow>(
    q,
    `SELECT ${CASE_COLUMNS} FROM rehearsal_cases
      WHERE workspace_id = $1 AND source = 'incident' AND source_task_id = $2 AND incident_kind = $3
        AND ($4::text IS NULL OR stopped_writes @> jsonb_build_array(jsonb_build_object('intentId', $4::text)))
      LIMIT 1`,
    [ctx.workspaceId, o.sourceTaskId, o.incidentKind, o.intentId],
  );
}

/** 対象の試験の一覧（古い順）。既定は外されていないものだけ */
export async function listRehearsalCases(q: Queryable, ctx: WsCtx, subject: CaseSubject, o: { includeRemoved?: boolean } = {}): Promise<RehearsalCaseRow[]> {
  const [jobId, askId] = subjectParams(subject);
  const r = await q.query<RehearsalCaseRow>(
    `SELECT ${CASE_COLUMNS} FROM rehearsal_cases
      WHERE workspace_id = $1 AND job_id IS NOT DISTINCT FROM $2 AND ask_id IS NOT DISTINCT FROM $3 AND ($4 OR removed_at IS NULL)
      ORDER BY created_at, id`,
    [ctx.workspaceId, jobId, askId, o.includeRemoved === true],
  );
  return r.rows;
}

/** ユーザーの操作で試験を外す（removed_reason = 'user'）。すでに外れている・ないなら null。監査ログ rehearsal.case_removed を同じトランザクションで書く */
export async function removeRehearsalCaseByUser(tx: Tx, ctx: WsCtx, caseId: Uuid, by: Uuid, now: Date): Promise<RehearsalCaseRow | null> {
  const row = await maybe<RehearsalCaseRow>(
    tx,
    `UPDATE rehearsal_cases SET removed_at = $3, removed_by = $4, removed_reason = 'user'
      WHERE workspace_id = $1 AND id = $2 AND removed_at IS NULL RETURNING ${CASE_COLUMNS}`,
    [ctx.workspaceId, caseId, now, by],
  );
  if (row === null) return null;
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "rehearsal.case_removed",
      actorType: "user",
      actorId: by,
      payload: { caseId: row.id, source: row.source, jobId: row.job_id, askId: row.ask_id, reasonCode: row.reason_code, faultIds: row.fault_ids },
    },
    now,
  );
  return row;
}

// ---- 締める変更の適用（FR-045：設定変更 TBL-025 を origin = rehearsal_tighten・classification = narrow で保存し、新しい今のスナップショットを作る） ----

export interface ApplyTighteningInput {
  agentId: Uuid;
  jobId: Uuid;
  /** 案のもとになった走行（rehearsal_tighten は走行つきでないと保存できない：DB の CHECK） */
  runId: Uuid;
  /** 当てた差分（JSON Patch） */
  patch: Json[];
  /** 差分を当てる前に今だったスナップショット。ほかの変更で動いていたら何も書かず null */
  expectedSnapshotId: Uuid;
  /** 差分を当てた定義と、そこから作った実効ポリシー（仕事の slug → { policy, hash }） */
  definition: JsonObject;
  effectivePolicies: EffectivePolicies;
  clamped: Json[];
  ceilingsVersion: string;
  decidedBy: Uuid;
  now: Date;
}

/**
 * 締める変更を適用する：設定変更（applied）→ スナップショット → エージェントの今のスナップショットを付け替える。監査ログ agent.config.changed。
 * 呼び出し側のトランザクションの中で呼ぶ（外部は呼ばない：G-14）。合格証には触れない（締める変更では切れない：FR-067）
 */
export async function applyTighteningChange(
  tx: Tx,
  ctx: WsCtx,
  i: ApplyTighteningInput,
): Promise<{ change: AgentConfigChangeRow; snapshot: AgentSnapshotRow } | null> {
  const cur = await maybe<{ current_snapshot_id: Uuid | null }>(
    tx,
    "SELECT current_snapshot_id FROM agents WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    [ctx.workspaceId, i.agentId],
  );
  if (cur === null || cur.current_snapshot_id !== i.expectedSnapshotId) return null;
  // applied には snapshot_id が要り、スナップショットは変更を指す。proposed で足してから付け替える
  const proposed = await one<AgentConfigChangeRow>(
    tx,
    `INSERT INTO agent_config_changes (workspace_id, agent_id, job_id, origin, rehearsal_run_id, patch, classification, status, created_at)
     VALUES ($1, $2, $3, 'rehearsal_tighten', $4, $5::jsonb, 'narrow', 'proposed', $6)
     RETURNING *`,
    [ctx.workspaceId, i.agentId, i.jobId, i.runId, i.patch as never, i.now],
  );
  const snapshot = await one<AgentSnapshotRow>(
    tx,
    `INSERT INTO agent_snapshots (workspace_id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
     VALUES ($1, $2, $3, 'in_app', 'valid', $4::jsonb, $5::jsonb, $6::jsonb, $7, $8)
     RETURNING *`,
    [ctx.workspaceId, i.agentId, proposed.id, i.definition as never, i.effectivePolicies as never, i.clamped as never, i.ceilingsVersion, i.now],
  );
  const change = await one<AgentConfigChangeRow>(
    tx,
    `UPDATE agent_config_changes SET status = 'applied', snapshot_id = $3, decided_by = $4, decided_at = $5
      WHERE workspace_id = $1 AND id = $2 RETURNING *`,
    [ctx.workspaceId, proposed.id, snapshot.id, i.decidedBy, i.now],
  );
  await tx.query("UPDATE agents SET current_snapshot_id = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2", [
    ctx.workspaceId,
    i.agentId,
    snapshot.id,
    i.now,
  ]);
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "agent.config.changed",
      actorType: "user",
      actorId: i.decidedBy,
      payload: {
        agentId: i.agentId,
        jobId: i.jobId,
        changeId: change.id,
        snapshotId: snapshot.id,
        previousSnapshotId: i.expectedSnapshotId,
        classification: "narrow",
        origin: "rehearsal_tighten",
        runId: i.runId,
        patch: i.patch,
      },
    },
    i.now,
  );
  return { change, snapshot };
}

export async function getConfigChange(q: Queryable, ctx: WsCtx, changeId: Uuid): Promise<AgentConfigChangeRow | null> {
  return maybe<AgentConfigChangeRow>(q, "SELECT * FROM agent_config_changes WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, changeId]);
}

/** 同じ走行・同じ仕事で、同じ差分を適用済みの締める変更（再適用の検出用。差分の比較は呼び出し側） */
export async function listAppliedTighteningChanges(q: Queryable, ctx: WsCtx, runId: Uuid, jobId: Uuid): Promise<AgentConfigChangeRow[]> {
  const r = await q.query<AgentConfigChangeRow>(
    "SELECT * FROM agent_config_changes WHERE workspace_id = $1 AND rehearsal_run_id = $2 AND job_id = $3 AND origin = 'rehearsal_tighten' AND status = 'applied'",
    [ctx.workspaceId, runId, jobId],
  );
  return r.rows;
}
