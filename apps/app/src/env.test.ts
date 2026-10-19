// 環境変数（SO-ENV-01〜08）。名前だけを返し、値は出さない（D-47）
import { describe, expect, it } from "vitest";
import { readAppEnv } from "./env.ts";

const S32 = "s".repeat(32);
const OWNER = "o".repeat(32);
const GUEST = "g".repeat(32);

const base = {
  PHASE0_ACCESS_TOKEN: OWNER,
  SESSION_COOKIE_SECRET: S32,
  GUEST_ENTRY_TOKEN: GUEST,
  DATABASE_URL: "postgres://app@db/open_team",
  DATABASE_URL_MAINT: "postgres://maint@db/open_team",
  APP_BASE_URL: "http://localhost:5173",
  GATEWAY_URL: "http://localhost:8081",
  SIM_WORLD_URL: "http://localhost:8082",
  COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
};

describe("readAppEnv", () => {
  it("SO-ENV-01 {} → 必須の名前を順に（DATABASE_URL は必須：セッションを DB に置くため）", () => {
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

  it("GATEWAY_URL・SIM_WORLD_URL・INTERNAL_SHARED_TOKEN が任意（ないとき共有トークンは空）", () => {
    const r = readAppEnv({ PHASE0_ACCESS_TOKEN: OWNER, SESSION_COOKIE_SECRET: S32, DATABASE_URL: "postgres://x/y" });
    expect(r.missing).toEqual([]);
    expect(r.env.serviceAuth).toEqual({ sharedToken: undefined });
    expect(r.env.gatewayUrl).toBeUndefined();
  });

  it("INTERNAL_SHARED_TOKEN が短い → 名前を積む", () => {
    const r = readAppEnv({ PHASE0_ACCESS_TOKEN: OWNER, SESSION_COOKIE_SECRET: S32, DATABASE_URL: "postgres://x/y", INTERNAL_SHARED_TOKEN: "short" });
    expect(r.missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
  });

  it("全部そろう → missing なし、共有トークンが読まれる", () => {
    const r = readAppEnv({ ...base, INTERNAL_SHARED_TOKEN: S32 });
    expect(r.missing).toEqual([]);
    expect(r.env.cookieSecure).toBe(true);
    expect(r.env.serviceAuth).toEqual({ sharedToken: S32 });
  });

  it("SO-ENV-05・06 COOKIE_SECURE は既定 true、false にできる", () => {
    expect(readAppEnv(base).env.cookieSecure).toBe(true);
    expect(readAppEnv({ ...base, COOKIE_SECURE: "false" }).env.cookieSecure).toBe(false);
  });

  it("GEMINI_API_KEY は任意。あれば gemini.apiKey に入る（missing に値は出ない）", () => {
    expect(readAppEnv(base).env.gemini.apiKey).toBeUndefined();
    const r = readAppEnv({ ...base, GEMINI_API_KEY: "AIza-secret-value" });
    expect(r.env.gemini.apiKey).toBe("AIza-secret-value");
    expect(r.missing).toEqual([]);
  });

  it("URL の形が不正 → 名前", () => {
    expect(readAppEnv({ ...base, GATEWAY_URL: "ftp://gateway" }).missing).toEqual(["GATEWAY_URL"]);
  });

  it("PLATFORM_CEILINGS_VERSION は必須にしない（M-59）", () => {
    expect(readAppEnv(base).missing).not.toContain("PLATFORM_CEILINGS_VERSION");
  });

  it("Google カレンダーの連携は4つ（＋APP_BASE_URL）がそろい、鍵が32バイトのときだけ有効。準備中の名前には積まない", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const google = {
      GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-value",
      OAUTH_TOKEN_KEY: key,
      GCAL_URL: "https://gcal-123.example.test/",
    };
    const off = readAppEnv({ ...base });
    expect(off.env.googleConnect).toBeUndefined();
    expect(off.missing).toEqual([]);

    const on = readAppEnv({ ...base, ...google });
    expect(on.missing).toEqual([]);
    expect(on.env.googleConnect).toEqual({
      clientId: google.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: google.GOOGLE_OAUTH_CLIENT_SECRET,
      tokenKey: key,
      gcalUrl: "https://gcal-123.example.test",
      appBaseUrl: "http://localhost:5173",
    });

    // どれか欠ける・鍵が32バイトでない・GCAL_URL が URL でない → 無効（起動は止めない）
    const { GOOGLE_OAUTH_CLIENT_SECRET: _s, ...noSecret } = google;
    expect(readAppEnv({ ...base, ...noSecret }).env.googleConnect).toBeUndefined();
    expect(readAppEnv({ ...base, ...google, OAUTH_TOKEN_KEY: Buffer.alloc(16).toString("base64") }).env.googleConnect).toBeUndefined();
    expect(readAppEnv({ ...base, ...google, OAUTH_TOKEN_KEY: "not-base64-key" }).env.googleConnect).toBeUndefined();
    expect(readAppEnv({ ...base, ...google, GCAL_URL: "ftp://gcal" }).env.googleConnect).toBeUndefined();
    const { APP_BASE_URL: _b, ...noBase } = base;
    expect(readAppEnv({ ...noBase, ...google }).env.googleConnect).toBeUndefined();
    expect(readAppEnv({ ...base, ...google, GCAL_URL: "ftp://gcal" }).missing).toEqual([]);
  });
});

describe("作業場（SANDBOX_*：D-116）", () => {
  const local = { PHASE0_ACCESS_TOKEN: OWNER, SESSION_COOKIE_SECRET: S32, DATABASE_URL: "postgres://x/y" };
  it("既定は none。不正な値・足りない値は名前で返す", () => {
    const r = readAppEnv(local);
    expect(r.missing).toEqual([]);
    expect(r.env.sandbox.provider).toBe("none");
    expect(readAppEnv({ ...local, SANDBOX_PROVIDER: "kubernetes" }).missing).toEqual(["SANDBOX_PROVIDER"]);
    expect(readAppEnv({ ...local, SANDBOX_PROVIDER: "cloudrun" }).missing).toEqual(["SANDBOX_PROVIDER"]);
    expect(readAppEnv({ ...local, SANDBOX_PROVIDER: "docker", SANDBOX_EDGE_URL: "http://app:8080" }).missing).toEqual(["SANDBOX_DOCKER_IMAGE"]);
  });

  it("docker は作業場が呼ぶ URL とイメージがそろえば通る", () => {
    const r = readAppEnv({ ...local, SANDBOX_PROVIDER: "docker", SANDBOX_EDGE_URL: "http://app:8080/", SANDBOX_DOCKER_IMAGE: "sandbox:latest" });
    expect(r.missing).toEqual([]);
    expect(r.env.sandbox).toMatchObject({ provider: "docker", edgeUrl: "http://app:8080", dockerImage: "sandbox:latest" });
  });

  it("inprocess は通る", () => {
    expect(readAppEnv({ ...local, SANDBOX_PROVIDER: "inprocess" }).missing).toEqual([]);
  });
});
