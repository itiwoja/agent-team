// app の土台の問い合わせ（@open-team/db/app。持ち主は app-base。README §1 のリポジトリ層の約束に従う）
// - 業務の関数は (q, ctx: WsCtx, …) で、SQL を必ず workspace_id で絞る（15:368）。見つからなければ null（API は 404）
// - 書いて整合が要る関数は Tx を受ける。トランザクションの中で外部（Gemini・gateway）を呼ばない（G-14）
// - ロックの順はワークスペース → タスク → 承認 → Intent（M-21・SO §3.14）
// 中身：ワークスペースの表示（EP-03・26）・Kill Switch（EP-27・28）・SSE の事象（EP-45）・監査ログの一覧（EP-43）・
//       冪等性のキー（EP-27 ほか）・オーナーの初期投入（G-08）に使う行の読み書き

import type { Json, JsonObject } from "@open-team/kernel";
import type { Queryable, Tx } from "../client.ts";
import {
  TASK_TERMINAL,
  type AgentJobRow,
  type AgentRow,
  type AgentSnapshotRow,
  type AskMemberRow,
  type AskRow,
  type AskShape,
  type AskStatus,
  type AskTrigger,
  type AuditLogRow,
  type ConnectorAuth,
  type ConnectorRow,
  type ConnectorToolRow,
  type EffectivePolicies,
  type IdempotencyKeyRow,
  type JobKind,
  type JobStatus,
  type JobTemplate,
  type MemberRole,
  type TaskStatus,
  type ToolClassification,
  type ToolHash,
  type ToolScope,
  type UsdDecimal,
  type Uuid,
  type WorkspaceEventRow,
  type WorkspacePolicyRow,
} from "../types.ts";
import type { WsCtx } from "../workspace.ts";

async function one<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T> {
  const r = await q.query<T>(text, params);
  const row = r.rows[0];
  if (!row) throw new Error(`行を書けなかった：${text.trim().slice(0, 60)}`);
  return row;
}

/** ワークスペースの行を FOR NO KEY UPDATE で取る（最初に取るロック：M-21）。なければ false */
async function lockWorkspaceRow(tx: Tx, ctx: WsCtx): Promise<boolean> {
  const r = await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [ctx.workspaceId]);
  return r.rowCount > 0;
}

// =====================================================================
// ワークスペースの表示（EP-03 /me・EP-26。AS §2.3 の WorkspaceView の材料）
// =====================================================================

/** 所属している利用者（ワークスペースで絞る。ほかのワークスペースの利用者は null） */
export async function getMemberUser(
  q: Queryable,
  ctx: WsCtx,
  userId: Uuid,
): Promise<{ id: Uuid; login: string; name: string | null; role: MemberRole } | null> {
  const r = await q.query<{ id: Uuid; login: string; name: string | null; role: MemberRole }>(
    `SELECT u.id, u.login, u.name, m.role
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.user_id = $2 AND u.deleted_at IS NULL`,
    [ctx.workspaceId, userId],
  );
  return r.rows[0] ?? null;
}

/** いちばん新しい版のワークスペースのポリシー（なければ null） */
export async function getLatestWorkspacePolicy(q: Queryable, ctx: WsCtx): Promise<WorkspacePolicyRow | null> {
  const r = await q.query<WorkspacePolicyRow>(
    `SELECT id, workspace_id, version, policy, policy_hash, created_by, created_at
       FROM workspace_policies WHERE workspace_id = $1 ORDER BY version DESC LIMIT 1`,
    [ctx.workspaceId],
  );
  return r.rows[0] ?? null;
}

/**
 * ワークスペースの今日の費用（usage_records の合計。小数6桁の文字列）。「今日」は timeZone の0時から（DB §4.10。
 * すべてのワークスペースは Asia/Tokyo：M-59）。夏時間でもずれない SQL（system.dayRange と同じ式）
 */
export async function getWorkspaceDayCostUsd(q: Queryable, ctx: WsCtx, now: Date, timeZone: string): Promise<UsdDecimal> {
  const r = await q.query<{ usd: string }>(
    `WITH d AS (
       SELECT (date_trunc('day', $2::timestamptz AT TIME ZONE $3) AT TIME ZONE $3) AS start,
              ((date_trunc('day', $2::timestamptz AT TIME ZONE $3) + interval '1 day') AT TIME ZONE $3) AS "end"
     )
     SELECT COALESCE(sum(u.cost_usd), 0)::numeric(16,6)::text AS usd
       FROM usage_records u, d
      WHERE u.workspace_id = $1 AND u.created_at >= d.start AND u.created_at < d."end"`,
    [ctx.workspaceId, now, timeZone],
  );
  return r.rows[0]?.usd ?? "0.000000";
}

