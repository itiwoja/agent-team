// gateway（apps/gateway。書き込みの唯一の出口）が使う問い合わせ（MT §3.12、IA §3.12・3.13・3.17、AS §3.17、SO §3.10・3.14）。
// 入口の引き直し（タスクのトークン・Intent の ID・コネクタの ID からワークスペースを引く）だけはワークスペースで絞れない。
// それが WsCtx の出どころ（README §1 の2、15:486）で、リクエストの workspace_id は使わない。
// それ以外はすべて WsCtx で絞る。ロックの順はワークスペース → タスク → 承認 → Intent（M-21・SO §3.14）。
// 外部（MCP サーバー）はここから呼ばない（G-14：接続を握ったまま待たない）

import { KERNEL_VERSION, hashCanonical, nextTaskStatus, type TaskStatus } from "@open-team/kernel";
import { appendAuditLog } from "../audit.ts";
import type { Queryable, Tx } from "../client.ts";
import { hashTaskToken } from "../session.ts";
import type {
  ActionIntentRow,
  ActorType,
  ApprovalRow,
  ConnectorRow,
  ConnectorToolRow,
  IntentExpireReason,
  IntentFailReason,
  IntentStatus,
  Json,
  JsonObject,
  PolicyDecisionRow,
  ToolHash,
  Uuid,
  WorkspaceKind,
} from "../types.ts";
import type { WsCtx } from "../workspace.ts";

/** gateway が監査ログ・事象に書く行為者（actor_type = system） */
export const GATEWAY_ACTOR = { actorType: "system" as ActorType, actorId: "gateway" } as const;

/** タスクのトークンの長さの上限（ヘッダーに長い値を載せられても DB に投げない） */
export const TASK_TOKEN_MAX_LENGTH = 512;

const TERMINAL: readonly TaskStatus[] = ["succeeded", "completed", "rejected", "failed", "cancelled", "halted"];

// ===================================================================
// 1. 入口の引き直し（ワークスペースを引く）
// ===================================================================

/** タスクのトークンから引き直したタスク（SO §3.10 の TaskContext。M-58 で TaskAuth と呼ぶもの） */
export interface GatewayTask {
  readonly ctx: WsCtx;
  readonly taskId: Uuid;
  readonly jobId: Uuid;
  readonly agentId: Uuid;
  readonly status: TaskStatus;
  readonly isDryRun: boolean;
  readonly killSwitchEngaged: boolean;
}

export type TaskTokenResolution =
  | { ok: true; task: GatewayTask }
  | { ok: false; error: "UNAUTHORIZED" }
  /** 終了状態・Kill Switch（409 TASK_HALTED：AS §3.17 EP-49 の1） */
  | { ok: false; error: "TASK_HALTED"; haltReason: "kill_switch" | "task_terminated"; task: GatewayTask };

interface TaskJoinRow {
  id: Uuid;
  workspace_id: Uuid;
  kind: WorkspaceKind;
  job_id: Uuid;
  agent_id: Uuid;
  status: TaskStatus;
  is_dry_run: boolean;
  kill_switch_engaged: boolean;
}

/**
 * X-Task-Token からタスクを引き直す（SO §3.10 resolveTaskByToken、DB §4.1 の3）。
 * 空・長すぎる・知らない・期限切れ（期限ちょうども無効）→ UNAUTHORIZED、Kill Switch・終了状態 → TASK_HALTED
 */
export async function resolveTaskByToken(q: Queryable, rawToken: string | null | undefined, now: Date): Promise<TaskTokenResolution> {
  if (typeof rawToken !== "string" || rawToken.trim() === "" || rawToken.length > TASK_TOKEN_MAX_LENGTH) {
    return { ok: false, error: "UNAUTHORIZED" };
  }
  const r = await q.query<TaskJoinRow>(
    `SELECT t.id, t.workspace_id, w.kind, t.job_id, t.agent_id, t.status, t.is_dry_run, w.kill_switch_engaged
       FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.task_token_hash = $1 AND t.task_token_expires_at > $2`,
    [hashTaskToken(rawToken), now],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, error: "UNAUTHORIZED" };
  const task: GatewayTask = {
    ctx: { workspaceId: row.workspace_id, kind: row.kind, userId: null },
    taskId: row.id,
    jobId: row.job_id,
    agentId: row.agent_id,
    status: row.status,
    isDryRun: row.is_dry_run,
    killSwitchEngaged: row.kill_switch_engaged,
  };
  if (row.kill_switch_engaged) return { ok: false, error: "TASK_HALTED", haltReason: "kill_switch", task };
  if (TERMINAL.includes(row.status)) return { ok: false, error: "TASK_HALTED", haltReason: "task_terminated", task };
  return { ok: true, task };
}

