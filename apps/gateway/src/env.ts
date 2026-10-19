// gateway の環境変数と起動時の確認（security-ops-deploy.md §2.2・§3.1.2、mcp-taint.md §3.12.1、BR-66、15:489）。
// 足りない・不正なら起動しない（gateway は画面を持たないので「準備中」にしない）。返すのは名前と理由だけで、秘密の値は出さない（D-47）。
// DEPLOYMENT_MODE は platform の読み方（public は cloud と同じ）。cloud＝公開デプロイ（0-H）、local＝docker compose（フェーズ0）

import { createPrivateKey } from "node:crypto";
import {
  EnvReader,
  readServiceAuthEnv,
  type DeploymentMode,
  type EnvSource,
  type ServiceAuthConfig,
} from "@open-team/platform";

/**
 * Google カレンダーのアダプター（16 §3.5・ADR-040）。GCAL_URL があるときだけ。秘密の値はここに入れたまま、ログには出さない
 */
export interface GcalConfig {
  /** GCAL_URL の正規化した値（ID トークンの aud。コネクタの URL はこの下の /mcp/gcal） */
  url: string;
  /** url の origin（コネクタの URL の origin と比べて、Google のコネクタだと判定する） */
  origin: string;
  clientId: string;
  clientSecret: string;
  /** refresh token を開く鍵（base64 の32バイト。platform の openSecret） */
  tokenKey: string;
  /** local だけ：アダプターを呼ぶ共有トークン（cloud は null。ID トークンを使う） */
  sharedToken: string | null;
}

/**
 * GitHub のアダプター（18 §3.5、D-119、ADR-002）。GITHUB_URL があるときだけ。
 * GitHub App の鍵（秘密鍵）は gateway だけが持ち、インストールのトークン（1時間）をそのつど作る。鍵の値はログに出さない
 */
export interface GithubConfig {
  /** GITHUB_URL の正規化した値（ID トークンの aud。コネクタの URL はこの下の /mcp/github） */
  url: string;
  origin: string;
  /** GitHub App の ID（JWT の iss） */
  appId: string;
  /** GitHub App の秘密鍵（PEM。RS256 で JWT に署名する） */
  privateKey: string;
  /** GitHub REST API の基底 URL（既定 https://api.github.com。末尾の / なし） */
  apiBase: string;
  /** local だけ：アダプターを呼ぶ共有トークン（cloud は null） */
  sharedToken: string | null;
}

export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

/** 環境変数の秘密鍵（改行を \n で書いたものも受ける）。PEM として読めなければ null */
export function normalizePrivateKey(raw: string): string | null {
  const pem = raw.includes("\\n") && !raw.includes("\n") ? raw.replace(/\\n/g, "\n") : raw;
  try {
    createPrivateKey(pem);
    return pem;
  } catch {
    return null;
  }
}

export interface GatewayEnv {
  deploymentMode: DeploymentMode;
  port: number;
  databaseUrl: string;
  /** 正規化した ALLOWED_CONNECTOR_URLS（BR-66）。cloud では全部 SIM_WORLD_URL と同じ origin。local の境界では使わない */
  allowedConnectorUrls: readonly string[];
  /** 正規化した SIM_WORLD_URL（cloud は必須。local は無ければ sim-world なし＝ゲスト・影・リハーサルは全部拒否） */
  simWorldUrl: string | null;
  /** 受ける側の呼び出し元の確認（sa-app だけ：15:483）。local は INTERNAL_SHARED_TOKEN、cloud は GATEWAY_URL・APP_SA_EMAIL */
  serviceAuth: ServiceAuthConfig;
  /** local で sim-world を呼ぶ共有トークン（SIM_WORLD_SHARED_TOKEN：compose.yaml・.env.example と同じ）。cloud は ID トークン */
  simWorldSharedToken: string | undefined;
  /** Google カレンダー（GCAL_URL があるときだけ。無ければ null＝「つなぐ」は使えない） */
  gcal: GcalConfig | null;
  /** GitHub（GITHUB_URL があるときだけ。無ければ null＝「つなぐ」は使えない） */
  github: GithubConfig | null;
  commitSha: string | undefined;
}

/** 起動を断る理由（名前と文。値は入れない） */
export class GatewayStartupError extends Error {
  readonly missing: readonly string[];
  readonly reasons: readonly string[];
  constructor(missing: readonly string[], reasons: readonly string[]) {
    super(`gateway を起動しない：${[...missing.map((m) => `足りない・不正な環境変数 ${m}`), ...reasons].join(" / ")}`);
    this.name = "GatewayStartupError";
    this.missing = [...missing];
    this.reasons = [...reasons];
  }
}

