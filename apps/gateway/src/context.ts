// gateway の処理が使う依存（DB・時計・ログ・HTTP・認証）と、コネクタを呼ぶときの宛先（URL と頭）を作る

import { createSign } from "node:crypto";
import { getActiveCredential, type ConnectorCredentialRow, type ConnectorRow, type Db } from "@open-team/db";
import { locateConnector } from "@open-team/db/gateway";
import { GCAL_HEADER } from "@open-team/gcal-core";
import { GITHUB_HEADER } from "@open-team/github-core";
import {
  createServiceAuth,
  knownSecretsFromEnv,
  openSecret,
  silentLogger,
  systemClock,
  type Clock,
  type Logger,
  type ServiceAuth,
} from "@open-team/platform";
import { originOf } from "./origin.ts";
import type { GatewayEnv, GcalConfig, GithubConfig } from "./env.ts";
import { MCP_CALL_TIMEOUT_MS, MCP_LIST_TIMEOUT_MS, type McpTarget } from "./mcp.ts";

/** 送信前の失敗の再試行の待ち（IA §2.1 の PRESEND_BACKOFF_MS。11 §9 の値を流用。合計21秒で EP-50 の1回の要求に収める：G-02） */
export const PRESEND_BACKOFF_MS: readonly number[] = [1_000, 4_000, 16_000];

/** コネクタを呼ぶときの証明の依頼 */
export interface ConnectorAuthRequest {
  connector: Pick<ConnectorRow, "id" | "workspace_id" | "url" | "auth">;
  /** 書き込みの Intent の ID（execute だけ。読み取り・同期は null）。Google では冪等キーになる */
  intentId: string | null;
  /** list：tools/list（同期。アダプターは Google の頭を見ないので資格情報を開かない）／call：tools/call（資格情報が要る） */
  purpose: "list" | "call";
}

/** コネクタを呼ぶときの証明。証明できないコネクタ（0-H の外の認証）は ConnectorAuthUnsupported を投げる */
export type ConnectorAuthProvider = (c: ConnectorAuthRequest) => Promise<Record<string, string>>;

export class ConnectorAuthUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthUnsupported";
  }
}

/**
 * Google の資格情報で認証できない（資格情報がない・取り消された・開けない・Google が refresh token を拒んだ）。
 * 呼び出し側は認証の失敗（failed(auth_required)・読み取りは拒否）として扱い、再試行しない。reason は固定の短い名前（秘密は入れない）
 */
export class ConnectorAuthRequired extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`認証が要る：${reason}`);
    this.name = "ConnectorAuthRequired";
    this.reason = reason;
  }
}

/** Google のアクセストークンを取れなかった（届かない・5xx など）。tools/call を送る前の失敗として扱う（再試行してよい） */
export class ConnectorTokenUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`トークンを取れなかった：${reason}`);
    this.name = "ConnectorTokenUnavailable";
    this.reason = reason;
  }
}

/** Google の token の交換の宛先（16 §3.5） */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** アクセストークンは expires_in から この分だけ早く捨てる */
const TOKEN_MARGIN_MS = 60_000;
const TOKEN_TIMEOUT_MS = 10_000;
const ACCESS_TOKEN_CACHE = new Map<string, { token: string; expiresAt: number }>();

/** 応答の本文から error の名前だけを読む（読めなければ null。本文は残さない） */
async function googleErrorCodeOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/** refresh token からアクセストークンを作る（Google の token の宛先・form 形式）。失敗は投げる（トークンは例外にも入れない） */
async function exchangeRefreshToken(
  gcal: GcalConfig,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<{ token: string; expiresInSec: number }> {
  const body = new URLSearchParams({
    client_id: gcal.clientId,
    client_secret: gcal.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorTokenUnavailable("network");
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      const code = await googleErrorCodeOf(res);
      // 同意の取り消し・期限切れ：もう使えない（再接続が要る）
      if (code === "invalid_grant") throw new ConnectorAuthRequired("invalid_grant");
    }
    throw new ConnectorTokenUnavailable(`http_${res.status}`);
  }
  let json: { access_token?: unknown; expires_in?: unknown };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new ConnectorTokenUnavailable("bad_response");
  }
  if (typeof json.access_token !== "string" || json.access_token === "" || typeof json.expires_in !== "number") {
    throw new ConnectorTokenUnavailable("bad_response");
  }
  return { token: json.access_token, expiresInSec: json.expires_in };
}