/**
 * Intent の ID からワークスペースとタスクを引く（EP-50。IA §8-23：実行はタスクのトークンを使わず Intent の行から引き直す）。
 * ロックは取らない（このあと M-21 の順でワークスペースから取り直す）
 */
export async function locateIntent(q: Queryable, intentId: Uuid): Promise<{ ctx: WsCtx; taskId: Uuid } | null> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind; task_id: Uuid }>(
    `SELECT i.workspace_id, w.kind, i.task_id FROM action_intents i JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = $1`,
    [intentId],
  );
  const row = r.rows[0];
  return row ? { ctx: { workspaceId: row.workspace_id, kind: row.kind, userId: null }, taskId: row.task_id } : null;
}

/** コネクタの ID からワークスペースを引く（EP-51。本文を持たないので行から引き直す） */
export async function locateConnector(q: Queryable, connectorId: Uuid): Promise<{ ctx: WsCtx } | null> {
  const r = await q.query<{ workspace_id: Uuid; kind: WorkspaceKind }>(
    `SELECT c.workspace_id, w.kind FROM connectors c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = $1`,
    [connectorId],
  );
  const row = r.rows[0];
  return row ? { ctx: { workspaceId: row.workspace_id, kind: row.kind, userId: null } } : null;
}

// ===================================================================
// 2. コネクタとツール（読むだけ）
// ===================================================================

