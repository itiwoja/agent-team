// 依頼の実行・API の試験の世界：本物に近い形で組む（本番では読み込まれない）。
// - 例の MCP コネクタ：同じプロセスの小さな MCP サーバー（本物の HTTP。ポートは OS が選ぶ）。在庫・仕入れ先・銀行・メールは一般的な MCP のコネクタとして扱う
// - gateway：createGateway を app.request につなぐ（MCP は本物の HTTP）。コネクタは EP-51 で同期し、manifest の分類・役割で確定する
// - DB：@open-team/db/testing の試験ごとのデータベース。ワークスペースのポリシーは例のコネクタを有効にしたもの。エージェントは kernel の composeAll で作った実効ポリシーつき
// - LLM：ScriptedLlmClient（台本は呼び出し側）

import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createGateway, type GatewayEnv } from "@open-team/gateway";
import { insertWorkspacePolicyIfMissing } from "@open-team/db/app";
import { fxWorkspace, type FxWorkspace } from "@open-team/db/testing";
import type { Db, Uuid } from "@open-team/db";
import { createGatewayClient, type GatewayClient } from "@open-team/gateway-client";
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
  type ToolHash,
  type WorkspacePolicy,
} from "@open-team/kernel";
import { DEFAULT_AGENT_MODEL, ScriptedLlmClient } from "@open-team/llm";
import { manualClock, memoryLogger, type ManualClock } from "@open-team/platform";
import { createRunningTaskRegistry } from "../registry.ts";
import { testEnv } from "../test-helpers.ts";
import type { AskRunDeps } from "../asks/run.ts";

export const GW_TOKEN = "gateway-internal-token-for-app-tests-0123456";
export const T0 = new Date("2026-10-14T01:00:00.000Z");

// ---- 例の MCP コネクタ ----

interface WorldTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  classification: "read" | "write";
  argRoles: ArgRoleMap;
  result: (args: Record<string, unknown>) => unknown;
}
interface WorldConnector {
  slug: string;
  displayName: string;
  tools: WorldTool[];
}

const OBJ = (properties: Record<string, unknown>, required: string[] = []): JsonObject =>
  ({ type: "object", properties, required, additionalProperties: false }) as JsonObject;

export const WORLD_CONNECTORS: readonly WorldConnector[] = [
  {
    slug: "store",
    displayName: "在庫",
    tools: [
      {
        name: "get_inventory",
        description: "在庫の一覧を返します。",
        inputSchema: OBJ({}),
        classification: "read",
        argRoles: {},
        result: () => ({ items: [{ sku: "BEAN-HOUSE", quantity: 2, unit: "kg" }] }),
      },
    ],
  },
  {
    slug: "supplier",
    displayName: "仕入れ先",
    tools: [
      {
        name: "list_products",
        description: "仕入れ先の商品と単価を返します。",
        inputSchema: OBJ({ supplier_id: { type: "string" } }),
        classification: "read",
        argRoles: {},
        result: () => ({ products: [{ sku: "BEAN-HOUSE", unit_price: 780 }] }),
      },
      {
        name: "place_order",
        description: "仕入れ先に発注します。",
        inputSchema: OBJ(
          {
            supplier_id: { type: "string" },
            items: {
              type: "array",
              items: OBJ({ sku: { type: "string" }, quantity: { type: "integer" }, unit_price: { type: "integer" } }, ["sku", "quantity", "unit_price"]),
            },
            note: { type: "string" },
          },
          ["supplier_id", "items"],
        ),
        classification: "write",
        argRoles: { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" },
        result: () => ({ order_id: `ord-${randomUUID().slice(0, 8)}`, status: "accepted" }),
      },
    ],
  },
  {
    slug: "bank",
    displayName: "銀行",
    tools: [
      {
        name: "register_payee",
        description: "振込先を登録します。",
        inputSchema: OBJ({ account: { type: "string" }, supplier_id: { type: "string" } }, ["account", "supplier_id"]),
        classification: "write",
        argRoles: { account: "destination" },
        result: () => ({ payee_id: `payee-${randomUUID().slice(0, 8)}` }),
      },
    ],
  },
  {
    slug: "mail",
    displayName: "メール",
    tools: [
      {
        name: "list_inbox",
        description: "受信箱を返します。",
        inputSchema: OBJ({}),
        classification: "read",
        argRoles: {},
        result: () => ({ messages: [] }),
      },
    ],
  },
];

/** 小さな MCP サーバー（initialize・tools/list・tools/call だけ。応答は application/json） */
async function startMcpServer(): Promise<{ url: string; close(): Promise<void> }> {
  const app = new Hono();
  app.post("/mcp/:slug", async (c) => {
    const spec = WORLD_CONNECTORS.find((x) => x.slug === c.req.param("slug"));
    if (!spec) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json()) as { id?: unknown; method?: string; params?: Record<string, unknown> };
    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id: body.id ?? null, result });
    if (typeof body.method === "string" && body.method.startsWith("notifications/")) return c.body(null, 202);
    switch (body.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof body.params?.protocolVersion === "string" ? body.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "test-mcp", version: "0.0.0" },
        });
      case "tools/list":
        return reply({ tools: spec.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": {
        const tool = spec.tools.find((t) => t.name === body.params?.name);
        if (!tool) return c.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message: "unknown tool" } });
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        return reply({ content: [{ type: "text", text: JSON.stringify(tool.result(args)) }] });
      }
      default:
        return c.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "method not found" } });
    }
  });
  app.all("*", (c) => c.body(null, 405));
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