/** GitHub のインストールのトークンのキャッシュ（キー：installation_id。値はトークンだけ。ログに出さない） */
const INSTALLATION_TOKEN_CACHE = new Map<string, { token: string; expiresAt: number }>();

const b64url = (v: string | Buffer): string => Buffer.from(v).toString("base64url");

/**
 * GitHub App の JWT（RS256。18 §3.5）。iat は時計のずれを見て60秒前、exp は9分後（GitHub の上限は10分）
 */
export function githubAppJwt(appId: string, privateKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(privateKey))}`;
}

/**
 * インストールのトークンを作る（POST /app/installations/{id}/access_tokens）。失敗は投げる（トークン・鍵は例外にも入れない）。
 * 404（アンインストール）・403（一時停止）は再接続が要る（ConnectorAuthRequired）、それ以外は ConnectorTokenUnavailable
 */
async function createInstallationToken(
  github: GithubConfig,
  installationId: string,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<{ token: string; expiresAtMs: number }> {
  let res: Response;
  try {
    res = await fetchImpl(`${github.apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${githubAppJwt(github.appId, github.privateKey, nowMs)}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "open-team-gateway",
      },
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectorTokenUnavailable("network");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) throw new ConnectorAuthRequired("installation_gone");
    if (res.status === 403) throw new ConnectorAuthRequired("installation_suspended");
    throw new ConnectorTokenUnavailable(`http_${res.status}`);
  }
  let json: { token?: unknown; expires_at?: unknown };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new ConnectorTokenUnavailable("bad_response");
  }
  const expiresAtMs = typeof json.expires_at === "string" ? Date.parse(json.expires_at) : Number.NaN;
  if (typeof json.token !== "string" || json.token === "" || Number.isNaN(expiresAtMs)) throw new ConnectorTokenUnavailable("bad_response");
  return { token: json.token, expiresAtMs };
}

export interface DefaultConnectorAuthDeps {
  db: Db;
  /** Google の token の交換に使う（試験で差し替える） */
  fetch: typeof fetch;
  clock: Clock;
}

/**
 * 既定の証明（MT D-12、SO §3.9、16 §3.5）：
 * - Google カレンダー（auth.type = oauth・provider google、URL の origin が GCAL_URL）：呼び出しの証明（GCAL_SHARED_TOKEN）。purpose = call のときは資格情報を開き、アクセストークンと GCAL_HEADER.* を足す。
 *   アクセストークンはメモリに exp−60秒までキャッシュする（資格情報の行の id が変われば取り直す）
 * - GitHub（auth.type = oauth・provider github、URL の origin が GITHUB_URL）：呼び出しの証明（GITHUB_SHARED_TOKEN）。purpose = call のときは資格情報の行のインストールで GitHub App のトークンを作り、
 *   GITHUB_HEADER.*（トークン・保護したブランチへの許可・冪等キー）を足す。許可は実行のときの行の値（18 §2-5）
 * - 実のコネクタ：auth.type = none は頭なし。api_key は 0-H では使えない
 */
