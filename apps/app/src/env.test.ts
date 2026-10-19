// 環境変数（SO §3.1.1、SO-ENV-01〜08）。名前だけを返し、値は出さない（D-47）
import { describe, expect, it } from "vitest";
import { readAppEnv } from "./env.ts";

const S32 = "s".repeat(32);
const OWNER = "o".repeat(32);
const GUEST = "g".repeat(32);

const cloudBase = {
  DEPLOYMENT_MODE: "public",
  PHASE0_ACCESS_TOKEN: OWNER,
  SESSION_COOKIE_SECRET: S32,
  GUEST_ENTRY_TOKEN: GUEST,
  DATABASE_URL: "postgres://app@db/open_team",
  DATABASE_URL_MAINT: "postgres://maint@db/open_team",
  APP_BASE_URL: "https://app.example.com",
  APP_INTERNAL_URL: "https://app-123.asia-northeast1.run.app",
  GATEWAY_URL: "https://gateway-123.asia-northeast1.run.app",
  SIM_WORLD_URL: "https://sim-world-123.asia-northeast1.run.app",
  APP_SA_EMAIL: "sa-app@proj.iam.gserviceaccount.com",
  GOOGLE_CLOUD_PROJECT: "proj",
  GOOGLE_CLOUD_LOCATION: "global",
  GEMINI_MODEL_PLANNER: "gemini-3.1-pro",
  GEMINI_MODEL_AGENT: "gemini-3.8-flash",
  COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
};

