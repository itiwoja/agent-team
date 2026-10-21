// 依頼（asks）の問い合わせ（@open-team/db/asks。設定プランナー FR-061・編成の実行 FR-062・回答 FR-063・連絡板 FR-064・API-072〜077）
// README §1 の約束：業務の関数は (q, ctx: WsCtx, …)、SQL を必ず workspace_id で絞る。書いて整合が要る関数は Tx を受ける。
// トランザクションの中で外部（Gemini・gateway・sim-world）を呼ばない（G-14）。ロックの順はワークスペース → タスク → 承認 → Intent（M-21）。
// 本番のタスクを作るのは insertAskTask だけ（trigger_type = 'ask'・本番。shadow・rehearsal_run_id は付けられない：BR-67①）

import type { Hex64, Json, JsonObject, TaintState } from "@open-team/kernel";
import type { Queryable, Tx } from "../client.ts";
import type {
  AgentQuestionRow,
  AgentRow,
  AgentSnapshotRow,
  AskFailureReason,
  AskPendingReplyRow,
  AskMemberRow,
  AskRow,
  AskRunRow,
  AskRunStatus,
  AskRunTrigger,
  AskShape,
  AskStatus,
  AskTrigger,
  EffectivePolicies,
  TaskRow,
  TeamMessageKind,
  Uuid,
} from "../types.ts";
import type { WsCtx } from "../workspace.ts";
import { addTaskWebUrls, copyTaskWebUrls, TASK_WEB_URLS_MAX } from "./web-urls.ts";

async function one<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T> {
  const r = await q.query<T>(text, params);
  const row = r.rows[0];
  if (!row) throw new Error(`行を書けなかった：${text.trim().slice(0, 60)}`);
  return row;
}
async function maybe<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T | null> {
  const r = await q.query<T>(text, params);
  return r.rows[0] ?? null;
}

// =====================================================================
// 依頼
// =====================================================================

const ASK_COLS = `id, workspace_id, created_by, text, mention_agent_id, pack_id, shape, status, trigger, next_run_at, formation, planner_attempts,
  question, question_answer, failure_reason, seed_key, created_at, updated_at, finished_at`;

