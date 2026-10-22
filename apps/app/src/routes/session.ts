// EP-01 入口・EP-02 セッション・EP-03 /me・EP-04 ログアウト（AS §2.3・§3.1・§3.2、SO §3.4・§3.6・§3.8）
// CSRF トークンは EP-02 と EP-03 の両方で返す（M-57：入口の直後に /session だけで画面が組める）

import { revokeSession, system } from "@open-team/db";
import { getMemberUser } from "@open-team/db/app";
import { AppError } from "@open-team/platform";
import { z } from "zod";
import type { AppDeps } from "../deps.ts";
import type { EntryResponse, SessionSignedIn } from "../check/contract.ts";
import { enter, enterAsOwner } from "../entry.ts";
import { clearSessionCookie, clientIp, isLoopbackRequest, readJsonBody, sessionOf, setSessionCookie } from "../http.ts";
import { buildWorkspaceView } from "../workspace-view.ts";
import { deleteCookie } from "hono/cookie";
import { GCAL_STATE_COOKIE, GCAL_STATE_COOKIE_PATH } from "../connectors/google.ts";
import { GITHUB_STATE_COOKIE, GITHUB_STATE_COOKIE_PATH } from "../connectors/github.ts";
import type { ApiRouter } from "./router.ts";

/** EP-01 の本文（トークンは本文だけ。512 は既存の上限。知らないキーは 400：BR-67①） */
export const EntryBody = z.strictObject({ token: z.string().min(1).max(512) });
/** ローカルのトークンなしの入口の本文（空のオブジェクトだけ） */
export const LocalEntryBody = z.strictObject({});

/** 入口（SCR-020）に、用意した依頼の知らせを出させる URL（入口は読んだら `/` に戻す） */
export function sessionRoutes(r: ApiRouter, deps: AppDeps): void {
  // EP-01（セッションも CSRF もまだない：T-22）
  r.post(
    "/entry",
    async (c) => {
      const body = await readJsonBody(c, EntryBody);
      const result = await enter(deps, {
        token: body.token,
        ip: clientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
        existing: c.get("session"),
      });
      if (result.kind === "wrong_token") throw new AppError("UNAUTHORIZED", "入口のトークンが違います");
      setSessionCookie(c, deps, result.session.cookieValue);
      c.set("session", null);
      const res: EntryResponse = { state: "signed_in", workspaceKind: "owner", next: "/" };
      return c.json(res);
    },
    { auth: "none" },
  );

  // トークンなしでオーナーとして入る（ローカル実行）。
  // このマシンの中からの要求だけ通す（--host 0.0.0.0 で LAN に出ても入れない）
  r.post(
    "/entry/local",
    async (c) => {
      if (!isLoopbackRequest(c)) throw new AppError("FORBIDDEN", "トークンなしで入れるのはこのマシンからだけです");
      await readJsonBody(c, LocalEntryBody);
      const ip = clientIp(c);
      const result = await enterAsOwner(deps, {
        ipHash: deps.env.cookieSecret ? system.hashIp(ip, deps.env.cookieSecret) : null,
        userAgent: c.req.header("user-agent") ?? null,
        existing: c.get("session"),
        now: deps.clock.now(),
        via: "local",
      });
      setSessionCookie(c, deps, result.session.cookieValue);
      c.set("session", null);
      const res: EntryResponse = { state: "signed_in", workspaceKind: "owner", next: "/" };
      return c.json(res);
    },
    { auth: "none" },
  );

  // EP-02（準備中は http.ts の setupGuard が { state: "setup_required", missing } を返す）
  r.get(
    "/session",
    async (c) => {
      const s = c.get("session");
      // 入口の画面がトークンなしで入れる（POST /entry/local）
      if (!s) return c.json({ state: "signed_out", localEntry: true });
      const body: SessionSignedIn = { state: "signed_in", workspaceKind: s.kind, csrfToken: s.csrfToken };
      return c.json(body);
    },
    { auth: "optional" },
  );

  // EP-03（API-004 を 0-H 向けに広げたもの）
  r.get("/me", async (c) => {
    const s = sessionOf(c);
    const user = await getMemberUser(deps.db, s, s.userId);
    if (!user) throw new AppError("UNAUTHORIZED");
    const workspace = await buildWorkspaceView(deps, s);
    return c.json({ user: { id: user.id, login: user.login, name: user.name }, csrfToken: s.csrfToken, workspace });
  });

  // EP-04（09 の 204）
  r.post("/logout", async (c) => {
    const s = sessionOf(c);
    const now = deps.clock.now();
    await revokeSession(deps.db, s, now);
    clearSessionCookie(c, deps);
    deleteCookie(c, GCAL_STATE_COOKIE, { path: GCAL_STATE_COOKIE_PATH, httpOnly: true, secure: deps.env.cookieSecure, sameSite: "Lax" });
    deleteCookie(c, GITHUB_STATE_COOKIE, { path: GITHUB_STATE_COOKIE_PATH, httpOnly: true, secure: deps.env.cookieSecure, sameSite: "Lax" });
    c.set("session", null);
    deps.log.info("session.logout", "ログアウトした", { workspaceId: s.workspaceId });
    return c.body(null, 204);
  });
}
