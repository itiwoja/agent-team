// packages/db/src/repo/gateway.ts の WorkspaceDO 版。
// gateway（書き込みの唯一の出口）が使う問い合わせ（MT §3.12、IA §3.12・3.13・3.17、AS §3.17、SO §3.10・3.14）。
// - 入口の引き直し（タスクのトークン・Intent の ID・コネクタの ID）は、この DO の中の行から引き直す。どの DO に送るかは Worker が決める。
//   リクエストに載った値（タスクの ID など）は使わない
// - ロックの順（M-21）・FOR UPDATE は要らない（DO の中は1本の流れ）。読んで判断して書く所は db.transaction で包む
// - 外部（MCP サーバー）はここから呼ばない（G-14：トランザクションの中で待たない）

import { KERNEL_VERSION, hashCanonical, nextTaskStatus, type TaskStatus } from "@open-team/kernel";
import { appendAuditLog } from "../audit.ts";
import { CODECS } from "../codecs.ts";
import { all, newId, one, run, type WsDb } from "../sqlite.ts";
import { hashTaskToken } from "../tokens.ts";
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
} from "../types.ts";
import { requireWorkspace } from "../workspace.ts";

/** gateway が監査ログ・事象に書く行為者（actor_type = system） */
export const GATEWAY_ACTOR = { actorType: "system" as ActorType, actorId: "gateway" } as const;

/** タスクのトークンの長さの上限（ヘッダーに長い値を載せられても DB に投げない） */
export const TASK_TOKEN_MAX_LENGTH = 512;

const TERMINAL: readonly TaskStatus[] = ["succeeded", "completed", "rejected", "failed", "cancelled", "halted"];

/** JSON の列に入れる値（文字列・数も JSON にする。sqlite.ts は文字列をそのまま渡すため） */
function jsonParam(v: Json | null): string | null {
  return v === null ? null : JSON.stringify(v);
}

// ===================================================================
// 1. 入口の引き直し
// ===================================================================