// =====================================================================
// Kill Switch（EP-27・28。SO §3.15、AS §3.9、FR-015）
// =====================================================================

/** Kill Switch で止めたタスク（順番の進め方の入力。previousStatus は止める前の状態） */
export interface HaltedTask {
  id: Uuid;
  jobId: Uuid;
  agentId: Uuid;
  askId: Uuid | null;
  askRunId: Uuid | null;
  previousStatus: TaskStatus;
}

export interface KillSwitchEngageResult {
  /** すでに発動していた（何も変えていない。監査ログも足さない：09_api/policies.md:75） */
  alreadyEngaged: boolean;
  engagedAt: Date;
  haltedTasks: HaltedTask[];
  expiredApprovalIds: Uuid[];
  expiredIntentIds: Uuid[];
}

/**
 * Kill Switch の発動の DB の部分（SO §3.15 の3〜7、AS §3.9 の3）。ロックはワークスペース → タスク → 承認 → Intent の順。
 * 1. ワークスペースの行を取り、発動中なら何もしない（冪等）
 * 2. kill_switch_engaged・_at・_by・_reason
 * 3. 終了状態でない全タスクを halted（kill_switch）、finished_at、タスクのトークンを失効
 * 4. pending の承認を expired、proposed・pending_approval・approved の Intent を expired（kill_switch）。executing は触らない（完了を待つ）
 * 監査ログ・SSE の事象・NOTIFY は呼び出し側が同じトランザクションで足す。ワークスペースがなければ null
 */
export async function engageKillSwitchTx(
  tx: Tx,
  ctx: WsCtx,
  i: { by: Uuid | null; reason: string | null; now: Date },
): Promise<KillSwitchEngageResult | null> {
  const ws = (
    await tx.query<{ kill_switch_engaged: boolean; kill_switch_engaged_at: Date | null }>(
      "SELECT kill_switch_engaged, kill_switch_engaged_at FROM workspaces WHERE id = $1 FOR NO KEY UPDATE",
      [ctx.workspaceId],
    )
  ).rows[0];
  if (!ws) return null;
  const empty = { haltedTasks: [], expiredApprovalIds: [], expiredIntentIds: [] };
  if (ws.kill_switch_engaged) return { alreadyEngaged: true, engagedAt: ws.kill_switch_engaged_at ?? i.now, ...empty };

  await tx.query(
    `UPDATE workspaces SET kill_switch_engaged = true, kill_switch_engaged_at = $2, kill_switch_engaged_by = $3,
            kill_switch_reason = $4, updated_at = $2
      WHERE id = $1`,
    [ctx.workspaceId, i.now, i.by, i.reason],
  );
  const tasks = await tx.query<{
    id: Uuid;
    job_id: Uuid;
    agent_id: Uuid;
    ask_id: Uuid | null;
    ask_run_id: Uuid | null;
    previous_status: TaskStatus;
  }>(
    `WITH t AS (
       SELECT id, status FROM tasks
        WHERE workspace_id = $1 AND status <> ALL($3::text[])
        ORDER BY id
        FOR UPDATE
     )
     UPDATE tasks SET status = 'halted', halt_reason = 'kill_switch', finished_at = $2, updated_at = $2,
                      task_token_hash = NULL, task_token_expires_at = NULL
       FROM t
      WHERE tasks.id = t.id AND tasks.workspace_id = $1
     RETURNING tasks.id, tasks.job_id, tasks.agent_id, tasks.ask_id, tasks.ask_run_id,
               t.status AS previous_status`,
    [ctx.workspaceId, i.now, [...TASK_TERMINAL]],
  );
  const approvals = await tx.query<{ id: Uuid }>(
    "UPDATE approvals SET status = 'expired', updated_at = $2 WHERE workspace_id = $1 AND status = 'pending' RETURNING id",
    [ctx.workspaceId, i.now],
  );
  const intents = await tx.query<{ id: Uuid }>(
    `UPDATE action_intents SET status = 'expired', expire_reason = 'kill_switch', updated_at = $2
      WHERE workspace_id = $1 AND status IN ('proposed', 'pending_approval', 'approved')
     RETURNING id`,
    [ctx.workspaceId, i.now],
  );
  const haltedTasks = tasks.rows
    .map(
      (t): HaltedTask => ({
        id: t.id,
        jobId: t.job_id,
        agentId: t.agent_id,
        askId: t.ask_id,
        askRunId: t.ask_run_id,
        previousStatus: t.previous_status,
      }),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    alreadyEngaged: false,
    engagedAt: i.now,
    haltedTasks,
    expiredApprovalIds: approvals.rows.map((r) => r.id).sort(),
    expiredIntentIds: intents.rows.map((r) => r.id).sort(),
  };
}

