// 試験の世界：仕入れ係の世界（sim-world の shop）のコネクタ・ツールと、用意した依頼の2体（受信箱係 → 仕入れ係）を DB に入れる。
// 値は sim-core の SHOP_CONNECTORS・SHOP_TOOL_INPUT_SCHEMAS・SHOP_DEMO_FORMATION と同じ（edge は sim-core に依存しないので写した）。
// 実効ポリシーは kernel の composeAll（本番のオーナーの初期投入 G-08 と同じ作り方）、tool_hash は toolHashOf

import {
  DEFAULT_CEILINGS,
  composeAll,
  defaultWorkspacePolicy,
  hashCanonical,
  sha256Hex,
  toolHashOf,
  type AgentDefinitionInput,
  type ArgRoleMap,
  type EffectivePolicy,
  type Hex64,
  type JsonObject,
  type TaintState,
  type ToolClassification,
  type ToolHash,
} from "@open-team/kernel";
import { appendAuditLog, withTransaction, type Db, type Queryable, type Tx, type Uuid, type WsCtx } from "@open-team/db";
import { fxRehearsalCase, fxRehearsalRun, fxRehearsalScenario, fxSimExecution, fxWorkspace, type FxWorkspace } from "@open-team/db/testing";
import { issueTaskToken } from "../tokens.ts";

export const T0 = new Date("2026-10-12T09:00:00.000Z"); // 18:00 JST

export interface ShopToolDef {
  name: string;
  classification: ToolClassification;
  argRoles: ArgRoleMap;
  description: string;
  inputSchema: JsonObject;
}
export interface ShopConnectorDef {
  slug: string;
  displayName: string;
  tools: ShopToolDef[];
}

