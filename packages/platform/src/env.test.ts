import { describe, expect, it } from "vitest";
import { EnvReader, MIN_SECRET_LENGTH, describeMissing, normalizeServiceUrl } from "./env.ts";

const S32 = "s".repeat(MIN_SECRET_LENGTH);

describe("EnvReader（足りない・不正な名前だけを積む。D-47）", () => {
  it("SO-ENV-01 足りない名前は読んだ順（既存の並び：PHASE0_ACCESS_TOKEN → SESSION_COOKIE_SECRET）", () => {
    const r = new EnvReader({});
    r.secret("PHASE0_ACCESS_TOKEN", { required: true });
    r.secret("SESSION_COOKIE_SECRET", { required: true });
    expect(r.missing).toEqual(["PHASE0_ACCESS_TOKEN", "SESSION_COOKIE_SECRET"]);
  });

  it("SO-ENV-02 秘密は 31文字で足りない、32文字で足りる", () => {
    const short = new EnvReader({ PHASE0_ACCESS_TOKEN: "a".repeat(31) });
    expect(short.secret("PHASE0_ACCESS_TOKEN", { required: true })).toBeUndefined();
    expect(short.missing).toEqual(["PHASE0_ACCESS_TOKEN"]);
    const ok = new EnvReader({ PHASE0_ACCESS_TOKEN: "a".repeat(32) });
    expect(ok.secret("PHASE0_ACCESS_TOKEN", { required: true })).toBe("a".repeat(32));
    expect(ok.missing).toEqual([]);
  });

  it("秘密の値は前後の空白を除かない。前後に空白・改行があれば不正（改行の混入に気づけるように）", () => {
    const r = new EnvReader({ A: `${S32}\n`, B: ` ${S32}`, C: `${S32}` });
    expect(r.secret("A")).toBeUndefined();
    expect(r.secret("B")).toBeUndefined();
    expect(r.secret("C")).toBe(S32);
    expect(r.missing).toEqual(["A", "B"]);
  });

  it("必須でない秘密は、無ければ積まない。あって短ければ積む（minLength を変えられる）", () => {
    const r = new EnvReader({ SHORT: "abc", OK8: "12345678" });
    expect(r.secret("NONE")).toBeUndefined();
    expect(r.secret("SHORT")).toBeUndefined();
    expect(r.secret("OK8", { minLength: 8 })).toBe("12345678");
    expect(r.missing).toEqual(["SHORT"]);
  });

  it("D-47 missing・describeMissing に値は出ない（名前だけ）", () => {
    const secret = "x".repeat(10);
    const r = new EnvReader({ PHASE0_ACCESS_TOKEN: secret, APP_BASE_URL: "https://user:pw-secret@example.com" });
    r.secret("PHASE0_ACCESS_TOKEN", { required: true });
    r.url("APP_BASE_URL", { required: true });
    const text = JSON.stringify(r.missing) + describeMissing(r.missing);
    expect(r.missing).toEqual(["PHASE0_ACCESS_TOKEN", "APP_BASE_URL"]);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("pw-secret");
    expect(describeMissing(r.missing)).toBe("足りない・不正な環境変数：PHASE0_ACCESS_TOKEN, APP_BASE_URL");
  });

  it("string は前後の空白を除き、空は無し。pattern に合わなければ不正", () => {
    const r = new EnvReader({ A: "  v  ", B: "   ", C: "abc" });
    expect(r.string("A")).toBe("v");
    expect(r.string("B", { required: true })).toBeUndefined();
    expect(r.string("C", { pattern: /^\d+$/ })).toBeUndefined();
    expect(r.missing).toEqual(["B", "C"]);
  });

  it("url は正規化（末尾の / を除く・ホストを小文字）し、認証情報・クエリ・#・http(s) 以外は不正", () => {
    const r = new EnvReader({
      A: "https://Gateway-123.asia-northeast1.run.app/",
      B: "https://u:p@sim-world.run.app",
      C: "https://sim-world.run.app?x=1",
      D: "https://sim-world.run.app#f",
      E: "ftp://example.com",
      F: "not a url",
      G: "http://localhost:8081/",
    });
    expect(r.url("A")).toBe("https://gateway-123.asia-northeast1.run.app");
    expect(r.url("B")).toBeUndefined();
    expect(r.url("C")).toBeUndefined();
    expect(r.url("D")).toBeUndefined();
    expect(r.url("E")).toBeUndefined();
    expect(r.url("F")).toBeUndefined();
    expect(r.url("G")).toBe("http://localhost:8081");
    expect(r.missing).toEqual(["B", "C", "D", "E", "F"]);
  });

  it("url の httpsOnly は http を不正にする（cloud の aud）", () => {
    const r = new EnvReader({ GATEWAY_URL: "http://gateway-123.asia-northeast1.run.app" });
    expect(r.url("GATEWAY_URL", { required: true, httpsOnly: true })).toBeUndefined();
    expect(r.missing).toEqual(["GATEWAY_URL"]);
  });

  it("email は形を確かめて小文字にそろえる", () => {
    const r = new EnvReader({ A: "SA-App@Proj.iam.gserviceaccount.com", B: "no-at-mark", C: "a@b" });
    expect(r.email("A")).toBe("sa-app@proj.iam.gserviceaccount.com");
    expect(r.email("B")).toBeUndefined();
    expect(r.email("C")).toBeUndefined();
    expect(r.email("D", { required: true })).toBeUndefined();
    expect(r.missing).toEqual(["B", "C", "D"]);
  });

  it("port は 0〜65535 の整数（既定 8080）。外れは名前を積んで既定値", () => {
    expect(new EnvReader({}).port()).toBe(8080);
    expect(new EnvReader({ PORT: "0" }).port()).toBe(0);
    expect(new EnvReader({ PORT: "65535" }).port()).toBe(65535);
    for (const bad of ["abc", "70000", "-1", "80.5", "1e3"]) {
      const r = new EnvReader({ PORT: bad });
      expect(r.port()).toBe(8080);
      expect(r.missing).toEqual(["PORT"]);
    }
  });

  it("int の範囲", () => {
    const r = new EnvReader({ N: "5", M: "11" });
    expect(r.int("N", { fallback: 1, min: 1, max: 10 })).toBe(5);
    expect(r.int("M", { fallback: 1, min: 1, max: 10 })).toBe(1);
    expect(r.int("NONE", { fallback: 3 })).toBe(3);
    expect(r.missing).toEqual(["M"]);
  });

  it("list はカンマで分け、前後の空白を除いて空を捨てる。必須で空なら積む", () => {
    const r = new EnvReader({ L: " https://a.run.app , ,https://b.run.app,", E: " , " });
    expect(r.list("L")).toEqual(["https://a.run.app", "https://b.run.app"]);
    expect(r.list("E", { required: true })).toEqual([]);
    expect(r.list("NONE")).toEqual([]);
    expect(r.missing).toEqual(["E"]);
  });

  it("SO-ENV-07 置いてはいけない変数（GEMINI_API_KEY）は、値があれば名前を積む", () => {
    const set = new EnvReader({ GEMINI_API_KEY: "x" });
    set.forbid("GEMINI_API_KEY");
    set.forbid("GOOGLE_API_KEY");
    expect(set.missing).toEqual(["GEMINI_API_KEY"]);
    const blank = new EnvReader({ GEMINI_API_KEY: " " });
    blank.forbid("GEMINI_API_KEY");
    expect(blank.missing).toEqual([]);
  });

  it("flag は重複しない", () => {
    const r = new EnvReader({});
    r.flag("X");
    r.flag("X");
    expect(r.missing).toEqual(["X"]);
  });

  it("done は env と missing の写しを返す（あとから積んでも前の結果は変わらない）", () => {
    const r = new EnvReader({});
    r.flag("A");
    const first = r.done({ a: 1 });
    r.flag("B");
    expect(first).toEqual({ env: { a: 1 }, missing: ["A"] });
    expect(r.done({}).missing).toEqual(["A", "B"]);
    // missing の配列を書き換えても reader は変わらない
    r.missing.push("C");
    expect(r.missing).toEqual(["A", "B"]);
  });

  it("has は空白だけの値を無しとみなす", () => {
    const r = new EnvReader({ A: "x", B: "  " });
    expect(r.has("A")).toBe(true);
    expect(r.has("B")).toBe(false);
    expect(r.has("C")).toBe(false);
  });
});

describe("normalizeServiceUrl", () => {
  it("パスは残し、末尾の / だけ除く。ポートは残す", () => {
    expect(normalizeServiceUrl("https://x.run.app/mcp/shop/")).toBe("https://x.run.app/mcp/shop");
    expect(normalizeServiceUrl("http://localhost:8081")).toBe("http://localhost:8081");
    expect(normalizeServiceUrl(" https://X.run.app ")).toBe("https://x.run.app");
    expect(normalizeServiceUrl("http://localhost:8081", true)).toBeNull();
    expect(normalizeServiceUrl("javascript:alert(1)")).toBeNull();
  });
});