/** 自分のワークスペースのコネクタ（別のワークスペースの ID は null） */
export async function getConnector(q: Queryable, ctx: WsCtx, connectorId: Uuid): Promise<ConnectorRow | null> {
  const r = await q.query<ConnectorRow>("SELECT * FROM connectors WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, connectorId]);
  return r.rows[0] ?? null;
}

export async function getConnectorTool(q: Queryable, ctx: WsCtx, connectorId: Uuid, name: string): Promise<ConnectorToolRow | null> {
  const r = await q.query<ConnectorToolRow>("SELECT * FROM connector_tools WHERE workspace_id = $1 AND connector_id = $2 AND name = $3", [
    ctx.workspaceId,
    connectorId,
    name,
  ]);
  return r.rows[0] ?? null;
}

export async function listConnectorTools(q: Queryable, ctx: WsCtx, connectorId: Uuid): Promise<ConnectorToolRow[]> {
  const r = await q.query<ConnectorToolRow>("SELECT * FROM connector_tools WHERE workspace_id = $1 AND connector_id = $2 ORDER BY name", [
    ctx.workspaceId,
    connectorId,
  ]);
  return r.rows;
}

// ===================================================================
// 3. 実行（EP-50）のロックと状態の遷移
// ===================================================================

/** gateway が見るタスクの列（報告の本文などは読まない） */
export interface GatewayTaskRow {
  id: Uuid;
  workspace_id: Uuid;
  job_id: Uuid;
  agent_id: Uuid;
  status: TaskStatus;
  is_dry_run: boolean;
  halt_reason: string | null;
}

const TASK_COLUMNS = "id, workspace_id, job_id, agent_id, status, is_dry_run, halt_reason";

/** タスクを FOR UPDATE で取る（ワークスペースの行を取ったあとに呼ぶ：M-21） */
export async function lockTask(tx: Tx, ctx: WsCtx, taskId: Uuid): Promise<GatewayTaskRow | null> {
  const r = await tx.query<GatewayTaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $2 AND workspace_id = $1 FOR UPDATE`, [
    ctx.workspaceId,
    taskId,
  ]);
  return r.rows[0] ?? null;
}

export async function getIntent(q: Queryable, ctx: WsCtx, intentId: Uuid): Promise<ActionIntentRow | null> {
  const r = await q.query<ActionIntentRow>("SELECT * FROM action_intents WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, intentId]);
  return r.rows[0] ?? null;
}

/** Intent を FOR UPDATE で取る（タスクのあと：M-21） */
export async function lockIntent(tx: Tx, ctx: WsCtx, intentId: Uuid): Promise<ActionIntentRow | null> {
  const r = await tx.query<ActionIntentRow>("SELECT * FROM action_intents WHERE id = $2 AND workspace_id = $1 FOR UPDATE", [
    ctx.workspaceId,
    intentId,
  ]);
  return r.rows[0] ?? null;
}

/** approved → executing（IA §3.12 の2-7。approved のときだけ。二重のジョブの片方だけが送る：G-3） */
export async function markIntentExecuting(tx: Tx, ctx: WsCtx, intentId: Uuid, now: Date): Promise<boolean> {
  const r = await tx.query(
    "UPDATE action_intents SET status = 'executing', updated_at = $3 WHERE id = $2 AND workspace_id = $1 AND status = 'approved'",
    [ctx.workspaceId, intentId, now],
  );
  return r.rowCount === 1;
}

/** 送信前の失敗の再試行の上限（BR-59・D-18。初回＋再試行3回。presend_attempts の CHECK は 0〜3） */
export const PRESEND_RETRY_MAX = 3;

export type PresendFailureResult =
  /** approved に戻した（再試行できる）。attempts は数えた後の値 */
  | { retry: true; attempts: number }
  /** 上限に達したので failed(unreachable) にした */
  | { retry: false; attempts: number }
  /** from の状態でなかった（別の処理が先に変えた） */
  | { retry: false; attempts: number; skipped: true };

/**
 * 送信前の失敗を数える（D-18）。presend_attempts < 3 なら approved に戻して +1、そうでなければ failed(unreachable)。
 * from は今の状態（tools/call の前の失敗は approved のまま、tools/call の送信前の失敗は executing）
 */
export async function recordPresendFailure(
  tx: Tx,
  ctx: WsCtx,
  intentId: Uuid,
  from: "approved" | "executing",
  detail: JsonObject,
  now: Date,
): Promise<PresendFailureResult> {
  const cur = await tx.query<{ presend_attempts: number; status: IntentStatus }>(
    "SELECT presend_attempts, status FROM action_intents WHERE id = $2 AND workspace_id = $1 FOR UPDATE",
    [ctx.workspaceId, intentId],
  );
  const row = cur.rows[0];
  if (!row || row.status !== from) return { retry: false, attempts: row?.presend_attempts ?? 0, skipped: true };
  if (row.presend_attempts < PRESEND_RETRY_MAX) {
    const attempts = row.presend_attempts + 1;
    await tx.query(
      "UPDATE action_intents SET status = 'approved', presend_attempts = $3, updated_at = $4 WHERE id = $2 AND workspace_id = $1",
      [ctx.workspaceId, intentId, attempts, now],
    );
    return { retry: true, attempts };
  }
  await tx.query(
    `UPDATE action_intents SET status = 'failed', fail_reason = 'unreachable', result = $3::jsonb, updated_at = $4
      WHERE id = $2 AND workspace_id = $1`,
    [ctx.workspaceId, intentId, detail, now],
  );
  return { retry: false, attempts: row.presend_attempts };
}

export type IntentCompletion =
  | { status: "executed"; result: Json }
  | { status: "failed"; failReason: IntentFailReason; result: Json }
  | { status: "unknown_outcome"; result: Json }
  | { status: "expired"; expireReason: IntentExpireReason; result: Json | null };

/**
 * Intent の最後の状態を書く（IA §3.12 の4 の表・§3.12 の2 の前提の外れ）。from のどれかの状態のときだけ書き、書けたら true。
 * executed は executed_at = now。result は 64KB で切ってマスクした値を呼び出し側が渡す（A-86）
 */
export async function completeIntent(
  tx: Tx,
  ctx: WsCtx,
  intentId: Uuid,
  from: readonly IntentStatus[],
  c: IntentCompletion,
  now: Date,
): Promise<boolean> {
  const failReason = c.status === "failed" ? c.failReason : null;
  const expireReason = c.status === "expired" ? c.expireReason : null;
  const r = await tx.query(
    `UPDATE action_intents
        SET status = $3, fail_reason = $4, expire_reason = $5, result = COALESCE($6::jsonb, result),
            executed_at = CASE WHEN $3 = 'executed' THEN $7::timestamptz ELSE executed_at END, updated_at = $7
      WHERE id = $2 AND workspace_id = $1 AND status = ANY($8::text[])`,
    [ctx.workspaceId, intentId, c.status, failReason, expireReason, c.result, now, [...from]],
  );
  return r.rowCount === 1;
}

// ===================================================================
// 4. タスクの状態の決め直し（IA §3.18。kernel の nextTaskStatus）
// ===================================================================

export interface TaskStatusChange {
  changed: boolean;
  from: TaskStatus;
  to: TaskStatus;
  /** 今回終了状態になった */
  terminal: boolean;
}

/**
 * Intent の状態が変わったあとにタスクの状態を決め直す（IA §3.18 の4）。タスクの行は呼び出し側がロック済み（M-21）。
 * gateway はエージェントのループの終わりを知らないので loopEnded = false（awaiting_approval・executing はループが終わった扱い）。
 * 終了状態にしたら finished_at・status_detail・fail_reason、トークンの失効（SO §3.10）、task_events の status_changed・finished、
 * 監査ログ task.status_changed。依頼の回答・順番の次の段は app が行う
 */
export async function recomputeTaskStatus(tx: Tx, ctx: WsCtx, taskId: Uuid, now: Date): Promise<TaskStatusChange | null> {
  const t = (
    await tx.query<{ status: TaskStatus; is_dry_run: boolean }>(
      "SELECT status, is_dry_run FROM tasks WHERE id = $2 AND workspace_id = $1",
      [ctx.workspaceId, taskId],
    )
  ).rows[0];
  if (!t) return null;
  const intents = (
    await tx.query<{ status: IntentStatus }>("SELECT status FROM action_intents WHERE task_id = $2 AND workspace_id = $1", [
      ctx.workspaceId,
      taskId,
    ])
  ).rows;
  const next = nextTaskStatus({ status: t.status, loopEnded: false, isDryRun: t.is_dry_run, intents });
  if (next.status === t.status) return { changed: false, from: t.status, to: t.status, terminal: false };

  const ending = next.ending;
  const detail = ending?.status === "completed" ? ending.detail : null;
  const failReason = ending?.status === "failed" ? ending.failReason : null;
  const r = ending
    ? await tx.query(
        `UPDATE tasks SET status = $3, status_detail = $4, fail_reason = $5, finished_at = $6, updated_at = $6,
                task_token_hash = NULL, task_token_expires_at = NULL
          WHERE id = $2 AND workspace_id = $1 AND status = $7`,
        [ctx.workspaceId, taskId, next.status, detail, failReason, now, t.status],
      )
    : await tx.query("UPDATE tasks SET status = $3, updated_at = $4 WHERE id = $2 AND workspace_id = $1 AND status = $5", [
        ctx.workspaceId,
        taskId,
        next.status,
        now,
        t.status,
      ]);
  if (r.rowCount !== 1) return { changed: false, from: t.status, to: t.status, terminal: false };

  await tx.query("INSERT INTO task_events (workspace_id, task_id, type, payload, created_at) VALUES ($1, $2, 'status_changed', $3, $4)", [
    ctx.workspaceId,
    taskId,
    { from: t.status, to: next.status, ...(detail ? { detail } : {}), ...(failReason ? { failReason } : {}) },
    now,
  ]);
  if (ending) {
    await tx.query("INSERT INTO task_events (workspace_id, task_id, type, payload, created_at) VALUES ($1, $2, 'finished', $3, $4)", [
      ctx.workspaceId,
      taskId,
      { outcome: next.status, ...(detail ? { detail } : {}), ...(failReason ? { failReason } : {}) },
      now,
    ]);
  }
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "task.status_changed",
      ...GATEWAY_ACTOR,
      taskId,
      payload: { taskId, from: t.status, to: next.status, ...(detail ? { detail } : {}), ...(failReason ? { failReason } : {}) },
    },
    now,
  );
  return { changed: true, from: t.status, to: next.status, terminal: ending !== null };
}

// ===================================================================
// 5. ツールの変化（MT §3.12.4・3.12.7、IA §3.17）
// ===================================================================

/** tools/list から読んだ1件（注釈は保存して提案に使うだけ。ハッシュ・比較に入れない：ADR-022） */
export interface ToolDefinitionInput {
  name: string;
  description: string;
  inputSchema: Json;
  annotations: Json | null;
}

/** 新しいツールを unclassified・ok・役割なしで足す（MT §3.12.4 の3） */
export async function insertConnectorTool(
  tx: Tx,
  ctx: WsCtx,
  connectorId: Uuid,
  def: ToolDefinitionInput,
  toolHash: ToolHash,
  now: Date,
): Promise<Uuid> {
  const r = await tx.query<{ id: Uuid }>(
    `INSERT INTO connector_tools (workspace_id, connector_id, name, description, input_schema, annotations, classification, status,
                                  arg_roles, scope, verify, tool_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'unclassified', 'ok', '{}', NULL, 'none', $7, $8, $8) RETURNING id`,
    [ctx.workspaceId, connectorId, def.name, def.description, def.inputSchema, def.annotations, toolHash, now],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("ツールを足せなかった");
  return id;
}

/**
 * needs_review にする（MT §3.12.4 の4・5）。確定した description・input_schema・tool_hash は書き換えない。
 * pending は新しい定義、一覧から消えたツールは null（消えた印）
 */
export async function markToolNeedsReview(
  tx: Tx,
  ctx: WsCtx,
  toolId: Uuid,
  pending: { description: string; inputSchema: Json; annotations: Json | null; detectedAt: string } | null,
  now: Date,
): Promise<void> {
  await tx.query("UPDATE connector_tools SET status = 'needs_review', pending = $3::jsonb, updated_at = $4 WHERE id = $2 AND workspace_id = $1", [
    ctx.workspaceId,
    toolId,
    pending,
    now,
  ]);
}

/** 注釈だけの変化（needs_review にしない：MT DR-04） */
export async function updateToolAnnotations(tx: Tx, ctx: WsCtx, toolId: Uuid, annotations: Json | null, now: Date): Promise<void> {
  await tx.query("UPDATE connector_tools SET annotations = $3::jsonb, updated_at = $4 WHERE id = $2 AND workspace_id = $1", [
    ctx.workspaceId,
    toolId,
    annotations,
    now,
  ]);
}

export async function markConnectorSynced(tx: Tx, ctx: WsCtx, connectorId: Uuid, now: Date): Promise<void> {
  await tx.query("UPDATE connectors SET last_synced_at = $3, updated_at = $3 WHERE id = $2 AND workspace_id = $1", [
    ctx.workspaceId,
    connectorId,
    now,
  ]);
}

export interface ExpiredIntent {
  intentId: Uuid;
  taskId: Uuid;
  /** 承認待ちだったときの承認（expired にした） */
  approvalId: Uuid | null;
}

/**
 * そのツールの承認待ち（pending_approval）と、まだ executing でない approved の Intent を expired（tool_changed）にする
 * （MT §3.12.7、IA §3.17、X-10。executing はそのまま）。承認待ちの承認も expired。
 * ワークスペースの行は呼び出し側がロック済み。ここでタスク → 承認 → Intent の順に取る（M-21）。通知は送らない（MT §3.12.7 の2）
 */
export async function expireIntentsForTool(
  tx: Tx,
  ctx: WsCtx,
  tool: { connectorId: Uuid; name: string },
  now: Date,
): Promise<ExpiredIntent[]> {
  const cand = await tx.query<{ id: Uuid; task_id: Uuid }>(
    `SELECT i.id, i.task_id FROM action_intents i
      WHERE i.workspace_id = $1 AND i.connector_id = $2 AND i.payload->>'tool' = $3
        AND i.status IN ('pending_approval', 'approved')`,
    [ctx.workspaceId, tool.connectorId, tool.name],
  );
  if (cand.rows.length === 0) return [];
  const intentIds = cand.rows.map((r) => r.id);
  const taskIds = [...new Set(cand.rows.map((r) => r.task_id))].sort();
  await tx.query("SELECT id FROM tasks WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE", [ctx.workspaceId, taskIds]);
  const approvals = await tx.query<{ id: Uuid; intent_id: Uuid }>(
    `UPDATE approvals SET status = 'expired', updated_at = $3
      WHERE workspace_id = $1 AND intent_id = ANY($2::uuid[]) AND status = 'pending' RETURNING id, intent_id`,
    [ctx.workspaceId, intentIds, now],
  );
  const approvalOf = new Map(approvals.rows.map((a) => [a.intent_id, a.id]));
  const expired = await tx.query<{ id: Uuid; task_id: Uuid }>(
    `UPDATE action_intents SET status = 'expired', expire_reason = 'tool_changed', result = $3::jsonb, updated_at = $4
      WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND status IN ('pending_approval', 'approved') RETURNING id, task_id`,
    [ctx.workspaceId, intentIds, { reasonCode: "tool_changed", tool: tool.name }, now],
  );
  const out = expired.rows
    .map((r) => ({ intentId: r.id, taskId: r.task_id, approvalId: approvalOf.get(r.id) ?? null }))
    .sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0));
  for (const e of out) {
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      e.approvalId
        ? {
            eventType: "approval.expired",
            ...GATEWAY_ACTOR,
            taskId: e.taskId,
            payload: { approvalId: e.approvalId, intentId: e.intentId, taskId: e.taskId, reason: "tool_changed" },
          }
        : { eventType: "intent.expired", ...GATEWAY_ACTOR, taskId: e.taskId, payload: { intentId: e.intentId, taskId: e.taskId, reason: "tool_changed" } },
      now,
    );
  }
  for (const taskId of taskIds) await recomputeTaskStatus(tx, ctx, taskId, now);
  return out;
}

// ===================================================================
// 6. gateway の判定の記録（境界・説明の変化。MT §3.12.2・D-14）
// ===================================================================

export interface GatewayDecisionInput {
  taskId: Uuid;
  intentId: Uuid | null;
  subjectKind: "tool_call" | "intent";
  /** DecideResult.operation と同じ列（M-15） */
  operation: "mcp_read" | "mcp_write";
  /** 何を止めたか（action・connectorId・tool など。引数は入れない：Intent の行にある） */
  subject: JsonObject;
  /** 判定の入力（境界の入力など。flags 列に入れる：NFR-036） */
  inputs: JsonObject;
  reasonCode: string;
  /** 'boundary.<code>'・'gateway.tool_changed' など */
  matchedRule: string;
  /** 判定どおりに効かせたか（今は常に true。0024 より前の影の走行の行だけ false） */
  enforced: boolean;
}

/**
 * Kernel の外の拒否を policy_decisions（decision = deny）と監査ログ decision.made に残す（MT §3.12.2・D-14：「誰が止めたか」に出す）。
 * 入力のハッシュは同じ正規形 JSON の関数で（M-08）
 */
export async function recordGatewayDecision(tx: Tx, ctx: WsCtx, d: GatewayDecisionInput, now: Date): Promise<void> {
  const inputsHash = hashCanonical({ gate: "gateway", subject: d.subject, inputs: d.inputs });
  await tx.query(
    `INSERT INTO policy_decisions (workspace_id, task_id, intent_id, subject_kind, action_type, subject, counters, flags, decision,
                                   reason_code, matched_rule, enforced, inputs_hash, kernel_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}', $7::jsonb, 'deny', $8, $9, $10, $11, $12, $13)`,
    [
      ctx.workspaceId,
      d.taskId,
      d.intentId,
      d.subjectKind,
      d.operation,
      { gate: "gateway", ...d.subject },
      d.inputs,
      d.reasonCode,
      d.matchedRule,
      d.enforced,
      inputsHash,
      KERNEL_VERSION,
      now,
    ],
  );
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "decision.made",
      ...GATEWAY_ACTOR,
      taskId: d.taskId,
      payload: {
        taskId: d.taskId,
        ...(d.intentId ? { intentId: d.intentId } : {}),
        decision: "deny",
        reasonCode: d.reasonCode,
        matchedRule: d.matchedRule,
        enforced: d.enforced,
        source: "gateway",
        ...d.subject,
      },
    },
    now,
  );
}

