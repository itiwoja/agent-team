import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findMatchingRule, RULE_INVALID_REASONS, ruleValidity } from "./rules.ts";
import type { EffectiveRule, JsonObject, ToolHash, ToolInfo } from "./types.ts";

const PO = "mcp.supplier.place_order";
const H: ToolHash = `sha256:${"a".repeat(64)}`;
const T_PO: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: H,
  argRoles: {
    supplier_id: "destination",
    "items[].sku": "option",
    "items[].quantity": "option",
    "items[].unit_price": "option",
    note: "content",
  },
};
// KC §6.6・IA RL・MT RU の前提のルール
const R: EffectiveRule = {
  id: "r-91c2",
  action: PO,
  tool_hash: H,
  match: { supplier_id: "SUP-0012", "items[].sku": ["BEAN-HOUSE", "MILK-1L"] },
  free: ["items[].quantity", "items[].unit_price"],
};
const item = (sku: string, quantity = 12, unit_price = 780) => ({ sku, quantity, unit_price });
const args = (over: JsonObject = {}): JsonObject => ({
  supplier_id: "SUP-0012",
  items: [item("BEAN-HOUSE"), item("MILK-1L")],
  note: "いつもの",
  ...over,
});
const find = (rules: EffectiveRule[], a: JsonObject, tool: ToolInfo = T_PO, enabled = true) => findMatchingRule(rules, PO, a, tool, enabled);
const validity = (rule: EffectiveRule, tool: ToolInfo = T_PO, rulesEnabled = true, action = PO) => ruleValidity(rule, { action, tool, rulesEnabled });

describe("RULE_INVALID_REASONS（MT §2.6、M-60）", () => {
  it("MT の列挙のとおり", () => {
    expect(RULE_INVALID_REASONS).toEqual([
      "rules_disabled",
      "not_write",
      "tool_changed",
      "no_destination",
      "not_covering",
      "free_not_option",
      "match_bad_key",
    ]);
  });
});

describe("ruleValidity（MT §3.6。上から順に最初に当たった理由）", () => {
  it("有効", () => {
    expect(validity(R)).toEqual({ valid: true });
  });
  it("action が違えば not_applicable", () => {
    expect(validity(R, T_PO, true, "mcp.mail.send")).toBe("not_applicable");
  });
  it("RU-08：rules.enabled = false → rules_disabled", () => {
    expect(validity(R, T_PO, false)).toEqual({ valid: false, reason: "rules_disabled" });
  });
  it("RU-19：unclassified → not_write（read も）", () => {
    expect(validity(R, { ...T_PO, classification: "unclassified" })).toEqual({ valid: false, reason: "not_write" });
    expect(validity(R, { ...T_PO, classification: "read" })).toEqual({ valid: false, reason: "not_write" });
  });
  it("RU-04・RL-5：tool_hash が古い → tool_changed", () => {
    expect(validity({ ...R, tool_hash: `sha256:${"b".repeat(64)}` })).toEqual({ valid: false, reason: "tool_changed" });
  });
  it("destination がなく scope が self でない → no_destination（scope: self なら有効）", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { title: "content" } };
    const rule: EffectiveRule = { ...R, match: {}, free: [] };
    expect(validity(rule, tool)).toEqual({ valid: false, reason: "no_destination" });
    expect(validity(rule, { ...tool, scope: "self" })).toEqual({ valid: true });
  });
  it("RU-05・R4：match に supplier_id がない → not_covering", () => {
    expect(validity({ ...R, match: { "items[].sku": ["BEAN-HOUSE"] } })).toEqual({ valid: false, reason: "not_covering" });
  });
  it("RL-4・AR-10：ツールの destination が増えた（cc）→ not_covering", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, cc: "destination" } };
    expect(validity(R, tool)).toEqual({ valid: false, reason: "not_covering" });
  });
  it("RL-9：後からツールに destination が増えた（スキーマの変更）→ tool_hash が変わり無効（tool_changed が先）", () => {
    const tool: ToolInfo = { ...T_PO, toolHash: `sha256:${"b".repeat(64)}`, argRoles: { ...T_PO.argRoles, ship_to: "destination" } };
    expect(validity(R, tool)).toEqual({ valid: false, reason: "tool_changed" });
    expect(find([R], args({ ship_to: "x" }), tool)).toEqual({ matched: false, firstMismatch: null });
  });
  it("RU-06・RL-6・R5：free に supplier_id → free_not_option（IA の free_has_destination は M-60 で MT の名前）", () => {
    expect(validity({ ...R, free: [...R.free, "supplier_id"] })).toEqual({ valid: false, reason: "free_not_option" });
    expect(validity({ ...R, free: ["note"] })).toEqual({ valid: false, reason: "free_not_option" });
    expect(validity({ ...R, free: ["ghost"] })).toEqual({ valid: false, reason: "free_not_option" });
  });
  it("RU-07：match に content・存在しないキー・free と重なるキー → match_bad_key", () => {
    expect(validity({ ...R, match: { ...R.match, note: "x" } })).toEqual({ valid: false, reason: "match_bad_key" });
    expect(validity({ ...R, match: { ...R.match, ghost: 1 } })).toEqual({ valid: false, reason: "match_bad_key" });
    expect(validity({ ...R, match: { ...R.match, "items[].quantity": [12] } })).toEqual({ valid: false, reason: "match_bad_key" });
  });
  it("free が欠けていても [] として読む（M-03）", () => {
    const rule = { ...R, match: { ...R.match, "items[].quantity": [12, 12], "items[].unit_price": [780, 780] } } as EffectiveRule;
    delete (rule as { free?: unknown }).free;
    expect(validity(rule)).toEqual({ valid: true });
  });
});

