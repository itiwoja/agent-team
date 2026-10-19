import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GUARD_SUGGEST_MULTIPLIER,
  RULES_MAX_PER_AGENT,
  RuleBuildError,
  buildRuleFromIntent,
  canOfferRemember,
  suggestedGuardMax,
} from "./remember.ts";
import type { BuildRuleFromIntentInput, CanOfferRememberInput } from "./remember.ts";
import { findMatchingRule, ruleValidity } from "./rules.ts";
import type { EffectiveRule, JsonObject, Rule, ToolHash, ToolInfo } from "./types.ts";

// ---- フィクスチャ（MT §2.10 の manifest、MT §6.6 RU の前提） ----
const PO = "mcp.supplier.place_order";
const H: ToolHash = `sha256:${"a".repeat(64)}`;
const H2: ToolHash = `sha256:${"b".repeat(64)}`;
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
const tool = (over: Partial<ToolInfo> = {}): ToolInfo => ({ ...T_PO, ...over });
const offer = (over: Partial<CanOfferRememberInput> = {}) =>
  canOfferRemember({
    tool: T_PO,
    effectiveMcpWrite: "approve",
    rulesEnabled: true,
    isHandoffOnly: false,
    isDryRun: false,
    currentRuleCount: 0,
    ...over,
  });
const item = (sku: string, quantity = 12, unit_price = 780) => ({ sku, quantity, unit_price });
const A0: JsonObject = { supplier_id: " SUP-0012 ", items: [item("MILK-1L", 2), item("BEAN-HOUSE")], note: "至急" };
const build = (over: Partial<BuildRuleFromIntentInput> = {}): Rule =>
  buildRuleFromIntent({
    intent: { id: "i-1", action: PO, args: A0, toolHash: H },
    tool: T_PO,
    freeOptions: ["items[].quantity", "items[].unit_price"],
    labels: { supplier_id: "山田珈琲" },
    addedBy: "u-owner",
    now: "2026-10-03T09:00:00.000Z",
    newId: "r-7f3a",
    createdWhileTainted: false,
    ...over,
  });
const effective = (r: Rule): EffectiveRule => ({ id: r.id, action: r.action, match: r.match, free: r.free, tool_hash: r.tool_hash });

describe("canOfferRemember（MT §3.7、09_api/approvals.md:125-132。外れた番号の配列：M-24）", () => {
  it("5つの条件と上限をすべて満たせば ok", () => {
    expect(offer()).toEqual({ ok: true });
  });

  it("CL-03・AP-7・RU-19：未分類（unclassified）のツールには出さない → 条件1（read も同じ）", () => {
    expect(offer({ tool: tool({ classification: "unclassified" }) })).toEqual({ ok: false, failed: [1] });
    expect(offer({ tool: tool({ classification: "read" }) })).toEqual({ ok: false, failed: [1] });
  });

  it("AR-11・AP-8：引数が全部 content で scope = null → 条件2", () => {
    const allContent = tool({ argRoles: { text: "content", body: "content" } });
    expect(offer({ tool: allContent })).toEqual({ ok: false, failed: [2] });
  });

  it("AR-12：destination がなくても scope = self なら出す", () => {
    expect(offer({ tool: tool({ argRoles: { text: "content" }, scope: "self" }) })).toEqual({ ok: true });
  });

  it("RU-08・AP-9：rules.enabled = false → 条件3。mcp_write が approve でない（deny・handoff・auto）も条件3", () => {
    expect(offer({ rulesEnabled: false })).toEqual({ ok: false, failed: [3] });
    expect(offer({ effectiveMcpWrite: "deny" })).toEqual({ ok: false, failed: [3] });
    expect(offer({ effectiveMcpWrite: "handoff" })).toEqual({ ok: false, failed: [3] });
    expect(offer({ effectiveMcpWrite: "auto" })).toEqual({ ok: false, failed: [3] });
  });

  it("BR-36：handoff だけの操作 → 条件4", () => {
    expect(offer({ isHandoffOnly: true })).toEqual({ ok: false, failed: [4] });
  });

  it("RU-18：試し実行（リハーサルの走行を含む is_dry_run）→ 条件5", () => {
    expect(offer({ isDryRun: true })).toEqual({ ok: false, failed: [5] });
  });

  it("RU-14・AP-10：ルールが20個あると21個目は出さない（'limit'）。19個なら出す", () => {
    expect(RULES_MAX_PER_AGENT).toBe(20);
    expect(offer({ currentRuleCount: 19 })).toEqual({ ok: true });
    expect(offer({ currentRuleCount: 20 })).toEqual({ ok: false, failed: ["limit"] });
    expect(offer({ currentRuleCount: 2, maxPerAgent: 3 })).toEqual({ ok: true });
    expect(offer({ currentRuleCount: 3, maxPerAgent: 3 })).toEqual({ ok: false, failed: ["limit"] });
  });

  it("数えられない上限・件数は上限に当たったものとして扱う（厳しい側）", () => {
    expect(offer({ currentRuleCount: Number.NaN })).toEqual({ ok: false, failed: ["limit"] });
    expect(offer({ maxPerAgent: Number.NaN })).toEqual({ ok: false, failed: ["limit"] });
  });

  it("T-76：外れた条件はすべて番号順に返す", () => {
    const r = offer({
      tool: tool({ classification: "unclassified", argRoles: { text: "content" } }),
      effectiveMcpWrite: "deny",
      rulesEnabled: false,
      isHandoffOnly: true,
      isDryRun: true,
      currentRuleCount: 20,
    });
    expect(r).toEqual({ ok: false, failed: [1, 2, 3, 4, 5, "limit"] });
  });
});

