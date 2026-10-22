// 承認・チェック（SCR-019）の問い合わせ（packages/db/src/repo/check.ts の WorkspaceDO 版。app の routes/approvals.ts・check.ts・tasks.ts が使う）。
// 業務の関数は (db: WsDb, …) の同期の関数。workspace_id で絞る代わりに、DO そのものがワークスペース。
// 読んで判断して書く関数は db.transaction(() => …) で包む。トランザクションの中で外部を呼ばない（G-14）。
// ロックの順（M-21）・FOR UPDATE は要らない（DO の中は1本の流れ）。Postgres 版の lockApproval・lockApprovalIntent は
// ただ読む getApproval・getApprovalIntent になる（決めるときは、読んでから書くまでを呼ぶ側が db.transaction で包む）。
// 「チェック済み」は check_marks（M-54）。キーは '<種類>:<UUID>'

import type { Json, JsonObject } from "@open-team/kernel";
import { appendAuditLog } from "../audit.ts";
import { CODECS } from "../codecs.ts";
import { all, newId, one, run, type Param, type WsDb } from "../sqlite.ts";
import type {
  ActionIntentRow,
  AgentEvolutionEventRow,
  AgentSkillRow,
  AgentSnapshotRow,
  ApprovalRow,
  ApprovalStatus,
  AskRunRow,
  ConnectorRow,
  ConnectorToolRow,
  EffectivePolicies,
  IntentStatus,
  SkillProposalRow,
  TaskRow,
  Uuid,
} from "../types.ts";

// ===================================================================
// 承認（API-017・019）
// ===================================================================

/** 承認1件と、カードに要るもの（Intent・タスク・担当・依頼・ツール） */
export interface ApprovalBundle {
  approval: ApprovalRow;
  intent: ActionIntentRow;
  task: Pick<TaskRow, "id" | "agent_id" | "agent_snapshot_id" | "job_id" | "ask_id" | "requester_id" | "tainted" | "status" | "is_dry_run">;
  agentName: string | null;
  askText: string | null;
  connector: ConnectorRow | null;
  tool: ConnectorToolRow | null;
}

export interface ApprovalFilter {
  status?: ApprovalStatus;
  askId?: Uuid;
  taskId?: Uuid;
  limit?: number;
  /** 期限切れ（expires_at ≤ now）の pending を除く（SCR-019 の一覧）。省略すると除かない */
  notExpiredAt?: Date;
}

/** 承認の行から、カードに要る材料を集める */
export function loadApprovalBundles(db: WsDb, approvals: readonly ApprovalRow[]): ApprovalBundle[] {
  if (approvals.length === 0) return [];
  const IN = "IN (SELECT value FROM json_each(?))";
  const intents = all<ActionIntentRow>(db, CODECS.action_intents, `SELECT * FROM action_intents WHERE id ${IN}`, approvals.map((a) => a.intent_id));
  const taskIds = [...new Set(approvals.map((a) => a.task_id))];
  const tasks = all<ApprovalBundle["task"]>(
    db,
    CODECS.tasks,
    `SELECT id, agent_id, agent_snapshot_id, job_id, ask_id, requester_id, tainted, status, is_dry_run FROM tasks WHERE id ${IN}`,
    taskIds,
  );
  const agentIds = [...new Set(tasks.map((t) => t.agent_id))];
  const agents = all<{ id: Uuid; name: string }>(db, {}, `SELECT id, name FROM agents WHERE id ${IN}`, agentIds);
  const askIds = [...new Set(tasks.map((t) => t.ask_id).filter((x): x is Uuid => x !== null))];
  const asks = askIds.length === 0 ? [] : all<{ id: Uuid; text: string }>(db, {}, `SELECT id, text FROM asks WHERE id ${IN}`, askIds);
  const connectorIds = [...new Set(intents.map((i) => i.connector_id))];
  const connectors = all<ConnectorRow>(db, CODECS.connectors, `SELECT * FROM connectors WHERE id ${IN}`, connectorIds);
  const tools =
    connectorIds.length === 0 ? [] : all<ConnectorToolRow>(db, CODECS.connector_tools, `SELECT * FROM connector_tools WHERE connector_id ${IN}`, connectorIds);

  const out: ApprovalBundle[] = [];
  for (const approval of approvals) {
    const intent = intents.find((i) => i.id === approval.intent_id);
    const task = tasks.find((t) => t.id === approval.task_id);
    if (!intent || !task) continue;
    const toolName = typeof intent.payload.tool === "string" ? intent.payload.tool : null;
    out.push({
      approval,
      intent,
      task,
      agentName: agents.find((a) => a.id === task.agent_id)?.name ?? null,
      askText: asks.find((a) => a.id === task.ask_id)?.text ?? null,
      connector: connectors.find((c) => c.id === intent.connector_id) ?? null,
      tool: toolName === null ? null : (tools.find((t) => t.connector_id === intent.connector_id && t.name === toolName) ?? null),
    });
  }
  return out;
}

