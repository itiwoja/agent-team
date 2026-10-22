import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "./canonical.ts";
import {
  computeInputsHash,
  computeMcpIntentHash,
  computeRecheckInputsHash,
  destinationKey,
  optionDigest,
  repeatKeyOf,
  toolHashOf,
} from "./hashes.ts";
import type {
  ArgRoleMap,
  Counters,
  EffectivePolicy,
  Flags,
  JsonObject,
  OperationType,
  AutonomyLevel,
  Subject,
  TaintState,
  ToolHash,
} from "./types.ts";
import { OPERATION_TYPES } from "./types.ts";

const PO_ROLES: ArgRoleMap = {
  supplier_id: "destination",
  "items[].sku": "option",
  "items[].quantity": "option",
  "items[].unit_price": "option",
  note: "content",
};
const MS_ROLES: ArgRoleMap = { to: "destination", body: "content" };
const A0: JsonObject = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 800 }], note: "いつもの" };
const DK01 = "2366fc5baa1285be13d0ae6278b43f6d9ef3f56a6391abae7be184e7e409b40e";
const HEX64 = /^[0-9a-f]{64}$/;

describe("destinationKey（KD §3.3-4、BR-68）", () => {
  it("J3：place_order の宛先のキー", () => {
    expect(destinationKey("mcp.supplier.place_order", A0, PO_ROLES)).toBe(DK01);
  });
  it("J4：mail.send の宛先のキー", () => {
    expect(destinationKey("mcp.mail.send", { to: "owner@example.com", body: "…" }, MS_ROLES)).toBe(
      "35e850d7d8c8c20412594869f4fc0b71fd550a3cd7dd9ae41b7401814bae2f64",
    );
  });
  it("接頭辞なしの小文字64桁（M-07）", () => {
    expect(destinationKey("mcp.supplier.place_order", A0, PO_ROLES)).toMatch(HEX64);
  });
  it("DK-01：option（items）・content（note）だけ違っても同じキー", () => {
    const b = { supplier_id: "supplier-01", items: [{ sku: "MILK-1L", quantity: 3, unit_price: 200 }], note: "至急" };
    expect(destinationKey("mcp.supplier.place_order", b, PO_ROLES)).toBe(DK01);
  });
  it("DK-02：宛先が違えば違うキー", () => {
    expect(destinationKey("mcp.supplier.place_order", { ...A0, supplier_id: "supplier-02" }, PO_ROLES)).not.toBe(DK01);
  });
  it("DK-03・H-9：destination の配列は順序を無視", () => {
    const roles: ArgRoleMap = { to: "destination" };
    expect(destinationKey("mcp.mail.send", { to: ["a", "b"] }, roles)).toBe(destinationKey("mcp.mail.send", { to: ["b", "a"] }, roles));
  });
  it("H-10：要素の増減で違うキー", () => {
    const roles: ArgRoleMap = { to: "destination" };
    expect(destinationKey("mcp.mail.send", { to: ["a"] }, roles)).not.toBe(destinationKey("mcp.mail.send", { to: ["a", "b"] }, roles));
  });
  it("DK-04・H-8：同じ値で action が違えば違うキー", () => {
    const roles: ArgRoleMap = { supplier_id: "destination" };
    expect(destinationKey("mcp.supplier.place_order", { supplier_id: "x" }, roles)).not.toBe(
      destinationKey("mcp.mail.send", { supplier_id: "x" }, roles),
    );
  });
  it("DK-05：unclassified（全部 destination）は本文が違えば違うキー", () => {
    const roles: ArgRoleMap = { to: "destination", body: "destination" };
    expect(destinationKey("mcp.mail.send", { to: "a", body: "x" }, roles)).not.toBe(destinationKey("mcp.mail.send", { to: "a", body: "y" }, roles));
  });
  it("U3・H-7：前後の空白は正規化で同じキー", () => {
    expect(destinationKey("mcp.supplier.place_order", { ...A0, supplier_id: " supplier-01 " }, PO_ROLES)).toBe(DK01);
  });
  it("欠けた destination は null と同じキー（M-10・KD §8-22）", () => {
    expect(destinationKey("mcp.mail.send", {}, MS_ROLES)).toBe(destinationKey("mcp.mail.send", { to: null }, MS_ROLES));
  });
  it("H-11：スキーマにあって役割の確定のない引数（destination に倒れたもの）は入る", () => {
    const roles: ArgRoleMap = { to: "destination", body: "content", x: "destination" };
    expect(destinationKey("mcp.mail.send", { to: "a", x: "1" }, roles)).not.toBe(destinationKey("mcp.mail.send", { to: "a", x: "2" }, roles));
  });
  it("AR-13 は M-12 で変更：argRoles にない余計な引数（bcc）は入れない", () => {
    expect(destinationKey("mcp.mail.send", { to: "a", bcc: "evil@example.com" }, MS_ROLES)).toBe(
      destinationKey("mcp.mail.send", { to: "a" }, MS_ROLES),
    );
  });
  it("H-12：destination のないツール（scope: self）は同じキー", () => {
    const roles: ArgRoleMap = { title: "content" };
    expect(destinationKey("mcp.notes.create", { title: "a" }, roles)).toBe(destinationKey("mcp.notes.create", { title: "b" }, roles));
    expect(destinationKey("mcp.notes.create", {}, roles)).toBe(hashCanonical({ action: "mcp.notes.create", destination: {} }));
  });
  it("'p[].f' の destination は要素の値の多重集合", () => {
    const roles: ArgRoleMap = { "items[].sku": "destination" };
    const k = (skus: string[]) => destinationKey("a", { items: skus.map((sku) => ({ sku })) }, roles);
    expect(k(["A", "B"])).toBe(k(["B", "A"]));
    expect(k(["A"])).not.toBe(k(["A", "A"]));
  });
});

