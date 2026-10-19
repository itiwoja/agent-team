import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateGuard, firstGuardViolation, mergeGuards } from "./guards.ts";
import type { Guard, JsonObject, MergedGuard } from "./types.ts";

const PO = "mcp.supplier.place_order";
const g = (arg: string, c: Omit<Guard, "action" | "arg">, action = PO): Guard => ({ action, arg, ...c });
const merged1 = (guards: Guard[]): MergedGuard => {
  const out = mergeGuards(guards);
  expect(out).toHaveLength(1);
  return out[0]!;
};

describe("mergeGuards（KC §3.5・§6.4）", () => {
  it("G-01：1つならそのまま（empty: false）", () => {
    expect(merged1([g("qty", { max: 20 })])).toEqual({ action: PO, arg: "qty", max: 20, empty: false });
  });
  it("G-02・K-25：max は小さい方", () => {
    expect(merged1([g("qty", { max: 20 }), g("qty", { max: 10 })])).toMatchObject({ max: 10, empty: false });
    expect(merged1([g("qty", { max: 20 }), g("qty", { max: 50 })])).toMatchObject({ max: 20 });
  });
  it("G-03：min は大きい方", () => {
    expect(merged1([g("qty", { min: 1 }), g("qty", { min: 5 })])).toMatchObject({ min: 5 });
  });
  it("G-04：min === max は空でない", () => {
    expect(merged1([g("qty", { min: 5 }), g("qty", { max: 5 })])).toEqual({ action: PO, arg: "qty", min: 5, max: 5, empty: false });
  });
  it("G-05：min > max は空", () => {
    expect(merged1([g("qty", { min: 6 }), g("qty", { max: 5 })]).empty).toBe(true);
  });
  it("G-06：in は積集合", () => {
    expect(merged1([g("sku", { in: ["A", "B"] }), g("sku", { in: ["B", "C"] })])).toEqual({
      action: PO,
      arg: "sku",
      in: ["B"],
      empty: false,
    });
  });
  it("G-07・K-26：in の積が空なら空", () => {
    expect(merged1([g("sku", { in: ["A"] }), g("sku", { in: ["B"] })])).toEqual({ action: PO, arg: "sku", in: [], empty: true });
  });
  it("G-08：数値の条件と in が重なると空", () => {
    expect(merged1([g("x", { max: 5 }), g("x", { in: ["a"] })]).empty).toBe(true);
  });
  it("G-09：max_digits は小さい方", () => {
    expect(merged1([g("x", { max_digits: 4 }), g("x", { max_digits: 3 })])).toMatchObject({ max_digits: 3, empty: false });
  });
  it("G-10：別の action の同名の arg は別々", () => {
    const out = mergeGuards([g("qty", { max: 20 }), g("qty", { max: 10 }, "mcp.other.tool")]);
    expect(out).toHaveLength(2);
  });
  it("G-11：入力の順を変えても出力は同じ（action・arg の昇順）", () => {
    const list = [g("b", { max: 1 }), g("a", { max: 2 }), g("a", { min: 0 }, "mcp.a.b"), g("b", { in: ["x"] }, "mcp.a.b")];
    const out = mergeGuards(list);
    expect(out.map((m) => `${m.action}|${m.arg}`)).toEqual(["mcp.a.b|a", "mcp.a.b|b", `${PO}|a`, `${PO}|b`]);
    expect(mergeGuards([...list].reverse())).toEqual(out);
  });
  it("G-12：in は trim・重複なし・昇順", () => {
    expect(merged1([g("sku", { in: [" A ", "A", "C", "B"] })])).toMatchObject({ in: ["A", "B", "C"] });
  });
  it("条件が1つもない・有限でない境界・文字列でない候補のガードは空（壊れたガードは厳しい側：KD §8-20）", () => {
    expect(merged1([g("x", {})]).empty).toBe(true);
    expect(merged1([g("x", { max: Number.NaN })]).empty).toBe(true);
    expect(merged1([g("x", { in: [1 as unknown as string] })]).empty).toBe(true);
    expect(merged1([g("x", { max: 20 }), g("x", {})]).empty).toBe(true);
  });
  it("性質：入力の並べ替えで変わらない", () => {
    const arb = fc.array(
      fc.record({
        arg: fc.constantFrom("a", "b", "items[].q"),
        min: fc.option(fc.integer({ min: -5, max: 30 }), { nil: undefined }),
        max: fc.option(fc.integer({ min: -5, max: 30 }), { nil: undefined }),
        in: fc.option(fc.subarray(["x", "y", " z"]), { nil: undefined }),
      }),
      { maxLength: 6 },
    );
    fc.assert(
      fc.property(arb, (raw) => {
        const list = raw.map((r) => {
          const out: Guard = { action: PO, arg: r.arg };
          if (r.min !== undefined) out.min = r.min;
          if (r.max !== undefined) out.max = r.max;
          if (r.in !== undefined) out.in = r.in;
          return out;
        });
        expect(mergeGuards([...list].reverse())).toEqual(mergeGuards(list));
      }),
    );
  });
  it("性質：合成したガードを通る値は、元のどのガードも通る（積）。元が全部通れば合成も通る", () => {
    const arbGuard = fc.oneof(
      fc.record({ min: fc.integer({ min: -10, max: 30 }) }),
      fc.record({ max: fc.integer({ min: -10, max: 30 }) }),
      fc.record({ max_digits: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ min: fc.integer({ min: -10, max: 30 }), max: fc.integer({ min: -10, max: 30 }) }),
      fc.record({ in: fc.subarray(["a", "b", "c", " a"]) }),
    );
    const arbValue = fc.oneof(fc.integer({ min: -20, max: 2000 }), fc.constantFrom("a", "b", "c", " b ", "d"));
    fc.assert(
      fc.property(fc.array(arbGuard, { minLength: 1, maxLength: 4 }), arbValue, (cs, v) => {
        const list = cs.map((c) => g("x", c));
        const args = { x: v };
        const allOk = list.every((one) => evaluateGuard(one, args).ok);
        expect(evaluateGuard(merged1(list), args).ok).toBe(allOk);
      }),
    );
  });
});

