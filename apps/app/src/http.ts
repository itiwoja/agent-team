// 画面の API（/api/*）の共通の処理（AS §3.0、SO §3.3・§3.6・§3.8、11_tech_spec.md:226・233）
// 順番（app.ts で組む）：セキュリティヘッダー → X-Request-Id → no-store → 本文 64KB → 同一オリジンの JSON → 準備中（D-47）
// → セッションの解決（無くても通す。ローリングは処理のあと）→ ルートごとのセッション必須・CSRF → 入力の検証 → ワークスペースで絞る（404）→ 権限（403）
// 決めたこと：同一オリジンの確認を準備中の確認より先にした（SO §3.3 の順。別のオリジンの要求には準備中の名前も返さない）

import { getConnInfo } from "@hono/node-server/conninfo";
import { csrfTokenMatches, resolveSession, SESSION_LIMITS, touchSession, type MemberRole, type SessionCtx } from "@open-team/db";
import { AppError, errorResponse, parseInput, setupRequired } from "@open-team/platform";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import type { AppHonoEnv } from "./context.ts";
import type { AppDeps } from "./deps.ts";

/** Cookie の名前（09_api/common.md:44、SO §2.4） */
export const SESSION_COOKIE = "ot_session";
/** 7日（15:383）。アクセスのたびに出し直す */
export const SESSION_MAX_AGE_SEC = Math.floor(SESSION_LIMITS.ttlMs / 1000);
/** 本文の上限（既存の 64KB：SO §2.1 の apiBodyLimitBytes） */
export const API_BODY_LIMIT_BYTES = 64 * 1024;

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const isStateChanging = (method: string): boolean => STATE_CHANGING.has(method.toUpperCase());

/** CSP など（15:502、11_tech_spec.md:226。既存の値のまま）。全ルート */
export function securityHeaders(): MiddlewareHandler {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "no-referrer",
  });
}

/** /api は保存させない（11_tech_spec.md:233） */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
};

const JSON_TYPE = /^application\/json\b/i;

/** 本文があるか（ヘッダーで見る。実際の中身は readJsonBody が確かめる） */
function declaresBody(c: Context): boolean {
  const len = c.req.header("content-length");
  return (len !== undefined && len.trim() !== "" && len.trim() !== "0") || c.req.header("transfer-encoding") !== undefined;
}

/**
 * 状態を変えるメソッドは同じオリジンからの JSON だけ（SO §3.8 の sameOriginJson。既存の規則のまま、コードは 09 の形）：
 * Origin のホストが Host と違う・Origin がない → 403 ORIGIN_MISMATCH、Sec-Fetch-Site: cross-site → 403、
 * Content-Type が JSON でない（本文があるのに Content-Type がないも）→ 415 UNSUPPORTED_MEDIA_TYPE。本文のない要求は Content-Type を見ない
 */
export const sameOriginJson: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  if (!isStateChanging(c.req.method)) return next();
  const origin = c.req.header("origin");
  const host = c.req.header("host");
  let sameHost = false;
  if (origin && host) {
    try {
      sameHost = new URL(origin).host === host;
    } catch {
      sameHost = false;
    }
  }
  if (!sameHost || c.req.header("sec-fetch-site") === "cross-site") return errorResponse(c, "ORIGIN_MISMATCH");
  const ct = c.req.header("content-type");
  if (ct !== undefined ? !JSON_TYPE.test(ct) : declaresBody(c)) return errorResponse(c, "UNSUPPORTED_MEDIA_TYPE");
  return next();
};

/**
 * 準備中（D-47、AS §3.0 の5・§8-32）：必須の環境変数が足りなければ GET /api/v1/session は { state: "setup_required", missing }、
 * それ以外は 503 SETUP_REQUIRED（details.missing は名前だけ）。/api/health はこれより前に登録する
 */
export function setupGuard(missing: readonly string[]): MiddlewareHandler<AppHonoEnv> {
  return async (c, next) => {
    if (missing.length === 0) return next();
    if (c.req.method === "GET" && c.req.path === "/api/v1/session") {
      return c.json({ state: "setup_required", missing: [...missing] });
    }
    return errorResponse(c, setupRequired(missing));
  };
}

/** Cookie を出す（HttpOnly・Secure・SameSite=Lax・Path=/・Max-Age=604800：SO §2.4） */
export function setSessionCookie(c: Context<AppHonoEnv>, deps: Pick<AppDeps, "env">, value: string): void {
  setCookie(c, SESSION_COOKIE, value, {
    httpOnly: true,
    secure: deps.env.cookieSecure,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
  c.set("sessionCookieWritten", true);
}

export function clearSessionCookie(c: Context<AppHonoEnv>, deps: Pick<AppDeps, "env">): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: deps.env.cookieSecure, httpOnly: true, sameSite: "Lax" });
  c.set("sessionCookieWritten", true);
}