/** 承認の一覧（新しい順）。試し実行は承認の行を持たない（DB §4.6）ので入らない */
export function listApprovalBundles(db: WsDb, f: ApprovalFilter = {}): ApprovalBundle[] {
  const where: string[] = ["1 = 1"];
  const params: Param[] = [];
  const add = (sql: string, v: Param): void => {
    params.push(v);
    where.push(sql);
  };
  if (f.status !== undefined) add("a.status = ?", f.status);
  if (f.taskId !== undefined) add("a.task_id = ?", f.taskId);
  if (f.askId !== undefined) add("t.ask_id = ?", f.askId);
  if (f.notExpiredAt !== undefined) add("(a.status <> 'pending' OR a.expires_at > ?)", f.notExpiredAt);
  const rows = all<ApprovalRow>(
    db,
    CODECS.approvals,
    `SELECT a.* FROM approvals a JOIN tasks t ON t.id = a.task_id
      WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    ...params,
    Math.min(Math.max(f.limit ?? 50, 1), 200),
  );
  return loadApprovalBundles(db, rows);
}

export function getApprovalBundle(db: WsDb, approvalId: Uuid): ApprovalBundle | null {
  const row = getApproval(db, approvalId);
  return row === null ? null : (loadApprovalBundles(db, [row])[0] ?? null);
}

/** 承認の行（Postgres 版の lockApproval）。なければ null */
export function getApproval(db: WsDb, approvalId: Uuid): ApprovalRow | null {
  return one<ApprovalRow>(db, CODECS.approvals, "SELECT * FROM approvals WHERE id = ?", approvalId);
}

/** 承認の Intent（Postgres 版の lockApprovalIntent）。なければ null */
export function getApprovalIntent(db: WsDb, intentId: Uuid): ActionIntentRow | null {
  return one<ActionIntentRow>(db, CODECS.action_intents, "SELECT * FROM action_intents WHERE id = ?", intentId);
}

/** pending の承認を決定済みにする。pending でなければ false（二重の決定・期限切れ） */
export function decideApprovalRow(
  db: WsDb,
  approvalId: Uuid,
  d: { status: "approved" | "rejected"; decidedBy: Uuid; comment: string | null; remember: boolean; createdRuleId: string | null; now: Date },
): boolean {
  return (
    run(
      db,
      `UPDATE approvals SET status = ?, decided_by = ?, decision_comment = ?, decided_at = ?, remember = ?, created_rule_id = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
      d.status,
      d.decidedBy,
      d.comment,
      d.now,
      d.remember,
      d.createdRuleId,
      d.now,
      approvalId,
    ) === 1
  );
}

/** pending_approval の Intent を approved / rejected にする（タスクの状態の決め直しは呼び出し側）。違う状態なら false */
export function decideIntentRow(db: WsDb, intentId: Uuid, to: Extract<IntentStatus, "approved" | "rejected">, now: Date): boolean {
  return run(db, "UPDATE action_intents SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'", to, now, intentId) === 1;
}