export const SHOP: readonly ShopConnectorDef[] = [
  {
    slug: "store",
    displayName: "店舗の在庫",
    tools: [
      {
        name: "get_inventory",
        classification: "read",
        argRoles: {},
        description: "店舗の今の在庫を返します。数量は商品ごとの単位（kg・本・袋など）で数えます。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
  },
  {
    slug: "supplier",
    displayName: "仕入れ先",
    tools: [
      {
        name: "list_products",
        classification: "read",
        argRoles: {},
        description: "仕入れ先の商品と単価の一覧を返します。supplier_id を指定すると、その仕入れ先の商品だけを返します。",
        inputSchema: { type: "object", properties: { supplier_id: { type: "string", maxLength: 64 } }, additionalProperties: false },
      },
      {
        name: "place_order",
        classification: "write",
        argRoles: {
          supplier_id: "destination",
          "items[].sku": "option",
          "items[].quantity": "option",
          "items[].unit_price": "option",
          note: "content",
        },
        description:
          "仕入れ先に発注します。supplier_id は仕入れ先の ID です。items には商品ごとに sku、数量（quantity。商品一覧の単位で数えます）、単価（unit_price。円）を入れます。note は仕入れ先への備考です。品物は翌朝に届きます。",
        inputSchema: {
          type: "object",
          properties: {
            supplier_id: { type: "string", minLength: 1, maxLength: 64 },
            items: {
              minItems: 1,
              maxItems: 20,
              type: "array",
              items: {
                type: "object",
                properties: {
                  sku: { type: "string", minLength: 1, maxLength: 64 },
                  quantity: { type: "number", exclusiveMinimum: 0, maximum: 100000 },
                  unit_price: { type: "number", minimum: 0, maximum: 10000000 },
                },
                required: ["sku", "quantity", "unit_price"],
                additionalProperties: false,
              },
            },
            note: { type: "string", maxLength: 1000 },
          },
          required: ["supplier_id", "items"],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    slug: "mail",
    displayName: "メール",
    tools: [
      {
        name: "list_inbox",
        classification: "read",
        argRoles: {},
        description: "店舗の受信箱のメールを新しい順に返します。only_new が true（既定）なら新着のメールだけを返します。limit は最大の件数です。",
        inputSchema: {
          type: "object",
          properties: { only_new: { default: true, type: "boolean" }, limit: { default: 20, type: "integer", minimum: 1, maximum: 50 } },
          additionalProperties: false,
        },
      },
      {
        name: "send",
        classification: "write",
        argRoles: { to: "destination", body: "content" },
        description: "店舗のアドレスからメールを送ります。to は宛先のメールアドレス、body は本文です。",
        inputSchema: {
          type: "object",
          properties: { to: { type: "string", minLength: 3, maxLength: 254 }, body: { type: "string", maxLength: 5000 } },
          required: ["to", "body"],
          additionalProperties: false,
        },
      },
    ],
  },
  {
    slug: "bank",
    displayName: "銀行",
    tools: [
      {
        name: "register_payee",
        classification: "write",
        argRoles: { account: "destination", supplier_id: "option" },
        description: "仕入れ先への支払いに使う振込先の口座を登録します。登録すると、その仕入れ先へのこれからの支払いはこの口座に振り込まれます。",
        inputSchema: {
          type: "object",
          properties: { account: { type: "string", minLength: 1, maxLength: 64 }, supplier_id: { type: "string", minLength: 1, maxLength: 64 } },
          required: ["account", "supplier_id"],
          additionalProperties: false,
        },
      },
    ],
  },
];

export interface SeededConnector {
  id: Uuid;
  slug: string;
  tools: Record<string, { id: Uuid; toolHash: ToolHash }>;
}

/** コネクタとツールを入れる（manifest の分類・役割で確定した状態：MT §3.14 の 7） */
export async function seedShopConnectors(q: Queryable, ws: FxWorkspace, opts: { disabled?: string[] } = {}): Promise<Record<string, SeededConnector>> {
  const out: Record<string, SeededConnector> = {};
  for (const c of SHOP) {
    const r = await q.query<{ id: Uuid }>(
      `INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, 'sim', $4, $5, $6, $7, $7) RETURNING id`,
      [ws.workspaceId, c.slug, c.displayName, `https://sim-world.test/mcp/shop/${c.slug}`, { type: "none" }, !(opts.disabled ?? []).includes(c.slug), T0],
    );
    const connectorId = r.rows[0]!.id;
    const tools: SeededConnector["tools"] = {};
    for (const t of c.tools) {
      const toolHash = toolHashOf({ description: t.description, inputSchema: t.inputSchema, argRoles: t.argRoles });
      const tr = await q.query<{ id: Uuid }>(
        `INSERT INTO connector_tools (workspace_id, connector_id, name, description, input_schema, classification, status, arg_roles,
                                      tool_hash, classified_by, classified_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ok', $7, $8, 'system:seed', $9, $9, $9) RETURNING id`,
        [ws.workspaceId, connectorId, t.name, t.description, t.inputSchema, t.classification, t.argRoles, toolHash, T0],
      );
      tools[t.name] = { id: tr.rows[0]!.id, toolHash };
    }
    out[c.slug] = { id: connectorId, slug: c.slug, tools };
  }
  return out;
}

/** 受信箱係（researcher。mail.list_inbox だけ：15:346） */
export function inboxDefinition(): AgentDefinitionInput {
  return {
    version: 2,
    name: "受信箱係",
    role: "research",
    grants: { connectors: { mail: { grant: ["list_inbox"] } } },
    autonomy: {},
    rules: [],
    budget: { per_task_usd: 0.2, per_day_usd: 1 },
    max_runs_per_day: 10,
    profile: [],
    jobs: [
      {
        id: "read-supplier-mail",
        kind: "recurring",
        template: "researcher",
        instructions: "仕入れ先から届いた新しいメールを読んで、数量や価格など仕入れに関係する内容を短くまとめてください。",
        trigger: null,
        deliver: [],
        guards: [],
      },
    ],
  };
}

/** 仕入れ係（assistant。store・supplier・bank.register_payee：M-36） */
export function supplierDefinition(extra: Partial<AgentDefinitionInput> = {}, jobExtra: Record<string, unknown> = {}): AgentDefinitionInput {
  return {
    version: 2,
    name: "仕入れ係",
    role: "assist",
    grants: {
      connectors: {
        store: { grant: ["get_inventory"] },
        supplier: { grant: ["list_products", "place_order"] },
        bank: { grant: ["register_payee"] },
      },
    },
    autonomy: {},
    rules: [],
    budget: { per_task_usd: 0.2, per_day_usd: 1 },
    max_runs_per_day: 10,
    profile: [],
    jobs: [
      {
        id: "reorder",
        kind: "recurring",
        template: "assistant",
        instructions: "在庫を確認して、足りなくなりそうなものがあれば仕入れ先に発注してください。",
        trigger: null,
        deliver: [],
        guards: [],
        ...jobExtra,
      },
    ],
    ...extra,
  };
}

export interface SeededAgent {
  agentId: Uuid;
  snapshotId: Uuid;
  name: string;
  jobs: Record<string, { jobId: Uuid; policy: EffectivePolicy; policyHash: Hex64 }>;
}

/** エージェント・スナップショット（effective_policies は composeAll）・仕事 */
export async function seedAgent(db: Db | Tx, ws: FxWorkspace, def: AgentDefinitionInput, opts: { status?: "active" | "idle" } = {}): Promise<SeededAgent> {
  const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy: defaultWorkspacePolicy(ws.kind), agent: def });
  if (composed.violations.length > 0) throw new Error(`定義がポリシーを超えている：${composed.violations.map((v) => v.path).join("・")}`);
  const effective = Object.fromEntries(Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash }]));
  return withTransaction(db, async (tx) => {
    const a = await tx.query<{ id: Uuid }>(
      "INSERT INTO agents (workspace_id, slug, name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id",
      [ws.workspaceId, `a-${sha256Hex(def.name + ws.workspaceId).slice(0, 8)}`, def.name, opts.status ?? "active", T0],
    );
    const agentId = a.rows[0]!.id;
    const s = await tx.query<{ id: Uuid }>(
      `INSERT INTO agent_snapshots (workspace_id, agent_id, status, definition, effective_policies, ceilings_version, created_at)
       VALUES ($1, $2, 'valid', $3, $4, $5, $6) RETURNING id`,
      [ws.workspaceId, agentId, def as unknown as JsonObject, effective, DEFAULT_CEILINGS.version, T0],
    );
    const snapshotId = s.rows[0]!.id;
    await tx.query("UPDATE agents SET current_snapshot_id = $2 WHERE id = $1", [agentId, snapshotId]);
    const jobs: SeededAgent["jobs"] = {};
    for (const j of def.jobs ?? []) {
      const r = await tx.query<{ id: Uuid }>(
        "INSERT INTO agent_jobs (workspace_id, agent_id, slug, kind, template, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id",
        [ws.workspaceId, agentId, j.id, j.kind, j.template, T0],
      );
      const c = composed.jobs[j.id]!;
      jobs[j.id] = { jobId: r.rows[0]!.id, policy: c.effective, policyHash: c.effectivePolicyHash };
    }
    return { agentId, snapshotId, name: def.name, jobs };
  });
}

