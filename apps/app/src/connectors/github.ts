// GitHub の接続の道具（18 §2・§3.6、D-119）。HTTP の呼び出しは deps の fetch を使う（試験で差し替える）
// 決めたこと：
// - 「つなぐ」は GitHub App のインストール画面へ送る（どのリポジトリを任せるかは利用者が GitHub の画面で選ぶ）。
//   すでに入れている人は認可の画面（login/oauth/authorize）へ送る（mode=authorize）
// - 戻りの認可コードで利用者のトークンを得て、GET /user と GET /user/installations で「そのインストールを本人が使える」ことを確かめる。
//   URL の installation_id はそのままでは信じない（他人のインストールの ID を入れられるため）
// - 利用者のトークンは確かめたら取り消す（保存しない）。リポジトリを触るのは gateway が App の鍵で作るインストールのトークンだけ
// - 失敗の理由は GithubConnectError の code だけ。トークン・コードは例外にもログにも入れない

import type { GithubConnectEnv } from "../env.ts";

/** state を入れる Cookie の名前（10分。path は callback だけに届くよう絞る） */
export const GITHUB_STATE_COOKIE = "ot_github_state";
export const GITHUB_STATE_COOKIE_PATH = "/api/v1/connect/github";
export const GITHUB_STATE_MAX_AGE_SEC = 10 * 60;
const HTTP_TIMEOUT_MS = 10_000;

export class GithubConnectError extends Error {
  /** 画面に返す理由（not_installed：本人が使えるインストールがない） */
  readonly code: "not_installed" | "failed";
  constructor(code: "not_installed" | "failed", message: string) {
    super(message);
    this.name = "GithubConnectError";
    this.code = code;
  }
}

export function githubRedirectUri(env: GithubConnectEnv): string {
  return `${env.appBaseUrl}/api/v1/connect/github/callback`;
}

/** インストールの画面（入れる・対象のリポジトリを選ぶ）。終わると GitHub が callback に code・installation_id・state を付けて戻す */
export function buildGithubInstallUrl(env: GithubConnectEnv, state: string): string {
  return `${env.webBase}/apps/${encodeURIComponent(env.appSlug)}/installations/new?${new URLSearchParams({ state }).toString()}`;
}

/** 認可の画面（すでに入れている人。インストールは変えずに本人を確かめる） */
export function buildGithubAuthorizeUrl(env: GithubConnectEnv, state: string): string {
  const q = new URLSearchParams({ client_id: env.clientId, redirect_uri: githubRedirectUri(env), state });
  return `${env.webBase}/login/oauth/authorize?${q.toString()}`;
}

/** code を利用者のトークンに替える（失敗は "failed"。応答の中身は出さない） */
export async function exchangeGithubCode(fetchFn: typeof fetch, env: GithubConnectEnv, code: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(`${env.webBase}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, code, redirect_uri: githubRedirectUri(env) }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new GithubConnectError("failed", "token 交換に届かなかった");
  }
  if (!res.ok) throw new GithubConnectError("failed", `token 交換に失敗（${res.status}）`);
  const json = (await res.json().catch(() => ({}))) as { access_token?: unknown };
  // GitHub は失敗も 200 で { error } を返す
  if (typeof json.access_token !== "string" || json.access_token === "") throw new GithubConnectError("failed", "access_token がない");
  return json.access_token;
}

async function apiGet(fetchFn: typeof fetch, env: GithubConnectEnv, token: string, path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${env.apiBase}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "open-team-app" },
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new GithubConnectError("failed", `${path} に届かなかった`);
  }
  if (!res.ok) throw new GithubConnectError("failed", `${path} が ${res.status}`);
  return res.json();
}

export interface GithubIdentity {
  /** GitHub の利用者の固定の ID（数字の文字列） */
  id: string;
  login: string;
}

export async function githubUser(fetchFn: typeof fetch, env: GithubConnectEnv, token: string): Promise<GithubIdentity> {
  const u = (await apiGet(fetchFn, env, token, "/user")) as { id?: unknown; login?: unknown };
  if (typeof u.id !== "number" || typeof u.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(u.login)) throw new GithubConnectError("failed", "利用者を読めない");
  return { id: String(u.id), login: u.login };
}

export interface UserInstallation {
  id: number;
  accountLogin: string;
}

/** 利用者が使える、この App のインストール（利用者のトークンで見えるものだけ） */
export async function userInstallations(fetchFn: typeof fetch, env: GithubConnectEnv, token: string): Promise<UserInstallation[]> {
  const j = (await apiGet(fetchFn, env, token, "/user/installations?per_page=100")) as {
    installations?: Array<{ id?: unknown; app_slug?: unknown; account?: { login?: unknown } | null }>;
  };
  return (j.installations ?? [])
    .filter((i) => i.app_slug === undefined || i.app_slug === env.appSlug)
    .flatMap((i) =>
      typeof i.id === "number" && Number.isSafeInteger(i.id) && i.id > 0 && typeof i.account?.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(i.account.login)
        ? [{ id: i.id, accountLogin: i.account.login }]
        : [],
    );
}

/**
 * つなぐインストールを選ぶ。URL の installation_id は、本人が使えるものの中にあるときだけ使う。
 * 無ければ：本人のアカウントのもの → 1つだけならそれ。どれも無ければ not_installed
 */
export function chooseInstallation(installs: readonly UserInstallation[], requested: string | undefined, user: GithubIdentity): UserInstallation {
  if (requested !== undefined && /^[0-9]{1,20}$/.test(requested)) {
    const hit = installs.find((i) => String(i.id) === requested);
    if (hit) return hit;
  }
  const own = installs.find((i) => i.accountLogin.toLowerCase() === user.login.toLowerCase());
  if (own) return own;
  if (installs.length === 1) return installs[0]!;
  if (installs.length === 0) throw new GithubConnectError("not_installed", "使えるインストールがない");
  // 組織のインストールが複数あって選べない：先頭（利用者は GitHub の画面で絞れる）
  return installs[0]!;
}

/** 利用者のトークンを取り消す（best effort。保存しないので、確かめたらすぐ捨てる） */
export async function revokeGithubUserToken(fetchFn: typeof fetch, env: GithubConnectEnv, token: string): Promise<boolean> {
  try {
    const res = await fetchFn(`${env.apiBase}/applications/${encodeURIComponent(env.clientId)}/token`, {
      method: "DELETE",
      headers: {
        authorization: `Basic ${Buffer.from(`${env.clientId}:${env.clientSecret}`).toString("base64")}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "open-team-app",
      },
      body: JSON.stringify({ access_token: token }),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 利用者が対象のリポジトリを変える・アンインストールする GitHub の画面 */
export function githubInstallationSettingsUrl(env: GithubConnectEnv, installationId: string): string {
  return `${env.webBase}/settings/installations/${encodeURIComponent(installationId)}`;
}