/** 承認の期限切れ（pending のまま now ≥ expires_at）を expired にする。承認を出す前の整理。Intent も approval_timeout（next_run は superseded） */
export function expireDueApprovals(db: WsDb, now: Date): Array<{ approvalId: Uuid; intentId: Uuid; taskId: Uuid }> {
  return db.transaction(() => {
    const rows = all<{ id: Uuid; intent_id: Uuid; task_id: Uuid; expiry_cause: "ttl" | "next_run" }>(
      db,
      {},
      `UPDATE approvals SET status = 'expired', updated_at = ?
        WHERE status = 'pending' AND expires_at <= ?
        RETURNING id, intent_id, task_id, expiry_cause`,
      now,
      now,
    );
    for (const a of rows) {
      run(
        db,
        "UPDATE action_intents SET status = 'expired', expire_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending_approval'",
        a.expiry_cause === "next_run" ? "superseded" : "approval_timeout",
        now,
        a.intent_id,
      );
    }
    return rows.map((a) => ({ approvalId: a.id, intentId: a.intent_id, taskId: a.task_id }));
  });
}

/** そのエージェントの今のスナップショットとルール数の材料（[以後も許可] の上限）。なければ null */
export function getAgentCurrentSnapshot(db: WsDb, agentId: Uuid): AgentSnapshotRow | null {
  return one<AgentSnapshotRow>(
    db,
    CODECS.agent_snapshots,
    "SELECT s.* FROM agents a JOIN agent_snapshots s ON s.id = a.current_snapshot_id WHERE a.id = ?",
    agentId,
  );
}

// ===================================================================
// チェック済み（check_marks。M-54）
// ===================================================================

/** チェックする。すでにチェック済みなら null（冪等）。入れたら checked_at */
export function insertCheckMark(db: WsDb, key: string, now: Date): Date | null {
  return (
    one<{ checked_at: Date }>(
      db,
      CODECS.check_marks,
      "INSERT INTO check_marks (item_key, checked_at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING checked_at",
      key,
      now,
    )?.checked_at ?? null
  );
}

export function listCheckMarks(db: WsDb, o: { limit: number; before?: Date }): Array<{ item_key: string; checked_at: Date }> {
  const before = o.before ?? null;
  return all<{ item_key: string; checked_at: Date }>(
    db,
    CODECS.check_marks,
    `SELECT item_key, checked_at FROM check_marks WHERE (? IS NULL OR checked_at < ?)
      ORDER BY checked_at DESC, item_key DESC LIMIT ?`,
    before,
    before,
    o.limit,
  );
}

/** チェック済みの時刻（なければ null） */
export function getCheckMark(db: WsDb, key: string): Date | null {
  return one<{ checked_at: Date }>(db, CODECS.check_marks, "SELECT checked_at FROM check_marks WHERE item_key = ?", key)?.checked_at ?? null;
}

// ===================================================================
// 見てほしいもの（報告・質問）
// ===================================================================

export interface AnswerRunRow {
  run: AskRunRow;
  askText: string;
  /** この実行で担当に渡した文（返事の実行は返事の文。最初・定期の実行は依頼の文と同じ）。担当のタスクに prompt がなければ null */
  requestText: string | null;
}

const RUN_COLS_R = `r.id, r.ask_id, r.run_no, r.trigger_type, r.status, r.answer_task_id, r.answer, r.answer_hash, r.answered_at,
  r.first_member_started_at, r.started_at, r.finished_at`;

/** 実行の最初の担当のタスクの prompt（返事の実行では返事の文）。追いのターンは数えない */
const REQUEST_TEXT_SQL = `(SELECT t.prompt FROM tasks t WHERE t.ask_run_id = r.id AND t.kind = 'normal' AND t.prompt IS NOT NULL
                            ORDER BY t.created_at, t.id LIMIT 1) AS request_text`;

type AnswerJoin = AskRunRow & { ask_text: string; request_text: string | null };
const splitAnswer = ({ ask_text, request_text, ...runRow }: AnswerJoin): AnswerRunRow => ({ run: runRow, askText: ask_text, requestText: request_text });

/** 未チェックの依頼の回答（新しい順） */
export function listUncheckedAnswers(db: WsDb, limit: number): AnswerRunRow[] {
  return all<AnswerJoin>(
    db,
    CODECS.ask_runs,
    `SELECT ${RUN_COLS_R}, a.text AS ask_text, ${REQUEST_TEXT_SQL}
       FROM ask_runs r JOIN asks a ON a.id = r.ask_id
      WHERE r.answered_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM check_marks m WHERE m.item_key = 'answer:' || r.id)
      ORDER BY r.answered_at DESC, r.id DESC LIMIT ?`,
    limit,
  ).map(splitAnswer);
}