describe("evaluateGuard（KC §3.6・§6.5）", () => {
  const Q: MergedGuard = { action: PO, arg: "items[].quantity", max: 20, empty: false };
  const ev = (guard: Guard & { empty?: boolean }, args: JsonObject) => evaluateGuard(guard, args);

  it("E-01：上限ちょうどは通る", () => {
    expect(ev(Q, { items: [{ quantity: 20 }] })).toEqual({ ok: true });
  });
  it("E-02：上限を超えると above_max（添字つきのパス）", () => {
    expect(ev(Q, { items: [{ quantity: 21 }] })).toEqual({ ok: false, reason: "above_max", path: "items[0].quantity", value: 21, found: true });
  });
  it("E-03：1要素でも外れれば外れ", () => {
    expect(ev(Q, { items: [{ quantity: 5 }, { quantity: 200 }] })).toMatchObject({ ok: false, reason: "above_max", path: "items[1].quantity", value: 200 });
  });
  it("E-04：空配列は not_found", () => {
    expect(ev(Q, { items: [] })).toEqual({ ok: false, reason: "not_found", path: "items[].quantity", value: null, found: false });
  });
  it("E-05：items がない → not_found", () => {
    expect(ev(Q, {})).toMatchObject({ ok: false, reason: "not_found", found: false });
  });
  it("E-06：要素にフィールドがない → not_found（添字つき）", () => {
    expect(ev(Q, { items: [{ sku: "A" }] })).toEqual({ ok: false, reason: "not_found", path: "items[0].quantity", value: null, found: false });
  });
  it("E-07：数字の文字列は type", () => {
    expect(ev(Q, { items: [{ quantity: "20" }] })).toMatchObject({ ok: false, reason: "type", value: "20" });
  });
  it("E-08：配列でない → not_found", () => {
    expect(ev(Q, { items: { quantity: 1 } })).toMatchObject({ ok: false, reason: "not_found" });
  });
  it("E-09：単価 800 / 801 / 2400", () => {
    const P: MergedGuard = { action: PO, arg: "items[].unit_price", max: 800, empty: false };
    expect(ev(P, { items: [{ unit_price: 800 }] }).ok).toBe(true);
    expect(ev(P, { items: [{ unit_price: 801 }] })).toMatchObject({ reason: "above_max" });
    expect(ev(P, { items: [{ unit_price: 2400 }] })).toMatchObject({ reason: "above_max" });
  });
  it("E-10・K-22：min 1 に 0 / 1", () => {
    const G: MergedGuard = { action: PO, arg: "qty", min: 1, empty: false };
    expect(ev(G, { qty: 0 })).toMatchObject({ ok: false, reason: "below_min", path: "qty", value: 0 });
    expect(ev(G, { qty: 1 }).ok).toBe(true);
  });
  it("E-11・K-23：max_digits 3 に 999 / 1000 / 0.5 / -999 / 999.99", () => {
    const G: MergedGuard = { action: PO, arg: "price", max_digits: 3, empty: false };
    expect(ev(G, { price: 999 }).ok).toBe(true);
    expect(ev(G, { price: 1000 })).toMatchObject({ reason: "too_many_digits" });
    expect(ev(G, { price: 0.5 }).ok).toBe(true);
    expect(ev(G, { price: -999 }).ok).toBe(true);
    expect(ev(G, { price: 999.99 }).ok).toBe(true);
    expect(ev(G, { price: 1e21 })).toMatchObject({ reason: "too_many_digits" });
  });
  it("E-12・K-20：in の候補（F-12 の 1eft-pad は外れ）", () => {
    const G: MergedGuard = { action: "mcp.repo.create_pull_request", arg: "packages[].name", in: ["left-pad", "lodash"], empty: false };
    expect(ev(G, { packages: [{ name: "left-pad" }] }).ok).toBe(true);
    expect(ev(G, { packages: [{ name: "1eft-pad" }] })).toMatchObject({ ok: false, reason: "not_in", path: "packages[0].name" });
  });
  it("E-13・K-21：前後の空白を除いて比べる", () => {
    const G: MergedGuard = { action: PO, arg: "packages[].name", in: ["left-pad", "lodash"], empty: false };
    expect(ev(G, { packages: [{ name: " left-pad " }] }).ok).toBe(true);
    expect(ev(G, { packages: [{ name: " lodash " }] }).ok).toBe(true);
  });
  it("E-14：大文字小文字を区別", () => {
    const G: MergedGuard = { action: PO, arg: "packages[].name", in: ["left-pad"], empty: false };
    expect(ev(G, { packages: [{ name: "Left-pad" }] })).toMatchObject({ reason: "not_in" });
  });
  it("E-15：empty のガードは何でも empty", () => {
    const G: MergedGuard = { action: PO, arg: "qty", min: 30, max: 20, empty: true };
    for (const qty of [0, 20, 25, 30, 100]) expect(ev(G, { qty })).toMatchObject({ ok: false, reason: "empty", path: "qty", value: qty, found: true });
    expect(ev(G, {})).toMatchObject({ ok: false, reason: "empty", found: false });
  });
  it("E-16：NaN・Infinity は type", () => {
    const G: MergedGuard = { action: PO, arg: "qty", max: 20, empty: false };
    expect(ev(G, { qty: Number.NaN })).toMatchObject({ reason: "type" });
    expect(ev(G, { qty: Number.POSITIVE_INFINITY })).toMatchObject({ reason: "type" });
  });
  it("E-17：null は値ありとして type", () => {
    const G: MergedGuard = { action: PO, arg: "qty", max: 20, empty: false };
    expect(ev(G, { qty: null })).toEqual({ ok: false, reason: "type", path: "qty", value: null, found: true });
  });
  it("in のガードに数値は type", () => {
    const G: MergedGuard = { action: PO, arg: "x", in: ["1"], empty: false };
    expect(ev(G, { x: 1 })).toMatchObject({ reason: "type" });
  });
  it("最上位の引数が配列なら値全体を1つとして見る（数値のガードには type）", () => {
    const G: MergedGuard = { action: PO, arg: "qty", max: 20, empty: false };
    expect(ev(G, { qty: [1, 2] })).toMatchObject({ ok: false, reason: "type", path: "qty" });
  });
  it("合成していないガード（empty なし）でも条件がなければ外れ", () => {
    expect(ev({ action: PO, arg: "qty" }, { qty: 1 })).toMatchObject({ ok: false, reason: "empty" });
  });
  it("要素は添字の小さい順に最初の外れ（欠けと超過の混在）", () => {
    expect(ev(Q, { items: [{ quantity: 200 }, { sku: "A" }] })).toMatchObject({ reason: "above_max", path: "items[0].quantity" });
    expect(ev(Q, { items: [{ sku: "A" }, { quantity: 200 }] })).toMatchObject({ reason: "not_found", path: "items[0].quantity" });
    expect(ev(Q, { items: [{ quantity: 1 }, "x"] })).toMatchObject({ reason: "not_found", path: "items[1].quantity" });
  });
});

