// 試験用の道具（index からは出さない）。sim-world を同じプロセスで本物の HTTP で起こし（保存はメモリ）、
// gateway を app.request につなぎ、DB は @open-team/db/testing の試験ごとのデータベースを使う

import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { appendAuditLog, hashTaskToken, type Db } from "@open-team/db";
import {
  fxAgent,
  fxHash,
  fxRehearsalCase,
  fxRehearsalRun,
  fxRehearsalScenario,
  fxSimExecution,
  fxTask,
  fxWorkspace,
  type FxAgent,
  type FxTaskOptions,
  type FxWorkspace,
} from "@open-team/db/testing";
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
import { SHOP_CONNECTORS, SHOP_WORLD, type FaultSpecInput, type SimToolListing } from "@open-team/sim-core";
import { createApp as createSimApp, MemorySimStore, type SimWorldDeps, type SimWorldEnv } from "@open-team/sim-world";
import { createGateway, type GatewayApp } from "./app.ts";
import type { GatewayDeps } from "./context.ts";
import type { GatewayEnv } from "./env.ts";

export const SIM_TOKEN = "sim-world-shared-token-for-gateway-tests-0123";
export const GW_TOKEN = "gateway-internal-token-for-gateway-tests-0123";
export const APP_CALLER = { authorization: `Bearer ${GW_TOKEN}`, "x-ot-caller": "sa-app" } as const;
export const NOW = new Date("2026-10-12T09:00:00.000Z");

// ---- sim-world（本物の HTTP。ポートは OS が選ぶ）----

export interface SimWorldHandle {
  url: string;
  store: MemorySimStore;
  close(): Promise<void>;
  admin(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }>;
  createDemoStore(workspaceId: string): Promise<{ id: string }>;
  createExecution(i: {
    workspaceId: string;
    rehearsalRunId: string;
    executionId: string;
    variant: "governed" | "shadow";
    faults: FaultSpecInput[];
  }): Promise<void>;
  getState(workspaceId: string, executionId: string): Promise<{ state: Record<string, any>; events: Array<Record<string, any>> }>;
}

