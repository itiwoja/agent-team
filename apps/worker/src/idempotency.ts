// Idempotency-Key（09_api/common.md:50、AS §2.1・8-30。apps/app/src/idempotency.ts の WorkspaceDO 版）：任意の UUID。同じキーの要求は24時間、同じ結果を返す。
// - Worker の側（idempotencyOf）：ヘッダーのキーを読み、メソッド・パス・本文のハッシュと一緒に DO へ渡す
// - DO の側（runIdempotent）：探す → 処理 → 残す を1つのトランザクションで行う。DO の中は1本の流れなので、同じキーの同時の要求は重ならない
// 同じキーで違う要求（メソッド・パス・本文のハッシュが違う）は 400 VALIDATION_ERROR。失敗（AppError）は記録しない（トランザクションごと戻る）

import { hashCanonical, type Json } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import type { Context } from "hono";
import { z } from "zod";
import { findIdempotencyRecord, saveIdempotencyRecord } from "./db/repo/app.ts";
import type { WsDb } from "./db/sqlite.ts";
import { captureAppError, type WriteResult } from "./write.ts";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** DO に渡す冪等性のキーと要求の印 */
export interface IdemRequest {
  key: string;
  method: string;
  path: string;
  requestHash: string;
}

const KeySchema = z.guid();

/** ヘッダーのキーと要求の印（キーがなければ null。UUID の形でなければ 400）。request は要求の中身（本文とパスの ID） */
export function idempotencyOf(c: Context, request: Json): IdemRequest | null {
  const raw = c.req.header(IDEMPOTENCY_HEADER);
  if (raw === undefined || raw.trim() === "") return null;
  const r = KeySchema.safeParse(raw.trim());
  if (!r.success) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "Idempotency-Key", reason: "uuid の形ではありません" }] });
  return { key: r.data.toLowerCase(), method: c.req.method, path: c.req.path, requestHash: hashCanonical(request) };
}

/**
 * 処理（fn。中で AppError を投げてよい）を冪等にして結果を返す。キーがなければそのまま1回動かす。
 * 2回目以降は記録した応答（状態と本文）をそのまま返す（replayed: true。呼ぶ側はあとの処理を動かさない）
 */
export function runIdempotent<T>(db: WsDb, idem: IdemRequest | null, status: 200 | 201, now: Date, fn: () => T): WriteResult<T> {
  return captureAppError(() =>
    db.transaction(() => {
      if (idem === null) return { status, body: fn() };
      const prev = findIdempotencyRecord(db, idem.key, new Date(now.getTime() - IDEMPOTENCY_TTL_MS));
      if (prev) {
        if (prev.method !== idem.method || prev.path !== idem.path || prev.request_hash !== idem.requestHash) {
          throw new AppError("VALIDATION_ERROR", "同じ Idempotency-Key を違う要求に使えません", {
            details: [{ field: "Idempotency-Key", reason: "reused_for_different_request" }],
          });
        }
        return { status: prev.response_status, body: prev.response_body as T, replayed: true as const };
      }
      const body = fn();
      saveIdempotencyRecord(db, { ...idem, responseStatus: status, responseBody: body as unknown as Json }, now);
      return { status, body };
    }),
  );
}
