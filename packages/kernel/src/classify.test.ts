import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CHANGE_KINDS, CHANGE_ORDER, classify } from "./classify.ts";
import type { ChangeItem, ClassifyContext, ClassifyResult } from "./classify.ts";
import { compose, composeAll, effectivePolicyHash } from "./compose.ts";
import { decide, recheckIntent } from "./decide.ts";
import { AUTONOMY_STRICTNESS, DEFAULT_CEILINGS, TEMPLATES, defaultWorkspacePolicy, initialAgentDefinition, validateAgentDefinition } from "./policy.ts";
import type { AgentDefinitionInput, ConnectorCatalog, WorkspacePolicy } from "./policy.ts";
import { EMPTY_TAINT, OPERATION_TYPES } from "./types.ts";
import type { Counters, EffectivePolicy, Flags, Guard, JsonObject, Subject, ToolHash, ToolInfo } from "./types.ts";

/** 試験の例のコネクタ（ワークスペースで有効にするもの） */
const EXAMPLE_CONNECTORS = ["bank", "mail", "store", "supplier"];

// ---- フィクスチャ（KC §6 の前提：DEFAULT_CEILINGS、ゲストの ws、§2.4 の仕入れ係（M-36 の付与）、例の4つのコネクタ） ----

const H = (c: string): ToolHash => `sha256:${c.repeat(64)}`;
const PO = "mcp.supplier.place_order";
const SEND = "mcp.mail.send";
const read = (h: string): ToolInfo => ({ classification: "read", status: "ok", connectorEnabled: true, scope: null, toolHash: H(h), argRoles: {} });
const T_PO: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: H("a"),
  argRoles: { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" },
};
const T_MS: ToolInfo = { classification: "write", status: "ok", connectorEnabled: true, scope: null, toolHash: H("c"), argRoles: { to: "destination", body: "content" } };
const T_BP: ToolInfo = { classification: "write", status: "ok", connectorEnabled: true, scope: null, toolHash: H("d"), argRoles: { account: "destination", supplier_id: "option" } };
const TOOLS: ConnectorCatalog = {
  store: { connected: true, tools: { get_inventory: read("1") } },
  supplier: { connected: true, tools: { list_products: read("2"), place_order: T_PO } },
  mail: { connected: true, tools: { list_inbox: read("3"), send: T_MS } },
  bank: { connected: true, tools: { register_payee: T_BP } },
};
const WS: WorkspacePolicy = pinDay1(defaultWorkspacePolicy("guest", EXAMPLE_CONNECTORS));
/** 試験の ws は1日 $1 に固定する（D-105 でゲストの既定は 2 になったが、ここの期待値・保存したハッシュは per_day_usd 1 の ws で作った） */
function pinDay1(w: WorkspacePolicy): WorkspacePolicy {
  return { ...w, budget: { ...w.budget, per_day_usd: 1 } };
}
const CTX: ClassifyContext = { ceilings: DEFAULT_CEILINGS, workspacePolicy: WS, tools: TOOLS };
const BUYER: AgentDefinitionInput = {
  version: 2,
  name: "仕入れ係",
  role: "assist",
  appearance: { icon: "cart", color: "amber" },
  grants: {
    connectors: {
      store: { grant: ["get_inventory"] },
      supplier: { grant: ["list_products", "place_order"] },
      bank: { grant: ["register_payee"] },
    },
  },
  autonomy: {},
  rules: [],
  budget: { per_task_usd: 0.2, per_day_usd: 1 },
  max_runs_per_day: 10,
  profile: [],
  jobs: [{ id: "reorder", kind: "recurring", template: "assistant", instructions: "在庫を見て、必要なら仕入れ先に発注する", trigger: null, deliver: [], guards: [] }],
};
const R1 = {
  id: "r-1",
  action: PO,
  match: { supplier_id: "supplier-01", "items[].sku": ["BEAN"] },
  free: ["items[].quantity", "items[].unit_price"],
  labels: { supplier_id: "山田珈琲" },
  tool_hash: H("a"),
  added_by: "u-1",
  added_at: "2026-10-03T18:00:00+09:00",
};
const R_MAIL = { id: "r-mail", action: SEND, match: { to: "owner@example.com" }, free: [], tool_hash: H("c"), added_by: "u-1", added_at: "2026-10-03T18:00:00+09:00" };
const COUNTERS: Counters = {
  stepsUsed: 0,
  costUsd: 0,
  dayCostUsd: 0,
  agentDayCostUsd: 0,
  elapsedSec: 0,
  deniedCount: 0,
  repeatKey: null,
  repeatCount: 0,
  intentsCount: 0,
  unknownOutcomeKeys: [],
};
const FLAGS: Flags = { killSwitchEngaged: false, taskStatus: "running" };

function def(f?: (d: any) => void, base: AgentDefinitionInput = BUYER): AgentDefinitionInput {
  const d = structuredClone(base) as any;
  f?.(d);
  return d as AgentDefinitionInput;
}
const BUYER_R = def((d) => (d.rules = [R1]));
const cls = (before: AgentDefinitionInput, after: AgentDefinitionInput, ctx: ClassifyContext = CTX): ClassifyResult => classify({ before, after, ctx });
const kinds = (r: ClassifyResult) => r.items.map((i) => i.kind);
const guard = (arg: string, c: object, action = PO): Guard => ({ action, arg, ...c });
const withGuards = (guards: Guard[], base: AgentDefinitionInput = BUYER) => def((d) => (d.jobs[0].guards = guards), base);
const poSubject = (args: JsonObject, kind: Subject["kind"] = "tool_call"): Subject => ({
  kind,
  actionType: "mcp_call",
  action: PO,
  args,
  paths: [],
  tool: T_PO,
  origin: kind === "intent" ? "deliver" : "agent",
});
const order = (quantity: number, unit_price = 700, supplier_id = "supplier-01", sku = "BEAN"): JsonObject => ({
  supplier_id,
  items: [{ sku, quantity, unit_price }],
  note: "いつもの",
});

