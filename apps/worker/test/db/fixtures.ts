// 試験用の行を作る道具（packages/db/src/testing-fixtures.ts の WorkspaceDO 版）。どれも制約を満たす最小の行を作り、ID を返す。
// inWorkspace(fn) は試験ごとに新しい WorkspaceDO を作り、その中（runInDurableObject）で fn(db, ws) を呼ぶ

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "@open-team/kernel";
import { newId, one, run, wsDbOf, type Param, type WsDb } from "../../src/db/sqlite.ts";
import type {
  AskShape,
  AskStatus,
  Hex64,
  IntentStatus,
  JobTemplate,
  JsonObject,
  MicroUsd,
  TaskStatus,
  ToolClassification,
  ToolHash,
  Uuid,
} from "../../src/db/types.ts";
import { TASK_TERMINAL } from "../../src/db/types.ts";
import { initWorkspace } from "../../src/db/workspace.ts";

export const FIXED_NOW = new Date("2026-10-12T09:00:00.000Z");

export interface FxWorkspace {
  workspaceId: Uuid;
  /** 持ち主（D1 の利用者の ID） */
  userId: Uuid;
}

export interface FxWorkspaceOptions {
  now?: Date;
  killSwitchEngaged?: boolean;
  maxConcurrentTasks?: number;
}

/** 新しい WorkspaceDO の中で、ワークスペースの行（監査ログ seq 1 の workspace.created つき）を作ってから fn を呼ぶ */
export async function inWorkspace<T>(fn: (db: WsDb, ws: FxWorkspace) => T | Promise<T>, o: FxWorkspaceOptions = {}): Promise<T> {
  const stub = env.WORKSPACE.get(env.WORKSPACE.newUniqueId());
  return runInDurableObject(stub, async (_instance, state) => {
    const db = wsDbOf(state.storage);
    return fn(db, fxWorkspace(db, o));
  });
}

/** 決まった値から作る小文字16進64桁 */
export function fxHash(label: string): Hex64 {
  return sha256Hex(`fixture:${label}`);
}
export function fxToolHash(label: string): ToolHash {
  return `sha256:${fxHash(label)}`;
}
function rand(n = 4): string {
  return randomBytes(n).toString("hex");
}

function insert(db: WsDb, query: string, ...params: Param[]): Uuid {
  const row = one<{ id: Uuid }>(db, {}, query, ...params);
  if (!row) throw new Error(`行を作れなかった：${query.slice(0, 60)}`);
  return row.id;
}

/** ワークスペースの行（init と同じ。監査ログの seq 1 は workspace.created） */
export function fxWorkspace(db: WsDb, o: FxWorkspaceOptions = {}): FxWorkspace {
  const now = o.now ?? FIXED_NOW;
  const ws = { workspaceId: newId(), userId: newId() };
  initWorkspace(db, { workspaceId: ws.workspaceId, ownerUserId: ws.userId, now });
  if (o.killSwitchEngaged || o.maxConcurrentTasks !== undefined) {
    run(
      db,
      `UPDATE workspace SET kill_switch_engaged = ?, kill_switch_engaged_at = CASE WHEN ? THEN ? END, max_concurrent_tasks = ? WHERE id = 1`,
      o.killSwitchEngaged ?? false,
      o.killSwitchEngaged ?? false,
      now,
      o.maxConcurrentTasks ?? 3,
    );
  }
  return ws;
}

export interface FxToolSpec {
  name: string;
  classification?: ToolClassification;
  argRoles?: Record<string, "destination" | "content" | "option">;
}

/** コネクタとツール（既定は supplier と place_order・list_products） */
export function fxConnector(
  db: WsDb,
  o: { slug?: string; enabled?: boolean; tools?: FxToolSpec[] } = {},
): { connectorId: Uuid; slug: string; tools: Record<string, { id: Uuid; toolHash: ToolHash }> } {
  const slug = o.slug ?? "supplier";
  const connectorId = insert(
    db,
    `INSERT INTO connectors (id, slug, display_name, kind, url, auth, enabled) VALUES (?, ?, ?, 'mcp_remote', ?, ?, ?) RETURNING id`,
    newId(),
    slug,
    slug,
    `https://mcp.test/mcp/${slug}`,
    { type: "none" },
    o.enabled ?? true,
  );
  const specs = o.tools ?? [
    {
      name: "place_order",
      classification: "write" as const,
      argRoles: {
        supplier_id: "destination" as const,
        "items[].sku": "option" as const,
        "items[].quantity": "option" as const,
        "items[].unit_price": "option" as const,
        note: "content" as const,
      },
    },
    { name: "list_products", classification: "read" as const, argRoles: {} },
  ];
  const tools: Record<string, { id: Uuid; toolHash: ToolHash }> = {};
  for (const t of specs) {
    const toolHash = fxToolHash(`${slug}.${t.name}`);
    const id = insert(
      db,
      `INSERT INTO connector_tools (id, connector_id, name, description, input_schema, classification, arg_roles, tool_hash, classified_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system:seed') RETURNING id`,
      newId(),
      connectorId,
      t.name,
      `${t.name} の説明`,
      { type: "object" },
      t.classification ?? "read",
      t.argRoles ?? {},
      toolHash,
    );
    tools[t.name] = { id, toolHash };
  }
  return { connectorId, slug, tools };
}

