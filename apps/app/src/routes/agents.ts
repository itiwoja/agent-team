// エージェントの一覧（ライブラリ）の API（/api/v1/agents。API-041 の v0.5 版、SCR-014）。入出力の型は agents/contract.ts（フロントはそれに合わせる）。
// 一覧は読むだけ。ワークスペースはセッションのものだけ（別のワークスペースの担当は出ない）。権限は viewer 以上（全員）。
// 作業場を最初に戻す（POST /agents/{agentId}/workspace/reset。SG-07）は owner・maintainer（パックを入れられる役割と同じ）

import type { AppDeps } from "../deps.ts";
import { decideSkillProposalAction, restoreEvolutionItemAction } from "../evolution/actions.ts";
import { DecideSkillProposalBodySchema, RestoreEvolutionBodySchema, type DecideSkillProposalResponse, type RestoreEvolutionResponse } from "../agents/contract.ts";
import { buildAgentLibrary } from "../agents/view.ts";
import { resetAgentWorkspace } from "../agents/workspace-reset.ts";
import { idParam, readJsonBody, requireRole, sessionOf } from "../http.ts";
import type { ApiRouter } from "./router.ts";

const WORKSPACE_RESETTERS = ["owner", "maintainer"] as const;

export function agentRoutes(r: ApiRouter, deps: AppDeps): void {
  r.get("/agents", async (c) => {
    const s = sessionOf(c);
    return c.json(await buildAgentLibrary(deps.db, s, deps.clock.now()));
  });

  r.post("/agents/:agentId/workspace/reset", async (c) => {
    const s = sessionOf(c);
    requireRole(s, WORKSPACE_RESETTERS);
    return c.json(await resetAgentWorkspace(deps, s, idParam(c, "agentId")));
  });

  // スキルの案を決める（owner・maintainer）。二重の決定・別の担当の案は actions が弾く
  r.post("/agents/:agentId/skill-proposals/:proposalId/decide", async (c) => {
    const s = sessionOf(c);
    requireRole(s, WORKSPACE_RESETTERS);
    const agentId = idParam(c, "agentId");
    const proposalId = idParam(c, "proposalId");
    const body = await readJsonBody(c, DecideSkillProposalBodySchema);
    const res: DecideSkillProposalResponse = await decideSkillProposalAction(deps, s, agentId, proposalId, body.decision);
    return c.json(res);
  });

  // 整理で外したスキル・ルール1件を戻す（owner・maintainer）
  r.post("/agents/:agentId/evolution/:eventId/restore", async (c) => {
    const s = sessionOf(c);
    requireRole(s, WORKSPACE_RESETTERS);
    const agentId = idParam(c, "agentId");
    const eventId = idParam(c, "eventId");
    const body = await readJsonBody(c, RestoreEvolutionBodySchema);
    const res: RestoreEvolutionResponse = await restoreEvolutionItemAction(deps, s, agentId, eventId, { type: body.type, id: body.id });
    return c.json(res);
  });
}