describe("6.8 classify（項目ごと。KC §3.8）", () => {
  it("K-01：変更なし → neutral、項目なし", () => {
    const r = cls(BUYER, BUYER);
    expect(r).toEqual({ classification: "neutral", items: [], widenItems: [], hasNarrow: false, missing: [], runsWarning: null, violations: [] });
  });
  it("K-02：指示だけ → neutral／instructions_changed（仕事の項目に jobId）。調整メモも同じ種類", () => {
    const r = cls(BUYER, def((d) => ((d.jobs[0].instructions = "別の指示"), (d.jobs[0].tuning = "短く"))));
    expect(r.classification).toBe("neutral");
    expect(r.items).toEqual([
      { kind: "instructions_changed", class: "neutral", path: "jobs[reorder].instructions", jobId: "reorder", before: "在庫を見て、必要なら仕入れ先に発注する", after: "別の指示" },
      { kind: "instructions_changed", class: "neutral", path: "jobs[reorder].tuning", jobId: "reorder", before: null, after: "短く" },
    ]);
  });
  it("K-03：トリガーの時刻 18:00 → 17:00 → neutral／trigger_changed。種類・通知の設定も neutral", () => {
    const at = (cron: string) => def((d) => (d.jobs[0].trigger = { type: "schedule", cron, timezone: "Asia/Tokyo" }));
    expect(kinds(cls(at("0 18 * * *"), at("0 17 * * *")))).toEqual(["trigger_changed"]);
    const r = cls(BUYER, def((d) => ((d.jobs[0].kind = "once"), (d.jobs[0].notify = { quiet_if_normal: true }))));
    expect(r.classification).toBe("neutral");
    expect(kinds(r)).toEqual(["kind_changed", "notify_changed"]);
  });
  it("K-04：名前・アイコン・役割の変更 → neutral（BR-48）", () => {
    const r = cls(BUYER, def((d) => ((d.name = "発注係"), (d.role = "research"), (d.appearance = { icon: "box", color: "blue" }))));
    expect(r.classification).toBe("neutral");
    expect(kinds(r)).toEqual(["name_changed", "role_changed", "appearance_changed"]);
  });
  it("K-05：プロフィールの項目の公開を追加 → neutral（BR-50）", () => {
    expect(cls(BUYER, def((d) => (d.profile = ["interests"])))).toMatchObject({ classification: "neutral", items: [{ kind: "profile_changed", class: "neutral" }] });
  });
  it("K-06：mcp_read auto → approve → narrow／autonomy_tightened（境界の項目は jobId なし）", () => {
    const r = cls(BUYER, def((d) => (d.autonomy = { mcp_read: "approve" })));
    expect(r.classification).toBe("narrow");
    expect(r.items).toEqual([{ kind: "autonomy_tightened", class: "narrow", path: "autonomy.mcp_read", before: "auto", after: "approve" }]);
    expect(r.hasNarrow).toBe(true);
  });
  it("K-07：mcp_read approve → auto（ws が auto）→ widen／autonomy_loosened", () => {
    const r = cls(def((d) => (d.autonomy = { mcp_read: "approve" })), BUYER);
    expect(r.classification).toBe("widen");
    expect(r.widenItems).toEqual([{ kind: "autonomy_loosened", class: "widen", path: "autonomy.mcp_read", before: "approve", after: "auto" }]);
  });
  it("K-08：mcp_write approve → auto → compose(after) の違反（by ceiling）。実効値は approve のままなので項目は出ない", () => {
    const r = cls(def((d) => (d.autonomy = { mcp_write: "approve" })), def((d) => (d.autonomy = { mcp_write: "auto" })));
    expect(r.items).toEqual([]);
    expect(r.violations).toMatchObject([{ path: "autonomy.mcp_write", by: "ceiling" }]);
  });
  it("K-09・K-10：per_task_usd 0.2 → 0.1 は narrow、0.2 → 0.3 は widen／budget_raised", () => {
    const p = (v: number) => def((d) => (d.budget.per_task_usd = v));
    expect(cls(BUYER, p(0.1))).toMatchObject({ classification: "narrow", items: [{ kind: "budget_lowered", path: "budget.per_task_usd", before: 0.2, after: 0.1 }] });
    expect(cls(BUYER, p(0.3))).toMatchObject({ classification: "widen", items: [{ kind: "budget_raised", before: 0.2, after: 0.3 }] });
  });
  it("K-11：per_task_usd 0.2 → 0.6（ws 0.5）→ violations 非空（UC-026 E1）。実効は 0.5 まで上がる", () => {
    const r = cls(BUYER, def((d) => (d.budget.per_task_usd = 0.6)));
    expect(r.violations).toMatchObject([{ path: "budget.per_task_usd", by: "policy", limit: 0.5 }]);
    expect(r.items).toMatchObject([{ kind: "budget_raised", before: 0.2, after: 0.5 }]);
  });
  it("max_steps・max_minutes も同じ（下げる narrow・上げる widen）", () => {
    expect(cls(BUYER, def((d) => (d.budget.max_steps = 20)))).toMatchObject({ classification: "narrow", items: [{ kind: "budget_lowered", path: "budget.max_steps" }] });
    expect(cls(def((d) => (d.budget.max_minutes = 10)), BUYER)).toMatchObject({ classification: "widen", items: [{ kind: "budget_raised", path: "budget.max_minutes" }] });
  });
  it("Breaker：下げる narrow／上げる widen", () => {
    expect(cls(BUYER, def((d) => (d.breakers = { same_action_repeat: 3 })))).toMatchObject({ classification: "narrow", items: [{ kind: "breaker_lowered", path: "breakers.same_action_repeat" }] });
    expect(cls(def((d) => (d.breakers = { step_cost_usd_max: 0.1 })), BUYER)).toMatchObject({ classification: "widen", items: [{ kind: "breaker_raised", path: "breakers.step_cost_usd_max" }] });
  });
  it("K-12・K-13：max_runs_per_day 10 → 11 は widen／runs_raised、10 → 9 は narrow", () => {
    expect(cls(BUYER, def((d) => (d.max_runs_per_day = 11)))).toMatchObject({ classification: "widen", items: [{ kind: "runs_raised" }] });
    expect(cls(BUYER, def((d) => (d.max_runs_per_day = 9)))).toMatchObject({ classification: "narrow", items: [{ kind: "runs_lowered" }] });
  });
  it("K-14・K-15：per_day_usd を新しく付ける → narrow／agent_day_cap_added、外す → widen／agent_day_cap_removed", () => {
    const none = def((d) => delete d.budget.per_day_usd);
    const half = def((d) => (d.budget.per_day_usd = 0.5));
    expect(cls(none, half)).toMatchObject({ classification: "narrow", items: [{ kind: "agent_day_cap_added", before: null, after: 0.5 }] });
    expect(cls(half, none)).toMatchObject({ classification: "widen", items: [{ kind: "agent_day_cap_removed", before: 0.5, after: null }] });
    expect(cls(half, BUYER)).toMatchObject({ classification: "widen", items: [{ kind: "budget_raised", path: "budget.agent_day_usd" }] });
  });
  it("K-16：付与 supplier [list_products] → + place_order → widen／grant_added（1件）", () => {
    const r = cls(def((d) => (d.grants.connectors.supplier.grant = ["list_products"])), BUYER);
    expect(r.classification).toBe("widen");
    expect(r.items).toEqual([{ kind: "grant_added", class: "widen", path: "grants.connectors.supplier[place_order]", after: "place_order" }]);
  });
  it("K-17：付与 mail [list_inbox] を新しく（読み取りでも）→ widen", () => {
    expect(cls(BUYER, def((d) => (d.grants.connectors.mail = { grant: ["list_inbox"] })))).toMatchObject({ classification: "widen", items: [{ kind: "grant_added", path: "grants.connectors.mail[list_inbox]" }] });
  });
  it("K-18：付与 place_order を外す → narrow／grant_removed", () => {
    expect(cls(BUYER, def((d) => (d.grants.connectors.supplier.grant = ["list_products"])))).toMatchObject({ classification: "narrow", items: [{ kind: "grant_removed", before: "place_order" }] });
  });
  it("K-19：付与を1つ足し1つ外す → widen（最も広い）", () => {
    const r = cls(BUYER, def((d) => ((d.grants.connectors.supplier.grant = ["list_products"]), (d.grants.connectors.mail = { grant: ["list_inbox"] }))));
    expect(r.classification).toBe("widen");
    expect(kinds(r)).toEqual(["grant_added", "grant_removed"]);
    expect(r.hasNarrow).toBe(true);
    expect(r.widenItems.map((i) => i.kind)).toEqual(["grant_added"]);
  });
  it("K-20：ルール r-1 を追加（[以後も許可]）→ widen／rule_added", () => {
    expect(cls(BUYER, BUYER_R)).toMatchObject({ classification: "widen", items: [{ kind: "rule_added", path: "rules[r-1]" }] });
  });
  it("K-21：ルール r-1 を取り消す → narrow／rule_removed", () => {
    expect(cls(BUYER_R, BUYER)).toMatchObject({ classification: "narrow", items: [{ kind: "rule_removed", path: "rules[r-1]" }] });
  });
  it("K-22：r-1 の free [quantity, unit_price] → [unit_price]、match に items[].quantity: [20] → narrow／rule_option_fixed", () => {
    const after = def((d) => ((d.rules[0].free = ["items[].unit_price"]), (d.rules[0].match["items[].quantity"] = [20])), BUYER_R);
    const r = cls(BUYER_R, after);
    expect(r.classification).toBe("narrow");
    expect(r.items).toEqual([
      { kind: "rule_option_fixed", class: "narrow", path: "rules[r-1].args[items[].quantity]", before: { state: "free" }, after: { state: "fixed", value: [20] } },
    ]);
  });
  it("free の option を「なし」で固定するのも narrow（FREE → ABSENT）", () => {
    expect(cls(BUYER_R, def((d) => (d.rules[0].free = ["items[].quantity"]), BUYER_R))).toMatchObject({ classification: "narrow", items: [{ kind: "rule_option_fixed" }] });
  });
  it("K-23：r-1 の items[].sku を free にする → widen／rule_option_freed", () => {
    const after = def((d) => {
      delete d.rules[0].match["items[].sku"];
      d.rules[0].free.push("items[].sku");
    }, BUYER_R);
    expect(cls(BUYER_R, after)).toMatchObject({ classification: "widen", items: [{ kind: "rule_option_freed", path: "rules[r-1].args[items[].sku]" }] });
  });
  it("K-24：r-1 の supplier_id を supplier-01 → supplier-02 → widen／rule_changed", () => {
    const r = cls(BUYER_R, def((d) => (d.rules[0].match.supplier_id = "supplier-02"), BUYER_R));
    expect(r).toMatchObject({ classification: "widen", items: [{ kind: "rule_changed", path: "rules[r-1].args[supplier_id]" }] });
  });
  it("固定 ↔ なし（宛先を外す・option を足す）も rule_changed（安全側に widen）。action の変更も rule_changed", () => {
    expect(cls(BUYER_R, def((d) => delete d.rules[0].match.supplier_id, BUYER_R))).toMatchObject({ classification: "widen", items: [{ kind: "rule_changed" }] });
    expect(cls(BUYER_R, def((d) => (d.rules[0].match.note = "x"), BUYER_R))).toMatchObject({ classification: "widen", items: [{ kind: "rule_changed" }] });
    expect(cls(BUYER_R, def((d) => (d.rules[0].action = "mcp.supplier.cancel_order"), BUYER_R))).toMatchObject({
      classification: "widen",
      items: [{ kind: "rule_changed", path: "rules[r-1].action" }],
    });
  });
  it("値は正規化して比べる（前後の空白・配列の順は同じ。M-09：重複の数は別）", () => {
    expect(cls(BUYER_R, def((d) => (d.rules[0].match.supplier_id = " supplier-01 "), BUYER_R)).items).toEqual([]);
    const two = def((d) => (d.rules[0].match["items[].sku"] = ["MILK", "BEAN"]), BUYER_R);
    expect(cls(two, def((d) => (d.rules[0].match["items[].sku"] = ["BEAN", "MILK"]), BUYER_R)).items).toEqual([]);
    expect(cls(BUYER_R, def((d) => (d.rules[0].match["items[].sku"] = ["BEAN", "BEAN"]), BUYER_R)).classification).toBe("widen");
  });
  it("K-25：r-1 の labels だけ変える → neutral（項目なし）。added_by・added_at・source_intent_id も同じ", () => {
    const after = def((d) => ((d.rules[0].labels = { supplier_id: "別の名前" }), (d.rules[0].added_at = "2026-10-04T09:00:00+09:00"), (d.rules[0].source_intent_id = "i-1")), BUYER_R);
    expect(cls(BUYER_R, after)).toMatchObject({ classification: "neutral", items: [] });
  });
  it("K-26：r-1 の tool_hash を新しいものに → widen／rule_rebound", () => {
    expect(cls(BUYER_R, def((d) => (d.rules[0].tool_hash = H("b")), BUYER_R))).toMatchObject({
      classification: "widen",
      items: [{ kind: "rule_rebound", path: "rules[r-1].tool_hash", before: H("a"), after: H("b") }],
    });
  });
  it("無効なルール（free に宛先）を有効にする変更は、引数ごとには narrow でも widen（何も許さない → 許す）", () => {
    const invalid = def((d) => (d.rules[0].free = ["supplier_id", "items[].quantity", "items[].unit_price"]), BUYER_R);
    const r = cls(invalid, BUYER_R);
    expect(r.classification).toBe("widen");
    expect(kinds(r)).toEqual(["rule_option_fixed", "rule_changed"]);
    // ツールの情報がない（前のルールが有効と分からない）ときも安全側に widen
    const noTools = { ...CTX, tools: {} };
    expect(cls(BUYER_R, def((d) => (d.rules[0].free = ["items[].unit_price"]), BUYER_R), noTools).classification).toBe("widen");
    // 有効なルールを締めるのは narrow のまま
    expect(cls(BUYER_R, def((d) => (d.rules[0].free = ["items[].unit_price"]), BUYER_R)).classification).toBe("narrow");
  });
  it("K-27〜K-30：ガード qty max 20 の追加 narrow・20 → 10 narrow・20 → 50 widen・削除 widen", () => {
    const g20 = withGuards([guard("items[].quantity", { max: 20 })]);
    expect(cls(BUYER, g20)).toMatchObject({ classification: "narrow", items: [{ kind: "guard_added", path: "jobs[reorder].guards[mcp.supplier.place_order|items[].quantity]", jobId: "reorder" }] });
    expect(cls(g20, withGuards([guard("items[].quantity", { max: 10 })]))).toMatchObject({ classification: "narrow", items: [{ kind: "guard_narrowed" }] });
    expect(cls(g20, withGuards([guard("items[].quantity", { max: 50 })]))).toMatchObject({ classification: "widen", items: [{ kind: "guard_widened" }] });
    expect(cls(g20, BUYER)).toMatchObject({ classification: "widen", items: [{ kind: "guard_removed" }] });
  });
  it("K-31・K-32：候補 sku in [A, B] → [A] は narrow、[A] → [A, B] は widen（BR-61 の「足す」：C-15）", () => {
    const sku = (c: string[]) => withGuards([guard("items[].sku", { in: c })]);
    expect(cls(sku(["A", "B"]), sku(["A"])).classification).toBe("narrow");
    expect(cls(sku(["A"]), sku(["A", "B"])).classification).toBe("widen");
  });
  it("K-33・K-34：{max 20} → {min 5, max 30} は widen、{max 20} → {min 5, max 20} は narrow", () => {
    const g = (c: object) => withGuards([guard("items[].quantity", c)]);
    expect(cls(g({ max: 20 }), g({ min: 5, max: 30 })).classification).toBe("widen");
    expect(cls(g({ max: 20 }), g({ min: 5, max: 20 })).classification).toBe("narrow");
  });
  it("K-35：同じ引数の max 20 と max 10（合成で 10）を max 10 の1つに → 項目なし（合成後が同じ）", () => {
    const r = cls(withGuards([guard("q", { max: 20 }), guard("q", { max: 10 })]), withGuards([guard("q", { max: 10 })]));
    expect(r).toMatchObject({ classification: "neutral", items: [] });
  });
  it("K-36：ガードを空（min > max）にする → narrow。空どうしは同じ、空から戻すのは widen", () => {
    const g20 = withGuards([guard("q", { max: 20 })]);
    const empty = withGuards([guard("q", { min: 30 }), guard("q", { max: 20 })]);
    expect(cls(g20, empty)).toMatchObject({ classification: "narrow", items: [{ kind: "guard_narrowed" }] });
    expect(cls(empty, withGuards([guard("q", { min: 50, max: 10 })])).items).toEqual([]);
    expect(cls(empty, g20).classification).toBe("widen");
  });
  it("数値のガードを候補のガードに替える（比べられない）→ widen", () => {
    expect(cls(withGuards([guard("x", { max: 5 })]), withGuards([guard("x", { in: ["a"] })])).classification).toBe("widen");
    expect(cls(withGuards([guard("x", { max: 20, max_digits: 5 })]), withGuards([guard("x", { max: 20 })])).classification).toBe("widen");
  });
  it("K-37：仕事の追加（assistant、付与は既存の範囲）→ neutral／job_added", () => {
    const r = cls(BUYER, def((d) => d.jobs.push({ id: "restock", kind: "recurring", template: "assistant", instructions: "x" })));
    expect(r).toMatchObject({ classification: "neutral", items: [{ kind: "job_added", path: "jobs[restock]", jobId: "restock", after: { template: "assistant" } }] });
  });
  it("K-38：仕事の追加で付与も足す → widen（grant_added）", () => {
    const r = cls(BUYER, def((d) => ((d.grants.connectors.mail = { grant: ["send"] }), d.jobs.push({ id: "notify-owner", kind: "once", template: "assistant", instructions: "x" }))));
    expect(r.classification).toBe("widen");
    expect(kinds(r)).toEqual(["grant_added", "job_added"]);
  });
  it("K-39：仕事の削除 → narrow／job_removed", () => {
    expect(cls(BUYER, def((d) => (d.jobs = [])))).toMatchObject({ classification: "narrow", items: [{ kind: "job_removed", jobId: "reorder" }] });
  });
  // 能力の旗（mcp.llmRead・llmWrite・deliverWrite）の false → true は widen（この段階の決定 (a)・BR-47 の趣旨。KC §8 #15 の代案を採る）
  const tpl = (template: string, base: AgentDefinitionInput = BUYER) => def((d) => (d.jobs[0].template = template), base);
  /** 読み取りのツールだけの付与（書き込みのツールがない） */
  const READ_ONLY = def((d) => (d.grants.connectors = { store: { grant: ["get_inventory"] }, supplier: { grant: ["list_products"] } }));
  const flagItem = (flag: string, jobId = "reorder"): ChangeItem => ({
    kind: "template_widened",
    class: "widen",
    path: `jobs[${jobId}].mcp.${flag}`,
    jobId,
    before: false,
    after: true,
  });
  it("K-40：researcher → assistant（書き込みの place_order は付与済み）→ widen／template_widened（mcp.llmWrite が false → true。決定 (a)）", () => {
    const r = cls(tpl("researcher"), BUYER);
    expect(r.classification).toBe("widen");
    expect(r.items).toEqual([
      { kind: "template_changed", class: "neutral", path: "jobs[reorder].template", jobId: "reorder", before: "researcher", after: "assistant" },
      flagItem("llmWrite"),
    ]);
    expect(r.widenItems).toEqual([flagItem("llmWrite")]);
  });
  it("K-40 反例：逆向き（assistant → researcher。LLM が書けなくなる）は neutral／template_changed のまま（表 13 に narrow はない：K-42 と同じ）", () => {
    expect(cls(BUYER, tpl("researcher"))).toMatchObject({ classification: "neutral", hasNarrow: false, items: [{ kind: "template_changed" }] });
    expect(cls(BUYER, tpl("researcher")).items).toHaveLength(1);
  });
  it("K-40 境界：付与に書き込みのツールがなければ llmWrite が true になっても使えないので neutral。付与がない（mcp_call が渡らない）ときも neutral", () => {
    expect(cls(tpl("researcher", READ_ONLY), READ_ONLY)).toMatchObject({ classification: "neutral", items: [{ kind: "template_changed" }] });
    const none = def((d) => (d.grants.connectors = {}));
    expect(cls(tpl("researcher", none), none)).toMatchObject({ classification: "neutral", items: [{ kind: "template_changed" }] });
  });
  it("K-40 安全側：ツールの分類が分からない付与（ctx にない・未接続）と unclassified の付与は書き込みとして数える → widen", () => {
    expect(cls(tpl("researcher", READ_ONLY), READ_ONLY, { ...CTX, tools: {} }).widenItems).toEqual([flagItem("llmWrite")]);
    const off = { ...CTX, tools: { ...TOOLS, supplier: { connected: false, tools: TOOLS.supplier!.tools } } };
    expect(cls(tpl("researcher", READ_ONLY), READ_ONLY, off).widenItems).toEqual([flagItem("llmWrite")]);
    const unclassified = { ...CTX, tools: { ...TOOLS, store: { connected: true, tools: { get_inventory: { ...read("1"), classification: "unclassified" as const } } } } };
    expect(cls(tpl("researcher", READ_ONLY), READ_ONLY, unclassified).widenItems).toEqual([flagItem("llmWrite")]);
  });
  it("K-41・K-42：researcher → briefer、briefer → watcher → neutral（ツール・deliverWrite が減る）", () => {
    expect(cls(tpl("researcher"), tpl("briefer"))).toMatchObject({ classification: "neutral", items: [{ kind: "template_changed" }] });
    expect(cls(tpl("briefer"), tpl("watcher"))).toMatchObject({ classification: "neutral", items: [{ kind: "template_changed" }] });
    expect(cls(tpl("briefer"), tpl("watcher")).items).toHaveLength(1);
  });
  it("K-43：watcher → researcher、Web の付与なし・書き込みのツールの付与なし → neutral（web_search は付与がないので使えない）", () => {
    expect(cls(tpl("watcher", READ_ONLY), tpl("researcher", READ_ONLY))).toMatchObject({ classification: "neutral", items: [{ kind: "template_changed" }] });
  });
  it("K-43 決定 (a)：書き込みのツールの付与があれば、watcher → researcher で届け先が書き込めるようになる（deliverWrite）→ widen", () => {
    const r = cls(tpl("watcher"), tpl("researcher"));
    expect(r.classification).toBe("widen");
    expect(r.widenItems).toEqual([flagItem("deliverWrite")]);
    // watcher → assistant は LLM と届け先の両方
    expect(cls(tpl("watcher"), BUYER).widenItems).toEqual([flagItem("llmWrite"), flagItem("deliverWrite")]);
  });
  it("K-43b：watcher → researcher と同時に grants.web を足す → widen（web_granted と template_widened）。書き込みの付与があれば deliverWrite も", () => {
    const r = cls(tpl("watcher", READ_ONLY), def((d) => ((d.jobs[0].template = "researcher"), (d.grants.web = { allow_domains: ["*"] })), READ_ONLY));
    expect(r.classification).toBe("widen");
    expect(kinds(r)).toEqual(["web_granted", "template_widened"]);
    const w = cls(tpl("watcher"), def((d) => ((d.jobs[0].template = "researcher"), (d.grants.web = { allow_domains: ["*"] }))));
    expect(w.widenItems.map((i) => [i.kind, i.path])).toEqual([
      ["web_granted", "grants.web.allow_domains"],
      ["template_widened", "jobs[reorder].template"],
      ["template_widened", "jobs[reorder].mcp.deliverWrite"],
    ]);
  });
  it("K-43c：新しいエージェント（付与なし）に付与を足して assistant の仕事を追加（編成の生成）→ widen（grant_added×付与の数、job_added、template_widened）", () => {
    const fresh = initialAgentDefinition({ name: "仕入れ係", workspacePolicy: WS, workspaceKind: "guest" });
    const after = def((d) => {
      d.grants.connectors = { supplier: { grant: ["list_products", "place_order"] }, store: { grant: ["get_inventory"] } };
      d.jobs = [{ id: "reorder", kind: "recurring", template: "assistant", instructions: "x" }];
    }, fresh);
    const r = cls(fresh, after);
    expect(r.classification).toBe("widen");
    expect(kinds(r)).toEqual(["grant_added", "grant_added", "grant_added", "job_added", "template_widened", "template_widened", "template_widened", "template_widened"]);
    // 仕事のテンプレート（付与していなかった mcp_call を使う）と、能力の旗3つ（前の定義に仕事がない＝エージェントにまだない能力）
    expect(r.widenItems.filter((i) => i.kind === "template_widened").map((i) => i.path)).toEqual([
      "jobs[reorder].template",
      "jobs[reorder].mcp.llmRead",
      "jobs[reorder].mcp.llmWrite",
      "jobs[reorder].mcp.deliverWrite",
    ]);
  });
  it("仕事の追加：前の定義のどれかの仕事に同じ能力があれば旗の項目は出ない（K-37）。なければ widen（消して別の id で足し直しても、すり抜けない）", () => {
    const researcherOnly = tpl("researcher");
    const addAssistant = def((d) => d.jobs.push({ id: "restock", kind: "recurring", template: "assistant", instructions: "x" }), researcherOnly);
    expect(cls(researcherOnly, addAssistant).widenItems).toEqual([flagItem("llmWrite", "restock")]);
    const replaced = def((d) => (d.jobs = [{ id: "reorder-2", kind: "recurring", template: "assistant", instructions: "x" }]), researcherOnly);
    const r = cls(researcherOnly, replaced);
    expect(r.classification).toBe("widen");
    expect(kinds(r)).toEqual(["job_removed", "job_added", "template_widened"]);
    expect(r.widenItems).toEqual([flagItem("llmWrite", "reorder-2")]);
    // researcher の仕事を足しても、前の assistant の仕事に能力があるので neutral
    expect(cls(BUYER, def((d) => d.jobs.push({ id: "watch", kind: "recurring", template: "researcher", instructions: "x" }))).classification).toBe("neutral");
  });
  it("llmRead の false → true も widen（読み取りのツールの付与があるときだけ。0-H のテンプレートにはない形なので、ctx.templates で試す）", () => {
    // mcp_call を持たず、LLM は MCP を読めない（mcpLlm: none）テンプレート
    const templates = { ...TEMPLATES, briefer: { ...TEMPLATES.briefer, tools: ["submit_report", "notify", "finish"] as const, mcpLlm: "none" as const } };
    const ctx = { ...CTX, templates };
    const r = cls(tpl("briefer", READ_ONLY), tpl("researcher", READ_ONLY), ctx);
    expect(r.classification).toBe("widen");
    expect(r.widenItems).toEqual([flagItem("llmRead")]);
    // 書き込みのツールだけの付与なら、LLM が読めるようになっても読めるものがない
    const writeOnly = def((d) => (d.grants.connectors = { supplier: { grant: ["place_order"] } }));
    expect(cls(tpl("briefer", writeOnly), tpl("researcher", writeOnly), ctx).widenItems).toEqual([]);
  });
  it("テンプレートを変える：researcher → assistant は widen、assistant → researcher は neutral", () => {
    expect(cls(tpl("researcher"), BUYER)).toMatchObject({ classification: "widen" });
    expect(cls(BUYER, tpl("researcher"))).toMatchObject({ classification: "neutral" });
  });
  it("K-44：届け先 notify を追加 → neutral／deliver_added_notify", () => {
    expect(cls(BUYER, def((d) => (d.jobs[0].deliver = [{ to: "notify" }])))).toMatchObject({ classification: "neutral", items: [{ kind: "deliver_added_notify", jobId: "reorder" }] });
  });
  const withMail = (f?: (d: any) => void) =>
    def((d) => {
      d.grants.connectors.mail = { grant: ["send"] };
      d.rules = [R_MAIL];
      f?.(d);
    });
  const sendTo = (to: string, body = "{{report.summary}}") => ({ to: SEND, args: { to }, content: { body } });
  it("K-45：届け先 mail.send {to: owner@example.com} を追加、同じ宛先のルールが前からある → neutral／deliver_added_matched", () => {
    expect(cls(withMail(), withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com")])))).toMatchObject({
      classification: "neutral",
      items: [{ kind: "deliver_added_matched", path: "jobs[reorder].deliver[mcp.mail.send]" }],
    });
  });
  it("K-46：同上でルールがない（宛先が違う）→ widen／deliver_added_unmatched", () => {
    expect(cls(withMail(), withMail((d) => (d.jobs[0].deliver = [sendTo("other@example.com")])))).toMatchObject({ classification: "widen", items: [{ kind: "deliver_added_unmatched" }] });
    expect(cls(def((d) => (d.grants.connectors.mail = { grant: ["send"] })), def((d) => ((d.grants.connectors.mail = { grant: ["send"] }), (d.jobs[0].deliver = [sendTo("owner@example.com")]))))).toMatchObject({
      classification: "widen",
      items: [{ kind: "deliver_added_unmatched" }],
    });
  });
  it("K-47：ルールはあるが ws の rules.enabled = false → widen", () => {
    const ctx = { ...CTX, workspacePolicy: { ...WS, rules: { enabled: false, max_per_agent: 20 } } };
    expect(cls(withMail(), withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com")])), ctx).classification).toBe("widen");
  });
  it("K-48：ルールを同じ変更案で足す → widen（rule_added と deliver_added_unmatched）", () => {
    const before = def((d) => (d.grants.connectors.mail = { grant: ["send"] }));
    const r = cls(before, withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com")])));
    expect(r.classification).toBe("widen");
    expect(kinds(r)).toEqual(["rule_added", "deliver_added_unmatched"]);
  });
  it("ツールの情報がない・needs_review・コネクタが無効なら一致しないとみなす（widen）", () => {
    const after = withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com")]));
    const ctx = (send: ToolInfo | undefined, connected = true): ClassifyContext => ({
      ...CTX,
      tools: { ...TOOLS, mail: { connected, tools: send === undefined ? {} : { send } } },
    });
    expect(cls(withMail(), after, ctx(undefined)).classification).toBe("widen");
    expect(cls(withMail(), after, ctx({ ...T_MS, status: "needs_review" })).classification).toBe("widen");
    expect(cls(withMail(), after, ctx({ ...T_MS, connectorEnabled: false })).classification).toBe("widen");
    expect(cls(withMail(), after, ctx(T_MS, false)).classification).toBe("widen");
    expect(cls(withMail(), after, ctx(T_MS)).classification).toBe("neutral");
  });
  it("K-49：届け先を消す → narrow／deliver_removed", () => {
    const before = withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com"), { to: "notify" }]));
    const r = cls(before, withMail((d) => (d.jobs[0].deliver = [{ to: "notify" }])));
    expect(r).toMatchObject({ classification: "narrow", items: [{ kind: "deliver_removed", before: { to: SEND, args: { to: "owner@example.com" } } }] });
  });
  it("K-50：届け先の content のテンプレートだけ変える → neutral／deliver_content_changed", () => {
    const r = cls(withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com")])), withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com", "{{report.body}}")])));
    expect(r).toMatchObject({ classification: "neutral", items: [{ kind: "deliver_content_changed" }] });
  });
  it("同じ届け先を2つにする（同じ鍵が増える）→ 追加として数える", () => {
    const one = withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com")]));
    const two = withMail((d) => (d.jobs[0].deliver = [sendTo("owner@example.com"), sendTo("owner@example.com")]));
    expect(kinds(cls(one, two))).toEqual(["deliver_added_matched"]);
    expect(kinds(cls(two, one))).toEqual(["deliver_removed"]);
  });
  it("K-51：ガード追加（narrow）＋指示の変更（neutral）→ neutral、hasNarrow = true", () => {
    const r = cls(BUYER, def((d) => ((d.jobs[0].guards = [guard("items[].quantity", { max: 20 })]), (d.jobs[0].instructions = "x"))));
    expect(r).toMatchObject({ classification: "neutral", hasNarrow: true, widenItems: [] });
  });
  it("K-52：ルール追加（widen）＋ガード追加（narrow）→ widen、widenItems は rule_added だけ", () => {
    const r = cls(BUYER, def((d) => (d.jobs[0].guards = [guard("items[].quantity", { max: 20 })]), BUYER_R));
    expect(r.classification).toBe("widen");
    expect(r.widenItems.map((i) => i.kind)).toEqual(["rule_added"]);
    expect(r.hasNarrow).toBe(true);
  });
  it("K-53：付与先のコネクタが ctx にない・未接続 → missing: connector_not_connected", () => {
    const { bank: _bank, ...rest } = TOOLS;
    expect(cls(BUYER, BUYER, { ...CTX, tools: rest }).missing).toEqual([{ kind: "connector_not_connected", connector: "bank" }]);
    expect(cls(BUYER, BUYER, { ...CTX, tools: { ...TOOLS, store: { connected: false, tools: {} } } }).missing).toEqual([{ kind: "connector_not_connected", connector: "store" }]);
  });
  it("K-54：付与したツールが unclassified → missing: tool_unclassified。ないツールは tool_not_found", () => {
    const tools = { ...TOOLS, supplier: { connected: true, tools: { place_order: { ...T_PO, classification: "unclassified" as const } } } };
    expect(cls(BUYER, BUYER, { ...CTX, tools }).missing).toEqual([
      { kind: "tool_not_found", connector: "supplier", tool: "list_products" },
      { kind: "tool_unclassified", connector: "supplier", tool: "place_order" },
    ]);
  });
  it("K-55：入力に ws は1つだけ（ws の変化は classify の対象外）。どの ws でも同じ定義なら項目なし", () => {
    for (const ws of [WS, defaultWorkspacePolicy("owner", EXAMPLE_CONNECTORS), { ...WS, autonomy: { ...WS.autonomy, mcp_read: "deny" as const } }]) {
      expect(cls(BUYER_R, BUYER_R, { ...CTX, workspacePolicy: ws }).items).toEqual([]);
    }
  });
  it("K-56：同じ入力で2回 → 同じ結果（決定論）", () => {
    const after = def((d) => ((d.jobs[0].guards = [guard("q", { max: 1 })]), (d.grants.connectors.mail = { grant: ["send"] }), (d.autonomy = { mcp_read: "approve" })), BUYER_R);
    expect(cls(BUYER, after)).toEqual(cls(BUYER, after));
  });
  it("入力を変えない。version 2 以外・仕事の id の重複は例外（判定できない定義）", () => {
    const after = def((d) => (d.jobs[0].guards = [guard("q", { in: [" b", "a"] })]), BUYER_R);
    const copy = structuredClone(after);
    cls(BUYER, after);
    expect(after).toEqual(copy);
    expect(() => cls(BUYER, { ...BUYER, version: 1 } as unknown as AgentDefinitionInput)).toThrow(TypeError);
    expect(() => cls(BUYER, def((d) => d.jobs.push({ ...d.jobs[0] })))).toThrow(TypeError);
  });
  it("K-57：before と after を入れ替えると narrow ⇔ widen（項目が対称な場合）", () => {
    const a = def((d) => {
      d.jobs[0].guards = [guard("items[].quantity", { max: 20 })];
      d.budget.per_task_usd = 0.3;
      d.grants.connectors.mail = { grant: ["list_inbox"] };
      d.autonomy = { mcp_read: "auto" };
    }, BUYER_R);
    const b = def((d) => {
      d.jobs[0].guards = [guard("items[].quantity", { max: 10 })];
      d.budget.per_task_usd = 0.1;
      d.autonomy = { mcp_read: "approve" };
      d.rules[0].free = ["items[].unit_price"];
    }, BUYER_R);
    const ab = cls(a, b);
    const ba = cls(b, a);
    expect(ab.classification).toBe("narrow");
    expect(ba.classification).toBe("widen");
    expect(ab.items.map((i) => i.class)).toEqual(ab.items.map(() => "narrow"));
    expect(ba.items.map((i) => i.class)).toEqual(ba.items.map(() => "widen"));
    expect(ab.items.map((i) => i.path).sort()).toEqual(ba.items.map((i) => i.path).sort());
  });
  it("Web のドメイン：絞る narrow・広げる widen・外す narrow（KC §8 #16）。同じ範囲の書き換えは項目なし", () => {
    const w = (allow: string[] | undefined) => def((d) => (allow === undefined ? delete d.grants.web : (d.grants.web = { allow_domains: allow })));
    expect(cls(w(["*"]), w(["*.example.com"]))).toMatchObject({ classification: "narrow", items: [{ kind: "domains_narrowed" }] });
    expect(cls(w(["*.example.com"]), w(["a.example.com", "b.c.example.com"])).classification).toBe("narrow");
    expect(cls(w(["*.example.com"]), w(["example.com"]))).toMatchObject({ classification: "widen", items: [{ kind: "domains_widened" }] });
    expect(cls(w(["a.com"]), w(["a.com", "b.com"])).classification).toBe("widen");
    expect(cls(w(["*"]), w(undefined))).toMatchObject({ classification: "narrow", items: [{ kind: "web_revoked" }] });
    expect(cls(w(["*"]), w([]))).toMatchObject({ classification: "narrow", items: [{ kind: "web_revoked" }] });
    expect(cls(w(["*", "a.com"]), w(["*"])).items).toEqual([]);
  });
  it("メモリ・承認者（Won't。表の 16・17）：無効にする・減らす narrow、有効にする・増やす widen", () => {
    expect(cls(BUYER, def((d) => (d.memory = { enabled: true, max_items: 10 })))).toMatchObject({ classification: "widen", items: [{ kind: "memory_changed" }] });
    expect(cls(def((d) => (d.memory = { enabled: true, max_items: 10 })), def((d) => (d.memory = { enabled: true, max_items: 5 }))).classification).toBe("narrow");
    expect(cls(def((d) => (d.memory = { enabled: true, max_items: 10 })), def((d) => (d.memory = { enabled: false, max_items: 10 }))).classification).toBe("narrow");
    const ctx = { ...CTX, workspacePolicy: { ...WS, approvers: ["u1", "u2"] } };
    expect(cls(BUYER, def((d) => (d.approvers = ["u1"])), ctx)).toMatchObject({ classification: "narrow", items: [{ kind: "approvers_changed" }] });
    expect(cls(def((d) => (d.approvers = ["u1"])), BUYER, ctx).classification).toBe("widen");
    expect(cls(BUYER, def((d) => (d.approvers = ["u1"]))).classification).toBe("widen"); // 空（BR-14 の既定）とは比べられない
  });
  it("実行回数の見込みが max_runs_per_day を超えたら runsWarning（Should。分類には入れない）", () => {
    const hourly = def((d) => (d.jobs[0].trigger = { type: "schedule", cron: "0 * * * *", timezone: "Asia/Tokyo" }));
    const r = cls(BUYER, hourly);
    expect(r.runsWarning).toEqual({ estimatedRunsPerDay: 24, maxRunsPerDay: 10 });
    expect(r.classification).toBe("neutral");
    expect(cls(BUYER, def((d) => (d.jobs[0].trigger = { type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" }))).runsWarning).toBeNull();
    const watch = def((d) => ((d.jobs[0].kind = "watch"), (d.jobs[0].trigger = { type: "watch", interval: "2h", targets: ["https://x"] })));
    expect(cls(BUYER, watch).runsWarning).toEqual({ estimatedRunsPerDay: 12, maxRunsPerDay: 10 });
    expect(cls(BUYER, def((d) => ((d.jobs[0].kind = "once"), (d.jobs[0].trigger = { type: "schedule", cron: "0 * * * *", timezone: "UTC" })))).runsWarning).toBeNull();
  });
  it("違反は after のものだけ（before の違反は数えない）", () => {
    const bad = def((d) => (d.budget.per_day_usd = 2));
    expect(cls(bad, BUYER).violations).toEqual([]);
    expect(cls(BUYER, bad).violations).toMatchObject([{ path: "budget.per_day_usd" }]);
  });
  it("同じ id のルールが2つ（スキーマが拒否するもの）でも取りこぼさない", () => {
    const dup = def((d) => d.rules.push({ ...R1, match: { supplier_id: "supplier-09", "items[].sku": ["BEAN"] } }), BUYER_R);
    expect(cls(BUYER_R, dup)).toMatchObject({ classification: "widen", items: [{ kind: "rule_added" }] });
  });
  it("分類と種類の表（CHANGE_KINDS・CHANGE_ORDER）", () => {
    expect(CHANGE_ORDER).toEqual({ narrow: 0, neutral: 1, widen: 2 });
    expect(new Set(CHANGE_KINDS).size).toBe(CHANGE_KINDS.length);
  });
});

// ---- 性質（PB-05・PB-07、narrow の変更は実効ポリシーを広げない） ----

const GUARD_POOL: Guard[] = [
  guard("items[].quantity", { max: 20 }),
  guard("items[].quantity", { max: 10 }),
  guard("items[].quantity", { min: 1 }),
  guard("items[].unit_price", { max: 800 }),
  guard("items[].sku", { in: ["A"] }),
  guard("items[].sku", { in: ["A", "B"] }),
];
const T_PO_RUSH: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, rush: "option" } };
const PTOOLS: ConnectorCatalog = { ...TOOLS, supplier: { connected: true, tools: { list_products: read("2"), place_order: T_PO_RUSH } } };
const ruleArb = fc.record({
  id: fc.constantFrom("r-1", "r-2"),
  supplier: fc.constantFrom("s1", "s2"),
  sku: fc.constantFrom("A", "AB", "free", "absent"),
  qty: fc.constantFrom("20", "free", "absent", "both"), // both は free と match の両方（無効なルール：match_bad_key）
  price: fc.constantFrom("700", "free", "absent"),
  rush: fc.constantFrom("free", "absent", "true"),
  dest: fc.constantFrom("fixed", "fixed", "free"), // free は無効なルール（free に宛先）
  hash: fc.constantFrom(H("a"), H("a"), H("b")), // H('b') は今のツールと違う（無効）
});
type RuleSpec = { id: string; supplier: string; sku: string; qty: string; price: string; rush: string; dest: string; hash: ToolHash };
function buildRule(r: RuleSpec) {
  const match: Record<string, unknown> = {};
  const free: string[] = [];
  const put = (path: string, state: string, value: unknown) => {
    if (state === "free") free.push(path);
    else if (state === "both") (match[path] = value), free.push(path);
    else if (state !== "absent") match[path] = value;
  };
  if (r.dest === "free") (match.supplier_id = r.supplier), free.push("supplier_id");
  else match.supplier_id = r.supplier;
  put("items[].sku", r.sku, r.sku === "A" ? ["A"] : ["A", "B"]);
  put("items[].quantity", r.qty, [20]);
  put("items[].unit_price", r.price, [700]);
  put("rush", r.rush, true);
  return { id: r.id, action: PO, match, free, tool_hash: r.hash, added_by: "u", added_at: "2026-10-03T00:00:00Z" };
}
// 書き込みが通り得る形（assistant・place_order の付与・approve）が多く出るように重みを付ける
const specArb = fc.record({
  mcpWrite: fc.constantFrom<"approve" | "handoff" | "deny" | undefined>(undefined, undefined, "approve", "handoff", "deny"),
  mcpRead: fc.constantFrom<"auto" | "approve" | "deny" | undefined>(undefined, "auto", "approve", "deny"),
  perTask: fc.constantFrom(undefined, 0.1, 0.2, 0.5),
  perDay: fc.constantFrom(undefined, 0.5, 1),
  runs: fc.constantFrom(5, 10, 20),
  grants: fc.subarray(["supplier.place_order", "supplier.list_products", "mail.send", "mail.list_inbox"], { minLength: 1 }).map((g) =>
    g.includes("supplier.place_order") || g.length > 2 ? g : [...g, "supplier.place_order"],
  ),
  web: fc.constantFrom<string[] | undefined>(undefined, ["*"], ["*.example.com"], ["a.example.com"]),
  template: fc.constantFrom("assistant", "assistant", "researcher", "briefer", "watcher"),
  rules: fc.uniqueArray(ruleArb, { selector: (r) => r.id, minLength: 1, maxLength: 2 }),
  guards: fc.subarray(GUARD_POOL, { maxLength: 2 }),
});
type Spec = (typeof specArb extends fc.Arbitrary<infer T> ? T : never) & Record<string, unknown>;
const SCALARS = ["mcpWrite", "mcpRead", "perTask", "perDay", "runs", "grants", "web", "template"] as const;
const RULE_FIELDS: Record<string, readonly unknown[]> = {
  supplier: ["s1", "s2"],
  sku: ["A", "AB", "free", "absent"],
  qty: ["20", "free", "absent", "both"],
  price: ["700", "free", "absent"],
  rush: ["free", "absent", "true"],
  dest: ["fixed", "free"],
  hash: [H("a"), H("b")],
};
/** before に小さな編集を1〜3個当てて after を作る（ルールの引数1つ・ガード1つ・項目1つの変更が出やすいように） */
const editArb = fc.oneof(
  { arbitrary: fc.record({ op: fc.constant("ruleArg" as const), idx: fc.nat(1), field: fc.constantFrom(...Object.keys(RULE_FIELDS)), pick: fc.nat(3) }), weight: 6 },
  { arbitrary: fc.record({ op: fc.constant("removeRule" as const), idx: fc.nat(1) }), weight: 1 },
  { arbitrary: fc.record({ op: fc.constant("addRule" as const), rule: ruleArb }), weight: 1 },
  { arbitrary: fc.record({ op: fc.constant("addGuard" as const), g: fc.constantFrom(...GUARD_POOL) }), weight: 2 },
  { arbitrary: fc.record({ op: fc.constant("removeGuard" as const), idx: fc.nat(2) }), weight: 1 },
  { arbitrary: fc.record({ op: fc.constant("scalar" as const), field: fc.constantFrom(...SCALARS) }), weight: 2 },
);
function buildDef(s: Spec): AgentDefinitionInput {
  const connectors: Record<string, { grant: string[] }> = {};
  for (const g of s.grants) {
    const [c, t] = g.split(".") as [string, string];
    (connectors[c] ??= { grant: [] }).grant.push(t);
  }
  const autonomy: Record<string, string> = {};
  if (s.mcpWrite !== undefined) autonomy.mcp_write = s.mcpWrite;
  if (s.mcpRead !== undefined) autonomy.mcp_read = s.mcpRead;
  const budget: Record<string, number> = {};
  if (s.perTask !== undefined) budget.per_task_usd = s.perTask;
  if (s.perDay !== undefined) budget.per_day_usd = s.perDay;
  return {
    version: 2,
    name: "x",
    grants: { ...(s.web === undefined ? {} : { web: { allow_domains: s.web } }), connectors },
    autonomy,
    budget,
    max_runs_per_day: s.runs,
    rules: (s.rules as RuleSpec[]).map(buildRule),
    jobs: [{ id: "reorder", kind: "recurring", template: s.template, instructions: "x", guards: s.guards }],
  } as AgentDefinitionInput;
}
const pairArb = fc.tuple(specArb, specArb, fc.array(editArb, { minLength: 1, maxLength: 2 })).map(([a, other, edits]) => {
  const after: Spec = structuredClone(a) as Spec;
  for (const e of edits) {
    const rules = after.rules as RuleSpec[];
    if (e.op === "ruleArg" && rules.length > 0) {
      const r = rules[e.idx % rules.length]!;
      const values = RULE_FIELDS[e.field]!;
      (r as Record<string, unknown>)[e.field] = values[e.pick % values.length];
    } else if (e.op === "removeRule" && rules.length > 0) rules.splice(e.idx % rules.length, 1);
    else if (e.op === "addRule" && !rules.some((r) => r.id === e.rule.id)) rules.push(e.rule);
    else if (e.op === "addGuard") after.guards = [...after.guards, e.g];
    else if (e.op === "removeGuard" && after.guards.length > 0) after.guards = after.guards.filter((_, i) => i !== e.idx % after.guards.length);
    else if (e.op === "scalar") (after as Record<string, unknown>)[e.field] = (other as Record<string, unknown>)[e.field];
  }
  return { before: buildDef(a as Spec), after: buildDef(after) };
});
const SUBJECT_ARGS: JsonObject[] = [];
for (const supplier_id of ["s1", "s2"]) {
  for (const skus of [["A"], ["A", "B"], ["A", "A"]]) {
    for (const quantity of [0, 10, 21]) {
      for (const unit_price of [700, 2400]) {
        for (const rush of [undefined, true]) {
          SUBJECT_ARGS.push({
            supplier_id,
            items: skus.map((sku) => ({ sku, quantity, unit_price })),
            note: "n",
            ...(rush === undefined ? {} : { rush }),
          });
        }
      }
    }
  }
}
const PCTX: ClassifyContext = { ...CTX, tools: PTOOLS };
const allowedCache = new Map<string, boolean[]>();
/** 手順4〜11（recheckIntent）で allow になる呼び出し。同じ実効ポリシーは使い回す */
const allowedSet = (e: EffectivePolicy, kind: Subject["kind"]): boolean[] => {
  const key = `${kind}:${effectivePolicyHash(e)}`;
  const hit = allowedCache.get(key);
  if (hit !== undefined) return hit;
  const out = SUBJECT_ARGS.map(
    (args) => recheckIntent(e, { ...poSubject(args, kind), tool: T_PO_RUSH }, { unknownOutcomeKeys: [] }).decision === "allow",
  );
  allowedCache.set(key, out);
  return out;
};
const composeJobs = (d: AgentDefinitionInput) => composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy: WS, agent: d }).jobs;