export interface FxAgent {
  agentId: Uuid;
  snapshotId: Uuid;
  jobId: Uuid;
  jobSlug: string;
  policyHash: Hex64;
}

/** エージェント・有効なスナップショット（current）・仕事1つ */
export function fxAgent(
  db: WsDb,
  o: { name?: string; slug?: string; jobSlug?: string; template?: JobTemplate; status?: "idle" | "active" } = {},
): FxAgent {
  const jobSlug = o.jobSlug ?? "purchase";
  const name = o.name ?? `仕入れ係-${rand(2)}`;
  const policyHash = fxHash(`policy:${name}:${jobSlug}`);
  return db.transaction(() => {
    const agentId = insert(
      db,
      "INSERT INTO agents (id, slug, name, status) VALUES (?, ?, ?, ?) RETURNING id",
      newId(),
      o.slug ?? `a-${rand()}`,
      name,
      o.status ?? "active",
    );
    const definition: JsonObject = {
      version: 2,
      name,
      grants: { connectors: { supplier: { grant: ["place_order", "list_products"] } } },
      jobs: [{ id: jobSlug, kind: "recurring", template: o.template ?? "assistant", instructions: "在庫を見て発注する" }],
    };
    const snapshotId = insert(
      db,
      `INSERT INTO agent_snapshots (id, agent_id, status, definition, effective_policies, ceilings_version)
       VALUES (?, ?, 'valid', ?, ?, '0-H.1') RETURNING id`,
      newId(),
      agentId,
      definition,
      { [jobSlug]: { policy: { version: 1 }, hash: policyHash } },
    );
    run(db, "UPDATE agents SET current_snapshot_id = ? WHERE id = ?", snapshotId, agentId);
    const jobId = insert(
      db,
      "INSERT INTO agent_jobs (id, agent_id, slug, kind, template) VALUES (?, ?, ?, 'recurring', ?) RETURNING id",
      newId(),
      agentId,
      jobSlug,
      o.template ?? "assistant",
    );
    return { agentId, snapshotId, jobId, jobSlug, policyHash };
  });
}

