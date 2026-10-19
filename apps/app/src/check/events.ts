// SCR-019 の SSE の事象（workspace_events。業務の変更と同じトランザクションで書き、コミットで NOTIFY が届く：ADR-007）
// 事象の形は contract.ts の CHECK_EVENT_TYPES。取りこぼしても GET /check で取り直せば同じ状態になる

import type { Tx, WsCtx } from "@open-team/db";
import { appendWorkspaceEvent } from "@open-team/db/app";
import type { Json } from "@open-team/kernel";
import type { AppDeps } from "../deps.ts";
import { CHECK_EVENT_TYPES, type CheckCounts, type CheckItem } from "./contract.ts";
import { buildCheck, buildOneItem, type ItemDeps, type Viewer } from "./items.ts";

export async function publishCheckRemove(tx: Tx, ctx: WsCtx, key: string, now: Date): Promise<void> {
  await appendWorkspaceEvent(tx, ctx, { type: CHECK_EVENT_TYPES.remove, data: { key } }, now);
}

export async function publishCheckUpsert(tx: Tx, ctx: WsCtx, item: CheckItem, now: Date): Promise<void> {
  await appendWorkspaceEvent(tx, ctx, { type: CHECK_EVENT_TYPES.upsert, data: { item } as unknown as Json }, now);
}

/** 今の件数を事象にする（行の増減のあと。ctx は人の操作のとき SessionCtx、それ以外は承認者でないので件数だけ作れる形にする） */
export async function publishCheckCounts(tx: Tx, deps: Pick<AppDeps, "clock" | "ids">, s: Viewer, now: Date): Promise<CheckCounts> {
  const { counts } = await buildCheck({ db: tx, clock: deps.clock, ids: deps.ids } satisfies ItemDeps, s);
  await appendWorkspaceEvent(tx, s, { type: CHECK_EVENT_TYPES.counts, data: counts as unknown as Json }, now);
  return counts;
}

export { buildOneItem };
