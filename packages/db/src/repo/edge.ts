// edge（packages/edge）の業務の問い合わせ（formation-runtime.md §3.10〜3.12、G-01、M-14、SO §3.10・§3.12）
// 約束は README §1：業務の関数は (q, ctx: WsCtx, …) で、SQL を必ず workspace_id で絞る。書いて整合が要る関数は Tx を受ける。
// 例外はタスクのトークンからタスクを引く findTaskByTokenHash だけ（WsCtx を作る入口。resolveSession と同じ役目：README §1-2・§1-4）。
// トランザクションの中で外部（Gemini・gateway）を呼ばない（G-14）。ロックの順はワークスペース → タスク → 承認 → Intent（M-21）

import type { Hex64, JsonObject, TaintState } from "@open-team/kernel";
import type { Queryable, Tx } from "../client.ts";
import type {
  ActionIntentRow,
  AgentJobRow,
  AgentRow,
  AgentSnapshotRow,
  AskMemberRow,
  AskRow,
  ConnectorRow,
  ConnectorToolRow,
  HaltReason,
  IntentExpireReason,
  IntentStatus,
  LlmProvider,
  MemberRole,
  PolicyDecisionRow,
  ReportKind,
  ReportMeta,
  ReportSource,
  RiskLevel,
  RiskReason,
  SubjectKind,
  TaskEventType,
  TaskFailReason,
  TaskRow,
  TaskStatus,
  UsagePhase,
  UsdDecimal,
  Uuid,
  WorkspaceRow,
} from "../types.ts";
import { TASK_TERMINAL } from "../types.ts";
import type { WsCtx } from "../workspace.ts";

/** 終了状態（st:27）。SQL の NOT IN に使う */
const TERMINAL = [...TASK_TERMINAL] as string[];

async function one<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T | null> {
  const r = await q.query<T>(text, params);
  return r.rows[0] ?? null;
}

// ===================================================================
// タスクのトークン（SO §3.10。DB には SHA-256 だけ。期限ちょうどは無効）
// ===================================================================

export interface TaskTokenHit {
  task: TaskRow;
  workspace: WorkspaceRow;
}

const WORKSPACE_COLUMNS = `id, kind, status, kill_switch_engaged, kill_switch_engaged_at, kill_switch_engaged_by, kill_switch_reason,
  timezone, max_concurrent_tasks, audit_seq, audit_last_hash, last_seen_at, delete_requested_at, seed_version, created_at, updated_at`;

/**
 * タスクのトークン（の SHA-256）からタスクとワークスペースを引く（WsCtx を作る入口。リクエストの workspace_id は読まない：15:486）。
 * 期限（task_token_expires_at > now）の外・失効（NULL）は null。状態・Kill Switch の確かめは呼ぶ側
 */
export async function findTaskByTokenHash(q: Queryable, tokenHash: Buffer, now: Date): Promise<TaskTokenHit | null> {
  const task = await one<TaskRow>(q, "SELECT * FROM tasks WHERE task_token_hash = $1 AND task_token_expires_at > $2", [tokenHash, now]);
  if (task === null) return null;
  const workspace = await one<WorkspaceRow>(q, `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1`, [task.workspace_id]);
  if (workspace === null) return null;
  return { task, workspace };
}

/** トークンを付ける（終了状態のタスクには付けない）。tokenHash は hashTaskToken の値 */
export async function setTaskToken(tx: Tx, ctx: WsCtx, taskId: Uuid, tokenHash: Buffer, expiresAt: Date, now: Date): Promise<boolean> {
  const r = await tx.query(
    `UPDATE tasks SET task_token_hash = $3, task_token_expires_at = $4, updated_at = $5
      WHERE id = $2 AND workspace_id = $1 AND NOT (status = ANY($6::text[]))`,
    [ctx.workspaceId, taskId, tokenHash, expiresAt, now, TERMINAL],
  );
  return r.rowCount > 0;
}

/** トークンを失効させる（ハッシュを NULL。報告・finished・停止：si:135・171） */
export async function revokeTaskToken(q: Queryable, ctx: WsCtx, taskId: Uuid, now: Date): Promise<void> {
  await q.query(
    `UPDATE tasks SET task_token_hash = NULL, task_token_expires_at = NULL, updated_at = $3
      WHERE id = $2 AND workspace_id = $1 AND task_token_hash IS NOT NULL`,
    [ctx.workspaceId, taskId, now],
  );
}

