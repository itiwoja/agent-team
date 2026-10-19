// EP-26 ワークスペース・EP-27 Kill Switch の発動・EP-28 解除（AS §2.7・§3.9、09_api/policies.md:71-83）
// 評価の順（AS §3.0）：入力の検証（400）→ パスのワークスペースがセッションのものか（404）→ 権限（403）→ 処理

import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import { assertOwnWorkspace, idParam, readJsonBody, sessionOf } from "../http.ts";
import { runIdempotent } from "../idempotency.ts";
import { engageKillSwitchInTx, releaseKillSwitch } from "../kill-switch.ts";
import { buildWorkspaceView } from "../workspace-view.ts";
import type { ApiRouter } from "./router.ts";

/** EP-27（理由は任意・500文字以内） */
export const KillSwitchEngageBody = z.strictObject({ reason: z.string().max(500).optional() });
/** EP-28（理由は必須・1〜500文字） */
export const KillSwitchReleaseBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

export function workspaceRoutes(r: ApiRouter, deps: AppDeps): void {
  // EP-26
  r.get("/workspaces/:workspaceId", async (c) => {
    const s = sessionOf(c);
    assertOwnWorkspace(s, idParam(c, "workspaceId"));
    return c.json(await buildWorkspaceView(deps, s));
  });

  // EP-27（Idempotency-Key を受ける：09_api/common.md:50）
  r.post("/workspaces/:workspaceId/kill-switch", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const body = await readJsonBody(c, KillSwitchEngageBody);
    assertOwnWorkspace(s, workspaceId);
    const reason = body.reason === undefined || body.reason.trim() === "" ? null : body.reason;
    return runIdempotent(deps, c, s, { reason }, (tx, now) => engageKillSwitchInTx(tx, deps, s, { reason }, now));
  });

  // EP-28
  r.post("/workspaces/:workspaceId/kill-switch/release", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const body = await readJsonBody(c, KillSwitchReleaseBody);
    assertOwnWorkspace(s, workspaceId);
    return c.json(await releaseKillSwitch(deps, s, { reason: body.reason }));
  });
}
