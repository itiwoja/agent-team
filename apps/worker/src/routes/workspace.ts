// EP-27 Kill Switch の発動・EP-28 解除（AS §2.7・§3.9、09_api/policies.md:71-83。apps/app/src/routes/workspace.ts の WorkspaceDO 版）
// 評価の順（AS §3.0）：入力の検証（400）→ パスのワークスペースがセッションのものか（404）→ 処理。
// 使えるのはワークスペースの持ち主だけ（D1 の memberships は owner だけ）なので、役割は見ない

import { z } from "zod";
import { idempotencyOf } from "../idempotency.ts";
import type { ApiDeps, ApiRouter } from "./router.ts";
import { assertOwnWorkspace, idParam, readJsonBody, reply, sessionOf, workspaceOf } from "./router.ts";

/** EP-27（理由は任意・500文字以内） */
export const KillSwitchEngageBody = z.strictObject({ reason: z.string().max(500).optional() });
/** EP-28（理由は必須・1〜500文字） */
export const KillSwitchReleaseBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

export function workspaceRoutes(r: ApiRouter, deps: ApiDeps): void {
  // EP-27（Idempotency-Key を受ける：09_api/common.md:50）
  r.post("/workspaces/:workspaceId/kill-switch", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const body = await readJsonBody(c, KillSwitchEngageBody);
    assertOwnWorkspace(s, workspaceId);
    const reason = body.reason === undefined || body.reason.trim() === "" ? null : body.reason;
    const idem = idempotencyOf(c, { reason });
    return reply(c, await workspaceOf(c, s).engageKillSwitch({ userId: s.userId, reason, idem, now: deps.now() }));
  });

  // EP-28
  r.post("/workspaces/:workspaceId/kill-switch/release", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const body = await readJsonBody(c, KillSwitchReleaseBody);
    assertOwnWorkspace(s, workspaceId);
    return reply(c, await workspaceOf(c, s).releaseKillSwitch({ userId: s.userId, reason: body.reason, now: deps.now() }));
  });
}