// ===================================================================
// タスクの行
// ===================================================================

export async function getTask(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<TaskRow | null> {
  return one<TaskRow>(q, "SELECT * FROM tasks WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, taskId]);
}

/** タスクの行を FOR UPDATE（ワークスペースの行を先に取ってから呼ぶ：M-21） */
export async function lockTask(tx: Tx, ctx: WsCtx, taskId: Uuid): Promise<TaskRow | null> {
  return one<TaskRow>(tx, "SELECT * FROM tasks WHERE id = $2 AND workspace_id = $1 FOR UPDATE", [ctx.workspaceId, taskId]);
}

/** queued・provisioning → running（API-036 の最初の呼び出し：si:43）。started_at は最初の1回だけ入れる */
export async function markTaskRunning(tx: Tx, ctx: WsCtx, taskId: Uuid, now: Date): Promise<TaskRow | null> {
  return one<TaskRow>(
    tx,
    `UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, $3), last_heartbeat_at = $3, updated_at = $3
      WHERE id = $2 AND workspace_id = $1 AND status IN ('queued', 'provisioning')
      RETURNING *`,
    [ctx.workspaceId, taskId, now],
  );
}

/** ハートビート（API-038・LLM の呼び出し。rt:101） */
export async function touchTaskHeartbeat(q: Queryable, ctx: WsCtx, taskId: Uuid, now: Date): Promise<void> {
  await q.query("UPDATE tasks SET last_heartbeat_at = $3 WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, taskId, now]);
}

/** 終了状態への変え方（tasks の CHECK：halted ⇔ halt_reason、failed ⇔ fail_reason、終了状態 ⇔ finished_at） */
export type TaskEndChange =
  | { status: "halted"; haltReason: HaltReason }
  | { status: "failed"; failReason: TaskFailReason }
  | { status: "completed"; detail: string }
  | { status: "succeeded" }
  | { status: "cancelled"; detail: string | null };

/**
 * タスクを終了状態にし、トークンを失効させる（終了状態は最終で、あとから変えない：st:27）。
 * すでに終了状態なら変えずに null
 */
export async function endTask(tx: Tx, ctx: WsCtx, taskId: Uuid, change: TaskEndChange, now: Date): Promise<TaskRow | null> {
  const haltReason = change.status === "halted" ? change.haltReason : null;
  const failReason = change.status === "failed" ? change.failReason : null;
  const detail = change.status === "completed" || change.status === "cancelled" ? change.detail : null;
  return one<TaskRow>(
    tx,
    `UPDATE tasks SET status = $3, halt_reason = $4, fail_reason = $5, status_detail = $6, finished_at = $7,
                      task_token_hash = NULL, task_token_expires_at = NULL, updated_at = $7
      WHERE id = $2 AND workspace_id = $1 AND NOT (status = ANY($8::text[]))
      RETURNING *`,
    [ctx.workspaceId, taskId, change.status, haltReason, failReason, detail, now, TERMINAL],
  );
}

/** ループが終わって承認・実行を待つ（awaiting_approval / executing。IA §3.18 の3） */
export async function setTaskWaitingStatus(
  tx: Tx,
  ctx: WsCtx,
  taskId: Uuid,
  status: "awaiting_approval" | "executing",
  now: Date,
): Promise<TaskRow | null> {
  return one<TaskRow>(
    tx,
    `UPDATE tasks SET status = $3, updated_at = $4
      WHERE id = $2 AND workspace_id = $1 AND NOT (status = ANY($5::text[]))
      RETURNING *`,
    [ctx.workspaceId, taskId, status, now, TERMINAL],
  );
}

/** LLM の呼び出し1回の費用とステップを足す（FR-013：gov:130）。足したあとの値を返す */
export async function addTaskUsage(
  tx: Tx,
  ctx: WsCtx,
  taskId: Uuid,
  costUsd: UsdDecimal,
  steps: number,
  now: Date,
): Promise<{ cost_usd: UsdDecimal; steps_used: number } | null> {
  return one<{ cost_usd: UsdDecimal; steps_used: number }>(
    tx,
    `UPDATE tasks SET cost_usd = cost_usd + $3, steps_used = steps_used + $4, last_heartbeat_at = $5, updated_at = $5
      WHERE id = $2 AND workspace_id = $1
      RETURNING cost_usd::text AS cost_usd, steps_used`,
    [ctx.workspaceId, taskId, costUsd, steps, now],
  );
}

/** Breaker のカウンタ（FR-014。nextCounters の結果） */
export async function updateTaskCounters(
  tx: Tx,
  ctx: WsCtx,
  taskId: Uuid,
  c: { deniedCount: number; repeatKey: Hex64 | null; repeatCount: number },
  now: Date,
): Promise<void> {
  await tx.query(
    `UPDATE tasks SET denied_count = $3, repeat_key = $4, repeat_count = $5, updated_at = $6
      WHERE id = $2 AND workspace_id = $1`,
    [ctx.workspaceId, taskId, c.deniedCount, c.repeatKey, c.repeatCount, now],
  );
}

/** 汚染を保存する（BR-38。tainted は一度 true にしたら戻らない：トリガー） */
export async function setTaskTaint(tx: Tx, ctx: WsCtx, taskId: Uuid, taint: TaintState, now: Date): Promise<void> {
  await tx.query(
    "UPDATE tasks SET tainted = $3, taint_sources = $4, updated_at = $5 WHERE id = $2 AND workspace_id = $1",
    [ctx.workspaceId, taskId, taint.tainted, [...taint.sources], now],
  );
}

/** 報告を保存する（API-056。2回目は false：REPORT_ALREADY_SUBMITTED） */
export async function saveTaskReport(
  tx: Tx,
  ctx: WsCtx,
  taskId: Uuid,
  r: { title: string; body: string; kind: ReportKind; sources: ReportSource[]; meta?: ReportMeta | null },
  now: Date,
): Promise<boolean> {
  const meta = r.meta === undefined || r.meta === null || Object.keys(r.meta).length === 0 ? null : r.meta;
  const res = await tx.query(
    `UPDATE tasks SET report = $3, report_title = $4, report_kind = $5, report_sources = $6, report_meta = $8, updated_at = $7
      WHERE id = $2 AND workspace_id = $1 AND report IS NULL`,
    [ctx.workspaceId, taskId, r.body, r.title, r.kind, r.sources, now, meta],
  );
  return res.rowCount > 0;
}

/** 同じワークスペースで動いているタスクの数（BR-08） */
export async function countActiveLiveTasks(q: Queryable, ctx: WsCtx): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM tasks
      WHERE workspace_id = $1 AND status IN ('provisioning', 'running')`,
    [ctx.workspaceId],
  );
  return r?.n ?? 0;
}

// ===================================================================
// タスクの文脈（エージェント・スナップショット・仕事・依頼・受け渡し）
// ===================================================================

export async function getAgentRow(q: Queryable, ctx: WsCtx, agentId: Uuid): Promise<AgentRow | null> {
  return one<AgentRow>(q, "SELECT * FROM agents WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, agentId]);
}

export async function getAgentSnapshotRow(q: Queryable, ctx: WsCtx, snapshotId: Uuid): Promise<AgentSnapshotRow | null> {
  return one<AgentSnapshotRow>(q, "SELECT * FROM agent_snapshots WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, snapshotId]);
}

export async function getAgentJobRow(q: Queryable, ctx: WsCtx, jobId: Uuid): Promise<AgentJobRow | null> {
  return one<AgentJobRow>(q, "SELECT * FROM agent_jobs WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, jobId]);
}

export async function getAskRow(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<AskRow | null> {
  return one<AskRow>(q, "SELECT * FROM asks WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, askId]);
}

/** 依頼の担当（段の順。まとめ役は最後）と担当の名前 */
export async function listAskMembers(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<Array<AskMemberRow & { agent_name: string }>> {
  const r = await q.query<AskMemberRow & { agent_name: string }>(
    `SELECT m.*, a.name AS agent_name
       FROM ask_members m JOIN agents a ON a.id = m.agent_id AND a.workspace_id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.ask_id = $2
      ORDER BY m.is_aggregator, m.position NULLS LAST, m.created_at, m.id`,
    [ctx.workspaceId, askId],
  );
  return r.rows;
}

export interface InputTaskReport {
  id: Uuid;
  agent_name: string;
  status: TaskStatus;
  report: string | null;
  report_title: string | null;
  tainted: boolean;
  taint_sources: TaintState["sources"];
  ask_run_id: Uuid | null;
  ask_member_id: Uuid | null;
  finished_at: Date | null;
}

/** 依頼の実行のきっかけ（initial・manual・schedule・resume）。見つからなければ null */
export async function getAskRunTriggerType(q: Queryable, ctx: WsCtx, runId: Uuid): Promise<string | null> {
  const r = await q.query<{ trigger_type: string }>("SELECT trigger_type FROM ask_runs WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, runId]);
  return r.rows[0]?.trigger_type ?? null;
}

/** 受け渡した元のタスクの報告（BR-71）。ids の順で返す（見つからないものは飛ばす） */
export async function listInputTaskReports(q: Queryable, ctx: WsCtx, taskIds: readonly Uuid[]): Promise<InputTaskReport[]> {
  if (taskIds.length === 0) return [];
  const r = await q.query<InputTaskReport>(
    `SELECT t.id, a.name AS agent_name, t.status, t.report, t.report_title, t.tainted, t.taint_sources, t.ask_run_id, t.ask_member_id, t.finished_at
       FROM tasks t JOIN agents a ON a.id = t.agent_id AND a.workspace_id = t.workspace_id
      WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[])`,
    [ctx.workspaceId, [...taskIds]],
  );
  const byId = new Map(r.rows.map((x) => [x.id, x]));
  return taskIds.map((id) => byId.get(id)).filter((x): x is InputTaskReport => x !== undefined);
}

/** ワークスペースのメンバーのロール（BR-14 の承認者の計算） */
export async function listMembershipRoles(q: Queryable, ctx: WsCtx): Promise<Array<{ user_id: Uuid; role: MemberRole }>> {
  const r = await q.query<{ user_id: Uuid; role: MemberRole }>(
    "SELECT user_id, role FROM memberships WHERE workspace_id = $1 ORDER BY created_at, id",
    [ctx.workspaceId],
  );
  return r.rows;
}

// ===================================================================
// コネクタ・ツール（G-01 の subject.tool。connector_tools＋connectors.enabled）
// ===================================================================

export interface ConnectorToolHit {
  connector: ConnectorRow;
  tool: ConnectorToolRow;
}

/** slug とツール名で1つ（'mcp.<slug>.<tool>' の判定に使う）。なければ null（decide で unknown_action） */
export async function findConnectorTool(q: Queryable, ctx: WsCtx, slug: string, toolName: string): Promise<ConnectorToolHit | null> {
  const connector = await one<ConnectorRow>(q, "SELECT * FROM connectors WHERE workspace_id = $1 AND slug = $2", [ctx.workspaceId, slug]);
  if (connector === null) return null;
  const tool = await one<ConnectorToolRow>(
    q,
    "SELECT * FROM connector_tools WHERE workspace_id = $1 AND connector_id = $2 AND name = $3",
    [ctx.workspaceId, connector.id, toolName],
  );
  return tool === null ? null : { connector, tool };
}

/** slug のコネクタとそのツールすべて（付与されたツールの一覧に使う） */
export async function listConnectorToolsBySlugs(q: Queryable, ctx: WsCtx, slugs: readonly string[]): Promise<ConnectorToolHit[]> {
  if (slugs.length === 0) return [];
  const connectors = await q.query<ConnectorRow>(
    "SELECT * FROM connectors WHERE workspace_id = $1 AND slug = ANY($2::text[]) ORDER BY slug",
    [ctx.workspaceId, [...slugs]],
  );
  if (connectors.rows.length === 0) return [];
  const byId = new Map(connectors.rows.map((c) => [c.id, c]));
  const tools = await q.query<ConnectorToolRow>(
    "SELECT * FROM connector_tools WHERE workspace_id = $1 AND connector_id = ANY($2::uuid[]) ORDER BY name",
    [ctx.workspaceId, [...byId.keys()]],
  );
  const out: ConnectorToolHit[] = [];
  for (const tool of tools.rows) {
    const connector = byId.get(tool.connector_id);
    if (connector !== undefined) out.push({ connector, tool });
  }
  return out;
}

// ===================================================================
// 費用（G-01 の dayCostUsd・agentDayCostUsd、SO §3.12 の checkSpend）。金額は numeric の文字列で返す
// ===================================================================

/** そのワークスペースの、timeZone の今日（now を含む日）の費用 */
export async function sumWorkspaceDayCostUsd(q: Queryable, ctx: WsCtx, now: Date, timeZone: string): Promise<UsdDecimal> {
  const r = await one<{ usd: string }>(
    q,
    `WITH d AS (
       SELECT (date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3) AS start,
              ((date_trunc('day', $2::timestamptz AT TIME ZONE $3) + interval '1 day') AT TIME ZONE $3) AS "end"
     )
     SELECT COALESCE(sum(u.cost_usd), 0)::numeric(16,6)::text AS usd
       FROM usage_records u, d
      WHERE u.workspace_id = $1 AND u.created_at >= d.start AND u.created_at < d."end"`,
    [ctx.workspaceId, now, timeZone],
  );
  return r?.usd ?? "0.000000";
}

/** そのエージェントの今日の費用（agent_id が同じか、task_id のタスクのエージェントが同じ：G-01） */
export async function sumAgentDayCostUsd(q: Queryable, ctx: WsCtx, agentId: Uuid, now: Date, timeZone: string): Promise<UsdDecimal> {
  const r = await one<{ usd: string }>(
    q,
    `WITH d AS (
       SELECT (date_trunc('day', $3::timestamptz AT TIME ZONE $4) AT TIME ZONE $4) AS start,
              ((date_trunc('day', $3::timestamptz AT TIME ZONE $4) + interval '1 day') AT TIME ZONE $4) AS "end"
     )
     SELECT COALESCE(sum(u.cost_usd), 0)::numeric(16,6)::text AS usd
       FROM usage_records u
       CROSS JOIN d
       LEFT JOIN tasks t ON t.id = u.task_id AND t.workspace_id = u.workspace_id
      WHERE u.workspace_id = $1 AND u.created_at >= d.start AND u.created_at < d."end"
        AND (u.agent_id = $2 OR t.agent_id = $2)`,
    [ctx.workspaceId, agentId, now, timeZone],
  );
  return r?.usd ?? "0.000000";
}

export interface UsageRecordInput {
  taskId: Uuid | null;
  agentId: Uuid | null;
  askId: Uuid | null;
  provider: LlmProvider;
  model: string;
  phase: UsagePhase;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: UsdDecimal;
  costUsd: UsdDecimal;
  latencyMs: number;
  promptHash: string;
}

/** 費用の行（TBL-011。持ち主は task・agent・ask のどれか1つ以上） */
export async function insertUsageRecord(q: Queryable, ctx: WsCtx, u: UsageRecordInput, now: Date): Promise<void> {
  await q.query(
    `INSERT INTO usage_records (workspace_id, task_id, agent_id, ask_id, provider, model, phase, input_tokens,
                                output_tokens, estimated_cost_usd, cost_usd, latency_ms, prompt_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      ctx.workspaceId,
      u.taskId,
      u.agentId,
      u.askId,
      u.provider,
      u.model,
      u.phase,
      u.inputTokens,
      u.outputTokens,
      u.estimatedCostUsd,
      u.costUsd,
      u.latencyMs,
      u.promptHash,
      now,
    ],
  );
}

