// API-017（承認待ちの Intent の一覧）・API-018（1件）・API-019（決定：approve / reject / remember）
// 評価の順（AS §3.0）：入力の検証（400）→ 存在（404。別のワークスペースのものも）→ 承認者（403）→ Kill Switch（423）→ 決定済み・期限切れ（409）→ intentHash（409）
// 状態を変える API は CSRF とセッションが必須（router の既定）

import { listApprovalBundles, getApprovalBundle } from "@open-team/db/check";
import { z } from "zod";
import { APPROVAL_STATUSES, DecisionBody, type ApprovalListResponse, type DecisionResponse } from "../check/contract.ts";
import { buildApprovalView, newRuleIdFrom } from "../check/approval-view.ts";
import { decideApproval } from "../check/decide.ts";
import type { AppDeps } from "../deps.ts";
import { idParam, readJsonBody, readQuery, sessionOf } from "../http.ts";
import { AppError } from "@open-team/platform";
import { findIdempotencyRecord, saveIdempotencyRecord } from "@open-team/db/app";
import { hashCanonical, type Json } from "@open-team/kernel";
import { IDEMPOTENCY_TTL_MS, idempotencyKeyOf } from "../idempotency.ts";
import { resolveIntent, ResolveBody } from "../check/resolve.ts";
import type { ApiRouter } from "./router.ts";

const ListQuery = z.object({
  status: z.enum(APPROVAL_STATUSES).default("pending"),
  askId: z.guid().optional(),
  taskId: z.guid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function approvalRoutes(r: ApiRouter, deps: AppDeps): void {
  const viewDeps = () => ({ q: deps.db, now: deps.clock.now(), newRuleId: () => newRuleIdFrom(deps.ids.newId()) });

  // API-017（ask_id・task_id で絞れる。承認待ちは期限切れを除く。ワークスペースで必ず絞る）
  r.get("/approvals", async (c) => {
    const s = sessionOf(c);
    const q = readQuery(c, ListQuery);
    const now = deps.clock.now();
    const bundles = await listApprovalBundles(deps.db, s, {
      status: q.status,
      ...(q.askId ? { askId: q.askId.toLowerCase() } : {}),
      ...(q.taskId ? { taskId: q.taskId.toLowerCase() } : {}),
      limit: q.limit,
      ...(q.status === "pending" ? { notExpiredAt: now } : {}),
    });
    const items = [];
    for (const b of bundles) items.push(await buildApprovalView({ ...viewDeps(), ctx: s }, s, b));
    const body: ApprovalListResponse = { items };
    return c.json(body);
  });

  // API-018
  r.get("/approvals/:approvalId", async (c) => {
    const s = sessionOf(c);
    const b = await getApprovalBundle(deps.db, s, idParam(c, "approvalId"));
    if (b === null) throw new AppError("NOT_FOUND");
    return c.json(await buildApprovalView({ ...viewDeps(), ctx: s }, s, b));
  });

  // API-019（Idempotency-Key：同じキー・同じ内容の再送は、記録した応答をそのまま返す。承認は1回しか通らないので、再送の2回目は 409 でなく前の結果になる）
  r.post("/approvals/:approvalId/decision", async (c) => {
    const s = sessionOf(c);
    const approvalId = idParam(c, "approvalId");
    const body = await readJsonBody(c, DecisionBody);
    const key = idempotencyKeyOf(c);
    const requestHash = hashCanonical({ approvalId, body: body as unknown as Json });
    if (key !== null) {
      const prev = await findIdempotencyRecord(deps.db, s, key, new Date(deps.clock.now().getTime() - IDEMPOTENCY_TTL_MS));
      if (prev) {
        if (prev.method !== c.req.method || prev.path !== c.req.path || prev.request_hash !== requestHash) {
          throw new AppError("VALIDATION_ERROR", "同じ Idempotency-Key を違う要求に使えません", { details: [{ field: "Idempotency-Key", reason: "reused_for_different_request" }] });
        }
        return c.json(prev.response_body as unknown as DecisionResponse, prev.response_status as 200);
      }
    }
    const res = await decideApproval(deps, s, approvalId, body);
    if (key !== null) {
      await deps.db.transaction((tx) =>
        saveIdempotencyRecord(tx, s, { key, method: c.req.method, path: c.req.path, requestHash, responseStatus: 200, responseBody: res as unknown as Json }, deps.clock.now()),
      );
    }
    return c.json(res);
  });

  // API-070（結果が分からない書き込みの確定。画面は /outcome の名前で呼ぶので、同じ処理を2つのパスに置く）
  const resolve = async (c: Parameters<Parameters<ApiRouter["post"]>[1]>[0]) => {
    const s = sessionOf(c);
    const intentId = idParam(c, "intentId");
    const body = await readJsonBody(c, ResolveBody);
    return c.json(await resolveIntent(deps, s, intentId, body));
  };
  r.post("/intents/:intentId/resolve", resolve);
  r.post("/intents/:intentId/outcome", resolve);
}