export async function startSimWorld(deps: Omit<SimWorldDeps, "store"> = {}): Promise<SimWorldHandle> {
  const store = new MemorySimStore();
  const env: SimWorldEnv = {
    deploymentMode: "local",
    port: 0,
    sharedToken: SIM_TOKEN,
    selfUrl: undefined,
    gatewaySaEmail: undefined,
    appSaEmail: undefined,
    databaseUrl: undefined,
    commitSha: "test",
  };
  const app = createSimApp(env, { store, ...deps });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}/admin/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${SIM_TOKEN}`, "x-ot-caller": "sa-app", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return {
    url,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
    admin,
    async createDemoStore(workspaceId) {
      const r = await admin("POST", "/demo-store", { workspaceId, world: "shop" });
      if (r.status !== 201 && r.status !== 200) throw new Error(`デモ店舗を作れない：${r.status} ${JSON.stringify(r.json)}`);
      return { id: r.json.execution.id as string };
    },
    async createExecution(i) {
      const r = await admin("POST", "/executions", {
        workspaceId: i.workspaceId,
        world: "shop",
        rehearsalRunId: i.rehearsalRunId,
        executionId: i.executionId,
        variant: i.variant,
        scenario: {
          schemaVersion: 1,
          world: "shop",
          seed: 1,
          title: "試験の状況",
          faults: i.faults,
          agentRuns: i.faults.some((f) => (f as { id: string }).id === "F-01") ? 2 : 1,
          endAt: "day2_end",
          origin: { source: i.faults.length === 0 ? "incident" : "generated" },
        },
      });
      if (r.status !== 201) throw new Error(`走行を作れない：${r.status} ${JSON.stringify(r.json)}`);
    },
    async getState(workspaceId, executionId) {
      const r = await admin("GET", `/executions/${executionId}?workspaceId=${workspaceId}`);
      if (r.status !== 200) throw new Error(`走行を読めない：${r.status} ${JSON.stringify(r.json)}`);
      return { state: r.json.state, events: r.json.events };
    },
  };
}

/** サーバー側のツールの定義を試験の中で変える（F-08 の本番の形・ツールの増減：DR-01〜06） */
export interface ToolListOverrides {
  /** '<コネクタ>.<ツール>' → 新しい説明 */
  description: Map<string, string>;
  /** '<コネクタ>.<ツール>' → 新しい入力スキーマ */
  inputSchema: Map<string, Record<string, unknown>>;
  /** 一覧から消す '<コネクタ>.<ツール>' */
  removed: Set<string>;
  /** 一覧に足す（コネクタごと） */
  added: Map<string, SimToolListing[]>;
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

/** tools/list の中身を overrides で変える sim-world（呼び出しの処理は本物の仕入れ係の世界のまま） */
export async function startMutableSimWorld(o: ToolListOverrides): Promise<SimWorldHandle> {
  const world = {
    ...SHOP_WORLD,
    listTools(state: Parameters<typeof SHOP_WORLD.listTools>[0], connector?: string): SimToolListing[] {
      const base = SHOP_WORLD.listTools(state, connector)
        .filter((t) => !o.removed.has(`${t.connector}.${t.name}`))
        .map((t) => {
          const key = `${t.connector}.${t.name}`;
          return {
            ...t,
            ...(o.description.has(key) ? { description: o.description.get(key)! } : {}),
            ...(o.inputSchema.has(key) ? { inputSchema: o.inputSchema.get(key)! } : {}),
          } as SimToolListing;
        });
      return [...base, ...(connector ? (o.added.get(connector) ?? []) : [...o.added.values()].flat())];
    },
  };
  return startSimWorld({ worlds: { shop: world as unknown as NonNullable<SimWorldDeps["worlds"]>["shop"] } });
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

export function gatewayEnv(simUrl: string | null, over: Partial<GatewayEnv> = {}): GatewayEnv {
  return {
    deploymentMode: "local",
    port: 0,
    databaseUrl: "postgres://unused",
    allowedConnectorUrls: simUrl ? [simUrl] : [],
    simWorldUrl: simUrl,
    serviceAuth: { mode: "local", sharedToken: GW_TOKEN },
    simWorldSharedToken: SIM_TOKEN,
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
export type SeededShop = Record<string, SeededConnector>;

/**
 * sim-world を普通のコネクタとして登録する（MT §3.14 の5〜7）：コネクタの行 → EP-51（tools/list）→ manifest の分類・役割で確定し
 * tool_hash を計算し直す（seed が app でやる処理を試験の中で行う）
 */
export async function seedShop(db: Db, client: GatewayClient, ws: FxWorkspace, simUrl: string, opts: { slugs?: string[] } = {}): Promise<SeededShop> {
  const out: SeededShop = {};
  for (const c of SHOP_CONNECTORS) {
    if (opts.slugs && !opts.slugs.includes(c.slug)) continue;
    const url = `${simUrl}${c.path}`;
    const r = await db.query<{ id: string }>(
      `INSERT INTO connectors (workspace_id, slug, display_name, kind, url, auth) VALUES ($1, $2, $3, 'sim', $4, $5) RETURNING id`,
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
        [row.id, t.classification, t.argRoles, t.scope, t.verify, toolHash, NOW],
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
   * approve で approved 以降の状態なら人の承認（approved の承認の行と approval.decided）。合格証は入れない（insertCertificate）
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
    const task = (await db.query<{ rehearsal_run_id: string | null; shadow: boolean }>("SELECT rehearsal_run_id, shadow FROM tasks WHERE id = $1", [i.taskId])).rows[0]!;
    // 本番のタスクだけ（edge は影・リハーサルでも判定の記録を残すが、gateway はそれを照合しない。既存の試験の判定の記録の数を変えない）
    if (task.rehearsal_run_id === null && !task.shadow) {
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
        certificateValid: decision === "allow",
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
  certificateValid?: boolean;
  /** 承認待ちの承認の行と approval.requested も作るか（edge は本番の approve で作る）。期限は既定 NOW + 24時間 */
  approval?: boolean | { expiresAt: Date };
  /** 監査ログ（intent.proposed・approval.requested・decision.made）を書くか（既定 true） */
  audit?: boolean;
}

/**
 * edge の LLM Proxy が1つのトランザクションで残す判定の記録（recordMcpIntent → recordDecision と同じ順と形）：
 * intent.proposed →（承認の行と approval.requested）→ policy_decisions（subject.call.intentId に Intent の ID）→ decision.made。
 * 形が edge の本物と合っていることは apps/app/src/rehearsal/provenance-shape.test.ts が確かめる
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
        { killSwitchEngaged: false, taskStatus: "running", certificateValid: k.certificateValid ?? false },
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

/** 判定の記録のない承認（ゲストのデモのデータの形）：承認の行を作って人が決める */
export async function insertDecidedApproval(
  db: Db,
  ws: FxWorkspace,
  a: Omit<DecideApprovalInput, "approvalId"> & { approverIds?: string[]; expiresAt?: Date },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO approvals (workspace_id, task_id, intent_id, status, risk_level, risk_score, approver_ids, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', 'medium', 3, $4, $5, $6, $6) RETURNING id`,
    [ws.workspaceId, a.taskId, a.intentId, a.approverIds ?? [ws.userId], a.expiresAt ?? new Date(NOW.getTime() + 24 * 3600_000), new Date(NOW.getTime() - 120_000)],
  );
  const approvalId = r.rows[0]!.id;
  await decideApproval(db, ws, { ...a, approvalId });
  return approvalId;
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

