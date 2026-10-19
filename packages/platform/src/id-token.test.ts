import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";
import {
  bearerTokenOf,
  checkGoogleIdToken,
  createIdTokenSource,
  decodeJwtClaims,
  googleIdTokenVerifier,
  normalizeAudience,
  verifyGoogleIdToken,
  type IdTokenClaims,
  type IdTokenSignatureVerifier,
  type InternalAuthPolicy,
} from "./id-token.ts";
import { manualClock } from "./time.ts";

const APP_URL = "https://app-123456.asia-northeast1.run.app";
const GATEWAY_URL = "https://gateway-123456.asia-northeast1.run.app";
const SA_APP = "sa-app@proj.iam.gserviceaccount.com";
const SA_GATEWAY = "sa-gateway@proj.iam.gserviceaccount.com";
const NOW = Date.parse("2026-10-08T00:00:00.000Z");
const NOW_SEC = NOW / 1000;

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

/** 署名なしの形だけの JWT（偽の検証器・クレームの読み取り用） */
function fakeJwt(claims: IdTokenClaims): string {
  return `${b64({ alg: "RS256", kid: "k1", typ: "JWT" })}.${b64(claims)}.c2ln`;
}

function claimsFor(over: Partial<IdTokenClaims> = {}): IdTokenClaims {
  return {
    iss: "https://accounts.google.com",
    aud: APP_URL,
    sub: "1234567890",
    email: SA_APP,
    email_verified: true,
    iat: NOW_SEC - 60,
    exp: NOW_SEC + 3600,
    ...over,
  };
}

/** 偽の検証器：署名は見ず、トークンのクレームをそのまま返す（呼ばれた回数を数える） */
function fakeVerifier(): IdTokenSignatureVerifier & { calls: number } {
  const f = Object.assign(
    async (token: string): Promise<IdTokenClaims> => {
      f.calls++;
      const c = decodeJwtClaims(token);
      if (!c) throw new Error("bad");
      return c;
    },
    { calls: 0 },
  );
  return f;
}

const APP_POLICY: InternalAuthPolicy = { audience: APP_URL, allowedEmails: [SA_APP] };
const clock = manualClock(NOW);