describe("firstGuardViolation（KD §3.3-8）", () => {
  const G0: MergedGuard = { action: PO, arg: "items[].quantity", max: 20, empty: false };
  const G1: MergedGuard = { action: PO, arg: "items[].unit_price", max: 800, empty: false };
  const GM: MergedGuard = { action: "mcp.mail.send", arg: "to", in: ["owner@example.com"], empty: false };
  const item = (quantity: number, unit_price: number) => ({ sku: "BEAN-HOUSE", quantity, unit_price });

  it("違反がなければ null", () => {
    expect(firstGuardViolation([G0, G1], PO, { items: [item(20, 800)] })).toBeNull();
  });
  it("G2：数量 21 → guards[0]、添字つきのパスと値", () => {
    expect(firstGuardViolation([G0, G1], PO, { items: [item(21, 800)] })).toEqual({ index: 0, argPath: "items[0].quantity", value: 21, found: true });
  });
  it("G3：2件目だけ 200 → items[1].quantity", () => {
    expect(firstGuardViolation([G0, G1], PO, { items: [item(5, 800), item(200, 800)] })).toMatchObject({ index: 0, argPath: "items[1].quantity" });
  });
  it("G7・G8・K-27：単価だけなら guards[1]、両方外れなら添字の小さい方", () => {
    expect(firstGuardViolation([G0, G1], PO, { items: [item(5, 2400)] })).toMatchObject({ index: 1, argPath: "items[0].unit_price", value: 2400 });
    expect(firstGuardViolation([G0, G1], PO, { items: [item(200, 2400)] })).toMatchObject({ index: 0 });
  });
  it("G14・K-24：別の action のガードは効かない（添字は policy.guards のまま）", () => {
    expect(firstGuardViolation([GM], PO, { items: [item(999, 9999)] })).toBeNull();
    expect(firstGuardViolation([GM, G1], PO, { items: [item(5, 801)] })).toMatchObject({ index: 1 });
  });
  it("G11：packages[].name の in", () => {
    const G: MergedGuard = { action: "mcp.repo.create_pull_request", arg: "packages[].name", in: ["left-pad", "lodash"], empty: false };
    const a = "mcp.repo.create_pull_request";
    expect(firstGuardViolation([G], a, { packages: [{ name: "left-pad" }] })).toBeNull();
    expect(firstGuardViolation([G], a, { packages: [{ name: "1eft-pad" }] })).toMatchObject({ argPath: "packages[0].name" });
    expect(firstGuardViolation([G], a, { packages: [{ name: "left-pad" }, { name: "1eft-pad" }] })).toMatchObject({ argPath: "packages[1].name" });
  });
  it("性質：要素の並べ替えでは、外れるかどうかと外れたガードの添字は変わらない（多重集合）", () => {
    const arbItem = fc.record({ sku: fc.constant("A"), quantity: fc.integer({ min: 0, max: 40 }), unit_price: fc.integer({ min: 0, max: 1200 }) });
    fc.assert(
      fc.property(fc.array(arbItem, { maxLength: 5 }), (items) => {
        const a = firstGuardViolation([G0, G1], PO, { items });
        const b = firstGuardViolation([G0, G1], PO, { items: [...items].reverse() });
        expect(b === null).toBe(a === null);
        expect(b?.index).toBe(a?.index);
      }),
    );
  });
});
