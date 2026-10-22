// 試験用の行を作る道具（@open-team/db/testing から使う。本番のコードからは使わない）。
// どれも制約（CHECK・複合 FK）を満たす最小の行を作り、ID を返す。値を変えたいときは引数で上書きする

import { randomBytes } from "node:crypto";
import { sha256Hex } from "@open-team/kernel";
import { appendAuditLog } from "./audit.ts";
import { withTransaction, type Db, type Queryable, type Tx } from "./client.ts";
import type {
  AskShape,
  AskStatus,
  Hex64,
  IntentStatus,
  JobTemplate,
  JsonObject,
  TaskStatus,
  ToolClassification,
  ToolHash,
  Uuid,
  WorkspaceKind,
} from "./types.ts";
import { TASK_TERMINAL } from "./types.ts";
import type { WsCtx } from "./workspace.ts";

export interface FxWorkspace {
  workspaceId: Uuid;
  userId: Uuid;
  kind: WorkspaceKind;
  ctx: WsCtx & { userId: Uuid };
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
const FIXED_NOW = new Date("2026-10-12T09:00:00.000Z");

async function one<T extends object>(q: Queryable, text: string, params: readonly unknown[]): Promise<T> {
  const r = await q.query<T>(text, params);
  const row = r.rows[0];
  if (!row) throw new Error(`行を作れなかった：${text.slice(0, 60)}`);
  return row;
}

/**
 * 利用者・ワークスペース（オーナー）・所属（owner）。audit: true なら workspace.created を seq 1 で足す。
 * ワークスペースはオーナーの1つだけ（workspaces_single_owner_uq）。分離の試験のために2つ目を作るときは second: true：
 * この試験のデータベースの一意の索引を外してから作る（本番では作れない。workspace_id で絞る作りを確かめるためだけ）
 */
export async function fxWorkspace(
  q: Db | Tx,
  o: {
    now?: Date;
    lastSeenAt?: Date;
    login?: string;
    killSwitchEngaged?: boolean;
    maxConcurrentTasks?: number;
    audit?: boolean;
    second?: boolean;
  } = {},
): Promise<FxWorkspace> {
  const kind: WorkspaceKind = "owner";
  const now = o.now ?? FIXED_NOW;
  return withTransaction(q, async (tx) => {
    if (o.second) await tx.query("DROP INDEX IF EXISTS workspaces_single_owner_uq");
    const user = await one<{ id: Uuid }>(tx, "INSERT INTO users (login, created_at, updated_at) VALUES ($1, $2, $2) RETURNING id", [
      o.login ?? `owner-${rand()}`,
      now,
    ]);
    const ws = await one<{ id: Uuid }>(
      tx,
      `INSERT INTO workspaces (kind, max_concurrent_tasks, last_seen_at, kill_switch_engaged, kill_switch_engaged_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN $5::timestamptz END, $5, $5) RETURNING id`,
      [kind, o.maxConcurrentTasks ?? 3, o.lastSeenAt ?? now, o.killSwitchEngaged ?? false, now],
    );
    await tx.query("INSERT INTO memberships (workspace_id, user_id, role, created_at, updated_at) VALUES ($1, $2, 'owner', $3, $3)", [
      ws.id,
      user.id,
      now,
    ]);
    if (o.audit) {
      await appendAuditLog(tx, ws.id, { eventType: "workspace.created", actorType: "system", actorId: "app", payload: { kind } }, now);
    }
    return { workspaceId: ws.id, userId: user.id, kind, ctx: { workspaceId: ws.id, kind, userId: user.id } };
  });
}

export interface FxToolSpec {
  name: string;
  classification?: ToolClassification;
  argRoles?: Record<string, "destination" | "content" | "option">;
}

/** コネクタとツール（既定は supplier と place_order・list_products） */
export async function fxConnector(
  q: Queryable,
  ws: FxWorkspace,
  o: { slug?: string; enabled?: boolean; tools?: FxToolSpec[] } = {},
): Promise<{ connectorId: Uuid; slug: string; tools: Record<string, { id: Uuid; toolHash: ToolHash }> }> {
  const slug = o.slug ?? "supplier";
  const c = await one<{ id: Uuid }>(
    q,
    `INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth, enabled)
     VALUES ($1, $2, $3, 'mcp_remote', $4, $5, $6) RETURNING id`,
    [ws.workspaceId, slug, slug, `https://mcp.test/mcp/${slug}`, { type: "none" }, o.enabled ?? true],
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
    const row = await one<{ id: Uuid }>(
      q,
      `INSERT INTO connector_tools (workspace_id, connector_id, name, description, input_schema, classification, arg_roles, tool_hash,
                                    classified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'system:seed') RETURNING id`,
      [ws.workspaceId, c.id, t.name, `${t.name} の説明`, { type: "object" }, t.classification ?? "read", t.argRoles ?? {}, toolHash],
    );
    tools[t.name] = { id: row.id, toolHash };
  }
  return { connectorId: c.id, slug, tools };
}

export interface FxAgent {
  agentId: Uuid;
  snapshotId: Uuid;
  jobId: Uuid;
  jobSlug: string;
  policyHash: Hex64;
}

/** エージェント・有効なスナップショット（current）・仕事1つ */
export async function fxAgent(
  q: Db | Tx,
  ws: FxWorkspace,
  o: { name?: string; slug?: string; jobSlug?: string; template?: JobTemplate; status?: "idle" | "active" } = {},
): Promise<FxAgent> {
  const jobSlug = o.jobSlug ?? "purchase";
  const name = o.name ?? `仕入れ係-${rand(2)}`;
  const policyHash = fxHash(`policy:${name}:${jobSlug}`);
  return withTransaction(q, async (tx) => {
    const agent = await one<{ id: Uuid }>(
      tx,
      "INSERT INTO agents (workspace_id, slug, name, status) VALUES ($1, $2, $3, $4) RETURNING id",
      [ws.workspaceId, o.slug ?? `a-${rand()}`, name, o.status ?? "active"],
    );
    const definition: JsonObject = {
      version: 2,
      name,
      grants: { connectors: { supplier: { grant: ["place_order", "list_products"] } } },
      jobs: [{ id: jobSlug, kind: "recurring", template: o.template ?? "assistant", instructions: "在庫を見て発注する" }],
    };
    const snap = await one<{ id: Uuid }>(
      tx,
      `INSERT INTO agent_snapshots (workspace_id, agent_id, status, definition, effective_policies, ceilings_version)
       VALUES ($1, $2, 'valid', $3, $4, '0-H.1') RETURNING id`,
      [ws.workspaceId, agent.id, definition, { [jobSlug]: { policy: { version: 1 }, hash: policyHash } }],
    );
    await tx.query("UPDATE agents SET current_snapshot_id = $2 WHERE id = $1", [agent.id, snap.id]);
    const job = await one<{ id: Uuid }>(
      tx,
      "INSERT INTO agent_jobs (workspace_id, agent_id, slug, kind, template) VALUES ($1, $2, $3, 'recurring', $4) RETURNING id",
      [ws.workspaceId, agent.id, jobSlug, o.template ?? "assistant"],
    );
    return { agentId: agent.id, snapshotId: snap.id, jobId: job.id, jobSlug, policyHash };
  });
}

/** 依頼（既定は順番・running） */
export async function fxAsk(
  q: Queryable,
  ws: FxWorkspace,
  o: { status?: AskStatus; shape?: AskShape | null; text?: string; seedKey?: string | null } = {},
): Promise<{ askId: Uuid }> {
  const status = o.status ?? "running";
  const shape = o.shape === undefined ? (status === "generating" ? null : "chain") : o.shape;
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO asks (workspace_id, created_by, text, shape, status, failure_reason, seed_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      ws.workspaceId,
      ws.userId,
      o.text ?? "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
      shape,
      status,
      status === "failed" && shape === null ? "planner_error" : null,
      o.seedKey ?? null,
    ],
  );
  return { askId: r.id };
}