describe("readAppEnv", () => {
  it("SO-ENV-01 {} → 必須の名前を順に（DATABASE_URL は local でも必須：セッションを DB に置くため）", () => {
    expect(readAppEnv({}).missing).toEqual(["PHASE0_ACCESS_TOKEN", "SESSION_COOKIE_SECRET", "DATABASE_URL"]);
  });

  it("SO-ENV-02 31文字 ／ 32文字", () => {
    const base = { SESSION_COOKIE_SECRET: S32, DATABASE_URL: "postgres://x/y" };
    expect(readAppEnv({ ...base, PHASE0_ACCESS_TOKEN: "o".repeat(31) }).missing).toEqual(["PHASE0_ACCESS_TOKEN"]);
    expect(readAppEnv({ ...base, PHASE0_ACCESS_TOKEN: OWNER }).missing).toEqual([]);
  });

  it("GUEST_RETEST_MODE は gemini のときだけ gemini、それ以外（なし・不正）は replay", () => {
    const base = { PHASE0_ACCESS_TOKEN: OWNER, SESSION_COOKIE_SECRET: S32, DATABASE_URL: "postgres://x/y" };
    expect(readAppEnv(base).env.guestRetestMode).toBe("replay");
    expect(readAppEnv({ ...base, GUEST_RETEST_MODE: "gemini" }).env.guestRetestMode).toBe("gemini");
    expect(readAppEnv({ ...base, GUEST_RETEST_MODE: "foo" }).env.guestRetestMode).toBe("replay");
  });

  it("local は GATEWAY_URL・SIM_WORLD_URL・INTERNAL_SHARED_TOKEN が任意（ないとき共有トークンは空）", () => {
    const r = readAppEnv({ PHASE0_ACCESS_TOKEN: OWNER, SESSION_COOKIE_SECRET: S32, DATABASE_URL: "postgres://x/y" });
    expect(r.missing).toEqual([]);
    expect(r.env.deploymentMode).toBe("local");
    expect(r.env.serviceAuth).toEqual({ mode: "local", sharedToken: undefined });
    expect(r.env.gatewayUrl).toBeUndefined();
  });

  it("local で INTERNAL_SHARED_TOKEN が短い → 名前を積む", () => {
    const r = readAppEnv({ PHASE0_ACCESS_TOKEN: OWNER, SESSION_COOKIE_SECRET: S32, DATABASE_URL: "postgres://x/y", INTERNAL_SHARED_TOKEN: "short" });
    expect(r.missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
  });

  it("cloud（public）で全部そろう → missing なし、Cookie は Secure、aud は APP_INTERNAL_URL", () => {
    const r = readAppEnv(cloudBase);
    expect(r.missing).toEqual([]);
    expect(r.env.deploymentMode).toBe("cloud");
    expect(r.env.cookieSecure).toBe(true);
    expect(r.env.serviceAuth).toEqual({
      mode: "cloud",
      audience: "https://app-123.asia-northeast1.run.app",
      callerEmails: { "sa-app": "sa-app@proj.iam.gserviceaccount.com" },
    });
    expect(r.env.appInternalUrl).toBe("https://app-123.asia-northeast1.run.app");
  });

  it("SO-ENV-03 cloud で GUEST_ENTRY_TOKEN なし → 名前", () => {
    const { GUEST_ENTRY_TOKEN: _, ...rest } = cloudBase;
    expect(readAppEnv(rest).missing).toEqual(["GUEST_ENTRY_TOKEN"]);
  });

  it("SO-ENV-04 cloud で GUEST_ENTRY_TOKEN = PHASE0_ACCESS_TOKEN → GUEST_ENTRY_TOKEN", () => {
    expect(readAppEnv({ ...cloudBase, GUEST_ENTRY_TOKEN: OWNER }).missing).toEqual(["GUEST_ENTRY_TOKEN"]);
  });

  it("SO-ENV-05・06 cloud の COOKIE_SECURE=false は無視（true）、local は false にできる", () => {
    expect(readAppEnv({ ...cloudBase, COOKIE_SECURE: "false" }).env.cookieSecure).toBe(true);
    expect(readAppEnv({ COOKIE_SECURE: "false" }).env.cookieSecure).toBe(false);
  });

  it("SO-ENV-07 cloud で GEMINI_API_KEY・GOOGLE_API_KEY → 準備中（名前だけ）", () => {
    const r = readAppEnv({ ...cloudBase, GEMINI_API_KEY: "AIza-secret-value", GOOGLE_API_KEY: "x" });
    expect(r.missing).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    expect(JSON.stringify(r.missing)).not.toContain("AIza");
  });

  it("cloud で http の URL ・メールの形でない → 名前", () => {
    const r = readAppEnv({ ...cloudBase, GATEWAY_URL: "http://gateway", APP_SA_EMAIL: "not-an-email" });
    expect(r.missing).toEqual(["APP_SA_EMAIL", "GATEWAY_URL"]);
  });

  it("cloud で足りないものを SO §3.1.1 の順に近い順で積む（値は入れない）", () => {
    const r = readAppEnv({ DEPLOYMENT_MODE: "public" });
    expect(r.missing).toEqual([
      "PHASE0_ACCESS_TOKEN",
      "SESSION_COOKIE_SECRET",
      "DATABASE_URL",
      "GUEST_ENTRY_TOKEN",
      "DATABASE_URL_MAINT",
      "APP_BASE_URL",
      "APP_INTERNAL_URL",
      "APP_SA_EMAIL",
      "GATEWAY_URL",
      "SIM_WORLD_URL",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
      "GEMINI_MODEL_PLANNER",
      "GEMINI_MODEL_AGENT",
      "COMMIT_SHA",
    ]);
  });

  it("Cloud Run（K_SERVICE あり）で DEPLOYMENT_MODE がない → cloud として読み、DEPLOYMENT_MODE を積む", () => {
    const r = readAppEnv({ ...cloudBase, DEPLOYMENT_MODE: undefined, K_SERVICE: "app" });
    expect(r.env.deploymentMode).toBe("cloud");
    expect(r.missing).toContain("DEPLOYMENT_MODE");
  });

  it("PLATFORM_CEILINGS_VERSION は必須にしない（M-59）", () => {
    expect(readAppEnv(cloudBase).missing).not.toContain("PLATFORM_CEILINGS_VERSION");
  });

  it("Google カレンダーの連携は4つ（＋APP_BASE_URL）がそろい、鍵が32バイトのときだけ有効。準備中の名前には積まない", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const google = {
      GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-value",
      OAUTH_TOKEN_KEY: key,
      GCAL_URL: "https://gcal-123.asia-northeast1.run.app/",
    };
    const off = readAppEnv({ ...cloudBase });
    expect(off.env.googleConnect).toBeUndefined();
    expect(off.missing).toEqual([]);

    const on = readAppEnv({ ...cloudBase, ...google });
    expect(on.missing).toEqual([]);
    expect(on.env.googleConnect).toEqual({
      clientId: google.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: google.GOOGLE_OAUTH_CLIENT_SECRET,
      tokenKey: key,
      gcalUrl: "https://gcal-123.asia-northeast1.run.app",
      appBaseUrl: "https://app.example.com",
    });

    // どれか欠ける・鍵が32バイトでない・GCAL_URL が URL でない → 無効（起動は止めない）
    const { GOOGLE_OAUTH_CLIENT_SECRET: _s, ...noSecret } = google;
    expect(readAppEnv({ ...cloudBase, ...noSecret }).env.googleConnect).toBeUndefined();
    expect(readAppEnv({ ...cloudBase, ...google, OAUTH_TOKEN_KEY: Buffer.alloc(16).toString("base64") }).env.googleConnect).toBeUndefined();
    expect(readAppEnv({ ...cloudBase, ...google, OAUTH_TOKEN_KEY: "not-base64-key" }).env.googleConnect).toBeUndefined();
    expect(readAppEnv({ ...cloudBase, ...google, GCAL_URL: "ftp://gcal" }).env.googleConnect).toBeUndefined();
    const { APP_BASE_URL: _b, ...noBase } = cloudBase;
    expect(readAppEnv({ ...noBase, ...google, DEPLOYMENT_MODE: "local" }).env.googleConnect).toBeUndefined();
    expect(readAppEnv({ ...cloudBase, ...google, GCAL_URL: "ftp://gcal" }).missing).toEqual([]);
  });
});