describe("ID トークンの検証（SO §3.9。偽の検証器）", () => {
  it("SO-INT-04 sa-app の ID トークン（aud = APP_INTERNAL_URL）は通り、{ email, sub, audience } を返す", async () => {
    const verifier = fakeVerifier();
    const r = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor())}`, APP_POLICY, { verifier, clock });
    expect(r).toEqual({ ok: true, identity: { email: SA_APP, sub: "1234567890", audience: APP_URL } });
    expect(verifier.calls).toBe(1);
  });

  it("SO-INT-02 aud が gateway の URL のトークンで app を呼ぶと aud_mismatch（署名の検証まで行かない）", async () => {
    const verifier = fakeVerifier();
    const r = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ aud: GATEWAY_URL }))}`, APP_POLICY, { verifier, clock });
    expect(r).toEqual({ ok: false, reason: "aud_mismatch" });
    expect(verifier.calls).toBe(0);
  });

  it("SO-INT-03 sa-gateway の正しいトークンで app の /internal/* は email_not_allowed（email はログ用に返す）", async () => {
    const r = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ email: SA_GATEWAY }))}`, APP_POLICY, { verifier: fakeVerifier(), clock });
    expect(r).toEqual({ ok: false, reason: "email_not_allowed", email: SA_GATEWAY });
  });

  it("SO-INT-05 email_verified が true でない（false・文字列 'true'・なし）は拒否", async () => {
    for (const email_verified of [false, "true", undefined]) {
      const r = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ email_verified }))}`, APP_POLICY, { verifier: fakeVerifier(), clock });
      expect(r).toMatchObject({ ok: false, reason: "email_not_verified" });
    }
  });

  it("SO-INT-05 期限切れは拒否（exp ちょうどの時刻も切れ。1秒前なら通る）", async () => {
    const at = (exp: number) => checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ exp }))}`, APP_POLICY, { verifier: fakeVerifier(), clock });
    expect(await at(NOW_SEC - 1)).toEqual({ ok: false, reason: "expired" });
    expect(await at(NOW_SEC)).toEqual({ ok: false, reason: "expired" });
    expect((await at(NOW_SEC + 1)).ok).toBe(true);
    expect(await at("9999999999" as unknown as number)).toEqual({ ok: false, reason: "expired" });
  });

  it("Google 以外の発行者は issuer_mismatch", async () => {
    const r = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ iss: "https://evil.example" }))}`, APP_POLICY, { verifier: fakeVerifier(), clock });
    expect(r).toEqual({ ok: false, reason: "issuer_mismatch" });
    // 'accounts.google.com'（https なし）も Google の発行者
    expect((await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ iss: "accounts.google.com" }))}`, APP_POLICY, { verifier: fakeVerifier(), clock })).ok).toBe(
      true,
    );
  });

  it("Bearer でない・ヘッダーなし → no_bearer。JWT の形でない → malformed_token", async () => {
    for (const h of [undefined, null, "", "Basic abc", fakeJwt(claimsFor()), "Bearer"]) {
      expect(await checkGoogleIdToken(h, APP_POLICY, { verifier: fakeVerifier(), clock })).toEqual({ ok: false, reason: "no_bearer" });
    }
    for (const t of ["abc", "a.b", "a.b.c.d", `${b64({})}.${Buffer.from("not json").toString("base64url")}.x`, `${b64({})}.${b64([1, 2])}.x`]) {
      expect(await checkGoogleIdToken(`Bearer ${t}`, APP_POLICY, { verifier: fakeVerifier(), clock })).toEqual({ ok: false, reason: "malformed_token" });
    }
  });

  it("検証器が通さなければ invalid_token", async () => {
    const r = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor())}`, APP_POLICY, {
      verifier: async () => {
        throw new Error("Invalid token signature");
      },
      clock,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("検証器が返したクレームでもう一度 aud・email を確かめる（検証器が別のクレームを返しても素通りしない）", async () => {
    const lying = (over: Partial<IdTokenClaims>): IdTokenSignatureVerifier => async () => claimsFor(over);
    const token = `Bearer ${fakeJwt(claimsFor())}`;
    expect(await checkGoogleIdToken(token, APP_POLICY, { verifier: lying({ aud: GATEWAY_URL }), clock })).toEqual({ ok: false, reason: "aud_mismatch" });
    expect(await checkGoogleIdToken(token, APP_POLICY, { verifier: lying({ email: SA_GATEWAY }), clock })).toEqual({
      ok: false,
      reason: "email_not_allowed",
      email: SA_GATEWAY,
    });
    expect(await checkGoogleIdToken(token, APP_POLICY, { verifier: lying({ exp: NOW_SEC - 5 }), clock })).toEqual({ ok: false, reason: "expired" });
  });

  it("aud の末尾の / の有無は同じサービス。email は大文字小文字を区別しない", async () => {
    const policy: InternalAuthPolicy = { audience: `${APP_URL}/`, allowedEmails: [SA_APP.toUpperCase()] };
    const r1 = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor())}`, policy, { verifier: fakeVerifier(), clock });
    const r2 = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ aud: `${APP_URL}/`, email: "SA-App@proj.iam.gserviceaccount.com" }))}`, APP_POLICY, {
      verifier: fakeVerifier(),
      clock,
    });
    expect(r1).toMatchObject({ ok: true, identity: { email: SA_APP } });
    expect(r2).toMatchObject({ ok: true, identity: { email: SA_APP, audience: `${APP_URL}/` } });
    // 別のパスの aud は別物
    const r3 = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ aud: `${APP_URL}/internal` }))}`, APP_POLICY, { verifier: fakeVerifier(), clock });
    expect(r3).toEqual({ ok: false, reason: "aud_mismatch" });
  });

  it("aud・許す email が設定されていなければ全部拒否（not_configured）", async () => {
    const token = `Bearer ${fakeJwt(claimsFor())}`;
    expect(await checkGoogleIdToken(token, { audience: "", allowedEmails: [SA_APP] }, { verifier: fakeVerifier(), clock })).toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(await checkGoogleIdToken(token, { audience: APP_URL, allowedEmails: [" "] }, { verifier: fakeVerifier(), clock })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("sub がなければ malformed_token", async () => {
    const r = await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ sub: undefined }))}`, APP_POLICY, { verifier: fakeVerifier(), clock });
    expect(r).toMatchObject({ ok: false, reason: "malformed_token" });
  });

  it("I-27 verifySignature: false（IAM が確かめた gateway・sim-world）は検証器を呼ばず、クレームだけ確かめる", async () => {
    const verifier = fakeVerifier();
    const policy: InternalAuthPolicy = { audience: GATEWAY_URL, allowedEmails: [SA_APP], verifySignature: false };
    expect((await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ aud: GATEWAY_URL }))}`, policy, { verifier, clock })).ok).toBe(true);
    expect(await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ aud: APP_URL }))}`, policy, { verifier, clock })).toEqual({ ok: false, reason: "aud_mismatch" });
    expect(await checkGoogleIdToken(`Bearer ${fakeJwt(claimsFor({ aud: GATEWAY_URL, email_verified: false }))}`, policy, { verifier, clock })).toMatchObject({
      reason: "email_not_verified",
    });
    // 署名を外したトークン（末尾が .）も読める
    const stripped = fakeJwt(claimsFor({ aud: GATEWAY_URL })).replace(/\.[^.]*$/, ".");
    expect((await checkGoogleIdToken(`Bearer ${stripped}`, policy, { verifier, clock })).ok).toBe(true);
    expect(verifier.calls).toBe(0);
  });

  it("verifyGoogleIdToken（SO の形）は通れば CallerIdentity、だめなら null", async () => {
    expect(await verifyGoogleIdToken(`Bearer ${fakeJwt(claimsFor())}`, APP_POLICY, { verifier: fakeVerifier(), clock })).toEqual({
      email: SA_APP,
      sub: "1234567890",
      audience: APP_URL,
    });
    expect(await verifyGoogleIdToken(undefined, APP_POLICY, { verifier: fakeVerifier(), clock })).toBeNull();
  });
});

