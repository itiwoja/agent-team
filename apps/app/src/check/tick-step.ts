// 毎分の tick の手順：承認の期限切れ（pending → expired）と、承認されたのに実行が始まっていない Intent の拾い直し（G-02）
// - 期限切れ：approvals.expires_at ≤ now の pending を expired（Intent は approval_timeout。依頼の次の実行で切れたものは superseded）にし、
//   タスクの状態を決め直して、SCR-019 の行を消す。監査ログ approval.expired
// - 拾い直し：approved のまま30秒たった本番の Intent を、再判定のあと gateway で実行する（承認の API のコミットのあと・allow のあとに落ちたもの）。
//   実行は gateway が approved のときだけ送る（二重に送らない：G-3）。1回に20件まで
// ワークスペースの行を最初にロックする（M-21）。外部の呼び出しはトランザクションの外（G-14）

import { appendAuditLog, lockWorkspace, wsCtxOf } from "@open-team/db";
import { expireDueApprovals, listStalledApprovedIntents, listWorkspacesWithDueApprovals } from "@open-team/db/check";
import { recomputeTaskStatus } from "@open-team/db/gateway";
import { GatewayClientError } from "@open-team/gateway-client";
import type { TickStep } from "../deps.ts";
import { publishCheckRemove } from "./events.ts";
import { recheckBeforeExecute } from "./recheck.ts";

export const STALLED_AFTER_MS = 30_000;
const BATCH = 20;

export const approvalsTickStep: TickStep = {
  name: "approvals",
  async run(deps, now) {
    let expired = 0;
    for (const w of await listWorkspacesWithDueApprovals(deps.db, now, BATCH)) {
      const ctx = wsCtxOf({ id: w.workspaceId, kind: w.workspaceKind });
      expired += await deps.db.transaction(async (tx) => {
        await lockWorkspace(tx, ctx);
        const rows = await expireDueApprovals(tx, ctx, now);
        for (const r of rows) {
          await appendAuditLog(tx, ctx.workspaceId, { eventType: "approval.expired", actorType: "system", actorId: "app", taskId: r.taskId, payload: { approvalId: r.approvalId, intentId: r.intentId } }, now);
          await recomputeTaskStatus(tx, ctx, r.taskId, now);
          await publishCheckRemove(tx, ctx, `approval:${r.approvalId}`, now);
        }
        return rows.length;
      });
    }

    let dispatched = 0;
    for (const s of await listStalledApprovedIntents(deps.db, new Date(now.getTime() - STALLED_AFTER_MS), BATCH)) {
      const ctx = wsCtxOf({ id: s.workspaceId, kind: s.workspaceKind });
      try {
        const r = await recheckBeforeExecute(deps, ctx, s.intentId);
        if (!r.ok) continue;
        await deps.gatewayClient.executeIntent(s.intentId);
        dispatched++;
      } catch (error) {
        deps.log.warn("tick.dispatch_failed", "承認済みの Intent を拾い直せなかった", {
          workspaceId: s.workspaceId,
          intentId: s.intentId,
          error: error instanceof GatewayClientError ? `${error.status} ${error.code}` : error,
        });
      }
    }
    return { expiredApprovals: expired, dispatched };
  },
};
