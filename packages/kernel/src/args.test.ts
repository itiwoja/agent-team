import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ROLE_SUGGESTIONS,
  argPathsByRole,
  effectiveArgRoles,
  extractArg,
  normalizeForMatch,
  parseArgPath,
  readArgPath,
  suggestArgRoles,
  suggestClassification,
  validateArgRoleKeys,
  valuesEqualForMatch,
} from "./args.ts";
import { canonicalJson } from "./canonical.ts";
import type { ArgRole, Json } from "./types.ts";

describe("parseArgPath（KD §8-14：'name' と 'name[].field' の2形だけ）", () => {
  it("最上位と配列の要素の1段", () => {
    expect(parseArgPath("supplier_id")).toEqual({ kind: "scalar", name: "supplier_id" });
    expect(parseArgPath("items[].sku")).toEqual({ kind: "each", name: "items", field: "sku" });
  });

  it("ほかの形は null", () => {
    for (const p of ["", "a.b", "a[].b[].c", "a[]", "[].b", "a[].", "a[0].b", "a[].b.c", "a]"]) {
      expect(parseArgPath(p), p).toBeNull();
    }
  });
});

describe("readArgPath（KD §3.3-6）", () => {
  it("最上位：自分のプロパティだけを読む", () => {
    expect(readArgPath({ a: 1 }, "a")).toEqual({ shape: "scalar", found: true, value: 1 });
    expect(readArgPath({ a: null }, "a")).toEqual({ shape: "scalar", found: true, value: null });
    expect(readArgPath({}, "a")).toEqual({ shape: "scalar", found: false, value: undefined });
    // 継承した値（Object.prototype.constructor）を拾わない
    expect(readArgPath({}, "constructor")).toEqual({ shape: "scalar", found: false, value: undefined });
  });

  it("要素：配列なら要素ごと、配列でなければ containerFound: false", () => {
    expect(readArgPath({ items: [{ sku: "A" }, { qty: 1 }, "x"] }, "items[].sku")).toEqual({
      shape: "each",
      containerFound: true,
      elements: [
        { index: 0, found: true, value: "A" },
        { index: 1, found: false, value: undefined },
        { index: 2, found: false, value: undefined },
      ],
    });
    expect(readArgPath({ items: "x" }, "items[].sku")).toEqual({ shape: "each", containerFound: false, elements: [] });
    expect(readArgPath({}, "items[].sku")).toEqual({ shape: "each", containerFound: false, elements: [] });
    expect(readArgPath({ items: [] }, "items[].sku")).toEqual({ shape: "each", containerFound: true, elements: [] });
  });

  it("形の外れたパスは最上位のキーの名前そのものとして読む", () => {
    expect(readArgPath({ "a.b": 1, a: { b: 2 } }, "a.b")).toEqual({ shape: "scalar", found: true, value: 1 });
  });
});

describe("extractArg（MT §3.4。欠け≡null：M-10）", () => {
  it("NV-12：要素の値の配列", () => {
    expect(extractArg({ items: [{ sku: "A" }, { sku: "B" }] }, "items[].sku")).toEqual(["A", "B"]);
  });
  it("NV-13：容れ物が配列でなければ null", () => {
    expect(extractArg({ items: "x" }, "items[].sku")).toBeNull();
    expect(extractArg({}, "items[].sku")).toBeNull();
  });
  it("NV-14：欠けた要素は null", () => {
    expect(extractArg({ items: [{ sku: "A" }, {}] }, "items[].sku")).toEqual(["A", null]);
  });
  it("最上位の欠けは null", () => {
    expect(extractArg({}, "to")).toBeNull();
    expect(extractArg({ to: null }, "to")).toBeNull();
  });
});