describe("optionDigest（G-05）", () => {
  it("option の値（free の option を含む）のハッシュ。content と destination は入らない", () => {
    const d = optionDigest("mcp.supplier.place_order", A0, PO_ROLES);
    expect(d).toMatch(HEX64);
    expect(d).toBe(
      hashCanonical({
        action: "mcp.supplier.place_order",
        options: { "items[].quantity": [20], "items[].sku": ["BEAN-HOUSE"], "items[].unit_price": [800] },
      }),
    );
    expect(optionDigest("mcp.supplier.place_order", { ...A0, note: "x", supplier_id: "supplier-02" }, PO_ROLES)).toBe(d);
  });
  it("数量が変われば違う。要素の順は無視", () => {
    const d = optionDigest("mcp.supplier.place_order", A0, PO_ROLES);
    expect(optionDigest("mcp.supplier.place_order", { ...A0, items: [{ sku: "BEAN-HOUSE", quantity: 200, unit_price: 800 }] }, PO_ROLES)).not.toBe(d);
    const two = (a: JsonObject, b: JsonObject) => optionDigest("x", { items: [a, b] }, PO_ROLES);
    expect(two({ sku: "A", quantity: 1 }, { sku: "B", quantity: 2 })).toBe(two({ sku: "B", quantity: 2 }, { sku: "A", quantity: 1 }));
  });
  it("欠けた option は null", () => {
    const roles: ArgRoleMap = { send_at: "option" };
    expect(optionDigest("x", {}, roles)).toBe(optionDigest("x", { send_at: null }, roles));
    expect(optionDigest("x", {}, roles)).toBe(hashCanonical({ action: "x", options: { send_at: null } }));
  });
});

describe("repeatKeyOf（KD §3.3-5）", () => {
  it("J5：get_inventory の repeatKey", () => {
    expect(repeatKeyOf({ actionType: "mcp_call", action: "mcp.store.get_inventory", args: {} })).toBe(
      "3a936c3e0519549f55fe656db9fd787a6a2439611547d31a224d31365c9b5eac",
    );
  });
  it("K4：引数のキーの順だけ違っても同じ", () => {
    expect(repeatKeyOf({ actionType: "mcp_call", action: "mcp.a.b", args: { a: 1, b: 2 } })).toBe(
      repeatKeyOf({ actionType: "mcp_call", action: "mcp.a.b", args: { b: 2, a: 1 } }),
    );
  });
  it("trim しない（完全に同じ呼び出しだけを数える）", () => {
    expect(repeatKeyOf({ actionType: "mcp_call", action: "mcp.a.b", args: { a: "x" } })).not.toBe(
      repeatKeyOf({ actionType: "mcp_call", action: "mcp.a.b", args: { a: " x" } }),
    );
  });
  it("action がなければ actionType", () => {
    expect(repeatKeyOf({ actionType: "notify", args: { t: 1 } })).toBe(hashCanonical({ action: "notify", args: { t: 1 } }));
    expect(repeatKeyOf({ actionType: null, args: {} })).toBe(hashCanonical({ action: null, args: {} }));
  });
});