// ===================================================================
// Intent・承認（G-01 の intentsCount・unknownOutcomeKeys、M-14 の recordMcpIntent）
// ===================================================================

/** そのタスクの Intent の行数（denied を含む全状態：KD §8-6） */
export async function countTaskIntents(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<number> {
  const r = await one<{ n: number }>(q, "SELECT count(*)::int AS n FROM action_intents WHERE workspace_id = $1 AND task_id = $2", [
    ctx.workspaceId,
    taskId,
  ]);
  return r?.n ?? 0;
}

/** そのタスクの Intent の状態（タスクの終わり方：IA §3.18） */
export async function listTaskIntentStatuses(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<IntentStatus[]> {
  const r = await q.query<{ status: IntentStatus }>(
    "SELECT status FROM action_intents WHERE workspace_id = $1 AND task_id = $2 ORDER BY created_at, id",
    [ctx.workspaceId, taskId],
  );
  return r.rows.map((x) => x.status);
}

/** 同じ仕事の unknown_outcome の destination_key（BR-68）。重複なし・昇順 */
export async function listUnknownOutcomeKeys(q: Queryable, ctx: WsCtx, jobId: Uuid): Promise<Hex64[]> {
  const r = await q.query<{ destination_key: Hex64 }>(
    `SELECT DISTINCT i.destination_key
       FROM action_intents i
      WHERE i.workspace_id = $1 AND i.job_id = $2 AND i.status = 'unknown_outcome'
      ORDER BY i.destination_key`,
    [ctx.workspaceId, jobId],
  );
  return r.rows.map((x) => x.destination_key);
}

/** その仕事で人が承認したことのある宛先か（BR-70 の「初めての宛先」の反対。MT §3.15） */
export async function hasApprovedDestination(q: Queryable, ctx: WsCtx, jobId: Uuid, destinationKey: Hex64): Promise<boolean> {
  const r = await one<{ found: boolean }>(
    q,
    `SELECT EXISTS (
       SELECT 1 FROM approvals a JOIN action_intents i ON i.id = a.intent_id AND i.workspace_id = a.workspace_id
        WHERE a.workspace_id = $1 AND a.status = 'approved' AND i.job_id = $2 AND i.destination_key = $3
     ) AS found`,
    [ctx.workspaceId, jobId, destinationKey],
  );
  return r?.found === true;
}

export interface ActionIntentInput {
  taskId: Uuid;
  jobId: Uuid;
  connectorId: Uuid;
  connectorCredentialId?: Uuid | null;
  action: string;
  origin: "agent" | "deliver";
  payload: ActionIntentRow["payload"];
  toolHash: ActionIntentRow["tool_hash"];
  destinationKey: Hex64;
  optionDigest: Hex64;
  taintSnapshot: TaintState;
  status: Extract<IntentStatus, "simulated" | "denied" | "pending_approval" | "approved">;
  decision: ActionIntentRow["decision"];
  reasonCode: string;
  matchedRule: string | null;
  decisionDetail: JsonObject | null;
  enforced: boolean;
  policyHash: Hex64;
  intentHash: Hex64;
  expiresAt: Date | null;
}

/** OAuth Intent に固定する有効資格情報の ID（秘密列は選ばない）。workspace と connector の両方で絞る。 */
export async function getActiveCredentialId(q: Queryable, ctx: WsCtx, connectorId: Uuid): Promise<Uuid | null> {
  const r = await one<{ id: Uuid }>(q,
    "SELECT id FROM connector_credentials WHERE workspace_id = $1 AND connector_id = $2 AND revoked_at IS NULL",
    [ctx.workspaceId, connectorId],
  );
  return r?.id ?? null;
}

export async function insertActionIntent(tx: Tx, ctx: WsCtx, i: ActionIntentInput, now: Date): Promise<Uuid> {
  const r = await one<{ id: Uuid }>(
    tx,
    `INSERT INTO action_intents (workspace_id, task_id, job_id, connector_id, connector_credential_id, action_type, action, origin, payload, tool_hash,
                                 destination_key, option_digest, taint_snapshot, status, decision, reason_code, matched_rule,
                                 decision_detail, enforced, policy_hash, intent_hash, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'mcp_call', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22)
     RETURNING id`,
    [
      ctx.workspaceId,
      i.taskId,
      i.jobId,
      i.connectorId,
      i.connectorCredentialId ?? null,
      i.action,
      i.origin,
      i.payload,
      i.toolHash,
      i.destinationKey,
      i.optionDigest,
      { tainted: i.taintSnapshot.tainted, sources: [...i.taintSnapshot.sources] },
      i.status,
      i.decision,
      i.reasonCode,
      i.matchedRule,
      i.decisionDetail,
      i.enforced,
      i.policyHash,
      i.intentHash,
      i.expiresAt,
      now,
    ],
  );
  if (r === null) throw new Error("Intent を作れなかった");
  return r.id;
}

export interface ApprovalInput {
  taskId: Uuid;
  intentId: Uuid;
  riskLevel: RiskLevel;
  riskScore: number;
  riskReasons: RiskReason[];
  approverIds: Uuid[];
  expiresAt: Date;
  expiryCause: "ttl" | "next_run";
  firstDestination: boolean;
}

export async function insertApproval(tx: Tx, ctx: WsCtx, a: ApprovalInput, now: Date): Promise<Uuid> {
  const r = await one<{ id: Uuid }>(
    tx,
    `INSERT INTO approvals (workspace_id, task_id, intent_id, status, risk_level, risk_score, risk_reasons, approver_ids, expires_at,
                            expiry_cause, first_destination, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7::uuid[], $8, $9, $10, $11, $11)
     RETURNING id`,
    [
      ctx.workspaceId,
      a.taskId,
      a.intentId,
      a.riskLevel,
      a.riskScore,
      a.riskReasons,
      a.approverIds,
      a.expiresAt,
      a.expiryCause,
      a.firstDestination,
      now,
    ],
  );
  if (r === null) throw new Error("承認を作れなかった");
  return r.id;
}

/**
 * タスクの未実行の Intent（proposed・pending_approval・approved）を expired にし、待っている承認も expired にする
 * （IA §8-7：finish・予算・Breaker・sandbox_lost でも task_ended。Kill Switch は kill_switch）。executing は完了まで待つ
 */
export async function expireOpenIntentsOfTask(
  tx: Tx,
  ctx: WsCtx,
  taskId: Uuid,
  reason: IntentExpireReason,
  now: Date,
): Promise<{ intentIds: Uuid[]; approvals: number }> {
  // ロックの順（承認 → Intent：M-21）
  const approvals = await tx.query(
    `UPDATE approvals SET status = 'expired', updated_at = $3
      WHERE workspace_id = $1 AND task_id = $2 AND status = 'pending'`,
    [ctx.workspaceId, taskId, now],
  );
  const intents = await tx.query<{ id: Uuid }>(
    `UPDATE action_intents SET status = 'expired', expire_reason = $3, updated_at = $4
      WHERE workspace_id = $1 AND task_id = $2 AND status IN ('proposed', 'pending_approval', 'approved')
      RETURNING id`,
    [ctx.workspaceId, taskId, reason, now],
  );
  return { intentIds: intents.rows.map((x) => x.id), approvals: approvals.rowCount };
}

// ===================================================================
// 判定の記録（TBL-010）とツール呼び出しの記録
// ===================================================================

export interface PolicyDecisionInput {
  taskId: Uuid;
  intentId: Uuid | null;
  subjectKind: SubjectKind;
  /** DecideResult.operation（M-15） */
  actionType: string | null;
  /** decide の subject。ツール呼び出しは call（toolCallId など）も持つ（callTool がこれで引く） */
  subject: JsonObject;
  counters: JsonObject;
  flags: JsonObject;
  taint: TaintState;
  decision: PolicyDecisionRow["decision"];
  reasonCode: string;
  matchedRule: string | null;
  /** 一致したルールの id（DecideResult.matchedRuleId。SG-09）。ないときは省略か null */
  matchedRuleId?: string | null;
  detail: JsonObject | null;
  enforced: boolean;
  inputsHash: Hex64;
  kernelVersion: string;
}

export async function insertPolicyDecision(tx: Tx, ctx: WsCtx, d: PolicyDecisionInput, now: Date): Promise<Uuid> {
  const r = await one<{ id: Uuid }>(
    tx,
    `INSERT INTO policy_decisions (workspace_id, task_id, intent_id, subject_kind, action_type, subject, counters, flags, taint, decision,
                                   reason_code, matched_rule, detail, enforced, inputs_hash, kernel_version, created_at, matched_rule_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id`,
    [
      ctx.workspaceId,
      d.taskId,
      d.intentId,
      d.subjectKind,
      d.actionType,
      d.subject,
      d.counters,
      d.flags,
      { tainted: d.taint.tainted, sources: [...d.taint.sources] },
      d.decision,
      d.reasonCode,
      d.matchedRule,
      d.detail,
      d.enforced,
      d.inputsHash,
      d.kernelVersion,
      now,
      d.matchedRuleId ?? null,
    ],
  );
  if (r === null) throw new Error("判定の記録を作れなかった");
  return r.id;
}

/** そのタスクのツール呼び出しの判定の記録（subject.call.toolCallId）。新しいものを1件。なければ null */
export async function findToolCallDecision(q: Queryable, ctx: WsCtx, taskId: Uuid, toolCallId: string): Promise<PolicyDecisionRow | null> {
  return one<PolicyDecisionRow>(
    q,
    `SELECT * FROM policy_decisions
      WHERE workspace_id = $1 AND task_id = $2 AND subject_kind = 'tool_call' AND subject->'call'->>'toolCallId' = $3
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ctx.workspaceId, taskId, toolCallId],
  );
}

/** そのタスクで使った toolCallId（判定の記録に残っているもの） */
export async function listToolCallIds(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<string[]> {
  const r = await q.query<{ id: string }>(
    `SELECT DISTINCT subject->'call'->>'toolCallId' AS id FROM policy_decisions
      WHERE workspace_id = $1 AND task_id = $2 AND subject_kind = 'tool_call' AND subject->'call'->>'toolCallId' IS NOT NULL`,
    [ctx.workspaceId, taskId],
  );
  return r.rows.map((x) => x.id);
}

/** タスクのイベント（TBL-007。payload にも必要なら taskId を入れるのは呼ぶ側） */
export async function insertTaskEvent(q: Queryable, ctx: WsCtx, taskId: Uuid, type: TaskEventType, payload: JsonObject, now: Date): Promise<void> {
  await q.query("INSERT INTO task_events (workspace_id, task_id, type, payload, created_at) VALUES ($1, $2, $3, $4, $5)", [
    ctx.workspaceId,
    taskId,
    type,
    payload,
    now,
  ]);
}

/**
 * ツール呼び出しの実行を1回だけ受け付ける（callTool。同じ toolCallId の2回目は false → TOOL_CALL_NOT_ALLOWED）。
 * task_events に { toolCallId, name, by: 'edge', stage: 'executed' } を足す。runner の進捗（by なし）とは by で見分ける。
 * 呼ぶ側はタスクの行を FOR UPDATE してから呼ぶ（同じタスクの実行を直列にする）
 */
export async function claimToolCallExecution(
  tx: Tx,
  ctx: WsCtx,
  taskId: Uuid,
  call: { toolCallId: string; name: string },
  now: Date,
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO task_events (workspace_id, task_id, type, payload, created_at)
     SELECT $1::uuid, $2::uuid, 'tool_called', $4::jsonb, $5::timestamptz
      WHERE NOT EXISTS (
        SELECT 1 FROM task_events
         WHERE workspace_id = $1 AND task_id = $2 AND type = 'tool_called'
           AND payload->>'by' = 'edge' AND payload->>'stage' = 'executed' AND payload->>'toolCallId' = $3
      )`,
    [ctx.workspaceId, taskId, call.toolCallId, { toolCallId: call.toolCallId, name: call.name, by: "edge", stage: "executed" }, now],
  );
  return r.rowCount > 0;
}

/** このタスクで edge が実行を受け付けたツール呼び出しの数（name ごと。web_fetch の max_fetches_per_task） */
export async function countExecutedToolCalls(q: Queryable, ctx: WsCtx, taskId: Uuid, name: string): Promise<number> {
  const r = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM task_events
      WHERE workspace_id = $1 AND task_id = $2 AND type = 'tool_called'
        AND payload->>'by' = 'edge' AND payload->>'stage' = 'executed' AND payload->>'name' = $3`,
    [ctx.workspaceId, taskId, name],
  );
  return Number(r.rows[0]?.n ?? "0");
}

// タスクが見た URL の集合（SG-04。task_web_urls）は web-urls.ts。依頼のタスクを作る側（asks.ts）と同じものを使う
export { addTaskWebUrls, copyTaskWebUrls, hasTaskWebUrl, TASK_WEB_URLS_MAX } from "./web-urls.ts";

/** タスクが汚染されているか（いまの値。SG-04 の出口の確認は、呼び出しの始めに引いた行ではなくこの値で見る） */
export async function isTaskTainted(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<boolean> {
  const r = await q.query<{ tainted: boolean }>("SELECT tainted FROM tasks WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, taskId]);
  return r.rows[0]?.tainted === true;
}

// ===================================================================
// 連絡板（FR-064。Should）：edge の team_post・team_wait と、追いのターンの文脈
// ===================================================================

export { insertAskMessage, listAskMessages, type AskMessageRow } from "./asks.ts";
export { expireAgentQuestion, getAgentQuestion, insertAgentQuestion } from "./asks.ts";

/** 担当ごとの最新の通常のタスク（追いのターン・作り直しは除く）。担当が止まったか・終わったかの判断に使う */
export async function listLatestMemberTasks(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<TaskRow[]> {
  const r = await q.query<TaskRow>(
    `SELECT DISTINCT ON (ask_member_id) *
       FROM tasks
      WHERE workspace_id = $1 AND ask_id = $2 AND kind = 'normal' AND ask_member_id IS NOT NULL
      ORDER BY ask_member_id, created_at DESC, id DESC`,
    [ctx.workspaceId, askId],
  );
  return r.rows;
}

/** 連絡を渡し終えたことを記録する（tasks.input_message_ids に足す。同じ連絡を2度渡さない） */
export async function markMessagesDelivered(tx: Tx, ctx: WsCtx, taskId: Uuid, messageIds: readonly Uuid[], now: Date): Promise<void> {
  if (messageIds.length === 0) return;
  await tx.query(
    `UPDATE tasks SET input_message_ids = input_message_ids || $3::uuid[], updated_at = $4
      WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, taskId, [...messageIds], now],
  );
}
