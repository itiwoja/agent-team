// 起動時の確認（SO §3.1.2・§7.1、MT §3.12.1、BR-66）
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GatewayStartupError, assertAllowedConnectorUrls, assertGatewayEnv, normalizeConnectorUrl, readGatewayEnv } from "./env.ts";

const SIM = "http://localhost:8081";
const DB_URL = "postgres://gw:pw@10.0.0.5:5432/open_team";
const TOKEN = "x".repeat(40);

const baseVars = (over: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: DB_URL,
  INTERNAL_SHARED_TOKEN: TOKEN,
  SIM_WORLD_URL: SIM,
  SIM_WORLD_SHARED_TOKEN: TOKEN,
  ...over,
});

function refused(fn: () => unknown): GatewayStartupError {
  try {
    fn();
  } catch (e) {
    if (e instanceof GatewayStartupError) return e;
    throw e;
  }
  throw new Error("起動を断るはずが通った");
}

describe("normalizeConnectorUrl（SO §3.1.2）", () => {
  it("SO-ENV-11 末尾の / を除き、ホストを小文字にする", () => {
    expect(normalizeConnectorUrl("  https://Sim-World-1.Example.com/  ")).toBe("https://sim-world-1.example.com");
    expect(normalizeConnectorUrl("https://sim.example/mcp/shop/store/")).toBe("https://sim.example/mcp/shop/store");
  });
  it("http とポートを許す（docker compose の http://localhost:8081）。https の 443 は URL が空にする", () => {
    expect(normalizeConnectorUrl("http://localhost:8081/")).toBe("http://localhost:8081");
    expect(normalizeConnectorUrl("https://sim.example:443/")).toBe("https://sim.example");
  });
  it("SO-ENV-13 http・https 以外、認証情報・クエリ・#、読めない URL は断る", () => {
    for (const u of ["ftp://x.example", "http://u:p@localhost:8081", "https://u:p@sim.example", "http://localhost:8081/?q=1", "https://sim.example/#a", "notaurl"]) {
      expect(() => normalizeConnectorUrl(u), u).toThrow();
    }
  });
});

describe("assertAllowedConnectorUrls（BR-66、SO-ENV-09〜15）", () => {
  it("SO-ENV-11 同じ URL ＋ /、同じものを2つ、空 → 起動する（正規化して重複を除く）", () => {
    const r = assertAllowedConnectorUrls({ allowedConnectorUrls: [`${SIM}/`, ` ${SIM} `, ""], simWorldUrl: SIM });
    expect(r).toEqual({ allowedConnectorUrls: [SIM], simWorldUrl: SIM });
  });
  it("SO-ENV-15 一覧に実の MCP サーバーがあっても、一覧が空でも、SIM_WORLD_URL がなくても起動する（確かめない）", () => {
    expect(() =>
      assertAllowedConnectorUrls({ allowedConnectorUrls: ["https://mcp.example.com", "http://localhost:8081"], simWorldUrl: undefined }),
    ).not.toThrow();
    expect(assertAllowedConnectorUrls({ allowedConnectorUrls: [], simWorldUrl: undefined })).toEqual({ allowedConnectorUrls: [], simWorldUrl: null });
  });
  it("一覧に読めない URL・認証情報つきがあれば起動しない", () => {
    refused(() => assertAllowedConnectorUrls({ allowedConnectorUrls: ["::not a url::"], simWorldUrl: undefined }));
    refused(() => assertAllowedConnectorUrls({ allowedConnectorUrls: ["https://u:p@mcp.example.com"], simWorldUrl: undefined }));
  });
  it("SIM_WORLD_URL が不正なら起動しない", () => {
    const e = refused(() => assertAllowedConnectorUrls({ allowedConnectorUrls: [], simWorldUrl: "ftp://sim.example" }));
    expect(e.reasons.join()).toContain("SIM_WORLD_URL");
  });
});

