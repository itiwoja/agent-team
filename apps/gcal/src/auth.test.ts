import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServiceAuth, decodeJwtClaims, manualClock, type IdTokenClaims, type IdTokenSignatureVerifier } from "@open-team/platform";
import { createApp } from "./app.ts";
import { CALLER_HEADER, GCAL_CALLERS } from "./auth.ts";
import { serviceAuthConfigOf, type GcalEnv } from "./env.ts";
import { CALL_HEADERS, GATEWAY, LOCAL_ENV, LOCAL_TOKEN, connectMcp, fakeGoogle, setup } from "./test-helpers.ts";

const SA_GATEWAY = "sa-gateway@proj.iam.gserviceaccount.com";
const SA_APP = "sa-app@proj.iam.gserviceaccount.com";
const GCAL_URL = "https://gcal-123.asia-northeast1.run.app";
const NOW_SEC = 1_792_000_000;
const clock = manualClock(NOW_SEC * 1000);

const CLOUD_ENV: GcalEnv = {
  deploymentMode: "cloud",
  port: 0,
  sharedToken: undefined,
  selfUrl: GCAL_URL,
  gatewaySaEmail: SA_GATEWAY,
  googleCalendarApiBase: "https://www.googleapis.com/calendar/v3",
  commitSha: undefined,
};

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
/** Google の ID トークンの形（署名は "c2ln"。試験の検証器だけが通す） */
function idToken(email: string, aud = GCAL_URL, over: Partial<IdTokenClaims> = {}): string {
  const claims = { iss: "https://accounts.google.com", aud, sub: `sub-${email}`, email, email_verified: true, iat: NOW_SEC - 10, exp: NOW_SEC + 3600, ...over };
  return `${b64({ alg: "RS256", kid: "k1" })}.${b64(claims)}.c2ln`;
}
const fakeVerifier: IdTokenSignatureVerifier = async (token) => {
  if (!token.endsWith(".c2ln")) throw new Error("署名が違う");
  const claims = decodeJwtClaims(token);
  if (!claims) throw new Error("形が違う");
  return claims;
};

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** 認証の結果：接続（initialize）が通れば 200、拒否なら HTTP の状態コード */
async function statusWith(app: Parameters<typeof connectMcp>[0], headers: Record<string, string>): Promise<number> {
  try {
    const c = await connectMcp(app, headers);
    clients.push(c);
    return 200;
  } catch (e) {
    if (e instanceof StreamableHTTPError) return e.code ?? -1;
    throw e;
  }
}

describe("呼び出し元の確認（16 §3.2：sa-gateway だけ）", () => {
  it("設定：呼べるのは sa-gateway だけ（cloud は aud = GCAL_URL）", () => {
    expect(GCAL_CALLERS).toEqual(["sa-gateway"]);
    expect(serviceAuthConfigOf(LOCAL_ENV)).toEqual({ mode: "local", sharedToken: LOCAL_TOKEN });
    expect(serviceAuthConfigOf(CLOUD_ENV)).toEqual({ mode: "cloud", audience: GCAL_URL, callerEmails: { "sa-gateway": SA_GATEWAY } });
  });

  it("local：共有トークン＋ sa-gateway は通る。sa-app・名前なし・トークン違いは 403", async () => {
    const { app } = setup(fakeGoogle(() => new Response(null, { status: 500 })));
    expect(await statusWith(app, GATEWAY)).toBe(200);
    expect(await statusWith(app, { authorization: `Bearer ${LOCAL_TOKEN}`, [CALLER_HEADER]: "sa-app" })).toBe(403);
    expect(await statusWith(app, { authorization: `Bearer ${LOCAL_TOKEN}` })).toBe(403);
    expect(await statusWith(app, { authorization: "Bearer wrong-token-0123456789-0123456789", [CALLER_HEADER]: "sa-gateway" })).toBe(403);
  });

  it("cloud：sa-gateway の ID トークン（aud = GCAL_URL）だけ通る。他の email・aud の違いは 403", async () => {
    const auth = createServiceAuth(serviceAuthConfigOf(CLOUD_ENV), { verifier: fakeVerifier, clock });
    const app = createApp(CLOUD_ENV, { serviceAuth: auth, fetch: fakeGoogle(() => new Response(null, { status: 500 })).fetch });
    expect(await statusWith(app, { authorization: `Bearer ${idToken(SA_GATEWAY)}` })).toBe(200);
    expect(await statusWith(app, { authorization: `Bearer ${idToken(SA_APP)}` })).toBe(403);
    expect(await statusWith(app, { authorization: `Bearer ${idToken(SA_GATEWAY, "https://other.example.com")}` })).toBe(403);
    expect(await statusWith(app, {})).toBe(403);
  });

  it("GET・DELETE は 405（認証の後）。/healthz は認証なし", async () => {
    const { app } = setup(fakeGoogle(() => new Response(null, { status: 500 })));
    expect((await app.request("http://gcal.test/mcp/gcal", { method: "GET", headers: GATEWAY })).status).toBe(405);
    expect((await app.request("http://gcal.test/mcp/gcal", { method: "DELETE", headers: GATEWAY })).status).toBe(405);
    expect((await app.request("http://gcal.test/mcp/gcal", { method: "GET" })).status).toBe(403);
    const health = await app.request("http://gcal.test/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "gcal", commit: "0123abc" });
  });

  it("tools/call の CALL_HEADERS は確かめの後に読む（sa-app からは届かない）", async () => {
    const { app } = setup(fakeGoogle(() => new Response(null, { status: 500 })));
    expect(await statusWith(app, { ...CALL_HEADERS, [CALLER_HEADER]: "sa-app", authorization: `Bearer ${LOCAL_TOKEN}` })).toBe(403);
  });
});
