import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical, sha256Hex } from "./canonical.ts";

describe("canonicalJson（KD §3.3-1。RFC 8785 / JCS 相当）", () => {
  it("J1：キーを並べ替える", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha256Hex(canonicalJson({ b: 1, a: 2 }))).toBe("d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772");
  });

  it("J2：入れ子・-0・小数（配列の順は保つ）", () => {
    const v = { z: [3, 1, { y: "x", a: null }], a: { d: 1.5, c: -0 } };
    expect(canonicalJson(v)).toBe('{"a":{"c":0,"d":1.5},"z":[3,1,{"a":null,"y":"x"}]}');
    expect(hashCanonical(v)).toBe("97545dfa7a6a7af162157a472366d5309d4676140ce5ce2ead6c8898c1c9d285");
  });

  it("J6：U+2028 は生の文字のまま・日本語もそのまま", () => {
    const v = { k: "コーヒー豆 20kg", e: " " };
    expect(canonicalJson(v)).toBe('{"e":" ","k":"コーヒー豆 20kg"}');
    expect(hashCanonical(v)).toBe("d7265725833f353835545c644705789f38883c9a27f180da69db609042d7ef0d");
  });

  it("J7：NaN・Infinity・配列の undefined・bigint は例外", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NEGATIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });

  it("J8：値が undefined のキーは除く", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("関数・Symbol・Date・Map などプレーンでないものは例外（日時は呼び出し側で ISO 8601 の文字列に）", () => {
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(Symbol("x"))).toThrow(TypeError);
    expect(() => canonicalJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalJson(new Map())).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it("null プロトタイプのオブジェクトは扱える", () => {
    const o = Object.assign(Object.create(null) as Record<string, number>, { b: 1, a: 2 });
    expect(canonicalJson(o)).toBe('{"a":2,"b":1}');
  });

  it("数値は ECMAScript の最短表記（1.0 → 1、指数表記）", () => {
    expect(canonicalJson(1.0)).toBe("1");
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson(0.000001)).toBe("0.000001");
    expect(canonicalJson(1e-7)).toBe("1e-7");
    expect(canonicalJson(-0)).toBe("0");
  });

  it("キーは UTF-16 のコード単位の順（大文字が小文字より先、サロゲートは BMP の後ろの方）", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, "é": 4, "😀": 5, "｡": 6 })).toBe(
      '{"B":2,"a":3,"b":1,"é":4,"😀":5,"｡":6}',
    );
  });

  it("文字列は JSON.stringify のエスケープ（制御文字・引用符）", () => {
    expect(canonicalJson('a"b\\c\n\u0001')).toBe('"a\\"b\\\\c\\n\\u0001"');
  });

  it("空白を入れない・空のオブジェクトと配列", () => {
    expect(canonicalJson({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
    expect(canonicalJson([null, true, false])).toBe("[null,true,false]");
  });

  it("性質：キーの順によらず同じ。JSON.parse で読み直しても同じ", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const s = canonicalJson(v);
        expect(canonicalJson(JSON.parse(s))).toBe(s);
        expect(canonicalJson(JSON.parse(JSON.stringify(v)))).toBe(s);
      }),
    );
  });

  it("性質：オブジェクトのキーを逆順に入れても同じ", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (o) => {
        const reversed = Object.fromEntries(Object.entries(o).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(o));
      }),
    );
  });
});

describe("sha256Hex・hashCanonical", () => {
  it("UTF-8 のバイト列の SHA-256（小文字16進64桁）", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("コーヒー")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("hashCanonical = sha256Hex(canonicalJson(v))", () => {
    expect(hashCanonical({ b: 1, a: 2 })).toBe(sha256Hex('{"a":2,"b":1}'));
  });
});
