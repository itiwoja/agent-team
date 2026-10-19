// Hono の文脈に載せる値（app）。platform の requestContext・verifyServiceCaller が入れるものに、セッションを足す

import type { SessionCtx } from "@open-team/db";
import type { PlatformVariables } from "@open-team/platform";

export type AppVariables = PlatformVariables & {
  /** resolveSession の結果（Cookie がない・無効なら null）。/api/v1/entry と GET /api/v1/session 以外は必ずある */
  session: SessionCtx | null;
  /** 今のリクエストの Cookie の値（ローリングで出し直すとき・入口で前のセッションを失効させるとき） */
  sessionCookie: string | null;
  /** 処理が Cookie を書いた・消した（入口・ログアウト）。ローリングで上書きしない */
  sessionCookieWritten: boolean;
};

export type AppHonoEnv = { Variables: AppVariables };
