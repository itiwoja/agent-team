import { describe, expect, it } from "vitest";
import { MAX_DEPTH, MAX_STRING_LENGTH, REDACTED, isSensitiveKey, knownSecretsFromEnv, maskSecrets, redact } from "./mask.ts";

// 試験用の偽の秘密（実在しない値）
const GHS = "ghs_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const SK = "sk-" + "proj-" + "abcdEFGH1234ijklMNOP5678qrst";
const AKIA = "AKIA" + "IOSFODNN7EXAMPLE";
const JWT =
  "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIiwidHlwIjoiSldUIn0" +
  ".eyJhdWQiOiJodHRwczovL2dhdGV3YXkucnVuLmFwcCIsImVtYWlsIjoic2EtYXBwQHAuaWFtLmdzZXJ2aWNlYWNjb3VudC5jb20ifQ" +
  ".c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----";

describe("maskSecrets のパターン（NFR-057・NFR-032、SO §3.17 の 2・I-29）", () => {
  it.each([
    ["NFR-057 ghs_（GitHub App のトークン）", `token is ${GHS} ok`, `token is ${REDACTED} ok`],
    ["ghp_・github_pat_", `a ghp_${"x".repeat(36)} b github_pat_${"Y".repeat(40)}`, `a ${REDACTED} b ${REDACTED}`],
    ["NFR-057 sk-（API キー）", `key=${SK}`, `key=${REDACTED}`],
    ["NFR-057 AKIA（AWS のアクセスキー ID）", `id ${AKIA} end`, `id ${REDACTED} end`],
    ["Google のアクセストークン ya29.", "use ya29.a0AfH6SMBx-y_z.123 now", `use ${REDACTED} now`],
    ["Google の API キー AIza", `k=AIza${"B".repeat(35)}`, `k=${REDACTED}`],
    ["JWT（ID トークン）", `got ${JWT} back`, `got ${REDACTED} back`],
    ["署名を外した JWT（末尾が .）", "x eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ. y", `x ${REDACTED} y`],
    ["Bearer のトークン", "sent Bearer abc.DEF-123_~+/= done", `sent Bearer ${REDACTED} done`],
    ["Authorization ヘッダー（行の終わりまで）", "Authorization: Basic dXNlcjpwYXNz\nnext line", `Authorization: ${REDACTED}\nnext line`],
    ["Cookie ヘッダー", "Cookie: ot_session=abc; theme=dark", `Cookie: ${REDACTED}`],
    ["Set-Cookie ヘッダー", "set-cookie: ot_session=zzz; HttpOnly", `set-cookie: ${REDACTED}`],
    ["JSON の中の x-task-token", '{"x-task-token":"tt-1234567890","n":1}', `{"x-task-token":"${REDACTED}","n":1}`],
    ["X-CSRF-Token ヘッダー", "X-CSRF-Token: Zm9vYmFy", `X-CSRF-Token: ${REDACTED}`],
    ["セッションの Cookie の値", "cookie value ot_session=s3cr3tvalue;", `cookie value ot_session=${REDACTED};`],
    ["DB の URL のパスワード", "postgres://ot_app:p%40ss-w0rd@10.0.0.3:5432/open_team", `postgres://ot_app:${REDACTED}@10.0.0.3:5432/open_team`],
  ])("%s", (_label, input, expected) => {
    expect(maskSecrets(input)).toBe(expected);
  });

  it("NFR-057 秘密鍵のヘッダーから END まで（複数行）。END がなければ終わりまで", () => {
    expect(maskSecrets(`before\n${PEM}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    expect(maskSecrets("x -----BEGIN RSA PRIVATE KEY-----\nMIIabc\n(切れた)")).toBe(`x ${REDACTED}`);
    expect(maskSecrets("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----")).toBe(REDACTED);
  });

  it("1つの文字列の中の複数の秘密をすべて隠す", () => {
    const out = maskSecrets(`a ${GHS} b ${SK} c ${AKIA} d ${JWT}`);
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED} d ${REDACTED}`);
  });

  it("誤検出しない：語の途中の sk-・カナリア・SKU・ふつうの文", () => {
    for (const text of [
      "task-1234567890abcdefghij を作った",
      "desk-1234567890abcdefghij",
      "risk-free な変更",
      "ワンタイムパスワード：OT-CANARY-0123456789ab",
      "BEAN-HOUSE を 20 個発注",
      "inputTokens=1200 outputTokens=300",
      "postgres://ot_app@localhost/open_team",
      "https://gateway-123.asia-northeast1.run.app/mcp/supplier",
      "ghs_short",
      "AKIA の形の説明",
    ]) {
      expect(maskSecrets(text)).toBe(text);
    }
  });

  it("既知の値（環境変数の秘密・リクエストのトークン）はそのままの一致で全部隠す", () => {
    const token = "entry-token-0123456789-abcdefghij";
    expect(maskSecrets(`x ${token} y ${token}`, [token])).toBe(`x ${REDACTED} y ${REDACTED}`);
    // 長い方を先に（短い方が長い方の一部でも、長い方が丸ごと消える）
    const long = `${token}-and-more`;
    expect(maskSecrets(`v=${long}`, [token, long])).toBe(`v=${REDACTED}`);
  });

  it("短すぎる既知の値（8文字未満）・空文字は使わない（設定の誤りで全部が消えない）", () => {
    expect(maskSecrets("a b c abc", ["a", "", "abc"])).toBe("a b c abc");
    expect(maskSecrets("12345678", ["12345678"])).toBe(REDACTED);
  });
});

describe("isSensitiveKey（キーの名前で値ごと隠す）", () => {
  it.each([
    "authorization",
    "Authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-task-token",
    "X-CSRF-Token",
    "csrfToken",
    "taskToken",
    "idToken",
    "token",
    "password",
    "dbPassword",
    "secret",
    "clientSecret",
    "apiKey",
    "api_key",
    "privateKey",
    "credentials",
  ])("%s は隠す", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["inputTokens", "maxOutputTokens", "thoughtsTokens", "tokenCount", "taskTokenHash", "reason", "event", "requestId", "publicKey", "email"])(
    "%s は隠さない",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe("redact（構造ごとマスク）", () => {
  it("入れ子・配列の文字列をマスクし、秘密の名前のキーは値ごと隠す（null は残す）", () => {
    const out = redact(
      {
        headers: { authorization: "Bearer x", cookie: "ot_session=1", "x-request-id": "req_1", accept: "*/*" },
        items: [{ note: `key ${SK}` }, "plain"],
        csrfToken: null,
        inputTokens: 1200,
      },
      [],
    );
    expect(out).toEqual({
      headers: { authorization: REDACTED, cookie: REDACTED, "x-request-id": "req_1", accept: "*/*" },
      items: [{ note: `key ${REDACTED}` }, "plain"],
      csrfToken: null,
      inputTokens: 1200,
    });
  });

  it("Error は name・message・stack・cause にし、どれもマスクする", () => {
    const err = new Error(`connect failed postgres://u:hunter2-pass@db/x`, { cause: new Error(`inner ${GHS}`) });
    const out = redact({ error: err }) as { error: { name: string; message: string; stack: string; cause: { message: string } } };
    expect(out.error.name).toBe("Error");
    expect(out.error.message).toBe(`connect failed postgres://u:${REDACTED}@db/x`);
    expect(out.error.stack).not.toContain("hunter2-pass");
    expect(out.error.cause.message).toBe(`inner ${REDACTED}`);
  });

  it("循環・深すぎる入れ子・長すぎる文字列で落ちない", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redact(a)).toEqual({ name: "a", self: "[循環]" });
    // 同じオブジェクトを2か所から指すのは循環ではない
    const shared = { v: 1 };
    expect(redact({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });

    let deep: unknown = "leaf";
    for (let i = 0; i < MAX_DEPTH + 3; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[深すぎるので省略]");

    const long = "x".repeat(MAX_STRING_LENGTH + 100);
    const cut = redact(long) as string;
    expect(cut.length).toBeLessThan(long.length);
    expect(cut.startsWith("x".repeat(MAX_STRING_LENGTH))).toBe(true);
  });

  it("bigint・Date・Uint8Array・関数・undefined を JSON にできる形にする", () => {
    const out = redact({
      n: 12n,
      at: new Date("2026-10-08T00:00:00.000Z"),
      bad: new Date(Number.NaN),
      hash: new Uint8Array([0, 255, 16]),
      big: new Uint8Array(100),
      fn: () => 1,
      u: undefined,
      list: [undefined, () => 1, 1],
    });
    expect(out).toEqual({
      n: "12",
      at: "2026-10-08T00:00:00.000Z",
      bad: null,
      hash: "00ff10",
      big: "[100 バイト]",
      fn: undefined,
      list: [null, null, 1],
    });
    expect(JSON.parse(JSON.stringify(out))).not.toHaveProperty("u");
  });

  it("既知の値はキーの名前に関係なく隠す", () => {
    const s = "shared-token-0123456789-0123456789";
    expect(redact({ note: `x ${s}`, list: [s] }, [s])).toEqual({ note: `x ${REDACTED}`, list: [REDACTED] });
  });
});

describe("knownSecretsFromEnv", () => {
  it("決まった名前の、8文字以上の値だけを拾う", () => {
    const env = {
      PHASE0_ACCESS_TOKEN: "o".repeat(32),
      GUEST_ENTRY_TOKEN: "short",
      INTERNAL_SHARED_TOKEN: "i".repeat(40),
      DATABASE_URL: "postgres://u:p@h/db",
      PORT: "8080",
    };
    expect(knownSecretsFromEnv(env)).toEqual(["o".repeat(32), "i".repeat(40), "postgres://u:p@h/db"]);
    expect(knownSecretsFromEnv({})).toEqual([]);
  });
});
