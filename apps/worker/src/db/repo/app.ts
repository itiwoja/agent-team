// app の土台の問い合わせ（packages/db/src/repo/app.ts の WorkspaceDO 版）。
// - 業務の関数は (db: WsDb, …) の同期の関数。workspace_id で絞る代わりに、DO そのものがワークスペース。見つからなければ null（API は 404）
// - 読んで判断して書く関数は db.transaction(() => …) で包む。トランザクションの中で外部（Gemini・gateway）を呼ばない（G-14）
// - ロックの順（M-21）・ワークスペースの行のロック・冪等性のキーのアドバイザリロックは要らない（DO の中は1本の流れ）
// 中身：ワークスペースの今日の費用・Kill Switch（EP-27・28）・SSE の事象（EP-45）・監査ログの一覧（EP-43）・
//       冪等性のキー（EP-27 ほか）・オーナーの初期投入（G-08）に使う行の読み書き。
// 所属している利用者（getMemberUser）は D1 の users・memberships なので、ここには移さない（Worker の D1 の側で引く）。
// SSE の事象の NOTIFY はない（DO が自分の SSE の接続へ配る：第5段）

import { canonicalJson, type Json, type JsonObject } from "@open-team/kernel";
import { CODECS } from "../codecs.ts";
import { all, count, newId, one, run, type WsDb } from "../sqlite.ts";
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
  type ConnectorRow,
  type ConnectorToolRow,
  type EffectivePolicies,
  type IdempotencyKeyRow,
  type JobKind,
  type JobStatus,
  type JobTemplate,
  type MicroUsd,
  type TaskStatus,
  type ToolClassification,
  type ToolHash,
  type ToolScope,
  type Uuid,
  type WorkspaceEventRow,
  type WorkspacePolicyRow,
} from "../types.ts";
import { getWorkspace } from "../workspace.ts";
import { dayRange } from "./costs.ts";

/** 書いた行（RETURNING）。なければ例外 */
function written<T>(row: T | null, query: string): T {
  if (!row) throw new Error(`行を書けなかった：${query.trim().slice(0, 60)}`);
  return row;
}

// =====================================================================
// ワークスペースの表示（EP-03 /me・EP-26。AS §2.3 の WorkspaceView の材料）
// =====================================================================

/** いちばん新しい版のワークスペースのポリシー（なければ null） */
export function getLatestWorkspacePolicy(db: WsDb): WorkspacePolicyRow | null {
  return one<WorkspacePolicyRow>(
    db,
    CODECS.workspace_policies,
    "SELECT id, version, policy, policy_hash, created_by, created_at FROM workspace_policies ORDER BY version DESC LIMIT 1",
  );
}

/**
 * ワークスペースの今日の費用（usage_records の合計。整数のマイクロドル）。「今日」は timeZone の0時から（DB §4.10。
 * すべてのワークスペースは Asia/Tokyo：M-59）。区切りは costs.ts の dayRange（夏時間でもずれない）
 */
