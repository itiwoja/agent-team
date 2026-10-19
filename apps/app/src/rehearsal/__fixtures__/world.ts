// リハーサルの実行（run.ts）の試験の世界：本物に近い形で組む（本番では読み込まれない）。
// - sim-world：同じプロセスで本物の HTTP（ポートは OS が選ぶ）。保存は Postgres（ot_sim のロール。tasks.sim_execution_id などの外部キーが本物のため）
// - gateway：createGateway を app.request につなぐ（sim-world への MCP は本物の HTTP）。sim-world を普通のコネクタとして登録する（EP-51）
// - DB：@open-team/db/testing の試験ごとのデータベース。エージェントは kernel の composeAll で作った実効ポリシーつき
// - LLM：ScriptedLlmClient（台本は呼び出し側）

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createGateway, type GatewayEnv } from "@open-team/gateway";
import { createApp as createSimApp, PostgresSimStore } from "@open-team/sim-world";
import { fxWorkspace, openRoleDb, type FxWorkspace } from "@open-team/db/testing";
import type { Db, Uuid } from "@open-team/db";
import { createGatewayClient, type GatewayClient } from "@open-team/gateway-client";
import {
  DEFAULT_CEILINGS,
  composeAll,
  defaultWorkspacePolicy,
  sha256Hex,
  toolHashOf,
  type AgentDefinitionInput,
  type EffectivePolicy,
  type Hex64,
  type JsonObject,
  type ToolHash,
} from "@open-team/kernel";
import { DEFAULT_AGENT_MODEL, ScriptedLlmClient, type ScriptedResponder } from "@open-team/llm";
import { createServiceAuth, manualClock, memoryLogger, type ManualClock } from "@open-team/platform";
import { createSimClient, type SimClient } from "@open-team/sim-client";
import { SHOP_CONNECTORS, ScenarioSchema, type Scenario } from "@open-team/sim-core";
import { insertRehearsalCase } from "@open-team/db/rehearsal";
import type { RehearsalCaseRow } from "@open-team/db";
import type { AssistantPart } from "@open-team/runner";
import { createRunningTaskRegistry } from "../../registry.ts";
import { testEnv } from "../../test-helpers.ts";
import type { RehearsalRunDeps } from "../run.ts";

export const SIM_TOKEN = "sim-world-shared-token-for-rehearsal-tests-0123";
export const GW_TOKEN = "gateway-internal-token-for-rehearsal-tests-0123";
export const T0 = new Date("2026-10-14T01:00:00.000Z");

export interface SentRequest {
  url: string;
  method: string;
  rpc: string | null;
}

export interface RehearsalWorld {
  db: Db;
  ws: FxWorkspace;
  agent: SeededAgent;
  simUrl: string;
  simClient: SimClient;
  gatewayClient: GatewayClient;
  /** gateway → コネクタの HTTP の記録（tools/call など） */
  sent: SentRequest[];
  clock: ManualClock;
  logs: ReturnType<typeof memoryLogger>;
  deps: (llm: ScriptedLlmClient, over?: Partial<RehearsalRunDeps>) => RehearsalRunDeps;
  close(): Promise<void>;
}

export interface SeededAgent {
  agentId: Uuid;
  snapshotId: Uuid;
  jobId: Uuid;
  policy: EffectivePolicy;
}

/** 仕入れ係（store・supplier の2ツール・bank.register_payee。D-70 の用意した依頼の2段目と同じ付与） */
export function supplierDefinition(over: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
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
      },
    ],
    ...over,
  };
}