/** 依頼の1回の実行（本番） */
export async function fxAskRun(q: Queryable, ws: FxWorkspace, askId: Uuid, o: { runNo?: number } = {}): Promise<{ askRunId: Uuid }> {
  const r = await one<{ id: Uuid }>(
    q,
    "INSERT INTO ask_runs (workspace_id, ask_id, run_no, trigger_type) VALUES ($1, $2, $3, 'initial') RETURNING id",
    [ws.workspaceId, askId, o.runNo ?? 1],
  );
  return { askRunId: r.id };
}

/** 依頼の担当 */
export async function fxAskMember(
  q: Queryable,
  ws: FxWorkspace,
  o: { askId: Uuid; agent: FxAgent; position?: number | null; isSpokesperson?: boolean; isAggregator?: boolean },
): Promise<{ memberId: Uuid }> {
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO ask_members (workspace_id, ask_id, agent_id, job_id, position, is_spokesperson, is_aggregator, is_new, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, '担当') RETURNING id`,
    [ws.workspaceId, o.askId, o.agent.agentId, o.agent.jobId, o.position ?? null, o.isSpokesperson ?? false, o.isAggregator ?? false],
  );
  return { memberId: r.id };
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
export async function fxTask(q: Queryable, ws: FxWorkspace, agent: FxAgent, o: FxTaskOptions = {}): Promise<{ taskId: Uuid }> {
  const status = o.status ?? "running";
  const now = o.now ?? FIXED_NOW;
  const dryRun = o.dryRun ?? false;
  const terminal = (TASK_TERMINAL as readonly string[]).includes(status);
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO tasks (workspace_id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, trigger_type, is_dry_run,
                        tainted, taint_sources, status, halt_reason, fail_reason, started_at, finished_at, queued_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, $17)
     RETURNING id`,
    [
      ws.workspaceId,
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
    ],
  );
  return { taskId: r.id };
}

