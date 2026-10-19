// Hono の文脈に載せる値（packages/platform のミドルウェアが入れる）：
// requestId と、そのリクエストの Logger（requestContext）、確かめた呼び出し元 serviceCaller（verifyServiceCaller）

import type { PlatformVariables } from "@open-team/platform";

export type SimWorldHonoEnv = {
  Variables: PlatformVariables;
};