export function getAnswerRun(db: WsDb, runId: Uuid): AnswerRunRow | null {
  const r = one<AnswerJoin>(
    db,
    CODECS.ask_runs,
    `SELECT ${RUN_COLS_R}, a.text AS ask_text, ${REQUEST_TEXT_SQL} FROM ask_runs r JOIN asks a ON a.id = r.ask_id
      WHERE r.id = ? AND r.answered_at IS NOT NULL`,
    runId,
  );
  return r === null ? null : splitAnswer(r);
}

// ---- 育つ（0022）：スキルの案・整理の記録の報告 ----

export interface SkillProposalReportRow {
  proposal: SkillProposalRow;
  agentName: string | null;
}
type ProposalJoin = SkillProposalRow & { agent_name: string | null };
const splitProposal = ({ agent_name, ...proposal }: ProposalJoin): SkillProposalReportRow => ({ proposal, agentName: agent_name });
const PROPOSAL_SELECT = `SELECT p.*, ag.name AS agent_name FROM skill_proposals p
   LEFT JOIN agents ag ON ag.id = p.agent_id
  WHERE p.status <> 'skipped'`;

/** 未チェックで、まだ決めていないスキルの案（proposed。決めたら見てほしいものから消える） */
export function listUncheckedSkillProposals(db: WsDb, limit: number): SkillProposalReportRow[] {
  return all<ProposalJoin>(
    db,
    CODECS.skill_proposals,
    `${PROPOSAL_SELECT} AND p.status = 'proposed' AND (ag.id IS NULL OR ag.status <> 'removed')
        AND NOT EXISTS (SELECT 1 FROM check_marks m WHERE m.item_key = 'skill_proposal:' || p.id)
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    limit,
  ).map(splitProposal);
}

export function getSkillProposalReportRow(db: WsDb, id: Uuid): SkillProposalReportRow | null {
  const r = one<ProposalJoin>(db, CODECS.skill_proposals, `${PROPOSAL_SELECT} AND p.id = ?`, id);
  return r === null ? null : splitProposal(r);
}

export interface EvolutionReportRow {
  event: AgentEvolutionEventRow;
  agentName: string | null;
}
type EvolutionJoin = AgentEvolutionEventRow & { agent_name: string | null };
const splitEvolution = ({ agent_name, ...event }: EvolutionJoin): EvolutionReportRow => ({ event, agentName: agent_name });
const EVOLUTION_SELECT = `SELECT e.*, ag.name AS agent_name FROM agent_evolution_events e
   LEFT JOIN agents ag ON ag.id = e.agent_id
  WHERE 1 = 1`;

/** 未チェックの整理の記録（新しい順） */
export function listUncheckedEvolutionEvents(db: WsDb, limit: number): EvolutionReportRow[] {
  return all<EvolutionJoin>(
    db,
    CODECS.agent_evolution_events,
    `${EVOLUTION_SELECT} AND (ag.id IS NULL OR ag.status <> 'removed')
        AND NOT EXISTS (SELECT 1 FROM check_marks m WHERE m.item_key = 'evolution:' || e.id)
      ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    limit,
  ).map(splitEvolution);
}

export function getEvolutionReportRow(db: WsDb, id: Uuid): EvolutionReportRow | null {
  const r = one<EvolutionJoin>(db, CODECS.agent_evolution_events, `${EVOLUTION_SELECT} AND e.id = ?`, id);
  return r === null ? null : splitEvolution(r);
}

/** ワークスペースの外していないスキル全部（担当の一覧が担当ごとに引かないための一括。名前の順） */
export function listWorkspaceActiveSkills(db: WsDb): AgentSkillRow[] {
  return all<AgentSkillRow>(db, CODECS.agent_skills, "SELECT * FROM agent_skills WHERE removed_at IS NULL ORDER BY name, id");
}

