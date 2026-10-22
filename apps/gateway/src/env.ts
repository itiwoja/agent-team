// gateway の環境変数と起動時の確認（security-ops-deploy.md §2.2・§3.1.2、mcp-taint.md §3.12.1、BR-66、15:489）。
// 足りない・不正なら起動しない（gateway は画面を持たないので「準備中」にしない）。返すのは名前と理由だけで、秘密の値は出さない（D-47）。
// 動かし方はローカルだけ（pnpm dev + docker compose）

import { createPrivateKey } from "node:crypto";
import {
  EnvReader,
  readServiceAuthEnv,
  type EnvSource,
  type ServiceAuthConfig,
} from "@open-team/platform";

/**
 * Google カレンダーのアダプター（16 §3.5・ADR-040）。GCAL_URL があるときだけ。秘密の値はここに入れたまま、ログには出さない
 */
export interface GcalConfig {
  /** GCAL_URL の正規化した値（コネクタの URL はこの下の /mcp/gcal） */
  url: string;
  /** url の origin（コネクタの URL の origin と比べて、Google のコネクタだと判定する） */
  origin: string;
  clientId: string;
  clientSecret: string;
  /** refresh token を開く鍵（base64 の32バイト。platform の openSecret） */
  tokenKey: string;
  /** アダプターを呼ぶ共有トークン */
  sharedToken: string | null;
}

/**
 * GitHub のアダプター（18 §3.5、D-119、ADR-002）。GITHUB_URL があるときだけ。
 * GitHub App の鍵（秘密鍵）は gateway だけが持ち、インストールのトークン（1時間）をそのつど作る。鍵の値はログに出さない
 */
export interface GithubConfig {
  /** GITHUB_URL の正規化した値（コネクタの URL はこの下の /mcp/github） */
  url: string;
  origin: string;
  /** GitHub App の ID（JWT の iss） */
  appId: string;
  /** GitHub App の秘密鍵（PEM。RS256 で JWT に署名する） */
  privateKey: string;
  /** GitHub REST API の基底 URL（既定 https://api.github.com。末尾の / なし） */
  apiBase: string;
  /** アダプターを呼ぶ共有トークン */
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
  port: number;
  databaseUrl: string;
  /** 正規化した ALLOWED_CONNECTOR_URLS（BR-66） */
  allowedConnectorUrls: readonly string[];
  /** 受ける側の呼び出し元の確認（sa-app だけ：15:483）。INTERNAL_SHARED_TOKEN */
  serviceAuth: ServiceAuthConfig;
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
 * 1 前後の空白を除いて URL として読む／2 http か https だけ／3 認証情報・クエリ・# なし／4 末尾の / を除く。
 * 返す形は `${protocol}//${host}${path}`。ポートは許す（docker compose の http://localhost:8081 などのため）
 */
export function normalizeConnectorUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new TypeError("URL として読めない");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError("http か https だけ");
  if (u.username !== "" || u.password !== "") throw new TypeError("認証情報（user:pass@）を含む");
  if (u.search !== "" || u.hash !== "") throw new TypeError("クエリか # を含む");
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

export interface AllowedConnectorInput {
  /** ALLOWED_CONNECTOR_URLS をカンマで分けたもの（前後の空白・空はここで除く） */
  allowedConnectorUrls: readonly string[];
}

/**
 * 起動時の確認（SO §3.1.2 assertAllowedConnectorUrls、MT §3.12.1、BR-66）。外れたら GatewayStartupError。
 * 一覧のどれかが正規化できない → 断る。一覧の中身は確かめない（実のコネクタをつなぐ）
 * 返すのは正規化して重複を除いた一覧
 */
export function assertAllowedConnectorUrls(input: AllowedConnectorInput): { allowedConnectorUrls: string[] } {
  const reasons: string[] = [];
  const allowed: string[] = [];
  for (const raw of input.allowedConnectorUrls.map((s) => s.trim()).filter((s) => s !== "")) {
    try {
      const n = normalizeConnectorUrl(raw);
      if (!allowed.includes(n)) allowed.push(n);
    } catch (e) {
      reasons.push(`ALLOWED_CONNECTOR_URLS に正規化できない URL がある（${(e as Error).message}）`);
    }
  }
  if (reasons.length > 0) throw new GatewayStartupError([], reasons);
  return { allowedConnectorUrls: allowed };
}

/**
 * 環境変数を読む（SO §2.2 の GatewayEnv）。足りない・不正な名前（missing）と、起動時の確認（BR-66）の理由（reasons）を返す。
 * 必須：DATABASE_URL・INTERNAL_SHARED_TOKEN（受ける側）。
 * PLATFORM_CEILINGS_VERSION はコードの定数なので読まない（M-59）
 */
export function readGatewayEnv(source: EnvSource = process.env): { env: GatewayEnv | null; missing: string[]; reasons: string[] } {
  const r = new EnvReader(source);
  const port = r.port();
  const databaseUrl = r.string("DATABASE_URL", { required: true });
  const serviceAuth = readServiceAuthEnv(r);
  const allowedRaw = r.list("ALLOWED_CONNECTOR_URLS");

  // Google カレンダー（16 §3.5）：GCAL_URL があるときだけ、残りの秘密・鍵を必須にする
  const reasons: string[] = [];
  const gcalRaw = r.string("GCAL_URL");
  let gcalUrl: string | null = null;
  if (gcalRaw !== undefined) {
    try {
      gcalUrl = normalizeConnectorUrl(gcalRaw);
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
  const gcalSharedToken = gcalUrl !== null ? r.secret("GCAL_SHARED_TOKEN", { required: true }) : undefined;

  // GitHub（18 §3.5）：GITHUB_URL があるときだけ、GitHub App の ID と鍵を必須にする
  const githubRaw = r.string("GITHUB_URL");
  let githubUrl: string | null = null;
  if (githubRaw !== undefined) {
    try {
      githubUrl = normalizeConnectorUrl(githubRaw);
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
  const githubSharedToken = githubUrl !== null ? r.secret("GITHUB_SHARED_TOKEN", { required: true }) : undefined;
  const commitSha = r.string("COMMIT_SHA");

  let urls: { allowedConnectorUrls: string[] } = { allowedConnectorUrls: [] };
  try {
    urls = assertAllowedConnectorUrls({ allowedConnectorUrls: allowedRaw });
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
      port,
      databaseUrl,
      allowedConnectorUrls: urls.allowedConnectorUrls,
      serviceAuth,
      gcal,
      github,
      commitSha,
    },
    missing,
    reasons,
  };
}

/** 起動時の確認（SO §3.1.2）。外れたら GatewayStartupError（server.ts が CRITICAL のログ gateway.startup_refused を出して exit 1） */
export function assertGatewayEnv(source: EnvSource = process.env): GatewayEnv {
  const { env, missing, reasons } = readGatewayEnv(source);
  if (env === null) throw new GatewayStartupError(missing, reasons);
  return env;
}