export function defaultConnectorAuth(env: GatewayEnv, deps: DefaultConnectorAuthDeps): ConnectorAuthProvider {
  let gcalLocalAuth: ServiceAuth | null = null;
  let githubLocalAuth: ServiceAuth | null = null;
  /** キー：<connector_id>:<credential_id>。値はアクセストークンだけ（ログに出さない） */

  const gcalCallerProof = async (gcal: GcalConfig): Promise<Record<string, string>> => {
    if (gcal.sharedToken === null) throw new ConnectorAuthUnsupported("GCAL_SHARED_TOKEN がない");
    gcalLocalAuth ??= createServiceAuth({ sharedToken: gcal.sharedToken });
    return gcalLocalAuth.serviceAuthHeaders("sa-gateway", gcal.url);
  };

  const accessTokenOf = async (gcal: GcalConfig, connectorId: string, credentialId: string, refreshToken: string): Promise<string> => {
    const key = `${connectorId}:${credentialId}`;
    const now = deps.clock.now().getTime();
    const hit = ACCESS_TOKEN_CACHE.get(key);
    if (hit && hit.expiresAt > now) return hit.token;
    const fresh = await exchangeRefreshToken(gcal, refreshToken, deps.fetch);
    ACCESS_TOKEN_CACHE.set(key, { token: fresh.token, expiresAt: now + Math.max(0, fresh.expiresInSec * 1000 - TOKEN_MARGIN_MS) });
    return fresh.token;
  };

  const googleAuth = async (req: ConnectorAuthRequest): Promise<Record<string, string>> => {
    const { connector } = req;
    const gcal = env.gcal;
    if (gcal === null) throw new ConnectorAuthUnsupported("GCAL_URL がない（Google のコネクタは使えない）");
    if (originOf(connector.url) !== gcal.origin) throw new ConnectorAuthUnsupported("Google のコネクタの URL が GCAL_URL と違う");
    const caller = await gcalCallerProof(gcal);
    if (req.purpose === "list") return caller;

    // 資格情報は DB から引き直す（ワークスペースの種類も DB の値。リクエストの値は使わない）
    const cred = await activeCredentialFor(req);
    if (cred.provider !== "google" || cred.refresh_token_enc === null || cred.calendar_id === null || cred.time_zone === null) {
      throw new ConnectorAuthRequired("credential_unreadable");
    }
    let refreshToken: string;
    try {
      refreshToken = openSecret(gcal.tokenKey, cred.refresh_token_enc, `${connector.workspace_id}:${connector.id}`);
    } catch {
      // 持ち主（AAD）が違う・改ざん・鍵が違う：閉じた側に倒す
      throw new ConnectorAuthRequired("credential_unreadable");
    }
    const accessToken = await accessTokenOf(gcal, connector.id, cred.id, refreshToken);
    return {
      ...caller,
      [GCAL_HEADER.accessToken]: accessToken,
      [GCAL_HEADER.calendarId]: cred.calendar_id,
      [GCAL_HEADER.timeZone]: cred.time_zone,
      ...(req.intentId !== null ? { [GCAL_HEADER.idempotencyKey]: req.intentId } : {}),
    };
  };

  /** Intent の資格情報の pin（作ったときの行と今の行が同じか）を含め、本人のコネクタの有効な資格情報を DB から引く */
  const activeCredentialFor = async (req: ConnectorAuthRequest): Promise<ConnectorCredentialRow> => {
    const { connector } = req;
    const loc = await locateConnector(deps.db, connector.id);
    if (!loc || loc.ctx.workspaceId !== connector.workspace_id) throw new ConnectorAuthRequired("no_connector");
    const cred = await getActiveCredential(deps.db, loc.ctx, connector.id);
    if (!cred) throw new ConnectorAuthRequired("no_credential");
    if (req.intentId !== null) {
      const intent = await deps.db.query<{ connector_credential_id: string | null }>(
        "SELECT connector_credential_id FROM action_intents WHERE workspace_id = $1 AND id = $2",
        [loc.ctx.workspaceId, req.intentId],
      );
      if (!intent.rows.length) throw new ConnectorAuthRequired("no_intent");
      if (intent.rows[0]?.connector_credential_id !== cred.id) throw new ConnectorAuthRequired("credential_changed");
    }
    return cred;
  };

  const githubAuth = async (req: ConnectorAuthRequest): Promise<Record<string, string>> => {
    const { connector } = req;
    const github = env.github;
    if (github === null) throw new ConnectorAuthUnsupported("GITHUB_URL がない（GitHub のコネクタは使えない）");
    if (originOf(connector.url) !== github.origin) throw new ConnectorAuthUnsupported("GitHub のコネクタの URL が GITHUB_URL と違う");
    if (github.sharedToken === null) throw new ConnectorAuthUnsupported("GITHUB_SHARED_TOKEN がない");
    githubLocalAuth ??= createServiceAuth({ sharedToken: github.sharedToken });
    const caller = await githubLocalAuth.serviceAuthHeaders("sa-gateway", github.url);
    if (req.purpose === "list") return caller;

    const cred = await activeCredentialFor(req);
    if (cred.provider !== "github" || cred.installation_id === null) throw new ConnectorAuthRequired("credential_unreadable");
    const now = deps.clock.now().getTime();
    const hit = INSTALLATION_TOKEN_CACHE.get(cred.installation_id);
    let token: string;
    if (hit && hit.expiresAt > now) token = hit.token;
    else {
      const fresh = await createInstallationToken(github, cred.installation_id, now, deps.fetch);
      INSTALLATION_TOKEN_CACHE.set(cred.installation_id, { token: fresh.token, expiresAt: fresh.expiresAtMs - TOKEN_MARGIN_MS });
      token = fresh.token;
    }
    return {
      ...caller,
      [GITHUB_HEADER.token]: token,
      [GITHUB_HEADER.allowProtectedWrite]: cred.allow_protected_write ? "true" : "false",
      ...(req.intentId !== null ? { [GITHUB_HEADER.idempotencyKey]: req.intentId } : {}),
    };
  };

  return async (req) => {
    const { connector } = req;
    switch (connector.auth.type) {
      case "none":
        return {};
      case "oauth":
        return connector.auth.provider === "github" ? githubAuth(req) : googleAuth(req);
      default:
        throw new ConnectorAuthUnsupported("実のコネクタの認証情報は 0-H では使わない（BR-66・D-11）");
    }
  };
}

