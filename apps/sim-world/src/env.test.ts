import { describe, expect, it } from "vitest";
import { MIN_SHARED_TOKEN_LENGTH, readSimWorldEnv } from "./env.ts";

const TOKEN = "s".repeat(MIN_SHARED_TOKEN_LENGTH);
describe("readSimWorldEnv（SO §2.2・§3.1.3。読み方は platform の EnvReader・readServiceAuthEnv）", () => {
  it("共有トークン INTERNAL_SHARED_TOKEN（32文字以上。gateway・app と同じ値）が要る（G-11）", () => {
    expect(readSimWorldEnv({}).missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: "s".repeat(MIN_SHARED_TOKEN_LENGTH - 1) }).missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    // 前後に空白・改行のある値は不正（.env に改行つきで入れた値に気づけるように）
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: `${TOKEN}\n` }).missing).toEqual(["INTERNAL_SHARED_TOKEN"]);
    const ok = readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, PORT: "9090", COMMIT_SHA: "abc" });
    expect(ok.missing).toEqual([]);
    expect(ok.env).toEqual({
      port: 9090,
      sharedToken: TOKEN,
      databaseUrl: undefined,
      commitSha: "abc",
    });
  });

  it("DATABASE_URL があれば読み（Postgres の保存）、なくてもよい（メモリの保存）。形が違えば不正", () => {
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, DATABASE_URL: "postgres://postgres:pw@localhost:5432/open_team" }).env.databaseUrl).toBe(
      "postgres://postgres:pw@localhost:5432/open_team",
    );
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, DATABASE_URL: "postgresql://u@h/db" }).missing).toEqual([]);
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, DATABASE_URL: "mysql://u@h/db" }).missing).toEqual(["DATABASE_URL"]);
    expect(readSimWorldEnv({ INTERNAL_SHARED_TOKEN: TOKEN, DATABASE_URL: "   " }).env.databaseUrl).toBeUndefined();
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
