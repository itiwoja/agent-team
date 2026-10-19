// 試験用の道具（index からは出さない）。アプリを作り、MCP のクライアント SDK を app.request（または実際の HTTP）につなぐ

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { agentRunsFor, type FaultSpecInput } from "@open-team/sim-core";
import { createApp, type SimWorldDeps } from "./app.ts";
import { CALLER_HEADER } from "./auth.ts";
import type { SimWorldEnv } from "./env.ts";
import { MemorySimStore } from "./memory-store.ts";

export const TOKEN = "local-shared-token-for-tests-0123456789";

export const LOCAL_ENV: SimWorldEnv = {
  port: 0,
  sharedToken: TOKEN,
  databaseUrl: undefined,
  commitSha: "0123abc",
};

/** 実時刻を固定（2026-10-14 10:00 JST） */
export const FIXED_NOW = new Date("2026-10-14T01:00:00.000Z");

export const GATEWAY = { authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-gateway" } as const;
export const APP = { authorization: `Bearer ${TOKEN}`, [CALLER_HEADER]: "sa-app" } as const;

export type AppLike = { request: (input: string | URL, init?: RequestInit) => Response | Promise<Response> };

export function setup(deps: SimWorldDeps = {}) {
  const store = new MemorySimStore();
  const app = createApp(LOCAL_ENV, { store, now: () => FIXED_NOW, ...deps });
  return { app, store };
}

export const newId = (): string => randomUUID();

/** 管理 API を sa-app で呼ぶ */
export function adminApi(app: AppLike, auth: Record<string, string> = APP) {
  const send = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const res = await app.request(`http://sim.test/admin/v1${path}`, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, any>) : null;
    return { status: res.status, json, headers: res.headers };
  };
  return {
    post: (path: string, body: unknown, extra?: Record<string, string>) => send("POST", path, body, extra),
    get: (path: string) => send("GET", path),
    del: (path: string) => send("DELETE", path),
  };
}

/** 状況（API に渡す入力の形。既定値は sim-world が埋める） */
export function scenarioInput(faults: FaultSpecInput[], seed = 1, source: "generated" | "user" | "incident" = "generated") {
  return {
    schemaVersion: 1,
    world: "shop",
    seed,
    title: "試験の状況",
    faults,
    agentRuns: agentRunsFor(faults as { id: Parameters<typeof agentRunsFor>[0][number]["id"] }[]),
    endAt: "day2_end",
    origin: { source },
  };
}

/** デモ店舗を作る */
export async function createDemoStore(app: AppLike, workspaceId: string, extra: Record<string, unknown> = {}) {
  const r = await adminApi(app).post("/demo-store", { workspaceId, world: "shop", ...extra });
  if (r.status !== 201 && r.status !== 200) throw new Error(`デモ店舗を作れない：${r.status} ${JSON.stringify(r.json)}`);
  return r.json!.execution as { id: string; [k: string]: unknown };
}

/** リハーサルの走行を作る */
export async function createExecution(
  app: AppLike,
  input: { workspaceId: string; rehearsalRunId?: string; executionId?: string; variant?: "governed" | "shadow"; faults?: FaultSpecInput[]; seed?: number; snapshotId?: string; source?: "generated" | "user" | "incident" },
) {
  const body = {
    workspaceId: input.workspaceId,
    world: "shop",
    rehearsalRunId: input.rehearsalRunId ?? newId(),
    executionId: input.executionId ?? newId(),
    variant: input.variant ?? "governed",
    scenario: scenarioInput(input.faults ?? [], input.seed ?? 1, input.source ?? ((input.faults ?? []).length === 0 ? "incident" : "generated")),
    ...(input.snapshotId ? { snapshotId: input.snapshotId } : {}),
  };
  const r = await adminApi(app).post("/executions", body);
  if (r.status !== 201) throw new Error(`走行を作れない：${r.status} ${JSON.stringify(r.json)}`);
  return { id: body.executionId, rehearsalRunId: body.rehearsalRunId, view: r.json!.execution as Record<string, any> };
}

export async function getExecution(app: AppLike, workspaceId: string, id: string, auth: Record<string, string> = APP) {
  const r = await adminApi(app, auth).get(`/executions/${id}?workspaceId=${workspaceId}`);
  if (r.status !== 200) throw new Error(`走行を読めない：${r.status} ${JSON.stringify(r.json)}`);
  return r.json as { execution: Record<string, any>; state: Record<string, any>; initialState: Record<string, any>; events: Array<Record<string, any>> };
}

/** gateway が付ける X-OT-* */
export function simHeaders(h: {
  workspaceId?: string;
  rehearsalRunId?: string;
  executionId?: string;
  taskId?: string;
  intentId?: string;
  shadow?: boolean;
}): Record<string, string> {
  return {
    ...(h.workspaceId ? { "x-ot-workspace-id": h.workspaceId } : {}),
    ...(h.rehearsalRunId ? { "x-ot-rehearsal-run-id": h.rehearsalRunId } : {}),
    ...(h.executionId ? { "x-ot-sim-execution-id": h.executionId } : {}),
    ...(h.taskId ? { "x-ot-task-id": h.taskId } : {}),
    ...(h.intentId ? { "x-ot-intent-id": h.intentId } : {}),
    ...(h.shadow !== undefined ? { "x-ot-shadow": String(h.shadow) } : {}),
  };
}

/**
 * MCP のクライアント SDK でつなぐ（Streamable HTTP。fetch を app.request に向ける＝HTTP の要求と応答をそのまま通す）。
 * base を渡せば実際の HTTP で
 */
export async function connectMcp(
  target: AppLike | { base: string },
  path: string,
  headers: Record<string, string>,
): Promise<Client> {
  const url = new URL("base" in target ? `${target.base}${path}` : `http://sim.test${path}`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    ...("base" in target ? {} : { fetch: (input: string | URL, init?: RequestInit) => Promise.resolve(target.request(input, init)) }),
  });
  const client = new Client({ name: "test-gateway", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** 豆 20kg（いつもの発注。単価 780） */
export const BEANS_20 = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 780 }] };
