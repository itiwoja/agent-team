// エラー応答（09_api/common.md の形 { error: { code, message, details?, requestId } }。SO §2.11）
// 管理 API と、MCP の入口の手前（呼び出し元・URL）で使う。MCP の中のエラーは JSON-RPC のエラーで返す

export type SimErrorCode =
  | "VALIDATION_ERROR" // 400
  | "FORBIDDEN" // 403（理由は返さない：SO §3.9）
  | "NOT_FOUND" // 404（別のワークスペースのものも）
  | "METHOD_NOT_ALLOWED" // 405
  | "EXECUTION_EXISTS" // 409 同じ id の走行がある（AS §3.18 EP-53「すでにあれば 409」）
  | "FORK_NOT_ALLOWED" // 409 governed 以外は分岐しない（SW §4.4.3 の4）
  | "DAMAGE_NOT_AVAILABLE" // 409 デモ店舗には状況がない
  | "SNAPSHOT_IN_USE" // 409 試験が参照しているスナップショットがあるので消せない（DB T-16。Postgres の保存だけ）
  | "PAYLOAD_TOO_LARGE" // 413
  | "UNSUPPORTED_MEDIA_TYPE" // 415
  | "INTERNAL_ERROR"; // 500

export interface SimErrorBody {
  error: { code: SimErrorCode; message: string; details?: Array<Record<string, unknown>>; requestId: string };
}

export function errorBody(
  code: SimErrorCode,
  message: string,
  requestId: string,
  details?: Array<Record<string, unknown>>,
): SimErrorBody {
  return { error: { code, message, ...(details && details.length > 0 ? { details } : {}), requestId } };
}

/** 管理 API の処理の中で投げて、まとめて応答にする */
export class SimHttpError extends Error {
  readonly status: 400 | 404 | 409;
  readonly code: SimErrorCode;
  readonly details: Array<Record<string, unknown>> | undefined;
  constructor(status: 400 | 404 | 409, code: SimErrorCode, message: string, details?: Array<Record<string, unknown>>) {
    super(message);
    this.name = "SimHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