describe("buildRuleFromIntent（MT §3.8、BR-69・D-60、M-03・M-10）", () => {
  it("RU-15・AP-11：free = [quantity, unit_price] なら match は supplier_id と items[].sku だけ（note は入れない）、tool_hash は Intent の toolHash", () => {
    const r = build();
    expect(r).toEqual({
      id: "r-7f3a",
      action: PO,
      match: { "items[].sku": ["BEAN-HOUSE", "MILK-1L"], supplier_id: "SUP-0012" },
      free: ["items[].quantity", "items[].unit_price"],
      labels: { supplier_id: "山田珈琲" },
      tool_hash: H,
      added_by: "u-owner",
      added_at: "2026-10-03T09:00:00.000Z",
      source_intent_id: "i-1",
      created_while_tainted: false,
    });
    expect(r.match).not.toHaveProperty("note");
  });

  it("SG-09：汚染されたタスクの Intent からも作れ、created_while_tainted = true を残す。照合に使う項目は変わらない", () => {
    const clean = build();
    const tainted = build({ createdWhileTainted: true });
    expect(tainted.created_while_tainted).toBe(true);
    expect(tainted).toMatchObject({ id: "r-7f3a", added_by: "u-owner", added_at: "2026-10-03T09:00:00.000Z", source_intent_id: "i-1" });
    expect(effective(tainted)).toEqual(effective(clean));
    const args = { supplier_id: "SUP-0012", items: [item("BEAN-HOUSE", 1, 1), item("MILK-1L", 3, 3)] };
    expect(findMatchingRule([effective(tainted)], PO, args, T_PO, true)).toEqual(findMatchingRule([effective(clean)], PO, args, T_PO, true));
  });

  it("match の値は正規化した実際の値（文字列は trim、配列は並べ替えるが重複は残す：M-09）", () => {
    const r = build({ intent: { id: "i-2", action: PO, args: { ...A0, items: [item("B"), item("A"), item("B")] }, toolHash: H } });
    expect(r.match["items[].sku"]).toEqual(["A", "B", "B"]);
    expect(r.match.supplier_id).toBe("SUP-0012");
  });

  it("free が空でも [] を持ち（M-03）、すべての option を固定する（BR-69 の既定）", () => {
    const r = build({ freeOptions: [] });
    expect(r.free).toEqual([]);
    expect(Object.keys(r.match).sort()).toEqual(["items[].quantity", "items[].sku", "items[].unit_price", "supplier_id"]);
    expect(r.match["items[].quantity"]).toEqual([12, 2]); // 正規形 JSON の文字列の順（"12" < "2"）
  });

  it("free は重複を除いて昇順。labels が空なら持たない", () => {
    const r = build({ freeOptions: ["items[].unit_price", "items[].quantity", "items[].unit_price"], labels: {} });
    expect(r.free).toEqual(["items[].quantity", "items[].unit_price"]);
    expect(r).not.toHaveProperty("labels");
  });

  it("RU-16・AP-12：free に destination（supplier_id）→ 例外 free_not_option（API は 400）", () => {
    expect(() => build({ freeOptions: ["supplier_id"] })).toThrow(RuleBuildError);
    try {
      build({ freeOptions: ["items[].quantity", "supplier_id"] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RuleBuildError);
      expect((e as RuleBuildError).code).toBe("free_not_option");
      expect((e as RuleBuildError).argPath).toBe("supplier_id");
    }
  });

  it("free に content・存在しない引数も例外", () => {
    expect(() => build({ freeOptions: ["note"] })).toThrow(/option/);
    expect(() => build({ freeOptions: ["bcc"] })).toThrow(RuleBuildError);
    expect(() => build({ freeOptions: ["constructor"] })).toThrow(RuleBuildError);
  });

  it("Intent の toolHash が今のツールと違う → 例外 tool_changed（API は 409 INTENT_CHANGED）", () => {
    try {
      build({ tool: tool({ toolHash: H2 }) });
      expect.unreachable();
    } catch (e) {
      expect((e as RuleBuildError).code).toBe("tool_changed");
    }
  });

  it("RU-20：Intent になかった optional の destination（cc）は null で固定し、あとで cc を付けた Intent は一致しない", () => {
    const mail = tool({ toolHash: H2, argRoles: { to: "destination", cc: "destination", body: "content" } });
    const r = buildRuleFromIntent({
      intent: { id: "i-m", action: "mcp.mail.send", args: { to: "a@example.com", body: "x" }, toolHash: H2 },
      tool: mail,
      freeOptions: [],
      labels: {},
      addedBy: "u",
      now: "2026-10-03T09:00:00.000Z",
      newId: "r-m",
      createdWhileTainted: false,
    });
    expect(r.match).toEqual({ cc: null, to: "a@example.com" });
    expect(findMatchingRule([effective(r)], "mcp.mail.send", { to: "a@example.com", body: "y" }, mail, true).matched).toBe(true);
    expect(findMatchingRule([effective(r)], "mcp.mail.send", { to: "a@example.com", cc: "b@example.com", body: "y" }, mail, true).matched).toBe(false);
  });

  it("RU-13：option send_at を固定（null）で作ったルールは、send_at を指定した Intent と一致しない", () => {
    const slack = tool({ toolHash: H2, argRoles: { channel: "destination", text: "content", send_at: "option" } });
    const r = buildRuleFromIntent({
      intent: { id: "i-s", action: "mcp.slack.post", args: { channel: "C1", text: "x" }, toolHash: H2 },
      tool: slack,
      freeOptions: [],
      labels: {},
      addedBy: "u",
      now: "2026-10-03T09:00:00.000Z",
      newId: "r-s",
      createdWhileTainted: false,
    });
    expect(r.match).toEqual({ channel: "C1", send_at: null });
    expect(findMatchingRule([effective(r)], "mcp.slack.post", { channel: "C1", text: "y", send_at: "2026-10-04" }, slack, true).matched).toBe(false);
  });

  it("RL-1・RL-3：作ったルールは sku の順が違い数量・単価（free）が違う発注に一致し、sku が1つ多いと一致しない", () => {
    const r = effective(build());
    const reordered = { supplier_id: "SUP-0012", items: [item("BEAN-HOUSE", 99, 2400), item("MILK-1L", 1, 1)], note: "別の本文" };
    expect(findMatchingRule([r], PO, reordered, T_PO, true).matched).toBe(true);
    const extraSku = { ...reordered, items: [...(reordered.items as JsonObject[]), item("SUGAR")] };
    expect(findMatchingRule([r], PO, extraSku, T_PO, true).matched).toBe(false);
  });

  it("性質：[以後も許可] を出せるツールで作ったルールは有効で、元の Intent にいつも一致する（M-10・M-11 の整合）", () => {
    const options = ["items[].sku", "items[].quantity", "items[].unit_price"];
    const str = fc.string({ maxLength: 6 });
    const itemArb = fc.record(
      { sku: str, quantity: fc.oneof(fc.integer(), fc.constant(null)), unit_price: fc.integer({ min: 0, max: 5000 }) },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(
        fc.record({ supplier_id: fc.oneof(str, fc.constant(null)), items: fc.array(itemArb, { maxLength: 4 }), note: str }, { requiredKeys: [] }),
        fc.subarray(options),
        (args, free) => {
          const r = build({ intent: { id: "i-p", action: PO, args: args as JsonObject, toolHash: H }, freeOptions: free });
          expect(ruleValidity(effective(r), { action: PO, tool: T_PO, rulesEnabled: true })).toEqual({ valid: true });
          expect(findMatchingRule([effective(r)], PO, args as JsonObject, T_PO, true)).toEqual({ matched: true, index: 0 });
        },
      ),
    );
  });
});

describe("suggestedGuardMax（IA §3.8-5、mcp-and-web.md:130：承認した値の2倍）", () => {
  it("数値の引数は2倍、配列の要素は最大値の2倍", () => {
    expect(GUARD_SUGGEST_MULTIPLIER).toBe(2);
    expect(suggestedGuardMax({ quantity: 20 }, "quantity")).toBe(40);
    expect(suggestedGuardMax(A0, "items[].quantity")).toBe(24);
    expect(suggestedGuardMax(A0, "items[].unit_price")).toBe(1560);
  });
  it("数でない値・欠け・空の配列は出さない（null）", () => {
    expect(suggestedGuardMax(A0, "items[].sku")).toBeNull();
    expect(suggestedGuardMax(A0, "missing")).toBeNull();
    expect(suggestedGuardMax({ items: [] }, "items[].quantity")).toBeNull();
    expect(suggestedGuardMax({ items: [{ quantity: 1 }, { quantity: "2" }] }, "items[].quantity")).toBeNull();
    expect(suggestedGuardMax({ items: [{ quantity: 1 }, {}] }, "items[].quantity")).toBeNull();
  });
});
