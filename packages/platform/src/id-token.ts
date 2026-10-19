// Google の ID トークン（OIDC）の取得と検証（security-ops-deploy.md §3.9。cloud のサービス間の認証）
// 取得：google-auth-library（Cloud Run のメタデータサーバーの identity。format=full で email が入る）。aud ごとに期限の5分前まで使い回す。
// 検証：OAuth2Client.verifyIdToken で署名・exp・iss・aud を確かめ、そのうえで aud・iss・exp・email_verified・email を自分でも確かめる
// （偽の検証器を差し込む試験でも、許す email と aud の外れが必ず拒否になるように）。トークンの値はどこにも出さない

import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { systemClock, type Clock } from "./time.ts";

/** 期限の何秒前に取り直すか（SO §2.1 の idTokenRefreshBeforeSec） */
export const ID_TOKEN_REFRESH_BEFORE_SEC = 300;

/** Google の ID トークンの発行者 */
export const GOOGLE_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];

/** 末尾の / と前後の空白を除く（取得と検証で aud の書き方をそろえる） */
export function normalizeAudience(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

// ---- 取得 ----

/** aud を受けて ID トークン（JWT）を返す。キャッシュしない生の取得 */
export type IdTokenFetcher = (audience: string) => Promise<string>;

export interface IdTokenSource {
  getIdToken(audience: string): Promise<string>;
}

/**
 * google-auth-library で取る（Cloud Run ではメタデータサーバーの
 * /instance/service-accounts/default/identity?audience=…&format=full。API キー・鍵ファイルは使わない）
 */
export function googleIdTokenFetcher(auth: GoogleAuth = new GoogleAuth()): IdTokenFetcher {
  return async (audience) => {
    const client = await auth.getIdTokenClient(audience);
    return client.idTokenProvider.fetchIdToken(audience);
  };
}

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** ID トークンのクレーム（読み取ったまま。型は確かめてから使う） */
export interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  exp?: unknown;
  iat?: unknown;
  [k: string]: unknown;
}

/** JWT のペイロードを署名を確かめずに読む（形が違えば null）。キャッシュの期限と、署名を見ないときのクレームの確認に使う */
export function decodeJwtClaims(token: string): IdTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !JWT_SEGMENT.test(parts[0] ?? "") || !JWT_SEGMENT.test(parts[1] ?? "")) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as IdTokenClaims) : null;
  } catch {
    return null;
  }
}

export interface IdTokenSourceOptions {
  /** 既定は googleIdTokenFetcher()（初めて使うときに作る） */
  fetchIdToken?: IdTokenFetcher;
  clock?: Clock;
  refreshBeforeSec?: number;
}

/**
 * aud ごとにキャッシュする ID トークンの取得（SO §3.9 の getIdToken）。
 * `exp − refreshBeforeSec > now` の間は同じトークンを返し、過ぎたら取り直す（SO-INT-07）。同じ aud の同時の取得は1回にまとめる
 */
export function createIdTokenSource(options: IdTokenSourceOptions = {}): IdTokenSource {
  const clock = options.clock ?? systemClock;
  const refreshBeforeMs = (options.refreshBeforeSec ?? ID_TOKEN_REFRESH_BEFORE_SEC) * 1000;
  let fetcher = options.fetchIdToken;
  const cache = new Map<string, { token: string; expMs: number }>();
  const inflight = new Map<string, Promise<string>>();

  const fetchFresh = async (audience: string): Promise<string> => {
    fetcher ??= googleIdTokenFetcher();
    const token = (await fetcher(audience)).trim();
    const exp = decodeJwtClaims(token)?.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) throw new Error("ID トークンの形が読めない（exp がない）");
    cache.set(audience, { token, expMs: exp * 1000 });
    return token;
  };

  return {
    async getIdToken(rawAudience) {
      const audience = normalizeAudience(rawAudience);
      if (audience === "") throw new Error("ID トークンの aud が空");
      const hit = cache.get(audience);
      if (hit && hit.expMs - refreshBeforeMs > clock.now().getTime()) return hit.token;
      const running = inflight.get(audience);
      if (running) return running;
      const p = fetchFresh(audience).finally(() => inflight.delete(audience));
      inflight.set(audience, p);
      return p;
    },
  };
}

// ---- 検証 ----

/** 受け手の決まり（SO §2.5 の InternalAuthPolicy） */
export interface InternalAuthPolicy {
  /** 受け手の run.app の URL（APP_INTERNAL_URL・GATEWAY_URL・SIM_WORLD_URL） */
  audience: string;
  /** 許す呼び出し元のサービスアカウント */
  allowedEmails: readonly string[];
  /**
   * 署名まで確かめるか（既定 true）。false は Cloud Run の IAM が署名を確かめ、コンテナに署名が届かないときだけ
   * （gateway・sim-world。SO §9 I-27：10/3 に確かめる）。app は allUsers で公開するので必ず true
   */
  verifySignature?: boolean;
}

/** ID トークンで確かめた呼び出し元（SO §2.5） */
export interface CallerIdentity {
  email: string;
  sub: string;
  audience: string;
}

