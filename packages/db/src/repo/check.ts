// 承認・チェック（SCR-019）の問い合わせ（app の routes/approvals.ts・check.ts・tasks.ts が使う）
// 約束は README §1：業務の関数は (q, ctx: WsCtx, …) で、SQL を必ず workspace_id で絞る。書いて整合が要る関数は Tx を受ける。
// ロックの順はワークスペース → タスク → 承認 → Intent（M-21）。トランザクションの中で外部を呼ばない（G-14）
// 「チェック済み」は check_marks（M-54）。キーは '<種類>:<UUID>'

import type { Json, JsonObject } from "@open-team/kernel";
import { appendAuditLog } from "../audit.ts";
import type { Queryable, Tx } from "../client.ts";
import type {
  ActionIntentRow,
  AgentSnapshotRow,
  ApprovalRow,
  AgentEvolutionEventRow,
  AgentSkillRow,
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
import type { WsCtx } from "../workspace.ts";

async function maybe<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T | null> {
  const r = await q.query<T>(text, params);
  return r.rows[0] ?? null;
}

// ===================================================================
// 承認（API-017・019）
// ===================================================================

/** 承認1件と、カードに要るもの（Intent・タスク・担当・依頼・ツール）。別のワークスペースのものは入らない */
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

/** 承認の行（ワークスペースで絞る）から、カードに要る材料を集める */
export async function loadApprovalBundles(q: Queryable, ctx: WsCtx, approvals: readonly ApprovalRow[]): Promise<ApprovalBundle[]> {
  if (approvals.length === 0) return [];
  const intentIds = approvals.map((a) => a.intent_id);
  const intents = (
    await q.query<ActionIntentRow>("SELECT * FROM action_intents WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [ctx.workspaceId, intentIds])
  ).rows;
  const taskIds = [...new Set(approvals.map((a) => a.task_id))];
  const tasks = (
    await q.query<ApprovalBundle["task"]>(
      `SELECT id, agent_id, agent_snapshot_id, job_id, ask_id, requester_id, tainted, status, is_dry_run
         FROM tasks WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [ctx.workspaceId, taskIds],
    )
  ).rows;
  const agentIds = [...new Set(tasks.map((t) => t.agent_id))];
  const agents = (
    await q.query<{ id: Uuid; name: string }>("SELECT id, name FROM agents WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [ctx.workspaceId, agentIds])
  ).rows;
  const askIds = [...new Set(tasks.map((t) => t.ask_id).filter((x): x is Uuid => x !== null))];
  const asks =
    askIds.length === 0
      ? []
      : (await q.query<{ id: Uuid; text: string }>("SELECT id, text FROM asks WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [ctx.workspaceId, askIds])).rows;
  const connectorIds = [...new Set(intents.map((i) => i.connector_id))];
  const connectors = (
    await q.query<ConnectorRow>("SELECT * FROM connectors WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [ctx.workspaceId, connectorIds])
  ).rows;
  const tools = connectorIds.length === 0 ? [] : (await q.query<ConnectorToolRow>("SELECT * FROM connector_tools WHERE workspace_id = $1 AND connector_id = ANY($2::uuid[])", [ctx.workspaceId, connectorIds])).rows;

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
export async function listApprovalBundles(q: Queryable, ctx: WsCtx, f: ApprovalFilter = {}): Promise<ApprovalBundle[]> {
  const where: string[] = ["a.workspace_id = $1"];
  const params: unknown[] = [ctx.workspaceId];
  const add = (sql: string, v: unknown): void => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.status !== undefined) add("a.status = ?", f.status);
  if (f.taskId !== undefined) add("a.task_id = ?", f.taskId);
  if (f.askId !== undefined) add("t.ask_id = ?", f.askId);
  if (f.notExpiredAt !== undefined) add("(a.status <> 'pending' OR a.expires_at > ?)", f.notExpiredAt);
  params.push(Math.min(Math.max(f.limit ?? 50, 1), 200));
  const rows = (
    await q.query<ApprovalRow>(
      `SELECT a.* FROM approvals a JOIN tasks t ON t.workspace_id = a.workspace_id AND t.id = a.task_id
        WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
      params,
    )
  ).rows;
  return loadApprovalBundles(q, ctx, rows);
}

export async function getApprovalBundle(q: Queryable, ctx: WsCtx, approvalId: Uuid): Promise<ApprovalBundle | null> {
  const row = await maybe<ApprovalRow>(q, "SELECT * FROM approvals WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, approvalId]);
  return row === null ? null : ((await loadApprovalBundles(q, ctx, [row]))[0] ?? null);
}

/** 承認の行を FOR UPDATE（タスクのロックのあと：M-21）。なければ null */
export async function lockApproval(tx: Tx, ctx: WsCtx, approvalId: Uuid): Promise<ApprovalRow | null> {
  return maybe<ApprovalRow>(tx, "SELECT * FROM approvals WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [ctx.workspaceId, approvalId]);
}

/** 承認の Intent を FOR UPDATE（承認のロックのあと） */
export async function lockApprovalIntent(tx: Tx, ctx: WsCtx, intentId: Uuid): Promise<ActionIntentRow | null> {
  return maybe<ActionIntentRow>(tx, "SELECT * FROM action_intents WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [ctx.workspaceId, intentId]);
}

/** pending の承認を決定済みにする。pending でなければ false（二重の決定・期限切れ） */
export async function decideApprovalRow(
  tx: Tx,
  ctx: WsCtx,
  approvalId: Uuid,
  d: { status: "approved" | "rejected"; decidedBy: Uuid; comment: string | null; remember: boolean; createdRuleId: string | null; now: Date },
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE approvals SET status = $3, decided_by = $4, decision_comment = $5, decided_at = $6, remember = $7, created_rule_id = $8, updated_at = $6
      WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
    [ctx.workspaceId, approvalId, d.status, d.decidedBy, d.comment, d.now, d.remember, d.createdRuleId],
  );
  return r.rowCount === 1;
}

/** pending_approval の Intent を approved / rejected にする（タスクの状態の決め直しは呼び出し側）。違う状態なら false */
export async function decideIntentRow(tx: Tx, ctx: WsCtx, intentId: Uuid, to: Extract<IntentStatus, "approved" | "rejected">, now: Date): Promise<boolean> {
  const r = await tx.query(
    "UPDATE action_intents SET status = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2 AND status = 'pending_approval'",
    [ctx.workspaceId, intentId, to, now],
  );
  return r.rowCount === 1;
}

/** 承認の期限切れ（pending のまま now ≥ expires_at）を expired にする。承認を出す前の整理。Intent も approval_timeout（next_run は superseded） */
export async function expireDueApprovals(tx: Tx, ctx: WsCtx, now: Date): Promise<Array<{ approvalId: Uuid; intentId: Uuid; taskId: Uuid }>> {
  const r = await tx.query<{ id: Uuid; intent_id: Uuid; task_id: Uuid; expiry_cause: "ttl" | "next_run" }>(
    `UPDATE approvals SET status = 'expired', updated_at = $2
      WHERE workspace_id = $1 AND status = 'pending' AND expires_at <= $2
      RETURNING id, intent_id, task_id, expiry_cause`,
    [ctx.workspaceId, now],
  );
  for (const a of r.rows) {
    await tx.query(
      `UPDATE action_intents SET status = 'expired', expire_reason = $3, updated_at = $4
        WHERE workspace_id = $1 AND id = $2 AND status = 'pending_approval'`,
      [ctx.workspaceId, a.intent_id, a.expiry_cause === "next_run" ? "superseded" : "approval_timeout", now],
    );
  }
  return r.rows.map((a) => ({ approvalId: a.id, intentId: a.intent_id, taskId: a.task_id }));
}

/** そのエージェントの今のスナップショットとルール数の材料（[以後も許可] の上限）。なければ null */
export async function getAgentCurrentSnapshot(q: Queryable, ctx: WsCtx, agentId: Uuid): Promise<AgentSnapshotRow | null> {
  return maybe<AgentSnapshotRow>(
    q,
    `SELECT s.* FROM agents a JOIN agent_snapshots s ON s.workspace_id = a.workspace_id AND s.id = a.current_snapshot_id
      WHERE a.workspace_id = $1 AND a.id = $2`,
    [ctx.workspaceId, agentId],
  );
}

// ===================================================================
// チェック済み（check_marks。M-54）
// ===================================================================

/** チェックする。すでにチェック済みなら null（冪等）。入れたら checked_at */
export async function insertCheckMark(q: Queryable, ctx: WsCtx, key: string, now: Date): Promise<Date | null> {
  const r = await q.query<{ checked_at: Date }>(
    "INSERT INTO check_marks (workspace_id, item_key, checked_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING checked_at",
    [ctx.workspaceId, key, now],
  );
  return r.rows[0]?.checked_at ?? null;
}

export async function listCheckMarks(q: Queryable, ctx: WsCtx, o: { limit: number; before?: Date }): Promise<Array<{ item_key: string; checked_at: Date }>> {
  const r = await q.query<{ item_key: string; checked_at: Date }>(
    `SELECT item_key, checked_at FROM check_marks WHERE workspace_id = $1 AND ($2::timestamptz IS NULL OR checked_at < $2)
      ORDER BY checked_at DESC, item_key DESC LIMIT $3`,
    [ctx.workspaceId, o.before ?? null, o.limit],
  );
  return r.rows;
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

/** 実行の最初の担当のタスクの prompt（返事の実行では返事の文）。追いのターンは数えない */
const REQUEST_TEXT_SQL = `(SELECT t.prompt FROM tasks t WHERE t.workspace_id = r.workspace_id AND t.ask_run_id = r.id AND t.kind = 'normal' AND t.prompt IS NOT NULL
                            ORDER BY t.created_at, t.id LIMIT 1) AS request_text`;

/** 未チェックの依頼の回答（新しい順） */
export async function listUncheckedAnswers(q: Queryable, ctx: WsCtx, limit: number): Promise<AnswerRunRow[]> {
  const r = await q.query<AskRunRow & { ask_text: string; request_text: string | null }>(
    `SELECT r.*, a.text AS ask_text, ${REQUEST_TEXT_SQL}
       FROM ask_runs r JOIN asks a ON a.workspace_id = r.workspace_id AND a.id = r.ask_id
      WHERE r.workspace_id = $1 AND r.answered_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM check_marks m WHERE m.workspace_id = r.workspace_id AND m.item_key = 'answer:' || r.id::text)
      ORDER BY r.answered_at DESC, r.id DESC LIMIT $2`,
    [ctx.workspaceId, limit],
  );
  return r.rows.map(({ ask_text, request_text, ...run }) => ({ run: run as AskRunRow, askText: ask_text, requestText: request_text }));
}

export async function getAnswerRun(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<AnswerRunRow | null> {
  const r = await maybe<AskRunRow & { ask_text: string; request_text: string | null }>(
    q,
    `SELECT r.*, a.text AS ask_text, ${REQUEST_TEXT_SQL} FROM ask_runs r JOIN asks a ON a.workspace_id = r.workspace_id AND a.id = r.ask_id
      WHERE r.workspace_id = $1 AND r.id = $2 AND r.answered_at IS NOT NULL`,
    [ctx.workspaceId, runId],
  );
  if (r === null) return null;
  const { ask_text, request_text, ...run } = r;
  return { run: run as AskRunRow, askText: ask_text, requestText: request_text };
}

// ---- 育つ（0022）：スキルの案・整理の記録の報告 ----

export interface SkillProposalReportRow {
  proposal: SkillProposalRow;
  agentName: string | null;
}
type ProposalJoin = SkillProposalRow & { agent_name: string | null };
const splitProposal = (x: ProposalJoin): SkillProposalReportRow => {
  const { agent_name, ...proposal } = x;
  return { proposal: proposal as SkillProposalRow, agentName: agent_name };
};
const PROPOSAL_SELECT = `SELECT p.*, ag.name AS agent_name FROM skill_proposals p
   LEFT JOIN agents ag ON ag.workspace_id = p.workspace_id AND ag.id = p.agent_id
  WHERE p.workspace_id = $1 AND p.status <> 'skipped'`;

/** 未チェックで、まだ決めていないスキルの案（proposed。決めたら見てほしいものから消える） */
export async function listUncheckedSkillProposals(q: Queryable, ctx: WsCtx, limit: number): Promise<SkillProposalReportRow[]> {
  const r = await q.query<ProposalJoin>(
    `${PROPOSAL_SELECT} AND p.status = 'proposed' AND (ag.id IS NULL OR ag.status <> 'removed')
        AND NOT EXISTS (SELECT 1 FROM check_marks m WHERE m.workspace_id = p.workspace_id AND m.item_key = 'skill_proposal:' || p.id::text)
      ORDER BY p.created_at DESC, p.id DESC LIMIT $2`,
    [ctx.workspaceId, limit],
  );
  return r.rows.map(splitProposal);
}

export async function getSkillProposalReportRow(q: Queryable, ctx: WsCtx, id: Uuid): Promise<SkillProposalReportRow | null> {
  const r = await maybe<ProposalJoin>(q, `${PROPOSAL_SELECT} AND p.id = $2`, [ctx.workspaceId, id]);
  return r === null ? null : splitProposal(r);
}

export interface EvolutionReportRow {
  event: AgentEvolutionEventRow;
  agentName: string | null;
}
type EvolutionJoin = AgentEvolutionEventRow & { agent_name: string | null };
const splitEvolution = (x: EvolutionJoin): EvolutionReportRow => {
  const { agent_name, ...event } = x;
  return { event: event as AgentEvolutionEventRow, agentName: agent_name };
};
const EVOLUTION_SELECT = `SELECT e.*, ag.name AS agent_name FROM agent_evolution_events e
   LEFT JOIN agents ag ON ag.workspace_id = e.workspace_id AND ag.id = e.agent_id
  WHERE e.workspace_id = $1`;

/** 未チェックの整理の記録（新しい順） */
export async function listUncheckedEvolutionEvents(q: Queryable, ctx: WsCtx, limit: number): Promise<EvolutionReportRow[]> {
  const r = await q.query<EvolutionJoin>(
    `${EVOLUTION_SELECT} AND (ag.id IS NULL OR ag.status <> 'removed')
        AND NOT EXISTS (SELECT 1 FROM check_marks m WHERE m.workspace_id = e.workspace_id AND m.item_key = 'evolution:' || e.id::text)
      ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
    [ctx.workspaceId, limit],
  );
  return r.rows.map(splitEvolution);
}

export async function getEvolutionReportRow(q: Queryable, ctx: WsCtx, id: Uuid): Promise<EvolutionReportRow | null> {
  const r = await maybe<EvolutionJoin>(q, `${EVOLUTION_SELECT} AND e.id = $2`, [ctx.workspaceId, id]);
  return r === null ? null : splitEvolution(r);
}

/** ワークスペースの外していないスキル全部（担当の一覧が担当ごとに引かないための一括。名前の順） */
export async function listWorkspaceActiveSkills(q: Queryable, ctx: WsCtx): Promise<AgentSkillRow[]> {
  const r = await q.query<AgentSkillRow>("SELECT * FROM agent_skills WHERE workspace_id = $1 AND removed_at IS NULL ORDER BY name, id", [ctx.workspaceId]);
  return r.rows;
}

export interface TaskReportRow {
  task: TaskRow;
  agentName: string | null;
}

type TaskJoin = TaskRow & { agent_name: string | null };
const splitTask = (x: TaskJoin): TaskReportRow => {
  const { agent_name, ...task } = x;
  return { task: task as TaskRow, agentName: agent_name };
};
const ENDED_TASK_SELECT = `SELECT t.*, ag.name AS agent_name FROM tasks t
   LEFT JOIN agents ag ON ag.workspace_id = t.workspace_id AND ag.id = t.agent_id
  WHERE t.workspace_id = $1 AND t.ask_run_id IS NULL AND NOT t.is_dry_run
    AND t.status IN ('succeeded', 'completed', 'failed')`;

/** 未チェックの、依頼に属さない仕事の終了（依頼の仕事は回答の行が代わりに出る） */
export async function listUncheckedEndedTasks(q: Queryable, ctx: WsCtx, limit: number): Promise<TaskReportRow[]> {
  const r = await q.query<TaskJoin>(
    `${ENDED_TASK_SELECT}
        AND NOT EXISTS (SELECT 1 FROM check_marks m WHERE m.workspace_id = t.workspace_id AND m.item_key = 'task:' || t.id::text)
      ORDER BY t.finished_at DESC NULLS LAST, t.id DESC LIMIT $2`,
    [ctx.workspaceId, limit],
  );
  return r.rows.map(splitTask);
}

export async function getEndedTaskReportRow(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<TaskReportRow | null> {
  const r = await maybe<TaskJoin>(q, `${ENDED_TASK_SELECT} AND t.id = $2`, [ctx.workspaceId, taskId]);
  return r === null ? null : splitTask(r);
}

export interface WaitingAskRow {
  askId: Uuid;
  text: string;
  question: { text: string; choices: Array<{ id: string; label: string }>; allowFreeText: boolean };
  updatedAt: Date;
}

/** エージェントの聞き返し待ちの依頼（asks.status = waiting_input と question） */
export async function listWaitingAsks(q: Queryable, ctx: WsCtx, limit: number): Promise<WaitingAskRow[]> {
  const r = await q.query<{ id: Uuid; text: string; question: WaitingAskRow["question"]; updated_at: Date }>(
    `SELECT id, text, question, updated_at FROM asks
      WHERE workspace_id = $1 AND status = 'waiting_input' AND question IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT $2`,
    [ctx.workspaceId, limit],
  );
  return r.rows.map((x) => ({ askId: x.id, text: x.text, question: x.question, updatedAt: x.updated_at }));
}

export interface UnknownOutcomeRow {
  intent: ActionIntentRow;
  agentName: string | null;
  agentId: Uuid | null;
  askId: Uuid | null;
}

/** 届いたか分からない書き込み（unknown_outcome で、まだ確定していないもの） */
export async function listUnknownOutcomeIntents(q: Queryable, ctx: WsCtx, limit: number): Promise<UnknownOutcomeRow[]> {
  const r = await q.query<ActionIntentRow & { agent_name: string | null; agent_id: Uuid | null; ask_id: Uuid | null }>(
    `SELECT i.*, ag.name AS agent_name, ag.id AS agent_id, t.ask_id
       FROM action_intents i
       JOIN tasks t ON t.workspace_id = i.workspace_id AND t.id = i.task_id
       LEFT JOIN agents ag ON ag.workspace_id = t.workspace_id AND ag.id = t.agent_id
      WHERE i.workspace_id = $1 AND i.status = 'unknown_outcome' AND i.resolution IS NULL
        AND NOT t.is_dry_run
      ORDER BY i.updated_at DESC, i.id DESC LIMIT $2`,
    [ctx.workspaceId, limit],
  );
  return r.rows.map(({ agent_name, agent_id, ask_id, ...intent }) => ({ intent: intent as ActionIntentRow, agentName: agent_name, agentId: agent_id, askId: ask_id }));
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
export async function listRunningTasks(q: Queryable, ctx: WsCtx, limit: number): Promise<RunningTaskRow[]> {
  const r = await q.query<{
    id: Uuid;
    agent_id: Uuid;
    agent_name: string;
    ask_id: Uuid | null;
    requester_id: Uuid;
    status: RunningTaskRow["status"];
    started_at: Date | null;
    last_tool: string | null;
  }>(
    `SELECT t.id, t.agent_id, ag.name AS agent_name, t.ask_id, t.requester_id, t.status, t.started_at,
            (SELECT e.payload->>'tool' FROM task_events e
              WHERE e.workspace_id = t.workspace_id AND e.task_id = t.id AND e.type = 'tool_called' ORDER BY e.id DESC LIMIT 1) AS last_tool
       FROM tasks t JOIN agents ag ON ag.workspace_id = t.workspace_id AND ag.id = t.agent_id
      WHERE t.workspace_id = $1 AND t.status IN ('queued', 'provisioning', 'running', 'executing')
        AND NOT t.is_dry_run
      ORDER BY t.queued_at DESC, t.id DESC LIMIT $2`,
    [ctx.workspaceId, limit],
  );
  return r.rows.map((x) => ({
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
export async function listDecidedApprovals(q: Queryable, ctx: WsCtx, o: { limit: number; before?: Date }): Promise<ApprovalBundle[]> {
  const rows = (
    await q.query<ApprovalRow>(
      `SELECT * FROM approvals WHERE workspace_id = $1 AND status IN ('approved', 'rejected') AND decided_at IS NOT NULL
          AND ($2::timestamptz IS NULL OR decided_at < $2)
        ORDER BY decided_at DESC, id DESC LIMIT $3`,
      [ctx.workspaceId, o.before ?? null, o.limit],
    )
  ).rows;
  return loadApprovalBundles(q, ctx, rows);
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
export async function applyRuleChange(
  tx: Tx,
  ctx: WsCtx,
  i: ApplyRuleChangeInput,
): Promise<{ changeId: Uuid; snapshotId: Uuid } | null> {
  const cur = await maybe<{ current_snapshot_id: Uuid | null }>(tx, "SELECT current_snapshot_id FROM agents WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [
    ctx.workspaceId,
    i.agentId,
  ]);
  if (cur === null || cur.current_snapshot_id !== i.expectedSnapshotId) return null;
  const proposed = await maybe<{ id: Uuid }>(
    tx,
    `INSERT INTO agent_config_changes (workspace_id, agent_id, job_id, origin, source_task_id, patch, classification, widened_items, status, created_at)
     VALUES ($1, $2, $3, 'approval_rule', $4, $5::jsonb, 'widen', $6::jsonb, 'proposed', $7) RETURNING id`,
    [ctx.workspaceId, i.agentId, i.jobId, i.sourceTaskId, i.patch as never, i.widenedItems as never, i.now],
  );
  if (proposed === null) throw new Error("設定変更を作れなかった");
  const snapshot = await maybe<{ id: Uuid }>(
    tx,
    `INSERT INTO agent_snapshots (workspace_id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
     VALUES ($1, $2, $3, 'in_app', 'valid', $4::jsonb, $5::jsonb, $6::jsonb, $7, $8) RETURNING id`,
    [ctx.workspaceId, i.agentId, proposed.id, i.definition as never, i.effectivePolicies as never, i.clamped as never, i.ceilingsVersion, i.now],
  );
  if (snapshot === null) throw new Error("スナップショットを作れなかった");
  await tx.query(
    "UPDATE agent_config_changes SET status = 'applied', snapshot_id = $3, decided_by = $4, decided_at = $5 WHERE workspace_id = $1 AND id = $2",
    [ctx.workspaceId, proposed.id, snapshot.id, i.decidedBy, i.now],
  );
  await tx.query("UPDATE agents SET current_snapshot_id = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, i.agentId, snapshot.id, i.now]);
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "agent.config.widened",
      actorType: "user",
      actorId: i.decidedBy,
      payload: {
        agentId: i.agentId,
        jobId: i.jobId,
        changeId: proposed.id,
        snapshotId: snapshot.id,
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
  return { changeId: proposed.id, snapshotId: snapshot.id };
}

// ===================================================================
// tick（G-02）：取りこぼしの拾い直し。ワークスペースをまたぐ（呼び出し側は結果のワークスペースごとに WsCtx を作り直して処理する。
// findTaskByTokenHash と同じ「WsCtx を作る入口」の例外：README §1）
// ===================================================================

export interface DueApproval {
  workspaceId: Uuid;
  workspaceKind: "owner" | "guest";
}

/** 期限が来た承認（pending で expires_at ≤ now）のあるワークスペース */
export async function listWorkspacesWithDueApprovals(q: Queryable, now: Date, limit: number): Promise<DueApproval[]> {
  const r = await q.query<{ workspace_id: Uuid; kind: "owner" | "guest" }>(
    `SELECT DISTINCT a.workspace_id, w.kind
       FROM approvals a JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.status = 'pending' AND a.expires_at <= $1 LIMIT $2`,
    [now, limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind }));
}

export interface StalledIntent {
  workspaceId: Uuid;
  workspaceKind: "owner" | "guest";
  intentId: Uuid;
  userId: Uuid | null;
}

/** 承認されたのに実行が始まっていない Intent（approved のまま olderThan より前から。本番のタスクの Intent だけ。Kill Switch 中のワークスペースは除く） */
export async function listStalledApprovedIntents(q: Queryable, olderThan: Date, limit: number): Promise<StalledIntent[]> {
  const r = await q.query<{ workspace_id: Uuid; kind: "owner" | "guest"; id: Uuid; requester_id: Uuid | null }>(
    `SELECT i.workspace_id, w.kind, i.id, t.requester_id
       FROM action_intents i
       JOIN tasks t ON t.workspace_id = i.workspace_id AND t.id = i.task_id
       JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.status = 'approved' AND i.enforced AND i.updated_at < $1
        AND NOT t.is_dry_run
        AND NOT w.kill_switch_engaged AND w.delete_requested_at IS NULL
      ORDER BY i.updated_at LIMIT $2`,
    [olderThan, limit],
  );
  return r.rows.map((x) => ({ workspaceId: x.workspace_id, workspaceKind: x.kind, intentId: x.id, userId: x.requester_id }));
}

/** チェック済みの時刻（なければ null） */
export async function getCheckMark(q: Queryable, ctx: WsCtx, key: string): Promise<Date | null> {
  const r = await q.query<{ checked_at: Date }>("SELECT checked_at FROM check_marks WHERE workspace_id = $1 AND item_key = $2", [ctx.workspaceId, key]);
  return r.rows[0]?.checked_at ?? null;
}

/** 本番のタスクか（試し実行は取り消し・承認の対象にしない） */
export function isProductionTask(t: Pick<TaskRow, "is_dry_run">): boolean {
  return !t.is_dry_run;
}

/**
 * 結果が分からない書き込み（unknown_outcome）をユーザーが確定する（ADR-031・BR-59。API-070）。executed → 届いていた（executed・resolution = confirmed_delivered）、
 * failed → 届いていない（failed・fail_reason = resolution = confirmed_not_delivered）。まだ確定していない unknown_outcome だけ。変えられたら true
 */
export async function resolveUnknownOutcome(tx: Tx, ctx: WsCtx, intentId: Uuid, outcome: "executed" | "failed", now: Date): Promise<boolean> {
  const r =
    outcome === "executed"
      ? await tx.query(
          `UPDATE action_intents SET status = 'executed', resolution = 'confirmed_delivered', updated_at = $3
            WHERE workspace_id = $1 AND id = $2 AND status = 'unknown_outcome' AND resolution IS NULL`,
          [ctx.workspaceId, intentId, now],
        )
      : await tx.query(
          `UPDATE action_intents SET status = 'failed', fail_reason = 'confirmed_not_delivered', resolution = 'confirmed_not_delivered', updated_at = $3
            WHERE workspace_id = $1 AND id = $2 AND status = 'unknown_outcome' AND resolution IS NULL`,
          [ctx.workspaceId, intentId, now],
        );
  return r.rowCount === 1;
}
