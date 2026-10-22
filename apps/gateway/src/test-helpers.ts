// 試験用の道具（index からは出さない）。試験の中だけの小さな MCP サーバー（偽のコネクタ）を同じプロセスで本物の HTTP で起こし、
// gateway を app.request につなぎ、DB は @open-team/db/testing の試験ごとのデータベースを使う

import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { appendAuditLog, hashTaskToken, type Db } from "@open-team/db";
import { fxAgent, fxHash, fxTask, fxWorkspace, type FxAgent, type FxTaskOptions, type FxWorkspace } from "@open-team/db/testing";
import { createGatewayClient, type GatewayClient } from "@open-team/gateway-client";
import {
  computeMcpIntentHash,
  destinationKey,
  effectiveArgRoles,
  optionDigest,
  toolHashOf,
  type ArgRoleMap,
  type Json,
  type JsonObject,
  type ToolHash,
} from "@open-team/kernel";
import { manualClock, memoryLogger, type ManualClock } from "@open-team/platform";
import { createGateway, type GatewayApp } from "./app.ts";
import type { GatewayDeps } from "./context.ts";
import type { GatewayEnv } from "./env.ts";

export const GW_TOKEN = "gateway-internal-token-for-gateway-tests-0123";
export const APP_CALLER = { authorization: `Bearer ${GW_TOKEN}`, "x-ot-caller": "sa-app" } as const;
export const NOW = new Date("2026-10-12T09:00:00.000Z");

// ---- 偽の MCP サーバー（本物の HTTP。ポートは OS が選ぶ）----

/** 偽のコネクタのツール（manifest の分類・役割つき） */
export interface FakeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  classification: "read" | "write";
  argRoles: ArgRoleMap;
  /** tools/call の結果（text に入れる JSON） */
  result: (args: Record<string, unknown>) => unknown;
}
export interface FakeConnectorSpec {
  slug: string;
  displayName: string;
  /** サーバーの下のパス（コネクタの URL は <サーバーの URL><path>） */
  path: string;
  tools: FakeToolSpec[];
}

const OBJ = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: "object", properties, required, additionalProperties: false });