// ---- 世界 ----

export interface SentRequest {
  url: string;
  method: string;
  rpc: string | null;
}

export interface TestWorld {
  db: Db;
  ws: FxWorkspace;
  agent: SeededAgent;
  gatewayClient: GatewayClient;
  /** gateway → コネクタの HTTP の記録（tools/call など） */
  sent: SentRequest[];
  clock: ManualClock;
  logs: ReturnType<typeof memoryLogger>;
  deps: (llm: ScriptedLlmClient, over?: Partial<AskRunDeps>) => AskRunDeps;
  close(): Promise<void>;
}

export interface SeededAgent {
  agentId: Uuid;
  snapshotId: Uuid;
  jobId: Uuid;
  policy: EffectivePolicy;
}

/** 仕入れ係（store・supplier の2ツール・bank.register_payee） */
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

/**
 * 定義から、実効ポリシーつきのエージェント・スナップショット・最初の仕事を入れる。
 * ワークスペースのポリシーは既定に例のコネクタを有効にしたもの（workspacePolicy で差し替える）
 */
export async function seedAgent(
  db: Db,
  ws: Pick<FxWorkspace, "workspaceId" | "kind">,
  def: AgentDefinitionInput,
  o: { workspacePolicy?: WorkspacePolicy; now?: Date } = {},
): Promise<SeededAgent> {
  const now = o.now ?? T0;
  const workspacePolicy = o.workspacePolicy ?? defaultWorkspacePolicy(WORLD_CONNECTORS.map((c) => c.slug));
  const composed = composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy, agent: def });
  if (composed.violations.length > 0) throw new Error(`定義がポリシーを超えている：${composed.violations.map((v) => v.path).join("・")}`);
  const effective = Object.fromEntries(Object.entries(composed.jobs).map(([slug, r]) => [slug, { policy: r.effective, hash: r.effectivePolicyHash as Hex64 }]));
  return db.transaction(async (tx) => {
    const a = await tx.query<{ id: Uuid }>(
      "INSERT INTO agents (workspace_id, slug, name, status, created_at, updated_at) VALUES ($1, $2, $3, 'active', $4, $4) RETURNING id",
      [ws.workspaceId, `a-${sha256Hex(def.name + ws.workspaceId).slice(0, 8)}`, def.name, now],
    );
    const agentId = a.rows[0]!.id;
    const s = await tx.query<{ id: Uuid }>(
      `INSERT INTO agent_snapshots (workspace_id, agent_id, status, definition, effective_policies, ceilings_version, created_at)
       VALUES ($1, $2, 'valid', $3, $4, $5, $6) RETURNING id`,
      [ws.workspaceId, agentId, def as unknown as JsonObject, effective, DEFAULT_CEILINGS.version, now],
    );
    const snapshotId = s.rows[0]!.id;
    await tx.query("UPDATE agents SET current_snapshot_id = $2 WHERE id = $1", [agentId, snapshotId]);
    const job = def.jobs![0]!;
    const j = await tx.query<{ id: Uuid }>(
      "INSERT INTO agent_jobs (workspace_id, agent_id, slug, kind, template, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id",
      [ws.workspaceId, agentId, job.id, job.kind, job.template, now],
    );
    return { agentId, snapshotId, jobId: j.rows[0]!.id, policy: composed.jobs[job.id]!.effective };
  });
}

/**
 * 例のコネクタの行を gateway を通さずに入れる（MCP サーバーなし。承認・チェックの試験用）。
 * manifest の分類・役割で確定した状態で、tool_hash = toolHashOf(説明・スキーマ・役割)。slug → { コネクタの ID, ツール名 → 行 }
 */
