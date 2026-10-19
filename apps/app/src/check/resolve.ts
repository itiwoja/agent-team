// API-070：POST /api/v1/intents/{intentId}/resolve（結果が分からない書き込みの確定。ADR-031・BR-59）
// 「届いていた」（executed）「届いていない」（failed）の2つだけ。[もう一度実行]（retry）は、同じ引数の新しい Intent と二重のおそれの確認が要るので、
// この段階は 422 RULE_NOT_ALLOWED（reason: retry_not_supported）で断る。自動では送り直さない。
// 1つのトランザクションで、Intent の状態・タスクの状態の決め直し・監査ログ intent.resolved・SSE（行を消す）。権限は承認者（owner・maintainer）

import { appendAuditLog, lockWorkspace, type SessionCtx, type Uuid } from "@open-team/db";
import { lockTask as lockEdgeTask } from "@open-team/db/edge";
import { getIntent, recomputeTaskStatus } from "@open-team/db/gateway";
import { resolveUnknownOutcome } from "@open-team/db/check";
import { AppError } from "@open-team/platform";
import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import { publishCheckCounts, publishCheckRemove } from "./events.ts";

export const ResolveBody = z.strictObject({ outcome: z.enum(["executed", "failed", "retry"]) });
export type ResolveBody = z.infer<typeof ResolveBody>;

export async function resolveIntent(deps: Pick<AppDeps, "db" | "clock" | "ids" | "hooks">, s: SessionCtx, intentId: Uuid, body: ResolveBody): Promise<{ intentId: Uuid; status: "executed" | "failed" }> {
  if (s.role !== "owner" && s.role !== "maintainer") throw new AppError("FORBIDDEN");
  if (body.outcome === "retry") throw new AppError("RULE_NOT_ALLOWED", "もう一度実行は、この段階では使えません", { details: { reason: "retry_not_supported" } });
  const now = deps.clock.now();
  const outcome = body.outcome;
  return deps.db.transaction(
    async (tx) => {
      const ws = await lockWorkspace(tx, s);
      if (ws === null) throw new AppError("NOT_FOUND");
      const found = await getIntent(tx, s, intentId);
      if (found === null) throw new AppError("NOT_FOUND");
      const task = await lockEdgeTask(tx, s, found.task_id);
      if (task === null) throw new AppError("NOT_FOUND");
      if (!resolveFor(found.status, found.resolution)) throw new AppError("INTENT_NOT_UNKNOWN");
      if (!(await resolveUnknownOutcome(tx, s, intentId, outcome, now))) throw new AppError("INTENT_NOT_UNKNOWN");
      await appendAuditLog(
        tx,
        s.workspaceId,
        { eventType: "intent.resolved", actorType: "user", actorId: s.userId, taskId: task.id, payload: { taskId: task.id, intentId, outcome } },
        now,
      );
      const change = await recomputeTaskStatus(tx, s, task.id, now);
      if (change?.terminal) for (const hook of deps.hooks.taskSettled ?? []) await hook(tx, s, { taskId: task.id, status: change.to, now });
      await publishCheckRemove(tx, s, `unknown_outcome:${intentId}`, now);
      await publishCheckCounts(tx, deps, s, now);
      return { intentId, status: outcome };
    },
    { retryOnce: true },
  );
}

const resolveFor = (status: string, resolution: string | null): boolean => status === "unknown_outcome" && resolution === null;