describe("google-auth-library の検証器（OAuth2Client.verifyIdToken。手元の鍵で署名）", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

  function signed(claims: IdTokenClaims, key: KeyObject = privateKey, kid = "k1"): string {
    const data = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(claims)}`;
    return `${data}.${createSign("RSA-SHA256").update(data).sign(key).toString("base64url")}`;
  }

  /** Google の公開鍵の取得を手元の鍵に差し替えた OAuth2Client（ネットワークに出ない） */
  function localClient(): OAuth2Client {
    const client = new OAuth2Client();
    const certs = { k1: publicKey.export({ type: "spki", format: "pem" }).toString() };
    client.getFederatedSignonCertsAsync = async () =>
      ({ certs, format: "PEM" }) as unknown as Awaited<ReturnType<OAuth2Client["getFederatedSignonCertsAsync"]>>;
    return client;
  }

  // ライブラリは実時間で exp を見るので、ここは本当の時刻で作る
  const real = (over: Partial<IdTokenClaims> = {}): IdTokenClaims => {
    const now = Math.floor(Date.now() / 1000);
    return claimsFor({ iat: now - 60, exp: now + 3600, ...over });
  };

  it("正しい署名・aud・email なら通る", async () => {
    const r = await checkGoogleIdToken(`Bearer ${signed(real())}`, APP_POLICY, { verifier: googleIdTokenVerifier(localClient()) });
    expect(r).toMatchObject({ ok: true, identity: { email: SA_APP } });
  });

  it("SO-INT-05 署名の改ざん（ペイロードの email を書き換え）・別の鍵の署名・知らない kid は invalid_token", async () => {
    const verifier = googleIdTokenVerifier(localClient());
    const original = signed(real({ email: SA_GATEWAY }));
    const [h, , s] = original.split(".");
    const tampered = `${h}.${b64(real({ email: SA_APP }))}.${s}`;
    expect(await checkGoogleIdToken(`Bearer ${tampered}`, APP_POLICY, { verifier })).toEqual({ ok: false, reason: "invalid_token" });
    expect(await checkGoogleIdToken(`Bearer ${signed(real(), other.privateKey)}`, APP_POLICY, { verifier })).toEqual({ ok: false, reason: "invalid_token" });
    expect(await checkGoogleIdToken(`Bearer ${signed(real(), privateKey, "unknown-kid")}`, APP_POLICY, { verifier })).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("SO-INT-05 期限切れは署名が正しくても拒否", async () => {
    const now = Math.floor(Date.now() / 1000);
    const r = await checkGoogleIdToken(`Bearer ${signed(real({ iat: now - 7200, exp: now - 600 }))}`, APP_POLICY, {
      verifier: googleIdTokenVerifier(localClient()),
    });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });
});

describe("ID トークンの取得とキャッシュ（SO §3.9 の getIdToken）", () => {
  function tokenWithExp(expSec: number, n = 0): string {
    return fakeJwt({ ...claimsFor(), exp: expSec, n });
  }

  it("SO-INT-07 期限の6分前はキャッシュを返し、4分前は取り直す（5分前ちょうども取り直す）", async () => {
    const c = manualClock(NOW);
    const exp = NOW_SEC + 3600;
    let n = 0;
    const fetchIdToken = vi.fn(async () => tokenWithExp(exp, ++n));
    const source = createIdTokenSource({ fetchIdToken, clock: c });
    const first = await source.getIdToken(GATEWAY_URL);
    expect(fetchIdToken).toHaveBeenCalledTimes(1);

    c.set((exp - 6 * 60) * 1000);
    expect(await source.getIdToken(GATEWAY_URL)).toBe(first);
    expect(fetchIdToken).toHaveBeenCalledTimes(1);

    c.set((exp - 5 * 60) * 1000);
    const second = await source.getIdToken(GATEWAY_URL);
    expect(fetchIdToken).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);

    c.set((exp - 4 * 60) * 1000);
    await source.getIdToken(GATEWAY_URL);
    expect(fetchIdToken).toHaveBeenCalledTimes(3);
  });

  it("aud ごとに別のトークン。末尾の / は同じ aud として扱い、取得には除いた aud を渡す", async () => {
    const fetchIdToken = vi.fn(async (aud: string) => fakeJwt({ ...claimsFor({ aud }), exp: NOW_SEC + 3600 }));
    const source = createIdTokenSource({ fetchIdToken, clock: manualClock(NOW) });
    const g1 = await source.getIdToken(`${GATEWAY_URL}/`);
    const g2 = await source.getIdToken(GATEWAY_URL);
    const a1 = await source.getIdToken(APP_URL);
    expect(g1).toBe(g2);
    expect(a1).not.toBe(g1);
    expect(fetchIdToken.mock.calls.map((c) => c[0])).toEqual([GATEWAY_URL, APP_URL]);
  });

  it("同じ aud の同時の取得は1回にまとめる", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchIdToken = vi.fn(async () => {
      await gate;
      return tokenWithExp(NOW_SEC + 3600);
    });
    const source = createIdTokenSource({ fetchIdToken, clock: manualClock(NOW) });
    const p = Promise.all([source.getIdToken(GATEWAY_URL), source.getIdToken(GATEWAY_URL)]);
    release();
    const [a, b] = await p;
    expect(a).toBe(b);
    expect(fetchIdToken).toHaveBeenCalledTimes(1);
  });

  it("取得の失敗はそのまま投げ、キャッシュしない（次は取り直す）。exp のないトークン・空の aud は例外", async () => {
    let fail = true;
    const fetchIdToken = vi.fn(async () => {
      if (fail) throw new Error("metadata server unreachable");
      return tokenWithExp(NOW_SEC + 3600);
    });
    const source = createIdTokenSource({ fetchIdToken, clock: manualClock(NOW) });
    await expect(source.getIdToken(GATEWAY_URL)).rejects.toThrow("metadata server unreachable");
    fail = false;
    await expect(source.getIdToken(GATEWAY_URL)).resolves.toMatch(/^eyJ/);

    const noExp = createIdTokenSource({ fetchIdToken: async () => fakeJwt({ sub: "x" }), clock: manualClock(NOW) });
    await expect(noExp.getIdToken(GATEWAY_URL)).rejects.toThrow(/exp/);
    const garbage = createIdTokenSource({ fetchIdToken: async () => "not-a-jwt", clock: manualClock(NOW) });
    await expect(garbage.getIdToken(GATEWAY_URL)).rejects.toThrow();
    await expect(createIdTokenSource({ fetchIdToken, clock: manualClock(NOW) }).getIdToken(" / ")).rejects.toThrow(/aud/);
  });
});

describe("ほかのパッケージの形との互換（型）", () => {
  it("apps/sim-world の IdTokenVerifier（(authorization, { audience, allowedEmails }) => { email } | null）にそのまま渡せる", async () => {
    type SimIdTokenVerifier = (
      authorization: string | undefined,
      policy: { audience: string; allowedEmails: readonly string[] },
    ) => Promise<{ email: string } | null>;
    const v: SimIdTokenVerifier = verifyGoogleIdToken;
    expect(await v(undefined, { audience: APP_URL, allowedEmails: [SA_APP] })).toBeNull();
  });
});

describe("小さな関数", () => {
  it("normalizeAudience・bearerTokenOf・decodeJwtClaims", () => {
    expect(normalizeAudience(` ${GATEWAY_URL}// `)).toBe(GATEWAY_URL);
    expect(bearerTokenOf("Bearer abc")).toBe("abc");
    expect(bearerTokenOf("bearer   abc")).toBe("abc");
    expect(bearerTokenOf("Bearer a b")).toBeNull();
    expect(bearerTokenOf("Token abc")).toBeNull();
    expect(decodeJwtClaims(fakeJwt({ sub: "1" }))).toEqual({ sub: "1" });
    expect(decodeJwtClaims("x.y")).toBeNull();
  });
});
