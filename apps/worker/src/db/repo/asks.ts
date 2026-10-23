// 依頼（asks）の問い合わせ（packages/db/src/repo/asks.ts の WorkspaceDO 版。設定プランナー FR-061・編成の実行 FR-062・回答 FR-063・連絡板 FR-064・API-072〜077）。
// 業務の関数は (db: WsDb, …) の同期の関数。workspace_id で絞る代わりに、DO そのものがワークスペース。
// 読んで判断して書く関数は db.transaction(() => …) で包む。トランザクションの中で外部（Gemini・gateway）を呼ばない（G-14）。
// ロックの順（M-21）は要らない（DO の中は1本の流れ）。本番のタスクを作るのは insertAskTask だけ（trigger_type = 'ask'）。
// 金額は整数のマイクロドル（*MicroUsd）

import type { Hex64, Json, JsonObject, TaintState } from "@open-team/kernel";
import { CODECS } from "../codecs.ts";
import { all, count, newId, one, run, type WsDb } from "../sqlite.ts";
import type {
  AgentJobRow,
  AgentQuestionRow,
  AgentRow,
  AgentSnapshotRow,
  AskFailureReason,
  AskMemberRow,
  AskPendingReplyRow,
  AskRow,
  AskRunRow,
  AskRunStatus,
  AskRunTrigger,
  AskShape,
  AskStatus,
  AskTrigger,
  EffectivePolicies,
  MicroUsd,
  TaskRow,
  TeamMessageKind,
  Uuid,
} from "../types.ts";
import { addTaskWebUrls, copyTaskWebUrls, TASK_WEB_URLS_MAX } from "./web-urls.ts";

/** 書いた行（RETURNING）。なければ例外 */
function written<T>(row: T | null, query: string): T {
  if (!row) throw new Error(`行を書けなかった：${query.trim().slice(0, 60)}`);
  return row;
}

// =====================================================================
// 依頼
// =====================================================================

const ASK_COLS = `id, created_by, text, mention_agent_id, pack_id, shape, status, "trigger", next_run_at, formation, planner_attempts,
  question, question_answer, failure_reason, seed_key, created_at, updated_at, finished_at`;

export function getAsk(db: WsDb, askId: Uuid): AskRow | null {
  return one<AskRow>(db, CODECS.asks, `SELECT ${ASK_COLS} FROM asks WHERE id = ?`, askId);
}

