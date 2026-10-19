// 起動時の確認（SO §3.1.2・§7.1、MT §3.12.1・§6.9 BD-04〜06、BR-66・15:489）
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GatewayStartupError,
  assertAllowedConnectorUrls,
  assertGatewayEnv,
  normalizeConnectorUrl,
  readGatewayEnv,
  readProjectNumber,
  simWorldUrlNeedsProjectNumber,
} from "./env.ts";

const SIM = "https://sim-world-123456789012.asia-northeast1.run.app";
const DB_URL = "postgres://gw:pw@10.0.0.5:5432/open_team";
const TOKEN = "x".repeat(40);

const cloudVars = (over: Record<string, string | undefined> = {}) => ({
  DEPLOYMENT_MODE: "public",
  DATABASE_URL: DB_URL,
  GATEWAY_URL: "https://gateway-123456789012.asia-northeast1.run.app",
  APP_SA_EMAIL: "sa-app@proj.iam.gserviceaccount.com",
  SIM_WORLD_URL: SIM,
  ALLOWED_CONNECTOR_URLS: SIM,
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
    expect(normalizeConnectorUrl("  https://Sim-World-1.Run.App/  ", "cloud")).toBe("https://sim-world-1.run.app");
    expect(normalizeConnectorUrl("https://sim.example/mcp/shop/store/", "cloud")).toBe("https://sim.example/mcp/shop/store");
  });
  it("SO-ENV-13 公開デプロイでは http・認証情報・クエリ・#・既定でないポートを断る", () => {
    for (const u of ["http://sim.example", "https://u:p@sim.example", "https://sim.example/?x=1", "https://sim.example/#a", "https://sim.example:8443", "notaurl"]) {
      expect(() => normalizeConnectorUrl(u, "cloud"), u).toThrow();
    }
    // https の 443 は既定のポート（URL が空にする）
    expect(normalizeConnectorUrl("https://sim.example:443/", "cloud")).toBe("https://sim.example");
  });
  it("local は http とポートを許す（docker compose の http://localhost:8081）。認証情報・クエリは断る", () => {
    expect(normalizeConnectorUrl("http://localhost:8081/", "local")).toBe("http://localhost:8081");
    expect(() => normalizeConnectorUrl("ftp://x.example", "local")).toThrow();
    expect(() => normalizeConnectorUrl("http://u:p@localhost:8081", "local")).toThrow();
    expect(() => normalizeConnectorUrl("http://localhost:8081/?q=1", "local")).toThrow();
  });
});