describe("toolHashOf（MT §3.2、M-07）", () => {
  const base = {
    description: "仕入れ先に発注する",
    inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } } },
    argRoles: { to: "destination", body: "content" } as ArgRoleMap,
  };
  it("TH-08：'sha256:' つきの小文字64桁", () => {
    expect(toolHashOf(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(toolHashOf(base)).toBe(`sha256:${hashCanonical(base)}`);
  });
  it("TH-01・TH-07：JSON のキーの順だけ違っても同じ", () => {
    const reordered = {
      argRoles: { body: "content", to: "destination" } as ArgRoleMap,
      inputSchema: { properties: { body: { type: "string" }, to: { type: "string" } }, type: "object" },
      description: base.description,
    };
    expect(toolHashOf(reordered)).toBe(toolHashOf(base));
  });
  it("TH-02・TH-03・H-13：説明の1文字・末尾の空白で違う（正規化しない）", () => {
    expect(toolHashOf({ ...base, description: "仕入れ先に発注する。" })).not.toBe(toolHashOf(base));
    expect(toolHashOf({ ...base, description: "仕入れ先に発注する " })).not.toBe(toolHashOf(base));
  });
  it("TH-04：スキーマにプロパティを足すと違う", () => {
    const s = structuredClone(base.inputSchema) as { properties: Record<string, unknown> };
    s.properties.cc = { type: "string" };
    expect(toolHashOf({ ...base, inputSchema: s as never })).not.toBe(toolHashOf(base));
  });
  it("TH-05：役割が変われば違う", () => {
    expect(toolHashOf({ ...base, argRoles: { to: "content", body: "content" } })).not.toBe(toolHashOf(base));
  });
  it("TH-06・TH-09：annotations・名前・分類など余計な項目は入らない", () => {
    const withExtra = { ...base, annotations: { readOnlyHint: true }, name: "send", classification: "read" };
    expect(toolHashOf(withExtra)).toBe(toolHashOf(base));
  });
});

describe("computeMcpIntentHash（intents.md:79、IA §3.1-4）", () => {
  const base = {
    connectorId: "11111111-1111-1111-1111-111111111111",
    tool: "place_order",
    arguments: A0,
    toolHash: `sha256:${"a".repeat(64)}` as ToolHash,
    effectivePolicyHash: "e".repeat(64),
  };
  it("接頭辞なしの64桁で、式どおり", () => {
    const h = computeMcpIntentHash(base);
    expect(h).toMatch(HEX64);
    expect(h).toBe(hashCanonical({ actionType: "mcp_call", ...base }));
  });
  it("H-1：引数のキーの順だけ違っても同じ", () => {
    const reordered = { note: "いつもの", items: [{ unit_price: 800, quantity: 20, sku: "BEAN-HOUSE" }], supplier_id: "supplier-01" };
    expect(computeMcpIntentHash({ ...base, arguments: reordered })).toBe(computeMcpIntentHash(base));
  });
  it("H-2：note を1文字変えると違う", () => {
    expect(computeMcpIntentHash({ ...base, arguments: { ...A0, note: "いつもの。" } })).not.toBe(computeMcpIntentHash(base));
  });
  it("H-3：items の要素の順を入れ替えると違う（配列を並べ替えない）", () => {
    const a = { supplier_id: "s", items: [{ sku: "A" }, { sku: "B" }] };
    const b = { supplier_id: "s", items: [{ sku: "B" }, { sku: "A" }] };
    expect(computeMcpIntentHash({ ...base, arguments: a })).not.toBe(computeMcpIntentHash({ ...base, arguments: b }));
  });
  it("H-3 補足：前後の空白も正規化しない", () => {
    expect(computeMcpIntentHash({ ...base, arguments: { ...A0, supplier_id: " supplier-01 " } })).not.toBe(computeMcpIntentHash(base));
  });
  it("H-4：toolHash・effectivePolicyHash のどちらが変わっても違う", () => {
    expect(computeMcpIntentHash({ ...base, toolHash: `sha256:${"b".repeat(64)}` })).not.toBe(computeMcpIntentHash(base));
    expect(computeMcpIntentHash({ ...base, effectivePolicyHash: "f".repeat(64) })).not.toBe(computeMcpIntentHash(base));
  });
  it("H-5：20 と 20.0（JSON の文字列から読む）は同じ", () => {
    const a = JSON.parse('{"q":20}') as JsonObject;
    const b = JSON.parse('{"q":20.0}') as JsonObject;
    expect(computeMcpIntentHash({ ...base, arguments: a })).toBe(computeMcpIntentHash({ ...base, arguments: b }));
  });
  it("H-6：NaN を含めば例外", () => {
    expect(() => computeMcpIntentHash({ ...base, arguments: { q: Number.NaN } })).toThrow();
  });
  it("origin・jobId・taskId などは入らない", () => {
    expect(computeMcpIntentHash({ ...base, origin: "deliver", jobId: "j", taskId: "t" } as typeof base)).toBe(computeMcpIntentHash(base));
  });
});