export async function seedAgent(db: Db, ws: FxWorkspace, def: AgentDefinitionInput): Promise<SeededAgent> {
  const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy: defaultWorkspacePolicy(ws.kind), agent: def });
  if (composed.violations.length > 0) throw new Error(`定義がポリシーを超えている：${composed.violations.map((v) => v.path).join("・")}`);
  const effective = Object.fromEntries(Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash as Hex64 }]));
  return db.transaction(async (tx) => {
    const a = await tx.query<{ id: Uuid }>(
      "INSERT INTO agents (workspace_id, slug, name, status, created_at, updated_at) VALUES ($1, $2, $3, 'active', $4, $4) RETURNING id",
      [ws.workspaceId, `a-${sha256Hex(def.name + ws.workspaceId).slice(0, 8)}`, def.name, T0],
    );
    const agentId = a.rows[0]!.id;
    const s = await tx.query<{ id: Uuid }>(
      `INSERT INTO agent_snapshots (workspace_id, agent_id, status, definition, effective_policies, ceilings_version, created_at)
       VALUES ($1, $2, 'valid', $3, $4, $5, $6) RETURNING id`,
      [ws.workspaceId, agentId, def as unknown as JsonObject, effective, DEFAULT_CEILINGS.version, T0],
    );
    const snapshotId = s.rows[0]!.id;
    await tx.query("UPDATE agents SET current_snapshot_id = $2 WHERE id = $1", [agentId, snapshotId]);
    const job = def.jobs![0]!;
    const j = await tx.query<{ id: Uuid }>(
      "INSERT INTO agent_jobs (workspace_id, agent_id, slug, kind, template, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id",
      [ws.workspaceId, agentId, job.id, job.kind, job.template, T0],
    );
    return { agentId, snapshotId, jobId: j.rows[0]!.id, policy: composed.jobs[job.id]!.effective };
  });
}

/** sim-world を普通のコネクタとして登録する（EP-51 → manifest の分類・役割で確定し、tool_hash を計算し直す：gateway の試験と同じ） */
async function seedShop(db: Db, client: GatewayClient, ws: FxWorkspace, simUrl: string): Promise<void> {
  for (const c of SHOP_CONNECTORS) {
    const r = await db.query<{ id: string }>(
      "INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth) VALUES ($1, $2, $3, 'sim', $4, $5) RETURNING id",
      [ws.workspaceId, c.slug, c.displayName, `${simUrl}${c.path}`, { type: "none" }],
    );
    const connectorId = r.rows[0]!.id;
    await client.syncTools(connectorId);
    for (const t of c.tools) {
      const row = (
        await db.query<{ id: string; description: string; input_schema: unknown }>(
          "SELECT id, description, input_schema FROM connector_tools WHERE connector_id = $1 AND name = $2",
          [connectorId, t.name],
        )
      ).rows[0]!;
      const toolHash: ToolHash = toolHashOf({ description: row.description, inputSchema: row.input_schema as never, argRoles: t.argRoles });
      await db.query(
        `UPDATE connector_tools SET classification = $2, arg_roles = $3, scope = $4, verify = $5, tool_hash = $6,
                classified_by = 'system:seed', classified_at = $7 WHERE id = $1`,
        [row.id, t.classification, t.argRoles, t.scope, t.verify, toolHash, T0],
      );
    }
  }
}

export interface StartWorldOptions {
  /** 仕入れ係の定義（ルールの tool_hash に place_order の値が要るので、コネクタを入れたあとに作る） */
  agentDefinition?: (h: { placeOrderHash: ToolHash }) => AgentDefinitionInput;
  /** 実のコネクタを混ぜない（既定どおり）。gateway が許す接続先を足す試験用 */
  gatewayEnv?: Partial<GatewayEnv>;
  /** ワークスペースの種別（既定 owner。ゲストの1日5件の試験用。kind は後から変えられない） */
  workspaceKind?: "owner" | "guest";
}

