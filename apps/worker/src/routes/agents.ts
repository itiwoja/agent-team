// エージェントの一覧（ライブラリ）の API（/api/v1/agents。apps/app/src/routes/agents.ts の WorkspaceDO 版）。入出力の型は views/agents/contract.ts。
// 一覧は読むだけ。ワークスペースはセッションのものだけ（DO をワークスペースの ID で引くので、別のワークスペースの担当は出ない）。
// 書き込みは、文から1体作る（POST /agents。Idempotency-Key を受ける）と削除（DELETE /agents/:agentId）。
// 作業場を最初に戻す・スキルの案を決める・整理で外したものを戻す は第4段で移す

import { createAgentFromText } from "../agents/create.ts";
import { idempotencyOf } from "../idempotency.ts";
import { CreateAgentBodySchema } from "../views/agents/contract.ts";
import type { ApiRouter, ApiDeps } from "./router.ts";
import { idParam, readJsonBody, reply, sessionOf, workspaceOf } from "./router.ts";

export function agentRoutes(r: ApiRouter, deps: ApiDeps): void {
  r.get("/agents", async (c) => {
    const s = sessionOf(c);
    return c.json(await workspaceOf(c, s).agentLibrary());
  });

  // API-080：したいことの文からエージェントを1体作る（201）
  r.post("/agents", async (c) => {
    const s = sessionOf(c);
    const body = await readJsonBody(c, CreateAgentBodySchema);
    const idem = idempotencyOf(c, { text: body.text });
    return reply(c, await createAgentFromText(workspaceOf(c, s), c.env, { userId: s.userId, text: body.text, idem, now: deps.now }));
  });

  // API-081：エージェントを削除する（論理削除。動いていれば 409 AGENT_BUSY）
  r.delete("/agents/:agentId", async (c) => {
    const s = sessionOf(c);
    const agentId = idParam(c, "agentId");
    return reply(c, await workspaceOf(c, s).removeAgent({ userId: s.userId, agentId, now: deps.now() }));
  });
}