const AUTONOMY = Object.fromEntries(OPERATION_TYPES.map((op) => [op, "deny"])) as Record<OperationType, AutonomyLevel>;
const POLICY: EffectivePolicy = {
  version: 1,
  autonomy: { ...AUTONOMY, mcp_read: "auto", mcp_write: "approve", notify: "auto" },
  budget: { per_task_usd: 0.2, per_day_usd: 1, agent_day_usd: 1, max_steps: 40, max_minutes: 15 },
  breakers: { same_action_repeat: 5, denied_attempts_max: 3, step_cost_usd_max: 0.5 },
  max_intents_per_task: 5,
  max_runs_per_day: 10,
  tools: ["mcp_call", "notify", "submit_report", "finish"],
  mcp: { llmRead: true, llmWrite: true, deliverWrite: true, grants: { supplier: ["place_order"] } },
  web: { allow_domains: [], deny_domains: [], max_fetches_per_task: 0 },
  rules: { enabled: true, items: [] },
  guards: [],
  approvers: [],
};
const SUBJECT: Subject = {
  kind: "tool_call",
  actionType: "mcp_call",
  action: "mcp.supplier.place_order",
  args: A0,
  paths: [],
  origin: "agent",
  tool: {
    classification: "write",
    status: "ok",
    connectorEnabled: true,
    argRoles: PO_ROLES,
    scope: null,
    toolHash: `sha256:${"a".repeat(64)}`,
  },
};
const COUNTERS: Counters = {
  stepsUsed: 3,
  costUsd: 0.05,
  dayCostUsd: 0.2,
  agentDayCostUsd: 0.1,
  elapsedSec: 60,
  deniedCount: 0,
  repeatKey: null,
  repeatCount: 0,
  intentsCount: 0,
  unknownOutcomeKeys: ["b".repeat(64), "a".repeat(64), "c".repeat(64)],
};
const FLAGS: Flags = { killSwitchEngaged: false, taskStatus: "running" };
const TAINT: TaintState = { tainted: false, sources: [] };

