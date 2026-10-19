// app の環境変数（security-ops-deploy.md §2.2・§3.1.1）。足りなくても起動は止めず「準備中」にする（D-47）。
// 名前だけを missing に積み、値は応答にもログにも出さない。読み方の共通は @open-team/platform の EnvReader。
// 決めたこと：
// - DATABASE_URL は local でも必須（セッションを DB に置いたため。SO §3.1.1 の「いつも必須」に足した）
// - local の GATEWAY_URL・SIM_WORLD_URL・INTERNAL_SHARED_TOKEN は任意（なければオーナーの初期投入と内部の呼び出しが止まるだけ）
// - PLATFORM_CEILINGS_VERSION は必須にしない（M-59：Hard Ceiling の版はコードの定数）

import { readGeminiEnv, type GeminiEnv } from "@open-team/llm";
import { EnvReader, readServiceAuthEnv, type DeploymentMode, type EnvCheck, type EnvSource, type ServiceAuthConfig } from "@open-team/platform";

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
  /** local＝ローカル（docker compose）、cloud＝Cloud Run（フェーズ0-H の公開デプロイ。SO の public と同じ） */
  deploymentMode: DeploymentMode;
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
  /** cloud では常に true（SO §3.1.1 の6） */
  cookieSecure: boolean;
  databaseUrl: string | undefined;
  /** 掃除（ot_retention）の接続（EP-48。次の段階） */
  databaseUrlMaint: string | undefined;
  appBaseUrl: string | undefined;
  /** 自分の /internal/* を呼ぶ先と ID トークンの aud（SO §2.2） */
  appInternalUrl: string | undefined;
  gatewayUrl: string | undefined;
  simWorldUrl: string | undefined;
  /** サービス間の認証（cloud：ID トークン、local：INTERNAL_SHARED_TOKEN） */
  serviceAuth: ServiceAuthConfig;
  gemini: GeminiEnv;
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

/**
 * 作業場の起こし方（SANDBOX_PROVIDER）：
 * - none（既定）：作業場を使わない
 * - cloudrun：Cloud Run Jobs（SANDBOX_JOB＝projects/…/locations/…/jobs/…、SANDBOX_EDGE_URL＝作業場が呼ぶ app の URL）
 * - docker：手元の Docker（SANDBOX_DOCKER_IMAGE・SANDBOX_EDGE_URL。SANDBOX_DOCKER_NETWORK は任意）
 * - inprocess：app と同じプロセス・同じ権限で動かす（隔離がないので local だけ。cloud では準備中にする）
 */
export interface SandboxEnv {
  provider: "none" | "cloudrun" | "docker" | "inprocess";
  job: string | undefined;
  edgeUrl: string | undefined;
  dockerImage: string | undefined;
  dockerNetwork: string | undefined;
}

export function readSandboxEnv(source: EnvSource, cloud: boolean, flag: (name: string) => void): SandboxEnv {
  const raw = source.SANDBOX_PROVIDER?.trim() ?? "";
  const provider = raw === "cloudrun" || raw === "docker" || raw === "inprocess" ? raw : "none";
  if (raw !== "" && raw !== provider) flag("SANDBOX_PROVIDER");
  // 隔離のない作業場を本番で使わない
  if (cloud && provider === "inprocess") flag("SANDBOX_PROVIDER");
  const job = optional(source.SANDBOX_JOB);
  const edgeUrl = normalizeHttpUrl(optional(source.SANDBOX_EDGE_URL));
  if (provider === "cloudrun" && (job === undefined || !/^projects\/[^/]+\/locations\/[^/]+\/jobs\/[^/]+$/.test(job))) flag("SANDBOX_JOB");
  if ((provider === "cloudrun" || provider === "docker") && edgeUrl === undefined) flag("SANDBOX_EDGE_URL");
  const dockerImage = optional(source.SANDBOX_DOCKER_IMAGE);
  if (provider === "docker" && dockerImage === undefined) flag("SANDBOX_DOCKER_IMAGE");
  return { provider, job, edgeUrl, dockerImage, dockerNetwork: optional(source.SANDBOX_DOCKER_NETWORK) };
}