export function getWorkspaceDayCostMicroUsd(db: WsDb, now: Date, timeZone: string): MicroUsd {
  const d = dayRange(now, timeZone);
  return count(db, "SELECT COALESCE(sum(cost_micro_usd), 0) FROM usage_records WHERE created_at >= ? AND created_at < ?", d.start, d.end);
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
 * Kill Switch の発動の DB の部分（SO §3.15 の3〜7、AS §3.9 の3）。1つのトランザクションで：
 * 1. 発動中なら何もしない（冪等）
 * 2. kill_switch_engaged・_at・_by・_reason
 * 3. 終了状態でない全タスクを halted（kill_switch）、finished_at、タスクのトークンを失効
 * 4. pending の承認を expired、proposed・pending_approval・approved の Intent を expired（kill_switch）。executing は触らない（完了を待つ）
 * 監査ログ・SSE の事象は呼び出し側が同じトランザクションで足す。ワークスペースの行がなければ（init の前）null
 */
export function engageKillSwitchTx(db: WsDb, i: { by: Uuid | null; reason: string | null; now: Date }): KillSwitchEngageResult | null {
  return db.transaction(() => {
    const ws = getWorkspace(db);
    if (!ws) return null;
    const empty = { haltedTasks: [], expiredApprovalIds: [], expiredIntentIds: [] };
    if (ws.kill_switch_engaged) return { alreadyEngaged: true, engagedAt: ws.kill_switch_engaged_at ?? i.now, ...empty };

    run(
      db,
      `UPDATE workspace SET kill_switch_engaged = 1, kill_switch_engaged_at = ?, kill_switch_engaged_by = ?, kill_switch_reason = ?, updated_at = ?
        WHERE id = 1`,
      i.now,
      i.by,
      i.reason,
      i.now,
    );
    // 止める前の状態を先に読む（UPDATE … RETURNING では前の値を返せない）
    const tasks = all<{ id: Uuid; job_id: Uuid; agent_id: Uuid; ask_id: Uuid | null; ask_run_id: Uuid | null; status: TaskStatus }>(
      db,
      {},
      "SELECT id, job_id, agent_id, ask_id, ask_run_id, status FROM tasks WHERE status NOT IN (SELECT value FROM json_each(?)) ORDER BY id",
      TASK_TERMINAL,
    );
    run(
      db,
      `UPDATE tasks SET status = 'halted', halt_reason = 'kill_switch', finished_at = ?, updated_at = ?,
                        task_token_hash = NULL, task_token_expires_at = NULL
        WHERE id IN (SELECT value FROM json_each(?))`,
      i.now,
      i.now,
      tasks.map((t) => t.id),
    );
    const approvals = all<{ id: Uuid }>(db, {}, "UPDATE approvals SET status = 'expired', updated_at = ? WHERE status = 'pending' RETURNING id", i.now);
    const intents = all<{ id: Uuid }>(
      db,
      {},
      `UPDATE action_intents SET status = 'expired', expire_reason = 'kill_switch', updated_at = ?
        WHERE status IN ('proposed', 'pending_approval', 'approved')
       RETURNING id`,
      i.now,
    );
    return {
      alreadyEngaged: false,
      engagedAt: i.now,
      haltedTasks: tasks.map(
        (t): HaltedTask => ({ id: t.id, jobId: t.job_id, agentId: t.agent_id, askId: t.ask_id, askRunId: t.ask_run_id, previousStatus: t.status }),
      ),
      expiredApprovalIds: approvals.map((r) => r.id).sort(),
      expiredIntentIds: intents.map((r) => r.id).sort(),
    };
  });
}

/**
 * Kill Switch の解除の DB の部分（SO §3.15 の解除）。発動中でなければ何もしない（wasEngaged false）。
 * 発動の時刻・人・理由は消す（履歴は監査ログに残る）。止めたタスクは再開しない（BR-17）。ワークスペースの行がなければ null
 */
export function releaseKillSwitchTx(db: WsDb, now: Date): { wasEngaged: boolean } | null {
  return db.transaction(() => {
    if (!getWorkspace(db)) return null;
    const n = run(
      db,
      `UPDATE workspace SET kill_switch_engaged = 0, kill_switch_engaged_at = NULL, kill_switch_engaged_by = NULL,
              kill_switch_reason = NULL, updated_at = ?
        WHERE id = 1 AND kill_switch_engaged = 1`,
      now,
    );
    return { wasEngaged: n > 0 };
  });
}

/**
 * 動いているタスク（このインスタンスの登録簿）のうち、止まったもの（SO §3.15 の止まり方の3：見回り）。
 * ワークスペースの行がなければ Kill Switch と同じに扱う（全部止める）
 */
export function findStoppedTasks(db: WsDb, taskIds: readonly Uuid[]): { killSwitchEngaged: boolean; terminalTaskIds: Uuid[] } {
  const ws = getWorkspace(db);
  if (!ws) return { killSwitchEngaged: true, terminalTaskIds: [...taskIds] };
  const terminal =
    taskIds.length === 0
      ? []
      : all<{ id: Uuid }>(
          db,
          {},
          `SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each(?)) AND status IN (SELECT value FROM json_each(?)) ORDER BY id`,
          taskIds,
          TASK_TERMINAL,
        ).map((r) => r.id);
  return { killSwitchEngaged: ws.kill_switch_engaged, terminalTaskIds: terminal };
}

// =====================================================================
// ワークスペースの事象（SSE。EP-45、M-53、AS 8-4）
// =====================================================================

const EVENT_TYPE_RE = /^[a-z_]+(\.[a-z_]+)*$/;

export interface WorkspaceEventInput {
  /** AS §2.11 の WorkspaceEvent の type（'killswitch'・'check.upsert' など） */
  type: string;
  data: Json;
}

/**
 * 事象を1件足す。業務の変更と同じトランザクションで呼ぶ。
 * DO の中は1本の流れなので、事象は id の順にコミットされる（SSE の Last-Event-ID の再開で取りこぼさない）。
 * 配るのは呼ぶ側（コミットのあと、DO が自分の SSE の接続へ）
 */
export function appendWorkspaceEvent(db: WsDb, e: WorkspaceEventInput, now: Date): WorkspaceEventRow {
  if (!EVENT_TYPE_RE.test(e.type) || e.type.length > 64) throw new TypeError(`事象の type の形が違う：${e.type}`);
  const q = "INSERT INTO workspace_events (type, data, created_at) VALUES (?, ?, ?) RETURNING id, type, data, created_at";
  // data は JSON の値なら何でもよい（文字列・数も）ので、ここで JSON にして渡す
  return written(one<WorkspaceEventRow>(db, CODECS.workspace_events, q, e.type, JSON.stringify(e.data), now), q);
}

/** afterId より後の事象を id の昇順に（SSE の再開と配信） */
export function listWorkspaceEventsAfter(db: WsDb, afterId: number, limit: number): WorkspaceEventRow[] {
  return all<WorkspaceEventRow>(
    db,
    CODECS.workspace_events,
    "SELECT id, type, data, created_at FROM workspace_events WHERE id > ? ORDER BY id LIMIT ?",
    afterId,
    limit,
  );
}

/** 最新の事象の id（なければ 0）。Last-Event-ID のない接続はここから */
export function latestWorkspaceEventId(db: WsDb): number {
  return count(db, "SELECT COALESCE(max(id), 0) FROM workspace_events");
}

/** その id の事象が残っているか（なければ保持期間を過ぎた → reset） */
export function workspaceEventExists(db: WsDb, id: number): boolean {
  return one(db, {}, "SELECT 1 AS ok FROM workspace_events WHERE id = ?", id) !== null;
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
export function listAuditLogs(db: WsDb, f: AuditListFilter): { rows: AuditLogRow[]; hasMore: boolean } {
  const where: string[] = [];
  const params: Array<string | number | Date | readonly string[]> = [];
  const add = (sql: string, v: string | number | Date | readonly string[]) => {
    params.push(v);
    where.push(sql);
  };
  if (f.beforeSeq !== null) add("seq < ?", f.beforeSeq);
  if (f.from) add("occurred_at >= ?", f.from);
  if (f.to) add("occurred_at <= ?", f.to);
  if (f.eventTypes && f.eventTypes.length > 0) add("event_type IN (SELECT value FROM json_each(?))", f.eventTypes);
  if (f.taskId) add("task_id = ?", f.taskId);
  // 0024 より前の影の走行の行（payload.enforced = false。真偽でも文字列でも）は出さない
  where.push("json_type(payload, '$.enforced') IS NOT 'false' AND json_extract(payload, '$.enforced') IS NOT 'false'");
  const rows = all<AuditLogRow>(
    db,
    CODECS.audit_logs,
    `SELECT seq, occurred_at, event_type, actor_type, actor_id, task_id, payload, prev_hash, hash
       FROM audit_logs WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
    ...params,
    f.limit + 1,
  );
  return { rows: rows.slice(0, f.limit), hasMore: rows.length > f.limit };
}

// =====================================================================
// 冪等性のキー（Idempotency-Key。09_api/common.md:50、AS §2.1。24時間は同じ結果を返す）
// 同じキーの要求の直列化（Postgres 版の lockIdempotencyKey）は要らない：DO の中は1本の流れなので、
// 探す → 処理 → 残す を1つのトランザクションで行えば同じキーの要求は重ならない
// =====================================================================

/** notBefore より新しい記録（古いものは無いものとして扱う。掃除は24時間で消す） */
export function findIdempotencyRecord(db: WsDb, key: Uuid, notBefore: Date): IdempotencyKeyRow | null {
  return one<IdempotencyKeyRow>(
    db,
    CODECS.idempotency_keys,
    `SELECT key, method, path, request_hash, response_status, response_body, created_at
       FROM idempotency_keys WHERE key = ? AND created_at > ?`,
    key.toLowerCase(),
    notBefore,
  );
}

/** 結果を残す（同じキーの古い記録は上書き） */
export function saveIdempotencyRecord(
  db: WsDb,
  rec: { key: Uuid; method: string; path: string; requestHash: string; responseStatus: number; responseBody: Json },
  now: Date,
): void {
  run(
    db,
    `INSERT INTO idempotency_keys (key, method, path, request_hash, response_status, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE
       SET method = excluded.method, path = excluded.path, request_hash = excluded.request_hash,
           response_status = excluded.response_status, response_body = excluded.response_body, created_at = excluded.created_at`,
    rec.key.toLowerCase(),
    rec.method,
    rec.path,
    rec.requestHash,
    rec.responseStatus,
    JSON.stringify(rec.responseBody),
    now,
  );
}

// =====================================================================
// オーナーの初期投入（G-08）。どれも「なければ作る」で、2回目は何も変えない
// =====================================================================

/** ワークスペースのポリシーの v1 を（どの版もなければ）入れる */
export function insertWorkspacePolicyIfMissing(
  db: WsDb,
  i: { policy: JsonObject; policyHash: string; createdBy: Uuid | null; now: Date },
): { row: WorkspacePolicyRow; created: boolean } {
  return db.transaction(() => {
    const latest = getLatestWorkspacePolicy(db);
    if (latest) return { row: latest, created: false };
    const q = `INSERT INTO workspace_policies (id, version, policy, policy_hash, created_by, created_at)
       VALUES (?, 1, ?, ?, ?, ?) RETURNING id, version, policy, policy_hash, created_by, created_at`;
    const row = written(one<WorkspacePolicyRow>(db, CODECS.workspace_policies, q, newId(), i.policy, i.policyHash, i.createdBy, i.now), q);
    return { row, created: true };
  });
}

const TOOL_COLS = `id, connector_id, name, description, input_schema, annotations, classification, status, arg_roles, scope,
  verify, tool_hash, pending, classified_by, classified_at, created_at, updated_at`;

/** コネクタのツール（コネクタを渡せばそのコネクタの分だけ。名前の順） */
export function listConnectorTools(db: WsDb, connectorIds?: readonly Uuid[]): ConnectorToolRow[] {
  if (connectorIds === undefined) {
    return all<ConnectorToolRow>(db, CODECS.connector_tools, `SELECT ${TOOL_COLS} FROM connector_tools ORDER BY connector_id, name`);
  }
  return all<ConnectorToolRow>(
    db,
    CODECS.connector_tools,
    `SELECT ${TOOL_COLS} FROM connector_tools WHERE connector_id IN (SELECT value FROM json_each(?)) ORDER BY connector_id, name`,
    connectorIds,
  );
}

/** ワークスペースのコネクタ（slug の順） */
export function listConnectors(db: WsDb): ConnectorRow[] {
  return all<ConnectorRow>(
    db,
    CODECS.connectors,
    "SELECT id, slug, display_name, kind, url, auth, enabled, last_synced_at, created_at, updated_at FROM connectors ORDER BY slug",
  );
}

/**
 * ツールの分類・役割を確定する（MT §3.14 の7。manifest の値）。status = 'ok' の行だけ（needs_review は持ち主の確認：MT §3.13.2）。
 * どれかが違うときだけ書き、書いたら true（2回目は false）。arg_roles はキーの順によらず中身で比べる（Postgres の jsonb の比較と同じ）
 */
export function applyToolClassification(
  db: WsDb,
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
): boolean {
  return db.transaction(() => {
    const cur = one<Pick<ConnectorToolRow, "classification" | "arg_roles" | "scope" | "verify" | "tool_hash">>(
      db,
      CODECS.connector_tools,
      "SELECT classification, arg_roles, scope, verify, tool_hash FROM connector_tools WHERE id = ? AND status = 'ok'",
      toolId,
    );
    if (!cur) return false;
    const same =
      cur.classification === i.classification &&
      canonicalJson(cur.arg_roles) === canonicalJson({ ...i.argRoles }) &&
      cur.scope === i.scope &&
      cur.verify === i.verify &&
      cur.tool_hash === i.toolHash;
    if (same) return false;
    return (
      run(
        db,
        `UPDATE connector_tools
            SET classification = ?, arg_roles = ?, scope = ?, verify = ?, tool_hash = ?, classified_by = ?, classified_at = ?, updated_at = ?
          WHERE id = ? AND status = 'ok'`,
        i.classification,
        { ...i.argRoles },
        i.scope,
        i.verify,
        i.toolHash,
        i.classifiedBy,
        i.now,
        i.now,
        toolId,
      ) > 0
    );
  });
}

const AGENT_COLS = `id, slug, name, name_source, role, appearance, status, current_snapshot_id, disabled_by, disabled_reason,
  disabled_at, created_at, updated_at`;

/** 名前で引く（removed を除く。名前はワークスペースの中で一意：agents_name_uq） */
export function findAgentByName(db: WsDb, name: string): AgentRow | null {
  return one<AgentRow>(db, CODECS.agents, `SELECT ${AGENT_COLS} FROM agents WHERE name = ? AND status <> 'removed'`, name);
}

export function getAgent(db: WsDb, agentId: Uuid): AgentRow | null {
  return one<AgentRow>(db, CODECS.agents, `SELECT ${AGENT_COLS} FROM agents WHERE id = ?`, agentId);
}

const SNAPSHOT_COLS = `id, agent_id, config_change_id, source, status, definition, effective_policies, clamped, ceilings_version,
  errors, warnings, created_at`;

/**
 * エージェントと有効なスナップショット（current）を1つのトランザクションで作る
 * （agents.current_snapshot_id は DEFERRABLE。スナップショットは UPDATE 禁止なので作ったまま）
 */
export function insertAgentWithSnapshot(
  db: WsDb,
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
): { agent: AgentRow; snapshot: AgentSnapshotRow } {
  return db.transaction(() => {
    const agentId = newId();
    run(
      db,
      "INSERT INTO agents (id, slug, name, name_source, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      agentId,
      i.slug,
      i.name,
      i.nameSource,
      i.role,
      i.status,
      i.now,
      i.now,
    );
    const sq = `INSERT INTO agent_snapshots (id, agent_id, source, status, definition, effective_policies, clamped, ceilings_version, created_at)
       VALUES (?, ?, 'in_app', 'valid', ?, ?, ?, ?, ?) RETURNING ${SNAPSHOT_COLS}`;
    const snapshot = written(
      one<AgentSnapshotRow>(db, CODECS.agent_snapshots, sq, newId(), agentId, i.definition, i.effectivePolicies, i.clamped, i.ceilingsVersion, i.now),
      sq,
    );
    const uq = `UPDATE agents SET current_snapshot_id = ?, updated_at = ? WHERE id = ? RETURNING ${AGENT_COLS}`;
    const agent = written(one<AgentRow>(db, CODECS.agents, uq, snapshot.id, i.now, agentId), uq);
    return { agent, snapshot };
  });
}

const JOB_COLS = "id, agent_id, slug, kind, template, status, source_message_id, created_at, updated_at";

export function findAgentJob(db: WsDb, agentId: Uuid, slug: string): AgentJobRow | null {
  return one<AgentJobRow>(db, CODECS.agent_jobs, `SELECT ${JOB_COLS} FROM agent_jobs WHERE agent_id = ? AND slug = ?`, agentId, slug);
}

export function insertAgentJob(
  db: WsDb,
  i: { agentId: Uuid; slug: string; kind: JobKind; template: JobTemplate; status: JobStatus; now: Date },
): AgentJobRow {
  const q = `INSERT INTO agent_jobs (id, agent_id, slug, kind, template, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${JOB_COLS}`;
  return written(one<AgentJobRow>(db, CODECS.agent_jobs, q, newId(), i.agentId, i.slug, i.kind, i.template, i.status, i.now, i.now), q);
}

const ASK_COLS = `id, created_by, text, mention_agent_id, pack_id, shape, status, "trigger", next_run_at, formation, planner_attempts,
  question, question_answer, failure_reason, seed_key, created_at, updated_at, finished_at`;

/** 用意した依頼の印（asks.seed_key。D-70）で引く */
export function findAskBySeedKey(db: WsDb, seedKey: string): AskRow | null {
  return one<AskRow>(db, CODECS.asks, `SELECT ${ASK_COLS} FROM asks WHERE seed_key = ?`, seedKey);
}

export function insertAsk(
  db: WsDb,
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
): AskRow {
  const q = `INSERT INTO asks (id, created_by, text, shape, status, "trigger", next_run_at, formation, seed_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${ASK_COLS}`;
  return written(
    one<AskRow>(
      db,
      CODECS.asks,
      q,
      newId(),
      i.createdBy,
      i.text,
      i.shape,
      i.status,
      i.trigger ? { ...i.trigger } : null,
      i.nextRunAt,
      i.formation,
      i.seedKey,
      i.now,
      i.now,
    ),
    q,
  );
}

const MEMBER_COLS = "id, ask_id, agent_id, job_id, position, depends_on, is_aggregator, is_spokesperson, is_new, summary, created_at";

export function insertAskMember(
  db: WsDb,
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
): AskMemberRow {
  const q = `INSERT INTO ask_members (id, ask_id, agent_id, job_id, position, depends_on, is_aggregator, is_spokesperson, is_new, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${MEMBER_COLS}`;
  return written(
    one<AskMemberRow>(
      db,
      CODECS.ask_members,
      q,
      newId(),
      i.askId,
      i.agentId,
      i.jobId,
      i.position,
      [...i.dependsOn],
      i.isAggregator,
      i.isSpokesperson,
      i.isNew,
      i.summary,
      i.now,
    ),
    q,
  );
}

/** 依頼の担当（段の順） */
export function listAskMembers(db: WsDb, askId: Uuid): AskMemberRow[] {
  return all<AskMemberRow>(
    db,
    CODECS.ask_members,
    `SELECT ${MEMBER_COLS} FROM ask_members WHERE ask_id = ? ORDER BY position NULLS LAST, created_at, id`,
    askId,
  );
}