/**
 * セッションを引く（SO §3.6 の resolveSession。無い・無効でも通す：要るかはルートが決める）。
 * 処理のあと、ローリング（前の更新から60秒以上なら last_seen_at・expires_at を延ばし、Cookie を Max-Age で出し直す：15:383）。
 * 無効な Cookie は応答で消す。処理が Cookie を書いた（入口・ログアウト）ときは触らない
 */
export function sessionMiddleware(deps: Pick<AppDeps, "db" | "clock" | "env">): MiddlewareHandler<AppHonoEnv> {
  return async (c, next) => {
    c.set("session", null);
    c.set("sessionCookie", null);
    c.set("sessionCookieWritten", false);
    const cookie = getCookie(c, SESSION_COOKIE);
    let invalid = false;
    if (cookie !== undefined && cookie !== "") {
      const s = await resolveSession(deps.db, cookie, deps.clock.now());
      if (s) {
        c.set("session", s);
        c.set("sessionCookie", cookie);
      } else {
        invalid = true;
      }
    }
    await next();
    if (c.get("sessionCookieWritten")) return;
    if (invalid) {
      clearSessionCookie(c, deps);
      return;
    }
    const s = c.get("session");
    const value = c.get("sessionCookie");
    if (!s || !value) return;
    const t = await touchSession(deps.db, s, deps.clock.now());
    if (t.touched) setSessionCookie(c, deps, value);
  };
}

/** セッション必須（401 UNAUTHORIZED） */
export const requireSession: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  if (!c.get("session")) throw new AppError("UNAUTHORIZED");
  await next();
};

/** 状態を変えるメソッドの CSRF（X-CSRF-Token を sessions.csrf_token と定数時間で比べる：SO §3.8） */
export const requireCsrf: MiddlewareHandler<AppHonoEnv> = async (c, next) => {
  if (isStateChanging(c.req.method)) {
    const s = c.get("session");
    if (!s) throw new AppError("UNAUTHORIZED");
    if (!csrfTokenMatches(s.csrfToken, c.req.header("x-csrf-token"))) throw new AppError("CSRF_TOKEN_INVALID");
  }
  await next();
};

/** ルートの中のセッション（requireSession のあと。なければ 401） */
export function sessionOf(c: Context<AppHonoEnv>): SessionCtx {
  const s = c.get("session");
  if (!s) throw new AppError("UNAUTHORIZED");
  return s;
}

/**
 * 本文を JSON として読み、スキーマで確かめる（AS §3.0 の10）。空の本文は {}（理由が任意の EP-27 など）。
 * 本文があるのに JSON の Content-Type でない → 415、JSON として読めない → 400
 */
export async function readJsonBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim() !== "") {
    if (!JSON_TYPE.test(c.req.header("content-type") ?? "")) throw new AppError("UNSUPPORTED_MEDIA_TYPE");
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AppError("VALIDATION_ERROR", "本文を JSON として読めません", { details: [{ field: "", reason: "invalid_json" }] });
    }
  }
  return parseInput(schema, raw);
}

/** クエリをスキーマで確かめる（同じ名前が2つあれば最初のもの） */
export function readQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return parseInput(schema, c.req.query());
}

const IdParam = z.guid();

/** パスの ID（8-4-4-4-12 の16進でなければ 400）。小文字にそろえる */
export function idParam(c: Context, name: string): string {
  const v = c.req.param(name) ?? "";
  const r = IdParam.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION_ERROR", undefined, { details: [{ field: name, reason: "uuid の形ではありません" }] });
  return r.data.toLowerCase();
}

/** パスの {workspaceId} がセッションのものと違えば 404（別のワークスペースのものは 404：15:517、AS §3.0 の11） */
export function assertOwnWorkspace(s: SessionCtx, workspaceId: string): void {
  if (workspaceId.toLowerCase() !== s.workspaceId.toLowerCase()) throw new AppError("NOT_FOUND");
}

/** 資源ごとの権限（AS §3.0 の12。404 のあとに判定する） */
export function requireRole(s: SessionCtx, roles: readonly MemberRole[]): void {
  if (!roles.includes(s.role)) throw new AppError("FORBIDDEN");
}

const isLoopbackAddress = (a: string): boolean => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/i.test(a.trim());

/**
 * このマシンの中からの要求か（ローカルのトークンなしの入口だけで使う）。接続の相手がループバックで、
 * X-Forwarded-For があればその全部もループバック（Vite の開発サーバーは xfwd で元の相手を付ける。LAN からは通さない）
 */
export function isLoopbackRequest(c: Context): boolean {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    return false;
  }
  if (!remote || !isLoopbackAddress(remote)) return false;
  const xff = c.req.header("x-forwarded-for");
  return xff === undefined || xff.split(",").every(isLoopbackAddress);
}

/** 呼び出し元の IP（BR-65 の数え方・失敗が続く IP の待ち時間。保存は HMAC：M-55）。接続の相手を使う */
export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // 試験（app.request）など、接続の情報がないとき
    return "unknown";
  }
}