/**
 * Kill Switch の解除の DB の部分（SO §3.15 の解除）。発動中でなければ何もしない（wasEngaged false）。
 * 発動の時刻・人・理由は消す（履歴は監査ログに残る）。止めたタスクは再開しない（BR-17）。ワークスペースがなければ null
 */
export async function releaseKillSwitchTx(tx: Tx, ctx: WsCtx, now: Date): Promise<{ wasEngaged: boolean } | null> {
  if (!(await lockWorkspaceRow(tx, ctx))) return null;
  const r = await tx.query(
    `UPDATE workspaces SET kill_switch_engaged = false, kill_switch_engaged_at = NULL, kill_switch_engaged_by = NULL,
            kill_switch_reason = NULL, updated_at = $2
      WHERE id = $1 AND kill_switch_engaged`,
    [ctx.workspaceId, now],
  );
  return { wasEngaged: r.rowCount > 0 };
}

/**
 * 動いているタスク（このインスタンスの登録簿）のうち、止まったもの（SO §3.15 の止まり方の3：LISTEN/NOTIFY が落ちたときの見回り）。
 * ワークスペースで絞る。ワークスペースが消えていたら Kill Switch と同じに扱う（全部止める）
 */
export async function findStoppedTasks(
  q: Queryable,
  ctx: WsCtx,
  taskIds: readonly Uuid[],
): Promise<{ killSwitchEngaged: boolean; terminalTaskIds: Uuid[] }> {
  const r = await q.query<{ kill_switch_engaged: boolean; terminal: Uuid[] }>(
    `SELECT w.kill_switch_engaged,
            COALESCE(array_agg(t.id ORDER BY t.id) FILTER (WHERE t.id IS NOT NULL), '{}'::uuid[]) AS terminal
       FROM workspaces w
       LEFT JOIN tasks t ON t.workspace_id = w.id AND t.id = ANY($2::uuid[]) AND t.status = ANY($3::text[])
      WHERE w.id = $1
      GROUP BY w.kill_switch_engaged`,
    [ctx.workspaceId, [...taskIds], [...TASK_TERMINAL]],
  );
  const row = r.rows[0];
  if (!row) return { killSwitchEngaged: true, terminalTaskIds: [...taskIds] };
  return { killSwitchEngaged: row.kill_switch_engaged, terminalTaskIds: row.terminal };
}

// =====================================================================
// ワークスペースの事象（SSE。EP-45、M-53、AS 8-4）
// =====================================================================

/** NOTIFY のチャンネル。payload は '<workspaceId>:<id>'（本体は行から読む。8000バイトの上限に本文を載せない） */
export const WORKSPACE_EVENTS_CHANNEL = "ot_workspace_events";
const EVENT_TYPE_RE = /^[a-z_]+(\.[a-z_]+)*$/;

export interface WorkspaceEventInput {
  /** AS §2.11 の WorkspaceEvent の type（'killswitch'・'check.upsert' など） */
  type: string;
  data: Json;
}

/**
 * 事象を1件足して NOTIFY する（コミットで届く）。業務の変更と同じトランザクションで呼ぶ。
 * 先にワークスペースの行をロックするので、同じワークスペースの事象は id の順にコミットされる
 * （SSE の Last-Event-ID の再開で、あとからコミットされた小さい id を取りこぼさない）。ロックの順は最初（M-21）
 */
