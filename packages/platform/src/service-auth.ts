// サービス間の認証（security-ops-deploy.md §2.5・§3.9・§3.11、15:479-490、G-11）
// cloud：呼ぶ側は Google の ID トークン（Authorization: Bearer。aud は呼び先の run.app の URL）、受ける側は ID トークンを検証して
//        email から呼び出し元を決める（名前のヘッダーは信じない）。
// local：共有トークン（INTERNAL_SHARED_TOKEN を Authorization: Bearer）＋呼び出し元の名前のヘッダー（x-ot-caller）。
//        apps/sim-world の auth.ts の local の形と同じ。
// 拒否は 403 FORBIDDEN（理由は返さず、ログ internal_auth.denied にだけ残す：SO §3.9、I-20）

import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { RequestVariables, ServiceCallerVariables } from "./context.ts";
import { MIN_SECRET_LENGTH, type DeploymentMode, type EnvReader } from "./env.ts";
import { errorResponse } from "./errors.ts";
import {
  bearerTokenOf,
  checkGoogleIdToken,
  createIdTokenSource,
  normalizeAudience,
  type IdTokenRejectReason,
  type IdTokenSignatureVerifier,
  type IdTokenSource,
} from "./id-token.ts";
import { loggerOf, silentLogger, type Logger } from "./log.ts";
import type { Clock } from "./time.ts";

/** サービス間の呼び出し元（15:490。sa-sim は誰も呼ばないので入れない） */
export const SERVICE_CALLERS = ["sa-app", "sa-gateway"] as const;
export type ServiceCaller = (typeof SERVICE_CALLERS)[number];

/** local で呼び出し元の名前を載せるヘッダー（apps/sim-world の CALLER_HEADER と同じ） */
export const CALLER_HEADER = "x-ot-caller";

/** cloud で呼び出し元のサービスアカウントを読む環境変数（SO §2.2） */
export const CALLER_EMAIL_VARS: Readonly<Record<ServiceCaller, string>> = {
  "sa-app": "APP_SA_EMAIL",
  "sa-gateway": "GATEWAY_SA_EMAIL",
};

/** 受ける側の aud にする自分の URL の変数（SO §3.9 の表） */
export type AudienceVar = "APP_INTERNAL_URL" | "GATEWAY_URL" | "SIM_WORLD_URL" | "GCAL_URL" | "GITHUB_URL";

export type ServiceAuthConfig =
  | {
      mode: "local";
      /** INTERNAL_SHARED_TOKEN（32文字以上。なければ全部拒否・呼べない） */
      sharedToken: string | undefined;
    }
  | {
      mode: "cloud";
      /** 受ける側の aud（自分の run.app の URL）。なければ全部拒否 */
      audience: string | undefined;
      /** 呼び出し元ごとのサービスアカウント（APP_SA_EMAIL・GATEWAY_SA_EMAIL） */
      callerEmails: Partial<Record<ServiceCaller, string>>;
      /** 署名まで確かめるか（既定 true。InternalAuthPolicy.verifySignature） */
      verifySignature?: boolean;
    };

export type ServiceAuthRejectReason =
  | IdTokenRejectReason
  | "shared_token_not_configured"
  | "bad_token"
  | "unknown_caller"
  | "caller_not_allowed"
  | "caller_email_not_configured";

/** 呼び出し元の確認の結果。理由・email・名前はログにだけ出す */
export type ServiceCallerCheck =
  | { ok: true; caller: ServiceCaller }
  | { ok: false; reason: ServiceAuthRejectReason; email?: string; caller?: ServiceCaller };

export interface ServiceAuthDeps {
  /** cloud の ID トークンの取得（既定は createIdTokenSource()＝メタデータサーバー） */
  idTokens?: IdTokenSource;
  /** cloud の署名の検証（既定は google-auth-library） */
  verifier?: IdTokenSignatureVerifier;
  clock?: Clock;
  /** 文脈に Logger がないときの拒否のログ */
  log?: Logger;
}

export interface ServiceAuth {
  readonly mode: DeploymentMode;
  /** 呼ぶ側：caller として audience（呼び先の URL）を呼ぶときのヘッダー。gateway-client の authHeaders にそのまま使える */
  serviceAuthHeaders(caller: ServiceCaller, audience: string): Promise<Record<string, string>>;
  /** 受ける側（関数）：allowed のどれかか */
  checkServiceCaller(headers: Headers, allowed: readonly ServiceCaller[]): Promise<ServiceCallerCheck>;
  /** 受ける側（Hono のミドルウェア）：通れば c.var.serviceCaller、外れれば 403 FORBIDDEN＋ログ internal_auth.denied */
  verifyServiceCaller(allowed: readonly ServiceCaller[]): MiddlewareHandler<{ Variables: RequestVariables & ServiceCallerVariables }>;
}

const isServiceCaller = (v: string | undefined): v is ServiceCaller => (SERVICE_CALLERS as readonly (string | undefined)[]).includes(v);

/**
 * 定数時間の比較。長さの違いも比較時間から漏らさないよう、両方を HMAC にしてから比べる
 * （apps/app の tokenMatches・apps/sim-world と同じ考え方）
 */
export function safeEqual(input: string, expected: string): boolean {
  const a = createHmac("sha256", "open-team/platform").update(input).digest();
  const b = createHmac("sha256", "open-team/platform").update(expected).digest();
  return timingSafeEqual(a, b);
}