/** 試験の例のコネクタ（在庫・仕入れ・振込・メール）。どれも一般的な MCP のコネクタとして扱う */
export const FAKE_CONNECTORS: readonly FakeConnectorSpec[] = [
  {
    slug: "store",
    displayName: "在庫",
    path: "/mcp/store",
    tools: [
      {
        name: "get_inventory",
        description: "在庫の一覧を返します。",
        inputSchema: OBJ({}),
        classification: "read",
        argRoles: {},
        result: () => ({ items: [{ sku: "BEAN-HOUSE", quantity: 12 }] }),
      },
    ],
  },
  {
    slug: "supplier",
    displayName: "仕入れ先",
    path: "/mcp/supplier",
    tools: [
      {
        name: "list_products",
        description: "仕入れ先の商品を返します。",
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
          },
          ["supplier_id", "items"],
        ),
        classification: "write",
        argRoles: { supplier_id: "destination" } as ArgRoleMap,
        result: () => ({ order_id: `ord-${randomUUID().slice(0, 8)}`, status: "accepted" }),
      },
    ],
  },
  {
    slug: "bank",
    displayName: "銀行",
    path: "/mcp/bank",
    tools: [
      {
        name: "register_payee",
        description: "振込先を登録します。",
        inputSchema: OBJ({ account: { type: "string" }, supplier_id: { type: "string" } }, ["account", "supplier_id"]),
        classification: "write",
        argRoles: { account: "destination" } as ArgRoleMap,
        result: () => ({ payee_id: `payee-${randomUUID().slice(0, 8)}` }),
      },
    ],
  },
  {
    slug: "mail",
    displayName: "メール",
    path: "/mcp/mail",
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

/** サーバー側のツールの定義を試験の中で変える（説明の変化・ツールの増減：DR-01〜06） */
export interface ToolListOverrides {
  /** '<コネクタ>.<ツール>' → 新しい説明 */
  description: Map<string, string>;
  /** '<コネクタ>.<ツール>' → 新しい入力スキーマ */
  inputSchema: Map<string, Record<string, unknown>>;
  /** 一覧から消す '<コネクタ>.<ツール>' */
  removed: Set<string>;
  /** 一覧に足す（コネクタごと） */
  added: Map<string, Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>;
  reset(): void;
}

export function toolListOverrides(): ToolListOverrides {
  const o: ToolListOverrides = {
    description: new Map(),
    inputSchema: new Map(),
    removed: new Set(),
    added: new Map(),
    reset() {
      o.description.clear();
      o.inputSchema.clear();
      o.removed.clear();
      o.added.clear();
    },
  };
  return o;
}

/** 偽のサーバーが受けた tools/call */
export interface FakeCall {
  connector: string;
  tool: string;
  arguments: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface FakeMcpHandle {
  url: string;
  /** 受けた tools/call（受けた順） */
  calls: FakeCall[];
  close(): Promise<void>;
}

/** 引数が入力スキーマに合うか（必須のキーがある・知らないキーがない。それ以上は見ない） */
function argsFit(schema: Record<string, unknown>, args: Record<string, unknown>): boolean {
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  const required = (schema.required ?? []) as string[];
  if (required.some((k) => !(k in args))) return false;
  return Object.keys(args).every((k) => k in props);
}

/**
 * 偽の MCP サーバー（initialize・tools/list・tools/call だけ。応答は application/json）。
 * token を渡すと Authorization: Bearer <token> のない要求を 403 で断る（呼び出し元の証明）
 */
export async function startFakeMcp(o: ToolListOverrides = toolListOverrides(), opts: { token?: string } = {}): Promise<FakeMcpHandle> {
  const calls: FakeCall[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts.token !== undefined && c.req.header("authorization") !== `Bearer ${opts.token}`) return c.body(null, 403);
    await next();
  });
  app.get("*", (c) => c.body(null, 405));
  app.delete("*", (c) => c.body(null, 405));
  app.post("/mcp/:slug", async (c) => {
    const spec = FAKE_CONNECTORS.find((x) => x.slug === c.req.param("slug"));
    if (!spec) return c.json({ error: "not_found" }, 404);
    const body = (await c.req.json()) as { id?: unknown; method?: string; params?: Record<string, any> };
    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id: body.id ?? null, result });
    if (typeof body.method === "string" && body.method.startsWith("notifications/")) return c.body(null, 202);
    switch (body.method) {
      case "initialize":
        return reply({
          protocolVersion: typeof body.params?.protocolVersion === "string" ? body.params.protocolVersion : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "0.0.0" },
        });
      case "tools/list": {
        const tools = spec.tools
          .filter((t) => !o.removed.has(`${spec.slug}.${t.name}`))
          .map((t) => {
            const key = `${spec.slug}.${t.name}`;
            return { name: t.name, description: o.description.get(key) ?? t.description, inputSchema: o.inputSchema.get(key) ?? t.inputSchema };
          });
        return reply({ tools: [...tools, ...(o.added.get(spec.slug) ?? [])] });
      }
      case "tools/call": {
        const name = String(body.params?.name ?? "");
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = spec.tools.find((t) => t.name === name);
        if (!tool) return c.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32602, message: `unknown tool ${name}` } });
        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((v, k) => {
          headers[k] = v;
        });
        if (!argsFit(tool.inputSchema, args)) return reply({ content: [{ type: "text", text: "引数が入力スキーマに合いません" }], isError: true });
        calls.push({ connector: spec.slug, tool: name, arguments: args, headers });
        return reply({ content: [{ type: "text", text: JSON.stringify(tool.result(args)) }] });
      }
      default:
        return c.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "method not found" } });
    }
  });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const srv = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(srv));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

// ---- gateway ----

/** HTTP の記録（gateway → コネクタ） */
export interface SentRequest {
  url: string;
  method: string;
  rpc: string | null;
  headers: Record<string, string>;
  body: unknown;
}

/** 差し込みの fetch：要求を記録し、hook が Response か例外を返せばそれで置き換える（null なら本物へ流す） */
export type FetchHook = (req: SentRequest, real: () => Promise<Response>, init: RequestInit | undefined) => Promise<Response | null> | Response | null;

export function recordingFetch(sent: SentRequest[], hook?: FetchHook): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = null;
    let rpc: string | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
        rpc = typeof (body as { method?: unknown }).method === "string" ? (body as { method: string }).method : null;
      } catch {
        body = init.body;
      }
    }
    const req: SentRequest = { url, method: init?.method ?? "GET", rpc, headers, body };
    sent.push(req);
    const real = () => fetch(input, init);
    const replaced = hook ? await hook(req, real, init) : null;
    return replaced ?? real();
  }) as typeof fetch;
}

/** 本物の ECONNREFUSED（閉じたポートへ）を投げる */
export async function connectionRefused(): Promise<never> {
  const net = await import("node:net");
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  await fetch(`http://127.0.0.1:${port}/`);
  throw new Error("閉じたポートにつながった");
}