describe("normalizeForMatch・valuesEqualForMatch（KD §3.3-7、MT §6.4 NV）", () => {
  it("NV-01：前後の空白を除く", () => {
    expect(valuesEqualForMatch(" SUP-0012 ", "SUP-0012")).toBe(true);
  });
  it("NV-02：配列は順序を無視", () => {
    expect(valuesEqualForMatch(["BEAN", "MILK"], ["MILK", "BEAN"])).toBe(true);
  });
  it("NV-03：要素の増減は不一致", () => {
    expect(valuesEqualForMatch(["BEAN"], ["BEAN", "MILK"])).toBe(false);
  });
  it("NV-04：重複も数える（多重集合。M-09）", () => {
    expect(valuesEqualForMatch(["BEAN", "BEAN"], ["BEAN"])).toBe(false);
    expect(valuesEqualForMatch(["BEAN", "MILK", "BEAN"], ["BEAN", "BEAN", "MILK"])).toBe(true);
  });
  it("NV-05・NV-06：型が違えば不一致（20 と '20'、true と 'true'）", () => {
    expect(valuesEqualForMatch(20, "20")).toBe(false);
    expect(valuesEqualForMatch(true, "true")).toBe(false);
  });
  it("NV-07：大文字小文字を区別", () => {
    expect(valuesEqualForMatch("D04ABC", "d04abc")).toBe(false);
  });
  it("NV-08：欠けた引数と null は一致（M-10）", () => {
    expect(valuesEqualForMatch(undefined, null)).toBe(true);
    expect(normalizeForMatch(undefined)).toBeNull();
  });
  it("NV-09・NV-10：'@me'・'*' はただの文字列（別名・glob なし）", () => {
    expect(valuesEqualForMatch("@me", "owner@example.com")).toBe(false);
    expect(valuesEqualForMatch("*", "anything")).toBe(false);
    expect(valuesEqualForMatch("SUP-*", "SUP-0012")).toBe(false);
  });
  it("NV-11：全角スペース・改行も trim で除く", () => {
    expect(valuesEqualForMatch("　SUP\n", "SUP")).toBe(true);
  });
  it("R21：Unicode の正規化はしない（U+00E9 と e＋U+0301 は別）", () => {
    expect(valuesEqualForMatch("café", "café")).toBe(false);
  });
  it("オブジェクトは値を再帰で正規化（キーの順は正規形で吸収）", () => {
    expect(normalizeForMatch({ b: [" y", "x"], a: " 1 " })).toEqual({ b: ["x", "y"], a: "1" });
    expect(valuesEqualForMatch({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  it("入れ子の配列も並べ替える", () => {
    expect(valuesEqualForMatch([["b", "a"], ["c"]], [["c"], ["a", "b"]])).toBe(true);
  });
  it("'__proto__' のキーも値として残る", () => {
    const v = JSON.parse('{"__proto__": "x"}') as Json;
    expect(canonicalJson(normalizeForMatch(v))).toBe('{"__proto__":"x"}');
  });
  it("数値・真偽値・null はそのまま", () => {
    expect(normalizeForMatch(20)).toBe(20);
    expect(normalizeForMatch(false)).toBe(false);
    expect(normalizeForMatch(null)).toBeNull();
  });

  const json = fc.jsonValue() as fc.Arbitrary<Json>;
  it("性質：正規化は冪等で、等しさは対称", () => {
    fc.assert(
      fc.property(json, json, (a, b) => {
        expect(normalizeForMatch(normalizeForMatch(a))).toEqual(normalizeForMatch(a));
        expect(valuesEqualForMatch(a, b)).toBe(valuesEqualForMatch(b, a));
        expect(valuesEqualForMatch(a, a)).toBe(true);
      }),
    );
  });
  it("性質：配列の並べ替えでは変わらず、要素を1つ足すと変わる（多重集合）", () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.string(), fc.integer())), fc.oneof(fc.string(), fc.integer()), (xs, extra) => {
        const shuffled = [...xs].reverse();
        expect(valuesEqualForMatch(xs, shuffled)).toBe(true);
        expect(valuesEqualForMatch(xs, [...xs, extra])).toBe(false);
      }),
    );
  });
});

