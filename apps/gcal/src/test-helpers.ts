// 試験用の道具（index からは出さない）。偽の Google（fetch）と、MCP のクライアント SDK をアプリにつなぐ

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GCAL_HEADER } from "@open-team/gcal-core";
import { CALLER_HEADER, type Logger, memoryLogger } from "@open-team/platform";
import { createApp, type GcalDeps } from "./app.ts";
import type { GcalEnv } from "./env.ts";

export const LOCAL_TOKEN = "local-shared-token-for-tests-0123456789";
export const ACCESS_TOKEN = "ya29.test-access-token-0123456789";
export const CALENDAR_ID = "makase0001@group.calendar.google.com";
export const API_BASE = "https://www.googleapis.com/calendar/v3";
/** Intent の ID（UUID）。予定の ID は eventIdOf(INTENT) */
export const INTENT = "01234567-89ab-cdef-0123-456789abcdef";
export const EVENT_ID = `mk${INTENT.replace(/-/g, "")}`;

export const LOCAL_ENV: GcalEnv = {
  deploymentMode: "local",
  port: 0,
  sharedToken: LOCAL_TOKEN,
  selfUrl: undefined,
  gatewaySaEmail: undefined,
  googleCalendarApiBase: API_BASE,
  commitSha: "0123abc",
};

/** gateway の呼び出し（共有トークンと呼び出し元の名前） */
export const GATEWAY = { authorization: `Bearer ${LOCAL_TOKEN}`, [CALLER_HEADER]: "sa-gateway" } as const;
/** tools/call のヘッダー（gateway が DB の行と復号したトークンから作るもの） */
export const CALL_HEADERS: Record<string, string> = {
  [GCAL_HEADER.accessToken]: ACCESS_TOKEN,
  [GCAL_HEADER.calendarId]: CALENDAR_ID,
  [GCAL_HEADER.timeZone]: "Asia/Tokyo",
  [GCAL_HEADER.idempotencyKey]: INTENT,
};

export interface FakeCall {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
}

/** 偽の Google：呼ばれた記録を残し、route の応答を返す */
export function fakeGoogle(route: (call: FakeCall) => Response | Promise<Response>) {
  const calls: FakeCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: FakeCall = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body };
    calls.push(call);
    return route(call);
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function setup(google: { fetch: typeof fetch }, deps: Partial<GcalDeps> = {}, env: GcalEnv = LOCAL_ENV) {
  const { logger, lines } = memoryLogger({ commit: "0123abc" });
  const log: Logger = logger;
  const app = createApp(env, { fetch: google.fetch, log, ...deps });
  return { app, lines };
}

type AppLike = { request: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response> };

/** MCP のクライアント SDK をアプリにつなぐ（initialize まで済ませる。拒否なら connect が StreamableHTTPError を投げる） */
export async function connectMcp(app: AppLike, headers: Record<string, string>): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://gcal.test/mcp/gcal"), {
    requestInit: { headers },
    fetch: (input: string | URL, init?: RequestInit) => Promise.resolve(app.request(input, init)),
  });
  const client = new Client({ name: "test-gateway", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