export async function getAsk(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<AskRow | null> {
  return maybe<AskRow>(q, `SELECT ${ASK_COLS} FROM asks WHERE workspace_id = $1 AND id = $2`, [ctx.workspaceId, askId]);
}

/** 新しい順の一覧（入口 SCR-020 用） */
export async function listAsks(q: Queryable, ctx: WsCtx, o: { limit: number; status?: AskStatus }): Promise<AskRow[]> {
  const r = await q.query<AskRow>(
    `SELECT ${ASK_COLS} FROM asks WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC, id DESC LIMIT $3`,
    [ctx.workspaceId, o.status ?? null, o.limit],
  );
  return r.rows;
}

/**
 * 依頼を生成中（generating）で作る（FR-061 の処理1）。担当の指定（mention）は作る前に引いた agent の id。
 * packId はパックの作業場から出した依頼のとき、入っていると確かめたパックの id（0018。省略は null）
 */
export async function insertGeneratingAsk(
  tx: Tx,
  ctx: WsCtx,
  i: { createdBy: Uuid; text: string; mentionAgentId: Uuid | null; packId?: string | null; now: Date },
): Promise<AskRow> {
  return one<AskRow>(
    tx,
    `INSERT INTO asks (workspace_id, created_by, text, mention_agent_id, pack_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'generating', $6, $6) RETURNING ${ASK_COLS}`,
    [ctx.workspaceId, i.createdBy, i.text, i.mentionAgentId, i.packId ?? null, i.now],
  );
}

/** 設定プランナーを呼んだ回数を足す（上限3：DB の CHECK）。generating のときだけ */
export async function bumpPlannerAttempts(q: Queryable, ctx: WsCtx, askId: Uuid, by: number, now: Date): Promise<void> {
  await q.query(
    `UPDATE asks SET planner_attempts = LEAST(3, planner_attempts + $3), updated_at = $4
      WHERE workspace_id = $1 AND id = $2 AND status = 'generating'`,
    [ctx.workspaceId, askId, by, now],
  );
}

/** 質問を1つ載せる（生成中のまま。BR-49：すでに質問があれば載せない＝false） */
export async function setAskQuestion(
  q: Queryable,
  ctx: WsCtx,
  askId: Uuid,
  question: { text: string; choices: Array<{ id: string; label: string }>; allowFreeText: boolean },
  now: Date,
): Promise<boolean> {
  const r = await q.query(
    `UPDATE asks SET question = $3::jsonb, updated_at = $4
      WHERE workspace_id = $1 AND id = $2 AND status = 'generating' AND question IS NULL`,
    [ctx.workspaceId, askId, question, now],
  );
  return r.rowCount > 0;
}

/** 質問への答えを保存する（質問が出ていて、まだ答えていない生成中の依頼だけ） */
export async function setAskQuestionAnswer(q: Queryable, ctx: WsCtx, askId: Uuid, answer: string, now: Date): Promise<AskRow | null> {
  return maybe<AskRow>(
    q,
    `UPDATE asks SET question_answer = $3, updated_at = $4
      WHERE workspace_id = $1 AND id = $2 AND status = 'generating' AND question IS NOT NULL AND question_answer IS NULL
      RETURNING ${ASK_COLS}`,
    [ctx.workspaceId, askId, answer, now],
  );
}

/** 編成ができた：generating → running（CAS。Kill Switch などで先に閉じられていれば null） */
export async function markAskFormed(
  tx: Tx,
  ctx: WsCtx,
  askId: Uuid,
  i: { shape: AskShape; formation: JsonObject; trigger: AskTrigger | null; nextRunAt: Date | null; now: Date },
): Promise<AskRow | null> {
  return maybe<AskRow>(
    tx,
    `UPDATE asks SET shape = $3, formation = $4::jsonb, trigger = $5::jsonb, next_run_at = $6, status = 'running', updated_at = $7
      WHERE workspace_id = $1 AND id = $2 AND status = 'generating' RETURNING ${ASK_COLS}`,
    [ctx.workspaceId, askId, i.shape, i.formation, i.trigger, i.nextRunAt, i.now],
  );
}

/** 生成に失敗した：generating → failed（CAS。すでに閉じていれば null） */
export async function markAskGenerationFailed(q: Queryable, ctx: WsCtx, askId: Uuid, reason: AskFailureReason, now: Date): Promise<AskRow | null> {
  return maybe<AskRow>(
    q,
    `UPDATE asks SET status = 'failed', failure_reason = $3, updated_at = $4, finished_at = $4
      WHERE workspace_id = $1 AND id = $2 AND status = 'generating' RETURNING ${ASK_COLS}`,
    [ctx.workspaceId, askId, reason, now],
  );
}

/** 実行の状態に合わせて依頼の状態を変える（from のどれかのときだけ。変えたら行を返す） */
export async function transitionAsk(
  q: Queryable,
  ctx: WsCtx,
  askId: Uuid,
  from: readonly AskStatus[],
  to: AskStatus,
  now: Date,
): Promise<AskRow | null> {
  const finished = to === "done" || to === "failed" || to === "cancelled";
  return maybe<AskRow>(
    q,
    `UPDATE asks SET status = $4, updated_at = $5, finished_at = CASE WHEN $6 THEN $5 ELSE NULL END
      WHERE workspace_id = $1 AND id = $2 AND status = ANY($3::text[]) RETURNING ${ASK_COLS}`,
    [ctx.workspaceId, askId, [...from], to, now, finished],
  );
}

/** 次の実行の時刻を進める（定期の依頼） */
export async function setAskNextRun(q: Queryable, ctx: WsCtx, askId: Uuid, nextRunAt: Date | null, now: Date): Promise<void> {
  await q.query("UPDATE asks SET next_run_at = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2 AND trigger IS NOT NULL", [
    ctx.workspaceId,
    askId,
    nextRunAt,
    now,
  ]);
}

// =====================================================================
// 編成の材料（設定プランナーに渡すもの）
// =====================================================================

export interface PlannerAgentRow {
  agent: AgentRow;
  jobCount: number;
  definition: JsonObject | null;
}

/** ワークスペースのエージェントと、仕事の数・今のスナップショットの定義（removed も含む：名前の重なりを見るため） */
export async function listAgentsForPlanner(q: Queryable, ctx: WsCtx): Promise<PlannerAgentRow[]> {
  const r = await q.query<AgentRow & { job_count: number; definition: JsonObject | null }>(
    `SELECT a.id, a.workspace_id, a.slug, a.name, a.name_source, a.role, a.appearance, a.status, a.current_snapshot_id, a.disabled_by,
            a.disabled_reason, a.disabled_at, a.created_at, a.updated_at,
            (SELECT count(*)::int FROM agent_jobs j WHERE j.workspace_id = a.workspace_id AND j.agent_id = a.id) AS job_count,
            s.definition
       FROM agents a
       LEFT JOIN agent_snapshots s ON s.workspace_id = a.workspace_id AND s.id = a.current_snapshot_id
      WHERE a.workspace_id = $1
      ORDER BY a.created_at, a.id`,
    [ctx.workspaceId],
  );
  return r.rows.map(({ job_count, definition, ...agent }) => ({ agent, jobCount: job_count, definition }));
}

/** 担当を名前か ID で引く（removed を除く） */
export async function findLiveAgentByIdOrName(q: Queryable, ctx: WsCtx, key: string): Promise<AgentRow | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  return maybe<AgentRow>(
    q,
    `SELECT id, workspace_id, slug, name, name_source, role, appearance, status, current_snapshot_id, disabled_by, disabled_reason,
            disabled_at, created_at, updated_at
       FROM agents WHERE workspace_id = $1 AND status <> 'removed' AND (id = $2::uuid OR name = $3)
      ORDER BY (id = $2::uuid) DESC LIMIT 1`,
    [ctx.workspaceId, isUuid ? key.toLowerCase() : "00000000-0000-0000-0000-000000000000", isUuid ? "" : key],
  );
}