// ===================================================================
// 7. 承認の出どころ（SG-03：docs/design/17_security_governance.md）。実行の前に「判定が実際に行われた証拠」を読む。
// gateway は decide を呼ばない（M-20）。ここは読むだけで、照合は apps/gateway の provenance.ts が行う
// ===================================================================

/**
 * その Intent への Kernel の判定の行（edge の LLM Proxy が decide の結果を記録したもの）。古い順。
 * gateway 自身が書いた拒否の記録（recordGatewayDecision：subject.gate = 'gateway'）は Kernel の判定ではないので入れない
 */
export async function listKernelDecisionsOfIntent(q: Queryable, ctx: WsCtx, intent: Pick<ActionIntentRow, "id" | "task_id">): Promise<PolicyDecisionRow[]> {
  const r = await q.query<PolicyDecisionRow>(
    `SELECT * FROM policy_decisions
      WHERE workspace_id = $1 AND intent_id = $2 AND task_id = $3 AND (subject->>'gate') IS DISTINCT FROM 'gateway'
      ORDER BY created_at, id`,
    [ctx.workspaceId, intent.id, intent.task_id],
  );
  return r.rows;
}

/** その Intent の承認の行（intent_id は一意：approvals_intent_uq）。なければ null。ロックはしない（読むだけ） */
export async function getApprovalOfIntent(q: Queryable, ctx: WsCtx, intentId: Uuid): Promise<ApprovalRow | null> {
  const r = await q.query<ApprovalRow>("SELECT * FROM approvals WHERE workspace_id = $1 AND intent_id = $2", [ctx.workspaceId, intentId]);
  return r.rows[0] ?? null;
}

