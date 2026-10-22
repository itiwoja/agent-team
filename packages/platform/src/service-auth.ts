// サービス間の認証（security-ops-deploy.md §2.5・§3.9・§3.11、G-11）
// 共有トークン（INTERNAL_SHARED_TOKEN を Authorization: Bearer）＋呼び出し元の名前のヘッダー（x-ot-caller）。
// 拒否は 403 FORBIDDEN（理由は返さず、ログ internal_auth.denied にだけ残す：SO §3.9、I-20）

import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { RequestVariables, ServiceCallerVariables } from "./context.ts";
import { MIN_SECRET_LENGTH, type EnvReader } from "./env.ts";
import { errorResponse } from "./errors.ts";
import { loggerOf, silentLogger, type Logger } from "./log.ts";

/** サービス間の呼び出し元 */
export const SERVICE_CALLERS = ["sa-app", "sa-gateway"] as const;
export type ServiceCaller = (typeof SERVICE_CALLERS)[number];

/** 呼び出し元の名前を載せるヘッダー */
export const CALLER_HEADER = "x-ot-caller";

export interface ServiceAuthConfig {
  /** INTERNAL_SHARED_TOKEN（32文字以上。なければ全部拒否・呼べない） */
  sharedToken: string | undefined;
}

export type ServiceAuthRejectReason = "shared_token_not_configured" | "bad_token" | "unknown_caller" | "caller_not_allowed";

/** 呼び出し元の確認の結果。理由・名前はログにだけ出す */
export type ServiceCallerCheck = { ok: true; caller: ServiceCaller } | { ok: false; reason: ServiceAuthRejectReason; caller?: ServiceCaller };

export interface ServiceAuthDeps {
  /** 文脈に Logger がないときの拒否のログ */
  log?: Logger;
}

export interface ServiceAuth {
  /** 呼ぶ側：caller として audience（呼び先の URL）を呼ぶときのヘッダー。gateway-client の authHeaders にそのまま使える */
  serviceAuthHeaders(caller: ServiceCaller, audience: string): Promise<Record<string, string>>;
  /** 受ける側（関数）：allowed のどれかか */
  checkServiceCaller(headers: Headers, allowed: readonly ServiceCaller[]): Promise<ServiceCallerCheck>;
  /** 受ける側（Hono のミドルウェア）：通れば c.var.serviceCaller、外れれば 403 FORBIDDEN＋ログ internal_auth.denied */
  verifyServiceCaller(allowed: readonly ServiceCaller[]): MiddlewareHandler<{ Variables: RequestVariables & ServiceCallerVariables }>;
}

const isServiceCaller = (v: string | undefined): v is ServiceCaller => (SERVICE_CALLERS as readonly (string | undefined)[]).includes(v);

/** `Authorization: Bearer <token>` の token（形が違えば null） */
export function bearerTokenOf(authorization: string | null | undefined): string | null {
  const m = /^Bearer[ ]+(\S+)$/i.exec(authorization?.trim() ?? "");
  return m?.[1] ?? null;
}

/**
 * 定数時間の比較。長さの違いも比較時間から漏らさないよう、両方を HMAC にしてから比べる
 * （apps/app の tokenMatches と同じ考え方）
 */
export function safeEqual(input: string, expected: string): boolean {
  const a = createHmac("sha256", "open-team/platform").update(input).digest();
  const b = createHmac("sha256", "open-team/platform").update(expected).digest();
  return timingSafeEqual(a, b);
}

function checkShared(sharedToken: string | undefined, headers: Headers, allowed: readonly ServiceCaller[]): ServiceCallerCheck {
  if (sharedToken === undefined || sharedToken.length < MIN_SECRET_LENGTH) return { ok: false, reason: "shared_token_not_configured" };
  const token = bearerTokenOf(headers.get("authorization"));
  if (token === null || !safeEqual(token, sharedToken)) return { ok: false, reason: "bad_token" };
  const name = headers.get(CALLER_HEADER)?.trim();
  if (!isServiceCaller(name)) return { ok: false, reason: "unknown_caller" };
  if (!allowed.includes(name)) return { ok: false, reason: "caller_not_allowed", caller: name };
  return { ok: true, caller: name };
}

export function createServiceAuth(config: ServiceAuthConfig, deps: ServiceAuthDeps = {}): ServiceAuth {
  const auth: ServiceAuth = {
    async serviceAuthHeaders(caller): Promise<Record<string, string>> {
      if (config.sharedToken === undefined || config.sharedToken.length < MIN_SECRET_LENGTH) {
        throw new Error("INTERNAL_SHARED_TOKEN がない・短いので、サービス間の呼び出しができない");
      }
      return { authorization: `Bearer ${config.sharedToken}`, [CALLER_HEADER]: caller };
    },

    async checkServiceCaller(headers, allowed) {
      return checkShared(config.sharedToken, headers, allowed);
    },

    verifyServiceCaller(allowed) {
      return async (c, next) => {
        const check = await auth.checkServiceCaller(c.req.raw.headers, allowed);
        if (!check.ok) {
          loggerOf(c, deps.log ?? silentLogger).warn("internal_auth.denied", "呼び出し元を拒否した", {
            method: c.req.method,
            path: c.req.path,
            reason: check.reason,
            ...(check.caller ? { caller: check.caller } : {}),
          });
          return errorResponse(c, "FORBIDDEN", { message: "この呼び出し元は使えません" });
        }
        c.set("serviceCaller", check.caller);
        await next();
      };
    },
  };
  return auth;
}

/** サービス間の認証の設定を環境変数から読む：INTERNAL_SHARED_TOKEN（32文字以上。足りない・不正な名前は reader に積む。値は出さない：D-47） */
export function readServiceAuthEnv(reader: EnvReader): ServiceAuthConfig {
  return { sharedToken: reader.secret("INTERNAL_SHARED_TOKEN", { required: true }) };
}
