// 試験用の行を作る道具（@open-team/db/testing から使う。本番のコードからは使わない）。
// どれも制約（CHECK・複合 FK）を満たす最小の行を作り、ID を返す。値を変えたいときは引数で上書きする

import { randomBytes } from "node:crypto";
import { sha256Hex } from "@open-team/kernel";
import { appendAuditLog } from "./audit.ts";
import { withTransaction, type Db, type Queryable, type Tx } from "./client.ts";
import type {
  AskShape,
  AskStatus,
  CaseSource,
  ExecutionVariant,
  Hex64,
  IntentStatus,
  JobTemplate,
  JsonObject,
  RunStatus,
  RunTrigger,
  SimWorld,
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

/** 利用者・ワークスペース・所属（owner）。audit: true なら workspace.created を seq 1 で足す */
export async function fxWorkspace(
  q: Db | Tx,
  o: {
    kind?: WorkspaceKind;
    now?: Date;
    lastSeenAt?: Date;
    deleteRequestedAt?: Date | null;
    seedVersion?: string | null;
    login?: string;
    killSwitchEngaged?: boolean;
    maxConcurrentTasks?: number;
    audit?: boolean;
  } = {},
): Promise<FxWorkspace> {
  const kind = o.kind ?? "guest";
  const now = o.now ?? FIXED_NOW;
  return withTransaction(q, async (tx) => {
    const user = await one<{ id: Uuid }>(tx, "INSERT INTO users (login, created_at, updated_at) VALUES ($1, $2, $2) RETURNING id", [
      o.login ?? `${kind === "owner" ? "owner" : "guest"}-${rand()}`,
      now,
    ]);
    const ws = await one<{ id: Uuid }>(
      tx,
      `INSERT INTO workspaces (kind, max_concurrent_tasks, seed_version, last_seen_at, delete_requested_at, kill_switch_engaged,
                               kill_switch_engaged_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN $7::timestamptz END, $7, $7) RETURNING id`,
      [
        kind,
        o.maxConcurrentTasks ?? (kind === "owner" ? 3 : 2),
        kind === "guest" ? (o.seedVersion === undefined ? "2026-10-12.1" : o.seedVersion) : null,
        o.lastSeenAt ?? now,
        o.deleteRequestedAt ?? null,
        o.killSwitchEngaged ?? false,
        now,
      ],
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

/** コネクタとツール（既定は sim-world の supplier と place_order・list_products） */
export async function fxConnector(
  q: Queryable,
  ws: FxWorkspace,
  o: { slug?: string; enabled?: boolean; tools?: FxToolSpec[] } = {},
): Promise<{ connectorId: Uuid; slug: string; tools: Record<string, { id: Uuid; toolHash: ToolHash }> }> {
  const slug = o.slug ?? "supplier";
  const c = await one<{ id: Uuid }>(
    q,
    `INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth, enabled)
     VALUES ($1, $2, $3, 'sim', $4, $5, $6) RETURNING id`,
    [ws.workspaceId, slug, slug, `https://sim-world.test/mcp/shop/${slug}`, { type: "none" }, o.enabled ?? true],
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
  rehearsalRunId?: Uuid | null;
  rehearsalScenarioId?: Uuid | null;
  shadow?: boolean;
  simExecutionId?: Uuid | null;
  executionVariant?: ExecutionVariant | null;
  simSnapshotId?: Uuid | null;
  tainted?: boolean;
  now?: Date;
}

/** タスク（既定は本番・running）。リハーサルのタスクは rehearsalRunId と rehearsalScenarioId を渡す（dry_run になる） */
export async function fxTask(q: Queryable, ws: FxWorkspace, agent: FxAgent, o: FxTaskOptions = {}): Promise<{ taskId: Uuid }> {
  const status = o.status ?? "running";
  const now = o.now ?? FIXED_NOW;
  const rehearsal = (o.rehearsalRunId ?? null) !== null;
  const terminal = (TASK_TERMINAL as readonly string[]).includes(status);
  const shadow = o.shadow ?? false;
  const variant = o.executionVariant !== undefined ? o.executionVariant : rehearsal ? (shadow ? "shadow" : "governed") : null;
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO tasks (workspace_id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, trigger_type, is_dry_run,
                        rehearsal_run_id, rehearsal_scenario_id, shadow, sim_execution_id, execution_variant, sim_snapshot_id,
                        tainted, taint_sources, status, halt_reason, fail_reason, started_at, finished_at, queued_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $23, $23)
     RETURNING id`,
    [
      ws.workspaceId,
      ws.userId,
      agent.agentId,
      agent.snapshotId,
      agent.jobId,
      o.askId ?? null,
      o.askRunId ?? null,
      rehearsal ? "dry_run" : o.askId ? "ask" : "manual",
      rehearsal,
      o.rehearsalRunId ?? null,
      o.rehearsalScenarioId ?? null,
      shadow,
      o.simExecutionId ?? null,
      variant,
      o.simSnapshotId ?? null,
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

/** リハーサルの走行（対象は jobId か askId のちょうど片方） */
export async function fxRehearsalRun(
  q: Queryable,
  ws: FxWorkspace,
  o: { jobId?: Uuid; askId?: Uuid; status?: RunStatus; trigger?: RunTrigger; parentRunId?: Uuid | null },
): Promise<{ runId: Uuid }> {
  const trigger = o.trigger ?? "manual";
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO rehearsal_runs (workspace_id, job_id, ask_id, trigger, reason, parent_run_id, status, seed, model_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 12345, 'gemini-test-001') RETURNING id`,
    [
      ws.workspaceId,
      o.jobId ?? null,
      o.askId ?? null,
      trigger,
      trigger === "recertify" ? "case_added" : null,
      o.parentRunId ?? null,
      o.status ?? "running",
    ],
  );
  return { runId: r.id };
}

/** 試験（既定は generated の F-04）。incident は simSnapshotId が要る */
export async function fxRehearsalCase(
  q: Queryable,
  ws: FxWorkspace,
  o: { jobId?: Uuid; askId?: Uuid; source?: CaseSource; simSnapshotId?: Uuid | null; sourceTaskId?: Uuid | null; reasonCode?: string },
): Promise<{ caseId: Uuid }> {
  const source = o.source ?? "generated";
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO rehearsal_cases (workspace_id, job_id, ask_id, source, fault_ids, scenario, seed, sim_snapshot_id, user_text,
                                  source_task_id, reason_code, incident_kind)
     VALUES ($1, $2, $3, $4, $5, $6, 7, $7, $8, $9, $10, $11) RETURNING id`,
    [
      ws.workspaceId,
      o.jobId ?? null,
      o.askId ?? null,
      source,
      source === "incident" ? [] : ["F-04"],
      { schemaVersion: 1, world: "shop", seed: 7, faults: [] },
      source === "incident" ? (o.simSnapshotId ?? null) : null,
      source === "user" ? "店長の名前で至急の発注が来る" : null,
      source === "incident" ? (o.sourceTaskId ?? null) : null,
      source === "incident" ? (o.reasonCode ?? "guard_exceeded") : null,
      source === "incident" ? "kernel_approve" : null,
    ],
  );
  return { caseId: r.id };
}

/** 状況（走行の中の1件） */
export async function fxRehearsalScenario(
  q: Queryable,
  ws: FxWorkspace,
  o: { runId: Uuid; caseId: Uuid; ordinal?: number },
): Promise<{ scenarioId: Uuid }> {
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO rehearsal_scenarios (workspace_id, rehearsal_run_id, case_id, ordinal, fault_ids, scenario, seed)
     VALUES ($1, $2, $3, $4, '{F-04}', $5, 7) RETURNING id`,
    [ws.workspaceId, o.runId, o.caseId, o.ordinal ?? 1, { schemaVersion: 1, world: "shop", seed: 7, faults: [] }],
  );
  return { scenarioId: r.id };
}

/** sim の走行（rehearsalRunId がなければデモ店舗 live） */
export async function fxSimExecution(
  q: Queryable,
  ws: FxWorkspace,
  o: { rehearsalRunId?: Uuid | null; variant?: ExecutionVariant; world?: SimWorld; id?: Uuid } = {},
): Promise<{ executionId: Uuid }> {
  const run = o.rehearsalRunId ?? null;
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO sim.executions (id, workspace_id, world, rehearsal_run_id, variant, seed, seed_version, scenario, initial_state, state)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, 7, '2026-10-12.1', $6, $7, $7) RETURNING id`,
    [
      o.id ?? null,
      ws.workspaceId,
      o.world ?? "shop",
      run,
      o.variant ?? (run ? "governed" : "live"),
      run ? { schemaVersion: 1, world: "shop", seed: 7, faults: [] } : null,
      { schemaVersion: 1, world: "shop" },
    ],
  );
  return { executionId: r.id };
}

/** sim のスナップショット（デモ店舗の走行から） */
export async function fxSimSnapshot(
  q: Queryable,
  ws: FxWorkspace,
  o: { executionId: Uuid; sourceTaskId: Uuid },
): Promise<{ snapshotId: Uuid }> {
  const r = await one<{ id: Uuid }>(
    q,
    `INSERT INTO sim.snapshots (workspace_id, world, execution_id, execution_version, seed, seed_version, state, state_hash, source_task_id)
     VALUES ($1, 'shop', $2, 1, 7, '2026-10-12.1', $3, $4, $5) RETURNING id`,
    [ws.workspaceId, o.executionId, { schemaVersion: 1, world: "shop" }, fxHash("state"), o.sourceTaskId],
  );
  return { snapshotId: r.id };
}

/** 費用の行（既定はタスクの中の Gemini の呼び出し） */
export async function fxUsage(
  q: Queryable,
  ws: FxWorkspace,
  o: { taskId?: Uuid | null; agentId?: Uuid | null; askId?: Uuid | null; rehearsalRunId?: Uuid | null; costUsd?: string; createdAt?: Date },
): Promise<void> {
  await q.query(
    `INSERT INTO usage_records (workspace_id, task_id, agent_id, ask_id, rehearsal_run_id, provider, model, phase, input_tokens,
                                output_tokens, estimated_cost_usd, cost_usd, latency_ms, prompt_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, 'google', 'gemini-test-001', 'plan', 100, 50, $6, $6, 10, $7, $8)`,
    [
      ws.workspaceId,
      o.taskId ?? null,
      o.agentId ?? null,
      o.askId ?? null,
      o.rehearsalRunId ?? null,
      o.costUsd ?? "0.010000",
      fxHash("prompt"),
      o.createdAt ?? FIXED_NOW,
    ],
  );
}