describe("findMatchingRule（KD §3.3-9、KC §6.6、IA §6.3、MT §6.6）", () => {
  it("RU-01・RL-1・R-01・R-05：sku が逆順・数量が違っても一致（free は比べない）", () => {
    expect(find([R], args({ items: [item("MILK-1L", 30, 100), item("BEAN-HOUSE", 1, 9999)] }))).toEqual({ matched: true, index: 0 });
  });
  it("RU-02・R-02：宛先が違えば不一致。firstMismatch は destination", () => {
    expect(find([R], args({ supplier_id: "SUP-9999" }))).toEqual({
      matched: false,
      firstMismatch: { ruleIndex: 0, argPath: "supplier_id", role: "destination" },
    });
  });
  it("R-03：前後の空白は正規化で一致", () => {
    expect(find([R], args({ supplier_id: " SUP-0012 " })).matched).toBe(true);
  });
  it("RU-03・RL-2・R-04：sku が1つ多い → 不一致（option）", () => {
    expect(find([R], args({ items: [item("BEAN-HOUSE"), item("MILK-1L"), item("SUGAR")] }))).toEqual({
      matched: false,
      firstMismatch: { ruleIndex: 0, argPath: "items[].sku", role: "option" },
    });
  });
  it("R11（M-09）：同じ sku を2行に分けた発注は一致しない（多重集合）", () => {
    const one: EffectiveRule = { ...R, match: { supplier_id: "SUP-0012", "items[].sku": ["BEAN-HOUSE"] } };
    expect(find([one], args({ items: [item("BEAN-HOUSE", 10)] })).matched).toBe(true);
    expect(find([one], args({ items: [item("BEAN-HOUSE", 10), item("BEAN-HOUSE", 10)] })).matched).toBe(false);
  });
  it("RL-3：単価が3倍でも一致（free。ガードがなければ F-05 のすり抜け）", () => {
    expect(find([R], args({ items: [item("BEAN-HOUSE", 12, 2340), item("MILK-1L")] })).matched).toBe(true);
  });
  it("R-06：quantity を固定したルールは数量が違えば不一致", () => {
    const fixed: EffectiveRule = {
      ...R,
      match: { ...R.match, "items[].quantity": [12, 12], "items[].unit_price": [780, 780] },
      free: [],
    };
    expect(find([fixed], args()).matched).toBe(true);
    expect(find([fixed], args({ items: [item("BEAN-HOUSE", 30), item("MILK-1L")] }))).toEqual({
      matched: false,
      firstMismatch: { ruleIndex: 0, argPath: "items[].quantity", role: "option" },
    });
  });
  it("R-07〜R-09：無効なルール（網羅・free・tool_hash）は一致しない。firstMismatch も null", () => {
    expect(find([{ ...R, match: { "items[].sku": R.match["items[].sku"]! } }], args())).toEqual({ matched: false, firstMismatch: null });
    expect(find([{ ...R, free: [...R.free, "supplier_id"] }], args())).toEqual({ matched: false, firstMismatch: null });
    expect(find([{ ...R, tool_hash: `sha256:${"0".repeat(64)}` }], args())).toEqual({ matched: false, firstMismatch: null });
  });
  it("R-10：役割のない新しい引数 ship_to（destination）が増えたら無効", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, ship_to: "destination" } };
    expect(find([R], args(), tool).matched).toBe(false);
  });
  it("R-11・R-12・R15（M-11・BR-69）：match にも free にもない option は「無いこと」を求める", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, rush: "option" } };
    expect(find([R], args({ rush: true }), tool)).toEqual({ matched: false, firstMismatch: { ruleIndex: 0, argPath: "rush", role: "option" } });
    expect(find([R], args(), tool).matched).toBe(true);
    expect(find([R], args({ rush: null }), tool).matched).toBe(true); // 欠け≡null（M-10）
  });
  it("RU-13：send_at を null で固定したルールに send_at を指定 → 不一致", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, send_at: "option" } };
    const rule: EffectiveRule = { ...R, match: { ...R.match, send_at: null } };
    expect(find([rule], args(), tool).matched).toBe(true);
    expect(find([rule], args({ send_at: "2026-10-10T09:00:00+09:00" }), tool).matched).toBe(false);
  });
  it("R-13・R13：content（note）は比べない", () => {
    expect(find([R], args({ note: "至急！全部買って" })).matched).toBe(true);
    expect(find([R], args({ note: undefined as never })).matched).toBe(true);
  });
  it("R14・AR-13（M-12）：argRoles にない引数があれば不一致（role: unknown）", () => {
    expect(find([R], args({ priority: "high" }))).toEqual({ matched: false, firstMismatch: { ruleIndex: 0, argPath: "priority", role: "unknown" } });
  });
  it("要素に argRoles にないフィールドがあれば不一致", () => {
    expect(find([R], args({ items: [{ ...item("BEAN-HOUSE"), discount: 1 }, item("MILK-1L")] }))).toEqual({
      matched: false,
      firstMismatch: { ruleIndex: 0, argPath: "items[].discount", role: "unknown" },
    });
  });
  it("容れ物が配列でない・要素がオブジェクトでない → 不一致", () => {
    const allFree: EffectiveRule = { ...R, match: { supplier_id: "SUP-0012" }, free: ["items[].sku", "items[].quantity", "items[].unit_price"] };
    expect(find([allFree], args()).matched).toBe(true);
    expect(find([allFree], args({ items: "BEAN" })).matched).toBe(false);
    expect(find([allFree], args({ items: ["BEAN"] })).matched).toBe(false);
  });
  it("形の外れたキー名（'a.b'・'items[].sku' そのもの）は余計な引数", () => {
    expect(find([R], args({ "items[].sku": ["BEAN-HOUSE"] })).matched).toBe(false);
    expect(find([R], args({ "a.b": 1 })).matched).toBe(false);
  });
  it("RU-20：欠けた optional の destination（cc）は null で固定。後で cc を付けると不一致", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { to: "destination", cc: "destination", body: "content" } };
    const rule: EffectiveRule = { id: "r-m", action: "mcp.mail.send", tool_hash: H, match: { to: "a@example.com", cc: null }, free: [] };
    const f = (a: JsonObject) => findMatchingRule([rule], "mcp.mail.send", a, tool, true);
    expect(f({ to: "a@example.com", body: "x" }).matched).toBe(true);
    expect(f({ to: "a@example.com", cc: "evil@example.com", body: "x" })).toEqual({
      matched: false,
      firstMismatch: { ruleIndex: 0, argPath: "cc", role: "destination" },
    });
  });
  it("R18・R19：宛先を固定したルールに違う宛先（F-09・F-03）→ 不一致", () => {
    const ms: ToolInfo = { ...T_PO, argRoles: { to: "destination", body: "content" } };
    const rm: EffectiveRule = { id: "r-m", action: "mcp.mail.send", tool_hash: H, match: { to: "owner@example.com" }, free: [] };
    expect(findMatchingRule([rm], "mcp.mail.send", { to: "xxx@example.com", body: "x" }, ms, true).matched).toBe(false);
    const bp: ToolInfo = { ...T_PO, argRoles: { account: "destination" } };
    const rb: EffectiveRule = { id: "r-b", action: "mcp.bank.register_payee", tool_hash: H, match: { account: "ACC-LEGIT" }, free: [] };
    expect(findMatchingRule([rb], "mcp.bank.register_payee", { account: "ACC-ATTACKER" }, bp, true).matched).toBe(false);
    expect(findMatchingRule([rb], "mcp.bank.register_payee", { account: "ACC-LEGIT" }, bp, true).matched).toBe(true);
  });
  it("R20・R21・RL-7・RL-8：型違い・Unicode・glob・別名は一致しない", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, rush: "option" } };
    const num: EffectiveRule = { ...R, match: { ...R.match, rush: 1 } };
    expect(find([num], args({ rush: "1" }), tool).matched).toBe(false);
    expect(find([num], args({ rush: 1 }), tool).matched).toBe(true);
    expect(find([{ ...R, match: { ...R.match, supplier_id: "café" } }], args({ supplier_id: "café" })).matched).toBe(false);
    expect(find([{ ...R, match: { ...R.match, supplier_id: "SUP-*" } }], args()).matched).toBe(false);
    expect(find([{ ...R, match: { ...R.match, supplier_id: "@me" } }], args()).matched).toBe(false);
  });
  it("R16：最初の有効なルールで一致したものの添字", () => {
    const stale: EffectiveRule = { ...R, id: "r-old", tool_hash: `sha256:${"9".repeat(64)}` };
    expect(find([stale, R], args())).toEqual({ matched: true, index: 1 });
  });
  it("firstMismatch は同じ action の最初の有効なルールのもの（別の action・無効なルールは飛ばす）", () => {
    const other: EffectiveRule = { ...R, id: "r-mail", action: "mcp.mail.send" };
    const stale: EffectiveRule = { ...R, id: "r-old", tool_hash: `sha256:${"9".repeat(64)}` };
    const second: EffectiveRule = { ...R, id: "r-2", match: { ...R.match, supplier_id: "SUP-7777" } };
    expect(find([other, stale, second, R], args({ supplier_id: "SUP-1" }))).toEqual({
      matched: false,
      firstMismatch: { ruleIndex: 2, argPath: "supplier_id", role: "destination" },
    });
  });
  it("rulesEnabled = false ならどれも一致しない", () => {
    expect(find([R], args(), T_PO, false)).toEqual({ matched: false, firstMismatch: null });
  });
  it("R17：destination のないツールは scope: self のときだけルールで一致", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { title: "content" } };
    const rule: EffectiveRule = { id: "r-n", action: "mcp.notes.create_note", tool_hash: H, match: {}, free: [] };
    expect(findMatchingRule([rule], "mcp.notes.create_note", { title: "x" }, { ...tool, scope: "self" }, true).matched).toBe(true);
    expect(findMatchingRule([rule], "mcp.notes.create_note", { title: "x" }, tool, true).matched).toBe(false);
  });
  it("RU-09：汚染はこの関数の入力にない（BR-39）", () => {
    expect(findMatchingRule.length).toBe(5);
  });

  const SKUS = ["BEAN-HOUSE", "MILK-1L", "SUGAR", " BEAN-HOUSE "];
  const arbItems = fc.array(
    fc.record({ sku: fc.constantFrom(...SKUS), quantity: fc.integer({ min: 0, max: 50 }), unit_price: fc.integer({ min: 0, max: 3000 }) }),
    { minLength: 1, maxLength: 5 },
  );
  it("性質：要素の並べ替えでは一致が変わらない（集合として比べる）", () => {
    fc.assert(
      fc.property(arbItems, arbItems, (ruleItems, callItems) => {
        const rule: EffectiveRule = { ...R, match: { supplier_id: "SUP-0012", "items[].sku": ruleItems.map((i) => i.sku) } };
        const a = find([rule], args({ items: callItems }));
        const b = find([rule], args({ items: [...callItems].reverse() }));
        expect(b).toEqual(a);
      }),
    );
  });
  it("性質：承認した品目と同じ多重集合なら一致し、1行でも増減すると一致しない（多重集合：M-09）", () => {
    fc.assert(
      fc.property(arbItems, fc.nat(), (items, k) => {
        const rule: EffectiveRule = { ...R, match: { supplier_id: "SUP-0012", "items[].sku": items.map((i) => i.sku) } };
        expect(find([rule], args({ items })).matched).toBe(true);
        const dup = items[k % items.length]!;
        expect(find([rule], args({ items: [...items, dup] })).matched).toBe(false);
        if (items.length > 1) expect(find([rule], args({ items: items.slice(1) })).matched).toBe(false);
      }),
    );
  });
});
