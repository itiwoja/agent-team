// EP-43 監査ログの一覧・EP-44 検証（AS §2.10・§3.13、SO §3.13、09_api/auth-workspace.md:130-154）
// 一覧：ワークスペースで絞り seq の降順でカーソル。includeShadow = false（既定）なら影の走行の行（payload.enforced = false）を除く（BR-67③、AS 8-26）。
// 検証：fromSeq〜toSeq（省略は全範囲、最大100万件）のハッシュを計算し直し、最初に合わない seq を返す。checkpointMatched は常に null（KMS は Won't）。
// ok = false なら構造化ログ audit.verify_failed（CRITICAL。運営への通知の代わり：SO §3.13）。権限は viewer 以上（全員）

import { verifyAuditChain, type AuditLogRow } from "@open-team/db";
import { listAuditLogs } from "@open-team/db/app";
import { AppError } from "@open-team/platform";
import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import { assertOwnWorkspace, idParam, readJsonBody, readQuery, sessionOf } from "../http.ts";
import type { ApiRouter } from "./router.ts";

/** 検証できる範囲の上限（09_api/auth-workspace.md:152） */
export const AUDIT_VERIFY_MAX = 1_000_000;

/** カーソルは最後に返した seq の base64（09 の例 "MTAyMzI=" と同じ） */
export function encodeAuditCursor(seq: number): string {
  return Buffer.from(String(seq), "utf8").toString("base64");
}
export function decodeAuditCursor(cursor: string): number | null {
  const text = Buffer.from(cursor, "base64").toString("utf8");
  if (!/^[1-9]\d{0,15}$/.test(text) || encodeAuditCursor(Number(text)) !== cursor) return null;
  return Number(text);
}

/** EP-43 のクエリ（AS §2.10） */
export const AuditListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  eventType: z.string().max(500).optional(),
  taskId: z.guid().optional(),
  includeShadow: z.enum(["true", "false"]).default("false"),
});

/** EP-44 の本文 */
export const AuditVerifyBody = z
  .strictObject({ fromSeq: z.number().int().min(1).optional(), toSeq: z.number().int().min(1).optional() })
  .refine((b) => b.fromSeq === undefined || b.toSeq === undefined || b.fromSeq <= b.toSeq, { message: "fromSeq ≤ toSeq", path: ["toSeq"] })
  .refine((b) => b.fromSeq === undefined || b.toSeq === undefined || b.toSeq - b.fromSeq + 1 <= AUDIT_VERIFY_MAX, {
    message: `範囲は ${AUDIT_VERIFY_MAX} 件まで`,
    path: ["toSeq"],
  });

/** AS §2.10 の AuditLogItem */
export function auditLogItem(row: AuditLogRow) {
  return {
    seq: row.seq,
    occurredAt: row.occurred_at.toISOString(),
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    taskId: row.task_id,
    payload: row.payload,
    hash: row.hash.toString("hex"),
    prevHash: row.prev_hash.toString("hex"),
    // 影の走行の書き込みは false（BR-67③）。それ以外は true
    enforced: row.payload.enforced !== false,
  };
}

export function auditRoutes(r: ApiRouter, deps: AppDeps): void {
  // EP-43
  r.get("/workspaces/:workspaceId/audit-logs", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const q = readQuery(c, AuditListQuery);
    assertOwnWorkspace(s, workspaceId);
    const beforeSeq = q.cursor === undefined ? null : decodeAuditCursor(q.cursor);
    if (q.cursor !== undefined && beforeSeq === null) {
      throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "cursor", reason: "カーソルの形が違います" }] });
    }
    const eventTypes = (q.eventType ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "");
    const page = await listAuditLogs(deps.db, s, {
      limit: q.limit,
      beforeSeq,
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
      ...(eventTypes.length > 0 ? { eventTypes } : {}),
      ...(q.taskId ? { taskId: q.taskId.toLowerCase() } : {}),
      includeShadow: q.includeShadow === "true",
    });
    const last = page.rows[page.rows.length - 1];
    return c.json({ items: page.rows.map(auditLogItem), nextCursor: page.hasMore && last ? encodeAuditCursor(last.seq) : null });
  });

  // EP-44
  r.post("/workspaces/:workspaceId/audit-logs/verify", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const body = await readJsonBody(c, AuditVerifyBody);
    assertOwnWorkspace(s, workspaceId);
    const result = await verifyAuditChain(deps.db, s.workspaceId, {
      ...(body.fromSeq !== undefined ? { fromSeq: body.fromSeq } : {}),
      ...(body.toSeq !== undefined ? { toSeq: body.toSeq } : {}),
    });
    if (!result.ok) {
      deps.log.log({
        severity: "CRITICAL",
        event: "audit.verify_failed",
        message: "監査ログのハッシュチェーンが合わない",
        workspaceId: s.workspaceId,
        firstBrokenSeq: result.firstBrokenSeq,
      });
    }
    return c.json({ ok: result.ok, checkedCount: result.checkedCount, firstBrokenSeq: result.firstBrokenSeq, checkpointMatched: null });
  });
}