/**
 * リハーサルの走行・試験・状況・sim の走行（DB の行。sim-world 側の走行は同じ ID で別に作る）。
 * 同じ仕事で動いている走行は1つ（rehearsal_runs_one_active_uq）なので、2つ目の種類は run を渡して同じ走行に足す
 */
export async function rehearsalRows(
  db: Db,
  ws: FxWorkspace,
  agent: FxAgent,
  variant: "governed" | "shadow",
  run?: { runId: string; scenarioId: string },
): Promise<{ runId: string; scenarioId: string; executionId: string }> {
  let ids = run;
  if (!ids) {
    const { runId } = await fxRehearsalRun(db, ws, { jobId: agent.jobId });
    const { caseId } = await fxRehearsalCase(db, ws, { jobId: agent.jobId });
    const { scenarioId } = await fxRehearsalScenario(db, ws, { runId, caseId });
    ids = { runId, scenarioId };
  }
  const { executionId } = await fxSimExecution(db, ws, { rehearsalRunId: ids.runId, variant, id: randomUUID() });
  return { ...ids, executionId };
}

/**
 * 有効な合格証（その仕事に付与したツールの [{ action, toolHash }]：M-49）。repo/rehearsal.ts の issueCertificate と同じく、
 * 監査ログ rehearsal.certificate_issued を書き、その seq を行の audit_seq に持たせる（同じ仕事の前の合格証は superseded にする）
 */
export async function insertCertificate(db: Db, ws: FxWorkspace, jobId: string, actions: Array<{ action: string; toolHash: string }>): Promise<string> {
  const { runId } = await fxRehearsalRun(db, ws, { jobId, status: "done" });
  const certificateHash = fxHash(`cert:${randomUUID()}`);
  const at = new Date(NOW.getTime() - 24 * 3600_000);
  return db.transaction(async (tx) => {
    await tx.query("UPDATE rehearsal_certificates SET revoked_at = $3, revoke_reason = 'superseded' WHERE workspace_id = $1 AND job_id = $2 AND revoked_at IS NULL", [
      ws.workspaceId,
      jobId,
      at,
    ]);
    const issued = await appendAuditLog(
      tx,
      ws.workspaceId,
      {
        eventType: "rehearsal.certificate_issued",
        actorType: "system",
        actorId: "rehearsal",
        payload: { jobId, runId, certificateHash, policyHash: fxHash("policy"), caseSetHash: fxHash("cases"), caseCount: 12, modelId: "gemini-test" },
      },
      at,
    );
    const r = await tx.query<{ id: string }>(
      `INSERT INTO rehearsal_certificates (workspace_id, job_id, rehearsal_run_id, policy_hash, tool_hashes, model_id, case_set_hash, case_count,
                                           summary, cost_usd, certificate_hash, audit_seq, issued_at)
       VALUES ($1, $2, $3, $4, $5, 'gemini-test', $6, 12, '{}', '0.400000', $7, $8, $9) RETURNING id`,
      [ws.workspaceId, jobId, runId, fxHash("policy"), actions, fxHash("cases"), certificateHash, issued.seq, at],
    );
    return r.rows[0]!.id;
  });
}

/** 合格証を切る（repo/rehearsal.ts の revokeJobCertificate と同じく rehearsal.certificate_revoked を書く） */
export async function revokeCertificate(db: Db, ws: FxWorkspace, certificateId: string, jobId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("UPDATE rehearsal_certificates SET revoked_at = $2, revoke_reason = 'widen' WHERE id = $1", [certificateId, NOW]);
    await appendAuditLog(
      tx,
      ws.workspaceId,
      { eventType: "rehearsal.certificate_revoked", actorType: "system", actorId: "rehearsal", payload: { certificateIds: [certificateId], jobIds: [jobId], reason: "widen" } },
      NOW,
    );
  });
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