/** 応答を返さず、中断（close）されたら AbortError で終わる（タイムアウトの試験） */
export function hangUntilAborted(init: RequestInit | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(new DOMException("This operation was aborted", "AbortError"));
    signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
  });
}

/** JSON-RPC の応答（application/json）を作る */
export function rpcResponse(req: SentRequest, payload: { result?: unknown; error?: unknown }, status = 200): Response {
  const id = (req.body as { id?: unknown } | null)?.id ?? null;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), { status, headers: { "content-type": "application/json" } });
}

/** 送ったあとに切れた（ECONNRESET）ことにする例外 */
export function connectionReset(): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
}

export function gatewayEnv(connectorUrl: string | null = null, over: Partial<GatewayEnv> = {}): GatewayEnv {
  return {
    port: 0,
    databaseUrl: "postgres://unused",
    allowedConnectorUrls: connectorUrl ? [connectorUrl] : [],
    serviceAuth: { sharedToken: GW_TOKEN },
    gcal: null,
    github: null,
    commitSha: "test",
    ...over,
  };
}

export interface GatewayHarness extends GatewayApp {
  client: GatewayClient;
  sent: SentRequest[];
  clock: ManualClock;
  logs: ReturnType<typeof memoryLogger>;
  /** gateway に直接 HTTP を投げる */
  request(path: string, init?: RequestInit): Promise<Response>;
}

export function startGateway(
  db: Db,
  env: GatewayEnv,
  opts: { hook?: FetchHook; deps?: Partial<GatewayDeps> } = {},
): GatewayHarness {
  const sent: SentRequest[] = [];
  const clock = manualClock(NOW);
  const logs = memoryLogger({ service: "gateway" });
  const gw = createGateway(env, {
    db,
    clock,
    log: logs.logger,
    fetch: recordingFetch(sent, opts.hook),
    presendBackoffMs: [0, 0, 0],
    knownSecrets: [],
    ...opts.deps,
  });
  const app: Hono<any> = gw.app;
  const client = createGatewayClient({
    baseUrl: "http://gateway.test",
    authHeaders: async () => ({ ...APP_CALLER }),
    fetch: ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(app.request(input as string, init))) as typeof fetch,
  });
  return {
    ...gw,
    client,
    sent,
    clock,
    logs,
    request: (path, init) => Promise.resolve(app.request(`http://gateway.test${path}`, init)),
  };
}

// ---- DB の行 ----

export interface SeededTool {
  id: string;
  name: string;
  toolHash: ToolHash;
  inputSchema: Json;
  description: string;
  argRoles: ArgRoleMap;
}
export interface SeededConnector {
  id: string;
  slug: string;
  url: string;
  tools: Record<string, SeededTool>;
}
export type SeededConnectors = Record<string, SeededConnector>;

/**
 * 偽の MCP サーバーのコネクタを登録する（MT §3.14 の5〜7）：コネクタの行 → EP-51（tools/list）→ manifest の分類・役割で確定し
 * tool_hash を計算し直す（app がつなぐときにやる処理を試験の中で行う）
 */