describe("effectiveArgRoles（MT §3.3。未確定は destination：BR-56）", () => {
  const placeOrderSchema: Json = {
    type: "object",
    properties: {
      supplier_id: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { sku: { type: "string" }, quantity: { type: "integer" }, unit_price: { type: "number" } },
        },
      },
      note: { type: "string" },
    },
  };
  const placeOrderRoles = {
    supplier_id: "destination",
    "items[].sku": "option",
    "items[].quantity": "option",
    "items[].unit_price": "option",
    note: "content",
  } as const;

  it("AR-02：確定なしなら全部 destination", () => {
    expect(effectiveArgRoles(placeOrderSchema, {})).toEqual({ items: "destination", note: "destination", supplier_id: "destination" });
  });

  it("AR-03：オブジェクトの引数は最上位で destination（A-84）", () => {
    const schema: Json = {
      type: "object",
      properties: { message: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } } } },
    };
    expect(effectiveArgRoles(schema, {})).toEqual({ message: "destination" });
  });

  it("AR-04：manifest の place_order", () => {
    expect(effectiveArgRoles(placeOrderSchema, placeOrderRoles)).toEqual(placeOrderRoles);
  });

  it("AR-05：要素に役割のないフィールドがあると items 全体が destination", () => {
    const schema = structuredClone(placeOrderSchema) as { properties: { items: { items: { properties: Record<string, Json> } } } };
    schema.properties.items.items.properties.name = { type: "string" };
    expect(effectiveArgRoles(schema as unknown as Json, placeOrderRoles)).toEqual({
      supplier_id: "destination",
      items: "destination",
      note: "content",
    });
  });

  it("要素のフィールドのどれかが destination なら items 全体が destination", () => {
    expect(effectiveArgRoles(placeOrderSchema, { ...placeOrderRoles, "items[].sku": "destination" })).toEqual({
      supplier_id: "destination",
      items: "destination",
      note: "content",
    });
  });

  it("AR-10：スキーマの変更で増えた引数（cc）は destination", () => {
    const schema: Json = { type: "object", properties: { to: { type: "string" }, body: { type: "string" }, cc: { type: "string" } } };
    expect(effectiveArgRoles(schema, { to: "destination", body: "content" })).toEqual({
      to: "destination",
      body: "content",
      cc: "destination",
    });
  });

  it("'p' と 'p[].f' の両方が確定にあるときは厳しい側の destination", () => {
    expect(effectiveArgRoles(placeOrderSchema, { ...placeOrderRoles, items: "option" })).toMatchObject({ items: "destination" });
  });

  it("要素のフィールドの確定があっても、要素がオブジェクトの配列でなければ destination", () => {
    const schema: Json = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } };
    expect(effectiveArgRoles(schema, { "tags[].x": "option" })).toEqual({ tags: "destination" });
  });

  it("スキーマにない確定の役割は捨てる。不正な役割は destination", () => {
    const schema: Json = { type: "object", properties: { a: { type: "string" } } };
    expect(effectiveArgRoles(schema, { a: "bogus" as never, ghost: "option" })).toEqual({ a: "destination" });
  });

  it("スキーマがオブジェクトでない・properties がない → 空", () => {
    expect(effectiveArgRoles(null, { a: "option" })).toEqual({});
    expect(effectiveArgRoles({ type: "object" }, { a: "option" })).toEqual({});
  });
});

describe("suggestArgRoles・suggestClassification（MT §3.3。提案は確定するまで効かない：mcp-and-web.md:69）", () => {
  it("AR-01：suggestArgRoles({channel, text, unfurl_links, foo}) → {channel: destination, text: content, unfurl_links: option}（foo は提案なし）", () => {
    const schema: Json = {
      type: "object",
      properties: { channel: { type: "string" }, text: { type: "string" }, unfurl_links: { type: "boolean" }, foo: { type: "string" } },
    };
    expect(suggestArgRoles(schema)).toEqual({ channel: "destination", text: "content", unfurl_links: "option" });
  });
  it("ROLE_SUGGESTIONS の名前（mcp-and-web.md:63-65）を完全一致で。大文字小文字は区別する", () => {
    const names = [...ROLE_SUGGESTIONS.destination, ...ROLE_SUGGESTIONS.content, ...ROLE_SUGGESTIONS.option];
    const schema: Json = { type: "object", properties: Object.fromEntries([...names, "To", "BODY", " to"].map((n) => [n, { type: "string" }])) };
    const s = suggestArgRoles(schema);
    for (const n of ROLE_SUGGESTIONS.destination) expect(s[n]).toBe("destination");
    for (const n of ROLE_SUGGESTIONS.content) expect(s[n]).toBe("content");
    for (const n of ROLE_SUGGESTIONS.option) expect(s[n]).toBe("option");
    expect(Object.keys(s).sort()).toEqual([...names].sort());
  });
  it("最上位だけを見る（配列の要素の to は提案しない）。スキーマが読めなければ空", () => {
    const schema: Json = {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", properties: { to: { type: "string" } } } } },
    };
    expect(suggestArgRoles(schema)).toEqual({});
    expect(suggestArgRoles(null)).toEqual({});
    expect(suggestArgRoles({ type: "object", properties: ["to"] })).toEqual({});
  });
  it("継承したキー（constructor・toString・__proto__）は提案しない", () => {
    const schema = JSON.parse('{"type":"object","properties":{"constructor":{},"toString":{},"__proto__":{},"to":{}}}') as Json;
    expect(suggestArgRoles(schema)).toEqual({ to: "destination" });
  });
  it("CL-01：annotations.readOnlyHint === true のときだけ read を提案（分類は unclassified のまま：ADR-022:10）", () => {
    expect(suggestClassification({ readOnlyHint: true })).toBe("read");
    expect(suggestClassification({ readOnlyHint: "true" })).toBeNull();
    expect(suggestClassification({ readOnlyHint: false, destructiveHint: false })).toBeNull();
    expect(suggestClassification({ destructiveHint: false })).toBeNull();
    expect(suggestClassification(null)).toBeNull();
    expect(suggestClassification([true])).toBeNull();
  });
});

