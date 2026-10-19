// 承認済み・実行前の再判定（M-20、D-46）。Gateway は decide を呼ばないので、app が gateway を呼ぶ前に行う。
// Intent を作ったときの実効ポリシー（policy_hash）が、そのエージェントの今の実効ポリシーと違うときだけ、Kernel の recheckIntent（手順4〜11）で判定し直す：
//   deny（halt・handoff も安全側で同じ）→ Intent を expired（policy_changed）にして実行しない
//   approve・allow → 実行（人がすでに承認している。締める変更で承認が無駄にならない）
// 読み取りだけで判定し、外部を呼ばない。expired にする書き込みだけ自分のトランザクション（G-14）

import { appendAuditLog, execContextOf, lockWorkspace, type WsCtx, type Uuid } from "@open-team/db";
import { getAgentCurrentSnapshot } from "@open-team/db/check";
import { getAgentJobRow, getTask, listUnknownOutcomeKeys } from "@open-team/db/edge";
import { completeIntent, getIntent, lockIntent, lockTask, recomputeTaskStatus } from "@open-team/db/gateway";
import { isCertificateValid, resolveMcpSubject } from "@open-team/edge";
import { recheckIntent } from "@open-team/kernel";
import type { AppDeps } from "../deps.ts";
import { splitAction } from "./reasons.ts";

export type RecheckResult = { ok: true; rechecked: boolean } | { ok: false; reasonCode: string };

type Deps = Pick<AppDeps, "db" | "clock" | "env" | "log">;

/** 判定し直す。実行してよければ ok: true。deny なら Intent を expired（policy_changed）にして ok: false */
export async function recheckBeforeExecute(deps: Deps, ctx: WsCtx, intentId: Uuid): Promise<RecheckResult> {
  const q = deps.db;
  const intent = await getIntent(q, ctx, intentId);
  if (intent === null || intent.status !== "approved") return { ok: true, rechecked: false };
  const task = await getTask(q, ctx, intent.task_id);
  const job = task === null ? null : await getAgentJobRow(q, ctx, task.job_id);
  if (task === null || job === null) return expire(deps, ctx, intent.id, task?.id ?? intent.task_id, "task_missing");
  // 影・リハーサルの Intent は承認の対象でない（edge の経路が実行する）
  if (task.shadow || task.rehearsal_run_id !== null) return { ok: true, rechecked: false };
  const snap = await getAgentCurrentSnapshot(q, ctx, task.agent_id);
  const current = snap?.status === "valid" ? snap.effective_policies?.[job.slug] : undefined;
  if (current === undefined) return expire(deps, ctx, intent.id, task.id, "policy_missing");
  if (current.hash === intent.policy_hash) return { ok: true, rechecked: false };

  const action = splitAction(intent.action);
  if (action === null) return expire(deps, ctx, intent.id, task.id, "unknown_action");
  const { subject, mcp } = await resolveMcpSubject(q, ctx, { connector: action.slug, tool: action.tool, arguments: intent.payload.arguments });
  if (mcp === null) return expire(deps, ctx, intent.id, task.id, "unknown_action");
  const unknownOutcomeKeys = await listUnknownOutcomeKeys(q, ctx, task.job_id, execContextOf(task));
  const certificateValid = await isCertificateValid(q, ctx, job.id, current.policy, deps.env.gemini.agentModel);
  const r = recheckIntent(current.policy, subject, { unknownOutcomeKeys, certificateValid });
  if (r.decision === "approve" || r.decision === "allow") return { ok: true, rechecked: true };
  return expire(deps, ctx, intent.id, task.id, r.reasonCode);
}

async function expire(deps: Deps, ctx: WsCtx, intentId: Uuid, taskId: Uuid, reasonCode: string): Promise<RecheckResult> {
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    await lockWorkspace(tx, ctx);
    await lockTask(tx, ctx, taskId);
    const intent = await lockIntent(tx, ctx, intentId);
    if (intent === null || intent.status !== "approved") return;
    const ok = await completeIntent(tx, ctx, intentId, ["approved"], { status: "expired", expireReason: "policy_changed", result: null }, now);
    if (!ok) return;
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      { eventType: "intent.expired", actorType: "system", actorId: "app", taskId, payload: { taskId, intentId, expireReason: "policy_changed", reasonCode } },
      now,
    );
    await recomputeTaskStatus(tx, ctx, taskId, now);
  });
  deps.log.info("approval.recheck_denied", "承認済みの Intent を、ポリシーの変更で実行しなかった", { workspaceId: ctx.workspaceId, intentId, reasonCode });
  return { ok: false, reasonCode };
}
