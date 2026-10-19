// 試験の道具（本番では読み込まれない。名前が test-helpers.ts なので dependency-cruiser の not-to-dev-dep の対象外）
// - app を試験用の依存で組む（手で進める時計・ログをためる Logger・待ちを記録する sleep・ローカルの共有トークン）
// - 偽の gateway（EP-51 の syncTools：sim-core の manifest のツールを unclassified で入れる。本物の gateway と同じ入れ方）
// - 同じプロセスの本物の sim-world（@open-team/sim-world の createApp。保存はメモリ）につないだ sim-client
// - 要求を送る・サインインする・SSE を読む

import type { Db } from "@open-team/db";
import { GatewayClientError, type GatewayClient, type GwToolsSyncResponse } from "@open-team/gateway-client";
import { toolHashOf, type Json } from "@open-team/kernel";
import { ScriptedLlmClient } from "@open-team/llm";
import { createServiceAuth, manualClock, memoryLogger, type LogRecord, type ManualClock } from "@open-team/platform";
import { createSimClient, type SimClient } from "@open-team/sim-client";
import { SHOP_CONNECTORS, SHOP_TOOL_DESCRIPTIONS, SHOP_TOOL_INPUT_SCHEMAS, type ShopToolName } from "@open-team/sim-core";
import { createApp as createSimWorldApp, MemorySimStore, type SimStore } from "@open-team/sim-world";
import type { Hono } from "hono";
import { createApp, type CreateAppOptions } from "./app.ts";
import type { AppHonoEnv } from "./context.ts";
import { createAppDeps, unavailableGatewayClient, type AppDeps } from "./deps.ts";
import type { AppEnv } from "./env.ts";
import { SESSION_COOKIE } from "./http.ts";
import { unavailableSimClient } from "@open-team/sim-client";

export const OWNER_TOKEN = "owner-token-for-tests-0123456789abcdef";
export const GUEST_TOKEN = "guest-token-for-tests-0123456789abcdef";
export const COOKIE_SECRET = "cookie-secret-for-tests-0123456789abcd";
export const SHARED_TOKEN = "internal-shared-token-0123456789abcdef";
export const HOST = "app.test";
export const ORIGIN = `https://${HOST}`;
export const SIM_URL = "http://sim-world.test";
export const GATEWAY_URL = "http://gateway.test";
export const T0 = new Date("2026-10-14T01:00:00.000Z"); // 10:00 JST

export function testEnv(over: Partial<AppEnv> = {}): AppEnv {
  return {
    deploymentMode: "local",
    appEnv: "test",
    port: 0,
    webDist: undefined,
    ownerToken: OWNER_TOKEN,
    guestToken: GUEST_TOKEN,
    cookieSecret: COOKIE_SECRET,
    cookieSecure: true,
    databaseUrl: "postgres://test",
    databaseUrlMaint: undefined,
    appBaseUrl: ORIGIN,
    appInternalUrl: ORIGIN,
    gatewayUrl: GATEWAY_URL,
    simWorldUrl: SIM_URL,
    serviceAuth: { mode: "local", sharedToken: SHARED_TOKEN },
    gemini: { project: undefined, location: "global", agentModel: "gemini-test", plannerModel: "gemini-test", compareModels: [] },
    guestRetestMode: "replay",
    commitSha: "0123abc",
    googleConnect: undefined,
    githubConnect: undefined,
    sandbox: { provider: "none", job: undefined, edgeUrl: undefined, dockerImage: undefined, dockerNetwork: undefined },
    ...over,
  };
}

export interface TestApp {
  app: Hono<AppHonoEnv>;
  deps: AppDeps;
  clock: ManualClock;
  logs: LogRecord[];
  sleeps: number[];
}