/**
 * 照合に使う監査ログの行。audit_logs は ot_app でも追記しかできず（UPDATE・DELETE はロールとトリガーで拒否）、seq はワークスペースごとの
 * 詰まった連番なので、「すでに起きたこと」と「起きた順番」の証拠になる（前に割り込めない・消せない）
 */
export interface ProvenanceAuditEvent {
  seq: number;
  occurred_at: Date;
  event_type: string;
  actor_type: ActorType;
  actor_id: string | null;
  payload: JsonObject;
}

/**
 * そのタスクの監査ログ（タスクの索引で引く）。seq の順。Intent の提案・判定・承認の要求と決定・実行の開始と終わり・失効・
 * タスクの状態の変化は、どれも taskId つきで書かれる（edge の recordMcpIntent・recordDecision、app の API-019・見回り、gateway）
 */
export async function listTaskAuditEvents(q: Queryable, ctx: WsCtx, taskId: Uuid): Promise<ProvenanceAuditEvent[]> {
  const r = await q.query<ProvenanceAuditEvent>(
    `SELECT seq, occurred_at, event_type, actor_type, actor_id, payload FROM audit_logs
      WHERE workspace_id = $1 AND task_id = $2 ORDER BY seq`,
    [ctx.workspaceId, taskId],
  );
  return r.rows;
}

/** ワークスペースの Kill Switch の発動（killswitch.engaged）の seq。古い順。発動は未実行の Intent と承認待ちを一括で失効させる（行ごとの監査ログはない） */
export async function listKillSwitchEngagedSeqs(q: Queryable, ctx: WsCtx): Promise<number[]> {
  const r = await q.query<{ seq: number }>(
    "SELECT seq FROM audit_logs WHERE workspace_id = $1 AND event_type = 'killswitch.engaged' ORDER BY seq",
    [ctx.workspaceId],
  );
  return r.rows.map((x) => x.seq);
}