export async function seedConnectors(db: Db, client: GatewayClient, ws: FxWorkspace, serverUrl: string, opts: { slugs?: string[] } = {}): Promise<SeededConnectors> {
  const out: SeededConnectors = {};
  for (const c of FAKE_CONNECTORS) {
    if (opts.slugs && !opts.slugs.includes(c.slug)) continue;
    const url = `${serverUrl}${c.path}`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth) VALUES ($1, $2, $3, 'mcp_remote', $4, $5) RETURNING id`,
      [ws.workspaceId, c.slug, c.displayName, url, { type: "none" }],
    );
    const connectorId = r.rows[0]!.id;
    await client.syncTools(connectorId);
    const tools: Record<string, SeededTool> = {};
    for (const t of c.tools) {
      const row = (
        await db.query<{ id: string; description: string; input_schema: Json }>(
          "SELECT id, description, input_schema FROM connector_tools WHERE connector_id = $1 AND name = $2",
          [connectorId, t.name],
        )
      ).rows[0]!;
      const toolHash = toolHashOf({ description: row.description, inputSchema: row.input_schema, argRoles: t.argRoles });
      await db.query(
        `UPDATE connector_tools SET classification = $2, arg_roles = $3, scope = $4, verify = $5, tool_hash = $6,
                classified_by = 'system:seed', classified_at = $7 WHERE id = $1`,
        [row.id, t.classification, t.argRoles, null, "none", toolHash, NOW],
      );
      tools[t.name] = { id: row.id, name: t.name, toolHash, inputSchema: row.input_schema, description: row.description, argRoles: t.argRoles };
    }
    out[c.slug] = { id: connectorId, slug: c.slug, url, tools };
  }
  return out;
}

export interface TaskWithToken {
  agent: FxAgent;
  taskId: string;
  token: string;
}

/** タスクとそのトークン（期限は NOW + 1時間） */
export async function taskWithToken(db: Db, ws: FxWorkspace, o: FxTaskOptions & { agent?: FxAgent } = {}): Promise<TaskWithToken> {
  const agent = o.agent ?? (await fxAgent(db, ws));
  const { taskId } = await fxTask(db, ws, agent, o);
  const token = randomBytes(32).toString("base64url");
  await db.query("UPDATE tasks SET task_token_hash = $2, task_token_expires_at = $3 WHERE id = $1", [
    taskId,
    hashTaskToken(token),
    new Date(NOW.getTime() + 3600_000),
  ]);
  return { agent, taskId, token };
}

export interface IntentInput {
  taskId: string;
  jobId: string;
  connector: Pick<SeededConnector, "id" | "slug">;
  tool: Pick<SeededTool, "name" | "toolHash" | "inputSchema" | "argRoles">;
  args: JsonObject;
  status?: "approved" | "pending_approval" | "executing" | "denied" | "executed" | "rejected";
  decision?: "allow" | "approve" | "deny";
  reasonCode?: string;
  /** 既定は approve・deny が autonomy.mcp_write、allow が rules.items[0] */
  matchedRule?: string | null;
  policyHash?: string;
  enforced?: boolean;
  /**
   * 承認の出どころ（SG-03）の証拠も入れるか（既定 true）。本番のタスクだけ：Kernel の判定の行（edge が残すもの）と、
   * approve で approved 以降の状態なら人の承認（approved の承認の行と approval.decided）
   */
  provenance?: boolean;
}

/** 正しい intentHash・destinationKey・optionDigest の Intent（kernel の関数で計算する） */
export async function insertIntent(db: Db, ws: FxWorkspace, i: IntentInput): Promise<{ intentId: string; intentHash: string }> {
  const action = `mcp.${i.connector.slug}.${i.tool.name}`;
  const eff = effectiveArgRoles(i.tool.inputSchema, i.tool.argRoles);
  const policyHash = i.policyHash ?? fxHash("policy");
  const intentHash = computeMcpIntentHash({
    connectorId: i.connector.id,
    tool: i.tool.name,
    arguments: i.args,
    toolHash: i.tool.toolHash,
    effectivePolicyHash: policyHash,
  });
  const status = i.status ?? "approved";
  const decision = i.decision ?? "approve";
  const reasonCode = i.reasonCode ?? (decision === "allow" ? "rule_matched" : "approval_required");
  const matchedRule = i.matchedRule !== undefined ? i.matchedRule : decision === "allow" ? "rules.items[0]" : "autonomy.mcp_write";
  const enforced = i.enforced ?? true;
  const credential = await db.query<{ id: string }>(
    "SELECT id FROM connector_credentials WHERE workspace_id = $1 AND connector_id = $2 AND revoked_at IS NULL",
    [ws.workspaceId, i.connector.id],
  );
  const r = await db.query<{ id: string }>(
    `INSERT INTO action_intents (workspace_id, task_id, job_id, connector_id, connector_credential_id, action, origin, payload, tool_hash, destination_key, option_digest,
                                 status, decision, reason_code, matched_rule, enforced, policy_hash, intent_hash, expires_at,
                                 executed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'agent', $7, $8, $9, $10, $11, $12, $13, $20, $14, $15, $16, $17, $18, $19, $19)
     RETURNING id`,
    [
      ws.workspaceId,
      i.taskId,
      i.jobId,
      i.connector.id,
      credential.rows[0]?.id ?? null,
      action,
      { connectorId: i.connector.id, tool: i.tool.name, arguments: i.args, toolHash: i.tool.toolHash },
      i.tool.toolHash,
      destinationKey(action, i.args, eff),
      optionDigest(action, i.args, eff),
      status,
      decision,
      reasonCode,
      enforced,
      policyHash,
      intentHash,
      status === "pending_approval" ? new Date(NOW.getTime() + 24 * 3600_000) : null,
      status === "executed" ? NOW : null,
      NOW,
      matchedRule,
    ],
  );
  const intentId = r.rows[0]!.id;
  if (i.provenance !== false) {
    {
      const decided = decision === "approve" && ["approved", "executing", "executed"].includes(status);
      const k = await insertKernelEvidence(db, ws, {
        taskId: i.taskId,
        intentId,
        intentHash,
        policyHash,
        action,
        args: i.args,
        decision,
        reasonCode,
        matchedRule,
        enforced,
        approval: decided,
      });
      if (decided) await decideApproval(db, ws, { taskId: i.taskId, intentId, intentHash, approvalId: k.approvalId! });
    }
  }
  return { intentId, intentHash };
}

export interface KernelEvidenceInput {
  taskId: string;
  intentId: string;
  /** intent.proposed に残す intentHash・policyHash（edge の recordMcpIntent） */
  intentHash: string;
  policyHash: string;
  action: string;
  args: JsonObject;
  decision: "allow" | "approve" | "deny";
  reasonCode: string;
  matchedRule: string | null;
  enforced?: boolean;
  /** 承認待ちの承認の行と approval.requested も作るか（edge は本番の approve で作る）。期限は既定 NOW + 24時間 */
  approval?: boolean | { expiresAt: Date };
  /** 監査ログ（intent.proposed・approval.requested・decision.made）を書くか（既定 true） */
  audit?: boolean;
}

/**
 * edge の LLM Proxy が1つのトランザクションで残す判定の記録（recordMcpIntent → recordDecision と同じ順と形）：
 * intent.proposed →（承認の行と approval.requested）→ policy_decisions（subject.call.intentId に Intent の ID）→ decision.made。
 */
export async function insertKernelEvidence(db: Db, ws: FxWorkspace, k: KernelEvidenceInput): Promise<{ decisionId: string; approvalId: string | null }> {
  const enforced = k.enforced ?? true;
  const inputsHash = fxHash(`inputs:${randomUUID()}`);
  const audit = k.audit !== false;
  return db.transaction(async (tx) => {
    if (audit) {
      await appendAuditLog(
        tx,
        ws.workspaceId,
        {
          eventType: "intent.proposed",
          actorType: "agent",
          actorId: null,
          taskId: k.taskId,
          payload: {
            taskId: k.taskId,
            intentId: k.intentId,
            action: k.action,
            origin: "agent",
            status: "approved",
            decision: k.decision,
            reasonCode: k.reasonCode,
            matchedRule: k.matchedRule,
            intentHash: k.intentHash,
            destinationKey: fxHash("dest"),
            optionDigest: fxHash("option"),
            policyHash: k.policyHash,
            enforced,
            tainted: false,
          },
        },
        NOW,
      );
    }
    let approvalId: string | null = null;
    if (k.approval) {
      const expiresAt = typeof k.approval === "object" ? k.approval.expiresAt : new Date(NOW.getTime() + 24 * 3600_000);
      const r = await tx.query<{ id: string }>(
        `INSERT INTO approvals (workspace_id, task_id, intent_id, status, risk_level, risk_score, approver_ids, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', 'medium', 3, $4, $5, $6, $6) RETURNING id`,
        [ws.workspaceId, k.taskId, k.intentId, [ws.userId], expiresAt, new Date(NOW.getTime() - 120_000)],
      );
      approvalId = r.rows[0]!.id;
      if (audit) {
        await appendAuditLog(
          tx,
          ws.workspaceId,
          {
            eventType: "approval.requested",
            actorType: "system",
            actorId: "edge",
            taskId: k.taskId,
            payload: { taskId: k.taskId, intentId: k.intentId, approvalId, expiresAt: expiresAt.toISOString(), expiryCause: "ttl" },
          },
          NOW,
        );
      }
    }
    const subject = {
      kind: "tool_call",
      actionType: "mcp_call",
      action: k.action,
      args: k.args,
      paths: [],
      origin: "agent",
      call: { toolCallId: `c-${randomUUID()}`, name: "mcp_call", effective: k.decision, intentId: k.intentId },
    };
    const d = await tx.query<{ id: string }>(
      `INSERT INTO policy_decisions (workspace_id, task_id, intent_id, subject_kind, action_type, subject, counters, flags, decision, reason_code,
                                     matched_rule, enforced, inputs_hash, kernel_version, created_at)
       VALUES ($1, $2, $3, 'tool_call', 'mcp_write', $4, '{}', $5, $6, $7, $8, $9, $10, '0.1.0', $11) RETURNING id`,
      [
        ws.workspaceId,
        k.taskId,
        k.intentId,
        subject,
        { killSwitchEngaged: false, taskStatus: "running" },
        k.decision,
        k.reasonCode,
        k.matchedRule,
        enforced,
        inputsHash,
        NOW,
      ],
    );
    if (audit) {
      await appendAuditLog(
        tx,
        ws.workspaceId,
        {
          eventType: "decision.made",
          actorType: "agent",
          actorId: null,
          taskId: k.taskId,
          payload: {
            taskId: k.taskId,
            subjectKind: "tool_call",
            action: k.action,
            operation: "mcp_write",
            decision: k.decision,
            reasonCode: k.reasonCode,
            matchedRule: k.matchedRule,
            inputsHash,
            enforced,
            intentId: k.intentId,
          },
        },
        NOW,
      );
    }
    return { decisionId: d.rows[0]!.id, approvalId };
  });
}