export interface GatewayDeps {
  db: Db;
  log?: Logger;
  clock?: Clock;
  /** MCP の HTTP（既定は globalThis.fetch。試験で失敗を差し込む） */
  fetch?: typeof fetch;
  /** 受ける側の呼び出し元の確認（既定は env.serviceAuth から作る） */
  serviceAuth?: ServiceAuth;
  /** コネクタを呼ぶときの証明（既定は defaultConnectorAuth。Google の token の交換は fetch を使う） */
  connectorAuth?: ConnectorAuthProvider;
  timeouts?: { callMs?: number; listMs?: number };
  /** 送信前の失敗の再試行の待ち（既定 1・4・16秒） */
  presendBackoffMs?: readonly number[];
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 応答・結果のマスクに使う既知の秘密（既定は環境変数の秘密） */
  knownSecrets?: readonly string[];
}

/** 解決済みの依存（処理の関数はこれだけを受け取る） */
export interface GatewayContext {
  env: GatewayEnv;
  db: Db;
  log: Logger;
  clock: Clock;
  fetch: typeof fetch;
  connectorAuth: ConnectorAuthProvider;
  callTimeoutMs: number;
  listTimeoutMs: number;
  presendBackoffMs: readonly number[];
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  knownSecrets: readonly string[];
  /** 切断のときの後始末（Google は refresh token の取り消し。GitHub はトークンのキャッシュを捨てるだけ：18 §2-8） */
  revokeGoogleCredential(connectorId: string, workspaceId: string): Promise<void>;
}

