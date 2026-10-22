// エージェントの一覧（ライブラリ）の API（/api/v1/agents。apps/app/src/routes/agents.ts の読む部分の WorkspaceDO 版）。入出力の型は views/agents/contract.ts。
// 一覧は読むだけ。ワークスペースはセッションのものだけ（DO をワークスペースの ID で引くので、別のワークスペースの担当は出ない）。
// 書き込み（作業場を最初に戻す・スキルの案を決める・整理で外したものを戻す）は第4段で移す

import type { ApiRouter } from "./router.ts";
import { sessionOf, workspaceOf } from "./router.ts";

export function agentRoutes(r: ApiRouter): void {
  r.get("/agents", async (c) => {
    const s = sessionOf(c);
    return c.json(await workspaceOf(c, s).agentLibrary());
  });
}