export async function insertWorldConnectorRows(
  db: Db,
  ws: Pick<FxWorkspace, "workspaceId">,
  slugs: readonly string[] = WORLD_CONNECTORS.map((c) => c.slug),
  now: Date = T0,
): Promise<Record<string, { id: Uuid; slug: string; displayName: string; tools: Record<string, { id: Uuid; toolHash: ToolHash }> }>> {
  const out: Record<string, { id: Uuid; slug: string; displayName: string; tools: Record<string, { id: Uuid; toolHash: ToolHash }> }> = {};
  for (const c of WORLD_CONNECTORS.filter((x) => slugs.includes(x.slug))) {
    const r = await db.query<{ id: Uuid }>(
      "INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth) VALUES ($1, $2, $3, 'mcp_remote', $4, $5) RETURNING id",
      [ws.workspaceId, c.slug, c.displayName, `https://mcp.test/mcp/${c.slug}`, { type: "none" }],
    );
    const tools: Record<string, { id: Uuid; toolHash: ToolHash }> = {};
    for (const t of c.tools) {
      const toolHash = toolHashOf({ description: t.description, inputSchema: t.inputSchema, argRoles: t.argRoles });
      const row = await db.query<{ id: Uuid }>(
        `INSERT INTO connector_tools (workspace_id, connector_id, name, description, input_schema, classification, status, arg_roles, verify, tool_hash,
                                      classified_by, classified_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'ok', $7, 'none', $8, 'system:seed', $9) RETURNING id`,
        [ws.workspaceId, r.rows[0]!.id, t.name, t.description, t.inputSchema, t.classification, t.argRoles, toolHash, now],
      );
      tools[t.name] = { id: row.rows[0]!.id, toolHash };
    }
    out[c.slug] = { id: r.rows[0]!.id, slug: c.slug, displayName: c.displayName, tools };
  }
  return out;
}

/** 例のコネクタを登録する（EP-51 → manifest の分類・役割で確定し、tool_hash を計算し直す：gateway の試験と同じ） */
async function seedConnectors(db: Db, client: GatewayClient, ws: FxWorkspace, serverUrl: string): Promise<void> {
  for (const c of WORLD_CONNECTORS) {
    const r = await db.query<{ id: string }>(
      "INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth) VALUES ($1, $2, $3, 'mcp_remote', $4, $5) RETURNING id",
      [ws.workspaceId, c.slug, c.displayName, `${serverUrl}/mcp/${c.slug}`, { type: "none" }],
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
        `UPDATE connector_tools SET classification = $2, arg_roles = $3, scope = NULL, verify = 'none', tool_hash = $4,
                classified_by = 'system:seed', classified_at = $5 WHERE id = $1`,
        [row.id, t.classification, t.argRoles, toolHash, T0],
      );
    }
  }
}

export interface StartWorldOptions {
  /** 仕入れ係の定義（ルールの tool_hash に place_order の値が要るので、コネクタを入れたあとに作る） */
  agentDefinition?: (h: { placeOrderHash: ToolHash }) => AgentDefinitionInput;
  /** gateway の環境を足す */
  gatewayEnv?: Partial<GatewayEnv>;
}

/** 試験の世界を起こす */
export async function startTestWorld(db: Db, o: StartWorldOptions = {}): Promise<TestWorld> {
  const clock = manualClock(T0);
  const logs = memoryLogger({ service: "app" });
  const ws = await fxWorkspace(db, { audit: true });
  const mcp = await startMcpServer();

  // gateway（app.request につなぐ。コネクタへの MCP は本物の HTTP）
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
    port: 0,
    databaseUrl: "postgres://unused",
    allowedConnectorUrls: [mcp.url],
    gcal: null,
    github: null,
    serviceAuth: { sharedToken: GW_TOKEN },
    commitSha: "test",
    ...o.gatewayEnv,
  };
  const gw = createGateway(gwEnv, { db, clock, log: memoryLogger({ service: "gateway" }).logger, fetch: recordingFetch, presendBackoffMs: [0, 0, 0], knownSecrets: [] });
  const gatewayClient = createGatewayClient({
    baseUrl: "http://gateway.test",
    authHeaders: async () => ({ authorization: `Bearer ${GW_TOKEN}`, "x-ot-caller": "sa-app" }),
    fetch: ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(gw.app.request(input as string, init))) as typeof fetch,
  });

  await seedConnectors(db, gatewayClient, ws, mcp.url);
  // ワークスペースのポリシー：既定に例のコネクタを有効にしたもの（つないだあとの状態）
  const workspacePolicy = defaultWorkspacePolicy(WORLD_CONNECTORS.map((c) => c.slug));
  await db.transaction((tx) =>
    insertWorkspacePolicyIfMissing(tx, ws.ctx, { policy: workspacePolicy as unknown as JsonObject, policyHash: hashCanonical(workspacePolicy), createdBy: null, now: T0 }),
  );
  const placeOrder = await db.query<{ tool_hash: ToolHash }>("SELECT tool_hash FROM connector_tools WHERE workspace_id = $1 AND name = 'place_order'", [
    ws.workspaceId,
  ]);
  const agent = await seedAgent(db, ws, (o.agentDefinition ?? (() => supplierDefinition()))({ placeOrderHash: placeOrder.rows[0]!.tool_hash }));

  const env = testEnv({ gemini: { apiKey: undefined, agentModel: DEFAULT_AGENT_MODEL, plannerModel: DEFAULT_AGENT_MODEL, compareModels: [] } });
  return {
    db,
    ws,
    agent,
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
      registry: createRunningTaskRegistry(),
      env,
      sleep: async () => {},
      // LLM のやり直しは待たない（試験）
      edge: { retry: { sleep: async () => {} } },
      ...over,
    }),
    close: () => mcp.close(),
  };
}