export interface TaskReportRow {
  task: TaskRow;
  agentName: string | null;
}

type TaskJoin = TaskRow & { agent_name: string | null };
const splitTask = ({ agent_name, ...task }: TaskJoin): TaskReportRow => ({ task, agentName: agent_name });
const ENDED_TASK_SELECT = `SELECT t.*, ag.name AS agent_name FROM tasks t
   LEFT JOIN agents ag ON ag.id = t.agent_id
  WHERE t.ask_run_id IS NULL AND NOT t.is_dry_run
    AND t.status IN ('succeeded', 'completed', 'failed')`;

/** 未チェックの、依頼に属さない仕事の終了（依頼の仕事は回答の行が代わりに出る） */
export function listUncheckedEndedTasks(db: WsDb, limit: number): TaskReportRow[] {
  return all<TaskJoin>(
    db,
    CODECS.tasks,
    `${ENDED_TASK_SELECT}
        AND NOT EXISTS (SELECT 1 FROM check_marks m WHERE m.item_key = 'task:' || t.id)
      ORDER BY t.finished_at DESC NULLS LAST, t.id DESC LIMIT ?`,
    limit,
  ).map(splitTask);
}

export function getEndedTaskReportRow(db: WsDb, taskId: Uuid): TaskReportRow | null {
  const r = one<TaskJoin>(db, CODECS.tasks, `${ENDED_TASK_SELECT} AND t.id = ?`, taskId);
  return r === null ? null : splitTask(r);
}

export interface WaitingAskRow {
  askId: Uuid;
  text: string;
  question: { text: string; choices: Array<{ id: string; label: string }>; allowFreeText: boolean };
  updatedAt: Date;
}

/** エージェントの聞き返し待ちの依頼（asks.status = waiting_input と question） */
export function listWaitingAsks(db: WsDb, limit: number): WaitingAskRow[] {
  return all<{ id: Uuid; text: string; question: WaitingAskRow["question"]; updated_at: Date }>(
    db,
    CODECS.asks,
    `SELECT id, text, question, updated_at FROM asks
      WHERE status = 'waiting_input' AND question IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT ?`,
    limit,
  ).map((x) => ({ askId: x.id, text: x.text, question: x.question, updatedAt: x.updated_at }));
}

export interface UnknownOutcomeRow {
  intent: ActionIntentRow;
  agentName: string | null;
  agentId: Uuid | null;
  askId: Uuid | null;
}

/** 届いたか分からない書き込み（unknown_outcome で、まだ確定していないもの） */
export function listUnknownOutcomeIntents(db: WsDb, limit: number): UnknownOutcomeRow[] {
  return all<ActionIntentRow & { agent_name: string | null; agent_id: Uuid | null; ask_id: Uuid | null }>(
    db,
    CODECS.action_intents,
    `SELECT i.*, ag.name AS agent_name, ag.id AS agent_id, t.ask_id
       FROM action_intents i
       JOIN tasks t ON t.id = i.task_id
       LEFT JOIN agents ag ON ag.id = t.agent_id
      WHERE i.status = 'unknown_outcome' AND i.resolution IS NULL
        AND NOT t.is_dry_run
      ORDER BY i.updated_at DESC, i.id DESC LIMIT ?`,
    limit,
  ).map(({ agent_name, agent_id, ask_id, ...intent }) => ({ intent, agentName: agent_name, agentId: agent_id, askId: ask_id }));
}

// ===================================================================
// やっていること
// ===================================================================

export interface RunningTaskRow {
  taskId: Uuid;
  agentId: Uuid;
  agentName: string;
  askId: Uuid | null;
  requesterId: Uuid;
  status: "queued" | "provisioning" | "running" | "awaiting_approval" | "executing";
  startedAt: Date | null;
  /** 最後に呼んだツール（'<コネクタ>.<ツール>' の action か、runner の tool 名）。なければ null */
  lastTool: string | null;
}