/** タスクのトークンから引き直したタスク（SO §3.10 の TaskContext。M-58 で TaskAuth と呼ぶもの） */
export interface GatewayTask {
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

/**
 * X-Task-Token からタスクを引き直す（SO §3.10 resolveTaskByToken、DB §4.1 の3）。
 * 空・長すぎる・知らない・期限切れ（期限ちょうども無効）→ UNAUTHORIZED、Kill Switch・終了状態 → TASK_HALTED
 */
export function resolveTaskByToken(db: WsDb, rawToken: string | null | undefined, now: Date): TaskTokenResolution {
  if (typeof rawToken !== "string" || rawToken.trim() === "" || rawToken.length > TASK_TOKEN_MAX_LENGTH) {
    return { ok: false, error: "UNAUTHORIZED" };
  }
  const row = one<{ id: Uuid; job_id: Uuid; agent_id: Uuid; status: TaskStatus; is_dry_run: boolean }>(
    db,
    CODECS.tasks,
    "SELECT id, job_id, agent_id, status, is_dry_run FROM tasks WHERE task_token_hash = ? AND task_token_expires_at > ?",
    hashTaskToken(rawToken),
    now,
  );
  if (!row) return { ok: false, error: "UNAUTHORIZED" };
  const ws = requireWorkspace(db);
  const task: GatewayTask = {
    taskId: row.id,
    jobId: row.job_id,
    agentId: row.agent_id,
    status: row.status,
    isDryRun: row.is_dry_run,
    killSwitchEngaged: ws.kill_switch_engaged,
  };
  if (ws.kill_switch_engaged) return { ok: false, error: "TASK_HALTED", haltReason: "kill_switch", task };
  if (TERMINAL.includes(row.status)) return { ok: false, error: "TASK_HALTED", haltReason: "task_terminated", task };
  return { ok: true, task };
}

/** Intent の ID からタスクを引く（EP-50。IA §8-23：実行はタスクのトークンを使わず Intent の行から引き直す） */
export function locateIntent(db: WsDb, intentId: Uuid): { taskId: Uuid } | null {
  const row = one<{ task_id: Uuid }>(db, {}, "SELECT task_id FROM action_intents WHERE id = ?", intentId);
  return row ? { taskId: row.task_id } : null;
}

/** コネクタの ID がこのワークスペースにあるか（EP-51。本文を持たないので行から引き直す） */
export function locateConnector(db: WsDb, connectorId: Uuid): { connectorId: Uuid } | null {
  const row = one<{ id: Uuid }>(db, {}, "SELECT id FROM connectors WHERE id = ?", connectorId);
  return row ? { connectorId: row.id } : null;
}

// ===================================================================
// 2. コネクタとツール（読むだけ）
// ===================================================================

export function getConnector(db: WsDb, connectorId: Uuid): ConnectorRow | null {
  return one<ConnectorRow>(db, CODECS.connectors, "SELECT * FROM connectors WHERE id = ?", connectorId);
}

export function getConnectorTool(db: WsDb, connectorId: Uuid, name: string): ConnectorToolRow | null {
  return one<ConnectorToolRow>(db, CODECS.connector_tools, "SELECT * FROM connector_tools WHERE connector_id = ? AND name = ?", connectorId, name);
}

export function listConnectorTools(db: WsDb, connectorId: Uuid): ConnectorToolRow[] {
  return all<ConnectorToolRow>(db, CODECS.connector_tools, "SELECT * FROM connector_tools WHERE connector_id = ? ORDER BY name", connectorId);
}

// ===================================================================
// 3. 実行（EP-50）の状態の遷移
// ===================================================================

/** gateway が見るタスクの列（報告の本文などは読まない） */
export interface GatewayTaskRow {
  id: Uuid;
  job_id: Uuid;
  agent_id: Uuid;
  status: TaskStatus;
  is_dry_run: boolean;
  halt_reason: string | null;
}

const TASK_COLUMNS = "id, job_id, agent_id, status, is_dry_run, halt_reason";

/** タスクを読む（Postgres 版の FOR UPDATE の代わり。DO の中は1本の流れなのでロックは要らない） */
export function lockTask(db: WsDb, taskId: Uuid): GatewayTaskRow | null {
  return one<GatewayTaskRow>(db, CODECS.tasks, `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, taskId);
}

export function getIntent(db: WsDb, intentId: Uuid): ActionIntentRow | null {
  return one<ActionIntentRow>(db, CODECS.action_intents, "SELECT * FROM action_intents WHERE id = ?", intentId);
}

/** Intent を読む（Postgres 版の FOR UPDATE の代わり。getIntent と同じ） */
export function lockIntent(db: WsDb, intentId: Uuid): ActionIntentRow | null {
  return getIntent(db, intentId);
}

/** approved → executing（IA §3.12 の2-7。approved のときだけ。二重のジョブの片方だけが送る：G-3） */
export function markIntentExecuting(db: WsDb, intentId: Uuid, now: Date): boolean {
  return run(db, "UPDATE action_intents SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'approved'", now, intentId) === 1;
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
export function recordPresendFailure(
  db: WsDb,
  intentId: Uuid,
  from: "approved" | "executing",
  detail: JsonObject,
  now: Date,
): PresendFailureResult {
  return db.transaction(() => {
    const row = one<{ presend_attempts: number; status: IntentStatus }>(db, {}, "SELECT presend_attempts, status FROM action_intents WHERE id = ?", intentId);
    if (!row || row.status !== from) return { retry: false, attempts: row?.presend_attempts ?? 0, skipped: true };
    if (row.presend_attempts < PRESEND_RETRY_MAX) {
      const attempts = row.presend_attempts + 1;
      run(db, "UPDATE action_intents SET status = 'approved', presend_attempts = ?, updated_at = ? WHERE id = ?", attempts, now, intentId);
      return { retry: true, attempts };
    }
    run(
      db,
      "UPDATE action_intents SET status = 'failed', fail_reason = 'unreachable', result = ?, updated_at = ? WHERE id = ?",
      jsonParam(detail),
      now,
      intentId,
    );
    return { retry: false, attempts: row.presend_attempts };
  });
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
export function completeIntent(db: WsDb, intentId: Uuid, from: readonly IntentStatus[], c: IntentCompletion, now: Date): boolean {
  const failReason = c.status === "failed" ? c.failReason : null;
  const expireReason = c.status === "expired" ? c.expireReason : null;
  return (
    run(
      db,
      `UPDATE action_intents
          SET status = ?1, fail_reason = ?2, expire_reason = ?3, result = COALESCE(?4, result),
              executed_at = CASE WHEN ?1 = 'executed' THEN ?5 ELSE executed_at END, updated_at = ?5
        WHERE id = ?6 AND status IN (SELECT value FROM json_each(?7))`,
      c.status,
      failReason,
      expireReason,
      jsonParam(c.result),
      now,
      intentId,
      [...from],
    ) === 1
  );
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
 * Intent の状態が変わったあとにタスクの状態を決め直す（IA §3.18 の4）。
 * gateway はエージェントのループの終わりを知らないので loopEnded = false（awaiting_approval・executing はループが終わった扱い）。
 * 終了状態にしたら finished_at・status_detail・fail_reason、トークンの失効（SO §3.10）、task_events の status_changed・finished、
 * 監査ログ task.status_changed。依頼の回答・順番の次の段は app が行う
 */
export function recomputeTaskStatus(db: WsDb, taskId: Uuid, now: Date): TaskStatusChange | null {
  return db.transaction(() => {
    const t = one<{ status: TaskStatus; is_dry_run: boolean }>(db, CODECS.tasks, "SELECT status, is_dry_run FROM tasks WHERE id = ?", taskId);
    if (!t) return null;
    const intents = all<{ status: IntentStatus }>(db, {}, "SELECT status FROM action_intents WHERE task_id = ?", taskId);
    const next = nextTaskStatus({ status: t.status, loopEnded: false, isDryRun: t.is_dry_run, intents });
    if (next.status === t.status) return { changed: false, from: t.status, to: t.status, terminal: false };

    const ending = next.ending;
    const detail = ending?.status === "completed" ? ending.detail : null;
    const failReason = ending?.status === "failed" ? ending.failReason : null;
    const n = ending
      ? run(
          db,
          `UPDATE tasks SET status = ?, status_detail = ?, fail_reason = ?, finished_at = ?, updated_at = ?,
                  task_token_hash = NULL, task_token_expires_at = NULL
            WHERE id = ? AND status = ?`,
          next.status,
          detail,
          failReason,
          now,
          now,
          taskId,
          t.status,
        )
      : run(db, "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?", next.status, now, taskId, t.status);
    if (n !== 1) return { changed: false, from: t.status, to: t.status, terminal: false };

    const extra = { ...(detail ? { detail } : {}), ...(failReason ? { failReason } : {}) };
    run(db, "INSERT INTO task_events (task_id, type, payload, created_at) VALUES (?, 'status_changed', ?, ?)", taskId, { from: t.status, to: next.status, ...extra }, now);
    if (ending) {
      run(db, "INSERT INTO task_events (task_id, type, payload, created_at) VALUES (?, 'finished', ?, ?)", taskId, { outcome: next.status, ...extra }, now);
    }
    appendAuditLog(
      db,
      { eventType: "task.status_changed", ...GATEWAY_ACTOR, taskId, payload: { taskId, from: t.status, to: next.status, ...extra } },
      now,
    );
    return { changed: true, from: t.status, to: next.status, terminal: ending !== null };
  });
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
export function insertConnectorTool(db: WsDb, connectorId: Uuid, def: ToolDefinitionInput, toolHash: ToolHash, now: Date): Uuid {
  const row = one<{ id: Uuid }>(
    db,
    {},
    `INSERT INTO connector_tools (id, connector_id, name, description, input_schema, annotations, classification, status,
                                  arg_roles, scope, verify, tool_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'unclassified', 'ok', '{}', NULL, 'none', ?, ?, ?) RETURNING id`,
    newId(),
    connectorId,
    def.name,
    def.description,
    jsonParam(def.inputSchema),
    jsonParam(def.annotations),
    toolHash,
    now,
    now,
  );
  if (!row) throw new Error("ツールを足せなかった");
  return row.id;
}

/**
 * needs_review にする（MT §3.12.4 の4・5）。確定した description・input_schema・tool_hash は書き換えない。
 * pending は新しい定義、一覧から消えたツールは null（消えた印）
 */
export function markToolNeedsReview(
  db: WsDb,
  toolId: Uuid,
  pending: { description: string; inputSchema: Json; annotations: Json | null; detectedAt: string } | null,
  now: Date,
): void {
  run(db, "UPDATE connector_tools SET status = 'needs_review', pending = ?, updated_at = ? WHERE id = ?", pending, now, toolId);
}

/** 注釈だけの変化（needs_review にしない：MT DR-04） */
export function updateToolAnnotations(db: WsDb, toolId: Uuid, annotations: Json | null, now: Date): void {
  run(db, "UPDATE connector_tools SET annotations = ?, updated_at = ? WHERE id = ?", jsonParam(annotations), now, toolId);
}

export function markConnectorSynced(db: WsDb, connectorId: Uuid, now: Date): void {
  run(db, "UPDATE connectors SET last_synced_at = ?, updated_at = ? WHERE id = ?", now, now, connectorId);
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
 * 監査ログは Intent の ID の順に、承認があれば approval.expired、なければ intent.expired。そのあとタスクの状態を決め直す。
 * 通知は送らない（MT §3.12.7 の2）
 */
export function expireIntentsForTool(db: WsDb, tool: { connectorId: Uuid; name: string }, now: Date): ExpiredIntent[] {
  return db.transaction(() => {
    const cand = all<{ id: Uuid; task_id: Uuid }>(
      db,
      {},
      `SELECT id, task_id FROM action_intents
        WHERE connector_id = ? AND json_extract(payload, '$.tool') = ? AND status IN ('pending_approval', 'approved')`,
      tool.connectorId,
      tool.name,
    );
    if (cand.length === 0) return [];
    const intentIds = cand.map((r) => r.id);
    const taskIds = [...new Set(cand.map((r) => r.task_id))].sort();
    const approvals = all<{ id: Uuid; intent_id: Uuid }>(
      db,
      {},
      `UPDATE approvals SET status = 'expired', updated_at = ?
        WHERE intent_id IN (SELECT value FROM json_each(?)) AND status = 'pending' RETURNING id, intent_id`,
      now,
      intentIds,
    );
    const approvalOf = new Map(approvals.map((a) => [a.intent_id, a.id]));
    const expired = all<{ id: Uuid; task_id: Uuid }>(
      db,
      {},
      `UPDATE action_intents SET status = 'expired', expire_reason = 'tool_changed', result = ?, updated_at = ?
        WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('pending_approval', 'approved') RETURNING id, task_id`,
      { reasonCode: "tool_changed", tool: tool.name },
      now,
      intentIds,
    );
    const out = expired
      .map((r) => ({ intentId: r.id, taskId: r.task_id, approvalId: approvalOf.get(r.id) ?? null }))
      .sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0));
    for (const e of out) {
      appendAuditLog(
        db,
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
    for (const taskId of taskIds) recomputeTaskStatus(db, taskId, now);
    return out;
  });
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
export function recordGatewayDecision(db: WsDb, d: GatewayDecisionInput, now: Date): void {
  const inputsHash = hashCanonical({ gate: "gateway", subject: d.subject, inputs: d.inputs });
  db.transaction(() => {
    run(
      db,
      `INSERT INTO policy_decisions (id, task_id, intent_id, subject_kind, action_type, subject, counters, flags, decision,
                                     reason_code, matched_rule, enforced, inputs_hash, kernel_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 'deny', ?, ?, ?, ?, ?, ?)`,
      newId(),
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
    );
    appendAuditLog(
      db,
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
  });
}

// ===================================================================
// 7. 承認の出どころ（SG-03：docs/design/17_security_governance.md）。実行の前に「判定が実際に行われた証拠」を読む。
// gateway は decide を呼ばない（M-20）。ここは読むだけで、照合は gateway の provenance.ts が行う
// ===================================================================

/**
 * その Intent への Kernel の判定の行（edge の LLM Proxy が decide の結果を記録したもの）。古い順。
 * gateway 自身が書いた拒否の記録（recordGatewayDecision：subject.gate = 'gateway'）は Kernel の判定ではないので入れない
 */
export function listKernelDecisionsOfIntent(db: WsDb, intent: Pick<ActionIntentRow, "id" | "task_id">): PolicyDecisionRow[] {
  return all<PolicyDecisionRow>(
    db,
    CODECS.policy_decisions,
    `SELECT * FROM policy_decisions
      WHERE intent_id = ? AND task_id = ? AND json_extract(subject, '$.gate') IS NOT 'gateway'
      ORDER BY created_at, id`,
    intent.id,
    intent.task_id,
  );
}

/** その Intent の承認の行（intent_id は一意）。なければ null。読むだけ */
export function getApprovalOfIntent(db: WsDb, intentId: Uuid): ApprovalRow | null {
  return one<ApprovalRow>(db, CODECS.approvals, "SELECT * FROM approvals WHERE intent_id = ?", intentId);
}

/**
 * 照合に使う監査ログの行。audit_logs は追記しかできず（UPDATE・DELETE はトリガーで拒否）、seq はワークスペースの
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
export function listTaskAuditEvents(db: WsDb, taskId: Uuid): ProvenanceAuditEvent[] {
  return all<ProvenanceAuditEvent>(
    db,
    CODECS.audit_logs,
    "SELECT seq, occurred_at, event_type, actor_type, actor_id, payload FROM audit_logs WHERE task_id = ? ORDER BY seq",
    taskId,
  );
}

/** Kill Switch の発動（killswitch.engaged）の seq。古い順。発動は未実行の Intent と承認待ちを一括で失効させる（行ごとの監査ログはない） */
export function listKillSwitchEngagedSeqs(db: WsDb): number[] {
  return all<{ seq: number }>(db, {}, "SELECT seq FROM audit_logs WHERE event_type = 'killswitch.engaged' ORDER BY seq").map((x) => x.seq);
}
