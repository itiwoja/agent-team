import { describe, expect, it } from "vitest";
import { MIN_SHARED_TOKEN_LENGTH, readSimWorldEnv } from "./env.ts";

const TOKEN = "s".repeat(MIN_SHARED_TOKEN_LENGTH);
const CLOUD = {
  DEPLOYMENT_MODE: "cloud",
  DATABASE_URL: "postgres://ot_sim:pw@/open_team?host=/cloudsql/proj:asia-northeast1:ot",
  SIM_WORLD_URL: "https://sim-world-123.asia-northeast1.run.app",
  GATEWAY_SA_EMAIL: "sa-gateway@proj.iam.gserviceaccount.com",
  APP_SA_EMAIL: "sa-app@proj.iam.gserviceaccount.com",
};

describe("readSimWorldEnv（SO §2.2・§3.1.3。読み方は platform の EnvReader・readServiceAuthEnv）", () => {
  it("既定は local で、共有トークン INTERNAL_SHARED_TOKEN（32文字以上。gateway・app と同じ値）が要る（G-11）", () => {
    expect(readSimWorldEnv({}).env.deploymentMode).toBe("local");
    expect(readSimWorldEnv({}).missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: "s".repeat(MIN_SHARED_TOKEN_LENGTH - 1) }).missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    // 前後に空白・改行のある値は不正（Secret Manager に改行つきで入れた値に気づけるように）
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: `${TOKEN}\n` }).missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    const ok = readSimWorldEnv({ DEPLOYMENT_MODE: "local", INTERNAL_SHARED_TOKEN: TOKEN, PORT: "9090", COMMIT_SHA: "abc" });
    expect(ok.missing).toEqual([]);
    expect(ok.env).toEqual({
      deploymentMode: "local",
      port: 9090,
      sharedToken: TOKEN,
      selfUrl: undefined,
      gatewaySaEmail: undefined,
      appSaEmail: undefined,
      databaseUrl: undefined,
      commitSha: "abc",
    });
  });

  it("local は DATABASE_URL があれば読み（Postgres の保存）、なくてもよい（メモリの保存）。形が違えば不正", () => {
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, DATABASE_URL: "postgres://postgres:pw@localhost:5432/open_team" }).env.databaseUrl).toBe(
      "postgres://postgres:pw@localhost:5432/open_team",
    );
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, DATABASE_URL: "postgresql://u@h/db" }).missing).toEqual([]);
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, DATABASE_URL: "mysql://u@h/db" }).missing).toEqual(["DATABASE_URL"]);
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, DATABASE_URL: "   " }).env.databaseUrl).toBeUndefined();
  });

  it("cloud（SO の名前 public も同じ）は DATABASE_URL・SIM_WORLD_URL・APP_SA_EMAIL・GATEWAY_SA_EMAIL が要る（SO-ENV-16）", () => {
    const ok = readSimWorldEnv(CLOUD);
    expect(ok.missing).toEqual([]);
    expect(ok.env).toMatchObject({
      deploymentMode: "cloud",
      databaseUrl: CLOUD.DATABASE_URL,
      selfUrl: CLOUD.SIM_WORLD_URL,
      gatewaySaEmail: CLOUD.GATEWAY_SA_EMAIL,
      appSaEmail: CLOUD.APP_SA_EMAIL,
      sharedToken: undefined,
    });
    expect(readSimWorldEnv({ ...CLOUD, DEPLOYMENT_MODE: "public" }).env.deploymentMode).toBe("cloud");
    expect(readSimWorldEnv({ DEPLOYMENT_MODE: "cloud" }).missing).toEqual(["DATABASE_URL", "SIM_WORLD_URL", "APP_SA_EMAIL", "GATEWAY_SA_EMAIL"]);
    const { GATEWAY_SA_EMAIL: _g, ...noGateway } = CLOUD;
    expect(readSimWorldEnv(noGateway).missing).toEqual(["GATEWAY_SA_EMAIL"]);
    const { DATABASE_URL: _d, ...noDb } = CLOUD;
    expect(readSimWorldEnv(noDb).missing).toEqual(["DATABASE_URL"]);
    // cloud では共有トークンを見ない
    expect(readSimWorldEnv({ ...CLOUD, INTERNAL_SHARED_TOKEN: "short" }).missing).toEqual([]);
  });

  it("SIM_WORLD_URL は https だけ（認証情報・クエリなし）。末尾の / と大文字のホストは正規化（ID トークンの aud）", () => {
    expect(readSimWorldEnv({ ...CLOUD, SIM_WORLD_URL: "not a url" }).missing).toEqual(["SIM_WORLD_URL"]);
    expect(readSimWorldEnv({ ...CLOUD, SIM_WORLD_URL: "http://sim-world-123.asia-northeast1.run.app" }).missing).toEqual(["SIM_WORLD_URL"]);
    expect(readSimWorldEnv({ ...CLOUD, SIM_WORLD_URL: "https://u:p@sim-world-123.asia-northeast1.run.app" }).missing).toEqual(["SIM_WORLD_URL"]);
    expect(readSimWorldEnv({ ...CLOUD, SIM_WORLD_URL: "https://Sim-World-123.asia-northeast1.run.app/" }).env.selfUrl).toBe(CLOUD.SIM_WORLD_URL);
  });

  it("gateway と app が同じ email だと呼び出し元を見分けられないので不可。email の形でなければ不正。小文字にそろえる", () => {
    expect(readSimWorldEnv({ ...CLOUD, GATEWAY_SA_EMAIL: CLOUD.APP_SA_EMAIL }).missing).toEqual(["GATEWAY_SA_EMAIL"]);
    expect(readSimWorldEnv({ ...CLOUD, GATEWAY_SA_EMAIL: "no-at-mark" }).missing).toEqual(["GATEWAY_SA_EMAIL"]);
    expect(readSimWorldEnv({ ...CLOUD, APP_SA_EMAIL: "SA-App@Proj.iam.gserviceaccount.com" }).env.appSaEmail).toBe(CLOUD.APP_SA_EMAIL);
  });

  it("知らない DEPLOYMENT_MODE・Cloud Run（K_SERVICE）なのに local は厳しい側（cloud）で読み、起動させない", () => {
    const r = readSimWorldEnv({ ...CLOUD, DEPLOYMENT_MODE: "prod" });
    expect(r.env.deploymentMode).toBe("cloud");
    expect(r.missing).toEqual(["DEPLOYMENT_MODE"]);
    const onCloudRun = readSimWorldEnv({ ...CLOUD, DEPLOYMENT_MODE: "local", K_SERVICE: "sim-world", INTERNAL_SHARED_TOKEN: TOKEN });
    expect(onCloudRun.env.deploymentMode).toBe("cloud");
    expect(onCloudRun.missing).toEqual(["DEPLOYMENT_MODE"]);
  });

  it("PORT は 0〜65535 の整数（既定 8080）", () => {
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN }).env.port).toBe(8080);
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, PORT: "abc" }).missing).toEqual(["PORT"]);
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, PORT: "70000" }).missing).toEqual(["PORT"]);
  });

  it("D-47 missing に値は出さない（名前だけ）", () => {
    const secret = "x".repeat(10);
    const r = readSimWorldEnv({ INTERNAL_SHARED_TOKEN: secret, DATABASE_URL: `nope://${secret}` });
    expect(r.missing).toEqual(["DATABASE_URL", "INTERNAL_SHARED_TOKEN"]);
    expect(JSON.stringify(r.missing)).not.toContain(secret);
  });
});
