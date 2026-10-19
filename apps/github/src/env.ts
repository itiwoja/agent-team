// 環境変数の読み込み（security-ops-deploy.md §2.2・§3.1.3、18 §3.2）。読み方は packages/platform の EnvReader（gcal と同じ）。
// 足りない・不正な変数の「名前」だけを返す（値は出さない：D-47）。足りなければ server.ts は起動しない。
// 呼び出し元の確かめは gateway だけ（sa-gateway）

import { EnvReader, type EnvCheck, type EnvSource, type ServiceAuthConfig } from "@open-team/platform";

/** GitHub REST API の既定の基底 URL（試験では GITHUB_API_BASE で差し替える） */
export const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

export interface GithubEnv {
  port: number;
  /** GITHUB_SHARED_TOKEN（gateway と共有する呼び出し元のトークン） */
  sharedToken: string | undefined;
  /** GitHub REST API の基底 URL（末尾の / なし） */
  githubApiBase: string;
  commitSha: string | undefined;
}

export function readGithubEnv(source: EnvSource = process.env): EnvCheck<GithubEnv> {
  const r = new EnvReader(source);
  const port = r.port();
  const sharedToken = r.secret("GITHUB_SHARED_TOKEN", { required: true });
  // 試験・ローカルでは https でない基底 URL（偽の GitHub）も許す
  const apiBase = r.url("GITHUB_API_BASE") ?? DEFAULT_GITHUB_API_BASE;
  const commitSha = r.string("COMMIT_SHA");
  return r.done({
    port,
    sharedToken,
    githubApiBase: apiBase.replace(/\/+$/, ""),
    commitSha,
  });
}

/** env から platform のサービス間の認証の設定を作る（共有トークン） */
export function serviceAuthConfigOf(env: Pick<GithubEnv, "sharedToken">): ServiceAuthConfig {
  return { sharedToken: env.sharedToken };
}