/** 必須でない local のサービス間の共有トークン（無いときは設定ごと空にして、内部の呼び出しを全部拒む） */
const LOCAL_SHARED_TOKEN = "INTERNAL_SHARED_TOKEN";

export function readAppEnv(source: EnvSource = process.env): EnvCheck<AppEnv> {
  const r = new EnvReader(source);
  // いつも必須（並び順は既存の missingEnv のまま：SO-ENV-01）
  const ownerToken = r.secret("PHASE0_ACCESS_TOKEN", { required: true });
  const cookieSecret = r.secret("SESSION_COOKIE_SECRET", { required: true });
  const mode = r.deploymentMode();
  const cloud = mode === "cloud";
  const databaseUrl = r.string("DATABASE_URL", { required: true, pattern: /^postgres(ql)?:\/\// });

  // cloud だけ追加で必須（SO §3.1.1 の3 の順）
  const guestToken = r.secret("GUEST_ENTRY_TOKEN", { required: cloud });
  const databaseUrlMaint = r.string("DATABASE_URL_MAINT", { required: cloud, pattern: /^postgres(ql)?:\/\// });
  const appBaseUrl = r.url("APP_BASE_URL", { required: cloud, httpsOnly: cloud });
  // APP_INTERNAL_URL・APP_SA_EMAIL は cloud のサービス間の認証として readServiceAuthEnv が読む（aud と呼び出し元）
  let serviceAuth: ServiceAuthConfig;
  let appInternalUrl: string | undefined;
  if (cloud) {
    serviceAuth = readServiceAuthEnv(r, mode, { audienceVar: "APP_INTERNAL_URL", callers: ["sa-app"] });
    appInternalUrl = serviceAuth.mode === "cloud" ? serviceAuth.audience : undefined;
  } else {
    serviceAuth = r.has(LOCAL_SHARED_TOKEN) ? readServiceAuthEnv(r, mode) : { mode: "local", sharedToken: undefined };
    appInternalUrl = r.url("APP_INTERNAL_URL");
  }
  const gatewayUrl = r.url("GATEWAY_URL", { required: cloud, httpsOnly: cloud });
  const simWorldUrl = r.url("SIM_WORLD_URL", { required: cloud, httpsOnly: cloud });
  const gemini = readGeminiEnv(source as NodeJS.ProcessEnv);
  if (cloud) {
    r.string("GOOGLE_CLOUD_PROJECT", { required: true });
    r.string("GOOGLE_CLOUD_LOCATION", { required: true });
    r.string("GEMINI_MODEL_PLANNER", { required: true });
    r.string("GEMINI_MODEL_AGENT", { required: true });
  }
  const commitSha = r.string("COMMIT_SHA", { required: cloud, pattern: /^[0-9a-f]{7,40}$/ });

  if (cloud) {
    // 同じ値だと入口のトークンの種類を見分けられない（15:330）
    if (guestToken !== undefined && ownerToken !== undefined && guestToken === ownerToken) r.flag("GUEST_ENTRY_TOKEN");
    // Gemini は IAM で呼ぶ。鍵の経路を作らない（ADR-032、SO §3.1.1 の5）
    r.forbid("GEMINI_API_KEY");
    r.forbid("GOOGLE_API_KEY");
  }

  return r.done({
    deploymentMode: mode,
    appEnv: r.string("APP_ENV"),
    port: r.port(),
    webDist: r.string("WEB_DIST"),
    ownerToken,
    guestToken,
    cookieSecret,
    cookieSecure: cloud ? true : source.COOKIE_SECURE !== "false",
    databaseUrl,
    databaseUrlMaint,
    appBaseUrl,
    appInternalUrl,
    gatewayUrl,
    simWorldUrl,
    serviceAuth,
    gemini,
    guestRetestMode: source.GUEST_RETEST_MODE?.trim() === "gemini" ? "gemini" : "replay",
    commitSha,
    googleConnect: readGoogleConnectEnv(source, appBaseUrl),
    githubConnect: readGithubConnectEnv(source, appBaseUrl),
    sandbox: readSandboxEnv(source, cloud, (n) => r.flag(n)),
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
