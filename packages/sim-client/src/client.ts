// sim-world の管理 API のクライアント（fetch だけ。app が使う。apps/sim-world/src/admin.ts の入出力に合わせる）
// 呼び出し元の証明は差し込む（共有トークン＋x-ot-caller：platform の serviceAuthHeaders）。
// 失敗は SimClientError（HTTP の失敗はサーバーの error.code、届かない・時間切れは status 0）。トークンの値は文に入れない

import type { DamageBreakdown, Scenario, SimEvent } from "@open-team/sim-core";
import type { z } from "zod";
import {
  AdvanceResponseSchema,
  DamageResponseSchema,
  DemoStoreResponseSchema,
  ExecutionDetailResponseSchema,
  ExecutionResponseSchema,
  SimClientError,
  SnapshotResponseSchema,
  WebResponseSchema,
  type ExecutionViewSchema,
  type SimCallOptions,
  type SimClient,
  type SimExecutionView,
  type SimSnapshotView,
  type SimWebResponse,
  type SnapshotViewSchema,
} from "./types.ts";

export interface SimClientOptions {
  /** SIM_WORLD_URL（例 http://localhost:8788。末尾の / はなくてよい） */
  baseUrl: string;
  /** 呼び出し元の証明のヘッダー（audience は baseUrl） */
  authHeaders: (audience: string) => Promise<Record<string, string>>;
  fetch?: typeof fetch;
  /** 既定 30秒（管理の操作は状態1行の読み書きだけ） */
  timeoutMs?: number;
}

export const SIM_ADMIN_PREFIX = "/admin/v1";
export const SIM_CLIENT_DEFAULT_TIMEOUT_MS = 30_000;

type Method = "GET" | "POST" | "DELETE";

const toExecution = (v: z.output<typeof ExecutionViewSchema>): SimExecutionView => ({
  id: v.id,
  workspaceId: v.workspaceId,
  world: v.world,
  rehearsalRunId: v.rehearsalRunId,
  parentExecutionId: v.parentExecutionId,
  variant: v.variant,
  seed: v.seed,
  seedVersion: v.seedVersion,
  // 状況の中身は sim-world が ScenarioSchema で確かめて保存したもの（ここでは作り直さない）
  scenario: (v.scenario ?? null) as Scenario | null,
  snapshotId: v.snapshotId,
  version: v.version,
  stateHash: v.stateHash,
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
});

const toSnapshot = (v: z.output<typeof SnapshotViewSchema>): SimSnapshotView => ({
  id: v.id,
  workspaceId: v.workspaceId,
  world: v.world,
  executionId: v.executionId,
  executionVersion: v.executionVersion,
  seed: v.seed,
  seedVersion: v.seedVersion,
  stateHash: v.stateHash,
  sourceTaskId: v.sourceTaskId,
  takenAt: v.takenAt,
});

function errorOf(status: number, json: unknown): SimClientError {
  const err = (json as { error?: { code?: unknown; message?: unknown; details?: unknown; requestId?: unknown } } | null)?.error;
  const code = typeof err?.code === "string" ? err.code : "UPSTREAM_ERROR";
  const message = typeof err?.message === "string" ? `sim-world ${status} ${code}：${err.message}` : undefined;
  return new SimClientError(status, code, message, {
    details: err?.details,
    requestId: typeof err?.requestId === "string" ? err.requestId : null,
  });
}

type WebRequestBody = { workspaceId: string; kind: "fetch"; url: string } | { workspaceId: string; kind: "search"; query: string; maxResults?: number };

