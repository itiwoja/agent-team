// エージェントの一覧（ライブラリ）の API（/api/v1/agents。API-041 の v0.5 版、SCR-014）。入出力の型は agents/contract.ts（フロントはそれに合わせる）。
// 一覧は読むだけ。ワークスペースはセッションのものだけ（別のワークスペースの担当は出ない）。権限は viewer 以上（全員）。
// 作業場を最初に戻す（POST /agents/{agentId}/workspace/reset。SG-07）は owner・maintainer（パックを入れられる役割と同じ）

import type { AppDeps } from "../deps.ts";
import { buildAgentLibrary } from "../agents/view.ts";
import { resetAgentWorkspace } from "../agents/workspace-reset.ts";
import { idParam, requireRole, sessionOf } from "../http.ts";
import type { ApiRouter } from "./router.ts";

const WORKSPACE_RESETTERS = ["owner", "maintainer"] as const;

export function agentRoutes(r: ApiRouter, deps: AppDeps): void {
  r.get("/agents", async (c) => {
    const s = sessionOf(c);
    return c.json(await buildAgentLibrary(deps.db, s));
  });

  r.post("/agents/:agentId/workspace/reset", async (c) => {
    const s = sessionOf(c);
    requireRole(s, WORKSPACE_RESETTERS);
    return c.json(await resetAgentWorkspace(deps, s, idParam(c, "agentId")));
  });
}