export function makeTestApp(
  db: Db,
  o: { env?: Partial<AppEnv>; missing?: string[]; deps?: Partial<AppDeps>; app?: CreateAppOptions } = {},
): TestApp {
  const clock = manualClock(T0);
  const { logger, records } = memoryLogger({ service: "app", secrets: [OWNER_TOKEN, GUEST_TOKEN, COOKIE_SECRET, SHARED_TOKEN] });
  const sleeps: number[] = [];
  const env = testEnv(o.env);
  const deps = createAppDeps(env, o.missing ?? [], {
    db,
    log: logger,
    clock,
    gatewayClient: unavailableGatewayClient(),
    simClient: unavailableSimClient(),
    llm: new ScriptedLlmClient([]),
    serviceAuth: createServiceAuth(env.serviceAuth, { log: logger }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...o.deps,
  });
  return { app: createApp(deps, { accessLog: false, ...o.app }), deps, clock, logs: records, sleeps };
}

export interface SendOptions {
  cookie?: string | null;
  csrf?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** 同じオリジンの要求（状態を変えるメソッドは Origin と JSON の Content-Type を付ける） */
export async function send(t: Pick<TestApp, "app">, method: string, path: string, o: SendOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { host: HOST };
  if (method !== "GET" && method !== "HEAD") headers.origin = ORIGIN;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.cookie) headers.cookie = `${SESSION_COOKIE}=${o.cookie}`;
  if (o.csrf) headers["x-csrf-token"] = o.csrf;
  Object.assign(headers, o.headers ?? {});
  return t.app.request(`http://${HOST}${path}`, {
    method,
    headers,
    ...(o.body !== undefined ? { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body) } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
}

/** Set-Cookie の ot_session の値（なければ null。消す Cookie は ""） */
export function sessionCookieOf(res: Response): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(raw);
  return m ? (m[1] ?? "") : null;
}

export interface SignedIn {
  cookie: string;
  csrf: string;
  workspaceId: string;
  userId: string;
}

/** オーナーのトークンで入り、Cookie・CSRF・ワークスペースを返す */
export async function signInOwner(t: TestApp): Promise<SignedIn> {
  const res = await send(t, "POST", "/api/v1/entry", { body: { token: OWNER_TOKEN } });
  if (res.status !== 200) throw new Error(`入れなかった：${res.status} ${await res.text()}`);
  const cookie = sessionCookieOf(res);
  if (!cookie) throw new Error("Cookie が出なかった");
  const me = (await (await send(t, "GET", "/api/v1/me", { cookie })).json()) as { csrfToken: string; workspace: { id: string }; user: { id: string } };
  return { cookie, csrf: me.csrfToken, workspaceId: me.workspace.id, userId: me.user.id };
}

/** /internal/* を呼ぶ（既定は sa-app のローカルの証明） */
export async function sendInternal(t: TestApp, method: string, path: string, caller: "sa-app" | "sa-gateway" | null = "sa-app"): Promise<Response> {
  const headers: Record<string, string> = { host: HOST };
  if (caller) Object.assign(headers, await t.deps.serviceAuth.serviceAuthHeaders(caller, ORIGIN));
  return t.app.request(`http://${HOST}${path}`, { method, headers });
}

// ---- 偽の gateway（EP-51） ----

export interface FakeGateway extends GatewayClient {
  syncCalls: string[];
  /** 次から tools/list が返す説明を変える（F-08・needs_review の試験） */
  overrideDescription(tool: ShopToolName, description: string): void;
  /** 次から tools/list に出さない */
  omit(tool: ShopToolName): void;
  /** 次の syncTools を失敗させる */
  failNext(status: number, code: string): void;
}

/**
 * EP-51 の偽物：コネクタの slug の manifest のツールを、本物の gateway と同じく unclassified・status ok・役割 {}・
 * tool_hash = toolHashOf({ 説明, スキーマ, {} }) で入れる。説明かスキーマが変わったら needs_review＋pending（確定の値は書き換えない）
 */
export function fakeGatewayClient(db: Db): FakeGateway {
  const descriptions = new Map<string, string>();
  const omitted = new Set<string>();
  let failure: { status: number; code: string } | null = null;
  const calls: string[] = [];
  return {
    syncCalls: calls,
    overrideDescription: (tool, d) => void descriptions.set(tool, d),
    omit: (tool) => void omitted.add(tool),
    failNext: (status, code) => {
      failure = { status, code };
    },
    async callReadTool() {
      throw new GatewayClientError(501, "NOT_IMPLEMENTED_IN_FAKE");
    },
    async executeIntent() {
      throw new GatewayClientError(501, "NOT_IMPLEMENTED_IN_FAKE");
    },
    async revokeCredential() {},
    async syncTools(connectorId): Promise<GwToolsSyncResponse> {
      calls.push(connectorId);
      if (failure) {
        const f = failure;
        failure = null;
        throw new GatewayClientError(f.status, f.code);
      }
      // 試験だけ：コネクタの ID から行を引く（本物の gateway も ID からワークスペースを引き直す）
      const c = (await db.query<{ id: string; workspace_id: string; slug: string }>("SELECT id, workspace_id, slug FROM connectors WHERE id = $1", [connectorId]))
        .rows[0];
      if (!c) throw new GatewayClientError(404, "NOT_FOUND");
      const manifest = SHOP_CONNECTORS.find((m) => m.slug === c.slug);
      const out: GwToolsSyncResponse["tools"] = [];
      for (const t of manifest?.tools ?? []) {
        const name = `${c.slug}.${t.name}` as ShopToolName;
        if (omitted.has(name)) continue;
        const description = descriptions.get(name) ?? SHOP_TOOL_DESCRIPTIONS[name];
        const inputSchema = SHOP_TOOL_INPUT_SCHEMAS[name] as unknown as Json;
        const existing = (
          await db.query<{ id: string; description: string; tool_hash: `sha256:${string}`; status: "ok" | "needs_review" }>(
            "SELECT id, description, tool_hash, status FROM connector_tools WHERE connector_id = $1 AND name = $2",
            [c.id, t.name],
          )
        ).rows[0];
        if (!existing) {
          const toolHash = toolHashOf({ description, inputSchema, argRoles: {} });
          await db.query(
            `INSERT INTO connector_tools (workspace_id, connector_id, name, description, input_schema, classification, status, arg_roles, tool_hash)
             VALUES ($1, $2, $3, $4, $5, 'unclassified', 'ok', '{}', $6)
             ON CONFLICT (connector_id, name) DO NOTHING`,
            [c.workspace_id, c.id, t.name, description, inputSchema, toolHash],
          );
          out.push({ name: t.name, toolHash, status: "ok" });
        } else if (existing.description !== description) {
          await db.query("UPDATE connector_tools SET status = 'needs_review', pending = $2 WHERE id = $1", [
            existing.id,
            { description, inputSchema, annotations: null, detectedAt: T0.toISOString() },
          ]);
          out.push({ name: t.name, toolHash: existing.tool_hash, status: "needs_review" });
        } else {
          out.push({ name: t.name, toolHash: existing.tool_hash, status: existing.status });
        }
      }
      return { tools: out };
    },
  };
}

// ---- 同じプロセスの sim-world ----

export interface InProcessSimWorld {
  simClient: SimClient;
  store: MemorySimStore;
  /** 次から sim-world に届かない（NETWORK_ERROR） */
  setDown(down: boolean): void;
  requests: string[];
}

/** store を渡すと、メモリでなくその保存（Postgres の PostgresSimStore など。タスクの sim_snapshot_id の外部キーを通したい試験）を使う */
export function inProcessSimWorld(clock: { now(): Date } = { now: () => T0 }, simStore?: SimStore): InProcessSimWorld {
  const store = (simStore ?? new MemorySimStore()) as MemorySimStore;
  const simApp = createSimWorldApp(
    {
      deploymentMode: "local",
      port: 0,
      sharedToken: SHARED_TOKEN,
      selfUrl: undefined,
      gatewaySaEmail: undefined,
      appSaEmail: undefined,
      databaseUrl: undefined,
      commitSha: "0123abc",
    },
    { store, now: () => clock.now() },
  );
  let down = false;
  const requests: string[] = [];
  const auth = createServiceAuth({ mode: "local", sharedToken: SHARED_TOKEN });
  const simClient = createSimClient({
    baseUrl: SIM_URL,
    authHeaders: (aud) => auth.serviceAuthHeaders("sa-app", aud),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(`${init?.method ?? "GET"} ${url.replace(SIM_URL, "")}`);
      if (down) throw new TypeError("fetch failed");
      return simApp.request(url, init);
    }) as typeof fetch,
  });
  return { simClient, store, setDown: (d) => void (down = d), requests };
}