/** 中断できる待ち（中断されたら false） */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveContext(env: GatewayEnv, deps: GatewayDeps): GatewayContext {
  const knownSecrets = [...(deps.knownSecrets ?? knownSecretsFromEnv(process.env))];
  if (env.serviceAuth.sharedToken) knownSecrets.push(env.serviceAuth.sharedToken);
  if (env.gcal?.sharedToken) knownSecrets.push(env.gcal.sharedToken);
  if (env.gcal) knownSecrets.push(env.gcal.clientSecret, env.gcal.tokenKey);
  if (env.github) knownSecrets.push(env.github.privateKey, ...(env.github.sharedToken ? [env.github.sharedToken] : []));
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const clock = deps.clock ?? systemClock;
  const revokeGoogleCredential = async (connectorId: string, workspaceId: string): Promise<void> => {
    const located = await locateConnector(deps.db, connectorId);
    if (!located || located.ctx.workspaceId !== workspaceId) throw new Error("connector_not_found");
    const credential = await getActiveCredential(deps.db, located.ctx, connectorId);
    if (credential?.provider === "github") {
      // GitHub は秘密を持たない。インストールのトークン（最長1時間）をキャッシュから捨てる。アンインストールは利用者が GitHub の画面で行う
      if (credential.installation_id !== null) INSTALLATION_TOKEN_CACHE.delete(credential.installation_id);
      return;
    }
    if (!credential || !env.gcal || credential.refresh_token_enc === null) return;
    const refresh = openSecret(env.gcal.tokenKey, credential.refresh_token_enc, `${workspaceId}:${connectorId}`);
    ACCESS_TOKEN_CACHE.delete(`${connectorId}:${credential.id}`);
    try {
      const response = await fetchImpl("https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh }).toString(), redirect: "error", signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      if (!response.ok) (deps.log ?? silentLogger).warn("gcal.revoke_failed", "Google 側の資格情報を取り消せなかった", { status: response.status, connectorId });
      await response.body?.cancel().catch(() => {});
    } catch (e) {
      (deps.log ?? silentLogger).warn("gcal.revoke_failed", "Google 側の資格情報を取り消せなかった", { connectorId, error: e instanceof Error ? e.name : "unknown" });
    }
  };
  return {
    env,
    db: deps.db,
    log: deps.log ?? silentLogger,
    clock,
    fetch: fetchImpl,
    connectorAuth: deps.connectorAuth ?? defaultConnectorAuth(env, { db: deps.db, fetch: fetchImpl, clock }),
    callTimeoutMs: deps.timeouts?.callMs ?? MCP_CALL_TIMEOUT_MS,
    listTimeoutMs: deps.timeouts?.listMs ?? MCP_LIST_TIMEOUT_MS,
    presendBackoffMs: deps.presendBackoffMs ?? PRESEND_BACKOFF_MS,
    sleep: deps.sleep ?? (async (ms, signal) => void (await abortableSleep(ms, signal))),
    knownSecrets,
    revokeGoogleCredential,
  };
}

/** 呼び出しの秘密として扱うヘッダー（応答のマスクに足す。ログには出さない） */
const SECRET_HEADERS: readonly string[] = [GCAL_HEADER.accessToken, GITHUB_HEADER.token];

/**
 * コネクタを呼ぶ宛先（URL・証明）。証明できなければ ConnectorAuthUnsupported。
 * 資格情報の失敗は ConnectorAuthRequired・ConnectorTokenUnavailable（呼び出し側が結果に直す）。
 * purpose = list は同期（tools/list）：Google のコネクタでも資格情報を開かない。
 * intentId は書き込みの Intent の ID（execute だけ。読み取り・同期は null）
 */
export async function targetFor(
  g: GatewayContext,
  connector: Pick<ConnectorRow, "id" | "workspace_id" | "url" | "auth">,
  intentId: string | null,
  purpose: "list" | "call",
): Promise<McpTarget> {
  const headers = await g.connectorAuth({ connector, intentId, purpose });
  const secrets = SECRET_HEADERS.map((h) => headers[h]).filter((v): v is string => typeof v === "string" && v !== "");
  return { url: connector.url, headers, secrets };
}
