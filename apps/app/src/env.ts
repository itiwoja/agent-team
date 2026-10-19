// app の環境変数（ローカル実行：pnpm dev・docker compose）。足りなくても起動は止めず「準備中」にする（D-47）。
// 名前だけを missing に積み、値は応答にもログにも出さない。読み方の共通は @open-team/platform の EnvReader。
// 決めたこと：
// - DATABASE_URL は必須（セッションを DB に置いたため）
// - GATEWAY_URL・SIM_WORLD_URL・INTERNAL_SHARED_TOKEN・GEMINI_API_KEY は任意（なければオーナーの初期投入・内部の呼び出し・LLM が止まるだけ）
// - PLATFORM_CEILINGS_VERSION は必須にしない（M-59：Hard Ceiling の版はコードの定数）

import { readLlmEnv, providerModelIdentity, type GeminiEnv, type LlmConfig } from "@open-team/llm";
import { EnvReader, readServiceAuthEnv, type EnvCheck, type EnvSource, type ServiceAuthConfig } from "@open-team/platform";

/** Google カレンダーの連携（16 §3.6）。どれか欠けるか不正なら undefined（「つなぐ」を出さない）。準備中の名前には積まない（画面全体は止めない） */
export interface GoogleConnectEnv {
  clientId: string;
  clientSecret: string;
  /** OAUTH_TOKEN_KEY（base64 の32バイト。refresh token の暗号化） */
  tokenKey: string;
  /** GCAL_URL（アダプターの origin。connector の url は これ + GCAL_MCP_PATH） */
  gcalUrl: string;
  /** リダイレクトの URI の基になる自分の公開 URL（APP_BASE_URL） */
  appBaseUrl: string;
}

/**
 * GitHub の連携（18 §3.6、D-119）。GitHub App のインストール画面へ送り、戻りの認可コードでインストールが本人のものかを確かめる。
 * どれか欠けるか不正なら undefined（「つなぐ」を出さない。準備中の名前には積まない）
 */
export interface GithubConnectEnv {
  /** GitHub App の Client ID・Client secret（利用者の認可コードの交換に使う。トークンは保存しない） */
  clientId: string;
  clientSecret: string;
  /** GitHub App の slug（インストール画面の URL：https://github.com/apps/<slug>/installations/new） */
  appSlug: string;
  /** GITHUB_URL（アダプターの origin。connector の url は これ + GITHUB_MCP_PATH） */
  githubUrl: string;
  /** リダイレクトの URI の基になる自分の公開 URL（APP_BASE_URL） */
  appBaseUrl: string;
  /** GitHub の画面（既定 https://github.com）と API（既定 https://api.github.com）。GitHub Enterprise・試験で差し替える */
  webBase: string;
  apiBase: string;
}

export interface AppEnv {
  /** ログのラベルだけ（SO C-21） */
  appEnv: string | undefined;
  port: number;
  webDist: string | undefined;
  /** PHASE0_ACCESS_TOKEN（オーナーの入口：D-06） */
  ownerToken: string | undefined;
  /** GUEST_ENTRY_TOKEN（審査用の入口。0-H のこの段階は準備中の扱い） */
  guestToken: string | undefined;
  /** SESSION_COOKIE_SECRET（IP の HMAC の鍵にも使う：AS 8-33、SO I-11） */
  cookieSecret: string | undefined;
  /** COOKIE_SECURE（既定 true。http の LAN などで使うときだけ "false"） */
  cookieSecure: boolean;
  databaseUrl: string | undefined;
  /** 掃除（ot_retention）の接続（EP-48。次の段階） */
  databaseUrlMaint: string | undefined;
  appBaseUrl: string | undefined;
  gatewayUrl: string | undefined;
  simWorldUrl: string | undefined;
  /** サービス間の認証（INTERNAL_SHARED_TOKEN） */
  serviceAuth: ServiceAuthConfig;
  gemini: GeminiEnv;
  /** Active provider. gemini retains model routing fields for legacy callers/tests. */
  llm?: LlmConfig;
  /** GUEST_RETEST_MODE：用意した依頼の再試験を台本で再現する（replay。既定）か、本物の Gemini で走らせる（gemini）か（D-101・D-104） */
  guestRetestMode: "replay" | "gemini";
  commitSha: string | undefined;
  /** Google カレンダーの連携（任意。揃っていれば「つなぐ」を出す） */
  googleConnect: GoogleConnectEnv | undefined;
  /** GitHub の連携（任意。揃っていれば「GitHub をつなぐ」を出す） */
  githubConnect: GithubConnectEnv | undefined;
  /** 作業場（サンドボックス。D-116）。provider が none なら作業場の道具を渡さない */
  sandbox: SandboxEnv;
}

export function agentModelIdentity(env: Pick<AppEnv, "gemini" | "llm">): string {
  return providerModelIdentity(env.llm, env.gemini.agentModel);
}

/**
 * 作業場の起こし方（SANDBOX_PROVIDER）：
 * - none（既定）：作業場を使わない
 * - docker：手元の Docker（SANDBOX_DOCKER_IMAGE・SANDBOX_EDGE_URL。SANDBOX_DOCKER_NETWORK は任意）
 * - inprocess：app と同じプロセス・同じ権限で動かす（隔離がない）
 */
export interface SandboxEnv {
  provider: "none" | "docker" | "inprocess";
  edgeUrl: string | undefined;
  dockerImage: string | undefined;
  dockerNetwork: string | undefined;
}