describe("computeInputsHash（KD §3.3-3）", () => {
  const h0 = computeInputsHash(POLICY, SUBJECT, COUNTERS, FLAGS, TAINT);
  it("接頭辞なしの64桁で、同じ入力なら同じ", () => {
    expect(h0).toMatch(HEX64);
    expect(computeInputsHash(structuredClone(POLICY), structuredClone(SUBJECT), structuredClone(COUNTERS), { ...FLAGS }, { ...TAINT })).toBe(h0);
  });
  it("X3：型にないキー（shadow・rehearsal_run_id・テンプレート名など）は入らない", () => {
    const flags = { ...FLAGS, shadow: true } as Flags;
    const subject = { ...SUBJECT, shadow: true, rehearsal_run_id: "r", tool: { ...SUBJECT.tool!, description: "x" } } as Subject;
    const counters = { ...COUNTERS, rehearsalCostUsd: 0.4, changedPaths: ["a"] } as Counters;
    const policy = {
      ...POLICY,
      template: { name: "assistant" },
      budget: { ...POLICY.budget, per_rehearsal_usd: 0.5 },
      autonomy: { ...POLICY.autonomy, browser_submit: "auto" },
      rules: { enabled: true, items: [] },
    } as unknown as EffectivePolicy;
    const taint = { ...TAINT, note: "x" } as TaintState;
    expect(computeInputsHash(policy, subject, counters, flags, taint)).toBe(h0);
  });
  it("X3：汚染の出どころも型にあるキーだけ（upstream の中も）。型にあるキーが変われば変わる", () => {
    const at = "2026-10-08T09:00:00+09:00";
    const mail = { kind: "mcp_read", connectorId: "c-1", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at } as const;
    const base: TaintState = {
      tainted: true,
      sources: [mail, { kind: "handoff", fromTaskId: "t-1", fromAgentName: "受信箱係", upstream: [mail, { kind: "web_fetch", url: "https://a.example/", at }], at }],
    };
    const extra = {
      tainted: true,
      sources: [
        { ...mail, subject: "店長（確認済み）", shadow: true },
        {
          kind: "handoff",
          fromTaskId: "t-1",
          fromAgentName: "受信箱係",
          upstream: [{ ...mail, body: "100個ずつ追加で" }, { kind: "web_fetch", url: "https://a.example/", at, title: "x" }],
          at,
          note: "x",
        },
      ],
    } as unknown as TaintState;
    const h = computeInputsHash(POLICY, SUBJECT, COUNTERS, FLAGS, base);
    expect(computeInputsHash(POLICY, SUBJECT, COUNTERS, FLAGS, extra)).toBe(h);
    const otherTool = { ...base, sources: [{ ...mail, tool: "get_message" }, base.sources[1]!] } as TaintState;
    expect(computeInputsHash(POLICY, SUBJECT, COUNTERS, FLAGS, otherTool)).not.toBe(h);
    const otherUrl = structuredClone(base) as unknown as { tainted: boolean; sources: Array<{ upstream?: Array<{ url?: string }> }> };
    otherUrl.sources[1]!.upstream![1]!.url = "https://b.example/";
    expect(computeInputsHash(POLICY, SUBJECT, COUNTERS, FLAGS, otherUrl as unknown as TaintState)).not.toBe(h);
  });
  it("ルールの表示用の項目（labels・added_by など）は入らない", () => {
    const rule = {
      id: "r-1",
      action: "mcp.supplier.place_order",
      match: { supplier_id: "supplier-01" },
      free: [],
      tool_hash: `sha256:${"a".repeat(64)}`,
    } as const;
    const withRule = { ...POLICY, rules: { enabled: true, items: [rule] } };
    const withLabels = { ...POLICY, rules: { enabled: true, items: [{ ...rule, labels: { supplier_id: "山田珈琲" }, added_by: "me" }] } };
    expect(computeInputsHash(withLabels, SUBJECT, COUNTERS, FLAGS, TAINT)).toBe(computeInputsHash(withRule, SUBJECT, COUNTERS, FLAGS, TAINT));
  });
  it("X9：unknownOutcomeKeys の順序を入れ替えても同じ", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([...COUNTERS.unknownOutcomeKeys], { minLength: 3, maxLength: 3 }), (keys) => {
        expect(computeInputsHash(POLICY, SUBJECT, { ...COUNTERS, unknownOutcomeKeys: keys }, FLAGS, TAINT)).toBe(h0);
      }),
    );
  });
  it("J9：args.items の順序だけ違えば違う（引数の配列は並べ替えない）", () => {
    const a = { ...A0, items: [{ sku: "A", quantity: 1 }, { sku: "B", quantity: 2 }] };
    const b = { ...A0, items: [{ sku: "B", quantity: 2 }, { sku: "A", quantity: 1 }] };
    expect(computeInputsHash(POLICY, { ...SUBJECT, args: a }, COUNTERS, FLAGS, TAINT)).not.toBe(
      computeInputsHash(POLICY, { ...SUBJECT, args: b }, COUNTERS, FLAGS, TAINT),
    );
  });
  it("X1・X2：汚染・origin は入る", () => {
    expect(computeInputsHash(POLICY, SUBJECT, COUNTERS, FLAGS, { tainted: true, sources: [] })).not.toBe(h0);
    expect(computeInputsHash(POLICY, { ...SUBJECT, origin: "deliver" }, COUNTERS, FLAGS, TAINT)).not.toBe(h0);
  });
  it("recheckIntent の inputsHash は decide のものと区別でき、unknownOutcomeKeys の順序によらない", () => {
    const r = computeRecheckInputsHash(POLICY, SUBJECT, { unknownOutcomeKeys: ["b".repeat(64), "a".repeat(64)] });
    expect(r).toMatch(HEX64);
    expect(r).not.toBe(h0);
    expect(computeRecheckInputsHash(POLICY, SUBJECT, { unknownOutcomeKeys: ["a".repeat(64), "b".repeat(64)] })).toBe(r);
  });
});
