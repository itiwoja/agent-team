// ゲストの [最初からやり直す]（POST /api/v1/guest/restart。15_hackathon.md:365）
// 順序：1. 先に新しいゲストを作る（上限に当たったら 429 のまま古いワークスペースは残す）
//       2. 作れたら、古いワークスペースを Kill Switch（理由 restart）と削除予約で1トランザクションにまとめて閉じる
//       3. 新しいセッションの Cookie を出す（古いセッションは削除予約が全部失効させる）
// 古いセッションは 1 の時点では失効させない（失敗したとき、利用者を古い画面に残すため）

import { requestWorkspaceDeletion, system } from "@open-team/db";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import { enterAsNewGuest } from "../guest-seed.ts";
import { clientIp, sessionOf, setSessionCookie } from "../http.ts";
import { engageKillSwitchInTx } from "../kill-switch.ts";
import type { ApiRouter } from "./router.ts";
import { preparedEntrance } from "./session.ts";

export interface GuestRestartResponse {
  next: string;
  firstAskId: string;
}

export function guestRoutes(r: ApiRouter, deps: AppDeps): void {
  r.post("/guest/restart", async (c) => {
    const s = sessionOf(c);
    if (s.kind !== "guest") throw new AppError("FORBIDDEN", "ゲストだけが最初からやり直せます");
    const ip = clientIp(c);
    const ipHash = deps.env.cookieSecret ? system.hashIp(ip, deps.env.cookieSecret) : null;

    const created = await enterAsNewGuest(deps, { ipHash, userAgent: c.req.header("user-agent") ?? null, existing: null });
    if (created.kind === "guest_limit") {
      deps.log.info("guest.restart_limit", "やり直しの作成が上限に当たった。古いワークスペースは残す", { workspaceId: s.workspaceId, scope: created.scope });
      throw new AppError("GUEST_LIMIT_REACHED", undefined, { details: { scope: created.scope } });
    }

    const now = deps.clock.now();
    const afterCommits: Array<() => void> = [];
    await deps.db.transaction(async (tx) => {
      const ks = await engageKillSwitchInTx(tx, deps, s, { reason: "restart" }, now);
      if (ks.afterCommit) afterCommits.push(ks.afterCommit);
      await requestWorkspaceDeletion(tx, s, now);
    });
    for (const f of afterCommits) f();

    setSessionCookie(c, deps, created.session.cookieValue);
    c.set("session", null);
    deps.log.info("guest.restart", "ゲストが最初からやり直した", { from: s.workspaceId, to: created.workspaceId });
    // 入口（SCR-020）へ。用意した依頼は入口の知らせから開く（D-118）
    const body: GuestRestartResponse = { next: preparedEntrance(created.firstAskId), firstAskId: created.firstAskId };
    return c.json(body);
  });
}
