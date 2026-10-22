// packages/db/src/repo/edge.ts の WorkspaceDO 版。
// edge の業務の問い合わせ（formation-runtime.md §3.10〜3.12、G-01、M-14、SO §3.10・§3.12）。
// - 関数は (db: WsDb, …) の同期の処理。workspace_id で絞る代わりに、DO の中の行だけを扱う
// - タスクのトークンからタスクを引く findTaskByTokenHash が入口（リクエストに載った ID は読まない：15:486）
// - トランザクションの中で外部（Gemini・gateway）を呼ばない（G-14）。ロックの順（M-21）は要らない（DO の中は1本の流れ）
// - 金額はマイクロドルの整数（MicroUsd）。日の区切りは costs.ts の dayRange（JS で計算する）

import type { Hex64, JsonObject, TaintState } from "@open-team/kernel";
import { CODECS } from "../codecs.ts";
import { all, count, newId, one, run, type WsDb } from "../sqlite.ts";
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
  MicroUsd,
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
  Uuid,
  WorkspaceRow,
} from "../types.ts";
import { TASK_TERMINAL } from "../types.ts";
import { getWorkspace, requireWorkspace } from "../workspace.ts";
import { dayRange } from "./costs.ts";

/** 終了状態（st:27）。SQL の NOT IN に使う */
const TERMINAL = [...TASK_TERMINAL] as string[];

// ===================================================================
// タスクのトークン（SO §3.10。DB には SHA-256 だけ。期限ちょうどは無効）
// ===================================================================

export interface TaskTokenHit {
  task: TaskRow;
  workspace: WorkspaceRow;
}

/**
 * タスクのトークン（の SHA-256）からタスクとワークスペースの行を引く（リクエストの ID は読まない：15:486）。
 * 期限（task_token_expires_at > now）の外・失効（NULL）は null。状態・Kill Switch の確かめは呼ぶ側
 */
export function findTaskByTokenHash(db: WsDb, tokenHash: Uint8Array, now: Date): TaskTokenHit | null {
  const task = one<TaskRow>(db, CODECS.tasks, "SELECT * FROM tasks WHERE task_token_hash = ? AND task_token_expires_at > ?", tokenHash, now);
  if (task === null) return null;
  const workspace = getWorkspace(db);
  if (workspace === null) return null;
  return { task, workspace };
}

/** トークンを付ける（終了状態のタスクには付けない）。tokenHash は hashTaskToken の値 */
export function setTaskToken(db: WsDb, taskId: Uuid, tokenHash: Uint8Array, expiresAt: Date, now: Date): boolean {
  return (
    run(
      db,
      `UPDATE tasks SET task_token_hash = ?, task_token_expires_at = ?, updated_at = ?
        WHERE id = ? AND status NOT IN (SELECT value FROM json_each(?))`,
      tokenHash,
      expiresAt,
      now,
      taskId,
      TERMINAL,
    ) > 0
  );
}

/** トークンを失効させる（ハッシュを NULL。報告・finished・停止：si:135・171） */
export function revokeTaskToken(db: WsDb, taskId: Uuid, now: Date): void {
  run(
    db,
    "UPDATE tasks SET task_token_hash = NULL, task_token_expires_at = NULL, updated_at = ? WHERE id = ? AND task_token_hash IS NOT NULL",
    now,
    taskId,
  );
}

// ===================================================================
// タスクの行
// ===================================================================

export function getTask(db: WsDb, taskId: Uuid): TaskRow | null {
  return one<TaskRow>(db, CODECS.tasks, "SELECT * FROM tasks WHERE id = ?", taskId);
}

/** タスクの行を読む（Postgres 版の FOR UPDATE の代わり。DO の中は1本の流れなのでロックは要らない） */
export function lockTask(db: WsDb, taskId: Uuid): TaskRow | null {
  return getTask(db, taskId);
}