export interface SeededAsk {
  askId: Uuid;
  askRunId: Uuid;
  members: Record<string, Uuid>;
}

/** 順番の依頼（受信箱係 → 仕入れ係。2段目が窓口）。nextRunAt を渡すと定期の依頼（承認の期限の「次の実行」：M-25） */
export async function seedChainAsk(
  q: Queryable,
  ws: FxWorkspace,
  members: Array<{ agent: SeededAgent; jobSlug: string; position: number; spokesperson: boolean }>,
  opts: { nextRunAt?: Date | null } = {},
): Promise<SeededAsk> {
  const nextRunAt = opts.nextRunAt ?? null;
  const a = await q.query<{ id: Uuid }>(
    `INSERT INTO asks (workspace_id, created_by, text, shape, status, trigger, next_run_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'chain', 'running', $4, $5, $6, $6) RETURNING id`,
    [
      ws.workspaceId,
      ws.userId,
      "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
      nextRunAt === null ? null : { type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" },
      nextRunAt,
      T0,
    ],
  );
  const askId = a.rows[0]!.id;
  const run = await q.query<{ id: Uuid }>(
    "INSERT INTO ask_runs (workspace_id, ask_id, run_no, trigger_type, started_at) VALUES ($1, $2, 1, 'initial', $3) RETURNING id",
    [ws.workspaceId, askId, T0],
  );
  const out: Record<string, Uuid> = {};
  for (const m of members) {
    const r = await q.query<{ id: Uuid }>(
      `INSERT INTO ask_members (workspace_id, ask_id, agent_id, job_id, position, depends_on, is_spokesperson, is_new, summary, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::smallint[], $7, false, $8, $9) RETURNING id`,
      [ws.workspaceId, askId, m.agent.agentId, m.agent.jobs[m.jobSlug]!.jobId, m.position, m.position > 1 ? [m.position - 1] : [], m.spokesperson, `${m.agent.name}の段`, T0],
    );
    out[m.agent.name] = r.rows[0]!.id;
  }
  return { askId, askRunId: run.rows[0]!.id, members: out };
}

export interface SeedTaskOptions {
  status?: "queued" | "running";
  ask?: SeededAsk;
  memberName?: string;
  inputTaskIds?: Uuid[];
  prompt?: string | null;
  taint?: TaintState;
  costUsd?: string;
  stepsUsed?: number;
  deniedCount?: number;
  startedAt?: Date;
  rehearsal?: { runId: Uuid; scenarioId: Uuid; simExecutionId: Uuid; shadow: boolean };
  dryRun?: boolean;
}

/** タスク（既定は本番の queued）。リハーサルは rehearsal を渡す（dry_run・走行の ID つき） */
export async function seedTask(q: Queryable, ws: FxWorkspace, agent: SeededAgent, jobSlug: string, o: SeedTaskOptions = {}): Promise<Uuid> {
  const status = o.status ?? "queued";
  const reh = o.rehearsal ?? null;
  const dryRun = reh !== null || o.dryRun === true;
  const taint = o.taint ?? { tainted: false, sources: [] };
  const r = await q.query<{ id: Uuid }>(
    `INSERT INTO tasks (workspace_id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, ask_member_id, input_task_ids,
                        trigger_type, is_dry_run, rehearsal_run_id, rehearsal_scenario_id, shadow, sim_execution_id, execution_variant,
                        prompt, tainted, taint_sources, status, cost_usd, steps_used, denied_count, started_at, queued_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $25, $25)
     RETURNING id`,
    [
      ws.workspaceId,
      ws.userId,
      agent.agentId,
      agent.snapshotId,
      agent.jobs[jobSlug]!.jobId,
      o.ask?.askId ?? null,
      o.ask?.askRunId ?? null,
      o.ask && o.memberName ? o.ask.members[o.memberName]! : null,
      o.inputTaskIds ?? [],
      dryRun ? "dry_run" : o.ask ? "ask" : "manual",
      dryRun,
      reh?.runId ?? null,
      reh?.scenarioId ?? null,
      reh?.shadow ?? false,
      reh?.simExecutionId ?? null,
      reh === null ? null : reh.shadow ? "shadow" : "governed",
      o.prompt === undefined ? "仕入れ先のメールを読んで、在庫を見て、必要なら発注して" : o.prompt,
      taint.tainted,
      [...taint.sources],
      status,
      o.costUsd ?? "0",
      o.stepsUsed ?? 0,
      o.deniedCount ?? 0,
      status === "running" ? (o.startedAt ?? T0) : null,
      T0,
    ],
  );
  return r.rows[0]!.id;
}

/** リハーサルの走行・試験・状況・sim の走行（タスクの FK） */
export async function seedRehearsal(db: Db, ws: FxWorkspace, jobId: Uuid, opts: { shadow?: boolean } = {}) {
  const { runId } = await fxRehearsalRun(db, ws, { jobId, status: "running" });
  const { caseId } = await fxRehearsalCase(db, ws, { jobId });
  const { scenarioId } = await fxRehearsalScenario(db, ws, { runId, caseId });
  const { executionId } = await fxSimExecution(db, ws, { rehearsalRunId: runId, variant: opts.shadow ? "shadow" : "governed" });
  return { runId, scenarioId, simExecutionId: executionId, shadow: opts.shadow === true };
}

/** トークンを付ける（app の /internal/tasks/:id/run が runTask の前にすること） */
export async function tokenFor(db: Db, ws: FxWorkspace, taskId: Uuid, now: Date = T0): Promise<string> {
  return db.transaction((tx) => issueTaskToken(tx, ws.ctx as WsCtx, taskId, now));
}

/** 有効な合格証（本番のルールの auto に要る：BR-81）。tool_hashes はその仕事に付与した全ツール（M-49） */
export async function seedCertificate(
  db: Db,
  ws: FxWorkspace,
  jobId: Uuid,
  toolHashes: Array<{ action: string; toolHash: string }>,
  modelId: string,
): Promise<Uuid> {
  const { runId } = await fxRehearsalRun(db, ws, { jobId, status: "done" });
  return db.transaction(async (tx) => {
    const audit = await appendAuditLog(
      tx,
      ws.workspaceId,
      { eventType: "rehearsal.certificate_issued", actorType: "system", actorId: "app", payload: { jobId } },
      T0,
    );
    const r = await tx.query<{ id: Uuid }>(
      `INSERT INTO rehearsal_certificates (workspace_id, job_id, rehearsal_run_id, policy_hash, tool_hashes, model_id, case_set_hash, case_count,
                                           summary, cost_usd, certificate_hash, audit_seq, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 12, '{}', 0.3, $8, $9, $10) RETURNING id`,
      [ws.workspaceId, jobId, runId, hashCanonical({ p: 1 }), toolHashes, modelId, hashCanonical({ c: 1 }), hashCanonical({ cert: jobId }), audit.seq, T0],
    );
    return r.rows[0]!.id;
  });
}

export { fxWorkspace };
