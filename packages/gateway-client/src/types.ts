// gateway の内部 API（EP-49〜51）の型（パッケージをまたぐ契約。変えるときは gateway・edge・app をすべて直す）
// 出典：spec/api-surface.md §2.12.2・§3.17、intents-approvals.md §3.12、mcp-taint.md §3.12、cross-check.md M-20・M-21・M-43
// 認証：共有トークン＋呼び出し元の名前（platform の serviceAuthHeaders）。
// 本文に workspaceId などを載せても gateway は読まない（タスクのトークン・Intent の行から DB で引き直す：15:486）

import type { ReasonCode, ToolHash, Uuid } from "@open-team/kernel";

/** EP-49 の拒否の理由（decide の理由のほか、gateway の境界：BR-63・64・66） */
export type GwRejectReason =
  | ReasonCode
  | "timeout"
  | "tool_not_read"
  | "tool_removed"
  | "connector_not_found"
  | "guest_workspace"
  | "upstream_error";

/** EP-49 POST /gw/v1/tools/call（読み取り）。ヘッダー X-Task-Token にタスクのトークン */
export interface GwToolsCallRequest {
  connectorId: Uuid;
  tool: string;
  arguments: Record<string, unknown>;
  toolCallId: string;
}
export type GwToolsCallResponse =
  /** content は 64KB で切り、秘密情報をマスク済み。isError は MCP の isError（サーバーの文字列なので汚染はする：MT D-27） */
  | { ok: true; content: string; isError: boolean; truncated: boolean }
  | { ok: false; reasonCode: GwRejectReason };

/** EP-50 POST /gw/v1/intents/{intentId}/execute の結果（本文なし。Intent の行から引く） */
export type GwExecuteStatus =
  | "executed"
  | "failed"
  | "unknown_outcome"
  | "expired"
  /** 送信前の失敗で再試行待ちに戻した（D-18） */
  | "approved";
export interface GwExecuteResponse {
  intentId: Uuid;
  status: GwExecuteStatus;
  /** tool_error・auth_required・unreachable・precondition_failed など（intents-approvals.md §2.2） */
  failReason: string | null;
  /** tool_changed・superseded・policy_changed など */
  expiredReason: string | null;
}

/** EP-51 POST /gw/v1/connectors/{connectorId}/tools/sync */
export interface GwToolsSyncResponse {
  tools: Array<{ name: string; toolHash: ToolHash; status: "ok" | "needs_review" | "removed" }>;
}

export interface GatewayClient {
  callReadTool(taskToken: string, req: GwToolsCallRequest, opts?: { signal?: AbortSignal }): Promise<GwToolsCallResponse>;
  executeIntent(intentId: Uuid, opts?: { signal?: AbortSignal }): Promise<GwExecuteResponse>;
  syncTools(connectorId: Uuid, opts?: { signal?: AbortSignal }): Promise<GwToolsSyncResponse>;
  revokeCredential(connectorId: Uuid, workspaceId: Uuid, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** HTTP の失敗（401・404・409・5xx）。body は 09 の共通の形 { error: { code, message, details, requestId } } */
export class GatewayClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, details?: unknown) {
    super(`gateway ${status} ${code}`);
    this.name = "GatewayClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