function domainContains(p: string, q: string): boolean {
  return p === "*" || p === q || (p.startsWith("*.") && q.endsWith(p.slice(1)));
}
/** a は b より広くない（KC §6.10 PB-07・NFR-056 の向き。ルール・ガードは判定で比べる） */
function expectNotWider(a: EffectivePolicy, b: EffectivePolicy): void {
  for (const op of OPERATION_TYPES) expect(AUTONOMY_STRICTNESS[a.autonomy[op]]).toBeGreaterThanOrEqual(AUTONOMY_STRICTNESS[b.autonomy[op]]);
  for (const k of ["per_task_usd", "per_day_usd", "max_steps", "max_minutes"] as const) expect(a.budget[k]).toBeLessThanOrEqual(b.budget[k]);
  if (b.budget.agent_day_usd !== null) expect(a.budget.agent_day_usd ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(b.budget.agent_day_usd);
  for (const k of ["same_action_repeat", "denied_attempts_max", "step_cost_usd_max"] as const) expect(a.breakers[k]).toBeLessThanOrEqual(b.breakers[k]);
  expect(a.max_runs_per_day).toBeLessThanOrEqual(b.max_runs_per_day);
  for (const t of a.tools) expect(b.tools).toContain(t);
  for (const k of ["llmRead", "llmWrite", "deliverWrite"] as const) if (a.mcp[k]) expect(b.mcp[k]).toBe(true);
  for (const [c, ts] of Object.entries(a.mcp.grants)) for (const t of ts) expect(b.mcp.grants[c] ?? []).toContain(t);
  for (const q of a.web.allow_domains) expect(b.web.allow_domains.some((p) => domainContains(p, q))).toBe(true);
  for (const kind of ["tool_call", "intent"] as const) {
    const allowA = allowedSet(a, kind);
    const allowB = allowedSet(b, kind);
    allowA.forEach((ok, i) => {
      if (ok) expect(allowB[i], JSON.stringify(SUBJECT_ARGS[i])).toBe(true);
    });
  }
}

describe("性質（fast-check）", () => {
  it("PB-05：classify(x, x) は neutral で項目なし", () => {
    fc.assert(
      fc.property(specArb, (s) => {
        const d = buildDef(s as Spec);
        const r = classify({ before: d, after: d, ctx: PCTX });
        expect(r.items).toEqual([]);
        expect(r.classification).toBe("neutral");
      }),
      { numRuns: 200 },
    );
  });
  it("narrow の変更を compose に通すと実効ポリシーは広がらない（どの項目も、ルール・ガードで allow になる呼び出しも）", () => {
    let checked = 0;
    fc.assert(
      fc.property(pairArb, ({ before, after }) => {
        const r = classify({ before, after, ctx: PCTX });
        if (r.classification !== "narrow") return;
        checked++;
        const jb = composeJobs(before);
        const ja = composeJobs(after);
        for (const id of Object.keys(ja)) {
          expect(jb[id]).toBeDefined(); // 仕事の追加は neutral なので、narrow なら新しい仕事はない
          expectNotWider(ja[id]!.effective, jb[id]!.effective);
        }
      }),
      { numRuns: 1500 },
    );
    expect(checked).toBeGreaterThan(20);
  }, 120_000);
  it("PB-07：widen の項目がない変更では、allow になる呼び出し（LLM の呼び出し・届け先）が増えない（テンプレートの変更も含む：決定 (a) で §8 #15 の代案を採った）", () => {
    let checked = 0;
    let templateChanged = 0;
    fc.assert(
      fc.property(pairArb, ({ before, after }) => {
        const r = classify({ before, after, ctx: PCTX });
        if (r.widenItems.length > 0) return;
        checked++;
        if (r.items.some((i) => i.kind === "template_changed")) templateChanged++;
        const jb = composeJobs(before);
        const ja = composeJobs(after);
        for (const id of Object.keys(ja)) {
          if (jb[id] === undefined) continue;
          for (const kind of ["tool_call", "intent"] as const) {
            const allowA = allowedSet(ja[id]!.effective, kind);
            const allowB = allowedSet(jb[id]!.effective, kind);
            allowA.forEach((ok, i) => {
              if (ok) expect(allowB[i], JSON.stringify(SUBJECT_ARGS[i])).toBe(true);
            });
          }
        }
      }),
      { numRuns: 1500 },
    );
    expect(checked).toBeGreaterThan(20);
    expect(templateChanged).toBeGreaterThan(0); // テンプレートの変更（neutral）も確かめた
  }, 120_000);
  it("テンプレートの変更で能力の旗が広がれば widen（決定 (a)）：researcher → assistant で llmWrite が true になり、LLM の書き込みが not_granted から通るようになる", () => {
    const r = cls(def((d) => (d.jobs[0].template = "researcher")), BUYER);
    expect(r.classification).toBe("widen");
    const before = compose({ ceilings: DEFAULT_CEILINGS, workspacePolicy: WS, agent: def((d) => (d.jobs[0].template = "researcher")) }, "reorder").effective;
    const after = compose({ ceilings: DEFAULT_CEILINGS, workspacePolicy: WS, agent: BUYER }, "reorder").effective;
    expect([before.mcp.llmWrite, after.mcp.llmWrite]).toEqual([false, true]);
    expect(decide(before, poSubject(order(20)), COUNTERS, FLAGS, EMPTY_TAINT)).toMatchObject({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.llmWrite" });
    expect(decide(after, poSubject(order(20)), COUNTERS, FLAGS, EMPTY_TAINT).decision).toBe("approve");
  });
  it("性質：classify は決定論で、items の分類の最大が全体の分類", () => {
    fc.assert(
      fc.property(pairArb, ({ before, after }) => {
        const r = classify({ before, after, ctx: PCTX });
        expect(classify({ before, after, ctx: PCTX })).toEqual(r);
        const max = r.items.reduce((m, i: ChangeItem) => Math.max(m, CHANGE_ORDER[i.class]), r.items.length === 0 ? 1 : 0);
        expect(CHANGE_ORDER[r.classification]).toBe(max);
        expect(r.widenItems).toEqual(r.items.filter((i) => i.class === "widen"));
        expect(r.hasNarrow).toBe(r.items.some((i) => i.class === "narrow"));
      }),
      { numRuns: 200 },
    );
  });
});

describe("SG-09：ルールの出どころの記録は照合・ガード・classify・policy_hash に効かない", () => {
  const PROV = { source_intent_id: "11111111-1111-4111-8111-111111111111", created_while_tainted: true };
  const R1P = { ...R1, ...PROV };
  const BUYER_RP = def((d) => (d.rules = [R1P]));
  const BUYER_RP_CLEAN = def((d) => (d.rules = [{ ...R1P, created_while_tainted: false }]));
  const BUYER_RP_GUARD = def((d) => {
    d.rules = [R1P];
    d.jobs[0].guards = [guard("items[].quantity", { max: 20 })];
  });
  const BUYER_R_GUARD = def((d) => {
    d.rules = [R1];
    d.jobs[0].guards = [guard("items[].quantity", { max: 20 })];
  });

  it("担当の定義のスキーマは記録つきのルールも、記録のないルールも受ける。正規化で記録は残る", () => {
    const a = validateAgentDefinition(BUYER_RP, { tools: TOOLS });
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.definition.rules[0]).toMatchObject(PROV);
    const legacy = validateAgentDefinition(BUYER_R, { tools: TOOLS });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(legacy.definition.rules[0]).not.toHaveProperty("created_while_tainted");
  });
  it("記録の型が違う・知らないキーは今までどおり拒否する", () => {
    expect(validateAgentDefinition(def((d) => (d.rules = [{ ...R1, created_while_tainted: "yes" }])), { tools: TOOLS }).ok).toBe(false);
    expect(validateAgentDefinition(def((d) => (d.rules = [{ ...R1, last_matched_at: "2026-10-03T18:00:00+09:00" }])), { tools: TOOLS }).ok).toBe(false);
  });
  it("ルールの id は 1〜128 文字（policy_decisions.matched_rule_id の CHECK と同じ）", () => {
    const withId = (id: string) => validateAgentDefinition(def((d) => (d.rules = [{ ...R1, id }])), { tools: TOOLS }).ok;
    expect(withId(`r-${"a".repeat(126)}`)).toBe(true);
    expect(withId(`r-${"a".repeat(127)}`)).toBe(false);
    expect(withId("")).toBe(false);
  });
  it("実効ポリシーと policy_hash は記録の有無・値で変わらない", () => {
    const withProv = composeJobs(BUYER_RP).reorder!;
    const legacy = composeJobs(BUYER_R).reorder!;
    const clean = composeJobs(BUYER_RP_CLEAN).reorder!;
    expect(withProv.effective).toEqual(legacy.effective);
    expect(withProv.effectivePolicyHash).toBe(legacy.effectivePolicyHash);
    expect(clean.effectivePolicyHash).toBe(legacy.effectivePolicyHash);
    expect(withProv.effective.rules.items[0]).toEqual({ id: R1.id, action: R1.action, match: R1.match, free: R1.free, tool_hash: R1.tool_hash });
  });
  it("記録だけの違い（足す・消す・汚染の印を変える）は項目なし（neutral）。widen と誤判定しない", () => {
    for (const [b, a] of [
      [BUYER_R, BUYER_RP],
      [BUYER_RP, BUYER_R],
      [BUYER_RP, BUYER_RP_CLEAN],
      [BUYER_RP_CLEAN, BUYER_RP],
    ] as const) {
      expect(cls(b, a)).toMatchObject({ classification: "neutral", items: [], widenItems: [], violations: [] });
    }
  });
  it("記録つきのルールを足す・取り消す・ガードを足すときの分類は記録のないルールと同じ", () => {
    expect(cls(BUYER, BUYER_RP)).toEqual(cls(BUYER, BUYER_R));
    expect(cls(BUYER_RP, BUYER)).toEqual(cls(BUYER_R, BUYER));
    expect(cls(BUYER_RP, BUYER_RP_GUARD)).toEqual(cls(BUYER_R, BUYER_R_GUARD));
  });
  it("照合・ガードの判定は記録の有無で同じ（decide の結果も同じ）", () => {
    const pA = composeJobs(BUYER_RP_GUARD).reorder!.effective;
    const pB = composeJobs(BUYER_R_GUARD).reorder!.effective;
    const cases: JsonObject[] = [
      { supplier_id: "supplier-01", items: [{ sku: "BEAN", quantity: 5, unit_price: 780 }], note: "x" },
      { supplier_id: "supplier-01", items: [{ sku: "BEAN", quantity: 50, unit_price: 780 }], note: "x" },
      { supplier_id: "supplier-02", items: [{ sku: "BEAN", quantity: 5, unit_price: 780 }], note: "x" },
    ];
    const reasons = cases.map((args) => {
      const a = decide(pA, poSubject(args), COUNTERS, FLAGS, EMPTY_TAINT);
      expect(a).toEqual(decide(pB, poSubject(args), COUNTERS, FLAGS, EMPTY_TAINT));
      return a.reasonCode;
    });
    expect(reasons).toEqual(["rule_matched", "guard_exceeded", "approval_required"]);
    expect(decide(pA, poSubject(cases[0]!), COUNTERS, FLAGS, EMPTY_TAINT).matchedRuleId).toBe("r-1");
  });
});