export interface DecideApprovalInput {
  taskId: string;
  intentId: string;
  approvalId: string;
  /** approval.decided に残す、人が承認した intentHash */
  intentHash: string;
  status?: "approved" | "rejected";
  /** 既定は ws.userId */
  decidedBy?: string;
  /** 既定 NOW */
  decidedAt?: Date;
  /** approval.decided の監査ログを書くか（既定 true） */
  audit?: boolean;
}

/** 人が承認待ちの承認を決める（app の API-019 の decideApprovalRow と、同じトランザクションの approval.decided） */
export async function decideApproval(db: Db, ws: FxWorkspace, a: DecideApprovalInput): Promise<void> {
  const decidedBy = a.decidedBy ?? ws.userId;
  const decidedAt = a.decidedAt ?? NOW;
  const status = a.status ?? "approved";
  await db.transaction(async (tx) => {
    await tx.query("UPDATE approvals SET status = $2, decided_by = $3, decided_at = $4, updated_at = $4 WHERE id = $1", [a.approvalId, status, decidedBy, decidedAt]);
    if (a.audit !== false) {
      await appendAuditLog(
        tx,
        ws.workspaceId,
        {
          eventType: "approval.decided",
          actorType: "user",
          actorId: decidedBy,
          taskId: a.taskId,
          payload: {
            approvalId: a.approvalId,
            intentId: a.intentId,
            taskId: a.taskId,
            decision: status === "approved" ? "approve" : "reject",
            intentHash: a.intentHash,
            remember: false,
            ruleId: null,
            hasComment: false,
          },
        },
        decidedAt,
      );
    }
  });
}

