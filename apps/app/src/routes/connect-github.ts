// GitHub の接続（18 §3.6、D-119）。セッション必須
//   GET    /api/v1/connect/github/start?mode=install|authorize  state を Cookie に置いて GitHub App のインストール（既定）か認可の画面へ
//   GET    /api/v1/connect/github/callback                       state を照合 → code を交換 → 本人とインストールを確かめる → 1トランザクション → 同期・分類
//   DELETE /api/v1/connect/github                                切断（DB だけ。アンインストールは利用者が GitHub の画面で行う）
//   PUT    /api/v1/connect/github/protected-write                保護したブランチ（既定のブランチ・main・master）への書き込みの許可を切り替える
// 失敗は画面に戻す（/?connect_error=github_…）。トークン・code・state は応答にもログにも出さない

import { randomBytes } from "node:crypto";
import { appendAuditLog, getGithubConnection, insertGithubCredential, lockWorkspace, revokeCredential, revokeCredentialIfActive, setGithubProtectedWrite, upsertOAuthConnector, type ConnectorRow, type SessionCtx, type Tx } from "@open-team/db";
import { GITHUB_CONNECTOR, GITHUB_DISPLAY_NAME, GITHUB_MCP_PATH, GITHUB_SLUG } from "@open-team/github-core";
import { AppError } from "@open-team/platform";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { classifyConnectorTools } from "../connectors/classify.ts";
import {
  buildGithubAuthorizeUrl,
  buildGithubInstallUrl,
  chooseInstallation,
  exchangeGithubCode,
  GITHUB_STATE_COOKIE,
  GITHUB_STATE_COOKIE_PATH,
  GITHUB_STATE_MAX_AGE_SEC,
  GithubConnectError,
  githubUser,
  revokeGithubUserToken,
  userInstallations,
} from "../connectors/github.ts";
import { setConnectorEnabledInPolicy } from "../connectors/policy.ts";
import type { GithubConnectEnv } from "../env.ts";
import type { AppDeps } from "../deps.ts";
import type { AppHonoEnv } from "../context.ts";
import { readJsonBody, sessionOf } from "../http.ts";
import { CONNECT_ACTOR, stateBinding, stateMatches } from "./connect.ts";
import type { ApiRouter } from "./router.ts";

type GithubConnectOutcome = "github_denied" | "github_not_installed" | "github_failed" | "github_state" | "github_unavailable";

const ProtectedWriteBody = z.strictObject({ allow: z.boolean() });

function stateCookieOptions(deps: Pick<AppDeps, "env">) {
  return { httpOnly: true, secure: deps.env.cookieSecure, sameSite: "Lax" as const, path: GITHUB_STATE_COOKIE_PATH };
}

function parseStateCookie(raw: string | undefined): { state: string; binding: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(":");
  if (i <= 0 || i === raw.length - 1) return null;
  return { state: raw.slice(0, i), binding: raw.slice(i + 1) };
}

