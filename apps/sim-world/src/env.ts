// 環境変数の読み込み（security-ops-deploy.md §2.2・§3.1.3）。読み方は packages/platform の EnvReader・readServiceAuthEnv
// （gateway・app と同じ）。足りない・不正な変数の「名前」だけを返す（値は出さない：D-47）。
// sim-world は画面を持たないので「準備中」にせず、足りなければ server.ts が起動しない（SO §3.1.3）

import { EnvReader, MIN_SECRET_LENGTH, readServiceAuthEnv, type DeploymentMode, type EnvCheck, type EnvSource } from "@open-team/platform";

/**
 * local＝ローカル（docker compose・計測。共有トークンで呼び出し元を確かめる：G-11）、
 * cloud＝Cloud Run（ID トークン）。SO §2.2 の値 public も cloud として読む（platform の readDeploymentMode）
 */
export type SimDeploymentMode = DeploymentMode;

export interface SimWorldEnv {
  deploymentMode: SimDeploymentMode;
  port: number;
  /** local：INTERNAL_SHARED_TOKEN（gateway・app と共有する呼び出し元のトークン。platform の serviceAuthHeaders と同じ値） */
  sharedToken: string | undefined;
  /** cloud：SIM_WORLD_URL（ID トークンの aud。https・末尾の / なしに正規化） */
  selfUrl: string | undefined;
  /** cloud：GATEWAY_SA_EMAIL（MCP を呼べる sa-gateway。小文字） */
  gatewaySaEmail: string | undefined;
  /** cloud：APP_SA_EMAIL（管理 API を呼べる sa-app。小文字） */
  appSaEmail: string | undefined;
  /** DATABASE_URL（cloud は必須で ot_sim。local はあれば Postgres、なければメモリ） */
  databaseUrl: string | undefined;
  commitSha: string | undefined;
}

/** 共有トークンの最小の長さ（SO §2.1 の secretMinLen。platform の MIN_SECRET_LENGTH） */
export const MIN_SHARED_TOKEN_LENGTH = MIN_SECRET_LENGTH;

/** postgres:// か postgresql://（Cloud SQL の unix ソケットは ?host=/cloudsql/… で渡す） */
const POSTGRES_URL = /^postgres(?:ql)?:\/\/\S+$/;

export function readSimWorldEnv(source: EnvSource = process.env): EnvCheck<SimWorldEnv> {
  const r = new EnvReader(source);
  // 既定は local。知らない値・Cloud Run（K_SERVICE）なのに local は cloud で読み、DEPLOYMENT_MODE を足りないに入れる
  const deploymentMode = r.deploymentMode();
  const port = r.port();
  // SO §3.1.3：cloud は DATABASE_URL・SIM_WORLD_URL・GATEWAY_SA_EMAIL・APP_SA_EMAIL が要る
  const databaseUrl = r.string("DATABASE_URL", { required: deploymentMode === "cloud", pattern: POSTGRES_URL });
  // MCP は sa-gateway、管理 API は sa-app（SO §3.11）。同じ email の2つは見分けられないので不可（readServiceAuthEnv が積む）
  const auth = readServiceAuthEnv(r, deploymentMode, { audienceVar: "SIM_WORLD_URL", callers: ["sa-app", "sa-gateway"] });
  const commitSha = r.string("COMMIT_SHA");
  return r.done({
    deploymentMode,
    port,
    sharedToken: auth.mode === "local" ? auth.sharedToken : undefined,
    selfUrl: auth.mode === "cloud" ? auth.audience : undefined,
    gatewaySaEmail: auth.mode === "cloud" ? auth.callerEmails["sa-gateway"] : undefined,
    appSaEmail: auth.mode === "cloud" ? auth.callerEmails["sa-app"] : undefined,
    databaseUrl,
    commitSha,
  });
}