/** queued・provisioning → running（API-036 の最初の呼び出し：si:43）。started_at は最初の1回だけ入れる */
export function markTaskRunning(db: WsDb, taskId: Uuid, now: Date): TaskRow | null {
  return one<TaskRow>(
    db,
    CODECS.tasks,
    `UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?1), last_heartbeat_at = ?1, updated_at = ?1
      WHERE id = ?2 AND status IN ('queued', 'provisioning')
      RETURNING *`,
    now,
    taskId,
  );
}

/** ハートビート（API-038・LLM の呼び出し。rt:101） */
export function touchTaskHeartbeat(db: WsDb, taskId: Uuid, now: Date): void {
  run(db, "UPDATE tasks SET last_heartbeat_at = ? WHERE id = ?", now, taskId);
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
export function endTask(db: WsDb, taskId: Uuid, change: TaskEndChange, now: Date): TaskRow | null {
  const haltReason = change.status === "halted" ? change.haltReason : null;
  const failReason = change.status === "failed" ? change.failReason : null;
  const detail = change.status === "completed" || change.status === "cancelled" ? change.detail : null;
  return one<TaskRow>(
    db,
    CODECS.tasks,
    `UPDATE tasks SET status = ?1, halt_reason = ?2, fail_reason = ?3, status_detail = ?4, finished_at = ?5,
                      task_token_hash = NULL, task_token_expires_at = NULL, updated_at = ?5
      WHERE id = ?6 AND status NOT IN (SELECT value FROM json_each(?7))
      RETURNING *`,
    change.status,
    haltReason,
    failReason,
    detail,
    now,
    taskId,
    TERMINAL,
  );
}

/** ループが終わって承認・実行を待つ（awaiting_approval / executing。IA §3.18 の3） */
export function setTaskWaitingStatus(db: WsDb, taskId: Uuid, status: "awaiting_approval" | "executing", now: Date): TaskRow | null {
  return one<TaskRow>(
    db,
    CODECS.tasks,
    `UPDATE tasks SET status = ?, updated_at = ?
      WHERE id = ? AND status NOT IN (SELECT value FROM json_each(?))
      RETURNING *`,
    status,
    now,
    taskId,
    TERMINAL,
  );
}

/** LLM の呼び出し1回の費用（マイクロドル）とステップを足す（FR-013：gov:130）。足したあとの値を返す */
export function addTaskUsage(
  db: WsDb,
  taskId: Uuid,
  costMicroUsd: MicroUsd,
  steps: number,
  now: Date,
): { cost_micro_usd: MicroUsd; steps_used: number } | null {
  if (!Number.isSafeInteger(costMicroUsd) || costMicroUsd < 0) throw new RangeError(`費用はマイクロドルの0以上の整数：${costMicroUsd}`);
  return one<{ cost_micro_usd: MicroUsd; steps_used: number }>(
    db,
    {},
    `UPDATE tasks SET cost_micro_usd = cost_micro_usd + ?1, steps_used = steps_used + ?2, last_heartbeat_at = ?3, updated_at = ?3
      WHERE id = ?4
      RETURNING cost_micro_usd, steps_used`,
    costMicroUsd,
    steps,
    now,
    taskId,
  );
}

/** Breaker のカウンタ（FR-014。nextCounters の結果） */
export function updateTaskCounters(
  db: WsDb,
  taskId: Uuid,
  c: { deniedCount: number; repeatKey: Hex64 | null; repeatCount: number },
  now: Date,
): void {
  run(
    db,
    "UPDATE tasks SET denied_count = ?, repeat_key = ?, repeat_count = ?, updated_at = ? WHERE id = ?",
    c.deniedCount,
    c.repeatKey,
    c.repeatCount,
    now,
    taskId,
  );
}

/** 汚染を保存する（BR-38。tainted は一度 true にしたら戻らない：トリガー） */
export function setTaskTaint(db: WsDb, taskId: Uuid, taint: TaintState, now: Date): void {
  run(db, "UPDATE tasks SET tainted = ?, taint_sources = ?, updated_at = ? WHERE id = ?", taint.tainted, [...taint.sources], now, taskId);
}

/** 報告を保存する（API-056。2回目は false：REPORT_ALREADY_SUBMITTED） */
export function saveTaskReport(
  db: WsDb,
  taskId: Uuid,
  r: { title: string; body: string; kind: ReportKind; sources: ReportSource[]; meta?: ReportMeta | null },
  now: Date,
): boolean {
  const meta = r.meta === undefined || r.meta === null || Object.keys(r.meta).length === 0 ? null : r.meta;
  return (
    run(
      db,
      `UPDATE tasks SET report = ?, report_title = ?, report_kind = ?, report_sources = ?, report_meta = ?, updated_at = ?
        WHERE id = ? AND report IS NULL`,
      r.body,
      r.title,
      r.kind,
      r.sources,
      meta as never,
      now,
      taskId,
    ) > 0
  );
}

/** このワークスペースで動いているタスクの数（BR-08） */
export function countActiveLiveTasks(db: WsDb): number {
  return count(db, "SELECT count(*) FROM tasks WHERE status IN ('provisioning', 'running')");
}

// ===================================================================
// タスクの文脈（エージェント・スナップショット・仕事・依頼・受け渡し）
// ===================================================================

export function getAgentRow(db: WsDb, agentId: Uuid): AgentRow | null {
  return one<AgentRow>(db, CODECS.agents, "SELECT * FROM agents WHERE id = ?", agentId);
}

export function getAgentSnapshotRow(db: WsDb, snapshotId: Uuid): AgentSnapshotRow | null {
  return one<AgentSnapshotRow>(db, CODECS.agent_snapshots, "SELECT * FROM agent_snapshots WHERE id = ?", snapshotId);
}

export function getAgentJobRow(db: WsDb, jobId: Uuid): AgentJobRow | null {
  return one<AgentJobRow>(db, CODECS.agent_jobs, "SELECT * FROM agent_jobs WHERE id = ?", jobId);
}

export function getAskRow(db: WsDb, askId: Uuid): AskRow | null {
  return one<AskRow>(db, CODECS.asks, "SELECT * FROM asks WHERE id = ?", askId);
}

/** 依頼の担当（段の順。まとめ役は最後）と担当の名前 */
export function listAskMembers(db: WsDb, askId: Uuid): Array<AskMemberRow & { agent_name: string }> {
  return all<AskMemberRow & { agent_name: string }>(
    db,
    CODECS.ask_members,
    `SELECT m.*, a.name AS agent_name
       FROM ask_members m JOIN agents a ON a.id = m.agent_id
      WHERE m.ask_id = ?
      ORDER BY m.is_aggregator, m.position IS NULL, m.position, m.created_at, m.id`,
    askId,
  );
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
export function getAskRunTriggerType(db: WsDb, runId: Uuid): string | null {
  return one<{ trigger_type: string }>(db, {}, "SELECT trigger_type FROM ask_runs WHERE id = ?", runId)?.trigger_type ?? null;
}

/** 受け渡した元のタスクの報告（BR-71）。ids の順で返す（見つからないものは飛ばす） */
export function listInputTaskReports(db: WsDb, taskIds: readonly Uuid[]): InputTaskReport[] {
  if (taskIds.length === 0) return [];
  const rows = all<InputTaskReport>(
    db,
    CODECS.tasks,
    `SELECT t.id, a.name AS agent_name, t.status, t.report, t.report_title, t.tainted, t.taint_sources, t.ask_run_id, t.ask_member_id, t.finished_at
       FROM tasks t JOIN agents a ON a.id = t.agent_id
      WHERE t.id IN (SELECT value FROM json_each(?))`,
    [...taskIds],
  );
  const byId = new Map(rows.map((x) => [x.id, x]));
  return taskIds.map((id) => byId.get(id)).filter((x): x is InputTaskReport => x !== undefined);
}

/**
 * ワークスペースのメンバーのロール（BR-14 の承認者の計算）。メンバーの表は D1（今は1人1つ）なので、
 * DO の中では持ち主（workspace.owner_user_id）1人を owner として返す
 */
export function listMembershipRoles(db: WsDb): Array<{ user_id: Uuid; role: "owner" }> {
  return [{ user_id: requireWorkspace(db).owner_user_id, role: "owner" }];
}

// ===================================================================
// コネクタ・ツール（G-01 の subject.tool。connector_tools＋connectors.enabled）
// ===================================================================

export interface ConnectorToolHit {
  connector: ConnectorRow;
  tool: ConnectorToolRow;
}

/** slug とツール名で1つ（'mcp.<slug>.<tool>' の判定に使う）。なければ null（decide で unknown_action） */
export function findConnectorTool(db: WsDb, slug: string, toolName: string): ConnectorToolHit | null {
  const connector = one<ConnectorRow>(db, CODECS.connectors, "SELECT * FROM connectors WHERE slug = ?", slug);
  if (connector === null) return null;
  const tool = one<ConnectorToolRow>(db, CODECS.connector_tools, "SELECT * FROM connector_tools WHERE connector_id = ? AND name = ?", connector.id, toolName);
  return tool === null ? null : { connector, tool };
}

/** slug のコネクタとそのツールすべて（付与されたツールの一覧に使う） */
export function listConnectorToolsBySlugs(db: WsDb, slugs: readonly string[]): ConnectorToolHit[] {
  if (slugs.length === 0) return [];
  const connectors = all<ConnectorRow>(db, CODECS.connectors, "SELECT * FROM connectors WHERE slug IN (SELECT value FROM json_each(?)) ORDER BY slug", [...slugs]);
  if (connectors.length === 0) return [];
  const byId = new Map(connectors.map((c) => [c.id, c]));
  const tools = all<ConnectorToolRow>(
    db,
    CODECS.connector_tools,
    "SELECT * FROM connector_tools WHERE connector_id IN (SELECT value FROM json_each(?)) ORDER BY name",
    [...byId.keys()],
  );
  const out: ConnectorToolHit[] = [];
  for (const tool of tools) {
    const connector = byId.get(tool.connector_id);
    if (connector !== undefined) out.push({ connector, tool });
  }
  return out;
}

// ===================================================================
// 費用（G-01 の dayCostUsd・agentDayCostUsd、SO §3.12 の checkSpend）。金額はマイクロドルの整数で返す
// ===================================================================

/** このワークスペースの、timeZone の今日（now を含む日）の費用 */
export function sumWorkspaceDayCostMicroUsd(db: WsDb, now: Date, timeZone: string): MicroUsd {
  const d = dayRange(now, timeZone);
  return count(db, "SELECT COALESCE(sum(cost_micro_usd), 0) FROM usage_records WHERE created_at >= ? AND created_at < ?", d.start, d.end);
}

/** そのエージェントの今日の費用（agent_id が同じか、task_id のタスクのエージェントが同じ：G-01） */
export function sumAgentDayCostMicroUsd(db: WsDb, agentId: Uuid, now: Date, timeZone: string): MicroUsd {
  const d = dayRange(now, timeZone);
  return count(
    db,
    `SELECT COALESCE(sum(u.cost_micro_usd), 0)
       FROM usage_records u LEFT JOIN tasks t ON t.id = u.task_id
      WHERE u.created_at >= ?1 AND u.created_at < ?2 AND (u.agent_id = ?3 OR t.agent_id = ?3)`,
    d.start,
    d.end,
    agentId,
  );
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
  estimatedCostMicroUsd: MicroUsd;
  costMicroUsd: MicroUsd;
  latencyMs: number;
  promptHash: string;
}

/** 費用の行（TBL-011。持ち主は task・agent・ask のどれか1つ以上） */
export function insertUsageRecord(db: WsDb, u: UsageRecordInput, now: Date): void {
  run(
    db,
    `INSERT INTO usage_records (id, task_id, agent_id, ask_id, provider, model, phase, input_tokens,
                                output_tokens, estimated_cost_micro_usd, cost_micro_usd, latency_ms, prompt_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    u.taskId,
    u.agentId,
    u.askId,
    u.provider,
    u.model,
    u.phase,
    u.inputTokens,
    u.outputTokens,
    u.estimatedCostMicroUsd,
    u.costMicroUsd,
    u.latencyMs,
    u.promptHash,
    now,
  );
}

// ===================================================================
// Intent・承認（G-01 の intentsCount・unknownOutcomeKeys、M-14 の recordMcpIntent）
// ===================================================================

/** そのタスクの Intent の行数（denied を含む全状態：KD §8-6） */
export function countTaskIntents(db: WsDb, taskId: Uuid): number {
  return count(db, "SELECT count(*) FROM action_intents WHERE task_id = ?", taskId);
}

/** そのタスクの Intent の状態（タスクの終わり方：IA §3.18） */
export function listTaskIntentStatuses(db: WsDb, taskId: Uuid): IntentStatus[] {
  return all<{ status: IntentStatus }>(db, {}, "SELECT status FROM action_intents WHERE task_id = ? ORDER BY created_at, id", taskId).map((x) => x.status);
}

/** 同じ仕事の unknown_outcome の destination_key（BR-68）。重複なし・昇順 */
export function listUnknownOutcomeKeys(db: WsDb, jobId: Uuid): Hex64[] {
  return all<{ destination_key: Hex64 }>(
    db,
    {},
    "SELECT DISTINCT destination_key FROM action_intents WHERE job_id = ? AND status = 'unknown_outcome' ORDER BY destination_key",
    jobId,
  ).map((x) => x.destination_key);
}

/** その仕事で人が承認したことのある宛先か（BR-70 の「初めての宛先」の反対。MT §3.15） */
export function hasApprovedDestination(db: WsDb, jobId: Uuid, destinationKey: Hex64): boolean {
  return (
    one(
      db,
      {},
      `SELECT 1 FROM approvals a JOIN action_intents i ON i.id = a.intent_id
        WHERE a.status = 'approved' AND i.job_id = ? AND i.destination_key = ? LIMIT 1`,
      jobId,
      destinationKey,
    ) !== null
  );
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

/** OAuth Intent に固定する有効資格情報の ID（秘密列は選ばない）。コネクタで絞る */
export function getActiveCredentialId(db: WsDb, connectorId: Uuid): Uuid | null {
  return one<{ id: Uuid }>(db, {}, "SELECT id FROM connector_credentials WHERE connector_id = ? AND revoked_at IS NULL", connectorId)?.id ?? null;
}

export function insertActionIntent(db: WsDb, i: ActionIntentInput, now: Date): Uuid {
  const r = one<{ id: Uuid }>(
    db,
    {},
    `INSERT INTO action_intents (id, task_id, job_id, connector_id, connector_credential_id, action_type, action, origin, payload, tool_hash,
                                 destination_key, option_digest, taint_snapshot, status, decision, reason_code, matched_rule,
                                 decision_detail, enforced, policy_hash, intent_hash, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'mcp_call', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    newId(),
    i.taskId,
    i.jobId,
    i.connectorId,
    i.connectorCredentialId ?? null,
    i.action,
    i.origin,
    i.payload as never,
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
    now,
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

export function insertApproval(db: WsDb, a: ApprovalInput, now: Date): Uuid {
  const r = one<{ id: Uuid }>(
    db,
    {},
    `INSERT INTO approvals (id, task_id, intent_id, status, risk_level, risk_score, risk_reasons, approver_ids, expires_at,
                            expiry_cause, first_destination, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    newId(),
    a.taskId,
    a.intentId,
    a.riskLevel,
    a.riskScore,
    a.riskReasons as never,
    a.approverIds,
    a.expiresAt,
    a.expiryCause,
    a.firstDestination,
    now,
    now,
  );
  if (r === null) throw new Error("承認を作れなかった");
  return r.id;
}

/**
 * タスクの未実行の Intent（proposed・pending_approval・approved）を expired にし、待っている承認も expired にする
 * （IA §8-7：finish・予算・Breaker・sandbox_lost でも task_ended。Kill Switch は kill_switch）。executing は完了まで待つ
 */
export function expireOpenIntentsOfTask(db: WsDb, taskId: Uuid, reason: IntentExpireReason, now: Date): { intentIds: Uuid[]; approvals: number } {
  return db.transaction(() => {
    const approvals = run(db, "UPDATE approvals SET status = 'expired', updated_at = ? WHERE task_id = ? AND status = 'pending'", now, taskId);
    const intents = all<{ id: Uuid }>(
      db,
      {},
      `UPDATE action_intents SET status = 'expired', expire_reason = ?, updated_at = ?
        WHERE task_id = ? AND status IN ('proposed', 'pending_approval', 'approved')
        RETURNING id`,
      reason,
      now,
      taskId,
    );
    return { intentIds: intents.map((x) => x.id), approvals };
  });
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

export function insertPolicyDecision(db: WsDb, d: PolicyDecisionInput, now: Date): Uuid {
  const r = one<{ id: Uuid }>(
    db,
    {},
    `INSERT INTO policy_decisions (id, task_id, intent_id, subject_kind, action_type, subject, counters, flags, taint, decision,
                                   reason_code, matched_rule, detail, enforced, inputs_hash, kernel_version, created_at, matched_rule_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    newId(),
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
  );
  if (r === null) throw new Error("判定の記録を作れなかった");
  return r.id;
}

/** そのタスクのツール呼び出しの判定の記録（subject.call.toolCallId）。新しいものを1件。なければ null */
export function findToolCallDecision(db: WsDb, taskId: Uuid, toolCallId: string): PolicyDecisionRow | null {
  return one<PolicyDecisionRow>(
    db,
    CODECS.policy_decisions,
    `SELECT * FROM policy_decisions
      WHERE task_id = ? AND subject_kind = 'tool_call' AND json_extract(subject, '$.call.toolCallId') = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    taskId,
    toolCallId,
  );
}

/** そのタスクで使った toolCallId（判定の記録に残っているもの） */
export function listToolCallIds(db: WsDb, taskId: Uuid): string[] {
  return all<{ id: string }>(
    db,
    {},
    `SELECT DISTINCT json_extract(subject, '$.call.toolCallId') AS id FROM policy_decisions
      WHERE task_id = ? AND subject_kind = 'tool_call' AND json_extract(subject, '$.call.toolCallId') IS NOT NULL`,
    taskId,
  ).map((x) => String(x.id));
}

/** タスクのイベント（TBL-007。payload にも必要なら taskId を入れるのは呼ぶ側） */
export function insertTaskEvent(db: WsDb, taskId: Uuid, type: TaskEventType, payload: JsonObject, now: Date): void {
  run(db, "INSERT INTO task_events (task_id, type, payload, created_at) VALUES (?, ?, ?, ?)", taskId, type, payload, now);
}

/**
 * ツール呼び出しの実行を1回だけ受け付ける（callTool。同じ toolCallId の2回目は false → TOOL_CALL_NOT_ALLOWED）。
 * task_events に { toolCallId, name, by: 'edge', stage: 'executed' } を足す。runner の進捗（by なし）とは by で見分ける。
 * DO の中は1本の流れなので、確かめて足すまでの間に同じタスクの別の実行が割り込まない
 */
export function claimToolCallExecution(db: WsDb, taskId: Uuid, call: { toolCallId: string; name: string }, now: Date): boolean {
  return (
    run(
      db,
      `INSERT INTO task_events (task_id, type, payload, created_at)
       SELECT ?1, 'tool_called', ?2, ?3
        WHERE NOT EXISTS (
          SELECT 1 FROM task_events
           WHERE task_id = ?1 AND type = 'tool_called'
             AND json_extract(payload, '$.by') = 'edge' AND json_extract(payload, '$.stage') = 'executed'
             AND json_extract(payload, '$.toolCallId') = ?4
        )`,
      taskId,
      { toolCallId: call.toolCallId, name: call.name, by: "edge", stage: "executed" },
      now,
      call.toolCallId,
    ) > 0
  );
}

/** このタスクで edge が実行を受け付けたツール呼び出しの数（name ごと。web_fetch の max_fetches_per_task） */
export function countExecutedToolCalls(db: WsDb, taskId: Uuid, name: string): number {
  return count(
    db,
    `SELECT count(*) FROM task_events
      WHERE task_id = ? AND type = 'tool_called'
        AND json_extract(payload, '$.by') = 'edge' AND json_extract(payload, '$.stage') = 'executed' AND json_extract(payload, '$.name') = ?`,
    taskId,
    name,
  );
}

// タスクが見た URL の集合（SG-04。task_web_urls）は web-urls.ts。依頼のタスクを作る側（asks.ts）と同じものを使う
export { addTaskWebUrls, copyTaskWebUrls, hasTaskWebUrl, TASK_WEB_URLS_MAX } from "./web-urls.ts";

/** タスクが汚染されているか（いまの値。SG-04 の出口の確認は、呼び出しの始めに引いた行ではなくこの値で見る） */
export function isTaskTainted(db: WsDb, taskId: Uuid): boolean {
  return one<{ tainted: boolean }>(db, CODECS.tasks, "SELECT tainted FROM tasks WHERE id = ?", taskId)?.tainted === true;
}

// ===================================================================
// 連絡板（FR-064。Should）：edge の team_post・team_wait と、追いのターンの文脈
// ===================================================================

export { insertAskMessage, listAskMessages } from "./asks.ts";
export { expireAgentQuestion, getAgentQuestion, insertAgentQuestion } from "./asks.ts";

/** 担当ごとの最新の通常のタスク（追いのターン・作り直しは除く）。担当が止まったか・終わったかの判断に使う */
export function listLatestMemberTasks(db: WsDb, askId: Uuid): TaskRow[] {
  return all<TaskRow & { rn: number }>(
    db,
    CODECS.tasks,
    `SELECT * FROM (
       SELECT t.*, row_number() OVER (PARTITION BY t.ask_member_id ORDER BY t.created_at DESC, t.id DESC) AS rn
         FROM tasks t
        WHERE t.ask_id = ? AND t.kind = 'normal' AND t.ask_member_id IS NOT NULL
     ) WHERE rn = 1
     ORDER BY ask_member_id`,
    askId,
  ).map(({ rn: _rn, ...t }) => t);
}

/** 連絡を渡し終えたことを記録する（tasks.input_message_ids の後ろに足す。同じ連絡を2度渡さない） */
export function markMessagesDelivered(db: WsDb, taskId: Uuid, messageIds: readonly Uuid[], now: Date): void {
  if (messageIds.length === 0) return;
  db.transaction(() => {
    const cur = one<{ input_message_ids: Uuid[] }>(db, CODECS.tasks, "SELECT input_message_ids FROM tasks WHERE id = ?", taskId);
    if (!cur) return;
    run(db, "UPDATE tasks SET input_message_ids = ?, updated_at = ? WHERE id = ?", [...cur.input_message_ids, ...messageIds], now, taskId);
  });
}
