// Google のログイン（OIDC の認可コードフロー＋PKCE）。HTTP の呼び出しは渡された fetch を使う（試験で差し替える）
// 決めたこと：
// - id_token は Google の token エンドポイントから TLS で直接受けたものだけを読む。OIDC の仕様どおり、この経路では署名は確かめず、
//   aud（クライアント ID）・iss・email_verified を確かめる（apps/app の connectors/google.ts と同じ考え方）
// - 失敗の理由は GoogleLoginError の code だけ。コード・トークンは例外にもログにも入れない

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const HTTP_TIMEOUT_MS = 10_000;

export interface GoogleLoginConfig {
  clientId: string;
  clientSecret: string;
  /** 戻り先（<APP_BASE_URL>/api/auth/google/callback） */
  redirectUri: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
}

export class GoogleLoginError extends Error {
  readonly code: "failed" | "unverified";
  constructor(code: "failed" | "unverified", message: string) {
    super(message);
    this.name = "GoogleLoginError";
    this.code = code;
  }
}

function base64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 推測できない文字列（state・PKCE の code_verifier） */
export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE の code_challenge（S256） */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function buildGoogleAuthUrl(cfg: GoogleLoginConfig, state: string, verifier: string): Promise<string> {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: await codeChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (part === undefined) throw new GoogleLoginError("failed", "id_token の形が違う");
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(json, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/** 認可コードを交換し、id_token から利用者を読む */
export async function exchangeGoogleCode(fetchFn: typeof fetch, cfg: GoogleLoginConfig, code: string, verifier: string): Promise<GoogleIdentity> {
  let res: Response;
  try {
    res = await fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: cfg.redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleLoginError("failed", "Google の token エンドポイントに届かなかった");
  }
  if (!res.ok) throw new GoogleLoginError("failed", `Google の token エンドポイントが ${res.status} を返した`);
  const body = (await res.json()) as { id_token?: unknown };
  if (typeof body.id_token !== "string") throw new GoogleLoginError("failed", "id_token がない");
  const p = decodeJwtPayload(body.id_token);
  if (p.aud !== cfg.clientId || typeof p.iss !== "string" || !GOOGLE_ISSUERS.has(p.iss)) {
    throw new GoogleLoginError("failed", "id_token の aud・iss が違う");
  }
  if (typeof p.sub !== "string" || typeof p.email !== "string") throw new GoogleLoginError("failed", "id_token に sub・email がない");
  if (p.email_verified !== true) throw new GoogleLoginError("unverified", "メールアドレスが確認されていない");
  return { sub: p.sub, email: p.email.toLowerCase(), name: typeof p.name === "string" ? p.name : null };
}

/** ALLOWED_EMAILS（カンマ区切り）にあるか。大文字小文字は区別しない。空なら誰も通さない */
export function isAllowedEmail(allowed: string | undefined, email: string): boolean {
  const list = (allowed ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x !== "");
  return list.includes(email.toLowerCase());
}
