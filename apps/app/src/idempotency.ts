// Idempotency-Key（09_api/common.md:50、AS §2.1・8-30）：任意の UUID。同じキーの要求は24時間、同じ結果を返す。
// 処理と結果の記録を1つのトランザクションにし、同じキーの同時の要求はアドバイザリロックで直列にする（片方が先に記録し、もう片方はそれを返す）。
// 決めたこと：同じキーで違う要求（メソッド・パス・本文のハッシュが違う）は 400 VALIDATION_ERROR（09 に定めがない）。
// 失敗（4xx・5xx）は記録しない（トランザクションごと戻る。同じキーでやり直せば同じ判断になる）

import type { SessionCtx, Tx } from "@open-team/db";
import { findIdempotencyRecord, lockIdempotencyKey, saveIdempotencyRecord } from "@open-team/db/app";
import { hashCanonical, type Json } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import type { Context } from "hono";
import { z } from "zod";
import type { AppHonoEnv } from "./context.ts";
import type { AppDeps, InTxResult } from "./deps.ts";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const KeySchema = z.guid();

/** ヘッダーのキー（なければ null。UUID の形でなければ 400） */
export function idempotencyKeyOf(c: Context): string | null {
  const raw = c.req.header(IDEMPOTENCY_HEADER);
  if (raw === undefined || raw.trim() === "") return null;
  const r = KeySchema.safeParse(raw.trim());
  if (!r.success) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "Idempotency-Key", reason: "uuid の形ではありません" }] });
  return r.data.toLowerCase();
}

/**
 * 処理（トランザクションの中）を冪等にして応答する。キーがなければそのまま1回動かす。
 * 2回目以降は記録した応答（状態と本文）をそのまま返し、afterCommit は動かさない
 */
export async function runIdempotent<T extends object>(
  deps: Pick<AppDeps, "db" | "clock">,
  c: Context<AppHonoEnv>,
  s: SessionCtx,
  request: Json,
  fn: (tx: Tx, now: Date) => Promise<InTxResult<T>>,
  status: 200 | 201 = 200,
): Promise<Response> {
  const key = idempotencyKeyOf(c);
  const now = deps.clock.now();
  if (key === null) {
    const r = await deps.db.transaction((tx) => fn(tx, now), { retryOnce: true });
    r.afterCommit?.();
    return c.json(r.body, status);
  }
  const method = c.req.method;
  const path = c.req.path;
  const requestHash = hashCanonical(request);
  const out = await deps.db.transaction(
    async (tx): Promise<{ replay: true; status: number; body: Json } | { replay: false; result: InTxResult<T> }> => {
      await lockIdempotencyKey(tx, s, key);
      const prev = await findIdempotencyRecord(tx, s, key, new Date(now.getTime() - IDEMPOTENCY_TTL_MS));
      if (prev) {
        if (prev.method !== method || prev.path !== path || prev.request_hash !== requestHash) {
          throw new AppError("VALIDATION_ERROR", "同じ Idempotency-Key を違う要求に使えません", {
            details: [{ field: "Idempotency-Key", reason: "reused_for_different_request" }],
          });
        }
        return { replay: true, status: prev.response_status, body: prev.response_body };
      }
      const result = await fn(tx, now);
      await saveIdempotencyRecord(tx, s, { key, method, path, requestHash, responseStatus: status, responseBody: result.body as unknown as Json }, now);
      return { replay: false, result };
    },
    { retryOnce: true },
  );
  if (out.replay) return c.json(out.body as T, out.status as 200);
  out.result.afterCommit?.();
  return c.json(out.result.body, status);
}