export async function appendWorkspaceEvent(tx: Tx, ctx: WsCtx, e: WorkspaceEventInput, now: Date): Promise<WorkspaceEventRow> {
  if (!EVENT_TYPE_RE.test(e.type) || e.type.length > 64) throw new TypeError(`事象の type の形が違う：${e.type}`);
  if (!(await lockWorkspaceRow(tx, ctx))) throw new Error(`事象を書くワークスペースがない：${ctx.workspaceId}`);
  const row = await one<WorkspaceEventRow>(
    tx,
    "INSERT INTO workspace_events (workspace_id, type, data, created_at) VALUES ($1, $2, $3, $4) RETURNING id, workspace_id, type, data, created_at",
    [ctx.workspaceId, e.type, e.data, now],
  );
  await tx.query("SELECT pg_notify($1, $2)", [WORKSPACE_EVENTS_CHANNEL, `${ctx.workspaceId}:${row.id}`]);
  return row;
}

/** afterId より後の事象を id の昇順に（SSE の再開と配信） */
export async function listWorkspaceEventsAfter(q: Queryable, ctx: WsCtx, afterId: number, limit: number): Promise<WorkspaceEventRow[]> {
  const r = await q.query<WorkspaceEventRow>(
    `SELECT id, workspace_id, type, data, created_at FROM workspace_events
      WHERE workspace_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [ctx.workspaceId, afterId, limit],
  );
  return r.rows;
}

/** そのワークスペースの最新の事象の id（なければ 0）。Last-Event-ID のない接続はここから */
export async function latestWorkspaceEventId(q: Queryable, ctx: WsCtx): Promise<number> {
  const r = await q.query<{ id: number | null }>("SELECT max(id) AS id FROM workspace_events WHERE workspace_id = $1", [ctx.workspaceId]);
  return r.rows[0]?.id ?? 0;
}

/** その id の事象がこのワークスペースに残っているか（なければ保持期間を過ぎた・別のワークスペースのもの → reset） */
export async function workspaceEventExists(q: Queryable, ctx: WsCtx, id: number): Promise<boolean> {
  const r = await q.query("SELECT 1 FROM workspace_events WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, id]);
  return r.rowCount > 0;
}

// =====================================================================
// 監査ログの一覧（EP-43。AS §3.13）
// =====================================================================

export interface AuditListFilter {
  /** 1〜100 */
  limit: number;
  /** この seq より前（カーソル）。null は最新から */
  beforeSeq: number | null;
  /** occurred_at がこれ以上 */
  from?: Date;
  /** occurred_at がこれ以下 */
  to?: Date;
  eventTypes?: readonly string[];
  taskId?: Uuid;
}

/** seq の降順。hasMore は limit より多く残っているか */
export async function listAuditLogs(q: Queryable, ctx: WsCtx, f: AuditListFilter): Promise<{ rows: AuditLogRow[]; hasMore: boolean }> {
  const where: string[] = ["workspace_id = $1"];
  const params: unknown[] = [ctx.workspaceId];
  const add = (sql: (n: number) => string, v: unknown) => {
    params.push(v);
    where.push(sql(params.length));
  };
  if (f.beforeSeq !== null) add((n) => `seq < $${n}`, f.beforeSeq);
  if (f.from) add((n) => `occurred_at >= $${n}`, f.from);
  if (f.to) add((n) => `occurred_at <= $${n}`, f.to);
  if (f.eventTypes && f.eventTypes.length > 0) add((n) => `event_type = ANY($${n}::text[])`, [...f.eventTypes]);
  if (f.taskId) add((n) => `task_id = $${n}`, f.taskId);
  // 0023 より前の影の走行の行（payload.enforced = false）は出さない
  where.push("payload->>'enforced' IS DISTINCT FROM 'false'");
  params.push(f.limit + 1);
  const r = await q.query<AuditLogRow>(
    `SELECT workspace_id, seq, occurred_at, event_type, actor_type, actor_id, task_id, payload, prev_hash, hash
       FROM audit_logs WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT $${params.length}`,
    params,
  );
  return { rows: r.rows.slice(0, f.limit), hasMore: r.rows.length > f.limit };
}

// =====================================================================
// 冪等性のキー（Idempotency-Key。09_api/common.md:50、AS §2.1。24時間は同じ結果を返す）
// =====================================================================

/** 同じキーの要求を直列にする（トランザクションの最初に。アドバイザリロックはこのキーだけを待たせる） */
export async function lockIdempotencyKey(tx: Tx, ctx: WsCtx, key: Uuid): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`ot.idempotency:${ctx.workspaceId}:${key.toLowerCase()}`]);
}

/** notBefore より新しい記録（古いものは無いものとして扱う。掃除は24時間で消す） */
export async function findIdempotencyRecord(q: Queryable, ctx: WsCtx, key: Uuid, notBefore: Date): Promise<IdempotencyKeyRow | null> {
  const r = await q.query<IdempotencyKeyRow>(
    `SELECT workspace_id, key, method, path, request_hash, response_status, response_body, created_at
       FROM idempotency_keys WHERE workspace_id = $1 AND key = $2 AND created_at > $3`,
    [ctx.workspaceId, key.toLowerCase(), notBefore],
  );
  return r.rows[0] ?? null;
}

/** 結果を残す（同じキーの古い記録は上書き） */
export async function saveIdempotencyRecord(
  tx: Tx,
  ctx: WsCtx,
  rec: { key: Uuid; method: string; path: string; requestHash: string; responseStatus: number; responseBody: Json },
  now: Date,
): Promise<void> {
  await tx.query(
    `INSERT INTO idempotency_keys (workspace_id, key, method, path, request_hash, response_status, response_body, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, key) DO UPDATE
       SET method = EXCLUDED.method, path = EXCLUDED.path, request_hash = EXCLUDED.request_hash,
           response_status = EXCLUDED.response_status, response_body = EXCLUDED.response_body, created_at = EXCLUDED.created_at`,
    [ctx.workspaceId, rec.key.toLowerCase(), rec.method, rec.path, rec.requestHash, rec.responseStatus, rec.responseBody, now],
  );
}

// =====================================================================
// オーナーの初期投入（G-08）。どれも「なければ作る」で、2回目は何も変えない
// =====================================================================

/** ワークスペースのポリシーの v1 を（どの版もなければ）入れる */
export async function insertWorkspacePolicyIfMissing(
  tx: Tx,
  ctx: WsCtx,
  i: { policy: JsonObject; policyHash: string; createdBy: Uuid | null; now: Date },
): Promise<{ row: WorkspacePolicyRow; created: boolean }> {
  const inserted = await tx.query<WorkspacePolicyRow>(
    `INSERT INTO workspace_policies (workspace_id, version, policy, policy_hash, created_by, created_at)
     SELECT $1, 1, $2, $3, $4, $5
      WHERE NOT EXISTS (SELECT 1 FROM workspace_policies WHERE workspace_id = $1)
     ON CONFLICT (workspace_id, version) DO NOTHING
     RETURNING id, workspace_id, version, policy, policy_hash, created_by, created_at`,
    [ctx.workspaceId, i.policy, i.policyHash, i.createdBy, i.now],
  );
  const row = inserted.rows[0];
  if (row) return { row, created: true };
  const latest = await getLatestWorkspacePolicy(tx, ctx);
  if (!latest) throw new Error("ワークスペースのポリシーを読めなかった");
  return { row: latest, created: false };
}

/** コネクタのツール（コネクタを渡せばそのコネクタの分だけ。名前の順） */
export async function listConnectorTools(q: Queryable, ctx: WsCtx, connectorIds?: readonly Uuid[]): Promise<ConnectorToolRow[]> {
  const byConnector = connectorIds !== undefined;
  const r = await q.query<ConnectorToolRow>(
    `SELECT id, workspace_id, connector_id, name, description, input_schema, annotations, classification, status, arg_roles, scope,
            verify, tool_hash, pending, classified_by, classified_at, created_at, updated_at
       FROM connector_tools
      WHERE workspace_id = $1 ${byConnector ? "AND connector_id = ANY($2::uuid[])" : ""}
      ORDER BY connector_id, name`,
    byConnector ? [ctx.workspaceId, [...connectorIds]] : [ctx.workspaceId],
  );
  return r.rows;
}

/** ワークスペースのコネクタ（slug の順） */
export async function listConnectors(q: Queryable, ctx: WsCtx): Promise<ConnectorRow[]> {
  const r = await q.query<ConnectorRow>(
    `SELECT id, workspace_id, slug, display_name, kind, url, auth, enabled, last_synced_at, created_at, updated_at
       FROM connectors WHERE workspace_id = $1 ORDER BY slug`,
    [ctx.workspaceId],
  );
  return r.rows;
}

/**
 * ツールの分類・役割を確定する（MT §3.14 の7。manifest の値）。status = 'ok' の行だけ（needs_review は持ち主の確認：MT §3.13.2）。
 * どれかが違うときだけ書き、書いたら true（2回目は false）
 */
export async function applyToolClassification(
  tx: Tx,
  ctx: WsCtx,
  toolId: Uuid,
  i: {
    classification: ToolClassification;
    argRoles: Readonly<Record<string, string>>;
    scope: ToolScope;
    verify: "none" | "readback";
    toolHash: ToolHash;
    classifiedBy: string;
    now: Date;
  },
): Promise<boolean> {
  const r = await tx.query(
    `UPDATE connector_tools
        SET classification = $3, arg_roles = $4, scope = $5, verify = $6, tool_hash = $7,
            classified_by = $8, classified_at = $9, updated_at = $9
      WHERE workspace_id = $1 AND id = $2 AND status = 'ok'
        AND (classification IS DISTINCT FROM $3 OR arg_roles IS DISTINCT FROM $4::jsonb OR scope IS DISTINCT FROM $5
             OR verify IS DISTINCT FROM $6 OR tool_hash IS DISTINCT FROM $7)`,
    [ctx.workspaceId, toolId, i.classification, i.argRoles, i.scope, i.verify, i.toolHash, i.classifiedBy, i.now],
  );
  return r.rowCount > 0;
}

const AGENT_COLS = `id, workspace_id, slug, name, name_source, role, appearance, status, current_snapshot_id, disabled_by, disabled_reason,
  disabled_at, created_at, updated_at`;

/** 名前で引く（removed を除く。名前はワークスペースの中で一意：agents_ws_name_uq） */
export async function findAgentByName(q: Queryable, ctx: WsCtx, name: string): Promise<AgentRow | null> {
  const r = await q.query<AgentRow>(`SELECT ${AGENT_COLS} FROM agents WHERE workspace_id = $1 AND name = $2 AND status <> 'removed'`, [
    ctx.workspaceId,
    name,
  ]);
  return r.rows[0] ?? null;
}

export async function getAgent(q: Queryable, ctx: WsCtx, agentId: Uuid): Promise<AgentRow | null> {
  const r = await q.query<AgentRow>(`SELECT ${AGENT_COLS} FROM agents WHERE workspace_id = $1 AND id = $2`, [ctx.workspaceId, agentId]);
  return r.rows[0] ?? null;
}

/**
 * エージェントと有効なスナップショット（current）を1つのトランザクションで作る
 * （agents.current_snapshot_id は DEFERRABLE。スナップショットは UPDATE 禁止なので作ったまま）
 */
export async function insertAgentWithSnapshot(
  tx: Tx,
  ctx: WsCtx,
  i: {
    slug: string;
    name: string;
    nameSource: "user" | "suggested";
    role: AgentRow["role"];
    status: AgentRow["status"];
    definition: JsonObject;
    effectivePolicies: EffectivePolicies;
    clamped: Json[];
    ceilingsVersion: string;
    now: Date;
  },
): Promise<{ agent: AgentRow; snapshot: AgentSnapshotRow }> {
  const agent = await one<AgentRow>(
    tx,
    `INSERT INTO agents (workspace_id, slug, name, name_source, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${AGENT_COLS}`,
    [ctx.workspaceId, i.slug, i.name, i.nameSource, i.role, i.status, i.now],
  );
  const snapshot = await one<AgentSnapshotRow>(
    tx,
    `INSERT INTO agent_snapshots (workspace_id, agent_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
     VALUES ($1, $2, 'in_app', 'valid', $3, $4, $5, $6, $7)
     RETURNING id, workspace_id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version,
               errors, warnings, created_at`,
    [ctx.workspaceId, agent.id, i.definition, i.effectivePolicies, i.clamped, i.ceilingsVersion, i.now],
  );
  const updated = await one<AgentRow>(
    tx,
    `UPDATE agents SET current_snapshot_id = $3, updated_at = $4 WHERE workspace_id = $1 AND id = $2 RETURNING ${AGENT_COLS}`,
    [ctx.workspaceId, agent.id, snapshot.id, i.now],
  );
  return { agent: updated, snapshot };
}

const JOB_COLS = "id, workspace_id, agent_id, slug, kind, template, status, source_message_id, created_at, updated_at";

export async function findAgentJob(q: Queryable, ctx: WsCtx, agentId: Uuid, slug: string): Promise<AgentJobRow | null> {
  const r = await q.query<AgentJobRow>(`SELECT ${JOB_COLS} FROM agent_jobs WHERE workspace_id = $1 AND agent_id = $2 AND slug = $3`, [
    ctx.workspaceId,
    agentId,
    slug,
  ]);
  return r.rows[0] ?? null;
}

export async function insertAgentJob(
  tx: Tx,
  ctx: WsCtx,
  i: { agentId: Uuid; slug: string; kind: JobKind; template: JobTemplate; status: JobStatus; now: Date },
): Promise<AgentJobRow> {
  return one<AgentJobRow>(
    tx,
    `INSERT INTO agent_jobs (workspace_id, agent_id, slug, kind, template, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING ${JOB_COLS}`,
    [ctx.workspaceId, i.agentId, i.slug, i.kind, i.template, i.status, i.now],
  );
}

const ASK_COLS = `id, workspace_id, created_by, text, mention_agent_id, pack_id, shape, status, trigger, next_run_at, formation, planner_attempts,
  question, question_answer, failure_reason, seed_key, created_at, updated_at, finished_at`;

/** 用意した依頼の印（asks.seed_key。D-70）で引く */
export async function findAskBySeedKey(q: Queryable, ctx: WsCtx, seedKey: string): Promise<AskRow | null> {
  const r = await q.query<AskRow>(`SELECT ${ASK_COLS} FROM asks WHERE workspace_id = $1 AND seed_key = $2`, [ctx.workspaceId, seedKey]);
  return r.rows[0] ?? null;
}

export async function insertAsk(
  tx: Tx,
  ctx: WsCtx,
  i: {
    createdBy: Uuid;
    text: string;
    shape: AskShape;
    status: AskStatus;
    trigger: AskTrigger | null;
    nextRunAt: Date | null;
    formation: JsonObject | null;
    seedKey: string | null;
    now: Date;
  },
): Promise<AskRow> {
  return one<AskRow>(
    tx,
    `INSERT INTO asks (workspace_id, created_by, text, shape, status, trigger, next_run_at, formation, seed_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING ${ASK_COLS}`,
    [ctx.workspaceId, i.createdBy, i.text, i.shape, i.status, i.trigger, i.nextRunAt, i.formation, i.seedKey, i.now],
  );
}

export async function insertAskMember(
  tx: Tx,
  ctx: WsCtx,
  i: {
    askId: Uuid;
    agentId: Uuid;
    jobId: Uuid;
    position: number | null;
    dependsOn: readonly number[];
    isAggregator: boolean;
    isSpokesperson: boolean;
    isNew: boolean;
    summary: string;
    now: Date;
  },
): Promise<AskMemberRow> {
  return one<AskMemberRow>(
    tx,
    `INSERT INTO ask_members (workspace_id, ask_id, agent_id, job_id, position, depends_on, is_aggregator, is_spokesperson, is_new, summary,
                              created_at)
     VALUES ($1, $2, $3, $4, $5, $6::smallint[], $7, $8, $9, $10, $11)
     RETURNING id, workspace_id, ask_id, agent_id, job_id, position, depends_on, is_aggregator, is_spokesperson, is_new, summary, created_at`,
    [ctx.workspaceId, i.askId, i.agentId, i.jobId, i.position, [...i.dependsOn], i.isAggregator, i.isSpokesperson, i.isNew, i.summary, i.now],
  );
}

/** 依頼の担当（段の順） */
export async function listAskMembers(q: Queryable, ctx: WsCtx, askId: Uuid): Promise<AskMemberRow[]> {
  const r = await q.query<AskMemberRow>(
    `SELECT id, workspace_id, ask_id, agent_id, job_id, position, depends_on, is_aggregator, is_spokesperson, is_new, summary, created_at
       FROM ask_members WHERE workspace_id = $1 AND ask_id = $2 ORDER BY position NULLS LAST, created_at, id`,
    [ctx.workspaceId, askId],
  );
  return r.rows;
}