describe("作業場（SANDBOX_*：D-116）", () => {
  const local = { PHASE0_ACCESS_TOKEN: OWNER, SESSION_COOKIE_SECRET: S32, DATABASE_URL: "postgres://x/y" };
  it("既定は none。不正な値・足りない値は名前で返す", () => {
    const r = readAppEnv(local);
    expect(r.missing).toEqual([]);
    expect(r.env.sandbox.provider).toBe("none");
    expect(readAppEnv({ ...local, SANDBOX_PROVIDER: "kubernetes" }).missing).toEqual(["SANDBOX_PROVIDER"]);
    expect(readAppEnv({ ...local, SANDBOX_PROVIDER: "cloudrun" }).missing).toEqual(["SANDBOX_JOB", "SANDBOX_EDGE_URL"]);
    expect(readAppEnv({ ...local, SANDBOX_PROVIDER: "docker", SANDBOX_EDGE_URL: "http://app:8080" }).missing).toEqual(["SANDBOX_DOCKER_IMAGE"]);
  });

  it("cloudrun はジョブの名前の形と作業場が呼ぶ URL がそろえば通る", () => {
    const r = readAppEnv({ ...local, SANDBOX_PROVIDER: "cloudrun", SANDBOX_JOB: "projects/p/locations/asia-northeast1/jobs/sandbox", SANDBOX_EDGE_URL: "https://app.example.com/" });
    expect(r.missing).toEqual([]);
    expect(r.env.sandbox).toMatchObject({ provider: "cloudrun", job: "projects/p/locations/asia-northeast1/jobs/sandbox", edgeUrl: "https://app.example.com" });
  });

  it("隔離のない inprocess は cloud では使えない（準備中にする）", () => {
    expect(readAppEnv({ ...cloudBase, SANDBOX_PROVIDER: "inprocess" }).missing).toEqual(["SANDBOX_PROVIDER"]);
    expect(readAppEnv({ ...local, SANDBOX_PROVIDER: "inprocess" }).missing).toEqual([]);
  });
});
