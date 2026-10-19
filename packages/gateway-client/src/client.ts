// gateway を呼ぶクライアント（fetch だけ。edge・app が使う）

import {
  GatewayClientError,
  type GatewayClient,
  type GwExecuteResponse,
  type GwToolsCallRequest,
  type GwToolsCallResponse,
  type GwToolsSyncResponse,
} from "./types.ts";

export interface GatewayClientOptions {
  /** 例 https://gateway-xxxx.a.run.app（末尾の / はなくてよい）。ID トークンの aud にも使う */
  baseUrl: string;
  /** 呼び出し元の証明のヘッダー（cloud は Authorization: Bearer <ID トークン>、local は共有トークン＋X-OT-Caller） */
  authHeaders: (audience: string) => Promise<Record<string, string>>;
  fetch?: typeof fetch;
  /** 既定 120秒（tools/call の60秒＋送信前の再試行の待ち 21秒より長く：G-02） */
  timeoutMs?: number;
}

export const TASK_TOKEN_HEADER = "x-task-token";

export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  async function post<T>(path: string, body: unknown, extra: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await opts.authHeaders(base)), ...extra },
      body: JSON.stringify(body ?? {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; details?: unknown } } | null)?.error;
      throw new GatewayClientError(res.status, err?.code ?? "UPSTREAM_ERROR", err?.details);
    }
    return json as T;
  }

  return {
    callReadTool: (taskToken: string, req: GwToolsCallRequest, o?: { signal?: AbortSignal }) =>
      post<GwToolsCallResponse>("/gw/v1/tools/call", req, { [TASK_TOKEN_HEADER]: taskToken }, o?.signal),
    executeIntent: (intentId: string, o?: { signal?: AbortSignal }) =>
      post<GwExecuteResponse>(`/gw/v1/intents/${encodeURIComponent(intentId)}/execute`, {}, {}, o?.signal),
    syncTools: (connectorId: string, o?: { signal?: AbortSignal }) =>
      post<GwToolsSyncResponse>(`/gw/v1/connectors/${encodeURIComponent(connectorId)}/tools/sync`, {}, {}, o?.signal),
    revokeCredential: async (connectorId: string, workspaceId: string, o?: { signal?: AbortSignal }) => {
      await post<unknown>(`/gw/v1/connectors/${encodeURIComponent(connectorId)}/revoke-credential`, { workspaceId }, {}, o?.signal);
    },
  };
}
