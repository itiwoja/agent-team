// 自分の言葉で悪い日を足す（FR-065・D-75・BR-78。パスは rehearsal.ts と同じ流儀）。作れるのは状況だけ
// - POST   /workspaces/{workspaceId}/rehearsals/{runId}/user-cases          ：入力を解釈し、解釈の1行を返して1件だけ走らせる（202）
// - DELETE /workspaces/{workspaceId}/rehearsals/{runId}/user-cases/{inputId}：走っている1件をやめる（[やめる]）。試験は残る
// 評価の順（AS §3.0）：入力の検証（400）→ パスのワークスペースがセッションのものか（404）→ 権限（403）→ 処理。
// エラー：1日5件を超えたら 429 USER_CASE_DAILY_LIMIT、カタログにない 422 NOT_IN_CATALOG、動いている走行がある 409、Kill Switch 中 423

import { getRehearsalRun } from "@open-team/db/rehearsal";
import { AppError } from "@open-team/platform";
import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import { assertOwnWorkspace, idParam, readJsonBody, requireRole, sessionOf } from "../http.ts";
import { cancelUserCase, startUserCase, userCaseView } from "../rehearsal/user-case.ts";
import { isScripted, rehearsalRunView } from "./rehearsal.ts";
import type { ApiRouter } from "./router.ts";

export const UserCaseBody = z.strictObject({
  /** 試したい悪い日（1〜500 文字。前後の空白は除く） */
  text: z.string().trim().min(1).max(500),
});

/** 試験を走らせてよい役割：owner・maintainer（rehearsal.ts の RUNNERS と同じ） */
const RUNNERS = ["owner", "maintainer"] as const;

/** POST /workspaces/{workspaceId}/rehearsals/{runId}/user-cases */
export function registerStartUserCase(r: ApiRouter, deps: AppDeps): void {
  r.post("/workspaces/:workspaceId/rehearsals/:runId/user-cases", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const runId = idParam(c, "runId");
    const body = await readJsonBody(c, UserCaseBody);
    assertOwnWorkspace(s, workspaceId);
    requireRole(s, RUNNERS);
    const parent = await getRehearsalRun(deps.db, s, runId);
    if (parent === null) throw new AppError("NOT_FOUND");
    const started = await startUserCase(deps, s, { parent, text: body.text });
    return c.json({ userCase: { ...userCaseView(started.input), faultIds: started.faultIds }, run: rehearsalRunView(started.run, await isScripted(deps, s, started.run)) }, 202);
  });
}

/** DELETE /workspaces/{workspaceId}/rehearsals/{runId}/user-cases/{inputId} */
export function registerCancelUserCase(r: ApiRouter, deps: AppDeps): void {
  r.delete("/workspaces/:workspaceId/rehearsals/:runId/user-cases/:inputId", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const runId = idParam(c, "runId");
    const inputId = idParam(c, "inputId");
    assertOwnWorkspace(s, workspaceId);
    requireRole(s, RUNNERS);
    const parent = await getRehearsalRun(deps.db, s, runId);
    if (parent === null) throw new AppError("NOT_FOUND");
    const row = await cancelUserCase(deps, s, parent, inputId);
    return c.json({ userCase: userCaseView(row) });
  });
}

export function userCaseRoutes(r: ApiRouter, deps: AppDeps): void {
  registerStartUserCase(r, deps);
  registerCancelUserCase(r, deps);
}