/** Intent（既定は承認待ち。destinationKey を変えると別の宛先） */
export async function fxIntent(
  q: Queryable,
  ws: FxWorkspace,
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
): Promise<{ intentId: Uuid }> {
  const status = o.status ?? "pending_approval";
  const now = o.now ?? FIXED_NOW;
  const toolHash = o.toolHash ?? fxToolHash("supplier.place_order");
  const args = { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 20, unit_price: 1800 }] };
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO action_intents (workspace_id, task_id, job_id, connector_id, action, origin, payload, tool_hash, destination_key,
                                 option_digest, status, decision, reason_code, matched_rule, enforced, policy_hash, intent_hash,
                                 expires_at, fail_reason, expire_reason, executed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'mcp.supplier.place_order', 'agent', $5, $6, $7, $8, $9, 'approve', 'approval_required',
             'autonomy.mcp_write', $10, $11, $12, $13, $14, $15, $16, $17, $17)
     RETURNING id`,
    [
      ws.workspaceId,
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
    ],
  );
  return { intentId: r.id };
}

/** 承認（既定は pending。承認者はワークスペースの利用者） */
export async function fxApproval(
  q: Queryable,
  ws: FxWorkspace,
  o: { taskId: Uuid; intentId: Uuid; status?: "pending" | "approved" | "rejected" | "expired"; now?: Date },
): Promise<{ approvalId: Uuid }> {
  const status = o.status ?? "pending";
  const now = o.now ?? FIXED_NOW;
  const decided = status === "approved" || status === "rejected";
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO approvals (workspace_id, task_id, intent_id, status, risk_level, risk_score, approver_ids, decided_by, decided_at,
                            expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'medium', 40, $5, $6, $7, $8, $9, $9) RETURNING id`,
    [
      ws.workspaceId,
      o.taskId,
      o.intentId,
      status,
      [ws.userId],
      decided ? ws.userId : null,
      decided ? now : null,
      new Date(now.getTime() + 24 * 3600_000),
      now,
    ],
  );
  return { approvalId: r.id };
}

/** 費用の行（既定はタスクの中の Gemini の呼び出し） */
export async function fxUsage(
  q: Queryable,
  ws: FxWorkspace,
  o: { taskId?: Uuid | null; agentId?: Uuid | null; askId?: Uuid | null; costUsd?: string; createdAt?: Date },
): Promise<void> {
  await q.query(
    `INSERT INTO usage_records (workspace_id, task_id, agent_id, ask_id, provider, model, phase, input_tokens,
                                output_tokens, estimated_cost_usd, cost_usd, latency_ms, prompt_hash, created_at)
     VALUES ($1, $2, $3, $4, 'google', 'gemini-test-001', 'plan', 100, 50, $5, $5, 10, $6, $7)`,
    [
      ws.workspaceId,
      o.taskId ?? null,
      o.agentId ?? null,
      o.askId ?? null,
      o.costUsd ?? "0.010000",
      fxHash("prompt"),
      o.createdAt ?? FIXED_NOW,
    ],
  );
}