/** 動いている本番のタスク（queued・provisioning・running・executing。awaiting_approval は「見てほしいもの」の側） */
export function listRunningTasks(db: WsDb, limit: number): RunningTaskRow[] {
  return all<{
    id: Uuid;
    agent_id: Uuid;
    agent_name: string;
    ask_id: Uuid | null;
    requester_id: Uuid;
    status: RunningTaskRow["status"];
    started_at: Date | null;
    last_tool: string | null;
  }>(
    db,
    { started_at: "date" },
    `SELECT t.id, t.agent_id, ag.name AS agent_name, t.ask_id, t.requester_id, t.status, t.started_at,
            (SELECT json_extract(e.payload, '$.tool') FROM task_events e
              WHERE e.task_id = t.id AND e.type = 'tool_called' ORDER BY e.id DESC LIMIT 1) AS last_tool
       FROM tasks t JOIN agents ag ON ag.id = t.agent_id
      WHERE t.status IN ('queued', 'provisioning', 'running', 'executing')
        AND NOT t.is_dry_run
      ORDER BY t.queued_at DESC, t.id DESC LIMIT ?`,
    limit,
  ).map((x) => ({
    taskId: x.id,
    agentId: x.agent_id,
    agentName: x.agent_name,
    askId: x.ask_id,
    requesterId: x.requester_id,
    status: x.status,
    startedAt: x.started_at,
    lastTool: x.last_tool,
  }));
}

// ===================================================================
// 済んだもの（/done）の解決：キーから行の材料を引く
// ===================================================================

/** 決定済みの承認（新しい順。済んだものに混ぜる） */
export function listDecidedApprovals(db: WsDb, o: { limit: number; before?: Date }): ApprovalBundle[] {
  const before = o.before ?? null;
  const rows = all<ApprovalRow>(
    db,
    CODECS.approvals,
    `SELECT * FROM approvals WHERE status IN ('approved', 'rejected') AND decided_at IS NOT NULL
        AND (? IS NULL OR decided_at < ?)
      ORDER BY decided_at DESC, id DESC LIMIT ?`,
    before,
    before,
    o.limit,
  );
  return loadApprovalBundles(db, rows);
}

// ===================================================================
// [以後も許可]（approval_rule）：ルールを定義に足して新しいスナップショットにする（widen。ADR-027・BR-47①：確認カードは重ねない）
// ===================================================================

export interface ApplyRuleChangeInput {
  agentId: Uuid;
  jobId: Uuid | null;
  /** [{ op: 'add', path: '/rules/-', value: <ルール> }] など */
  patch: Json[];
  widenedItems: Json[];
  /** 判定したときの今のスナップショット。動いていたら null を返す（古い定義に足さない） */
  expectedSnapshotId: Uuid;
  definition: JsonObject;
  effectivePolicies: EffectivePolicies;
  clamped: Json[];
  ceilingsVersion: string;
  decidedBy: Uuid;
  sourceTaskId: Uuid;
  /** 足したルールの出どころ（SG-09）：ルールの id・もとにした Intent・汚染されたタスクの Intent から作ったか。監査ログに残す */
  rule: { id: string; sourceIntentId: Uuid; createdWhileTainted: boolean };
  now: Date;
}