function checkLocal(sharedToken: string | undefined, headers: Headers, allowed: readonly ServiceCaller[]): ServiceCallerCheck {
  if (sharedToken === undefined || sharedToken.length < MIN_SECRET_LENGTH) return { ok: false, reason: "shared_token_not_configured" };
  const token = bearerTokenOf(headers.get("authorization"));
  if (token === null || !safeEqual(token, sharedToken)) return { ok: false, reason: "bad_token" };
  const name = headers.get(CALLER_HEADER)?.trim();
  if (!isServiceCaller(name)) return { ok: false, reason: "unknown_caller" };
  if (!allowed.includes(name)) return { ok: false, reason: "caller_not_allowed", caller: name };
  return { ok: true, caller: name };
}

export function createServiceAuth(config: ServiceAuthConfig, deps: ServiceAuthDeps = {}): ServiceAuth {
  let idTokens = deps.idTokens;

  // cloud：同じ email の呼び出し元が2つあると見分けられないので、設定の誤りとして全部拒否する
  const emails =
    config.mode === "cloud"
      ? Object.entries(config.callerEmails)
          .filter((e): e is [ServiceCaller, string] => isServiceCaller(e[0]) && typeof e[1] === "string" && e[1].trim() !== "")
          .map(([caller, email]) => [caller, email.trim().toLowerCase()] as const)
      : [];
  const emailsConflict = new Set(emails.map(([, e]) => e)).size !== emails.length;

  const checkCloud = async (
    c: Extract<ServiceAuthConfig, { mode: "cloud" }>,
    headers: Headers,
    allowed: readonly ServiceCaller[],
  ): Promise<ServiceCallerCheck> => {
    const allowedPairs = emails.filter(([caller]) => allowed.includes(caller));
    if (emailsConflict || allowedPairs.length === 0) return { ok: false, reason: "caller_email_not_configured" };
    const r = await checkGoogleIdToken(
      headers.get("authorization"),
      {
        audience: c.audience ?? "",
        allowedEmails: allowedPairs.map(([, e]) => e),
        ...(c.verifySignature !== undefined ? { verifySignature: c.verifySignature } : {}),
      },
      { ...(deps.verifier ? { verifier: deps.verifier } : {}), ...(deps.clock ? { clock: deps.clock } : {}) },
    );
    if (!r.ok) return { ok: false, reason: r.reason, ...(r.email ? { email: r.email } : {}) };
    const hit = allowedPairs.find(([, e]) => e === r.identity.email);
    // allowedEmails に入っていた email なので必ず見つかる。見つからなければ閉じた側に倒す
    return hit ? { ok: true, caller: hit[0] } : { ok: false, reason: "email_not_allowed", email: r.identity.email };
  };

  const auth: ServiceAuth = {
    mode: config.mode,

    async serviceAuthHeaders(caller, audience): Promise<Record<string, string>> {
      if (config.mode === "local") {
        if (config.sharedToken === undefined || config.sharedToken.length < MIN_SECRET_LENGTH) {
          throw new Error("INTERNAL_SHARED_TOKEN がない・短いので、サービス間の呼び出しができない（local）");
        }
        return { authorization: `Bearer ${config.sharedToken}`, [CALLER_HEADER]: caller };
      }
      // cloud：呼び出し元はメタデータサーバーのサービスアカウントで決まる（caller の名前は送らない）
      idTokens ??= createIdTokenSource(deps.clock ? { clock: deps.clock } : {});
      const token = await idTokens.getIdToken(normalizeAudience(audience));
      return { authorization: `Bearer ${token}` };
    },

    async checkServiceCaller(headers, allowed) {
      return config.mode === "local" ? checkLocal(config.sharedToken, headers, allowed) : checkCloud(config, headers, allowed);
    },

    verifyServiceCaller(allowed) {
      return async (c, next) => {
        const check = await auth.checkServiceCaller(c.req.raw.headers, allowed);
        if (!check.ok) {
          loggerOf(c, deps.log ?? silentLogger).warn("internal_auth.denied", "呼び出し元を拒否した", {
            method: c.req.method,
            path: c.req.path,
            mode: config.mode,
            reason: check.reason,
            ...(check.email ? { email: check.email } : {}),
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

export interface ServiceAuthEnvOptions {
  /** 受ける側の aud にする自分の URL の変数（cloud で必須）。app は APP_INTERNAL_URL、gateway は GATEWAY_URL、sim-world は SIM_WORLD_URL */
  audienceVar?: AudienceVar;
  /** 受け入れる呼び出し元（cloud ではそのサービスアカウントの変数が必須） */
  callers?: readonly ServiceCaller[];
}

/**
 * サービス間の認証の設定を環境変数から読む（足りない・不正な名前は reader に積む。値は出さない：D-47）。
 * local：INTERNAL_SHARED_TOKEN（32文字以上）。cloud：audienceVar（https の URL）と、callers の APP_SA_EMAIL・GATEWAY_SA_EMAIL（互いに違う値）
 */
export function readServiceAuthEnv(reader: EnvReader, mode: DeploymentMode, options: ServiceAuthEnvOptions = {}): ServiceAuthConfig {
  if (mode === "local") return { mode, sharedToken: reader.secret("INTERNAL_SHARED_TOKEN", { required: true }) };
  const audience = options.audienceVar ? reader.url(options.audienceVar, { required: true, httpsOnly: true }) : undefined;
  const callerEmails: Partial<Record<ServiceCaller, string>> = {};
  const seen = new Set<string>();
  for (const caller of SERVICE_CALLERS) {
    if (!options.callers?.includes(caller)) continue;
    const name = CALLER_EMAIL_VARS[caller];
    const email = reader.email(name, { required: true });
    if (email === undefined) continue;
    // 同じアドレスだと呼び出し元を見分けられない（MCP は sa-gateway だけ、管理 API は sa-app だけ）
    if (seen.has(email)) {
      reader.flag(name);
      continue;
    }
    seen.add(email);
    callerEmails[caller] = email;
  }
  return { mode, audience, callerEmails };
}
