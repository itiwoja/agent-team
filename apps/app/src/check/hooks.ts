// 本番の edge のコミットのあとの処理（EdgeHooks）。本番のタスクを動かす側（依頼の実行：asks/run.ts の liveEdge）が createEdge の hooks に渡す
// - onIntentRecorded（LLM Proxy が Intent を保存したコミットのあと）：
//   1. approved（ルールの allow）→ 再判定のあと gateway の実行を起こす（承認の API と同じ経路）
//   2. pending_approval → SCR-019 に「送る前の確認」の行を足す（SSE の check.upsert・check.counts）
// - onTaskTerminal：依頼に属さない仕事の終了を、報告の行として足す（SSE）
// 外部（gateway）はトランザクションの外で呼ぶ（G-14）。失敗はログだけ（edge の runHook も握る）

import type { Db, Uuid, WsCtx } from "@open-team/db";
import { listMembershipRoles } from "@open-team/db/edge";
import type { EdgeHooks } from "@open-team/edge";
import type { AppDeps } from "../deps.ts";
import { publishCheckCounts, publishCheckUpsert } from "./events.ts";
import { buildOneItem, type Viewer } from "./items.ts";
import { recheckBeforeExecute } from "./recheck.ts";

type HookDeps = Pick<AppDeps, "db" | "clock" | "ids" | "log" | "gatewayClient" | "registry" | "env">;

/** SSE の行を作る相手（owner の利用者。0-H は1ワークスペース1人：approver の判定に使うだけ） */
async function ownerViewerOf(db: Db, ctx: WsCtx): Promise<Viewer | null> {
  const owner = (await listMembershipRoles(db, ctx)).find((m) => m.role === "owner");
  return owner === undefined ? null : { workspaceId: ctx.workspaceId, kind: ctx.kind, userId: owner.user_id, role: "owner" };
}

async function publishRow(deps: HookDeps, ctx: WsCtx, key: string): Promise<void> {
  const viewer = await ownerViewerOf(deps.db, ctx);
  if (viewer === null) return;
  const now = deps.clock.now();
  await deps.db.transaction(async (tx) => {
    const item = await buildOneItem({ db: tx, clock: deps.clock, ids: deps.ids }, viewer, key);
    if (item !== null) await publishCheckUpsert(tx, ctx, item, now);
    await publishCheckCounts(tx, deps, viewer, now);
  });
}

export function productionEdgeHooks(deps: HookDeps): NonNullable<EdgeHooks> {
  return {
    async onIntentRecorded(ctx, e) {
      if (e.status === "approved") {
        // 1：承認なしで通る Intent（ルールの allow）。再判定のあと実行
        const r = await recheckBeforeExecute(deps, ctx, e.intentId);
        if (r.ok) await deps.gatewayClient.executeIntent(e.intentId, { signal: deps.registry.get(e.taskId)?.controller.signal });
        return;
      }
      if (e.status === "pending_approval") {
        // 2：送る前の確認の行（承認の行の ID は Intent から引く）
        const row = await deps.db.query<{ id: Uuid }>("SELECT id FROM approvals WHERE workspace_id = $1 AND intent_id = $2", [ctx.workspaceId, e.intentId]);
        const id = row.rows[0]?.id;
        if (id !== undefined) await publishRow(deps, ctx, `approval:${id}`);
      }
    },
    async onTaskTerminal(ctx, e) {
      await publishRow(deps, ctx, `task:${e.taskId}`);
    },
  };
}
