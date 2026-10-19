// Google カレンダーの接続の道具（16 §2・§3.6、ADR-040）。HTTP の呼び出しは deps の fetch を使う（試験で差し替える）
// 決めたこと：
// - トークンの交換の応答（id_token を含む）は Google の token エンドポイントから TLS で直接受けたもの。OIDC の仕様どおり、
//   id_token の署名は確かめず、sub と email だけを読む（ここで受けた以外の経路の id_token は使わない）
// - 失敗の理由は GoogleConnectError の code（"denied"・"scope"・"failed"）だけ。トークン・コードは例外にもログにも入れない

import { GCAL_CALENDAR_SUMMARY, GCAL_REQUIRED_SCOPES, GCAL_SCOPES } from "@open-team/gcal-core";
import type { GoogleConnectEnv } from "../env.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";
/** 既定の時間帯（tz が不正なとき） */
export const DEFAULT_TIME_ZONE = "Asia/Tokyo";
/** state と時間帯を入れる Cookie の名前（10分。path は callback だけに届くよう絞る） */
export const GCAL_STATE_COOKIE = "ot_gcal_state";
export const GCAL_STATE_COOKIE_PATH = "/api/v1/connect/google";
export const GCAL_STATE_MAX_AGE_SEC = 10 * 60;
const HTTP_TIMEOUT_MS = 10_000;

export type GoogleFetch = typeof fetch;

export class GoogleConnectError extends Error {
  /** 画面に返す理由（失敗の内訳は出さない） */
  readonly code: "scope" | "failed";
  constructor(code: "scope" | "failed", message: string) {
    super(message);
    this.name = "GoogleConnectError";
    this.code = code;
  }
}

/** IANA のタイムゾーンか（Intl が受けるか）。違えば既定 */
export function timeZoneOrDefault(tz: string | undefined): string {
  if (!tz || tz.length > 64) return DEFAULT_TIME_ZONE;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function googleRedirectUri(env: GoogleConnectEnv): string {
  return `${env.appBaseUrl}/api/v1/connect/google/callback`;
}

/** 同意画面の URL（16 §3.6：access_type=offline・prompt=consent・include_granted_scopes=false） */
export function buildGoogleAuthUrl(env: GoogleConnectEnv, state: string): string {
  const q = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: googleRedirectUri(env),
    response_type: "code",
    scope: GCAL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  idToken: string | null;
}

async function postForm(fetchFn: GoogleFetch, url: string, body: Record<string, string>): Promise<Response> {
  return fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

/** code をトークンに替える（失敗は "failed"。応答の中身は出さない） */
export async function exchangeGoogleCode(fetchFn: GoogleFetch, env: GoogleConnectEnv, code: string): Promise<GoogleTokens> {
  const res = await postForm(fetchFn, GOOGLE_TOKEN_URL, {
    code,
    client_id: env.clientId,
    client_secret: env.clientSecret,
    redirect_uri: googleRedirectUri(env),
    grant_type: "authorization_code",
  });
  if (!res.ok) throw new GoogleConnectError("failed", `token 交換に失敗（${res.status}）`);
  const json = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; scope?: unknown; id_token?: unknown };
  if (typeof json.access_token !== "string" || json.access_token === "") throw new GoogleConnectError("failed", "access_token がない");
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" && json.refresh_token !== "" ? json.refresh_token : null,
    scopes: typeof json.scope === "string" ? json.scope.split(" ").filter((s) => s !== "") : [],
    idToken: typeof json.id_token === "string" ? json.id_token : null,
  };
}

/** 必須の scope が全部あるか（16 §3.6。足りなければ "scope"） */
export function requireScopes(granted: readonly string[]): void {
  const set = new Set(granted);
  if (!GCAL_REQUIRED_SCOPES.every((s) => set.has(s))) throw new GoogleConnectError("scope", "必要な権限がそろっていない");
}

/** id_token の payload から sub と email を読む（署名は確かめない。上のコメントを参照） */
export function idTokenIdentity(idToken: string | null): { sub: string; email: string } {
  if (!idToken) throw new GoogleConnectError("failed", "id_token がない");
  const part = idToken.split(".")[1];
  if (!part) throw new GoogleConnectError("failed", "id_token の形が違う");
  let claims: { sub?: unknown; email?: unknown };
  try {
    claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { sub?: unknown; email?: unknown };
  } catch {
    throw new GoogleConnectError("failed", "id_token の中身が読めない");
  }
  if (typeof claims.sub !== "string" || claims.sub === "" || typeof claims.email !== "string" || claims.email === "") {
    throw new GoogleConnectError("failed", "id_token に sub・email がない");
  }
  return { sub: claims.sub, email: claims.email.toLowerCase() };
}

/** Makase のカレンダーを作る（calendar.app.created の範囲。作ったものの ID を返す） */
export async function createMakaseCalendar(fetchFn: GoogleFetch, accessToken: string, timeZone: string): Promise<string> {
  const res = await fetchFn(`${GOOGLE_CALENDAR_API_URL}/calendars`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ summary: GCAL_CALENDAR_SUMMARY, timeZone }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new GoogleConnectError("failed", `カレンダーを作れなかった（${res.status}）`);
  const json = (await res.json()) as { id?: unknown };
  if (typeof json.id !== "string" || json.id === "") throw new GoogleConnectError("failed", "カレンダーの ID がない");
  return json.id;
}

/** Google 側の取り消し（best effort。失敗は呼び出し側が無視する） */
export async function revokeGoogleToken(fetchFn: GoogleFetch, token: string): Promise<boolean> {
  try {
    const res = await postForm(fetchFn, GOOGLE_REVOKE_URL, { token });
    return res.ok;
  } catch {
    return false;
  }
}
