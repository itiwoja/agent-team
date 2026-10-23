// task-edge の試験の世界（packages/edge/src/__fixtures__/seed.ts・env.ts の WorkspaceDO 版）：
// 例の MCP コネクタ（在庫・仕入れ先・メール・銀行）とツール、受信箱係・仕入れ係、順番の依頼を DO の SQLite に入れる。
// 実効ポリシーは kernel の composeAll（本番の作り方と同じ）、tool_hash は toolHashOf。
// LLM は Workflow の側（workflows/task-run.ts の llmTurn）と同じ順で、Prepare → Begin → ScriptedLlmClient → Settle／Fail を呼ぶ（llmMessages）

import {
  DEFAULT_CEILINGS,
  composeAll,
  defaultWorkspacePolicy,
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
import { LlmError, type ScriptedResponder, type ScriptedStep } from "@open-team/llm";
import { DEFAULT_CLAUDE_MODEL as DEFAULT_AGENT_MODEL } from "../../src/llm/claude.ts";
import { ClaudeScriptedLlm as ScriptedLlmClient } from "../llm/scripted.ts";
import { EdgeError, type AssistantPart, type LlmMessagesRequest, type LlmMessagesResponse } from "@open-team/runner";
import { expect } from "vitest";
import { newId, one, type WsDb } from "../../src/db/sqlite.ts";
import type { Uuid } from "../../src/db/types.ts";
import { estimateCallMicroUsd } from "../../src/edge/llm-call.ts";
import type { EdgeLimits } from "../../src/edge/limits.ts";
import { createTaskEdgeRuntime, edgeLlmBegin, edgeLlmFail, edgeLlmPrepare, edgeLlmSettle, type TaskEdgeRuntime } from "../../src/edge/task-edge.ts";
import type { FxWorkspace } from "../db/fixtures.ts";

export const T0 = new Date("2026-10-12T09:00:00.000Z"); // 18:00 JST

interface FxToolDef {
  name: string;
  classification: ToolClassification;
  argRoles: ArgRoleMap;
  description: string;
  inputSchema: JsonObject;
}

const FX_CONNECTORS: ReadonlyArray<{ slug: string; displayName: string; tools: FxToolDef[] }> = [
  {
    slug: "store",
    displayName: "店舗の在庫",
    tools: [
      { name: "get_inventory", classification: "read", argRoles: {}, description: "店舗の今の在庫を返します。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
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
        description: "仕入れ先の商品と単価の一覧を返します。",
        inputSchema: { type: "object", properties: { supplier_id: { type: "string", maxLength: 64 } }, additionalProperties: false },
      },
      {
        name: "place_order",
        classification: "write",
        argRoles: { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" },
        description: "仕入れ先に発注します。",
        inputSchema: {
          type: "object",
          properties: {
            supplier_id: { type: "string", minLength: 1, maxLength: 64 },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: { sku: { type: "string", minLength: 1 }, quantity: { type: "integer", minimum: 1 }, unit_price: { type: "integer", minimum: 0 } },
                required: ["sku", "quantity", "unit_price"],
                additionalProperties: false,
              },
            },
            note: { type: "string", maxLength: 500 },
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
        description: "店舗の受信箱のメールを返します。",
        inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false },
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
        description: "振込先の口座を登録します。",
        inputSchema: {
          type: "object",
          properties: { account: { type: "string", minLength: 1 }, supplier_id: { type: "string", minLength: 1 } },
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

function insertId(db: WsDb, query: string, ...params: Parameters<typeof one>[3][]): Uuid {
  const r = one<{ id: Uuid }>(db, {}, query, ...params);
  if (r === null) throw new Error(`行を作れなかった：${query.slice(0, 60)}`);
  return r.id;
}

/** コネクタとツール（manifest の分類・役割で確定した状態） */
export function seedConnectors(db: WsDb, opts: { disabled?: string[] } = {}): Record<string, SeededConnector> {
  const out: Record<string, SeededConnector> = {};
  for (const c of FX_CONNECTORS) {
    const id = insertId(
      db,
      "INSERT INTO connectors (id, slug, display_name, kind, url, auth, enabled) VALUES (?, ?, ?, 'mcp_remote', ?, ?, ?) RETURNING id",
      newId(),
      c.slug,
      c.displayName,
      `https://mcp.test/mcp/${c.slug}`,
      { type: "none" },
      !(opts.disabled ?? []).includes(c.slug),
    );
    const tools: SeededConnector["tools"] = {};
    for (const t of c.tools) {
      const toolHash = toolHashOf({ description: t.description, inputSchema: t.inputSchema, argRoles: t.argRoles });
      const tid = insertId(
        db,
        `INSERT INTO connector_tools (id, connector_id, name, description, input_schema, classification, status, arg_roles, tool_hash, classified_by, classified_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, 'system:seed', ?) RETURNING id`,
        newId(),
        id,
        t.name,
        t.description,
        t.inputSchema,
        t.classification,
        t.argRoles,
        toolHash,
        T0,
      );
      tools[t.name] = { id: tid, toolHash };
    }
    out[c.slug] = { id, slug: c.slug, tools };
  }
  return out;
}

const BASE = { autonomy: {}, rules: [], budget: { per_task_usd: 0.2, per_day_usd: 1 }, max_runs_per_day: 10, profile: [] };

/** 受信箱係（researcher。mail.list_inbox だけ） */
export function inboxDefinition(): AgentDefinitionInput {
  return {
    version: 2,
    name: "受信箱係",
    role: "research",
    grants: { connectors: { mail: { grant: ["list_inbox"] } } },
    ...BASE,
    jobs: [{ id: "read-supplier-mail", kind: "recurring", template: "researcher", instructions: "仕入れ先から届いた新しいメールを読んでまとめてください。", trigger: null, deliver: [], guards: [] }],
  } as AgentDefinitionInput;
}

/** 仕入れ係（assistant。store・supplier・bank.register_payee） */
export function supplierDefinition(extra: Partial<AgentDefinitionInput> = {}, jobExtra: Record<string, unknown> = {}): AgentDefinitionInput {
  return {
    version: 2,
    name: "仕入れ係",
    role: "assist",
    grants: { connectors: { store: { grant: ["get_inventory"] }, supplier: { grant: ["list_products", "place_order"] }, bank: { grant: ["register_payee"] } } },
    ...BASE,
    jobs: [
      { id: "reorder", kind: "recurring", template: "assistant", instructions: "在庫を確認して、足りなければ発注してください。", trigger: null, deliver: [], guards: [], ...jobExtra },
    ],
    ...extra,
  } as AgentDefinitionInput;
}

export interface SeededAgent {
  agentId: Uuid;
  snapshotId: Uuid;
  name: string;
  jobs: Record<string, { jobId: Uuid; policy: EffectivePolicy; policyHash: Hex64 }>;
}

/** エージェント・スナップショット（effective_policies は composeAll）・仕事 */
export function seedAgent(db: WsDb, def: AgentDefinitionInput): SeededAgent {
  const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy: defaultWorkspacePolicy(FX_CONNECTORS.map((c) => c.slug)), agent: def });
  if (composed.violations.length > 0) throw new Error(`定義がポリシーを超えている：${composed.violations.map((v) => v.path).join("・")}`);
  const effective = Object.fromEntries(Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash }]));
  return db.transaction(() => {
    const agentId = insertId(db, "INSERT INTO agents (id, slug, name, status) VALUES (?, ?, ?, 'active') RETURNING id", newId(), `a-${sha256Hex(def.name + newId()).slice(0, 8)}`, def.name);
    const snapshotId = insertId(
      db,
      "INSERT INTO agent_snapshots (id, agent_id, status, definition, effective_policies, ceilings_version) VALUES (?, ?, 'valid', ?, ?, ?) RETURNING id",
      newId(),
      agentId,
      def as unknown as JsonObject,
      effective as unknown as JsonObject,
      DEFAULT_CEILINGS.version,
    );
    one(db, {}, "UPDATE agents SET current_snapshot_id = ? WHERE id = ? RETURNING id", snapshotId, agentId);
    const jobs: SeededAgent["jobs"] = {};
    for (const j of def.jobs ?? []) {
      const jobId = insertId(db, "INSERT INTO agent_jobs (id, agent_id, slug, kind, template) VALUES (?, ?, ?, ?, ?) RETURNING id", newId(), agentId, j.id, j.kind, j.template);
      const c = composed.jobs[j.id]!;
      jobs[j.id] = { jobId, policy: c.effective, policyHash: c.effectivePolicyHash };
    }
    return { agentId, snapshotId, name: def.name, jobs };
  });
}

export interface SeededAsk {
  askId: Uuid;
  askRunId: Uuid;
  members: Record<string, Uuid>;
}

/** 順番の依頼（members の順。nextRunAt を渡すと定期の依頼） */
export function seedChainAsk(
  db: WsDb,
  ws: FxWorkspace,
  members: Array<{ agent: SeededAgent; jobSlug: string; position: number; spokesperson: boolean }>,
  opts: { nextRunAt?: Date | null } = {},
): SeededAsk {
  const nextRunAt = opts.nextRunAt ?? null;
  const askId = insertId(
    db,
    `INSERT INTO asks (id, created_by, text, shape, status, "trigger", next_run_at) VALUES (?, ?, ?, 'chain', 'running', ?, ?) RETURNING id`,
    newId(),
    ws.userId,
    "仕入れ先のメールを読んで、在庫を見て、必要なら発注して",
    nextRunAt === null ? null : { type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" },
    nextRunAt,
  );
  const askRunId = insertId(db, "INSERT INTO ask_runs (id, ask_id, run_no, trigger_type, started_at) VALUES (?, ?, 1, 'initial', ?) RETURNING id", newId(), askId, T0);
  const out: Record<string, Uuid> = {};
  for (const m of members) {
    out[m.agent.name] = insertId(
      db,
      `INSERT INTO ask_members (id, ask_id, agent_id, job_id, position, depends_on, is_spokesperson, is_new, summary) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) RETURNING id`,
      newId(),
      askId,
      m.agent.agentId,
      m.agent.jobs[m.jobSlug]!.jobId,
      m.position,
      m.position > 1 ? [m.position - 1] : [],
      m.spokesperson,
      `${m.agent.name}の段`,
    );
  }
  return { askId, askRunId, members: out };
}

export interface SeedTaskOptions {
  status?: "queued" | "provisioning" | "running";
  ask?: SeededAsk;
  memberName?: string;
  inputTaskIds?: Uuid[];
  prompt?: string | null;
  taint?: TaintState;
  costMicroUsd?: number;
  stepsUsed?: number;
  startedAt?: Date;
  dryRun?: boolean;
}

/** タスク（既定は本番の queued） */
export function seedTask(db: WsDb, ws: FxWorkspace, agent: SeededAgent, jobSlug: string, o: SeedTaskOptions = {}): Uuid {
  const status = o.status ?? "queued";
  const dryRun = o.dryRun === true;
  const taint = o.taint ?? { tainted: false, sources: [] };
  return insertId(
    db,
    `INSERT INTO tasks (id, requester_id, agent_id, agent_snapshot_id, job_id, ask_id, ask_run_id, ask_member_id, input_task_ids, trigger_type, is_dry_run,
                        prompt, tainted, taint_sources, status, cost_micro_usd, steps_used, started_at, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    newId(),
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
    o.prompt === undefined ? "仕入れ先のメールを読んで、在庫を見て、必要なら発注して" : o.prompt,
    taint.tainted,
    [...taint.sources],
    status,
    o.costMicroUsd ?? 0,
    o.stepsUsed ?? 0,
    status === "running" ? (o.startedAt ?? T0) : null,
    T0,
    T0,
    T0,
  );
}

// ---- LLM の応答の部品 ----

export const text = (t: string): AssistantPart => ({ type: "text", text: t });
export const call = (id: string, name: string, args: unknown = {}): AssistantPart => ({ type: "tool_call", id, name, arguments: args });
export const mcp = (id: string, connector: string, tool: string, args: Record<string, unknown> = {}): AssistantPart =>
  call(id, "mcp_call", { connector, tool, arguments: args });
export const report = (id: string, extra: Record<string, unknown> = {}): AssistantPart =>
  call(id, "submit_report", { title: "発注の報告", body: "豆が残り2kgなので20kg発注します。", sources: [], ...extra });

/** runner が送るのと同じ形の要求（ツールは文脈のツールの名前） */
export function llmRequest(tools: ReadonlyArray<{ name: string }>, o: Partial<LlmMessagesRequest> = {}): LlmMessagesRequest {
  return {
    phase: "plan",
    system: "あなたは試験のエージェントです。",
    messages: [{ role: "user", content: "仕事を始めてください。" }],
    tools: tools.map((t) => ({ name: t.name as LlmMessagesRequest["tools"][number]["name"], description: "", inputSchema: {} })),
    maxTokens: 1000,
    ...o,
  };
}

/** 決まった量の使用量（Opus 5.5 の単価で 6,000 マイクロドル：入力 1,000 × $4/M ＋ 出力 100 × $20/M） */
export const USAGE = { inputTokens: 1000, outputTokens: 100, thinkingTokens: 0 } as const;

export interface TestEdge {
  rt: TaskEdgeRuntime;
  llm: ScriptedLlmClient;
  /** Workflow の llmTurn と同じ順で DO の4つを呼ぶ（やり直しはしない：やり直しは llm-call.ts の試験） */
  llmMessages(taskId: string, req: unknown, now?: Date): Promise<LlmMessagesResponse>;
}

export function buildEdge(
  db: WsDb,
  o: { script?: readonly ScriptedStep[] | ScriptedResponder; limits?: Partial<EdgeLimits>; knownSecrets?: string[]; models?: { agentModel: string; plannerModel: string } } = {},
): TestEdge {
  let seq = 0;
  const rt = createTaskEdgeRuntime({
    models: o.models ?? { agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_AGENT_MODEL },
    knownSecrets: o.knownSecrets ?? [],
    ...(o.limits ? { limits: o.limits } : {}),
    newId: () => `gen-${++seq}`,
  });
  const llm = new ScriptedLlmClient(o.script ?? []);
  return {
    rt,
    llm,
    async llmMessages(taskId, req, now = T0) {
      const { llmReq, phase } = edgeLlmPrepare(db, rt, taskId, req, now);
      const est = estimateCallMicroUsd(llmReq);
      edgeLlmBegin(db, rt, taskId, { budgetEstimateMicroUsd: est, model: llmReq.model, phase }, now);
      let response;
      try {
        response = await llm.generate(llmReq);
      } catch (e) {
        const err = e instanceof LlmError ? e : new LlmError(String(e), null, false);
        return edgeLlmFail(db, rt, taskId, { llmReq, phase, kind: "llm", llmStatus: err.status, message: err.message, usage: null, provider: "anthropic" }, now);
      }
      const usage = { ...response.usage, model: response.model, estimatedMicroUsd: est, latencyMs: 1, attempts: 1 };
      return edgeLlmSettle(db, rt, taskId, { llmReq, phase, usage, response, provider: "anthropic" }, now);
    },
  };
}

/** EdgeError（code）を投げることを確かめる */
export async function expectEdgeError(fn: () => unknown, code: string): Promise<EdgeError> {
  let caught: unknown = null;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `EdgeError(${code}) のはず`).toBeInstanceOf(EdgeError);
  expect((caught as EdgeError).code).toBe(code);
  return caught as EdgeError;
}

export const ORDER = { supplier_id: "supplier-01", items: [{ sku: "BEAN-01", quantity: 20, unit_price: 1800 }] };