describe("assertAllowedConnectorUrls（BR-66、BD-04〜06、SO-ENV-09〜15）", () => {
  it("SO-ENV-10 一覧が SIM_WORLD_URL と同じ origin だけなら起動する（正規化した一覧を返す）", () => {
    const r = assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [SIM], simWorldUrl: SIM });
    expect(r).toEqual({ allowedConnectorUrls: [SIM], simWorldUrl: SIM });
  });
  it("SO-ENV-11 同じ URL ＋ /、大文字のホスト、同じものを2つ → 起動する（重複を除く）", () => {
    const r = assertAllowedConnectorUrls({
      deploymentMode: "cloud",
      allowedConnectorUrls: [`${SIM}/`, SIM.toUpperCase().replace("HTTPS", "https"), ` ${SIM} `, ""],
      simWorldUrl: SIM,
    });
    expect(r.allowedConnectorUrls).toEqual([SIM]);
  });
  it("BD-04・SO-ENV-12 一覧に sim-world 以外が1つ → 起動しない", () => {
    const e = refused(() =>
      assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [SIM, "https://gmail.mcp.example.com"], simWorldUrl: SIM }),
    );
    expect(e.reasons.join()).toContain("sim-world 以外");
  });
  it("SO-BD-04 の形：sim-world のホスト名を前に付けた別のホスト → 起動しない（origin で比べる）", () => {
    refused(() => assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [`${SIM}.evil.com`], simWorldUrl: SIM }));
  });
  it("BD-05・SO-ENV-09 一覧が空 → 起動しない", () => {
    const e = refused(() => assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [], simWorldUrl: SIM }));
    expect(e.reasons.join()).toContain("空");
  });
  it("BD-06 SIM_WORLD_URL がない（public）→ 起動しない", () => {
    const e = refused(() => assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [SIM], simWorldUrl: undefined }));
    expect(e.reasons.join()).toContain("SIM_WORLD_URL");
  });
  it("SO-ENV-13 一覧に http・認証情報・クエリ・ポートつき → 起動しない", () => {
    for (const bad of [SIM.replace("https", "http"), SIM.replace("https://", "https://u:p@"), `${SIM}?x=1`, `${SIM}:8443`]) {
      refused(() => assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [bad], simWorldUrl: SIM }));
    }
  });
  it("SO-ENV-14 SIM_WORLD_URL のプロジェクト番号が自分と違う → 起動しない。同じなら起動する", () => {
    refused(() => assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [SIM], simWorldUrl: SIM }, { projectNumber: "999" }));
    expect(() =>
      assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [SIM], simWorldUrl: SIM }, { projectNumber: "123456789012" }),
    ).not.toThrow();
    // 旧形式の URL（ハッシュの入った a.run.app）は番号を比べない（デプロイのスクリプトで照合する）
    const old = "https://sim-world-abcdef-an.a.run.app";
    expect(() => assertAllowedConnectorUrls({ deploymentMode: "cloud", allowedConnectorUrls: [old], simWorldUrl: old }, { projectNumber: "999" })).not.toThrow();
    expect(simWorldUrlNeedsProjectNumber(SIM)).toBe(true);
    expect(simWorldUrlNeedsProjectNumber(old)).toBe(false);
    expect(simWorldUrlNeedsProjectNumber(null)).toBe(false);
  });
  it("SO-ENV-15 local は一覧に実の MCP サーバーがあっても起動する（確かめない）。ただし読めない URL は断る", () => {
    expect(() =>
      assertAllowedConnectorUrls({ deploymentMode: "local", allowedConnectorUrls: ["https://mcp.example.com", "http://localhost:8081"], simWorldUrl: undefined }),
    ).not.toThrow();
    refused(() => assertAllowedConnectorUrls({ deploymentMode: "local", allowedConnectorUrls: ["::not a url::"], simWorldUrl: undefined }));
  });
});

