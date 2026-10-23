// edge の失敗（runner の EdgeError）を RPC・Workflow の歩みをまたいで運ぶ形。
// EdgeError は RPC をまたぐと code・details・retryAfterSec が落ち、歩みの中で投げると Workflow のやり直しにかかるので、
// DO の中で値（EdgeOutcome）にして返し、Workflow の側（workflows/task-run.ts）で EdgeError に戻して投げる

import type { Json } from "@open-team/kernel";
import { EdgeError, type EdgeErrorCode } from "@open-team/runner";

/** details は JSON の値（RPC の型は unknown を通さないので、JSON の型にそろえる） */
export interface EdgeFault {
  code: EdgeErrorCode;
  details?: Json;
  retryAfterSec: number | null;
}

export type EdgeOutcome<T> = { ok: true; value: T } | { ok: false; fault: EdgeFault };

/** fn を動かし、EdgeError を値にする（ほかの例外はそのまま投げる） */
export function captureEdge<T>(fn: () => T): EdgeOutcome<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (!(e instanceof EdgeError)) throw e;
    return { ok: false, fault: { code: e.code, ...(e.details === undefined ? {} : { details: e.details as Json }), retryAfterSec: e.retryAfterSec } };
  }
}

/** 値にした失敗を EdgeError に戻して投げる */
export function unwrapEdge<T>(r: EdgeOutcome<T>): T {
  if (r.ok) return r.value;
  throw new EdgeError(r.fault.code, r.fault.details, r.fault.retryAfterSec);
}
