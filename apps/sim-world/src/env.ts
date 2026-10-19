// 環境変数の読み込み（security-ops-deploy.md §2.2・§3.1.3）。読み方は packages/platform の EnvReader・readServiceAuthEnv
// （gateway・app と同じ）。足りない・不正な変数の「名前」だけを返す（値は出さない：D-47）。
// sim-world は画面を持たないので「準備中」にせず、足りなければ server.ts が起動しない（SO §3.1.3）

import { EnvReader, MIN_SECRET_LENGTH, readServiceAuthEnv, type EnvCheck, type EnvSource } from "@open-team/platform";

export interface SimWorldEnv {
  port: number;
  /** INTERNAL_SHARED_TOKEN（gateway・app と共有する呼び出し元のトークン。platform の serviceAuthHeaders と同じ値） */
  sharedToken: string | undefined;
  /** DATABASE_URL（あれば Postgres、なければメモリ） */
  databaseUrl: string | undefined;
  commitSha: string | undefined;
}

/** 共有トークンの最小の長さ（SO §2.1 の secretMinLen。platform の MIN_SECRET_LENGTH） */
export const MIN_SHARED_TOKEN_LENGTH = MIN_SECRET_LENGTH;

/** postgres:// か postgresql://（docker compose の db など） */
const POSTGRES_URL = /^postgres(?:ql)?:\/\/\S+$/;

export function readSimWorldEnv(source: EnvSource = process.env): EnvCheck<SimWorldEnv> {
  const r = new EnvReader(source);
  const port = r.port();
  const databaseUrl = r.string("DATABASE_URL", { pattern: POSTGRES_URL });
  const auth = readServiceAuthEnv(r);
  const commitSha = r.string("COMMIT_SHA");
  return r.done({
    port,
    sharedToken: auth.sharedToken,
    databaseUrl,
    commitSha,
  });
}
