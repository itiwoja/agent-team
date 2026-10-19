// EP-45 GET /api/v1/workspaces/{workspaceId}/stream（SSE。AS §3.14、ADR-007）
// パスのワークスペースがセッションのものでなければ 404（セッションがなければ 401）。Last-Event-ID（なければクエリ lastEventId）から続ける

import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import { assertOwnWorkspace, idParam, sessionOf } from "../http.ts";
import { parseLastEventId, workspaceStream } from "../sse.ts";
import type { ApiRouter } from "./router.ts";

export function streamRoutes(r: ApiRouter, deps: AppDeps): void {
  r.get("/workspaces/:workspaceId/stream", async (c) => {
    const s = sessionOf(c);
    const workspaceId = idParam(c, "workspaceId");
    const last = parseLastEventId(c.req.header("last-event-id"), c.req.query("lastEventId"));
    if (last === undefined) {
      throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: "Last-Event-ID", reason: "0 以上の整数ではありません" }] });
    }
    assertOwnWorkspace(s, workspaceId);
    return workspaceStream(deps, s, last, c.req.raw.signal);
  });
}