export function createSimClient(opts: SimClientOptions): SimClient {
  const base = opts.baseUrl.trim().replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SIM_CLIENT_DEFAULT_TIMEOUT_MS;

  async function send(method: Method, path: string, body: unknown, o: SimCallOptions = {}): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
    o.signal?.throwIfAborted();
    const headers: Record<string, string> = { ...(await opts.authHeaders(base)) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (o.requestId !== undefined) headers["x-request-id"] = o.requestId;
    let res: Response;
    try {
      res = await doFetch(`${base}${SIM_ADMIN_PREFIX}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
        // 許可した URL から別のホストに飛ばされない（SO §3.2）
        redirect: "error",
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      if (timeout.aborted) throw new SimClientError(0, "TIMEOUT", `sim-world が ${timeoutMs} ミリ秒以内に応答しない`, { cause: e });
      throw new SimClientError(0, "NETWORK_ERROR", "sim-world に届かない", { cause: e });
    }
    const text = await res.text();
    let json: unknown = null;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new SimClientError(res.status, "BAD_RESPONSE", `sim-world の応答が JSON ではない（${res.status}）`);
      }
    }
    if (!res.ok) throw errorOf(res.status, json);
    return { status: res.status, json };
  }

  function parse<S extends z.ZodType>(schema: S, res: { status: number; json: unknown }, what: string): z.output<S> {
    const r = schema.safeParse(res.json);
    if (!r.success) throw new SimClientError(res.status, "BAD_RESPONSE", `sim-world の応答の形が違う（${what}）`, { details: r.error.issues });
    return r.data;
  }

  const id = (s: string) => encodeURIComponent(s);
  const q = (workspaceId: string) => `?workspaceId=${encodeURIComponent(workspaceId)}`;

  return {
    async ensureDemoStore(req, o) {
      const r = parse(DemoStoreResponseSchema, await send("POST", "/demo-store", req, o), "demo-store");
      return { execution: toExecution(r.execution), created: r.created };
    },
    async createExecution(req, o) {
      return { execution: toExecution(parse(ExecutionResponseSchema, await send("POST", "/executions", req, o), "executions").execution) };
    },
    async getExecution(ref, o) {
      const res = await send("GET", `/executions/${id(ref.executionId)}${q(ref.workspaceId)}`, undefined, o);
      const r = parse(ExecutionDetailResponseSchema, res, "execution");
      return { execution: toExecution(r.execution), initialState: r.initialState, state: r.state, events: r.events as SimEvent[] };
    },
    async forkExecution(req, o) {
      const res = await send(
        "POST",
        `/executions/${id(req.sourceExecutionId)}/fork`,
        { workspaceId: req.workspaceId, executionId: req.executionId },
        o,
      );
      return { execution: toExecution(parse(ExecutionResponseSchema, res, "fork").execution) };
    },
    async advanceExecution(req, o) {
      const res = await send("POST", `/executions/${id(req.executionId)}/advance`, { workspaceId: req.workspaceId, to: req.to }, o);
      const r = parse(AdvanceResponseSchema, res, "advance");
      return { execution: toExecution(r.execution), events: r.events as SimEvent[] };
    },
    async computeDamage(ref, o) {
      const res = await send("POST", `/executions/${id(ref.executionId)}/damage`, { workspaceId: ref.workspaceId }, o);
      const r = parse(DamageResponseSchema, res, "damage");
      return { execution: toExecution(r.execution), damage: r.damage as unknown as DamageBreakdown };
    },
    async createSnapshot(req, o) {
      return { snapshot: toSnapshot(parse(SnapshotResponseSchema, await send("POST", "/snapshots", req, o), "snapshots").snapshot) };
    },
    async webFetch(ref, url, o) {
      return webOf({ workspaceId: ref.workspaceId, kind: "fetch", url }, ref.executionId, o);
    },
    async webSearch(ref, query, o, maxResults) {
      return webOf({ workspaceId: ref.workspaceId, kind: "search", query, ...(maxResults === undefined ? {} : { maxResults }) }, ref.executionId, o);
    },
    async deleteWorkspace(workspaceId, o) {
      await send("DELETE", `/workspaces/${id(workspaceId)}`, undefined, o);
    },
  };

  async function webOf(body: WebRequestBody, executionId: string, o?: SimCallOptions): Promise<SimWebResponse> {
    const response = await send("POST", `/executions/${id(executionId)}/web`, body, o);
    const r = parse(WebResponseSchema, response, "web");
    if (r.result.kind !== body.kind) {
      throw new SimClientError(response.status, "BAD_RESPONSE", `sim-world の応答の kind が要求と違う（web: ${body.kind}）`);
    }
    return { execution: toExecution(r.execution), result: r.result as SimWebResponse["result"], events: r.events as SimEvent[] };
  }
}

/** SIM_WORLD_URL がないとき（local の一部）に渡す。どの呼び出しも SimClientError(503, NOT_CONFIGURED) */
export function unavailableSimClient(reason = "SIM_WORLD_URL が設定されていない"): SimClient {
  const fail = async (): Promise<never> => {
    throw new SimClientError(503, "NOT_CONFIGURED", reason);
  };
  return {
    ensureDemoStore: fail,
    createExecution: fail,
    getExecution: fail,
    forkExecution: fail,
    advanceExecution: fail,
    computeDamage: fail,
    createSnapshot: fail,
    webFetch: fail,
    webSearch: fail,
    deleteWorkspace: fail,
  };
}