/** 承認の行（承認待ちの Intent に） */
export async function insertApproval(db: Db, ws: FxWorkspace, taskId: string, intentId: string, status: "pending" | "approved" = "pending"): Promise<string> {
  const decided = status === "approved";
  const r = await db.query<{ id: string }>(
    `INSERT INTO approvals (workspace_id, task_id, intent_id, status, risk_level, risk_score, approver_ids, decided_by, decided_at, expires_at,
                            created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'medium', 3, $5, $6, $7, $8, $9, $9) RETURNING id`,
    [ws.workspaceId, taskId, intentId, status, [ws.userId], decided ? ws.userId : null, decided ? NOW : null, new Date(NOW.getTime() + 24 * 3600_000), NOW],
  );
  return r.rows[0]!.id;
}

export async function intentRow(db: Db, intentId: string): Promise<Record<string, any>> {
  return (await db.query<Record<string, any>>("SELECT * FROM action_intents WHERE id = $1", [intentId])).rows[0]!;
}
export async function taskRow(db: Db, taskId: string): Promise<Record<string, any>> {
  return (await db.query<Record<string, any>>("SELECT * FROM tasks WHERE id = $1", [taskId])).rows[0]!;
}
export async function auditEvents(db: Db, workspaceId: string): Promise<Array<{ event_type: string; payload: Record<string, any> }>> {
  return (
    await db.query<{ event_type: string; payload: Record<string, any> }>(
      "SELECT event_type, payload FROM audit_logs WHERE workspace_id = $1 ORDER BY seq",
      [workspaceId],
    )
  ).rows;
}

/** ワークスペース（既定はオーナー。監査ログの起点つき） */
export function workspace(db: Db, kind: "owner" | "guest" = "owner"): Promise<FxWorkspace> {
  return fxWorkspace(db, { kind, audit: true });
}

/** 豆 20kg（いつもの発注。単価 780） */
export const BEANS_20: JsonObject = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 780 }] };