/**
 * コネクタの URL の正規化（SO §3.1.2 normalizeConnectorUrl）。不正なら throw。
 * 1 前後の空白を除いて URL として読む／2 cloud は https だけ（local は http も可）／3 認証情報・クエリ・# なし／
 * 4 cloud は既定のポートだけ（https の 443 は URL が空にする）／5 末尾の / を除く。返す形は `${protocol}//${host}${path}`。
 * local でポートを許すのは docker compose の http://localhost:8081 などのため（SO の 4 は公開デプロイの話と読んだ）
 */
export function normalizeConnectorUrl(raw: string, mode: DeploymentMode): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new TypeError("URL として読めない");
  }
  if (mode === "cloud" ? u.protocol !== "https:" : u.protocol !== "https:" && u.protocol !== "http:") {
    throw new TypeError(mode === "cloud" ? "公開デプロイは https だけ" : "http か https だけ");
  }
  if (u.username !== "" || u.password !== "") throw new TypeError("認証情報（user:pass@）を含む");
  if (u.search !== "" || u.hash !== "") throw new TypeError("クエリか # を含む");
  if (mode === "cloud" && u.port !== "") throw new TypeError("既定でないポート");
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** Cloud Run の決まった形の URL（<サービス>-<プロジェクト番号>.<リージョン>.run.app） */
const CLOUD_RUN_DETERMINISTIC_HOST = /^[a-z0-9-]+-(\d+)\.[a-z0-9-]+\.run\.app$/;

export interface AllowedConnectorInput {
  deploymentMode: DeploymentMode;
  /** ALLOWED_CONNECTOR_URLS をカンマで分けたもの（前後の空白・空はここで除く） */
  allowedConnectorUrls: readonly string[];
  simWorldUrl: string | null | undefined;
  /** 正規化済みの GCAL_URL（無ければ null。cloud の一覧にはこの origin も許す） */
  gcalUrl?: string | null;
  /** 正規化済みの GITHUB_URL（無ければ null。cloud の一覧にはこの origin も許す） */
  githubUrl?: string | null;
}

/**
 * 起動時の確認（SO §3.1.2 assertAllowedConnectorUrls、MT §3.12.1、BR-66・15:489）。外れたら GatewayStartupError。
 * 1 一覧のどれかが正規化できない → 断る（local も）
 * 2 cloud：SIM_WORLD_URL がない・不正、一覧が空、どれか1つでも origin が SIM_WORLD_URL・GCAL_URL・GITHUB_URL のどれとも違う → 断る（内部の URL だけ）。
 *   projectNumber を渡したとき、SIM_WORLD_URL が決まった形の run.app なら、その番号が自分のプロジェクトの番号であること（【提案】）
 * 3 local：一覧は確かめない（フェーズ0 は実のコネクタをつなぐ）
 * 返すのは正規化して重複を除いた一覧と SIM_WORLD_URL
 */
export function assertAllowedConnectorUrls(
  input: AllowedConnectorInput,
  opts: { projectNumber?: string | null } = {},
): { allowedConnectorUrls: string[]; simWorldUrl: string | null } {
  const mode = input.deploymentMode;
  const reasons: string[] = [];
  const allowed: string[] = [];
  for (const raw of input.allowedConnectorUrls.map((s) => s.trim()).filter((s) => s !== "")) {
    try {
      const n = normalizeConnectorUrl(raw, mode);
      if (!allowed.includes(n)) allowed.push(n);
    } catch (e) {
      reasons.push(`ALLOWED_CONNECTOR_URLS に正規化できない URL がある（${(e as Error).message}）`);
    }
  }
  let simWorldUrl: string | null = null;
  const simRaw = input.simWorldUrl?.trim();
  if (simRaw) {
    try {
      simWorldUrl = normalizeConnectorUrl(simRaw, mode);
    } catch (e) {
      reasons.push(`SIM_WORLD_URL が不正（${(e as Error).message}）`);
    }
  }
  if (mode === "cloud") {
    if (!simRaw) reasons.push("SIM_WORLD_URL がない（公開デプロイでは必須）");
    if (allowed.length === 0 && reasons.every((r) => !r.startsWith("ALLOWED_CONNECTOR_URLS"))) {
      reasons.push("ALLOWED_CONNECTOR_URLS が空（公開デプロイでは sim-world と GCAL_URL の URL だけを入れる）");
    }
    if (simWorldUrl !== null) {
      const simOrigin = new URL(simWorldUrl).origin;
      const gcalOrigin = input.gcalUrl ? new URL(input.gcalUrl).origin : null;
      const githubOrigin = input.githubUrl ? new URL(input.githubUrl).origin : null;
      for (const a of allowed) {
        const o = new URL(a).origin;
        if (o !== simOrigin && o !== gcalOrigin && o !== githubOrigin) {
          reasons.push(`ALLOWED_CONNECTOR_URLS に sim-world 以外（GCAL_URL・GITHUB_URL 以外）の URL がある：${o}`);
        }
      }
      const m = CLOUD_RUN_DETERMINISTIC_HOST.exec(new URL(simWorldUrl).hostname);
      if (m && opts.projectNumber != null && m[1] !== opts.projectNumber) {
        reasons.push("SIM_WORLD_URL のプロジェクト番号が自分のプロジェクトと違う");
      }
    }
  }
  if (reasons.length > 0) throw new GatewayStartupError([], reasons);
  return { allowedConnectorUrls: allowed, simWorldUrl };
}