/** 既存の担当に新しいスナップショットを足して今のものにする（依頼の仕事を足すとき。UPDATE 禁止の表なので足すだけ） */
export async function appendAgentSnapshot(
  tx: Tx,
  ctx: WsCtx,
  i: {
    agentId: Uuid;
    definition: JsonObject;
    effectivePolicies: EffectivePolicies;
    clamped: Json[];
    ceilingsVersion: string;
    now: Date;
  },
): Promise<AgentSnapshotRow> {
  const snapshot = await one<AgentSnapshotRow>(
    tx,
    `INSERT INTO agent_snapshots (workspace_id, agent_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
     VALUES ($1, $2, 'in_app', 'valid', $3, $4, $5, $6, $7)
     RETURNING id, workspace_id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version,
               errors, warnings, created_at`,
    [ctx.workspaceId, i.agentId, i.definition, i.effectivePolicies, i.clamped, i.ceilingsVersion, i.now],
  );
  await tx.query("UPDATE agents SET current_snapshot_id = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2", [
    ctx.workspaceId,
    i.agentId,
    snapshot.id,
    i.now,
  ]);
  return snapshot;
}

// =====================================================================
// 実行（ask_runs）
// =====================================================================

const RUN_COLS = `id, workspace_id, ask_id, run_no, mode, rehearsal_run_id, rehearsal_scenario_id, trigger_type, status, answer_task_id, answer,
  answer_hash, answered_at, first_member_started_at, started_at, finished_at`;

/** 本番の実行を始める（run_no は本番の実行だけで数える）。同じ依頼で動いている実行があれば作らず null */
export async function insertLiveRun(tx: Tx, ctx: WsCtx, askId: Uuid, triggerType: AskRunTrigger, now: Date): Promise<AskRunRow | null> {
  const active = await tx.query(
    "SELECT 1 FROM ask_runs WHERE workspace_id = $1 AND ask_id = $2 AND mode = 'live' AND status IN ('running','waiting_input') LIMIT 1",
    [ctx.workspaceId, askId],
  );
  if (active.rowCount > 0) return null;
  return one<AskRunRow>(
    tx,
    `INSERT INTO ask_runs (workspace_id, ask_id, run_no, mode, trigger_type, status, started_at)
     VALUES ($1, $2, COALESCE((SELECT max(run_no) FROM ask_runs WHERE workspace_id = $1 AND ask_id = $2 AND mode = 'live'), 0) + 1,
             'live', $3, 'running', $4)
     RETURNING ${RUN_COLS}`,
    [ctx.workspaceId, askId, triggerType, now],
  );
}