/** 試験の世界を起こす。url は useTestDb の T().url（ot_sim のロールで開く） */
export async function startRehearsalWorld(db: Db, url: string, o: StartWorldOptions = {}): Promise<RehearsalWorld> {
  const clock = manualClock(T0);
  const logs = memoryLogger({ service: "app" });
  const ws = await fxWorkspace(db, { kind: o.workspaceKind ?? "owner", audit: true });

  // sim-world（本物の HTTP。保存は Postgres）
  const simDb = await openRoleDb(url, "ot_sim", { max: 3 });
  const simApp = createSimApp(
    { deploymentMode: "local", port: 0, sharedToken: SIM_TOKEN, selfUrl: undefined, gatewaySaEmail: undefined, appSaEmail: undefined, databaseUrl: undefined, commitSha: "test" },
    { store: new PostgresSimStore(simDb), now: () => clock.now() },
  );
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: simApp.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const simUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const simAuth = createServiceAuth({ mode: "local", sharedToken: SIM_TOKEN });
  const simClient = createSimClient({ baseUrl: simUrl, authHeaders: (aud) => simAuth.serviceAuthHeaders("sa-app", aud) });

  // gateway（app.request につなぐ。sim-world への MCP は本物の HTTP）
  const sent: SentRequest[] = [];
  const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let rpc: string | null = null;
    if (typeof init?.body === "string") {
      try {
        const b = JSON.parse(init.body) as { method?: unknown };
        rpc = typeof b.method === "string" ? b.method : null;
      } catch {
        // JSON でない本文は記録の対象外
      }
    }
    sent.push({ url: u, method: init?.method ?? "GET", rpc });
    return fetch(input, init);
  }) as typeof fetch;
  const gwEnv: GatewayEnv = {
    deploymentMode: "local",
    port: 0,
    databaseUrl: "postgres://unused",
    allowedConnectorUrls: [simUrl],
    simWorldUrl: simUrl,
    gcal: null,
    github: null,
    serviceAuth: { mode: "local", sharedToken: GW_TOKEN },
    simWorldSharedToken: SIM_TOKEN,
    commitSha: "test",
    ...o.gatewayEnv,
  };
  const gw = createGateway(gwEnv, { db, clock, log: memoryLogger({ service: "gateway" }).logger, fetch: recordingFetch, presendBackoffMs: [0, 0, 0], knownSecrets: [] });
  const gatewayClient = createGatewayClient({
    baseUrl: "http://gateway.test",
    authHeaders: async () => ({ authorization: `Bearer ${GW_TOKEN}`, "x-ot-caller": "sa-app" }),
    fetch: ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(gw.app.request(input as string, init))) as typeof fetch,
  });

  await seedShop(db, gatewayClient, ws, simUrl);
  const placeOrder = await db.query<{ tool_hash: ToolHash }>(
    "SELECT tool_hash FROM connector_tools WHERE workspace_id = $1 AND name = 'place_order'",
    [ws.workspaceId],
  );
  const agent = await seedAgent(db, ws, (o.agentDefinition ?? (() => supplierDefinition()))({ placeOrderHash: placeOrder.rows[0]!.tool_hash }));

  const env = testEnv({ gemini: { project: undefined, location: "global", agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_AGENT_MODEL, compareModels: [] } });
  return {
    db,
    ws,
    agent,
    simUrl,
    simClient,
    gatewayClient,
    sent,
    clock,
    logs,
    deps: (llm, over = {}) => ({
      db,
      log: logs.logger,
      clock,
      ids: { newId: () => randomUUID() },
      llm,
      gatewayClient,
      simClient,
      registry: createRunningTaskRegistry(),
      env,
      // LLM のやり直しは待たない（試験）
      edge: { retry: { sleep: async () => {} } },
      ...over,
    }),
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await simDb.close();
    },
  };
}

// ---- 状況・試験・台本 ----

type FaultInput = Scenario["faults"][number];
export function scenarioOf(title: string, faults: FaultInput[], over: { seed?: number; source?: "generated" | "user" } = {}): Scenario {
  return ScenarioSchema.parse({
    schemaVersion: 1,
    world: "shop",
    seed: over.seed ?? 11,
    title,
    faults,
    agentRuns: faults.some((f) => f.id === "F-01") ? 2 : 1,
    endAt: "day2_end",
    origin: { source: over.source ?? "generated" },
  });
}

/** 試験（rehearsal_cases）を1件足す */
export async function addCase(
  w: RehearsalWorld,
  scenario: Scenario,
  source: "generated" | "user" = "generated",
  subject: { jobId: Uuid } | { askId: Uuid } = { jobId: w.agent.jobId },
): Promise<RehearsalCaseRow> {
  return insertRehearsalCase(w.db, w.ws.ctx, {
    subject,
    source,
    faultIds: [...new Set(scenario.faults.map((f) => f.id))],
    scenario: JSON.parse(JSON.stringify(scenario)) as JsonObject,
    seed: scenario.seed,
    ...(source === "user" ? { userText: "試験のための悪い日" } : {}),
  });
}