// ---- SSE ----

export interface SseMessage {
  id: string | null;
  event: string | null;
  data: string | null;
  comment: string | null;
}

export interface SseReader {
  /** これまでに読んだすべてのメッセージ */
  readonly messages: SseMessage[];
  /** 流れが終わった（サーバーが切った） */
  readonly ended: boolean;
  /** pred が true になるか、時間切れか、流れが終わるまで読む（同じ応答を何度でも読み進められる） */
  until(pred: (all: SseMessage[]) => boolean, timeoutMs?: number): Promise<SseMessage[]>;
  cancel(): Promise<void>;
}

/** SSE の応答を読み進める道具（読んだメッセージを溜める） */
export function sseReader(res: Response): SseReader {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: SseMessage[] = [];
  let buffer = "";
  let ended = false;
  const parseBlock = (block: string): SseMessage => {
    const m: SseMessage = { id: null, event: null, data: null, comment: null };
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) m.comment = line.slice(1).trim();
      else if (line.startsWith("id: ")) m.id = line.slice(4);
      else if (line.startsWith("event: ")) m.event = line.slice(7);
      else if (line.startsWith("data: ")) m.data = line.slice(6);
    }
    return m;
  };
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  return {
    messages,
    get ended() {
      return ended;
    },
    async until(pred, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (!ended && !pred(messages)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        // 時間切れで抜けても、読みかけの read() は次の until で使う（取りこぼさない）
        pending ??= reader.read();
        const r = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), left))]);
        if (r === null) break;
        pending = null;
        if (r.done) {
          ended = true;
          break;
        }
        buffer += decoder.decode(r.value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          messages.push(parseBlock(buffer.slice(0, i)));
          buffer = buffer.slice(i + 2);
        }
      }
      return messages;
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

/** 少し待つ（通知・見回りの到着を待つ。上限つきでくり返し確かめる） */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("待っても条件が成り立たなかった");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
