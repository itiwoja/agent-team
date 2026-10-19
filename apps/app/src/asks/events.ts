// 依頼の SSE の事象（ask.*）。workspace_events に書く（appendWorkspaceEvent。業務の変更と同じトランザクション：events.ts・sse.ts の仕組みに載せる）。
// data は contract.ts の AskEventData（type を含む）。コミットで NOTIFY され、各インスタンスの SSE の接続が DB から読んで流す

import type { Tx, WsCtx } from "@open-team/db";
import { appendWorkspaceEvent } from "@open-team/db/app";
import type { Json } from "@open-team/kernel";
import type { AskEventData } from "./contract.ts";

export async function emitAskEvent(tx: Tx, ctx: WsCtx, data: AskEventData, now: Date): Promise<void> {
  await appendWorkspaceEvent(tx, ctx, { type: data.type, data: data as unknown as Json }, now);
}