/** 新しい順の一覧（入口 SCR-020 用） */
export function listAsks(db: WsDb, o: { limit: number; status?: AskStatus }): AskRow[] {
  return all<AskRow>(
    db,
    CODECS.asks,
    `SELECT ${ASK_COLS} FROM asks WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
    o.status ?? null,
    o.status ?? null,
    o.limit,
  );
}

/**
 * 依頼を生成中（generating）で作る（FR-061 の処理1）。担当の指定（mention）は作る前に引いた agent の id。
 * packId はパックの作業場から出した依頼のとき、入っていると確かめたパックの id（0018。省略は null）
 */
export function insertGeneratingAsk(
  db: WsDb,
  i: { createdBy: Uuid; text: string; mentionAgentId: Uuid | null; packId?: string | null; now: Date },
): AskRow {
  const q = `INSERT INTO asks (id, created_by, text, mention_agent_id, pack_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'generating', ?, ?) RETURNING ${ASK_COLS}`;
  return written(one<AskRow>(db, CODECS.asks, q, newId(), i.createdBy, i.text, i.mentionAgentId, i.packId ?? null, i.now, i.now), q);
}

/** 設定プランナーを呼んだ回数を足す（上限3：DB の CHECK）。generating のときだけ */
export function bumpPlannerAttempts(db: WsDb, askId: Uuid, by: number, now: Date): void {
  run(
    db,
    "UPDATE asks SET planner_attempts = min(3, planner_attempts + ?), updated_at = ? WHERE id = ? AND status = 'generating'",
    by,
    now,
    askId,
  );
}

/** 質問を1つ載せる（生成中のまま。BR-49：すでに質問があれば載せない＝false） */
export function setAskQuestion(
  db: WsDb,
  askId: Uuid,
  question: { text: string; choices: Array<{ id: string; label: string }>; allowFreeText: boolean },
  now: Date,
): boolean {
  return (
    run(db, "UPDATE asks SET question = ?, updated_at = ? WHERE id = ? AND status = 'generating' AND question IS NULL", question, now, askId) > 0
  );
}

/** 質問への答えを保存する（質問が出ていて、まだ答えていない生成中の依頼だけ） */
export function setAskQuestionAnswer(db: WsDb, askId: Uuid, answer: string, now: Date): AskRow | null {
  return one<AskRow>(
    db,
    CODECS.asks,
    `UPDATE asks SET question_answer = ?, updated_at = ?
      WHERE id = ? AND status = 'generating' AND question IS NOT NULL AND question_answer IS NULL
      RETURNING ${ASK_COLS}`,
    answer,
    now,
    askId,
  );
}

/** 編成ができた：generating → running（CAS。時間切れ・取り消しなどで先に閉じられていれば null） */
export function markAskFormed(
  db: WsDb,
  askId: Uuid,
  i: { shape: AskShape; formation: JsonObject; trigger: AskTrigger | null; nextRunAt: Date | null; now: Date },
): AskRow | null {
  return one<AskRow>(
    db,
    CODECS.asks,
    `UPDATE asks SET shape = ?, formation = ?, "trigger" = ?, next_run_at = ?, status = 'running', updated_at = ?
      WHERE id = ? AND status = 'generating' RETURNING ${ASK_COLS}`,
    i.shape,
    i.formation,
    i.trigger ? { ...i.trigger } : null,
    i.nextRunAt,
    i.now,
    askId,
  );
}

/** 生成に失敗した：generating → failed（CAS。すでに閉じていれば null） */
export function markAskGenerationFailed(db: WsDb, askId: Uuid, reason: AskFailureReason, now: Date): AskRow | null {
  return one<AskRow>(
    db,
    CODECS.asks,
    `UPDATE asks SET status = 'failed', failure_reason = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND status = 'generating' RETURNING ${ASK_COLS}`,
    reason,
    now,
    now,
    askId,
  );
}

/** 実行の状態に合わせて依頼の状態を変える（from のどれかのときだけ。変えたら行を返す） */
export function transitionAsk(db: WsDb, askId: Uuid, from: readonly AskStatus[], to: AskStatus, now: Date): AskRow | null {
  const finished = to === "done" || to === "failed" || to === "cancelled";
  return one<AskRow>(
    db,
    CODECS.asks,
    `UPDATE asks SET status = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND status IN (SELECT value FROM json_each(?)) RETURNING ${ASK_COLS}`,
    to,
    now,
    finished ? now : null,
    askId,
    from,
  );
}

/** 次の実行の時刻を進める（定期の依頼） */
export function setAskNextRun(db: WsDb, askId: Uuid, nextRunAt: Date | null, now: Date): void {
  run(db, `UPDATE asks SET next_run_at = ?, updated_at = ? WHERE id = ? AND "trigger" IS NOT NULL`, nextRunAt, now, askId);
}

// =====================================================================
// 編成の材料（設定プランナーに渡すもの）
// =====================================================================

export interface PlannerAgentRow {
  agent: AgentRow;
  jobCount: number;
  definition: JsonObject | null;
}

const AGENT_COLS_A = `a.id, a.slug, a.name, a.name_source, a.role, a.appearance, a.status, a.current_snapshot_id, a.disabled_by,
  a.disabled_reason, a.disabled_at, a.created_at, a.updated_at`;

/**
 * 外してよい仕事（j）の条件：1回きりの仕事で、その依頼が終わった（done・failed・cancelled）もの。
 * 担当の仕事は10個まで（A-81）なので、仕事を足すときにこれを古い順に外して空きを作る（外した仕事は status = done）
 */
const FINISHED_ONCE_JOB = `j.kind = 'once' AND EXISTS (
  SELECT 1 FROM ask_members fm JOIN asks fk ON fk.id = fm.ask_id WHERE fm.job_id = j.id AND fk.status IN ('done', 'failed', 'cancelled'))`;

/** ワークスペースのエージェントと、仕事の数（外した・外してよい仕事は数えない）・今のスナップショットの定義（removed も含む：名前の重なりを見るため） */
export function listAgentsForPlanner(db: WsDb): PlannerAgentRow[] {
  const rows = all<AgentRow & { job_count: number; definition: JsonObject | null }>(
    db,
    { ...CODECS.agents, definition: "json" },
    `SELECT ${AGENT_COLS_A},
            (SELECT count(*) FROM agent_jobs j WHERE j.agent_id = a.id AND j.status <> 'done' AND NOT (${FINISHED_ONCE_JOB})) AS job_count,
            s.definition
       FROM agents a
       LEFT JOIN agent_snapshots s ON s.id = a.current_snapshot_id
      ORDER BY a.created_at, a.id`,
  );
  return rows.map(({ job_count, definition, ...agent }) => ({ agent, jobCount: job_count, definition }));
}

/** 担当の外してよい仕事（まだ外していないもの。古い順） */
export function listFinishedOnceJobs(db: WsDb, agentId: Uuid): AgentJobRow[] {
  return all<AgentJobRow>(
    db,
    CODECS.agent_jobs,
    `SELECT j.* FROM agent_jobs j WHERE j.agent_id = ? AND j.status <> 'done' AND ${FINISHED_ONCE_JOB} ORDER BY j.created_at, j.id`,
    agentId,
  );
}

/** 仕事を外した印を付ける（status = done） */
export function markJobsDone(db: WsDb, jobIds: readonly Uuid[], now: Date): void {
  for (const id of jobIds) run(db, "UPDATE agent_jobs SET status = 'done', updated_at = ? WHERE id = ?", now, id);
}

/** 担当を名前か ID で引く（removed を除く） */
export function findLiveAgentByIdOrName(db: WsDb, key: string): AgentRow | null {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const id = isUuid ? key.toLowerCase() : "00000000-0000-0000-0000-000000000000";
  return one<AgentRow>(
    db,
    CODECS.agents,
    `SELECT ${AGENT_COLS_A} FROM agents a WHERE a.status <> 'removed' AND (a.id = ? OR a.name = ?)
      ORDER BY (a.id = ?) DESC LIMIT 1`,
    id,
    isUuid ? "" : key,
    id,
  );
}

const SNAPSHOT_COLS = `id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version,
  errors, warnings, created_at`;

/** 既存の担当に新しいスナップショットを足して今のものにする（依頼の仕事を足すとき。UPDATE 禁止の表なので足すだけ） */
export function appendAgentSnapshot(
  db: WsDb,
  i: {
    agentId: Uuid;
    definition: JsonObject;
    effectivePolicies: EffectivePolicies;
    clamped: Json[];
    ceilingsVersion: string;
    now: Date;
  },
): AgentSnapshotRow {
  return db.transaction(() => {
    const q = `INSERT INTO agent_snapshots (id, agent_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
       VALUES (?, ?, 'in_app', 'valid', ?, ?, ?, ?, ?) RETURNING ${SNAPSHOT_COLS}`;
    const snapshot = written(
      one<AgentSnapshotRow>(db, CODECS.agent_snapshots, q, newId(), i.agentId, i.definition, i.effectivePolicies, i.clamped, i.ceilingsVersion, i.now),
      q,
    );
    run(db, "UPDATE agents SET current_snapshot_id = ?, updated_at = ? WHERE id = ?", snapshot.id, i.now, i.agentId);
    return snapshot;
  });
}

// =====================================================================
// 実行（ask_runs）
// =====================================================================

const RUN_COLS = `id, ask_id, run_no, trigger_type, status, answer_task_id, answer,
  answer_hash, answered_at, first_member_started_at, started_at, finished_at`;

/** 実行を始める。同じ依頼で動いている実行があれば作らず null */
export function insertLiveRun(db: WsDb, askId: Uuid, triggerType: AskRunTrigger, now: Date): AskRunRow | null {
  return db.transaction(() => {
    if (hasActiveLiveRun(db, askId)) return null;
    const q = `INSERT INTO ask_runs (id, ask_id, run_no, trigger_type, status, started_at)
       VALUES (?, ?, COALESCE((SELECT max(run_no) FROM ask_runs WHERE ask_id = ?), 0) + 1, ?, 'running', ?)
       RETURNING ${RUN_COLS}`;
    return written(one<AskRunRow>(db, CODECS.ask_runs, q, newId(), askId, askId, triggerType, now), q);
  });
}

export function getAskRun(db: WsDb, runId: Uuid): AskRunRow | null {
  return one<AskRunRow>(db, CODECS.ask_runs, `SELECT ${RUN_COLS} FROM ask_runs WHERE id = ?`, runId);
}

/** 本番の最新の実行 */
export function getLatestLiveRun(db: WsDb, askId: Uuid): AskRunRow | null {
  return one<AskRunRow>(db, CODECS.ask_runs, `SELECT ${RUN_COLS} FROM ask_runs WHERE ask_id = ? ORDER BY run_no DESC LIMIT 1`, askId);
}

/**
 * 本番の実行の履歴（新しい順に limit 件。画面は古い順に並べ直す）。
 * 依頼のページの「頼んだこと → 回答」の対応に使う（返事のたびに実行が1つ増える）
 */
export function listLiveRuns(db: WsDb, askId: Uuid, limit: number): AskRunRow[] {
  return all<AskRunRow>(db, CODECS.ask_runs, `SELECT ${RUN_COLS} FROM ask_runs WHERE ask_id = ? ORDER BY run_no DESC LIMIT ?`, askId, limit);
}

/**
 * 実行ごとに、担当に渡した「お願い」の文（最初に作った担当のタスクの prompt。返事の実行は返事の文）。
 * prompt のない実行（用意した依頼の種など）は入らない。追いのターン（kind = followup）は数えない
 */
export function firstPromptsOfRuns(db: WsDb, runIds: readonly Uuid[]): Map<Uuid, string> {
  if (runIds.length === 0) return new Map();
  const rows = all<{ ask_run_id: Uuid; prompt: string }>(
    db,
    {},
    `SELECT ask_run_id, prompt FROM (
       SELECT ask_run_id, prompt, row_number() OVER (PARTITION BY ask_run_id ORDER BY created_at, id) AS rn
         FROM tasks
        WHERE ask_run_id IN (SELECT value FROM json_each(?)) AND kind = 'normal' AND prompt IS NOT NULL
     ) WHERE rn = 1`,
    runIds,
  );
  return new Map(rows.map((row) => [row.ask_run_id, row.prompt]));
}

/** 実行の状態を変える（from のどれかのときだけ） */
export function transitionRun(db: WsDb, runId: Uuid, from: readonly AskRunStatus[], to: AskRunStatus, now: Date): AskRunRow | null {
  const finished = to === "done" || to === "failed" || to === "cancelled";
  return one<AskRunRow>(
    db,
    CODECS.ask_runs,
    `UPDATE ask_runs SET status = ?, finished_at = ?
      WHERE id = ? AND status IN (SELECT value FROM json_each(?)) RETURNING ${RUN_COLS}`,
    to,
    finished ? now : null,
    runId,
    from,
  );
}

/** 最初の担当が始まった時刻（A-100 のまとめ役の待ち時間の起点）。入っていれば変えない */
export function markFirstMemberStarted(db: WsDb, runId: Uuid, now: Date): void {
  run(db, "UPDATE ask_runs SET first_member_started_at = ? WHERE id = ? AND first_member_started_at IS NULL", now, runId);
}

/** 回答を保存する。最初の1回で answered_at を入れ、2回目以降（手が要るものの行の書き換え）は answered_at を変えない */
export function saveRunAnswer(
  db: WsDb,
  runId: Uuid,
  i: { answerTaskId: Uuid | null; answer: JsonObject; answerHash: Hex64; now: Date },
): AskRunRow | null {
  return one<AskRunRow>(
    db,
    CODECS.ask_runs,
    `UPDATE ask_runs SET answer_task_id = ?, answer = ?, answer_hash = ?, answered_at = COALESCE(answered_at, ?)
      WHERE id = ? RETURNING ${RUN_COLS}`,
    i.answerTaskId,
    i.answer,
    i.answerHash,
    i.now,
    runId,
  );
}

/** 動いている本番の実行（alarm の拾い直し用） */
export function listActiveLiveRuns(db: WsDb): AskRunRow[] {
  return all<AskRunRow>(db, CODECS.ask_runs, `SELECT ${RUN_COLS} FROM ask_runs WHERE status IN ('running','waiting_input') ORDER BY started_at`);
}

// =====================================================================
// 担当・タスク
// =====================================================================

export function listMembers(db: WsDb, askId: Uuid): Array<AskMemberRow & { agent_name: string }> {
  return all<AskMemberRow & { agent_name: string }>(
    db,
    CODECS.ask_members,
    `SELECT m.id, m.ask_id, m.agent_id, m.job_id, m.position, m.depends_on, m.is_aggregator, m.is_spokesperson, m.is_new, m.summary,
            m.created_at, a.name AS agent_name
       FROM ask_members m JOIN agents a ON a.id = m.agent_id
      WHERE m.ask_id = ?
      ORDER BY m.is_aggregator, m.position NULLS LAST, m.created_at, m.id`,
    askId,
  );
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
   * 入力の並べ方にかかわらず確実に写すために渡す（copyTaskWebUrls）
   */
  inheritWebUrlsFrom?: readonly Uuid[];
  now: Date;
}

/**
 * 依頼のタスクを作る（trigger_type = 'ask'・queued）。
 * 担当に今のスナップショットを固定する（agent_snapshot_id は呼び出し側が現在のものを渡す）
 */
export function insertAskTask(db: WsDb, i: InsertAskTaskInput): TaskRow {
  return db.transaction(() => {
    const q = `INSERT INTO tasks (id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, ask_member_id, input_task_ids,
                          trigger_type, is_dry_run, prompt, tainted, taint_sources, status, queued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ask', 0, ?, ?, ?, 'queued', ?, ?, ?)
       RETURNING *`;
    const task = written(
      one<TaskRow>(
        db,
        CODECS.tasks,
        q,
        newId(),
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
        i.now,
        i.now,
      ),
      q,
    );
    // 見た URL の集合（SG-04）：利用者の文の URL を先に、受け渡しの元のタスク（汚染を引き継ぐ元）が見た URL を後に
    addTaskWebUrls(db, task.id, i.userWebUrlHashes ?? [], TASK_WEB_URLS_MAX, i.now);
    copyTaskWebUrls(db, task.id, [...new Set([...i.inputTaskIds, ...(i.inheritWebUrlsFrom ?? [])])], TASK_WEB_URLS_MAX, i.now);
    return task;
  });
}

/** 実行のタスク（古い順）。同じ担当のやり直しは新しいタスクが後ろに並ぶ */
export function listRunTasks(db: WsDb, runId: Uuid): TaskRow[] {
  return all<TaskRow>(db, CODECS.tasks, "SELECT * FROM tasks WHERE ask_run_id = ? ORDER BY created_at, id", runId);
}

/**
 * 担当の前の回の報告（定期の見張りで「前回の報告」として渡す）。この実行より前の実行の、報告のある通常のタスクのうち最も新しいもの。
 */
export function getPreviousReportTask(db: WsDb, memberId: Uuid, currentRunId: Uuid): TaskRow | null {
  return one<TaskRow>(
    db,
    CODECS.tasks,
    `SELECT t.* FROM tasks t
       JOIN ask_runs r ON r.id = t.ask_run_id
      WHERE t.ask_member_id = ? AND t.ask_run_id <> ? AND t.kind = 'normal' AND t.report IS NOT NULL
      ORDER BY r.run_no DESC, t.created_at DESC, t.id DESC
      LIMIT 1`,
    memberId,
    currentRunId,
  );
}

/**
 * queued のタスクを動かす側が取る（queued → provisioning。取れたのは1か所だけ：同じタスクを2か所で動かさない）。
 * 取れなければ null（すでに動いている・終わっている）
 */
export function claimQueuedTask(db: WsDb, taskId: Uuid, now: Date): TaskRow | null {
  return one<TaskRow>(db, CODECS.tasks, "UPDATE tasks SET status = 'provisioning', updated_at = ? WHERE id = ? AND status = 'queued' RETURNING *", now, taskId);
}

/** 依頼の動いているタスク（取り消しの確認用） */
export function countOpenRunTasks(db: WsDb, runId: Uuid): number {
  return count(
    db,
    `SELECT count(*) FROM tasks
      WHERE ask_run_id = ? AND status NOT IN ('succeeded','completed','rejected','failed','cancelled','halted')`,
    runId,
  );
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
export function countRejectedIntentsOfTasks(db: WsDb, taskIds: readonly Uuid[]): Map<Uuid, number> {
  if (taskIds.length === 0) return new Map();
  const rows = all<{ task_id: Uuid; n: number }>(
    db,
    {},
    `SELECT task_id, count(*) AS n FROM action_intents
      WHERE task_id IN (SELECT value FROM json_each(?)) AND status = 'rejected'
      GROUP BY task_id`,
    taskIds,
  );
  return new Map(rows.map((x) => [x.task_id, x.n] as const));
}

/**
 * 担当ごとの「この依頼より前の依頼」の数（依頼のページの段：いつもの担当 · 前の依頼 N件でも働きました）。
 * before の依頼（askId）は除き、作られた時刻が before.createdAt より前のものだけ数える。なければ Map に入らない
 */
export function countPriorAsksOfAgents(db: WsDb, agentIds: readonly Uuid[], before: { askId: Uuid; createdAt: Date }): Map<Uuid, number> {
  if (agentIds.length === 0) return new Map();
  const rows = all<{ agent_id: Uuid; n: number }>(
    db,
    {},
    `SELECT m.agent_id, count(DISTINCT m.ask_id) AS n
       FROM ask_members m JOIN asks k ON k.id = m.ask_id
      WHERE m.agent_id IN (SELECT value FROM json_each(?)) AND m.ask_id <> ? AND k.created_at < ?
      GROUP BY m.agent_id`,
    agentIds,
    before.askId,
    before.createdAt,
  );
  return new Map(rows.map((x) => [x.agent_id, x.n] as const));
}

export interface ToolActivityRow {
  task_id: Uuid;
  action: string | null;
  decision: string;
  created_at: Date;
}

/** タスクごとのツールの呼び出しの判定（policy_decisions の tool_call）。新しいものから perTask 件まで、古い順に返す（依頼のページの「やったこと」） */
export function listToolActivityOfTasks(db: WsDb, taskIds: readonly Uuid[], perTask: number): ToolActivityRow[] {
  if (taskIds.length === 0) return [];
  return all<ToolActivityRow>(
    db,
    { created_at: "date" },
    `SELECT task_id, action, decision, created_at FROM (
       SELECT task_id,
              COALESCE(json_extract(subject, '$.action'), json_extract(subject, '$.actionType'), json_extract(subject, '$.call.name')) AS action,
              decision, created_at, id,
              row_number() OVER (PARTITION BY task_id ORDER BY created_at DESC, id DESC) AS rn
         FROM policy_decisions
        WHERE task_id IN (SELECT value FROM json_each(?)) AND subject_kind = 'tool_call'
     ) d
     WHERE rn <= ?
     ORDER BY task_id, created_at, id`,
    taskIds,
    perTask,
  );
}

/** タスクの承認待ちの Intent（pending_approval）。承認の行（pending）があれば付ける */
export function listPendingIntentsOfTasks(db: WsDb, taskIds: readonly Uuid[]): PendingIntentRow[] {
  if (taskIds.length === 0) return [];
  return all<PendingIntentRow>(
    db,
    { taint_snapshot: "json", created_at: "date" },
    `SELECT i.id AS intent_id, ap.id AS approval_id, i.task_id, a.name AS agent_name, i.action, i.intent_hash, i.taint_snapshot, i.created_at
       FROM action_intents i
       JOIN tasks t ON t.id = i.task_id
       JOIN agents a ON a.id = t.agent_id
       LEFT JOIN approvals ap ON ap.intent_id = i.id AND ap.status = 'pending'
      WHERE i.task_id IN (SELECT value FROM json_each(?)) AND i.status = 'pending_approval'
      ORDER BY i.created_at, i.id`,
    taskIds,
  );
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

const ASK_MESSAGE_SELECT = `SELECT m.id, m.ask_id, m.ask_run_id, m.from_member, fa.name AS from_agent_name, m.to_member, ta.name AS to_agent_name,
          m.kind, m.body, m.in_reply_to, m.tainted, m.from_task_id, m.created_at
     FROM ask_messages m
     JOIN ask_members fm ON fm.id = m.from_member
     JOIN agents fa ON fa.id = fm.agent_id
     LEFT JOIN ask_members tm ON tm.id = m.to_member
     LEFT JOIN agents ta ON ta.id = tm.agent_id`;

/** 受け付けた連絡（rejected_reason が空のもの）を古い順に */
export function listAskMessages(db: WsDb, askId: Uuid): AskMessageRow[] {
  return all<AskMessageRow>(
    db,
    CODECS.ask_messages,
    `${ASK_MESSAGE_SELECT} WHERE m.ask_id = ? AND m.rejected_reason IS NULL ORDER BY m.created_at, m.id`,
    askId,
  );
}

export function countAskMessages(db: WsDb, askId: Uuid): number {
  return count(db, "SELECT count(*) FROM ask_messages WHERE ask_id = ? AND rejected_reason IS NULL", askId);
}

/** 連絡を保存する（本文はマスク済みを渡す。検査は kernel の validateTeamMessage が済んでいること） */
export function insertAskMessage(
  db: WsDb,
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
): AskMessageRow {
  return db.transaction(() => {
    const id = newId();
    run(
      db,
      `INSERT INTO ask_messages (id, ask_id, ask_run_id, from_member, to_member, kind, body, in_reply_to, tainted, from_task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      i.askId,
      i.askRunId,
      i.fromMember,
      i.toMember,
      i.kind,
      i.body,
      i.inReplyTo,
      i.tainted,
      i.fromTaskId,
      i.now,
    );
    const found = one<AskMessageRow>(db, CODECS.ask_messages, `${ASK_MESSAGE_SELECT} WHERE m.id = ?`, id);
    if (!found) throw new Error("連絡を読み戻せなかった");
    return found;
  });
}

// =====================================================================
// 依頼の使った費用（設定プランナーの呼び出しの合計。usage_records.ask_id）。整数のマイクロドル
// =====================================================================

export function sumAskCostMicroUsd(db: WsDb, askId: Uuid): MicroUsd {
  return count(db, "SELECT COALESCE(sum(cost_micro_usd), 0) FROM usage_records WHERE ask_id = ?", askId);
}

/** 編成を作った設定プランナーの呼び出しの集計（画面の「Gemini（モデル）が編成を作りました · 14秒 · $0.003」用）。呼んでいなければ null */
export interface PlannerUsage {
  model: string;
  calls: number;
  latencyMs: number;
  costMicroUsd: MicroUsd;
}

export function plannerUsageOf(db: WsDb, askId: Uuid): PlannerUsage | null {
  const row = one<{ calls: number; latency_ms: number; cost_micro_usd: number; model: string | null }>(
    db,
    {},
    `SELECT count(*) AS calls,
            COALESCE(sum(latency_ms), 0) AS latency_ms,
            COALESCE(sum(cost_micro_usd), 0) AS cost_micro_usd,
            (SELECT model FROM usage_records WHERE ask_id = ? AND phase = 'planner' ORDER BY created_at DESC, id DESC LIMIT 1) AS model
       FROM usage_records
      WHERE ask_id = ? AND phase = 'planner'`,
    askId,
    askId,
  );
  if (row === null || row.calls === 0 || row.model === null) return null;
  return { model: row.model, calls: row.calls, latencyMs: row.latency_ms, costMicroUsd: row.cost_micro_usd };
}

// =====================================================================
// 追いのターン（FR-064。A-105）
// =====================================================================

/**
 * 終わった担当の追いのターンのタスクを作る（kind = 'followup'・queued）。同じ仕事・同じスナップショット（同じ境界）、
 * parent_task_id は元のタスク、input_message_ids は答える質問。汚染は親のタスクから始める（呼び出し側が taintOnTeamMessage で質問の分を足して渡す）
 */
export function insertFollowupTask(db: WsDb, i: { parent: TaskRow; messageId: Uuid; taint: TaintState; now: Date }): TaskRow {
  const p = i.parent;
  return db.transaction(() => {
    const q = `INSERT INTO tasks (id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, ask_member_id, input_task_ids, input_message_ids,
                          parent_task_id, kind, trigger_type, is_dry_run, prompt, tainted, taint_sources, status, queued_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'followup', 'ask', 0, NULL, ?, ?, 'queued', ?, ?, ?)
       RETURNING *`;
    const task = written(
      one<TaskRow>(
        db,
        CODECS.tasks,
        q,
        newId(),
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
        i.now,
        i.now,
      ),
      q,
    );
    // 見た URL の集合（SG-04）：汚染を引き継ぐ親のタスクが見た URL を写す（質問の文は担当が書いたものなので入れない）
    copyTaskWebUrls(db, task.id, [p.id], TASK_WEB_URLS_MAX, i.now);
    return task;
  });
}

/** 質問への追いのターンがもう作られているか（同じ質問に2回起こさない） */
export function hasFollowupForMessage(db: WsDb, messageId: Uuid): boolean {
  return (
    one(
      db,
      {},
      `SELECT 1 AS ok FROM tasks t
        WHERE t.kind = 'followup' AND EXISTS (SELECT 1 FROM json_each(t.input_message_ids) WHERE value = ?)
        LIMIT 1`,
      messageId,
    ) !== null
  );
}

/** まだ返事のない質問（受けた担当宛て）。受けた担当のタスクが終わったとき、追いのターンの要否を見る */
export function listUnansweredQuestionsTo(db: WsDb, askId: Uuid, memberId: Uuid): AskMessageRow[] {
  const msgs = listAskMessages(db, askId);
  return msgs.filter((m) => m.kind === "question" && m.to_member === memberId && !msgs.some((r) => r.kind === "reply" && r.in_reply_to === m.id));
}

// ---- エージェントから利用者への質問（agent_questions：0011） ----

/** 担当が ask_user で出した質問を残す（status = open） */
export function insertAgentQuestion(
  db: WsDb,
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
): AgentQuestionRow {
  const q = `INSERT INTO agent_questions (id, ask_id, ask_run_id, task_id, agent_id, agent_name, question, choices, allow_free_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`;
  return written(
    one<AgentQuestionRow>(
      db,
      CODECS.agent_questions,
      q,
      newId(),
      v.askId,
      v.askRunId,
      v.taskId,
      v.agentId,
      v.agentName,
      v.question,
      v.choices.map((c) => ({ id: c.id, label: c.label })),
      v.allowFreeText,
      v.now,
    ),
    q,
  );
}

export function getAgentQuestion(db: WsDb, questionId: Uuid): AgentQuestionRow | null {
  return one<AgentQuestionRow>(db, CODECS.agent_questions, "SELECT * FROM agent_questions WHERE id = ?", questionId);
}

/** 依頼の質問（古い順） */
export function listAgentQuestions(db: WsDb, askId: Uuid): AgentQuestionRow[] {
  return all<AgentQuestionRow>(db, CODECS.agent_questions, "SELECT * FROM agent_questions WHERE ask_id = ? ORDER BY created_at, id", askId);
}

/** 答える（open のときだけ）。答えた行を返す。もう答えた・時間切れなら null */
export function answerAgentQuestion(db: WsDb, questionId: Uuid, v: { answer: string; userId: Uuid | null; now: Date }): AgentQuestionRow | null {
  return one<AgentQuestionRow>(
    db,
    CODECS.agent_questions,
    `UPDATE agent_questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?
      WHERE id = ? AND status = 'open' RETURNING *`,
    v.answer,
    v.userId,
    v.now,
    questionId,
  );
}

/** 待ちを終える（open のときだけ expired にする）。もう答えていたら null */
export function expireAgentQuestion(db: WsDb, questionId: Uuid): AgentQuestionRow | null {
  return one<AgentQuestionRow>(
    db,
    CODECS.agent_questions,
    "UPDATE agent_questions SET status = 'expired' WHERE id = ? AND status = 'open' RETURNING *",
    questionId,
  );
}

/** 終わったタスクの、まだ開いている質問を閉じる（待っている担当がいない質問を画面に残さない） */
export function expireQuestionsOfTask(db: WsDb, taskId: Uuid): number {
  return run(db, "UPDATE agent_questions SET status = 'expired' WHERE task_id = ? AND status = 'open'", taskId);
}

// ---- 順番待ちの返事（0020。動いている間に送った返事を、実行が終わってから古い順に1つずつ始める） ----

/** 順番待ちに入れる（呼ぶ側が同じトランザクションの中で、動いている実行があることを確かめてから） */
export function insertPendingReply(db: WsDb, askId: Uuid, v: { text: string; requesterId: Uuid; now: Date }): AskPendingReplyRow {
  const q = "INSERT INTO ask_pending_replies (id, ask_id, text, requester_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *";
  return written(one<AskPendingReplyRow>(db, CODECS.ask_pending_replies, q, newId(), askId, v.text, v.requesterId, v.now), q);
}

/** 未消化の順番待ちの返事（古い順） */
export function listPendingReplies(db: WsDb, askId: Uuid): AskPendingReplyRow[] {
  return all<AskPendingReplyRow>(
    db,
    CODECS.ask_pending_replies,
    "SELECT * FROM ask_pending_replies WHERE ask_id = ? AND consumed_at IS NULL ORDER BY created_at, id",
    askId,
  );
}

/** いちばん古い未消化の返事（消化はしない。実行を始められたあとに、同じトランザクションで markPendingReplyConsumed で印を付ける） */
export function peekPendingReply(db: WsDb, askId: Uuid): AskPendingReplyRow | null {
  return one<AskPendingReplyRow>(
    db,
    CODECS.ask_pending_replies,
    "SELECT * FROM ask_pending_replies WHERE ask_id = ? AND consumed_at IS NULL ORDER BY created_at, id LIMIT 1",
    askId,
  );
}

/** 消化の印を付ける（未消化のときだけ。付けられなければ false＝ほかが先に始めた） */
export function markPendingReplyConsumed(db: WsDb, replyId: Uuid, now: Date): boolean {
  return run(db, "UPDATE ask_pending_replies SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", now, replyId) > 0;
}

/** 動いている本番の実行があるか（running・waiting_input。insertLiveRun と同じ判定） */
export function hasActiveLiveRun(db: WsDb, askId: Uuid): boolean {
  return one(db, {}, "SELECT 1 AS ok FROM ask_runs WHERE ask_id = ? AND status IN ('running','waiting_input') LIMIT 1", askId) !== null;
}
