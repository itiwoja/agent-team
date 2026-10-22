// 書き込みの RPC の結果（WorkspaceDO → Worker）。RPC をまたぐと AppError の code・details・headers が落ちるので、
// DO の中で AppError を値（WriteResult）にして返し、Worker の側（routes/router.ts の reply）で AppError に戻して投げる。
// AppError でない例外はそのまま投げる（500 になる）

import { AppError, isAppError, type ApiErrorCode } from "@open-team/platform";

export interface WriteError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
  headers?: Record<string, string>;
}

export type WriteResult<T> = { ok: true; status: number; body: T } | { ok: false; error: WriteError };

/** fn を動かし、AppError を値にする */
export function captureAppError<T>(fn: () => { status: number; body: T }): WriteResult<T> {
  try {
    return { ok: true, ...fn() };
  } catch (e) {
    if (!isAppError(e)) throw e;
    return {
      ok: false,
      error: {
        code: e.code,
        message: e.message,
        ...(e.details === undefined ? {} : { details: e.details }),
        ...(e.headers === undefined ? {} : { headers: { ...e.headers } }),
      },
    };
  }
}

/** 値にしたエラーを AppError に戻して投げる */
export function unwrapWrite<T>(r: WriteResult<T>): { status: number; body: T } {
  if (r.ok) return { status: r.status, body: r.body };
  const { code, message, details, headers } = r.error;
  throw new AppError(code, message, { ...(details === undefined ? {} : { details }), ...(headers === undefined ? {} : { headers }) });
}
