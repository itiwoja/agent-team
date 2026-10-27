import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type AuthorizationFailure = { status: number; code: string };

export function createAuthorize(token: string): (request: IncomingMessage) => AuthorizationFailure | undefined {
  if (token.length === 0 || /\s/.test(token)) throw new Error("Invalid browser token configuration");
  const expected = createHash("sha256").update(token).digest();
  return (request) => {
    // 内部のserver-to-server専用。ブラウザの直接アクセスは許可しない。
    if (request.headers.origin !== undefined) return { status: 403, code: "ORIGIN_FORBIDDEN" };
    const headers = request.headersDistinct.authorization;
    const match = headers?.length === 1 ? /^Bearer ([^\s]+)$/i.exec(headers[0] ?? "") : null;
    // 比較するバッファの長さは常に固定し、資格の長さによる比較例外を避ける。
    const actual = createHash("sha256").update(match?.[1] ?? "").digest();
    if (!timingSafeEqual(expected, actual) || match === null) return { status: 401, code: "UNAUTHORIZED" };
    return undefined;
  };
}