describe("validateArgRoleKeys（MT §3.3。API-071 と manifest の検査）", () => {
  const schema: Json = {
    type: "object",
    properties: {
      supplier_id: { type: "string" },
      items: {
        type: "array",
        items: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer" } } },
      },
      note: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
    },
  };
  it("最上位と、要素がオブジェクトの配列のフィールドは通る（AR-04 の形）", () => {
    expect(validateArgRoleKeys(schema, { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", note: "content" })).toEqual({
      ok: true,
    });
    expect(validateArgRoleKeys(schema, {})).toEqual({ ok: true });
  });
  it("AR-06：存在しないキー foo → unknown_property", () => {
    expect(validateArgRoleKeys(schema, { foo: "option" })).toEqual({ ok: false, errors: [{ path: "foo", reason: "unknown_property" }] });
  });
  it("AR-07：items と items[].sku の両方 → both_whole_and_element", () => {
    expect(validateArgRoleKeys(schema, { items: "option", "items[].sku": "option" })).toEqual({
      ok: false,
      errors: [{ path: "items", reason: "both_whole_and_element" }],
    });
  });
  it("AR-08：note[].x（note は配列でない）・tags[].x（要素がオブジェクトでない）→ not_array_of_objects", () => {
    expect(validateArgRoleKeys(schema, { "note[].x": "option", "tags[].x": "option" })).toEqual({
      ok: false,
      errors: [
        { path: "note[].x", reason: "not_array_of_objects" },
        { path: "tags[].x", reason: "not_array_of_objects" },
      ],
    });
  });
  it("要素にないフィールド・スキーマにない容れ物・形の外れたパス（KD §8-14）は unknown_property", () => {
    expect(validateArgRoleKeys(schema, { "items[].price": "option", "ghost[].x": "option", "a.b": "option", "items[].sku[].x": "option", "": "option" })).toEqual({
      ok: false,
      errors: [
        { path: "", reason: "unknown_property" },
        { path: "a.b", reason: "unknown_property" },
        { path: "ghost[].x", reason: "unknown_property" },
        { path: "items[].price", reason: "unknown_property" },
        { path: "items[].sku[].x", reason: "unknown_property" },
      ],
    });
  });
  it("役割が destination・content・option でない → bad_role（パスの誤りと両方あれば両方返す）", () => {
    expect(validateArgRoleKeys(schema, { note: "body" as never, foo: "x" as never })).toEqual({
      ok: false,
      errors: [
        { path: "foo", reason: "unknown_property" },
        { path: "foo", reason: "bad_role" },
        { path: "note", reason: "bad_role" },
      ],
    });
  });
  it("継承したキー（constructor）は最上位のプロパティとして扱わない", () => {
    const roles = JSON.parse('{"constructor":"option"}') as Record<string, ArgRole>;
    expect(validateArgRoleKeys(schema, roles)).toEqual({ ok: false, errors: [{ path: "constructor", reason: "unknown_property" }] });
  });
  it("性質：通った確定の役割は effectiveArgRoles でそのまま効く（要素に destination がなく、全フィールドを確定したとき）", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ArgRole>("destination", "content", "option"),
        fc.constantFrom<ArgRole>("content", "option"),
        fc.constantFrom<ArgRole>("content", "option"),
        (sid, sku, qty) => {
          const roles = { supplier_id: sid, "items[].sku": sku, "items[].quantity": qty, note: "content", tags: "option" } as const;
          expect(validateArgRoleKeys(schema, roles)).toEqual({ ok: true });
          expect(effectiveArgRoles(schema, roles)).toEqual(roles);
        },
      ),
    );
  });
});

describe("argPathsByRole", () => {
  it("役割ごとのパスを辞書順で", () => {
    const roles = { b: "option", a: "option", "items[].sku": "option", to: "destination", body: "content" } as const;
    expect(argPathsByRole(roles, "option")).toEqual(["a", "b", "items[].sku"]);
    expect(argPathsByRole(roles, "destination")).toEqual(["to"]);
    expect(argPathsByRole(roles, "content")).toEqual(["body"]);
  });
});