/** 依頼（既定は順番・running） */
export function fxAsk(
  db: WsDb,
  ws: FxWorkspace,
  o: { status?: AskStatus; shape?: AskShape | null; text?: string; seedKey?: string | null } = {},
): { askId: Uuid } {
  const status = o.status ?? "running";
  const shape = o.shape === undefined ? (status === "generating" ? null : "chain") : o.shape;
  const askId = insert(
    db,
    `INSERT INTO asks (id, created_by, text, shape, status, failure_reason, seed_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    newId(),
    ws.userId,
    o.text ?? "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
    shape,
    status,
    status === "failed" && shape === null ? "planner_error" : null,
    o.seedKey ?? null,
  );
  return { askId };
}

/** 依頼の1回の実行 */
export function fxAskRun(db: WsDb, askId: Uuid, o: { runNo?: number } = {}): { askRunId: Uuid } {
  const askRunId = insert(
    db,
    "INSERT INTO ask_runs (id, ask_id, run_no, trigger_type) VALUES (?, ?, ?, 'initial') RETURNING id",
    newId(),
    askId,
    o.runNo ?? 1,
  );
  return { askRunId };
}

/** 依頼の担当 */
export function fxAskMember(
  db: WsDb,
  o: { askId: Uuid; agent: FxAgent; position?: number | null; isSpokesperson?: boolean; isAggregator?: boolean },
): { memberId: Uuid } {
  const memberId = insert(
    db,
    `INSERT INTO ask_members (id, ask_id, agent_id, job_id, position, is_spokesperson, is_aggregator, is_new, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, '担当') RETURNING id`,
    newId(),
    o.askId,
    o.agent.agentId,
    o.agent.jobId,
    o.position ?? null,
    o.isSpokesperson ?? false,
    o.isAggregator ?? false,
  );
  return { memberId };
}

export interface FxTaskOptions {
  status?: TaskStatus;
  askId?: Uuid | null;
  askRunId?: Uuid | null;
  /** 試し実行（trigger_type = dry_run） */
  dryRun?: boolean;
  tainted?: boolean;
  now?: Date;
}

/** タスク（既定は本番・running） */
export function fxTask(db: WsDb, ws: FxWorkspace, agent: FxAgent, o: FxTaskOptions = {}): { taskId: Uuid } {
  const status = o.status ?? "running";
  const now = o.now ?? FIXED_NOW;
  const dryRun = o.dryRun ?? false;
  const terminal = (TASK_TERMINAL as readonly string[]).includes(status);
  const taskId = insert(
    db,
    `INSERT INTO tasks (id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, trigger_type, is_dry_run,
                        tainted, taint_sources, status, halt_reason, fail_reason, started_at, finished_at, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    newId(),
    ws.userId,
    agent.agentId,
    agent.snapshotId,
    agent.jobId,
    o.askId ?? null,
    o.askRunId ?? null,
    dryRun ? "dry_run" : o.askId ? "ask" : "manual",
    dryRun,
    o.tainted ?? false,
    o.tainted ? [{ kind: "web_search", at: now.toISOString() }] : [],
    status,
    status === "halted" ? "kill_switch" : null,
    status === "failed" ? "agent_unable" : null,
    status === "queued" ? null : now,
    terminal ? now : null,
    now,
    now,
    now,
  );
  return { taskId };
}

/** Intent（既定は承認待ち。destinationKey を変えると別の宛先） */
export function fxIntent(
  db: WsDb,
  o: {
    taskId: Uuid;
    jobId: Uuid;
    connectorId: Uuid;
    status?: IntentStatus;
    destinationKey?: Hex64;
    toolHash?: ToolHash;
    enforced?: boolean;
    now?: Date;
  },
): { intentId: Uuid } {
  const status = o.status ?? "pending_approval";
  const now = o.now ?? FIXED_NOW;
  const toolHash = o.toolHash ?? fxToolHash("supplier.place_order");
  const args = { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 20, unit_price: 1800 }] };
  const intentId = insert(
    db,
    `INSERT INTO action_intents (id, task_id, job_id, connector_id, action, origin, payload, tool_hash, destination_key,
                                 option_digest, status, decision, reason_code, matched_rule, enforced, policy_hash, intent_hash,
                                 expires_at, fail_reason, expire_reason, executed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'mcp.supplier.place_order', 'agent', ?, ?, ?, ?, ?, 'approve', 'approval_required',
             'autonomy.mcp_write', ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    newId(),
    o.taskId,
    o.jobId,
    o.connectorId,
    { connectorId: o.connectorId, tool: "place_order", arguments: args, toolHash },
    toolHash,
    o.destinationKey ?? fxHash("dest:supplier-01"),
    fxHash("option:beans-20"),
    status,
    o.enforced ?? true,
    fxHash("policy"),
    fxHash(`intent:${rand()}`),
    status === "pending_approval" ? new Date(now.getTime() + 24 * 3600_000) : null,
    status === "failed" ? "tool_error" : null,
    status === "expired" ? "superseded" : null,
    status === "executed" || status === "verified" ? now : null,
    now,
    now,
  );
  return { intentId };
}

/** 承認（既定は pending。承認者はワークスペースの持ち主） */
export function fxApproval(
  db: WsDb,
  ws: FxWorkspace,
  o: { taskId: Uuid; intentId: Uuid; status?: "pending" | "approved" | "rejected" | "expired"; now?: Date },
): { approvalId: Uuid } {
  const status = o.status ?? "pending";
  const now = o.now ?? FIXED_NOW;
  const decided = status === "approved" || status === "rejected";
  const approvalId = insert(
    db,
    `INSERT INTO approvals (id, task_id, intent_id, status, risk_level, risk_score, approver_ids, decided_by, decided_at,
                            expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', 40, ?, ?, ?, ?, ?, ?) RETURNING id`,
    newId(),
    o.taskId,
    o.intentId,
    status,
    [ws.userId],
    decided ? ws.userId : null,
    decided ? now : null,
    new Date(now.getTime() + 24 * 3600_000),
    now,
    now,
  );
  return { approvalId };
}

/** 費用の行（既定はタスクの中の Gemini の呼び出し。1万マイクロドル = $0.01） */
export function fxUsage(
  db: WsDb,
  o: { taskId?: Uuid | null; agentId?: Uuid | null; askId?: Uuid | null; costMicroUsd?: MicroUsd; createdAt?: Date },
): void {
  const cost = o.costMicroUsd ?? 10_000;
  run(
    db,
    `INSERT INTO usage_records (id, task_id, agent_id, ask_id, provider, model, phase, input_tokens, output_tokens,
                                estimated_cost_micro_usd, cost_micro_usd, latency_ms, prompt_hash, created_at)
     VALUES (?, ?, ?, ?, 'google', 'gemini-test-001', 'plan', 100, 50, ?, ?, 10, ?, ?)`,
    newId(),
    o.taskId ?? null,
    o.agentId ?? null,
    o.askId ?? null,
    cost,
    cost,
    fxHash("prompt"),
    o.createdAt ?? FIXED_NOW,
  );
}