export function readSandboxEnv(source: EnvSource, flag: (name: string) => void): SandboxEnv {
  const raw = source.SANDBOX_PROVIDER?.trim() ?? "";
  const provider = raw === "docker" || raw === "inprocess" ? raw : "none";
  if (raw !== "" && raw !== provider) flag("SANDBOX_PROVIDER");
  const edgeUrl = normalizeHttpUrl(optional(source.SANDBOX_EDGE_URL));
  if (provider === "docker" && edgeUrl === undefined) flag("SANDBOX_EDGE_URL");
  const dockerImage = optional(source.SANDBOX_DOCKER_IMAGE);
  if (provider === "docker" && dockerImage === undefined) flag("SANDBOX_DOCKER_IMAGE");
  return { provider, edgeUrl, dockerImage, dockerNetwork: optional(source.SANDBOX_DOCKER_NETWORK) };
}

/** 必須でないサービス間の共有トークン（無いときは設定ごと空にして、内部の呼び出しを全部拒む） */
const LOCAL_SHARED_TOKEN = "INTERNAL_SHARED_TOKEN";

export function readAppEnv(source: EnvSource = process.env): EnvCheck<AppEnv> {
  const r = new EnvReader(source);
  // いつも必須（並び順は既存の missingEnv のまま：SO-ENV-01）
  const ownerToken = r.secret("PHASE0_ACCESS_TOKEN", { required: true });
  const cookieSecret = r.secret("SESSION_COOKIE_SECRET", { required: true });
  const databaseUrl = r.string("DATABASE_URL", { required: true, pattern: /^postgres(ql)?:\/\// });

  const guestToken = r.secret("GUEST_ENTRY_TOKEN");
  const databaseUrlMaint = r.string("DATABASE_URL_MAINT", { pattern: /^postgres(ql)?:\/\// });
  const appBaseUrl = r.url("APP_BASE_URL");
  const serviceAuth: ServiceAuthConfig = r.has(LOCAL_SHARED_TOKEN) ? readServiceAuthEnv(r) : { sharedToken: undefined };
  const gatewayUrl = r.url("GATEWAY_URL");
  const simWorldUrl = r.url("SIM_WORLD_URL");
  const llm = readLlmEnv(source as NodeJS.ProcessEnv);
  const gemini: GeminiEnv = { apiKey: llm.apiKey, agentModel: llm.agentModel, plannerModel: llm.plannerModel, compareModels: llm.compareModels };
  const commitSha = r.string("COMMIT_SHA", { pattern: /^[0-9a-f]{7,40}$/ });

  return r.done({
    appEnv: r.string("APP_ENV"),
    port: r.port(),
    webDist: r.string("WEB_DIST"),
    ownerToken,
    guestToken,
    cookieSecret,
    cookieSecure: source.COOKIE_SECURE !== "false",
    databaseUrl,
    databaseUrlMaint,
    appBaseUrl,
    gatewayUrl,
    simWorldUrl,
    serviceAuth,
    gemini,
    llm,
    guestRetestMode: source.GUEST_RETEST_MODE?.trim() === "gemini" ? "gemini" : "replay",
    commitSha,
    googleConnect: readGoogleConnectEnv(source, appBaseUrl),
    githubConnect: readGithubConnectEnv(source, appBaseUrl),
    sandbox: readSandboxEnv(source, (n) => r.flag(n)),
  });
}

const optional = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);

/** http(s) の URL を origin＋パス（末尾の / なし）にそろえる。不正なら undefined */
function normalizeHttpUrl(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  try {
    const u = new URL(v);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.search !== "" || u.hash !== "" || u.username || u.password) return undefined;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** 任意の Google 連携。欠けても・不正でも undefined（起動は止めない：D-47 の準備中の名前には積まない） */
export function readGoogleConnectEnv(source: EnvSource, appBaseUrl: string | undefined): GoogleConnectEnv | undefined {
  const clientId = optional(source.GOOGLE_OAUTH_CLIENT_ID);
  const clientSecret = optional(source.GOOGLE_OAUTH_CLIENT_SECRET);
  const tokenKey = optional(source.OAUTH_TOKEN_KEY);
  const gcalUrl = normalizeHttpUrl(optional(source.GCAL_URL));
  const base = normalizeHttpUrl(appBaseUrl);
  if (!clientId || !clientSecret || !tokenKey || !gcalUrl || !base) return undefined;
  // base64 の32バイト（44文字・= で終わる）。暗号の鍵の形を先に確かめる
  if (!/^[A-Za-z0-9+/]{43}=$/.test(tokenKey) || Buffer.from(tokenKey, "base64").length !== 32) return undefined;
  return { clientId, clientSecret, tokenKey, gcalUrl, appBaseUrl: base };
}

/** 任意の GitHub 連携（18 §3.6）。欠けても・不正でも undefined（起動は止めない） */
export function readGithubConnectEnv(source: EnvSource, appBaseUrl: string | undefined): GithubConnectEnv | undefined {
  const clientId = optional(source.GITHUB_APP_CLIENT_ID);
  const clientSecret = optional(source.GITHUB_APP_CLIENT_SECRET);
  const appSlug = optional(source.GITHUB_APP_SLUG);
  const githubUrl = normalizeHttpUrl(optional(source.GITHUB_URL));
  const base = normalizeHttpUrl(appBaseUrl);
  const webBase = normalizeHttpUrl(optional(source.GITHUB_WEB_BASE) ?? "https://github.com");
  const apiBase = normalizeHttpUrl(optional(source.GITHUB_API_BASE) ?? "https://api.github.com");
  if (!clientId || !clientSecret || !appSlug || !githubUrl || !base || !webBase || !apiBase) return undefined;
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(appSlug)) return undefined;
  return { clientId, clientSecret, appSlug, githubUrl, appBaseUrl: base, webBase, apiBase };
}