export const text = (t: string): AssistantPart => ({ type: "text", text: t });
export const mcp = (id: string, connector: string, tool: string, args: Record<string, unknown> = {}): AssistantPart => ({
  type: "tool_call",
  id,
  name: "mcp_call",
  arguments: { connector, tool, arguments: args },
});
export const report = (id: string, body = "在庫を確認して発注しました。"): AssistantPart => ({
  type: "tool_call",
  id,
  name: "submit_report",
  arguments: { title: "発注の報告", body, sources: [] },
});
const USAGE = { inputTokens: 1000, outputTokens: 100, thinkingTokens: 0 } as const;

/**
 * 仕入れ係の台本：在庫を読む → 発注する → 報告。どの走行（本番の経路・承認した分岐・影）でも同じ手順を踏む
 * （台本は今までに返ってきたツールの結果の数で決める。順に使う列ではないので、走行が増えても尽きない）
 */
export function orderScript(order: Record<string, unknown> | null): ScriptedResponder {
  return (req) => {
    const results = req.messages.filter((m) => m.role === "tool").length;
    if (results === 0) return { parts: [mcp("c-inv", "store", "get_inventory")], usage: USAGE };
    if (results === 1 && order !== null) return { parts: [mcp("c-order", "supplier", "place_order", order)], usage: USAGE };
    return { parts: [report("c-report")], usage: USAGE };
  };
}

/** 豆を 200kg（通常の発注 20kg の3倍を超える）・単価は通常の780円 */
export const BIG_ORDER = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 200, unit_price: 780 }] } as const;
/** いつもの発注（20kg・780円） */
export const NORMAL_ORDER = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 780 }] } as const;

/** 仕入れ先 supplier-01 への発注を、数量・単価は自由で確認なしにするルール（r-0001）。guards は数量の上限など */
export function withOrderRule(h: { placeOrderHash: ToolHash }, o: { quantityMax?: number } = {}): AgentDefinitionInput {
  const base = supplierDefinition({
    rules: [
      {
        id: "r-0001",
        action: "mcp.supplier.place_order",
        match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE"] },
        free: ["items[].quantity", "items[].unit_price"],
        tool_hash: h.placeOrderHash,
        added_by: "owner",
        added_at: T0.toISOString(),
      },
    ],
  });
  if (o.quantityMax === undefined) return base;
  return { ...base, jobs: base.jobs!.map((j) => ({ ...j, guards: [{ action: "mcp.supplier.place_order", arg: "items[].quantity", max: o.quantityMax! }] })) } as AgentDefinitionInput;
}

/** 受信箱係（researcher。mail.list_inbox だけ：D-70 の用意した依頼の1段目） */
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

/** 順番の依頼（受信箱係 → 仕入れ係。2段目が窓口）。試験の対象は依頼（ask_id） */
export async function seedChainAsk(w: RehearsalWorld): Promise<{ askId: Uuid; inbox: SeededAgent }> {
  const inbox = await seedAgent(w.db, w.ws, inboxDefinition());
  const a = await w.db.query<{ id: Uuid }>(
    `INSERT INTO asks (workspace_id, created_by, text, shape, status, trigger, next_run_at, created_at, updated_at)
     VALUES ($1, $2, '仕入れ先のメールを読んで、在庫を見て、必要なら発注して', 'chain', 'running', NULL, NULL, $3, $3) RETURNING id`,
    [w.ws.workspaceId, w.ws.userId, T0],
  );
  const askId = a.rows[0]!.id;
  const members: Array<[SeededAgent, number, boolean]> = [
    [inbox, 1, false],
    [w.agent, 2, true],
  ];
  for (const [agent, position, spokesperson] of members) {
    await w.db.query(
      `INSERT INTO ask_members (workspace_id, ask_id, agent_id, job_id, position, depends_on, is_spokesperson, is_new, summary, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::smallint[], $7, false, $8, $9)`,
      [w.ws.workspaceId, askId, agent.agentId, agent.jobId, position, position > 1 ? [position - 1] : [], spokesperson, `${position}段目`, T0],
    );
  }
  return { askId, inbox };
}
