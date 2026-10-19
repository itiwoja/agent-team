// 環境変数の読み込み（security-ops-deploy.md §2.2・§3.1.3、18 §3.2）。読み方は packages/platform の EnvReader（gcal と同じ）。
// 足りない・不正な変数の「名前」だけを返す（値は出さない：D-47）。足りなければ server.ts は起動しない。
// 呼び出し元の確かめは gateway だけ（sa-gateway）。cloud の aud は GITHUB_URL

import { EnvReader, type DeploymentMode, type EnvCheck, type EnvSource, type ServiceAuthConfig } from "@open-team/platform";

/** GitHub REST API の既定の基底 URL（試験では GITHUB_API_BASE で差し替える） */
export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

export interface GithubEnv {
  deploymentMode: DeploymentMode;
  port: number;
  /** local：GITHUB_SHARED_TOKEN（gateway と共有する呼び出し元のトークン） */
  sharedToken: string | undefined;
  /** cloud：GITHUB_URL（ID トークンの aud。https・末尾の / なし） */
  selfUrl: string | undefined;
  /** cloud：GATEWAY_SA_EMAIL（呼べるのは sa-gateway だけ。小文字） */
  gatewaySaEmail: string | undefined;
  /** GitHub REST API の基底 URL（末尾の / なし） */
  githubApiBase: string;
  commitSha: string | undefined;
}

export function readGithubEnv(source: EnvSource = process.env): EnvCheck<GithubEnv> {
  const r = new EnvReader(source);
  const deploymentMode = r.deploymentMode();
  const port = r.port();
  const sharedToken = deploymentMode === "local" ? r.secret("GITHUB_SHARED_TOKEN", { required: true }) : undefined;
  const selfUrl = deploymentMode === "cloud" ? r.url("GITHUB_URL", { required: true, httpsOnly: true }) : undefined;
  const gatewaySaEmail = deploymentMode === "cloud" ? r.email("GATEWAY_SA_EMAIL", { required: true }) : undefined;
  // 試験・ローカルでは https でない基底 URL（偽の GitHub）も許す
  const apiBase = r.url("GITHUB_API_BASE") ?? DEFAULT_GITHUB_API_BASE;
  const commitSha = r.string("COMMIT_SHA");
  return r.done({
    deploymentMode,
    port,
    sharedToken,
    selfUrl,
    gatewaySaEmail,
    githubApiBase: apiBase.replace(/\/+$/, ""),
    commitSha,
  });
}

/** env から platform のサービス間の認証の設定を作る（local：共有トークン、cloud：aud と sa-gateway の1つ） */
export function serviceAuthConfigOf(env: Pick<GithubEnv, "deploymentMode" | "sharedToken" | "selfUrl" | "gatewaySaEmail">): ServiceAuthConfig {
  if (env.deploymentMode === "local") return { mode: "local", sharedToken: env.sharedToken };
  return { mode: "cloud", audience: env.selfUrl, callerEmails: { "sa-gateway": env.gatewaySaEmail } };
}