export async function getAskRun(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<AskRunRow | null> {
  return maybe<AskRunRow>(q, `SELECT ${RUN_COLS} FROM ask_runs WHERE workspace_id = $1 AND id = $2`, [ctx.workspaceId, runId]);
}

/** 本番の最新の実行 */
export async function getLatestLiveRun(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<AskRunRow | null> {
  return maybe<AskRunRow>(
    q,
    `SELECT ${RUN_COLS} FROM ask_runs WHERE workspace_id = $1 AND ask_id = $2 AND mode = 'live' ORDER BY run_no DESC LIMIT 1`,
    [ctx.workspaceId, askId],
  );
}

/**
 * 本番の実行の履歴（新しい順に limit 件。画面は古い順に並べ直す）。
 * 依頼のページの「頼んだこと → 回答」の対応に使う（返事のたびに実行が1つ増える）
 */
export async function listLiveRuns(q: Queryable, ctx: WsCtx, askId: Uuid, limit: number): Promise<AskRunRow[]> {
  const r = await q.query<AskRunRow>(
    `SELECT ${RUN_COLS} FROM ask_runs WHERE workspace_id = $1 AND ask_id = $2 AND mode = 'live' ORDER BY run_no DESC LIMIT $3`,
    [ctx.workspaceId, askId, limit],
  );
  return r.rows;
}

/**
 * 実行ごとに、担当に渡した「お願い」の文（最初に作った担当のタスクの prompt。返事の実行は返事の文）。
 * prompt のない実行（用意した依頼の種など）は入らない。追いのターン（kind = followup）は数えない
 */
export async function firstPromptsOfRuns(q: Queryable, ctx: WsCtx, runIds: readonly Uuid[]): Promise<Map<Uuid, string>> {
  if (runIds.length === 0) return new Map();
  const r = await q.query<{ ask_run_id: Uuid; prompt: string }>(
    `SELECT DISTINCT ON (ask_run_id) ask_run_id, prompt FROM tasks
      WHERE workspace_id = $1 AND ask_run_id = ANY($2::uuid[]) AND kind = 'normal' AND prompt IS NOT NULL
      ORDER BY ask_run_id, created_at, id`,
    [ctx.workspaceId, [...runIds]],
  );
  return new Map(r.rows.map((row) => [row.ask_run_id, row.prompt]));
}

/** 実行の状態を変える（from のどれかのときだけ） */
export async function transitionRun(
  q: Queryable,
  ctx: WsCtx,
  runId: Uuid,
  from: readonly AskRunStatus[],
  to: AskRunStatus,
  now: Date,
): Promise<AskRunRow | null> {
  const finished = to === "done" || to === "failed" || to === "cancelled";
  return maybe<AskRunRow>(
    q,
    `UPDATE ask_runs SET status = $4, finished_at = CASE WHEN $5 THEN $6::timestamptz ELSE NULL END
      WHERE workspace_id = $1 AND id = $2 AND status = ANY($3::text[]) RETURNING ${RUN_COLS}`,
    [ctx.workspaceId, runId, [...from], to, finished, now],
  );
}

/** 最初の担当が始まった時刻（A-100 のまとめ役の待ち時間の起点）。入っていれば変えない */
export async function markFirstMemberStarted(q: Queryable, ctx: WsCtx, runId: Uuid, now: Date): Promise<void> {
  await q.query(
    "UPDATE ask_runs SET first_member_started_at = $3 WHERE workspace_id = $1 AND id = $2 AND first_member_started_at IS NULL",
    [ctx.workspaceId, runId, now],
  );
}

/** 回答を保存する。最初の1回で answered_at を入れ、2回目以降（手が要るものの行の書き換え）は answered_at を変えない */
export async function saveRunAnswer(
  q: Queryable,
  ctx: WsCtx,
  runId: Uuid,
  i: { answerTaskId: Uuid | null; answer: JsonObject; answerHash: Hex64; now: Date },
): Promise<AskRunRow | null> {
  return maybe<AskRunRow>(
    q,
    `UPDATE ask_runs SET answer_task_id = $3, answer = $4::jsonb, answer_hash = $5, answered_at = COALESCE(answered_at, $6)
      WHERE workspace_id = $1 AND id = $2 RETURNING ${RUN_COLS}`,
    [ctx.workspaceId, runId, i.answerTaskId, i.answer, i.answerHash, i.now],
  );
}

/** 動いている本番の実行（tick の拾い直し用。1ワークスペースぶん） */
export async function listActiveLiveRuns(q: Queryable, ctx: WsCtx): Promise<AskRunRow[]> {
  const r = await q.query<AskRunRow>(
    `SELECT ${RUN_COLS} FROM ask_runs WHERE workspace_id = $1 AND mode = 'live' AND status IN ('running','waiting_input') ORDER BY started_at`,
    [ctx.workspaceId],
  );
  return r.rows;
}

// =====================================================================
// 担当・タスク
// =====================================================================

export async function listMembers(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<Array<AskMemberRow & { agent_name: string }>> {
  const r = await q.query<AskMemberRow & { agent_name: string }>(
    `SELECT m.*, a.name AS agent_name
       FROM ask_members m JOIN agents a ON a.id = m.agent_id AND a.workspace_id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.ask_id = $2
      ORDER BY m.is_aggregator, m.position NULLS LAST, m.created_at, m.id`,
    [ctx.workspaceId, askId],
  );
  return r.rows;
}

export interface InsertAskTaskInput {
  requesterId: Uuid;
  agentId: Uuid;
  agentSnapshotId: Uuid;
  jobId: Uuid;
  askId: Uuid;
  askRunId: Uuid;
  askMemberId: Uuid;
  /** 受け渡した元のタスク（BR-71）。edge が「データ」として入力に渡す */
  inputTaskIds: readonly Uuid[];
  /** 受け渡しの汚染を引き継いで始める（taintFromInputs の結果） */
  taint: TaintState;
  /** 依頼の本文（窓口へのお願いなど。秘密情報はマスク済み） */
  prompt: string | null;
  /**
   * 利用者自身が書いた文（依頼の文・返事の文）に含まれる URL の鍵（edge の userTextWebUrlHashes。SG-04）。
   * タスクの見た URL の集合に最初に入れる。担当の指示（プランナーが書いたもの）や前の段の中身から作ったものは渡さない
   */
  userWebUrlHashes?: readonly string[];
  /**
   * 見た URL の集合を写す元（inputTaskIds に加えて。SG-04）。返事の実行の前の回答のタスクなど、汚染を引き継ぐ元を
   * 入力の並べ方にかかわらず確実に写すために渡す。同じワークスペースのタスクのものだけが写る（copyTaskWebUrls）
   */
  inheritWebUrlsFrom?: readonly Uuid[];
  now: Date;
}

/**
 * 本番のタスクを作る（trigger_type = 'ask'・queued・execution_variant = 'live'）。shadow・rehearsal_run_id は付けられない（BR-67①）。
 * 担当に今のスナップショットを固定する（agent_snapshot_id は呼び出し側が現在のものを渡す）
 */
export async function insertAskTask(tx: Tx, ctx: WsCtx, i: InsertAskTaskInput): Promise<TaskRow> {
  const task = await one<TaskRow>(
    tx,
    `INSERT INTO tasks (workspace_id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, ask_member_id, input_task_ids,
                        trigger_type, is_dry_run, execution_variant, prompt, tainted, taint_sources, status, queued_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], 'ask', false, 'live', $10, $11, $12::jsonb, 'queued', $13, $13, $13)
     RETURNING *`,
    [
      ctx.workspaceId,
      i.requesterId,
      i.agentId,
      i.agentSnapshotId,
      i.jobId,
      i.askId,
      i.askRunId,
      i.askMemberId,
      [...i.inputTaskIds],
      i.prompt,
      i.taint.tainted,
      [...i.taint.sources],
      i.now,
    ],
  );
  // 見た URL の集合（SG-04）：利用者の文の URL を先に、受け渡しの元のタスク（汚染を引き継ぐ元）が見た URL を後に
  await addTaskWebUrls(tx, ctx, task.id, i.userWebUrlHashes ?? [], TASK_WEB_URLS_MAX, i.now);
  await copyTaskWebUrls(tx, ctx, task.id, [...new Set([...i.inputTaskIds, ...(i.inheritWebUrlsFrom ?? [])])], TASK_WEB_URLS_MAX, i.now);
  return task;
}

/** 実行のタスク（古い順）。同じ担当のやり直しは新しいタスクが後ろに並ぶ */
export async function listRunTasks(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<TaskRow[]> {
  const r = await q.query<TaskRow>(
    "SELECT * FROM tasks WHERE workspace_id = $1 AND ask_run_id = $2 ORDER BY created_at, id",
    [ctx.workspaceId, runId],
  );
  return r.rows;
}

/**
 * 担当の前の回の報告（定期の見張りで「前回の報告」として渡す）。この実行より前の実行の、報告のある通常のタスクのうち最も新しいもの。
 * 本番だけ（リハーサルのタスクは ask_member_id を持たない）
 */
export async function getPreviousReportTask(q: Queryable, ctx: WsCtx, memberId: Uuid, currentRunId: Uuid): Promise<TaskRow | null> {
  const r = await q.query<TaskRow>(
    `SELECT t.* FROM tasks t
       JOIN ask_runs r ON r.workspace_id = t.workspace_id AND r.id = t.ask_run_id
      WHERE t.workspace_id = $1 AND t.ask_member_id = $2 AND t.ask_run_id <> $3 AND t.kind = 'normal'
        AND t.report IS NOT NULL AND t.rehearsal_run_id IS NULL
      ORDER BY r.run_no DESC, t.created_at DESC, t.id DESC
      LIMIT 1`,
    [ctx.workspaceId, memberId, currentRunId],
  );
  return r.rows[0] ?? null;
}

/**
 * queued のタスクを動かす側が取る（queued → provisioning。取れたのは1か所だけ：同じタスクを2か所で動かさない）。
 * 取れなければ null（すでに動いている・終わっている）
 */
export async function claimQueuedTask(tx: Tx, ctx: WsCtx, taskId: Uuid, now: Date): Promise<TaskRow | null> {
  return maybe<TaskRow>(
    tx,
    `UPDATE tasks SET status = 'provisioning', updated_at = $3
      WHERE workspace_id = $1 AND id = $2 AND status = 'queued' AND rehearsal_run_id IS NULL RETURNING *`,
    [ctx.workspaceId, taskId, now],
  );
}

/** 依頼の動いているタスク（Kill Switch・取り消しの確認用） */
export async function countOpenRunTasks(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM tasks
      WHERE workspace_id = $1 AND ask_run_id = $2
        AND status NOT IN ('succeeded','completed','rejected','failed','cancelled','halted')`,
    [ctx.workspaceId, runId],
  );
  return r.n;
}

// =====================================================================
// 送る前の確認（承認待ちの Intent）
// =====================================================================

export interface PendingIntentRow {
  intent_id: Uuid;
  approval_id: Uuid | null;
  task_id: Uuid;
  agent_name: string;
  action: string;
  intent_hash: Hex64;
  taint_snapshot: TaintState;
  created_at: Date;
}

/**
 * タスクごとの、ユーザーが送る前の確認で「送らない」にした Intent（status = rejected）の数（D-108。回答の手が要るものの行・担当の段の文に使う）。
 * ツールの変更で無効にした確認（expired・tool_changed）は数えない。なければ Map に入らない
 */
export async function countRejectedIntentsOfTasks(q: Queryable, ctx: WsCtx, taskIds: readonly Uuid[]): Promise<Map<Uuid, number>> {
  if (taskIds.length === 0) return new Map();
  const r = await q.query<{ task_id: Uuid; n: string }>(
    `SELECT task_id, count(*) AS n FROM action_intents
      WHERE workspace_id = $1 AND task_id = ANY($2::uuid[]) AND status = 'rejected'
      GROUP BY task_id`,
    [ctx.workspaceId, [...taskIds]],
  );
  return new Map(r.rows.map((x) => [x.task_id, Number(x.n)] as const));
}

/**
 * 担当ごとの「この依頼より前の依頼」の数（依頼のページの段：いつもの担当 · 前の依頼 N件でも働きました）。
 * before の依頼（askId）は除き、作られた時刻が before.createdAt より前のものだけ数える。なければ Map に入らない
 */
export async function countPriorAsksOfAgents(
  q: Queryable,
  ctx: WsCtx,
  agentIds: readonly Uuid[],
  before: { askId: Uuid; createdAt: Date },
): Promise<Map<Uuid, number>> {
  if (agentIds.length === 0) return new Map();
  const r = await q.query<{ agent_id: Uuid; n: number }>(
    `SELECT m.agent_id, count(DISTINCT m.ask_id)::int AS n
       FROM ask_members m JOIN asks k ON k.workspace_id = m.workspace_id AND k.id = m.ask_id
      WHERE m.workspace_id = $1 AND m.agent_id = ANY($2::uuid[]) AND m.ask_id <> $3 AND k.created_at < $4
      GROUP BY m.agent_id`,
    [ctx.workspaceId, [...agentIds], before.askId, before.createdAt],
  );
  return new Map(r.rows.map((x) => [x.agent_id, x.n] as const));
}

export interface ToolActivityRow {
  task_id: Uuid;
  action: string | null;
  decision: string;
  created_at: Date;
}

/** タスクごとのツールの呼び出しの判定（policy_decisions の tool_call）。新しいものから perTask 件まで、古い順に返す（依頼のページの「やったこと」） */
export async function listToolActivityOfTasks(q: Queryable, ctx: WsCtx, taskIds: readonly Uuid[], perTask: number): Promise<ToolActivityRow[]> {
  if (taskIds.length === 0) return [];
  const r = await q.query<ToolActivityRow>(
    `SELECT task_id, action, decision, created_at FROM (
       SELECT task_id, COALESCE(subject->>'action', subject->>'actionType', subject->'call'->>'name') AS action, decision, created_at, id,
              row_number() OVER (PARTITION BY task_id ORDER BY created_at DESC, id DESC) AS rn
         FROM policy_decisions
        WHERE workspace_id = $1 AND task_id = ANY($2::uuid[]) AND subject_kind = 'tool_call'
     ) d
     WHERE rn <= $3
     ORDER BY task_id, created_at, id`,
    [ctx.workspaceId, [...taskIds], perTask],
  );
  return r.rows;
}

/** タスクの承認待ちの Intent（pending_approval）。承認の行（pending）があれば付ける */
export async function listPendingIntentsOfTasks(q: Queryable, ctx: WsCtx, taskIds: readonly Uuid[]): Promise<PendingIntentRow[]> {
  if (taskIds.length === 0) return [];
  const r = await q.query<PendingIntentRow>(
    `SELECT i.id AS intent_id, ap.id AS approval_id, i.task_id, a.name AS agent_name, i.action, i.intent_hash, i.taint_snapshot, i.created_at
       FROM action_intents i
       JOIN tasks t ON t.workspace_id = i.workspace_id AND t.id = i.task_id
       JOIN agents a ON a.workspace_id = t.workspace_id AND a.id = t.agent_id
       LEFT JOIN approvals ap ON ap.workspace_id = i.workspace_id AND ap.intent_id = i.id AND ap.status = 'pending'
      WHERE i.workspace_id = $1 AND i.task_id = ANY($2::uuid[]) AND i.status = 'pending_approval'
      ORDER BY i.created_at, i.id`,
    [ctx.workspaceId, [...taskIds]],
  );
  return r.rows;
}

// =====================================================================
// 連絡板（FR-064。Should）
// =====================================================================

export interface AskMessageRow {
  id: Uuid;
  ask_id: Uuid;
  ask_run_id: Uuid | null;
  from_member: Uuid;
  from_agent_name: string;
  to_member: Uuid | null;
  to_agent_name: string | null;
  kind: TeamMessageKind;
  body: string;
  in_reply_to: Uuid | null;
  tainted: boolean;
  from_task_id: Uuid;
  created_at: Date;
}

/** 受け付けた連絡（rejected_reason が空のもの）を古い順に */
export async function listAskMessages(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<AskMessageRow[]> {
  const r = await q.query<AskMessageRow>(
    `SELECT m.id, m.ask_id, m.ask_run_id, m.from_member, fa.name AS from_agent_name, m.to_member, ta.name AS to_agent_name,
            m.kind, m.body, m.in_reply_to, m.tainted, m.from_task_id, m.created_at
       FROM ask_messages m
       JOIN ask_members fm ON fm.workspace_id = m.workspace_id AND fm.id = m.from_member
       JOIN agents fa ON fa.workspace_id = fm.workspace_id AND fa.id = fm.agent_id
       LEFT JOIN ask_members tm ON tm.workspace_id = m.workspace_id AND tm.id = m.to_member
       LEFT JOIN agents ta ON ta.workspace_id = tm.workspace_id AND ta.id = tm.agent_id
      WHERE m.workspace_id = $1 AND m.ask_id = $2 AND m.rejected_reason IS NULL
      ORDER BY m.created_at, m.id`,
    [ctx.workspaceId, askId],
  );
  return r.rows;
}

export async function countAskMessages(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    "SELECT count(*)::int AS n FROM ask_messages WHERE workspace_id = $1 AND ask_id = $2 AND rejected_reason IS NULL",
    [ctx.workspaceId, askId],
  );
  return r.n;
}

/** 連絡を保存する（本文はマスク済みを渡す。検査は kernel の validateTeamMessage が済んでいること） */
export async function insertAskMessage(
  tx: Tx,
  ctx: WsCtx,
  i: {
    askId: Uuid;
    askRunId: Uuid | null;
    fromMember: Uuid;
    toMember: Uuid | null;
    kind: TeamMessageKind;
    body: string;
    inReplyTo: Uuid | null;
    tainted: boolean;
    fromTaskId: Uuid;
    now: Date;
  },
): Promise<AskMessageRow> {
  const row = await one<{ id: Uuid }>(
    tx,
    `INSERT INTO ask_messages (workspace_id, ask_id, ask_run_id, from_member, to_member, kind, body, in_reply_to, tainted, from_task_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [ctx.workspaceId, i.askId, i.askRunId, i.fromMember, i.toMember, i.kind, i.body, i.inReplyTo, i.tainted, i.fromTaskId, i.now],
  );
  const all = await listAskMessages(tx, ctx, i.askId);
  const found = all.find((m) => m.id === row.id);
  if (!found) throw new Error("連絡を読み戻せなかった");
  return found;
}

// =====================================================================
// 依頼の使った費用（設定プランナーの呼び出しの合計。usage_records.ask_id）
// =====================================================================

export async function sumAskCostUsd(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<string> {
  const r = await one<{ usd: string }>(
    q,
    "SELECT COALESCE(sum(cost_usd), 0)::numeric(16,6)::text AS usd FROM usage_records WHERE workspace_id = $1 AND ask_id = $2",
    [ctx.workspaceId, askId],
  );
  return r.usd;
}

/** 編成を作った設定プランナーの呼び出しの集計（画面の「Gemini（モデル）が編成を作りました · 14秒 · $0.003」用）。呼んでいなければ null */
export interface PlannerUsage {
  model: string;
  calls: number;
  latencyMs: number;
  costUsd: string;
}

export async function plannerUsageOf(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<PlannerUsage | null> {
  const r = await q.query<{ calls: number; latency_ms: number; cost_usd: string; model: string }>(
    `SELECT count(*)::int AS calls,
            COALESCE(sum(latency_ms), 0)::int AS latency_ms,
            COALESCE(sum(cost_usd), 0)::numeric(16,6)::text AS cost_usd,
            (array_agg(model ORDER BY created_at DESC, id DESC))[1] AS model
       FROM usage_records
      WHERE workspace_id = $1 AND ask_id = $2 AND phase = 'planner'`,
    [ctx.workspaceId, askId],
  );
  const row = r.rows[0];
  if (row === undefined || row.calls === 0) return null;
  return { model: row.model, calls: row.calls, latencyMs: row.latency_ms, costUsd: row.cost_usd };
}

/** リハーサルの走行の「悪い日の生成」の費用（phase = rehearsal_generate の合計）。記録がなければ null（呼んでいない・費用を記録していない） */
export async function rehearsalGenerateCostOf(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<{ calls: number; costUsd: string } | null> {
  const r = await q.query<{ calls: number; cost_usd: string }>(
    `SELECT count(*)::int AS calls, COALESCE(sum(cost_usd), 0)::numeric(16,6)::text AS cost_usd
       FROM usage_records WHERE workspace_id = $1 AND rehearsal_run_id = $2 AND phase = 'rehearsal_generate'`,
    [ctx.workspaceId, runId],
  );
  const row = r.rows[0];
  if (row === undefined || row.calls === 0) return null;
  return { calls: row.calls, costUsd: row.cost_usd };
}

// =====================================================================
// 追いのターン（FR-064。A-105）
// =====================================================================

/**
 * 終わった担当の追いのターンのタスクを作る（kind = 'followup'・queued）。同じ仕事・同じスナップショット（同じ境界）、
 * parent_task_id は元のタスク、input_message_ids は答える質問。汚染は親のタスクから始める（呼び出し側が taintOnTeamMessage で質問の分を足して渡す）
 */
export async function insertFollowupTask(
  tx: Tx,
  ctx: WsCtx,
  i: { parent: TaskRow; messageId: Uuid; taint: TaintState; now: Date },
): Promise<TaskRow> {
  const p = i.parent;
  const task = await one<TaskRow>(
    tx,
    `INSERT INTO tasks (workspace_id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, ask_member_id, input_task_ids, input_message_ids,
                        parent_task_id, kind, trigger_type, is_dry_run, execution_variant, prompt, tainted, taint_sources, status, queued_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}', $9::uuid[], $10, 'followup', 'ask', false, 'live', NULL, $11, $12::jsonb, 'queued', $13, $13, $13)
     RETURNING *`,
    [
      ctx.workspaceId,
      p.requester_id,
      p.agent_id,
      p.agent_snapshot_id,
      p.job_id,
      p.ask_id,
      p.ask_run_id,
      p.ask_member_id,
      [i.messageId],
      p.id,
      i.taint.tainted,
      [...i.taint.sources],
      i.now,
    ],
  );
  // 見た URL の集合（SG-04）：汚染を引き継ぐ親のタスクが見た URL を写す（質問の文は担当が書いたものなので入れない）
  await copyTaskWebUrls(tx, ctx, task.id, [p.id], TASK_WEB_URLS_MAX, i.now);
  return task;
}

/** 質問への追いのターンがもう作られているか（同じ質問に2回起こさない） */
export async function hasFollowupForMessage(q: Queryable, ctx: WsCtx, messageId: Uuid): Promise<boolean> {
  const r = await one<{ n: number }>(
    q,
    "SELECT count(*)::int AS n FROM tasks WHERE workspace_id = $1 AND kind = 'followup' AND $2::uuid = ANY(input_message_ids)",
    [ctx.workspaceId, messageId],
  );
  return r.n > 0;
}

/** まだ返事のない質問（受けた担当宛て）。受けた担当のタスクが終わったとき、追いのターンの要否を見る */
export async function listUnansweredQuestionsTo(q: Queryable, ctx: WsCtx, askId: Uuid, memberId: Uuid): Promise<AskMessageRow[]> {
  const all = await listAskMessages(q, ctx, askId);
  return all.filter((m) => m.kind === "question" && m.to_member === memberId && !all.some((r) => r.kind === "reply" && r.in_reply_to === m.id));
}

// ---- エージェントから利用者への質問（agent_questions：0011） ----

/** 担当が ask_user で出した質問を残す（status = open） */
export async function insertAgentQuestion(
  tx: Tx,
  ctx: WsCtx,
  v: {
    askId: Uuid;
    askRunId: Uuid | null;
    taskId: Uuid;
    agentId: Uuid;
    agentName: string;
    question: string;
    choices: ReadonlyArray<{ id: string; label: string }>;
    allowFreeText: boolean;
    now: Date;
  },
): Promise<AgentQuestionRow> {
  const r = await tx.query<AgentQuestionRow>(
    `INSERT INTO agent_questions (workspace_id, ask_id, ask_run_id, task_id, agent_id, agent_name, question, choices, allow_free_text, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [ctx.workspaceId, v.askId, v.askRunId, v.taskId, v.agentId, v.agentName, v.question, v.choices.map((c) => ({ id: c.id, label: c.label })), v.allowFreeText, v.now],
  );
  return r.rows[0]!;
}

export async function getAgentQuestion(q: Queryable, ctx: WsCtx, questionId: Uuid): Promise<AgentQuestionRow | null> {
  const r = await q.query<AgentQuestionRow>("SELECT * FROM agent_questions WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, questionId]);
  return r.rows[0] ?? null;
}

/** 依頼の質問（古い順） */
export async function listAgentQuestions(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<AgentQuestionRow[]> {
  const r = await q.query<AgentQuestionRow>("SELECT * FROM agent_questions WHERE workspace_id = $1 AND ask_id = $2 ORDER BY created_at, id", [ctx.workspaceId, askId]);
  return r.rows;
}

/** 答える（open のときだけ）。答えた行を返す。もう答えた・時間切れなら null */
export async function answerAgentQuestion(tx: Tx, ctx: WsCtx, questionId: Uuid, v: { answer: string; userId: Uuid | null; now: Date }): Promise<AgentQuestionRow | null> {
  const r = await tx.query<AgentQuestionRow>(
    `UPDATE agent_questions SET status = 'answered', answer = $3, answered_by = $4, answered_at = $5
      WHERE id = $2 AND workspace_id = $1 AND status = 'open' RETURNING *`,
    [ctx.workspaceId, questionId, v.answer, v.userId, v.now],
  );
  return r.rows[0] ?? null;
}

/** 待ちを終える（open のときだけ expired にする）。もう答えていたら null */
export async function expireAgentQuestion(q: Queryable, ctx: WsCtx, questionId: Uuid): Promise<AgentQuestionRow | null> {
  const r = await q.query<AgentQuestionRow>(
    "UPDATE agent_questions SET status = 'expired' WHERE id = $2 AND workspace_id = $1 AND status = 'open' RETURNING *",
    [ctx.workspaceId, questionId],
  );
  return r.rows[0] ?? null;
}

/** 終わったタスクの、まだ開いている質問を閉じる（待っている担当がいない質問を画面に残さない） */
export async function expireQuestionsOfTask(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<number> {
  const r = await q.query("UPDATE agent_questions SET status = 'expired' WHERE workspace_id = $1 AND task_id = $2 AND status = 'open'", [ctx.workspaceId, taskId]);
  return r.rowCount;
}

// ---- 順番待ちの返事（0020。動いている間に送った返事を、実行が終わってから古い順に1つずつ始める） ----

/** 順番待ちに入れる（呼ぶ側がワークスペースの行ロックの中で、動いている実行があることを確かめてから） */
export async function insertPendingReply(tx: Tx, ctx: WsCtx, askId: Uuid, v: { text: string; requesterId: Uuid; now: Date }): Promise<AskPendingReplyRow> {
  return one<AskPendingReplyRow>(
    tx,
    `INSERT INTO ask_pending_replies (workspace_id, ask_id, text, requester_id, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [ctx.workspaceId, askId, v.text, v.requesterId, v.now],
  );
}

/** 未消化の順番待ちの返事（古い順） */
export async function listPendingReplies(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<AskPendingReplyRow[]> {
  const r = await q.query<AskPendingReplyRow>(
    "SELECT * FROM ask_pending_replies WHERE workspace_id = $1 AND ask_id = $2 AND consumed_at IS NULL ORDER BY created_at, id",
    [ctx.workspaceId, askId],
  );
  return r.rows;
}

/** いちばん古い未消化の返事（消化はしない。ワークスペースの行ロックの中で、実行を始められたあとに markPendingReplyConsumed で印を付ける） */
export async function peekPendingReply(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<AskPendingReplyRow | null> {
  return maybe<AskPendingReplyRow>(
    q,
    "SELECT * FROM ask_pending_replies WHERE workspace_id = $1 AND ask_id = $2 AND consumed_at IS NULL ORDER BY created_at, id LIMIT 1",
    [ctx.workspaceId, askId],
  );
}

/** 消化の印を付ける（未消化のときだけ。付けられなければ false＝ほかが先に始めた） */
export async function markPendingReplyConsumed(tx: Tx, ctx: WsCtx, replyId: Uuid, now: Date): Promise<boolean> {
  const r = await tx.query("UPDATE ask_pending_replies SET consumed_at = $3 WHERE workspace_id = $1 AND id = $2 AND consumed_at IS NULL", [ctx.workspaceId, replyId, now]);
  return r.rowCount > 0;
}

/** 動いている本番の実行があるか（running・waiting_input。insertLiveRun と同じ判定） */
export async function hasActiveLiveRun(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<boolean> {
  const r = await q.query("SELECT 1 FROM ask_runs WHERE workspace_id = $1 AND ask_id = $2 AND mode = 'live' AND status IN ('running','waiting_input') LIMIT 1", [ctx.workspaceId, askId]);
  return r.rowCount > 0;
}