/** SIM_WORLD_URL がプロジェクト番号の入った決まった形の run.app か（server.ts がメタデータを引くかを決める） */
export function simWorldUrlNeedsProjectNumber(simWorldUrl: string | null): boolean {
  if (!simWorldUrl) return false;
  try {
    return CLOUD_RUN_DETERMINISTIC_HOST.test(new URL(simWorldUrl).hostname);
  } catch {
    return false;
  }
}

/** 自分のプロジェクトの番号（Cloud Run のメタデータサーバー）。読めなければ null */
export async function readProjectNumber(fetchImpl: typeof fetch = fetch, timeoutMs = 2_000): Promise<string | null> {
  try {
    const res = await fetchImpl("http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id", {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return /^\d{1,20}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

/**
 * 環境変数を読む（SO §2.2 の GatewayEnv）。足りない・不正な名前（missing）と、起動時の確認（BR-66）の理由（reasons）を返す。
 * 必須：DATABASE_URL。local は INTERNAL_SHARED_TOKEN（受ける側）と、SIM_WORLD_URL があれば SIM_WORLD_SHARED_TOKEN（sim-world を呼ぶ側）。
 * cloud は GATEWAY_URL（aud）・APP_SA_EMAIL・SIM_WORLD_URL・ALLOWED_CONNECTOR_URLS。CONNECTOR_ENC_KEY は置かない（BR-66・D-11）。
 * PLATFORM_CEILINGS_VERSION はコードの定数なので読まない（M-59）
 */
export function readGatewayEnv(
  source: EnvSource = process.env,
  opts: { projectNumber?: string | null } = {},
): { env: GatewayEnv | null; missing: string[]; reasons: string[] } {
  const r = new EnvReader(source);
  const mode = r.deploymentMode();
  const port = r.port();
  const databaseUrl = r.string("DATABASE_URL", { required: true });
  const serviceAuth = readServiceAuthEnv(r, mode, { audienceVar: "GATEWAY_URL", callers: ["sa-app"] });
  const simRaw = r.string("SIM_WORLD_URL", { required: mode === "cloud" });
  const allowedRaw = r.list("ALLOWED_CONNECTOR_URLS", { required: mode === "cloud" });
  const simWorldSharedToken = mode === "local" && simRaw !== undefined ? r.secret("SIM_WORLD_SHARED_TOKEN", { required: true }) : undefined;
  if (mode === "cloud") r.forbid("CONNECTOR_ENC_KEY");

  // Google カレンダー（16 §3.5）：GCAL_URL があるときだけ、残りの秘密・鍵を必須にする
  const reasons: string[] = [];
  const gcalRaw = r.string("GCAL_URL");
  let gcalUrl: string | null = null;
  if (gcalRaw !== undefined) {
    try {
      gcalUrl = normalizeConnectorUrl(gcalRaw, mode);
    } catch (e) {
      r.flag("GCAL_URL");
      reasons.push(`GCAL_URL が不正（${(e as Error).message}）`);
    }
  }
  const gcalClientId = gcalUrl !== null ? r.string("GOOGLE_OAUTH_CLIENT_ID", { required: true }) : undefined;
  const gcalClientSecret = gcalUrl !== null ? r.secret("GOOGLE_OAUTH_CLIENT_SECRET", { required: true }) : undefined;
  const tokenKeyRaw = gcalUrl !== null ? r.string("OAUTH_TOKEN_KEY", { required: true }) : undefined;
  let tokenKey: string | undefined;
  if (tokenKeyRaw !== undefined) {
    if (Buffer.from(tokenKeyRaw, "base64").length === 32) tokenKey = tokenKeyRaw;
    else r.flag("OAUTH_TOKEN_KEY");
  }
  const gcalSharedToken = gcalUrl !== null && mode === "local" ? r.secret("GCAL_SHARED_TOKEN", { required: true }) : undefined;

  // GitHub（18 §3.5）：GITHUB_URL があるときだけ、GitHub App の ID と鍵を必須にする
  const githubRaw = r.string("GITHUB_URL");
  let githubUrl: string | null = null;
  if (githubRaw !== undefined) {
    try {
      githubUrl = normalizeConnectorUrl(githubRaw, mode);
    } catch (e) {
      r.flag("GITHUB_URL");
      reasons.push(`GITHUB_URL が不正（${(e as Error).message}）`);
    }
  }
  const githubAppId = githubUrl !== null ? r.string("GITHUB_APP_ID", { required: true }) : undefined;
  if (githubAppId !== undefined && !/^[0-9]{1,20}$/.test(githubAppId)) r.flag("GITHUB_APP_ID");
  // PEM は末尾の改行を含むことが多いので secret（前後の空白を断る）ではなく string で読み、PEM として読めるかで確かめる
  const githubKeyRaw = githubUrl !== null ? r.string("GITHUB_APP_PRIVATE_KEY", { required: true }) : undefined;
  let githubPrivateKey: string | undefined;
  if (githubKeyRaw !== undefined) {
    const k = normalizePrivateKey(githubKeyRaw);
    if (k === null) r.flag("GITHUB_APP_PRIVATE_KEY");
    else githubPrivateKey = k;
  }
  const githubApiBase = githubUrl !== null ? (r.url("GITHUB_API_BASE") ?? DEFAULT_GITHUB_API_BASE).replace(/\/+$/, "") : DEFAULT_GITHUB_API_BASE;
  const githubSharedToken = githubUrl !== null && mode === "local" ? r.secret("GITHUB_SHARED_TOKEN", { required: true }) : undefined;
  const commitSha = r.string("COMMIT_SHA");

  let urls: { allowedConnectorUrls: string[]; simWorldUrl: string | null } = { allowedConnectorUrls: [], simWorldUrl: null };
  try {
    urls = assertAllowedConnectorUrls({ deploymentMode: mode, allowedConnectorUrls: allowedRaw, simWorldUrl: simRaw, gcalUrl, githubUrl }, opts);
  } catch (e) {
    if (!(e instanceof GatewayStartupError)) throw e;
    reasons.push(...e.reasons);
  }
  const missing = r.missing;
  if (missing.length > 0 || reasons.length > 0 || databaseUrl === undefined) return { env: null, missing, reasons };
  const gcal: GcalConfig | null =
    gcalUrl !== null && gcalClientId !== undefined && gcalClientSecret !== undefined && tokenKey !== undefined
      ? {
          url: gcalUrl,
          origin: new URL(gcalUrl).origin,
          clientId: gcalClientId,
          clientSecret: gcalClientSecret,
          tokenKey,
          sharedToken: gcalSharedToken ?? null,
        }
      : null;
  const github: GithubConfig | null =
    githubUrl !== null && githubAppId !== undefined && githubPrivateKey !== undefined
      ? {
          url: githubUrl,
          origin: new URL(githubUrl).origin,
          appId: githubAppId,
          privateKey: githubPrivateKey,
          apiBase: githubApiBase,
          sharedToken: githubSharedToken ?? null,
        }
      : null;
  return {
    env: {
      deploymentMode: mode,
      port,
      databaseUrl,
      allowedConnectorUrls: urls.allowedConnectorUrls,
      simWorldUrl: urls.simWorldUrl,
      serviceAuth,
      simWorldSharedToken,
      gcal,
      github,
      commitSha,
    },
    missing,
    reasons,
  };
}

/** 起動時の確認（SO §3.1.2）。外れたら GatewayStartupError（server.ts が CRITICAL のログ gateway.startup_refused を出して exit 1） */
export function assertGatewayEnv(source: EnvSource = process.env, opts: { projectNumber?: string | null } = {}): GatewayEnv {
  const { env, missing, reasons } = readGatewayEnv(source, opts);
  if (env === null) throw new GatewayStartupError(missing, reasons);
  return env;
}
