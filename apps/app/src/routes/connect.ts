// Google カレンダーの接続（16 §3.6、ADR-040）。ゲストのワークスペースでもオーナーでも同じ（セッション必須）
//   GET    /api/v1/connect/google/start?tz=<IANA>   state を Cookie に置いて Google の同意画面へ
//   GET    /api/v1/connect/google/callback          state を照合 → code を交換 → 必要な権限の確認 → カレンダー → 1トランザクション → 同期・分類
//   DELETE /api/v1/connect/google                   切断（DB だけ。Google 側の取り消しは下の TODO）
// 失敗は画面に戻す（/?connect_error=…）。トークン・code・state は応答にもログにも出さない

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendAuditLog, getGoogleConnection, insertGoogleCredential, lockWorkspace, revokeCredential, revokeCredentialIfActive, upsertOAuthConnector, type ConnectorRow, type SessionCtx, type Tx } from "@open-team/db";
import { GCAL_CONNECTOR, GCAL_DISPLAY_NAME, GCAL_MCP_PATH, GCAL_SLUG } from "@open-team/gcal-core";
import { sealSecret } from "@open-team/platform";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { classifyConnectorTools } from "../connectors/classify.ts";
import {
  buildGoogleAuthUrl,
  createMakaseCalendar,
  exchangeGoogleCode,
  GCAL_STATE_COOKIE,
  GCAL_STATE_COOKIE_PATH,
  GCAL_STATE_MAX_AGE_SEC,
  GoogleConnectError,
  idTokenIdentity,
  requireScopes,
  revokeGoogleToken,
  timeZoneOrDefault,
  type GoogleFetch,
} from "../connectors/google.ts";
import { setConnectorEnabledInPolicy } from "../connectors/policy.ts";
import type { GoogleConnectEnv } from "../env.ts";
import type { AppDeps } from "../deps.ts";
import type { AppHonoEnv } from "../context.ts";
import { sessionOf } from "../http.ts";
import type { ApiRouter } from "./router.ts";

/** 分類・切断の監査の actor（システムの手順） */
export const CONNECT_ACTOR = "system:connect";

type ConnectOutcome = "denied" | "scope" | "failed" | "state" | "unavailable";