function backTo(c: Context<AppHonoEnv>, outcome: GithubConnectOutcome | null): Response {
  return c.redirect(outcome === null ? "/?connected=github" : `/?connect_error=${outcome}`, 302);
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

/**
 * 戻りの処理（トークンの交換から保存まで）。利用者のトークンは確かめたら必ず取り消す（成功・失敗とも）。
 * DB に入ったあと（同期・分類）の失敗は、入れたものを切って（資格情報・ポリシー）から投げ直す
 */
async function completeGithubConnect(deps: AppDeps, s: SessionCtx, env: GithubConnectEnv, code: string, requestedInstallation: string | undefined): Promise<string> {
  const fetchFn = deps.githubFetch;
  const userToken = await exchangeGithubCode(fetchFn, env, code);
  let committed: { connector: ConnectorRow; credentialId: string } | null = null;
  try {
    const user = await githubUser(fetchFn, env, userToken);
    const installation = chooseInstallation(await userInstallations(fetchFn, env, userToken), requestedInstallation, user);
    const now = deps.clock.now();
    committed = await deps.db.transaction(async (tx: Tx) => {
      await lockWorkspace(tx, s);
      const connector = await upsertOAuthConnector(tx, s, { slug: GITHUB_SLUG, displayName: GITHUB_DISPLAY_NAME, url: `${env.githubUrl}${GITHUB_MCP_PATH}`, now, provider: "github" });
      const credentialId = await insertGithubCredential(tx, s, { connectorId: connector.id, subject: user.id, accountLogin: user.login, installationId: installation.id, now });
      await appendAuditLog(
        tx,
        s.workspaceId,
        {
          eventType: "connector.oauth.connected",
          actorType: "user",
          actorId: s.userId,
          payload: { connectorId: connector.id, slug: GITHUB_SLUG, login: user.login, installationId: String(installation.id), installationAccount: installation.accountLogin },
        },
        now,
      );
      // GitHub の画面でのインストール・認可を、ポリシーの版を広げることへの承認とみなす（監査に残す。Google と同じ：16 §3.6）
      const policy = await setConnectorEnabledInPolicy(tx, s, { slug: GITHUB_SLUG, enabled: true, userId: s.userId, now });
      if (policy.changed) {
        await appendAuditLog(
          tx,
          s.workspaceId,
          {
            eventType: "policy.snapshot_created",
            actorType: "user",
            actorId: s.userId,
            payload: { scope: "workspace", version: policy.version, policyHash: policy.policyHash, reason: "connector.oauth.connected", connectorId: connector.id, consentedBy: s.userId },
          },
          now,
        );
      }
      return { connector, credentialId };
    });

    await deps.gatewayClient.syncTools(committed.connector.id);
    const connected = committed.connector;
    await deps.db.transaction((tx) =>
      classifyConnectorTools(tx, s, {
        manifests: [GITHUB_CONNECTOR],
        connectors: [connected],
        classifiedBy: CONNECT_ACTOR,
        now: deps.clock.now(),
        audit: async (atx, eventType, payload) => {
          await appendAuditLog(atx, s.workspaceId, { eventType, actorType: "system", actorId: CONNECT_ACTOR, payload }, now);
        },
      }),
    );
    return user.login;
  } catch (e) {
    if (committed) await cleanupAfterCommit(deps, s, committed.connector.id, committed.credentialId);
    throw e;
  } finally {
    await revokeGithubUserToken(fetchFn, env, userToken);
  }
}

async function cleanupAfterCommit(deps: AppDeps, s: SessionCtx, connectorId: string, credentialId: string): Promise<void> {
  try {
    const now = deps.clock.now();
    await deps.db.transaction(async (tx: Tx) => {
      await lockWorkspace(tx, s);
      if (await revokeCredentialIfActive(tx, s, connectorId, credentialId, now)) await setConnectorEnabledInPolicy(tx, s, { slug: GITHUB_SLUG, enabled: false, userId: s.userId, now });
    });
  } catch (e) {
    deps.log.warn("connect.github.cleanup_failed", "接続の後始末に失敗した（手で確かめる）", { workspaceId: s.workspaceId, error: errorName(e) });
  }
}

export function connectGithubRoutes(r: ApiRouter, deps: AppDeps): void {
  // インストール（既定）か認可の画面へ
  r.get("/connect/github/start", (c) => {
    const env = deps.env.githubConnect;
    if (!env) return backTo(c, "github_unavailable");
    const state = randomBytes(32).toString("base64url");
    const s = sessionOf(c);
    setCookie(c, GITHUB_STATE_COOKIE, `${state}:${stateBinding(deps.env.cookieSecret ?? "", state, s)}`, { ...stateCookieOptions(deps), maxAge: GITHUB_STATE_MAX_AGE_SEC });
    return c.redirect(c.req.query("mode") === "authorize" ? buildGithubAuthorizeUrl(env, state) : buildGithubInstallUrl(env, state), 302);
  });

  // GitHub からの戻り（code の交換・本人とインストールの確認・保存）
  r.get("/connect/github/callback", async (c) => {
    const s = sessionOf(c);
    const env = deps.env.githubConnect;
    const cookie = parseStateCookie(getCookie(c, GITHUB_STATE_COOKIE));
    deleteCookie(c, GITHUB_STATE_COOKIE, stateCookieOptions(deps));
    if (!env) return backTo(c, "github_unavailable");
    const got = c.req.query("state");
    if (!cookie || !got || !stateMatches(cookie.state, got) || !stateMatches(cookie.binding, stateBinding(deps.env.cookieSecret ?? "", cookie.state, s))) {
      deps.log.warn("connect.github.state_mismatch", "接続の state が合わない（拒否）", { workspaceId: s.workspaceId });
      return backTo(c, "github_state");
    }
    if (c.req.query("error") !== undefined) return backTo(c, "github_denied");
    const code = c.req.query("code");
    if (!code) {
      // インストールだけして認可を飛ばした（App の設定で認可を求めていない）：認可の画面へ回す
      return c.req.query("installation_id") !== undefined ? c.redirect("/api/v1/connect/github/start?mode=authorize", 302) : backTo(c, "github_failed");
    }
    try {
      await completeGithubConnect(deps, s, env, code, c.req.query("installation_id"));
      deps.log.info("connect.github.connected", "GitHub をつないだ", { workspaceId: s.workspaceId });
      return backTo(c, null);
    } catch (e) {
      const outcome: GithubConnectOutcome = e instanceof GithubConnectError && e.code === "not_installed" ? "github_not_installed" : "github_failed";
      deps.log.warn("connect.github.failed", "GitHub をつなげなかった", { workspaceId: s.workspaceId, reason: outcome, error: errorName(e) });
      return backTo(c, outcome);
    }
  });

  // 切断（資格情報を取り消し、コネクタとポリシーから外す。何もなければ何もしない）
  r.delete("/connect/github", async (c) => {
    const s = sessionOf(c);
    const conn = await getGithubConnection(deps.db, s);
    if (conn) {
      // gateway のインストールのトークンのキャッシュを捨てる（失敗しても DB の取り消しで次から使われない）
      try { await deps.gatewayClient.revokeCredential(conn.connectorId, s.workspaceId); }
      catch (e) { deps.log.warn("connect.github.cache_drop_failed", "gateway のトークンのキャッシュを捨てられなかった", { workspaceId: s.workspaceId, error: errorName(e) }); }
      const now = deps.clock.now();
      await deps.db.transaction(async (tx: Tx) => {
        await lockWorkspace(tx, s);
        await revokeCredential(tx, s, conn.connectorId, now);
        await setConnectorEnabledInPolicy(tx, s, { slug: GITHUB_SLUG, enabled: false, userId: s.userId, now });
        await appendAuditLog(tx, s.workspaceId, { eventType: "connector.oauth.disconnected", actorType: "user", actorId: s.userId, payload: { connectorId: conn.connectorId, slug: GITHUB_SLUG } }, now);
      });
      deps.log.info("connect.github.disconnected", "GitHub を切断した", { workspaceId: s.workspaceId });
    }
    return c.body(null, 204);
  });

  // 保護したブランチへの書き込みの許可（18 §2-5）。変えたら監査に残す。つながっていなければ 404
  r.put("/connect/github/protected-write", async (c) => {
    const s = sessionOf(c);
    const body = await readJsonBody(c, ProtectedWriteBody);
    const conn = await getGithubConnection(deps.db, s);
    if (!conn) throw new AppError("NOT_FOUND", "GitHub がつながっていません");
    const now = deps.clock.now();
    const changed = await deps.db.transaction(async (tx: Tx) => {
      await lockWorkspace(tx, s);
      const ok = await setGithubProtectedWrite(tx, s, conn.credentialId, body.allow);
      if (ok) {
        await appendAuditLog(
          tx,
          s.workspaceId,
          { eventType: "connector.github.protected_write_changed", actorType: "user", actorId: s.userId, payload: { connectorId: conn.connectorId, allow: body.allow } },
          now,
        );
      }
      return ok;
    });
    if (changed) deps.log.info("connect.github.protected_write", "保護したブランチへの書き込みの許可を変えた", { workspaceId: s.workspaceId, allow: body.allow });
    return c.json({ allowProtectedWrite: body.allow });
  });
}