/** 署名・exp・iss を確かめてクレームを返す（通らなければ throw）。既定は google-auth-library の OAuth2Client.verifyIdToken */
export type IdTokenSignatureVerifier = (idToken: string, audiences: readonly string[]) => Promise<IdTokenClaims>;

let defaultClient: OAuth2Client | undefined;

/** google-auth-library の検証（Google の公開鍵はクライアントの中でキャッシュされる） */
export function googleIdTokenVerifier(client?: OAuth2Client): IdTokenSignatureVerifier {
  return async (idToken, audiences) => {
    const c = client ?? (defaultClient ??= new OAuth2Client());
    const ticket = await c.verifyIdToken({ idToken, audience: [...audiences] });
    const payload = ticket.getPayload();
    if (!payload) throw new Error("ID トークンのペイロードがない");
    return payload as unknown as IdTokenClaims;
  };
}

export type IdTokenRejectReason =
  | "not_configured" // aud・許す email がない（設定の誤り。全部拒否）
  | "no_bearer"
  | "malformed_token"
  | "invalid_token" // 署名・期限など、検証器が通さなかった
  | "expired"
  | "issuer_mismatch"
  | "aud_mismatch"
  | "email_not_verified"
  | "email_not_allowed";

/** 拒否の理由と、分かれば email（SO §3.9：ログにだけ出す。応答には出さない） */
export type IdTokenCheck = { ok: true; identity: CallerIdentity } | { ok: false; reason: IdTokenRejectReason; email?: string };

export interface IdTokenVerifyDeps {
  /** 既定は googleIdTokenVerifier() */
  verifier?: IdTokenSignatureVerifier;
  clock?: Clock;
}

/** `Bearer <token>` の token。でなければ null */
export function bearerTokenOf(authorization: string | null | undefined): string | null {
  const m = /^Bearer[ ]+(\S+)$/i.exec(authorization?.trim() ?? "");
  return m?.[1] ?? null;
}

/** クレームの確認（署名の検証の前に早く落とすのにも、後の確認にも使う） */
function checkClaims(claims: IdTokenClaims, audiences: readonly string[], nowSec: number): IdTokenRejectReason | null {
  if (typeof claims.exp !== "number" || !(claims.exp > nowSec)) return "expired";
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) return "issuer_mismatch";
  if (typeof claims.aud !== "string" || !audiences.includes(claims.aud)) return "aud_mismatch";
  return null;
}

/**
 * Authorization の ID トークンを確かめ、理由つきで返す（SO §3.9 の verifyGoogleIdToken の手順）。
 * 1 Bearer でない → no_bearer。2 署名（verifySignature）・exp・iss・aud。3 email_verified === true かつ email が許す一覧にある。4 { email, sub, audience }
 */
export async function checkGoogleIdToken(
  authorization: string | null | undefined,
  policy: InternalAuthPolicy,
  deps: IdTokenVerifyDeps = {},
): Promise<IdTokenCheck> {
  const audience = normalizeAudience(policy.audience);
  const allowed = policy.allowedEmails.map((e) => e.trim().toLowerCase()).filter((e) => e !== "");
  if (audience === "" || allowed.length === 0) return { ok: false, reason: "not_configured" };
  // 取得側は末尾の / を除いた aud で取るが、付けて取ったトークンも同じサービス宛てとして受ける
  const audiences = [audience, `${audience}/`];

  const token = bearerTokenOf(authorization);
  if (token === null) return { ok: false, reason: "no_bearer" };
  const unverified = decodeJwtClaims(token);
  if (unverified === null) return { ok: false, reason: "malformed_token" };
  const nowSec = (deps.clock ?? systemClock).now().getTime() / 1000;
  // 署名を確かめる前に、期限・発行者・aud の外れは落とす（公開鍵の取得を減らし、ログの理由を細かくする）
  const early = checkClaims(unverified, audiences, nowSec);
  if (early !== null) return { ok: false, reason: early };

  let claims: IdTokenClaims;
  if (policy.verifySignature === false) {
    claims = unverified;
  } else {
    try {
      claims = await (deps.verifier ?? googleIdTokenVerifier())(token, audiences);
    } catch {
      return { ok: false, reason: "invalid_token" };
    }
    // 検証器が返したクレームでもう一度（偽の検証器・ライブラリの変化でも aud・期限が素通りしないように）
    const late = checkClaims(claims, audiences, nowSec);
    if (late !== null) return { ok: false, reason: late };
  }

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : null;
  if (claims.email_verified !== true) return { ok: false, reason: "email_not_verified", ...(email ? { email } : {}) };
  if (email === null || !allowed.includes(email)) return { ok: false, reason: "email_not_allowed", ...(email ? { email } : {}) };
  if (typeof claims.sub !== "string" || claims.sub === "") return { ok: false, reason: "malformed_token", email };
  return { ok: true, identity: { email, sub: claims.sub, audience: claims.aud as string } };
}

/** SO §3.9 の形（通らなければ null）。apps/sim-world の IdTokenVerifier にそのまま渡せる */
export async function verifyGoogleIdToken(
  authorization: string | null | undefined,
  policy: InternalAuthPolicy,
  deps: IdTokenVerifyDeps = {},
): Promise<CallerIdentity | null> {
  const r = await checkGoogleIdToken(authorization, policy, deps);
  return r.ok ? r.identity : null;
}