/** state の照合（定数時間。長さが違えば false） */
export function stateMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(got, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** state を開始時のセッションとワークスペースに結び付ける */
export function stateBinding(secret: string, state: string, s: SessionCtx): string {
  return createHmac("sha256", secret).update(`${state}:${s.sessionId}:${s.workspaceId}`).digest("base64url");
}
function parseStateCookie(raw: string | undefined): { state: string; tz: string; binding: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(":");
  const j = raw.indexOf(":", i + 1);
  if (i <= 0 || j <= i + 1) return null;
  return { state: raw.slice(0, i), tz: raw.slice(i + 1, j), binding: raw.slice(j + 1) };
}

/** Google の接続の Cookie のオプション（Secure は本番だけ。ローカルは http のまま動く） */
function stateCookieOptions(deps: Pick<AppDeps, "env">) {
  return { httpOnly: true, secure: deps.env.cookieSecure, sameSite: "Lax" as const, path: GCAL_STATE_COOKIE_PATH };
}

function backTo(c: Context<AppHonoEnv>, outcome: ConnectOutcome | null): Response {
  return c.redirect(outcome === null ? "/?connected=gcal" : `/?connect_error=${outcome}`, 302);
}

/**
 * consent のあとの処理（トークンの交換から保存まで）。失敗したら Google 側の許可を best effort で取り消して投げ直す。
 * DB に入ったあと（同期・分類）の失敗は、入れたものを切って（資格情報・ポリシー）から投げ直す
 */
async function completeGoogleConnect(deps: AppDeps, s: SessionCtx, env: GoogleConnectEnv, tz: string, code: string): Promise<void> {
  const fetchFn: GoogleFetch = deps.googleFetch;
  const tokens = await exchangeGoogleCode(fetchFn, env, code);
  const revokeToken = tokens.refreshToken ?? tokens.accessToken;
  let committed: { connector: ConnectorRow; credentialId: string } | null = null;
  try {
    if (!tokens.refreshToken) throw new GoogleConnectError("scope", "refresh_token がない");
    requireScopes(tokens.scopes);
    const { sub, email } = idTokenIdentity(tokens.idToken);
    const calendarId = await createMakaseCalendar(fetchFn, tokens.accessToken, tz);
    const now = deps.clock.now();
    const refreshToken = tokens.refreshToken;

    // 1トランザクション：コネクタ・資格情報・監査・ポリシーの版（外部は呼ばない：G-14）
    committed = await deps.db.transaction(async (tx: Tx) => {
      await lockWorkspace(tx, s);
      const connector = await upsertOAuthConnector(tx, s, { slug: GCAL_SLUG, displayName: GCAL_DISPLAY_NAME, url: `${env.gcalUrl}${GCAL_MCP_PATH}`, now });
      const credentialId = await insertGoogleCredential(tx, s, {
        connectorId: connector.id,
        subject: sub,
        email,
        scopes: tokens.scopes,
        // AAD は "<workspace_id>:<connector_id>"（別の行に写した暗号文は開けない：ADR-040）
        refreshTokenEnc: sealSecret(env.tokenKey, refreshToken, `${s.workspaceId}:${connector.id}`),
        calendarId,
        timeZone: tz,
        now,
      });
      await appendAuditLog(tx, s.workspaceId, { eventType: "connector.oauth.connected", actorType: "user", actorId: s.userId, payload: { connectorId: connector.id, slug: GCAL_SLUG, email } }, now);
      // 同意画面での許可を、ポリシーの版を広げることへの承認とみなす（監査に残す）
      const policy = await setConnectorEnabledInPolicy(tx, s, { slug: GCAL_SLUG, enabled: true, userId: s.userId, now });
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

    // コミットのあと：gateway がツールを同期し、manifest で分類する（外部の呼び出しはトランザクションの外）
    await deps.gatewayClient.syncTools(committed.connector.id);
    const connected = committed.connector;
    await deps.db.transaction((tx) =>
      classifyConnectorTools(tx, s, {
        manifests: [GCAL_CONNECTOR],
        connectors: [connected],
        classifiedBy: CONNECT_ACTOR,
        now: deps.clock.now(),
        audit: async (atx, eventType, payload) => {
          await appendAuditLog(atx, s.workspaceId, { eventType, actorType: "system", actorId: CONNECT_ACTOR, payload }, now);
        },
      }),
    );
  } catch (e) {
    if (committed) await cleanupAfterCommit(deps, s, committed.connector.id, committed.credentialId);
    await revokeGoogleToken(fetchFn, revokeToken);
    throw e;
  }
}

/** 入ったあとに失敗したときの後始末（資格情報を切り、ポリシーから外す。best effort） */
async function cleanupAfterCommit(deps: AppDeps, s: SessionCtx, connectorId: string, credentialId: string): Promise<void> {
  try {
    const now = deps.clock.now();
    await deps.db.transaction(async (tx: Tx) => {
      await lockWorkspace(tx, s);
      if (await revokeCredentialIfActive(tx, s, connectorId, credentialId, now)) await setConnectorEnabledInPolicy(tx, s, { slug: GCAL_SLUG, enabled: false, userId: s.userId, now });
    });
  } catch (e) {
    deps.log.warn("connect.google.cleanup_failed", "接続の後始末に失敗した（手で確かめる）", { workspaceId: s.workspaceId, error: errorName(e) });
  }
}

const errorName = (e: unknown): string => (e instanceof Error ? e.name : "unknown");

export function connectRoutes(r: ApiRouter, deps: AppDeps): void {
  // 同意画面へ（ゲストもオーナーも。セッションは既定の守りで必須）
  r.get("/connect/google/start", (c) => {
    const env = deps.env.googleConnect;
    if (!env) return backTo(c, "unavailable");
    const tz = timeZoneOrDefault(c.req.query("tz"));
    const state = randomBytes(32).toString("base64url");
    const s = sessionOf(c);
    setCookie(c, GCAL_STATE_COOKIE, `${state}:${tz}:${stateBinding(deps.env.cookieSecret ?? "", state, s)}`, { ...stateCookieOptions(deps), maxAge: GCAL_STATE_MAX_AGE_SEC });
    return c.redirect(buildGoogleAuthUrl(env, state), 302);
  });

  // Google からの戻り（code の交換・保存）
  r.get("/connect/google/callback", async (c) => {
    const s = sessionOf(c);
    const env = deps.env.googleConnect;
    const cookie = parseStateCookie(getCookie(c, GCAL_STATE_COOKIE));
    // 使った state は1回で捨てる（成功・失敗・照合の失敗のどれでも）
    deleteCookie(c, GCAL_STATE_COOKIE, stateCookieOptions(deps));
    if (!env) return backTo(c, "unavailable");
    const got = c.req.query("state");
    if (!cookie || !got || !stateMatches(cookie.state, got) || !stateMatches(cookie.binding, stateBinding(deps.env.cookieSecret ?? "", cookie.state, s))) {
      deps.log.warn("connect.google.state_mismatch", "接続の state が合わない（拒否）", { workspaceId: s.workspaceId });
      return backTo(c, "state");
    }
    if (c.req.query("error") !== undefined) return backTo(c, "denied");
    const code = c.req.query("code");
    if (!code) return backTo(c, "failed");
    try {
      await completeGoogleConnect(deps, s, env, cookie.tz, code);
      deps.log.info("connect.google.connected", "Google カレンダーをつないだ", { workspaceId: s.workspaceId });
      return backTo(c, null);
    } catch (e) {
      const outcome: ConnectOutcome = e instanceof GoogleConnectError && e.code === "scope" ? "scope" : "failed";
      deps.log.warn("connect.google.failed", "Google カレンダーをつなげなかった", { workspaceId: s.workspaceId, reason: outcome, error: errorName(e) });
      return backTo(c, outcome);
    }
  });

  // 切断（資格情報を取り消し、コネクタとポリシーから外す。何もなければ何もしない）
  r.delete("/connect/google", async (c) => {
    const s = sessionOf(c);
    const conn = await getGoogleConnection(deps.db, s);
    if (conn) {
      try { await deps.gatewayClient.revokeCredential(conn.connectorId, s.workspaceId); }
      catch (e) { deps.log.warn("connect.google.google_revoke_failed", "Google 側の許可を取り消せなかった", { workspaceId: s.workspaceId, error: errorName(e) }); }
      const now = deps.clock.now();
      await deps.db.transaction(async (tx: Tx) => {
        await lockWorkspace(tx, s);
        await revokeCredential(tx, s, conn.connectorId, now);
        await setConnectorEnabledInPolicy(tx, s, { slug: GCAL_SLUG, enabled: false, userId: s.userId, now });
        await appendAuditLog(tx, s.workspaceId, { eventType: "connector.oauth.disconnected", actorType: "user", actorId: s.userId, payload: { connectorId: conn.connectorId, slug: GCAL_SLUG } }, now);
      });
      deps.log.info("connect.google.disconnected", "Google カレンダーを切断した", { workspaceId: s.workspaceId });
    }
    return c.body(null, 204);
  });
}
