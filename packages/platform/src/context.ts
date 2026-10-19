// Hono の文脈に載せる値（platform のミドルウェアが入れる）。apps は自分の Variables と交差させて使う：
//   new Hono<{ Variables: PlatformVariables & { session: SessionContext } }>()

import type { Logger } from "./log.ts";
import type { ServiceCaller } from "./service-auth.ts";

/** requestContext が入れる */
export type RequestVariables = {
  requestId: string;
  log: Logger;
};

/** verifyServiceCaller が入れる（確かめた呼び出し元） */
export type ServiceCallerVariables = {
  serviceCaller: ServiceCaller;
};

export type PlatformVariables = RequestVariables & ServiceCallerVariables;
export type PlatformEnv = { Variables: PlatformVariables };