describe("readGatewayEnv・assertGatewayEnv（SO §2.2）", () => {
  it("cloud：必須がそろえば GatewayEnv（呼び出し元は sa-app、aud は GATEWAY_URL）", () => {
    const env = assertGatewayEnv(cloudVars({ PORT: "9090", COMMIT_SHA: "abc123" }));
    expect(env).toMatchObject({
      deploymentMode: "cloud",
      port: 9090,
      databaseUrl: DB_URL,
      allowedConnectorUrls: [SIM],
      simWorldUrl: SIM,
      simWorldSharedToken: undefined,
      commitSha: "abc123",
    });
    expect(env.serviceAuth).toEqual({
      mode: "cloud",
      audience: "https://gateway-123456789012.asia-northeast1.run.app",
      callerEmails: { "sa-app": "sa-app@proj.iam.gserviceaccount.com" },
    });
  });
  it("cloud：足りない名前を返し、値は出さない（D-47）", () => {
    const r = readGatewayEnv({ DEPLOYMENT_MODE: "cloud", DATABASE_URL: DB_URL });
    expect(r.env).toBeNull();
    expect(r.missing).toEqual(expect.arrayContaining(["GATEWAY_URL", "APP_SA_EMAIL", "SIM_WORLD_URL", "ALLOWED_CONNECTOR_URLS"]));
    const e = refused(() => assertGatewayEnv({ DEPLOYMENT_MODE: "cloud", DATABASE_URL: DB_URL }));
    expect(e.message).not.toContain(DB_URL);
  });
  it("cloud：CONNECTOR_ENC_KEY を置いたら起動しない（BR-66・D-11：実のコネクタの認証情報を置かない）", () => {
    const r = readGatewayEnv(cloudVars({ CONNECTOR_ENC_KEY: "k".repeat(44) }));
    expect(r.env).toBeNull();
    expect(r.missing).toContain("CONNECTOR_ENC_KEY");
  });
  it("cloud：一覧に余計な URL → 起動しない（BD-04。理由を返す）", () => {
    const r = readGatewayEnv(cloudVars({ ALLOWED_CONNECTOR_URLS: `${SIM},https://evil.example` }));
    expect(r.env).toBeNull();
    expect(r.reasons.join()).toContain("sim-world 以外");
  });
  it("local：INTERNAL_SHARED_TOKEN（受ける側）と、SIM_WORLD_URL があれば SIM_WORLD_SHARED_TOKEN が要る", () => {
    expect(readGatewayEnv({ DATABASE_URL: DB_URL }).missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    expect(readGatewayEnv({ DATABASE_URL: DB_URL, INTERNAL_SHARED_TOKEN: TOKEN, SIM_WORLD_URL: "http://localhost:8081" }).missing).toEqual([
      "SIM_WORLD_SHARED_TOKEN",
    ]);
    const env = assertGatewayEnv({
      DATABASE_URL: DB_URL,
      INTERNAL_SHARED_TOKEN: TOKEN,
      SIM_WORLD_URL: "http://localhost:8081/",
      SIM_WORLD_SHARED_TOKEN: TOKEN,
      ALLOWED_CONNECTOR_URLS: "http://localhost:8081",
    });
    expect(env).toMatchObject({ deploymentMode: "local", simWorldUrl: "http://localhost:8081", simWorldSharedToken: TOKEN, allowedConnectorUrls: ["http://localhost:8081"] });
    expect(env.serviceAuth).toEqual({ mode: "local", sharedToken: TOKEN });
  });
  it("DATABASE_URL がなければ起動しない（どちらのモードでも）", () => {
    expect(readGatewayEnv({ INTERNAL_SHARED_TOKEN: TOKEN }).missing).toContain("DATABASE_URL");
  });
  it("知らない DEPLOYMENT_MODE は厳しい側（cloud）で読み、起動しない", () => {
    const r = readGatewayEnv({ ...cloudVars(), DEPLOYMENT_MODE: "prod" });
    expect(r.env).toBeNull();
    expect(r.missing).toContain("DEPLOYMENT_MODE");
  });
});

describe("readProjectNumber（SO §3.1.2 の2-4）", () => {
  it("メタデータサーバーの数字を返す。読めない・数字でなければ null", async () => {
    const ok = (async (_u: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("metadata-flavor")).toBe("Google");
      return new Response("123456789012\n");
    }) as typeof fetch;
    expect(await readProjectNumber(ok)).toBe("123456789012");
    expect(await readProjectNumber((async () => new Response("nope")) as typeof fetch)).toBeNull();
    expect(await readProjectNumber((async () => new Response("1", { status: 404 })) as typeof fetch)).toBeNull();
    expect(
      await readProjectNumber((async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
    ).toBeNull();
  });
});

describe("Google カレンダー（GCAL_URL。16 §3.5・ADR-040）", () => {
  const GCAL = "https://gcal-123456789012.asia-northeast1.run.app";
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const gcalVars = (over: Record<string, string | undefined> = {}) => ({
    GCAL_URL: GCAL,
    GOOGLE_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_OAUTH_CLIENT_SECRET: "GOCSPX-" + "s".repeat(28),
    OAUTH_TOKEN_KEY: KEY,
    ...over,
  });
  const localVars = (over: Record<string, string | undefined> = {}) => ({
    DATABASE_URL: DB_URL,
    INTERNAL_SHARED_TOKEN: TOKEN,
    ...gcalVars({ GCAL_URL: "http://localhost:8083", GCAL_SHARED_TOKEN: TOKEN }),
    ...over,
  });

  it("GCAL_URL がなければ gcal は null（「つなぐ」は出さない）", () => {
    expect(assertGatewayEnv(cloudVars()).gcal).toBeNull();
  });
  it("cloud：GCAL_URL と許可の一覧の GCAL の origin がそろえば gcal を持つ（共有トークンは置かない）", () => {
    const env = assertGatewayEnv(cloudVars({ ...gcalVars(), ALLOWED_CONNECTOR_URLS: `${SIM},${GCAL}` }));
    expect(env.allowedConnectorUrls).toEqual([SIM, GCAL]);
    expect(env.gcal).toEqual({
      url: GCAL,
      origin: GCAL,
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "GOCSPX-" + "s".repeat(28),
      tokenKey: KEY,
      sharedToken: null,
    });
  });
  it("cloud：許可の一覧が GCAL_URL の origin も sim-world の origin も含まない → 起動しない", () => {
    const r = readGatewayEnv(cloudVars({ ...gcalVars(), ALLOWED_CONNECTOR_URLS: `${SIM},https://evil.example` }));
    expect(r.env).toBeNull();
    expect(r.reasons.join()).toContain("sim-world 以外");
  });
  it("GCAL_URL があるとき GOOGLE_OAUTH_CLIENT_ID・GOOGLE_OAUTH_CLIENT_SECRET・OAUTH_TOKEN_KEY が要る（名前だけ返す）", () => {
    const r = readGatewayEnv(cloudVars({ GCAL_URL: GCAL, ALLOWED_CONNECTOR_URLS: `${SIM},${GCAL}` }));
    expect(r.env).toBeNull();
    expect(r.missing).toEqual(expect.arrayContaining(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "OAUTH_TOKEN_KEY"]));
  });
  it("OAUTH_TOKEN_KEY は base64 の32バイトだけ（違えば名前を返す。値は出さない）", () => {
    const bad = Buffer.alloc(16, 1).toString("base64");
    const r = readGatewayEnv(cloudVars({ ...gcalVars({ OAUTH_TOKEN_KEY: bad }), ALLOWED_CONNECTOR_URLS: `${SIM},${GCAL}` }));
    expect(r.env).toBeNull();
    expect(r.missing).toEqual(["OAUTH_TOKEN_KEY"]);
    expect(JSON.stringify(r)).not.toContain(bad);
  });
  it("local：GCAL_URL があれば GCAL_SHARED_TOKEN が要る。揃えば gcal.sharedToken を持つ", () => {
    expect(readGatewayEnv(localVars({ GCAL_SHARED_TOKEN: undefined })).missing).toEqual(["GCAL_SHARED_TOKEN"]);
    const env = assertGatewayEnv(localVars());
    expect(env.gcal).toMatchObject({ url: "http://localhost:8083", origin: "http://localhost:8083", sharedToken: TOKEN });
  });
  it("cloud の GCAL_URL は https だけ（http は断る）", () => {
    const r = readGatewayEnv(cloudVars({ ...gcalVars({ GCAL_URL: "http://gcal.example" }), ALLOWED_CONNECTOR_URLS: SIM }));
    expect(r.env).toBeNull();
    expect(r.missing).toContain("GCAL_URL");
  });
});

describe("GitHub（GITHUB_URL。18 §3.5）", () => {
  const GH = "https://github-123456789012.asia-northeast1.run.app";
  const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const ghVars = (over: Record<string, string | undefined> = {}) => ({ GITHUB_URL: GH, GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: PEM, ...over });

  it("GITHUB_URL がなければ github は null", () => {
    expect(assertGatewayEnv(cloudVars()).github).toBeNull();
  });
  it("cloud：GITHUB_URL・App の ID・鍵と許可の一覧がそろえば github を持つ（API の既定は api.github.com）", () => {
    const env = assertGatewayEnv(cloudVars({ ...ghVars(), ALLOWED_CONNECTOR_URLS: `${SIM},${GH}` }));
    expect(env.allowedConnectorUrls).toEqual([SIM, GH]);
    expect(env.github).toEqual({ url: GH, origin: GH, appId: "123456", privateKey: PEM.trim(), apiBase: "https://api.github.com", sharedToken: null });
  });
  it("鍵が PEM でない・App の ID が数字でない → 名前だけ返して起動しない", () => {
    const r = readGatewayEnv(cloudVars({ ...ghVars({ GITHUB_APP_PRIVATE_KEY: "nope-not-a-key", GITHUB_APP_ID: "abc" }), ALLOWED_CONNECTOR_URLS: `${SIM},${GH}` }));
    expect(r.env).toBeNull();
    expect(r.missing).toEqual(expect.arrayContaining(["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_ID"]));
    expect(JSON.stringify(r)).not.toContain("nope-not-a-key");
  });
  it("local：GITHUB_SHARED_TOKEN が要る", () => {
    const vars = { DATABASE_URL: DB_URL, INTERNAL_SHARED_TOKEN: TOKEN, ...ghVars({ GITHUB_URL: "http://localhost:8084" }) };
    expect(readGatewayEnv(vars).missing).toEqual(["GITHUB_SHARED_TOKEN"]);
    expect(assertGatewayEnv({ ...vars, GITHUB_SHARED_TOKEN: TOKEN }).github).toMatchObject({ origin: "http://localhost:8084", sharedToken: TOKEN });
  });
});
