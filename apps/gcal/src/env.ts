// 環境変数の読み込み（security-ops-deploy.md §2.2・§3.1.3、16 §3.2）。読み方は packages/platform の EnvReader（sim-world と同じ）。
// 足りない・不正な変数の「名前」だけを返す（値は出さない：D-47）。足りなければ server.ts は起動しない（画面がないので「準備中」にしない）。
// 呼び出し元の確かめは gateway だけ（sa-gateway）

import { EnvReader, type EnvCheck, type EnvSource, type ServiceAuthConfig } from "@open-team/platform";

/** Google Calendar API の既定の基底 URL（§3.2。試験では GOOGLE_CALENDAR_API_BASE で差し替える） */
export const DEFAULT_GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export interface GcalEnv {
  port: number;
  /** GCAL_SHARED_TOKEN（gateway と共有する呼び出し元のトークン。platform の serviceAuthHeaders と同じ値） */
  sharedToken: string | undefined;
  /** Calendar API の基底 URL（末尾の / なし） */
  googleCalendarApiBase: string;
  commitSha: string | undefined;
}

export function readGcalEnv(source: EnvSource = process.env): EnvCheck<GcalEnv> {
  const r = new EnvReader(source);
  const port = r.port();
  // 呼び出し元は sa-gateway だけ（16 §3.2）。共有トークンで確かめる
  const sharedToken = r.secret("GCAL_SHARED_TOKEN", { required: true });
  // 試験・ローカルでは https でない基底 URL（偽の Google）も許す
  const apiBase = r.url("GOOGLE_CALENDAR_API_BASE") ?? DEFAULT_GOOGLE_CALENDAR_API_BASE;
  const commitSha = r.string("COMMIT_SHA");
  return r.done({
    port,
    sharedToken,
    googleCalendarApiBase: apiBase.replace(/\/+$/, ""),
    commitSha,
  });
}

/** env から platform のサービス間の認証の設定を作る（共有トークン） */
export function serviceAuthConfigOf(env: Pick<GcalEnv, "sharedToken">): ServiceAuthConfig {
  return { sharedToken: env.sharedToken };
}