/** ルールの追加を設定変更（widen・applied）として保存し、新しいスナップショットを今のものにする。監査ログ agent.config.widened（origin = approval_rule） */
export function applyRuleChange(db: WsDb, i: ApplyRuleChangeInput): { changeId: Uuid; snapshotId: Uuid } | null {
  return db.transaction(() => {
    const cur = one<{ current_snapshot_id: Uuid | null }>(db, {}, "SELECT current_snapshot_id FROM agents WHERE id = ?", i.agentId);
    if (cur === null || cur.current_snapshot_id !== i.expectedSnapshotId) return null;
    const changeId = newId();
    run(
      db,
      `INSERT INTO agent_config_changes (id, agent_id, job_id, origin, source_task_id, patch, classification, widened_items, status, created_at)
       VALUES (?, ?, ?, 'approval_rule', ?, ?, 'widen', ?, 'proposed', ?)`,
      changeId,
      i.agentId,
      i.jobId,
      i.sourceTaskId,
      i.patch,
      i.widenedItems,
      i.now,
    );
    const snapshotId = newId();
    run(
      db,
      `INSERT INTO agent_snapshots (id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
       VALUES (?, ?, ?, 'in_app', 'valid', ?, ?, ?, ?, ?)`,
      snapshotId,
      i.agentId,
      changeId,
      i.definition,
      i.effectivePolicies,
      i.clamped,
      i.ceilingsVersion,
      i.now,
    );
    run(
      db,
      "UPDATE agent_config_changes SET status = 'applied', snapshot_id = ?, decided_by = ?, decided_at = ? WHERE id = ?",
      snapshotId,
      i.decidedBy,
      i.now,
      changeId,
    );
    run(db, "UPDATE agents SET current_snapshot_id = ?, updated_at = ? WHERE id = ?", snapshotId, i.now, i.agentId);
    appendAuditLog(
      db,
      {
        eventType: "agent.config.widened",
        actorType: "user",
        actorId: i.decidedBy,
        payload: {
          agentId: i.agentId,
          jobId: i.jobId,
          changeId,
          snapshotId,
          previousSnapshotId: i.expectedSnapshotId,
          classification: "widen",
          origin: "approval_rule",
          widenedItems: i.widenedItems,
          ruleId: i.rule.id,
          sourceIntentId: i.rule.sourceIntentId,
          createdWhileTainted: i.rule.createdWhileTainted,
        },
      },
      i.now,
    );
    return { changeId, snapshotId };
  });
}

// ===================================================================
// alarm（G-02）：取りこぼしの拾い直し。Postgres 版はワークスペースをまたいだが、DO の中では自分のワークスペースだけを見る
// ===================================================================

/** 期限が来た承認（pending で expires_at ≤ now）があるか（Postgres 版の listWorkspacesWithDueApprovals） */
export function hasDueApprovals(db: WsDb, now: Date): boolean {
  return one(db, {}, "SELECT 1 AS ok FROM approvals WHERE status = 'pending' AND expires_at <= ? LIMIT 1", now) !== null;
}

export interface StalledIntent {
  intentId: Uuid;
  userId: Uuid | null;
}

/** 承認されたのに実行が始まっていない Intent（approved のまま olderThan より前から。本番のタスクの Intent だけ。Kill Switch の発動中は何も返さない） */
export function listStalledApprovedIntents(db: WsDb, olderThan: Date, limit: number): StalledIntent[] {
  return all<{ id: Uuid; requester_id: Uuid | null }>(
    db,
    {},
    `SELECT i.id, t.requester_id
       FROM action_intents i
       JOIN tasks t ON t.id = i.task_id
      WHERE i.status = 'approved' AND i.enforced AND i.updated_at < ?
        AND NOT t.is_dry_run
        AND NOT (SELECT kill_switch_engaged FROM workspace WHERE id = 1)
      ORDER BY i.updated_at, i.id LIMIT ?`,
    olderThan,
    limit,
  ).map((x) => ({ intentId: x.id, userId: x.requester_id }));
}

/** 本番のタスクか（試し実行は取り消し・承認の対象にしない） */
export function isProductionTask(t: Pick<TaskRow, "is_dry_run">): boolean {
  return !t.is_dry_run;
}

/**
 * 結果が分からない書き込み（unknown_outcome）をユーザーが確定する（ADR-031・BR-59。API-070）。executed → 届いていた（executed・resolution = confirmed_delivered）、
 * failed → 届いていない（failed・fail_reason = resolution = confirmed_not_delivered）。まだ確定していない unknown_outcome だけ。変えられたら true
 */
export function resolveUnknownOutcome(db: WsDb, intentId: Uuid, outcome: "executed" | "failed", now: Date): boolean {
  const n =
    outcome === "executed"
      ? run(
          db,
          `UPDATE action_intents SET status = 'executed', resolution = 'confirmed_delivered', updated_at = ?
            WHERE id = ? AND status = 'unknown_outcome' AND resolution IS NULL`,
          now,
          intentId,
        )
      : run(
          db,
          `UPDATE action_intents SET status = 'failed', fail_reason = 'confirmed_not_delivered', resolution = 'confirmed_not_delivered', updated_at = ?
            WHERE id = ? AND status = 'unknown_outcome' AND resolution IS NULL`,
          now,
          intentId,
        );
  return n === 1;
}