describe("readGatewayEnv・assertGatewayEnv（SO §2.2）", () => {
  it("INTERNAL_SHARED_TOKEN（受ける側）と、SIM_WORLD_URL があれば SIM_WORLD_SHARED_TOKEN が要る", () => {
    expect(readGatewayEnv({ DATABASE_URL: DB_URL }).missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    expect(readGatewayEnv({ DATABASE_URL: DB_URL, INTERNAL_SHARED_TOKEN: TOKEN, SIM_WORLD_URL: SIM }).missing).toEqual(["SIM_WORLD_SHARED_TOKEN"]);
    const env = assertGatewayEnv({
      DATABASE_URL: DB_URL,
      INTERNAL_SHARED_TOKEN: TOKEN,
      PORT: "9090",
      COMMIT_SHA: "abc123",
      SIM_WORLD_URL: "http://localhost:8081/",
      SIM_WORLD_SHARED_TOKEN: TOKEN,
      ALLOWED_CONNECTOR_URLS: "http://localhost:8081",
    });
    expect(env).toMatchObject({ port: 9090, simWorldUrl: SIM, simWorldSharedToken: TOKEN, allowedConnectorUrls: [SIM], commitSha: "abc123" });
    expect(env.serviceAuth).toEqual({ sharedToken: TOKEN });
  });
  it("SIM_WORLD_URL がなければ sim-world なし（SIM_WORLD_SHARED_TOKEN は要らない）", () => {
    const env = assertGatewayEnv({ DATABASE_URL: DB_URL, INTERNAL_SHARED_TOKEN: TOKEN });
    expect(env).toMatchObject({ simWorldUrl: null, simWorldSharedToken: undefined, allowedConnectorUrls: [] });
  });
  it("DATABASE_URL がなければ起動しない。足りない名前だけ返し、値は出さない（D-47）", () => {
    expect(readGatewayEnv({ INTERNAL_SHARED_TOKEN: TOKEN }).missing).toContain("DATABASE_URL");
    const e = refused(() => assertGatewayEnv({ DATABASE_URL: DB_URL }));
    expect(e.message).not.toContain(DB_URL);
  });
  it("一覧の URL が不正 → 起動しない（理由を返す）", () => {
    const r = readGatewayEnv(baseVars({ ALLOWED_CONNECTOR_URLS: "::bad::" }));
    expect(r.env).toBeNull();
    expect(r.reasons.join()).toContain("ALLOWED_CONNECTOR_URLS");
  });
});

describe("Google カレンダー（GCAL_URL。16 §3.5・ADR-040）", () => {
  const GCAL = "http://localhost:8083";
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const gcalVars = (over: Record<string, string | undefined> = {}) =>
    baseVars({
      GCAL_URL: GCAL,
      GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-" + "s".repeat(28),
      OAUTH_TOKEN_KEY: KEY,
      GCAL_SHARED_TOKEN: TOKEN,
      ...over,
    });

  it("GCAL_URL がなければ gcal は null（「つなぐ」は出さない）", () => {
    expect(assertGatewayEnv(baseVars()).gcal).toBeNull();
  });
  it("GCAL_URL と必要な値がそろえば gcal を持つ（一覧に入れなくてよい）", () => {
    const env = assertGatewayEnv(gcalVars());
    expect(env.gcal).toEqual({
      url: GCAL,
      origin: GCAL,
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "GOCSPX-" + "s".repeat(28),
      tokenKey: KEY,
      sharedToken: TOKEN,
    });
  });
  it("GCAL_URL があるとき GOOGLE_OAUTH_CLIENT_ID・GOOGLE_OAUTH_CLIENT_SECRET・OAUTH_TOKEN_KEY が要る（名前だけ返す）", () => {
    const r = readGatewayEnv(baseVars({ GCAL_URL: GCAL, GCAL_SHARED_TOKEN: TOKEN }));
    expect(r.env).toBeNull();
    expect(r.missing).toEqual(expect.arrayContaining(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "OAUTH_TOKEN_KEY"]));
  });
  it("OAUTH_TOKEN_KEY は base64 の32バイトだけ（違えば名前を返す。値は出さない）", () => {
    const bad = Buffer.alloc(16, 1).toString("base64");
    const r = readGatewayEnv(gcalVars({ OAUTH_TOKEN_KEY: bad }));
    expect(r.env).toBeNull();
    expect(r.missing).toEqual(["OAUTH_TOKEN_KEY"]);
    expect(JSON.stringify(r)).not.toContain(bad);
  });
  it("GCAL_URL があれば GCAL_SHARED_TOKEN が要る", () => {
    expect(readGatewayEnv(gcalVars({ GCAL_SHARED_TOKEN: undefined })).missing).toEqual(["GCAL_SHARED_TOKEN"]);
  });
  it("GCAL_URL が http・https 以外なら断る", () => {
    const r = readGatewayEnv(gcalVars({ GCAL_URL: "ftp://gcal.example" }));
    expect(r.env).toBeNull();
    expect(r.missing).toContain("GCAL_URL");
  });
});

describe("GitHub（GITHUB_URL。18 §3.5）", () => {
  const GH = "http://localhost:8084";
  const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const ghVars = (over: Record<string, string | undefined> = {}) =>
    baseVars({ GITHUB_URL: GH, GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_SHARED_TOKEN: TOKEN, ...over });

  it("GITHUB_URL がなければ github は null", () => {
    expect(assertGatewayEnv(baseVars()).github).toBeNull();
  });
  it("GITHUB_URL・App の ID・鍵・共有トークンがそろえば github を持つ（API の既定は api.github.com）", () => {
    const env = assertGatewayEnv(ghVars());
    expect(env.github).toEqual({ url: GH, origin: GH, appId: "123456", privateKey: PEM.trim(), apiBase: "https://api.github.com", sharedToken: TOKEN });
  });
  it("鍵が PEM でない・App の ID が数字でない → 名前だけ返して起動しない", () => {
    const r = readGatewayEnv(ghVars({ GITHUB_APP_PRIVATE_KEY: "nope-not-a-key", GITHUB_APP_ID: "abc" }));
    expect(r.env).toBeNull();
    expect(r.missing).toEqual(expect.arrayContaining(["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_ID"]));
    expect(JSON.stringify(r)).not.toContain("nope-not-a-key");
  });
  it("GITHUB_SHARED_TOKEN が要る", () => {
    expect(readGatewayEnv(ghVars({ GITHUB_SHARED_TOKEN: undefined })).missing).toEqual(["GITHUB_SHARED_TOKEN"]);
    expect(assertGatewayEnv(ghVars()).github).toMatchObject({ origin: GH, sharedToken: TOKEN });
  });
});
