import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decide, nextCounters, recheckIntent } from "./decide.ts";
import { firstGuardViolation, mergeGuards } from "./guards.ts";
import { computeInputsHash, destinationKey, repeatKeyOf } from "./hashes.ts";
import { operationOf } from "./operations.ts";
import { findMatchingRule } from "./rules.ts";
import type {
  AutonomyLevel,
  Counters,
  DecideResult,
  EffectivePolicy,
  EffectiveRule,
  Flags,
  JsonObject,
  MergedGuard,
  OperationType,
  Subject,
  TaintState,
  TaskStatus,
  ToolHash,
  ToolInfo,
} from "./types.ts";
import { CATALOG_TOOLS, OPERATION_TYPES } from "./types.ts";

// ---- フィクスチャ（KD §6.1 を M-01 の実効ポリシーの形に直したもの） ----

type W<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] extends object ? W<T[K]> : T[K] };

const PO = "mcp.supplier.place_order";
const H_PO: ToolHash = `sha256:${"a".repeat(64)}`;
const T_PO: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: H_PO,
  argRoles: {
    supplier_id: "destination",
    "items[].sku": "option",
    "items[].quantity": "option",
    "items[].unit_price": "option",
    note: "content",
  },
};
const T_INV: ToolInfo = { classification: "read", status: "ok", connectorEnabled: true, scope: null, toolHash: `sha256:${"b".repeat(64)}`, argRoles: {} };
const T_MS: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: `sha256:${"c".repeat(64)}`,
  argRoles: { to: "destination", body: "content" },
};
const T_BP: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: `sha256:${"d".repeat(64)}`,
  argRoles: { account: "destination" },
};
const R0: EffectiveRule = {
  id: "r-91c2",
  action: PO,
  tool_hash: H_PO,
  match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE"] },
  free: ["items[].quantity", "items[].unit_price"],
};
const R_MAIL: EffectiveRule = { id: "r-mail", action: "mcp.mail.send", tool_hash: T_MS.toolHash, match: { to: "owner@example.com" }, free: [] };
const R_BANK: EffectiveRule = { id: "r-bank", action: "mcp.bank.register_payee", tool_hash: T_BP.toolHash, match: { account: "ACC-LEGIT" }, free: [] };
const G0: MergedGuard = { action: PO, arg: "items[].quantity", max: 20, empty: false };
const G1: MergedGuard = { action: PO, arg: "items[].unit_price", max: 800, empty: false };
const ALL_DENY = Object.fromEntries(OPERATION_TYPES.map((op) => [op, "deny"])) as Record<OperationType, AutonomyLevel>;
const AUTONOMY: Record<OperationType, AutonomyLevel> = { ...ALL_DENY, mcp_read: "auto", mcp_write: "approve", notify: "auto", web_read: "deny" };
const P0: EffectivePolicy = {
  version: 1,
  autonomy: AUTONOMY,
  budget: { per_task_usd: 0.2, per_day_usd: 1, agent_day_usd: 1, max_steps: 40, max_minutes: 15 },
  breakers: { same_action_repeat: 5, denied_attempts_max: 3, step_cost_usd_max: 0.5 },
  max_intents_per_task: 5,
  max_runs_per_day: 10,
  tools: ["mcp_call", "notify", "submit_report", "finish"],
  mcp: {
    llmRead: true,
    llmWrite: true,
    deliverWrite: true,
    grants: { store: ["get_inventory"], supplier: ["list_products", "place_order"], mail: ["send"], bank: ["register_payee"] },
  },
  web: { allow_domains: [], deny_domains: [], max_fetches_per_task: 0 },
  rules: { enabled: true, items: [R0] },
  guards: [G0, G1],
  approvers: [],
};
const policy = (f?: (p: W<EffectivePolicy>) => void): EffectivePolicy => {
  const p = structuredClone(P0) as W<EffectivePolicy>;
  f?.(p);
  return p as EffectivePolicy;
};
const item = (quantity: number | string = 20, unit_price: number = 800, sku = "BEAN-HOUSE") => ({ sku, quantity, unit_price });
const A0: JsonObject = { supplier_id: "supplier-01", items: [item()], note: "いつもの" };
const poArgs = (over: JsonObject = {}): JsonObject => ({ ...A0, ...over });
const S_PO = (args: JsonObject = A0, over: Partial<Subject> = {}): Subject => ({
  kind: "tool_call",
  actionType: "mcp_call",
  action: PO,
  args,
  paths: [],
  tool: T_PO,
  origin: "agent",
  ...over,
});
const S_INV: Subject = {
  kind: "tool_call",
  actionType: "mcp_call",
  action: "mcp.store.get_inventory",
  args: {},
  paths: [],
  tool: T_INV,
  origin: "agent",
};
const S_MS = (to = "owner@example.com", over: Partial<Subject> = {}): Subject => ({
  kind: "tool_call",
  actionType: "mcp_call",
  action: "mcp.mail.send",
  args: { to, body: "…" },
  paths: [],
  tool: T_MS,
  origin: "agent",
  ...over,
});
const S_BP = (account: string, over: Partial<Subject> = {}): Subject => ({
  kind: "tool_call",
  actionType: "mcp_call",
  action: "mcp.bank.register_payee",
  args: { account },
  paths: [],
  tool: T_BP,
  origin: "agent",
  ...over,
});
const L = (est: number): Subject => ({ kind: "llm_call", actionType: null, args: {}, paths: [], estimatedCostUsd: est });
const T = (actionType: string, over: Partial<Subject> = {}): Subject => ({
  kind: "tool_call",
  actionType: actionType as Subject["actionType"],
  args: {},
  paths: [],
  ...over,
});
const C0: Counters = {
  stepsUsed: 3,
  costUsd: 0.05,
  dayCostUsd: 0.2,
  agentDayCostUsd: 0.1,
  elapsedSec: 60,
  deniedCount: 0,
  repeatKey: null,
  repeatCount: 0,
  intentsCount: 0,
  unknownOutcomeKeys: [],
};
const F0: Flags = { killSwitchEngaged: false, taskStatus: "running", certificateValid: true };
const X0: TaintState = { tainted: false, sources: [] };
const DK01 = "2366fc5baa1285be13d0ae6278b43f6d9ef3f56a6391abae7be184e7e409b40e";
const HEX64 = /^[0-9a-f]{64}$/;
const TERMINAL: TaskStatus[] = ["succeeded", "completed", "rejected", "failed", "cancelled", "halted"];

const run = (o: { p?: EffectivePolicy; s?: Subject; c?: Partial<Counters>; f?: Partial<Flags>; x?: TaintState } = {}) =>
  decide(o.p ?? P0, o.s ?? S_PO(), { ...C0, ...o.c }, { ...F0, ...o.f }, o.x ?? X0);
const brief = (r: DecideResult) => [r.decision, r.reasonCode, r.matchedRule];
const ALLOW_RULE0 = ["allow", "rule_matched", "rules.items[0]"];
const APPROVAL = ["approve", "approval_required", "autonomy.mcp_write"];

describe("decide：基準（KD §6.1）", () => {
  it("decide(P0, S_PO(), C0, F0, X0) → allow / rule_matched / rules.items[0]（cross-check §4.2 のパス）", () => {
    const r = run();
    expect(r).toEqual({
      decision: "allow",
      reasonCode: "rule_matched",
      matchedRule: "rules.items[0]",
      matchedRuleId: "r-91c2",
      inputsHash: expect.stringMatching(HEX64),
      operation: "mcp_write",
    });
  });
  it("J3 の前提：destinationKey(place_order, A0) は DK01", () => {
    expect(destinationKey(PO, A0, T_PO.argRoles)).toBe(DK01);
  });
});

describe("decide：手順1 停止（KD §6.2）", () => {
  it("H1：Kill Switch → halt / kill_switch / null", () => {
    const r = run({ f: { killSwitchEngaged: true } });
    expect(brief(r)).toEqual(["halt", "kill_switch", null]);
    expect(r.detail).toBeUndefined();
  });
  it("H2：終了状態のそれぞれ → halt / task_terminated", () => {
    for (const taskStatus of TERMINAL) expect(brief(run({ f: { taskStatus } })), taskStatus).toEqual(["halt", "task_terminated", null]);
  });
  it("H3：awaiting_approval・executing は通過", () => {
    expect(brief(run({ f: { taskStatus: "awaiting_approval" } }))).toEqual(ALLOW_RULE0);
    expect(brief(run({ f: { taskStatus: "executing" } }))).toEqual(ALLOW_RULE0);
  });
  it("H4：Kill Switch ＋ failed → kill_switch が先", () => {
    expect(brief(run({ f: { killSwitchEngaged: true, taskStatus: "failed" } }))).toEqual(["halt", "kill_switch", null]);
  });
  it("H5：Kill Switch ＋ カタログにない actionType → halt（halt が deny より先）", () => {
    expect(brief(run({ s: T("rm_rf"), f: { killSwitchEngaged: true } }))).toEqual(["halt", "kill_switch", null]);
  });
});

describe("decide：手順2 予算（KD §6.2、M-19）", () => {
  it("B1：L(0.01)、stepsUsed 39（max 40）→ allow / not_gated", () => {
    const r = run({ s: L(0.01), c: { stepsUsed: 39 } });
    expect(brief(r)).toEqual(["allow", "not_gated", null]);
    expect(r.operation).toBeNull();
  });
  it("B2：stepsUsed 40 → halt / budget.max_steps", () => {
    const r = run({ s: L(0.01), c: { stepsUsed: 40 } });
    expect(brief(r)).toEqual(["halt", "budget_exceeded", "budget.max_steps"]);
    expect(r.detail).toEqual({ kind: "budget", item: "max_steps", used: 40, adding: 1, limit: 40 });
  });
  it("B3：tool_call は手順を数えない（KD §8-4）", () => {
    expect(brief(run({ c: { stepsUsed: 40 } }))).toEqual(ALLOW_RULE0);
  });
  it("B4：L(0.15)、costUsd 0.05（per_task 0.2）→ allow（ちょうどは超えない）", () => {
    expect(brief(run({ s: L(0.15) }))).toEqual(["allow", "not_gated", null]);
  });
  it("B5：L(0.150001) → halt / budget.per_task_usd", () => {
    const r = run({ s: L(0.150001) });
    expect(brief(r)).toEqual(["halt", "budget_exceeded", "budget.per_task_usd"]);
    expect(r.detail).toEqual({ kind: "budget", item: "per_task_usd", used: 0.05, adding: 0.150001, limit: 0.2 });
  });
  it("B6：per_task 0.3、costUsd 0.1、L(0.2) → allow（マイクロドルで比べる）", () => {
    const p = policy((x) => {
      x.budget.per_task_usd = 0.3;
    });
    expect(0.1 + 0.2 > 0.3).toBe(true);
    expect(brief(run({ p, s: L(0.2), c: { costUsd: 0.1 } }))).toEqual(["allow", "not_gated", null]);
  });
  it("B7：dayCostUsd 0.99 → allow、0.995 → halt / budget.per_day_usd", () => {
    expect(brief(run({ s: L(0.01), c: { dayCostUsd: 0.99 } }))).toEqual(["allow", "not_gated", null]);
    expect(brief(run({ s: L(0.01), c: { dayCostUsd: 0.995 } }))).toEqual(["halt", "budget_exceeded", "budget.per_day_usd"]);
  });
  it("B8：agent_day_usd が null ならエージェントの日次では止まらない", () => {
    const p = policy((x) => {
      x.budget.agent_day_usd = null;
    });
    expect(brief(run({ p, c: { agentDayCostUsd: 100 } }))).toEqual(ALLOW_RULE0);
    expect(brief(run({ p, s: L(0.01), c: { agentDayCostUsd: 100 } }))).toEqual(["allow", "not_gated", null]);
  });
  it("B9：agent_day 1、agentDayCostUsd 0.995、L(0.01)、per_day 3 → halt / budget.agent_day_usd", () => {
    const p = policy((x) => {
      x.budget.per_day_usd = 3;
    });
    const r = run({ p, s: L(0.01), c: { agentDayCostUsd: 0.995 } });
    expect(brief(r)).toEqual(["halt", "budget_exceeded", "budget.agent_day_usd"]);
    expect(r.detail).toMatchObject({ item: "agent_day_usd", used: 0.995, adding: 0.01, limit: 1 });
  });
  it("B10：elapsedSec 900 → allow、901 → halt / budget.max_minutes（tool_call でも。単位は秒）", () => {
    expect(brief(run({ c: { elapsedSec: 900 } }))).toEqual(ALLOW_RULE0);
    const r = run({ c: { elapsedSec: 901 } });
    expect(brief(r)).toEqual(["halt", "budget_exceeded", "budget.max_minutes"]);
    expect(r.detail).toEqual({ kind: "budget", item: "max_minutes", used: 901, adding: 0, limit: 900 });
  });
  it("B11：max_steps と per_task が両方超えたら項目の順で max_steps", () => {
    expect(brief(run({ s: L(0.01), c: { stepsUsed: 40, costUsd: 0.3 } }))).toEqual(["halt", "budget_exceeded", "budget.max_steps"]);
  });
  it("B12：tool_call でも既に超えていれば止まる（ちょうどは通す）", () => {
    expect(brief(run({ c: { costUsd: 0.2 } }))).toEqual(ALLOW_RULE0);
    expect(brief(run({ c: { costUsd: 0.200001 } }))).toEqual(["halt", "budget_exceeded", "budget.per_task_usd"]);
  });
  it("B13 は M-19 で変更：全体 $10・リハーサル $0.5 は decide の外。余計な項目を渡しても判定も inputsHash も変わらない", () => {
    const p = { ...P0, budget: { ...P0.budget, per_rehearsal_usd: 0.5, platform_day_usd: 10 } } as EffectivePolicy;
    const c = { ...C0, rehearsalCostUsd: 0.49, platformDayCostUsd: 9.99 } as Counters;
    const a = decide(p, L(0.02), c, F0, X0);
    const b = decide(P0, L(0.02), C0, F0, X0);
    expect(brief(a)).toEqual(["allow", "not_gated", null]);
    expect(a).toEqual(b);
  });
  it("負の見積もりで予算をすり抜けない", () => {
    expect(brief(run({ s: L(-5), c: { costUsd: 0.3 } }))).toEqual(["halt", "budget_exceeded", "budget.per_task_usd"]);
  });
});

describe("decide：手順3 Breaker（KD §6.2）", () => {
  const k = repeatKeyOf(S_INV);
  it("K1：同じ呼び出しで repeatCount 3 → allow（3+1 < 5）", () => {
    expect(brief(run({ s: S_INV, c: { repeatKey: k, repeatCount: 3 } }))).toEqual(["allow", "autonomy_auto", "autonomy.mcp_read"]);
  });
  it("K2：repeatCount 4 → halt / breakers.same_action_repeat（以上で止まる）", () => {
    const r = run({ s: S_INV, c: { repeatKey: k, repeatCount: 4 } });
    expect(brief(r)).toEqual(["halt", "breaker_tripped", "breakers.same_action_repeat"]);
    expect(r.detail).toEqual({ kind: "breaker", breaker: "same_action_repeat", value: 5, threshold: 5 });
  });
  it("K3：直前と違うキーなら repeatCount 99 でも allow", () => {
    expect(run({ s: S_INV, c: { repeatKey: "f".repeat(64), repeatCount: 99 } }).decision).toBe("allow");
  });
  it("K4：引数のキーの順だけ違っても同じキー → halt", () => {
    const a = { ...S_INV, args: { a: 1, b: 2 } };
    const b = { ...S_INV, args: { b: 2, a: 1 } };
    expect(brief(run({ s: b, c: { repeatKey: repeatKeyOf(a), repeatCount: 4 } }))).toEqual(["halt", "breaker_tripped", "breakers.same_action_repeat"]);
  });
  it("K5：deniedCount 2 は通過、3 → halt / breakers.denied_attempts_max（llm_call でも）", () => {
    expect(run({ c: { deniedCount: 2 } }).decision).toBe("allow");
    const r = run({ c: { deniedCount: 3 } });
    expect(brief(r)).toEqual(["halt", "breaker_tripped", "breakers.denied_attempts_max"]);
    expect(r.detail).toEqual({ kind: "breaker", breaker: "denied_attempts_max", value: 3, threshold: 3 });
    expect(brief(run({ s: L(0.01), c: { deniedCount: 3 } }))).toEqual(["halt", "breaker_tripped", "breakers.denied_attempts_max"]);
  });
  it("K6：per_task 2、L(0.5) → allow、L(0.500001) → halt / breakers.step_cost_usd_max", () => {
    const p = policy((x) => {
      x.budget.per_task_usd = 2;
    });
    expect(brief(run({ p, s: L(0.5) }))).toEqual(["allow", "not_gated", null]);
    const r = run({ p, s: L(0.500001) });
    expect(brief(r)).toEqual(["halt", "breaker_tripped", "breakers.step_cost_usd_max"]);
    expect(r.detail).toEqual({ kind: "breaker", breaker: "step_cost_usd_max", value: 0.500001, threshold: 0.5 });
  });
  it("K7：K2 ＋ deniedCount 3 → same_action_repeat（Breaker の順）", () => {
    expect(run({ s: S_INV, c: { repeatKey: k, repeatCount: 4, deniedCount: 3 } }).matchedRule).toBe("breakers.same_action_repeat");
  });
  it("K8：same_action_repeat は llm_call に効かない", () => {
    expect(brief(run({ s: L(0.01), c: { repeatKey: repeatKeyOf(L(0.01)), repeatCount: 99 } }))).toEqual(["allow", "not_gated", null]);
  });
});

describe("decide：手順4 操作の分類（KD §6.3、M-01・M-14）", () => {
  it("D1：カタログにない actionType → deny / unknown_action / null", () => {
    const r = run({ s: T("rm_rf") });
    expect(brief(r)).toEqual(["deny", "unknown_action", null]);
    expect(r.operation).toBeNull();
  });
  it("D2：テンプレート外（tools にない web_fetch）→ deny / not_granted / tools", () => {
    const r = run({ s: T("web_fetch", { args: { url: "https://example.com" } }) });
    expect(brief(r)).toEqual(["deny", "not_granted", "tools"]);
    expect(r.detail).toEqual({ kind: "not_granted", what: "tools" });
    expect(r.operation).toBe("web_read");
  });
  it("D3：付与のないコネクタ → deny / not_granted / mcp.grants.crm", () => {
    const r = run({ s: S_MS("a", { action: "mcp.crm.update" }) });
    expect(brief(r)).toEqual(["deny", "not_granted", "mcp.grants.crm"]);
    expect(r.detail).toEqual({ kind: "not_granted", what: "grants" });
  });
  it("D4：付与にないツール → deny / not_granted / mcp.grants.supplier", () => {
    expect(brief(run({ s: S_PO(A0, { action: "mcp.supplier.cancel_order" }) }))).toEqual(["deny", "not_granted", "mcp.grants.supplier"]);
  });
  it("D5：読み取りだけのテンプレート（llmWrite: false）の LLM が書き込みを呼ぶ → deny / not_granted / mcp.llmWrite", () => {
    const p = policy((x) => {
      x.mcp.llmWrite = false;
      x.mcp.grants = { mail: ["list_inbox", "send"] };
    });
    const r = run({ p, s: S_MS() });
    expect(brief(r)).toEqual(["deny", "not_granted", "mcp.llmWrite"]);
    expect(r.detail).toEqual({ kind: "not_granted", what: "llm_write" });
  });
  it("D6：mcp_call で tool がない → deny / unknown_action", () => {
    expect(brief(run({ s: { ...S_PO(), tool: undefined } }))).toEqual(["deny", "unknown_action", null]);
  });
  it("D7：finish → allow / not_gated（テンプレート・自律を見ない）", () => {
    const p = policy((x) => {
      x.tools = [];
      x.autonomy = { ...ALL_DENY };
    });
    const r = run({ p, s: T("finish") });
    expect(brief(r)).toEqual(["allow", "not_gated", null]);
    expect(r.operation).toBeNull();
  });
  it("D8：submit_report → allow / autonomy_auto / autonomy.notify", () => {
    const r = run({ s: T("submit_report", { args: { title: "t" } }) });
    expect(brief(r)).toEqual(["allow", "autonomy_auto", "autonomy.notify"]);
    expect(r.operation).toBe("notify");
  });
  it("D9（M-14）：researcher の届け先（intent）の書き込みは通り、同じものを LLM が呼ぶと not_granted", () => {
    const researcher = policy((x) => {
      x.tools = ["mcp_call", "submit_report", "notify", "finish"];
      x.mcp = { llmRead: true, llmWrite: false, deliverWrite: true, grants: { mail: ["send"] } };
      x.rules.items = [];
    });
    expect(brief(run({ p: researcher, s: S_MS("owner@example.com", { kind: "intent", origin: "deliver" }) }))).toEqual(APPROVAL);
    const withRule = { ...researcher, rules: { enabled: true, items: [R_MAIL] } };
    expect(brief(run({ p: withRule, s: S_MS("owner@example.com", { kind: "intent", origin: "deliver" }) }))).toEqual(ALLOW_RULE0);
    expect(brief(run({ p: researcher, s: S_MS("owner@example.com", { kind: "tool_call", origin: "deliver" }) }))).toEqual([
      "deny",
      "not_granted",
      "mcp.llmWrite",
    ]);
  });
  it("D10（M-01）：watcher は llmWrite・deliverWrite がどちらも false → kind によらず not_granted", () => {
    const watcher = policy((x) => {
      x.mcp = { llmRead: true, llmWrite: false, deliverWrite: false, grants: { mail: ["send"] } };
    });
    const r = run({ p: watcher, s: S_MS("owner@example.com", { kind: "intent", origin: "deliver" }) });
    expect(brief(r)).toEqual(["deny", "not_granted", "mcp.deliverWrite"]);
    expect(r.detail).toEqual({ kind: "not_granted", what: "deliver_write" });
    expect(brief(run({ p: watcher, s: S_MS() }))).toEqual(["deny", "not_granted", "mcp.llmWrite"]);
  });
  it("D11：intent になれない actionType（web_fetch）→ deny / unknown_action", () => {
    expect(brief(run({ s: T("web_fetch", { kind: "intent" }) }))).toEqual(["deny", "unknown_action", null]);
  });
  it("action が 'mcp.<connector>.<tool>' の形でない → deny / unknown_action", () => {
    for (const action of ["supplier.place_order", "mcp.supplier", "mcp..place_order", "mcp.supplier.", undefined]) {
      expect(brief(run({ s: S_PO(A0, { action }) })), String(action)).toEqual(["deny", "unknown_action", null]);
    }
  });
  it("付与の表の継承したキー（constructor・__proto__）で例外にならず not_granted", () => {
    expect(brief(run({ s: S_PO(A0, { action: "mcp.constructor.x" }) }))).toEqual(["deny", "not_granted", "mcp.grants.constructor"]);
    expect(brief(run({ s: S_PO(A0, { action: "mcp.__proto__.x" }) }))).toEqual(["deny", "not_granted", "mcp.grants.__proto__"]);
  });
  it("ツール名にドットを含んでもよい（tool は残り全部）", () => {
    const p = policy((x) => {
      x.mcp.grants = { ...x.mcp.grants, repo: ["pulls.create"] };
    });
    expect(run({ p, s: S_MS("x", { action: "mcp.repo.pulls.create" }) }).matchedRule).toBe("autonomy.mcp_write");
  });
  it("LLM に MCP の読み取りを許していない（llmRead: false）→ deny / not_granted / mcp.llmRead", () => {
    const p = policy((x) => {
      x.mcp.llmRead = false;
    });
    const r = run({ p, s: S_INV });
    expect(brief(r)).toEqual(["deny", "not_granted", "mcp.llmRead"]);
    expect(r.detail).toBeUndefined();
  });
  it("M-22：連絡板（team_post・team_wait）は手順1〜3のあと not_gated（tools にない実行時のツール）", () => {
    expect(brief(run({ s: T("team_post", { args: { to: "仕入れ係", text: "x" } }) }))).toEqual(["allow", "not_gated", null]);
    expect(brief(run({ s: T("team_wait") }))).toEqual(["allow", "not_gated", null]);
    expect(brief(run({ s: T("team_post"), f: { killSwitchEngaged: true } }))).toEqual(["halt", "kill_switch", null]);
  });
  it("届け先の notify（intent）は自律レベルで決まる", () => {
    expect(brief(run({ s: T("notify", { kind: "intent", origin: "deliver" }) }))).toEqual(["allow", "autonomy_auto", "autonomy.notify"]);
    const p = policy((x) => {
      x.autonomy.notify = "deny";
    });
    expect(brief(run({ p, s: T("notify", { kind: "intent" }) }))).toEqual(["deny", "autonomy_deny", "autonomy.notify"]);
  });
  it("X7：run_command は作業場の中の実行（run_tests：D-116）。tools になければ not_granted、run_tests が deny なら deny", () => {
    expect(brief(run({ s: T("run_command", { args: { command: "npm test" } }) }))[1]).toBe("not_granted");
    const p = policy((x) => {
      x.tools = [...x.tools, "run_command"];
      x.autonomy.run_tests = "auto";
    });
    const r = run({ p, s: T("run_command", { args: { command: "npm test" } }) });
    expect(r.decision).toBe("allow");
    expect(r.operation).toBe("run_tests");
    const denied = policy((x) => {
      x.tools = [...x.tools, "run_command"];
      x.autonomy.run_tests = "deny";
    });
    expect(brief(run({ p: denied, s: T("run_command", { args: { command: "npm test" } }) }))).toEqual(["deny", "autonomy_deny", "autonomy.run_tests"]);
  });
  it("load_skill は判定の外（自分のスキルを読むだけ）", () => {
    expect(brief(run({ s: T("load_skill", { args: { name: "採点の手順" } }) }))).toEqual(["allow", "not_gated", null]);
  });
  it("知らない kind → deny / unknown_action", () => {
    expect(brief(run({ s: { ...S_PO(), kind: "bogus" as Subject["kind"] } }))).toEqual(["deny", "unknown_action", null]);
  });
});

describe("decide：手順5 ツールの状態（KD §6.3）", () => {
  it("T1：needs_review → deny / tool_needs_review（ルール・合格証があっても）", () => {
    expect(brief(run({ s: S_PO(A0, { tool: { ...T_PO, status: "needs_review" } }) }))).toEqual(["deny", "tool_needs_review", null]);
  });
  it("T2：コネクタが無効 → deny / connector_disabled", () => {
    expect(brief(run({ s: S_PO(A0, { tool: { ...T_PO, connectorEnabled: false } }) }))).toEqual(["deny", "connector_disabled", null]);
  });
  it("T3：両方なら tool_needs_review", () => {
    expect(run({ s: S_PO(A0, { tool: { ...T_PO, status: "needs_review", connectorEnabled: false } }) }).reasonCode).toBe("tool_needs_review");
  });
  it("CL-10：needs_review の読み取りも deny", () => {
    expect(run({ s: { ...S_INV, tool: { ...T_INV, status: "needs_review" } } }).reasonCode).toBe("tool_needs_review");
  });
});

describe("decide：手順6 Intent の数（KD §6.3、A-85）", () => {
  it("I1：intentsCount 4 → 通過", () => {
    expect(brief(run({ c: { intentsCount: 4 } }))).toEqual(ALLOW_RULE0);
  });
  it("I2：intentsCount 5 → deny / intent_limit / max_intents_per_task", () => {
    const r = run({ c: { intentsCount: 5 } });
    expect(brief(r)).toEqual(["deny", "intent_limit", "max_intents_per_task"]);
    expect(r.detail).toEqual({ kind: "intent_limit", count: 5, limit: 5 });
  });
  it("I3：読み取りは Intent を作らないので止めない", () => {
    expect(run({ s: S_INV, c: { intentsCount: 5 } }).decision).toBe("allow");
  });
  it("I4：上限 20 で 19 は通過、20 で intent_limit", () => {
    const p = policy((x) => {
      x.max_intents_per_task = 20;
    });
    expect(run({ p, c: { intentsCount: 19 } }).decision).toBe("allow");
    expect(run({ p, c: { intentsCount: 20 } }).reasonCode).toBe("intent_limit");
  });
  it("open_pr の intent にも効く", () => {
    const p = policy((x) => {
      x.autonomy.open_pr = "approve";
    });
    const s: Subject = { kind: "intent", actionType: "open_pr", args: {}, paths: [] };
    expect(brief(run({ p, s, c: { intentsCount: 4 } }))).toEqual(["approve", "approval_required", "autonomy.open_pr"]);
    expect(run({ p, s, c: { intentsCount: 5 } }).reasonCode).toBe("intent_limit");
  });
});

describe("decide：手順8 自律レベル（KD §6.3）", () => {
  it("A1：読み取り → allow / autonomy_auto / autonomy.mcp_read", () => {
    const r = run({ s: S_INV });
    expect(brief(r)).toEqual(["allow", "autonomy_auto", "autonomy.mcp_read"]);
    expect(r.operation).toBe("mcp_read");
  });
  it("A2：mcp_write: deny → deny / autonomy_deny / autonomy.mcp_write", () => {
    const p = policy((x) => {
      x.autonomy.mcp_write = "deny";
    });
    expect(brief(run({ p }))).toEqual(["deny", "autonomy_deny", "autonomy.mcp_write"]);
  });
  it("A3：mcp_write: auto（不正）でルールなし → approve / approval_required（auto として通さない）", () => {
    const p = policy((x) => {
      x.autonomy.mcp_write = "auto";
      x.rules.items = [];
    });
    expect(brief(run({ p }))).toEqual(APPROVAL);
  });
  it("A4：mcp_write: handoff → handoff / autonomy_handoff", () => {
    const p = policy((x) => {
      x.autonomy.mcp_write = "handoff";
    });
    expect(brief(run({ p }))).toEqual(["handoff", "autonomy_handoff", "autonomy.mcp_write"]);
  });
  it("A5：autonomy に mcp_read がない → deny / autonomy_deny（KD §8-28）", () => {
    const p = policy((x) => {
      delete (x.autonomy as Partial<Record<OperationType, AutonomyLevel>>).mcp_read;
    });
    expect(brief(run({ p, s: S_INV }))).toEqual(["deny", "autonomy_deny", "autonomy.mcp_read"]);
  });
  it("A6：mcp_read: approve → approve / approval_required / autonomy.mcp_read（KD §8-32）", () => {
    const p = policy((x) => {
      x.autonomy.mcp_read = "approve";
    });
    expect(brief(run({ p, s: S_INV }))).toEqual(["approve", "approval_required", "autonomy.mcp_read"]);
  });
  it("A7：未分類のツールに同じ action・同じ tool_hash のルールがあっても approval_required（ルールを持てない）", () => {
    const tun: ToolInfo = { ...T_PO, classification: "unclassified", argRoles: { supplier_id: "destination", items: "destination", note: "destination" } };
    const run_: EffectiveRule = { id: "r-un", action: PO, tool_hash: H_PO, match: { supplier_id: "supplier-01", items: A0.items!, note: "いつもの" }, free: [] };
    const p = policy((x) => {
      x.rules.items = [run_];
      x.guards = [];
    });
    const r = run({ p, s: S_PO(A0, { tool: tun }) });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.operation).toBe("mcp_write");
  });
  it("自律レベルが知らない値 → deny", () => {
    const p = policy((x) => {
      x.autonomy.mcp_read = "yes" as AutonomyLevel;
    });
    expect(brief(run({ p, s: S_INV }))).toEqual(["deny", "autonomy_deny", "autonomy.mcp_read"]);
  });
});

describe("decide：手順9 結果の分からない書き込み（KD §6.4、BR-68）", () => {
  it("U1：unknownOutcomeKeys に DK01 → approve / unknown_outcome_pending / null", () => {
    const r = run({ c: { unknownOutcomeKeys: [DK01] } });
    expect(brief(r)).toEqual(["approve", "unknown_outcome_pending", null]);
    expect(r.detail).toEqual({ kind: "unknown_outcome", destinationKey: DK01 });
  });
  it("U2：数量を変えても宛先が同じなら pending", () => {
    expect(run({ s: S_PO(poArgs({ items: [item(5)] })), c: { unknownOutcomeKeys: [DK01] } }).reasonCode).toBe("unknown_outcome_pending");
  });
  it("U3：前後の空白は正規化で同じキー", () => {
    expect(run({ s: S_PO(poArgs({ supplier_id: " supplier-01 " })), c: { unknownOutcomeKeys: [DK01] } }).reasonCode).toBe(
      "unknown_outcome_pending",
    );
  });
  it("U4：宛先が違えば手順9は通過 → approval_required（rule_mismatch は supplier_id の destination）", () => {
    const r = run({ s: S_PO(poArgs({ supplier_id: "supplier-02" })), c: { unknownOutcomeKeys: [DK01] } });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toEqual({ kind: "rule_mismatch", ruleIndex: 0, argPath: "supplier_id", role: "destination" });
  });
  it("U5：action が違うキーなら通過", () => {
    const key = destinationKey("mcp.mail.send", { to: "supplier-01" }, T_MS.argRoles);
    expect(brief(run({ c: { unknownOutcomeKeys: [key] } }))).toEqual(ALLOW_RULE0);
  });
  it("U6：数量 200 でも 9 が 10 より先", () => {
    expect(run({ s: S_PO(poArgs({ items: [item(200)] })), c: { unknownOutcomeKeys: [DK01] } }).reasonCode).toBe("unknown_outcome_pending");
  });
  it("U7：mcp_write: deny なら 8 が 9 より先", () => {
    const p = policy((x) => {
      x.autonomy.mcp_write = "deny";
    });
    expect(run({ p, c: { unknownOutcomeKeys: [DK01] } }).reasonCode).toBe("autonomy_deny");
  });
  it("未分類のツールにも効く（argRoles は全部 destination）", () => {
    const tun: ToolInfo = { ...T_PO, classification: "unclassified", argRoles: { supplier_id: "destination", items: "destination", note: "destination" } };
    const key = destinationKey(PO, A0, tun.argRoles);
    expect(run({ s: S_PO(A0, { tool: tun }), c: { unknownOutcomeKeys: [key] } }).reasonCode).toBe("unknown_outcome_pending");
  });
});

describe("decide：手順10 ガード（KD §6.4、BR-61）", () => {
  const withItems = (...items: JsonObject[]) => S_PO(poArgs({ items }));
  it("G1：数量 20（上限ちょうど）→ allow", () => {
    expect(brief(run({ s: withItems(item(20)) }))).toEqual(ALLOW_RULE0);
  });
  it("G2：数量 21 → approve / guard_exceeded / guards[0]（argPath・value・guard）", () => {
    const r = run({ s: withItems(item(21)) });
    expect(brief(r)).toEqual(["approve", "guard_exceeded", "guards[0]"]);
    expect(r.detail).toEqual({ kind: "guard", argPath: "items[0].quantity", value: 21, found: true, guard: G0 });
  });
  it("G3：2件目だけ 200 → argPath 'items[1].quantity'", () => {
    expect(run({ s: withItems(item(5), item(200)) }).detail).toMatchObject({ argPath: "items[1].quantity", value: 200 });
  });
  it("G4：items = [] → guard_exceeded（found: false）", () => {
    const r = run({ s: withItems() });
    expect(brief(r)).toEqual(["approve", "guard_exceeded", "guards[0]"]);
    expect(r.detail).toMatchObject({ found: false, value: null, argPath: "items[].quantity" });
  });
  it("G5：要素に quantity がない → argPath 'items[0].quantity'、found: false", () => {
    const r = run({ s: withItems({ sku: "BEAN-HOUSE", unit_price: 800 }) });
    expect(r.reasonCode).toBe("guard_exceeded");
    expect(r.detail).toMatchObject({ argPath: "items[0].quantity", found: false, value: null });
  });
  it("G6：数量が文字列 '20' → guard_exceeded", () => {
    expect(run({ s: withItems(item("20")) }).reasonCode).toBe("guard_exceeded");
  });
  it("G7：単価 801 / 2400 → guards[1]", () => {
    expect(run({ s: withItems(item(5, 801)) }).matchedRule).toBe("guards[1]");
    expect(run({ s: withItems(item(5, 2400)) }).matchedRule).toBe("guards[1]");
  });
  it("G8：数量 200 かつ単価 2400 → guards[0]（添字の小さい方）", () => {
    expect(run({ s: withItems(item(200, 2400)) }).matchedRule).toBe("guards[0]");
  });
  it("G9：min 1 を足すと数量 0 は外れ、1 は範囲内", () => {
    const p = policy((x) => {
      x.guards = [{ ...G0, min: 1 }, G1];
    });
    expect(run({ p, s: withItems(item(0)) }).reasonCode).toBe("guard_exceeded");
    expect(run({ p, s: withItems(item(1)) }).decision).toBe("allow");
  });
  it("G10：max_digits 3 で 999.99 / 1000 / -800", () => {
    const p = policy((x) => {
      x.guards = [G0, { action: PO, arg: "items[].unit_price", max_digits: 3, empty: false }];
    });
    expect(run({ p, s: withItems(item(5, 999.99)) }).decision).toBe("allow");
    expect(run({ p, s: withItems(item(5, 1000)) }).matchedRule).toBe("guards[1]");
    expect(run({ p, s: withItems(item(5, -800)) }).decision).toBe("allow");
  });
  it("G11：packages[].name の in（left-pad / 1eft-pad / 両方）", () => {
    const REPO = "mcp.repo.create_pull_request";
    const T_REPO: ToolInfo = { ...T_PO, toolHash: `sha256:${"e".repeat(64)}`, argRoles: { "packages[].name": "option", title: "content" } };
    const p = policy((x) => {
      x.mcp.grants = { repo: ["create_pull_request"] };
      x.guards = [{ action: REPO, arg: "packages[].name", in: ["left-pad", "lodash"], empty: false }];
      x.rules.items = [];
    });
    const s = (...names: string[]) => S_PO({ packages: names.map((name) => ({ name })), title: "t" }, { action: REPO, tool: T_REPO });
    expect(brief(run({ p, s: s("left-pad") }))).toEqual(APPROVAL);
    expect(brief(run({ p, s: s("1eft-pad") }))).toEqual(["approve", "guard_exceeded", "guards[0]"]);
    expect(run({ p, s: s("left-pad", "1eft-pad") }).detail).toMatchObject({ argPath: "packages[1].name", value: "1eft-pad" });
  });
  it("G12：合成で積が空（min 30・max 20）→ どの値でも guard_exceeded", () => {
    const p = policy((x) => {
      x.guards = mergeGuards([
        { action: PO, arg: "items[].quantity", min: 30 },
        { action: PO, arg: "items[].quantity", max: 20 },
      ]);
    });
    for (const q of [0, 20, 25, 30, 40]) expect(run({ p, s: withItems(item(q)) }).reasonCode, String(q)).toBe("guard_exceeded");
  });
  it("G13：in: [] → どの値でも guard_exceeded", () => {
    const p = policy((x) => {
      x.guards = mergeGuards([{ action: PO, arg: "items[].sku", in: [] }]);
    });
    expect(run({ p }).reasonCode).toBe("guard_exceeded");
  });
  it("G14：mail.send のガードだけなら place_order には効かない", () => {
    const p = policy((x) => {
      x.guards = [{ action: "mcp.mail.send", arg: "to", in: ["owner@example.com"], empty: false }];
    });
    expect(brief(run({ p, s: withItems(item(500, 9999)) }))).toEqual(ALLOW_RULE0);
  });
  it("G15：ルールがなくても guard_exceeded（approval_required ではない）", () => {
    const p = policy((x) => {
      x.rules.items = [];
    });
    expect(run({ p, s: withItems(item(21)) }).reasonCode).toBe("guard_exceeded");
  });
  it("G16：合格証がなくても guard_exceeded（合格証は手順10を変えない）", () => {
    expect(run({ s: withItems(item(21)), f: { certificateValid: false } }).reasonCode).toBe("guard_exceeded");
  });
});

describe("decide：手順11 ルール（KD §6.4、M-09〜M-12）", () => {
  const withRule = (r: Partial<EffectiveRule>) =>
    policy((x) => {
      x.rules.items = [{ ...R0, ...r }];
    });
  it("R1：基準 → allow / rule_matched / rules.items[0]", () => {
    expect(brief(run())).toEqual(ALLOW_RULE0);
  });
  it("R2：rules.enabled = false → approve / approval_required / autonomy.mcp_write", () => {
    const p = policy((x) => {
      x.rules.enabled = false;
    });
    const r = run({ p });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toBeUndefined();
  });
  it("R3：tool_hash が違う（説明が変わったが needs_review がまだ）→ approval_required", () => {
    expect(brief(run({ p: withRule({ tool_hash: `sha256:${"f".repeat(64)}` }) }))).toEqual(APPROVAL);
  });
  it("R4：match に supplier_id がない（網羅の条件）→ approval_required", () => {
    expect(brief(run({ p: withRule({ match: { "items[].sku": ["BEAN-HOUSE"] } }) }))).toEqual(APPROVAL);
  });
  it("R5：free に supplier_id → approval_required", () => {
    expect(brief(run({ p: withRule({ free: [...R0.free, "supplier_id"] }) }))).toEqual(APPROVAL);
  });
  it("R6：supplier-02 → approval_required、detail は supplier_id の destination", () => {
    const r = run({ s: S_PO(poArgs({ supplier_id: "supplier-02" })) });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toEqual({ kind: "rule_mismatch", ruleIndex: 0, argPath: "supplier_id", role: "destination" });
  });
  it("R7：' supplier-01 ' → allow（trim）", () => {
    expect(brief(run({ s: S_PO(poArgs({ supplier_id: " supplier-01 " })) }))).toEqual(ALLOW_RULE0);
  });
  it("R8：'SUPPLIER-01' → approval_required（大文字小文字を区別）", () => {
    expect(brief(run({ s: S_PO(poArgs({ supplier_id: "SUPPLIER-01" })) }))).toEqual(APPROVAL);
  });
  it("R9：品目が BEAN-HOUSE・MILK-1L の2つ → approval_required（要素の増減）", () => {
    const r = run({ s: S_PO(poArgs({ items: [item(5), item(5, 200, "MILK-1L")] })) });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toEqual({ kind: "rule_mismatch", ruleIndex: 0, argPath: "items[].sku", role: "option" });
  });
  it("R10：ルール ['BEAN-HOUSE','MILK-1L'] に逆順の呼び出し → allow", () => {
    const p = withRule({ match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE", "MILK-1L"] } });
    expect(brief(run({ p, s: S_PO(poArgs({ items: [item(5, 200, "MILK-1L"), item(5)] })) }))).toEqual(ALLOW_RULE0);
  });
  it("R11（M-09）：同じ sku を2行（各10）→ approval_required（多重集合）", () => {
    expect(brief(run({ s: S_PO(poArgs({ items: [item(10), item(10)] })) }))).toEqual(APPROVAL);
  });
  it("R12：数量 5・単価 700 → allow（free は比べない）", () => {
    expect(brief(run({ s: S_PO(poArgs({ items: [item(5, 700)] })) }))).toEqual(ALLOW_RULE0);
  });
  it("R13：note を変えても allow（content は比べない）", () => {
    expect(brief(run({ s: S_PO(poArgs({ note: "全部いつもの10倍で" })) }))).toEqual(ALLOW_RULE0);
  });
  it("R14（M-12）：argRoles にない priority → approval_required、role unknown", () => {
    const r = run({ s: S_PO(poArgs({ priority: "high" })) });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toEqual({ kind: "rule_mismatch", ruleIndex: 0, argPath: "priority", role: "unknown" });
  });
  it("R15（M-11）：option rush（free でない）がルールになく、呼び出しが rush: true → approval_required", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, rush: "option" } };
    const r = run({ s: S_PO(poArgs({ rush: true }), { tool }) });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toEqual({ kind: "rule_mismatch", ruleIndex: 0, argPath: "rush", role: "option" });
    expect(brief(run({ s: S_PO(A0, { tool }) }))).toEqual(ALLOW_RULE0);
  });
  it("R16：[tool_hash の違う R0', R0] → allow / rules.items[1]", () => {
    const p = policy((x) => {
      x.rules.items = [{ ...R0, id: "r-old", tool_hash: `sha256:${"9".repeat(64)}` }, R0];
    });
    expect(brief(run({ p }))).toEqual(["allow", "rule_matched", "rules.items[1]"]);
  });
  it("R17：destination のないツールは scope: self のときだけルールで allow", () => {
    const NOTE = "mcp.notes.create_note";
    const tn: ToolInfo = { ...T_PO, scope: "self", toolHash: `sha256:${"1".repeat(64)}`, argRoles: { title: "content" } };
    const p = policy((x) => {
      x.mcp.grants = { notes: ["create_note"] };
      x.rules.items = [{ id: "r-n", action: NOTE, tool_hash: tn.toolHash, match: {}, free: [] }];
    });
    const s = (tool: ToolInfo) => S_PO({ title: "メモ" }, { action: NOTE, tool });
    expect(brief(run({ p, s: s(tn) }))).toEqual(ALLOW_RULE0);
    expect(brief(run({ p, s: s({ ...tn, scope: null }) }))).toEqual(APPROVAL);
  });
  it("R18：mail.send のルール owner@ に xxx@（F-09）→ approval_required", () => {
    const p = policy((x) => {
      x.rules.items = [R_MAIL];
    });
    expect(brief(run({ p, s: S_MS("owner@example.com") }))).toEqual(ALLOW_RULE0);
    const r = run({ p, s: S_MS("xxx@example.com") });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toEqual({ kind: "rule_mismatch", ruleIndex: 0, argPath: "to", role: "destination" });
  });
  it("R19：bank.register_payee のルール ACC-LEGIT に ACC-ATTACKER（F-03）→ approval_required", () => {
    const p = policy((x) => {
      x.rules.items = [R_BANK];
    });
    expect(brief(run({ p, s: S_BP("ACC-ATTACKER") }))).toEqual(APPROVAL);
    expect(brief(run({ p, s: S_BP("ACC-LEGIT") }))).toEqual(ALLOW_RULE0);
  });
  it("R20：固定の option が数値 1 で呼び出しが文字列 '1' → 不一致", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, rush: "option" } };
    const p = withRule({ match: { ...R0.match, rush: 1 } });
    expect(brief(run({ p, s: S_PO(poArgs({ rush: "1" }), { tool }) }))).toEqual(APPROVAL);
    expect(brief(run({ p, s: S_PO(poArgs({ rush: 1 }), { tool }) }))).toEqual(ALLOW_RULE0);
  });
  it("R21：é（U+00E9）と e＋U+0301 は不一致（Unicode の正規化をしない）", () => {
    const p = withRule({ match: { ...R0.match, supplier_id: "café" } });
    expect(brief(run({ p, s: S_PO(poArgs({ supplier_id: "café" })) }))).toEqual(APPROVAL);
    expect(brief(run({ p, s: S_PO(poArgs({ supplier_id: "café" })) }))).toEqual(ALLOW_RULE0);
  });
  it("一致するルールがなければ detail なし（同じ action の有効なルールがない）", () => {
    const p = policy((x) => {
      x.rules.items = [R_MAIL];
    });
    const r = run({ p });
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toBeUndefined();
  });
});

describe("decide：合格証（KD §6.4、M-18・BR-81）", () => {
  it("C1：合格証なし → approve / certificate_missing / rules.items[0]", () => {
    expect(brief(run({ f: { certificateValid: false } }))).toEqual(["approve", "certificate_missing", "rules.items[0]"]);
  });
  it("C2（M-18）：合格証なし＋一致なし（supplier-02）→ approval_required", () => {
    expect(brief(run({ s: S_PO(poArgs({ supplier_id: "supplier-02" })), f: { certificateValid: false } }))).toEqual(APPROVAL);
  });
  it("C3：合格証なし＋rules.enabled = false → approval_required", () => {
    const p = policy((x) => {
      x.rules.enabled = false;
    });
    expect(brief(run({ p, f: { certificateValid: false } }))).toEqual(APPROVAL);
  });
  it("C4：合格証なし＋数量 21 → guard_exceeded、合格証なし＋U1 → unknown_outcome_pending", () => {
    expect(run({ s: S_PO(poArgs({ items: [item(21)] })), f: { certificateValid: false } }).reasonCode).toBe("guard_exceeded");
    expect(run({ c: { unknownOutcomeKeys: [DK01] }, f: { certificateValid: false } }).reasonCode).toBe("unknown_outcome_pending");
  });
  it("C5：合格証なしでも読み取りは変わらない", () => {
    expect(brief(run({ s: S_INV, f: { certificateValid: false } }))).toEqual(["allow", "autonomy_auto", "autonomy.mcp_read"]);
  });
  it("C6：用意した確認（supplier-01・豆 20kg）：ルールなし・合格証なし・汚染あり → approval_required（ADR-039:31）", () => {
    const p = policy((x) => {
      x.rules.items = [];
    });
    const x: TaintState = {
      tainted: true,
      sources: [{ kind: "mcp_read", connectorId: "c-1", connectorSlug: "mail", connectorName: "メール", tool: "list_inbox", at: "2026-10-08T09:00:00+09:00" }],
    };
    expect(brief(run({ p, f: { certificateValid: false }, x }))).toEqual(APPROVAL);
  });
  it("certificateValid が true 以外（undefined など）なら合格証なしとして扱う", () => {
    expect(run({ f: { certificateValid: undefined as unknown as boolean } }).reasonCode).toBe("certificate_missing");
  });
});

describe("decide：IA §6.2・MT §6.5〜6.6（M-xx で直したもの）", () => {
  it("IA K-1・K-2：intentsCount 4（上限5）は手順6を通り、5 で deny(intent_limit)", () => {
    expect(brief(run({ c: { intentsCount: 4 } }))).toEqual(ALLOW_RULE0);
    expect(run({ c: { intentsCount: 5 } })).toMatchObject({ decision: "deny", reasonCode: "intent_limit", matchedRule: "max_intents_per_task" });
  });
  it("IA K-3：上限25は compose が Hard Ceiling の20に切り詰める（C-36）。実効20で intentsCount 20 は deny", () => {
    const p = policy((x) => {
      x.max_intents_per_task = 20;
    });
    expect(brief(run({ p, c: { intentsCount: 19 } }))).toEqual(ALLOW_RULE0);
    expect(run({ p, c: { intentsCount: 20 } }).reasonCode).toBe("intent_limit");
  });
  it("IA K-4・K-5：Kill Switch → halt(kill_switch)、cancelled → halt(task_terminated)", () => {
    expect(brief(run({ f: { killSwitchEngaged: true } }))).toEqual(["halt", "kill_switch", null]);
    expect(brief(run({ f: { taskStatus: "cancelled" } }))).toEqual(["halt", "task_terminated", null]);
  });
  it("IA K-6・K-7・K-8：needs_review → deny(tool_needs_review)、コネクタ無効 → deny(connector_disabled)、mcp_write: deny → deny(autonomy_deny)", () => {
    expect(run({ s: S_PO(A0, { tool: { ...T_PO, status: "needs_review" } }) }).reasonCode).toBe("tool_needs_review");
    expect(run({ s: S_PO(A0, { tool: { ...T_PO, connectorEnabled: false } }) }).reasonCode).toBe("connector_disabled");
    const p = policy((x) => {
      x.autonomy.mcp_write = "deny";
    });
    expect(brief(run({ p }))).toEqual(["deny", "autonomy_deny", "autonomy.mcp_write"]);
  });
  it("K-9・DK-06：同じ宛先の unknown_outcome があればルール一致・ガード内・合格証ありでも pending", () => {
    expect(run({ c: { unknownOutcomeKeys: [DK01] } }).reasonCode).toBe("unknown_outcome_pending");
  });
  it("K-11：同じ操作・別の宛先の unknown_outcome は当たらない", () => {
    const other = destinationKey(PO, poArgs({ supplier_id: "supplier-02" }), T_PO.argRoles);
    expect(brief(run({ c: { unknownOutcomeKeys: [other] } }))).toEqual(ALLOW_RULE0);
  });
  it("K-12：確定してキーが消えたあとは当たらない", () => {
    expect(brief(run({ c: { unknownOutcomeKeys: [] } }))).toEqual(ALLOW_RULE0);
  });
  it("K-28・RU-12：合格証なし・ルール一致 → certificate_missing", () => {
    expect(run({ f: { certificateValid: false } }).reasonCode).toBe("certificate_missing");
  });
  it("K-29 は M-18 で変更：合格証なし・ルールなし → approval_required", () => {
    const p = policy((x) => {
      x.rules.items = [];
    });
    expect(brief(run({ p, f: { certificateValid: false } }))).toEqual(APPROVAL);
  });
  it("K-30：合格証あり・rules.enabled = false・一致するルールあり → approval_required", () => {
    const p = policy((x) => {
      x.rules.enabled = false;
    });
    expect(brief(run({ p }))).toEqual(APPROVAL);
  });
  it("K-31・RU-09：汚染あり・ルール一致・ガード内 → allow（BR-39・D-58）", () => {
    expect(brief(run({ x: { tainted: true, sources: [{ kind: "web_search", at: "2026-10-08T09:00:00+09:00" }] } }))).toEqual(ALLOW_RULE0);
  });
  it("K-32・RU-10：ルールなし → approval_required（汚染の有無によらない）", () => {
    const p = policy((x) => {
      x.rules.items = [];
    });
    expect(brief(run({ p }))).toEqual(APPROVAL);
    expect(brief(run({ p, x: { tainted: true, sources: [] } }))).toEqual(APPROVAL);
  });
  it("K-34・RU-11：ガード外れ・ルール一致 → guard_exceeded（ルールより先）", () => {
    expect(run({ s: S_PO(poArgs({ items: [item(200)] })) }).reasonCode).toBe("guard_exceeded");
  });
  it("K-35：同じ入力で2回 → 同じ出力・同じ inputsHash", () => {
    expect(run()).toEqual(run());
  });
  it("J9：args.items の順序だけ違えば inputsHash は違うが、ルールの一致（判定）は同じ", () => {
    const p = policy((x) => {
      x.rules.items = [{ ...R0, match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE", "MILK-1L"] } }];
    });
    const a = run({ p, s: S_PO(poArgs({ items: [item(5), item(5, 200, "MILK-1L")] })) });
    const b = run({ p, s: S_PO(poArgs({ items: [item(5, 200, "MILK-1L"), item(5)] })) });
    expect(a.inputsHash).not.toBe(b.inputsHash);
    expect(brief(a)).toEqual(ALLOW_RULE0);
    expect(brief(b)).toEqual(ALLOW_RULE0);
  });
  it("AR-11：書き込みツールの引数が全部 content で scope = null → ルールがあっても approval_required", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { title: "content", body: "content" } };
    const p = policy((x) => {
      x.rules.items = [{ id: "r-c", action: PO, tool_hash: H_PO, match: {}, free: [] }];
      x.guards = [];
    });
    expect(brief(run({ p, s: S_PO({ title: "a", body: "b" }, { tool }) }))).toEqual(APPROVAL);
  });
  it("RU-17：ルールを作ったあとに arg_roles が変わり tool_hash が変わった → approval_required", () => {
    const tool: ToolInfo = { ...T_PO, toolHash: `sha256:${"2".repeat(64)}` };
    expect(brief(run({ s: S_PO(A0, { tool }) }))).toEqual(APPROVAL);
  });
});

describe("decide：筋書き（KD §6.7）", () => {
  it("S1（F-01）：unknown_outcome のあとの出し直しは数量を変えても pending、確定後は allow", () => {
    const again = S_PO(poArgs({ items: [item(15)] }));
    expect(run({ s: again, c: { unknownOutcomeKeys: [DK01] } }).reasonCode).toBe("unknown_outcome_pending");
    expect(brief(run({ s: again, c: { unknownOutcomeKeys: [] } }))).toEqual(ALLOW_RULE0);
  });
  it("S2（F-02）：数量 100 はガードありなら guard_exceeded、ガードなしならすり抜け、ガードを足すと guard_exceeded", () => {
    const s = S_PO(poArgs({ items: [item(100)] }));
    expect(run({ s }).reasonCode).toBe("guard_exceeded");
    const noGuard = policy((x) => {
      x.guards = [];
    });
    expect(brief(run({ p: noGuard, s }))).toEqual(ALLOW_RULE0);
    const narrowed = { ...noGuard, guards: mergeGuards([{ action: PO, arg: "items[].quantity", max: 20 }]) };
    expect(run({ p: narrowed, s }).reasonCode).toBe("guard_exceeded");
  });
  it("S3（F-03）：振込先の変更 → approval_required（宛先の固定）", () => {
    const p = policy((x) => {
      x.rules.items = [R_BANK];
    });
    expect(run({ p, s: S_BP("ACC-ATTACKER") }).reasonCode).toBe("approval_required");
  });
  it("S4（F-04）：200個・単価の桁 8000（max_digits 3）→ guard_exceeded", () => {
    const p = policy((x) => {
      x.guards = mergeGuards([
        { action: PO, arg: "items[].quantity", max: 20 },
        { action: PO, arg: "items[].unit_price", max_digits: 3 },
      ]);
    });
    expect(run({ p, s: S_PO(poArgs({ items: [item(200)] })) }).reasonCode).toBe("guard_exceeded");
    expect(run({ p, s: S_PO(poArgs({ items: [item(5, 8000)] })) }).matchedRule).toBe("guards[1]");
  });
  it("S5（F-05）：単価が3倍 → guard_exceeded / guards[1]", () => {
    expect(brief(run({ s: S_PO(poArgs({ items: [item(5, 2400)] })) }))).toEqual(["approve", "guard_exceeded", "guards[1]"]);
  });
  it("S6（F-07）：同じ引数の get_inventory は5回目で halt（nextCounters で数える）", () => {
    let c: Counters = { ...C0 };
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = decide(P0, S_INV, c, F0, X0);
      seen.push(r.decision);
      c = nextCounters(c, S_INV, r, false);
    }
    expect(seen).toEqual(["allow", "allow", "allow", "allow", "halt"]);
  });
  it("S7（F-08）：説明が変わったら needs_review で deny、付く前でも tool_hash がルールと違えば approval_required", () => {
    expect(run({ s: S_PO(A0, { tool: { ...T_PO, status: "needs_review" } }) }).reasonCode).toBe("tool_needs_review");
    expect(run({ s: S_PO(A0, { tool: { ...T_PO, toolHash: `sha256:${"3".repeat(64)}` } }) }).reasonCode).toBe("approval_required");
  });
  it("S8（F-12）：packages[].name の 1eft-pad は in のガードで guard_exceeded、固定の option のルールでは approval_required", () => {
    const REPO = "mcp.repo.create_pull_request";
    const tool: ToolInfo = { ...T_PO, toolHash: `sha256:${"4".repeat(64)}`, argRoles: { repo: "destination", "packages[].name": "option" } };
    const s = S_PO({ repo: "acme/web", packages: [{ name: "1eft-pad" }] }, { action: REPO, tool });
    const withGuard = policy((x) => {
      x.mcp.grants = { repo: ["create_pull_request"] };
      x.guards = [{ action: REPO, arg: "packages[].name", in: ["left-pad", "lodash"], empty: false }];
      x.rules.items = [];
    });
    expect(run({ p: withGuard, s }).reasonCode).toBe("guard_exceeded");
    const withRule = policy((x) => {
      x.mcp.grants = { repo: ["create_pull_request"] };
      x.guards = [];
      x.rules.items = [{ id: "r-repo", action: REPO, tool_hash: tool.toolHash, match: { repo: "acme/web", "packages[].name": ["left-pad"] }, free: [] }];
    });
    expect(run({ p: withRule, s }).reasonCode).toBe("approval_required");
  });
  it("S9（デモ 1:05）：リハーサル（合格証 true）で数量 200 がすり抜け → ガードを足すと guard_exceeded。本番（合格証なし）は certificate_missing", () => {
    const noQtyGuard = policy((x) => {
      x.guards = [G1];
    });
    const s200 = S_PO(poArgs({ items: [item(200)] }));
    expect(brief(run({ p: noQtyGuard, s: s200, f: { certificateValid: true } }))).toEqual(ALLOW_RULE0);
    const tightened = { ...noQtyGuard, guards: mergeGuards([G1, { action: PO, arg: "items[].quantity", max: 20 }]) };
    expect(run({ p: tightened, s: s200, f: { certificateValid: true } }).reasonCode).toBe("guard_exceeded");
    expect(brief(run({ p: tightened, f: { certificateValid: false } }))).toEqual(["approve", "certificate_missing", "rules.items[0]"]);
  });
  it("S10：本番の経路と影の走行で同じ入力なら出力も同じ（decide は shadow を取らない）", () => {
    const shadowFlags = { ...F0, shadow: true } as Flags;
    expect(decide(P0, S_PO(), C0, shadowFlags, X0)).toEqual(decide(P0, S_PO(), C0, F0, X0));
  });
});

describe("decide：判定できない入力は例外（NFR-005）", () => {
  it("有限でない数値・欠けた上限は例外", () => {
    expect(() => run({ s: S_PO(poArgs({ items: [item(Number.NaN)] })) })).toThrow();
    expect(() => run({ c: { costUsd: Number.NaN } })).toThrow();
    expect(() => run({ c: { deniedCount: undefined as unknown as number } })).toThrow(TypeError);
    const p = { ...P0, max_intents_per_task: undefined } as unknown as EffectivePolicy;
    expect(() => run({ p })).toThrow(TypeError);
  });
});

describe("recheckIntent（M-20：手順4〜11だけ）", () => {
  const ctx = { unknownOutcomeKeys: [] as string[], certificateValid: true };
  it("予算・Breaker・時間・Kill Switch・Intent の数を見ない（引数にない）", () => {
    expect(brief(recheckIntent(P0, S_PO(), ctx))).toEqual(ALLOW_RULE0);
    const tiny = policy((x) => {
      x.max_intents_per_task = 1;
    });
    expect(brief(recheckIntent(tiny, S_PO(), ctx))).toEqual(ALLOW_RULE0);
  });
  it("締めたポリシー（ルールを外した）→ approve / approval_required", () => {
    const p = policy((x) => {
      x.rules.items = [];
    });
    expect(brief(recheckIntent(p, S_PO(), ctx))).toEqual(APPROVAL);
  });
  it("mcp_write: deny・付与を外した・LLM の書き込みを外した → deny（呼び出し側は expired(policy_changed)）", () => {
    const denyWrite = policy((x) => {
      x.autonomy.mcp_write = "deny";
    });
    expect(recheckIntent(denyWrite, S_PO(), ctx).decision).toBe("deny");
    const noGrant = policy((x) => {
      x.mcp.grants = { store: ["get_inventory"] };
    });
    expect(brief(recheckIntent(noGrant, S_PO(), ctx))).toEqual(["deny", "not_granted", "mcp.grants.supplier"]);
    const noWrite = policy((x) => {
      x.mcp.llmWrite = false;
    });
    expect(brief(recheckIntent(noWrite, S_PO(), ctx))).toEqual(["deny", "not_granted", "mcp.llmWrite"]);
  });
  it("ガードを足した・unknown_outcome・合格証なしも同じ手順で", () => {
    const tightened = policy((x) => {
      x.guards = mergeGuards([{ action: PO, arg: "items[].quantity", max: 10 }]);
    });
    expect(recheckIntent(tightened, S_PO(), ctx).reasonCode).toBe("guard_exceeded");
    expect(recheckIntent(P0, S_PO(), { unknownOutcomeKeys: [DK01], certificateValid: true }).reasonCode).toBe("unknown_outcome_pending");
    expect(recheckIntent(P0, S_PO(), { unknownOutcomeKeys: [], certificateValid: false }).reasonCode).toBe("certificate_missing");
  });
  it("inputsHash は decide のものと別で、同じ入力なら同じ", () => {
    const a = recheckIntent(P0, S_PO(), ctx);
    expect(a.inputsHash).toMatch(HEX64);
    expect(a.inputsHash).not.toBe(run().inputsHash);
    expect(recheckIntent(P0, S_PO(), { ...ctx })).toEqual(a);
    expect(a.operation).toBe("mcp_write");
  });
});

describe("一致したルールの id（SG-09 の記録）", () => {
  const R1: EffectiveRule = { ...R0, id: "r-second", match: { supplier_id: "supplier-02", "items[].sku": ["BEAN-HOUSE"] } };
  const two = policy((x) => {
    x.rules.items = [R0, R1];
  });
  it("rule_matched・certificate_missing はルールの id を付ける（パスは今までどおり）", () => {
    expect(run().matchedRuleId).toBe("r-91c2");
    expect(run({ f: { certificateValid: false } })).toMatchObject({ reasonCode: "certificate_missing", matchedRule: "rules.items[0]", matchedRuleId: "r-91c2" });
    const r = run({ p: two, s: S_PO(poArgs({ supplier_id: "supplier-02" })) });
    expect(brief(r)).toEqual(["allow", "rule_matched", "rules.items[1]"]);
    expect(r.matchedRuleId).toBe("r-second");
  });
  it("ルールに一致しない判定には付けない（approval_required・guard_exceeded・unknown_outcome・deny）", () => {
    const results = [
      run({ s: S_PO(poArgs({ supplier_id: "supplier-99" })) }),
      run({ s: S_PO(poArgs({ items: [item(99)] })) }),
      run({ c: { unknownOutcomeKeys: [DK01] } }),
      run({ p: policy((x) => (x.autonomy.mcp_write = "deny")) }),
      run({ p: policy((x) => (x.rules.enabled = false)) }),
      run({ s: S_INV }),
    ];
    for (const r of results) expect(r).not.toHaveProperty("matchedRuleId");
  });
  it("recheckIntent も同じ id を返す", () => {
    expect(recheckIntent(P0, S_PO(), { unknownOutcomeKeys: [], certificateValid: true }).matchedRuleId).toBe("r-91c2");
  });
  it("ルールの id を変えても判定（decision・reasonCode・matchedRule）は同じで、matchedRuleId だけが変わる", () => {
    const renamed = policy((x) => {
      x.rules.items = [{ ...R0, id: "r-other" }];
    });
    const a = run();
    const b = run({ p: renamed });
    expect(brief(b)).toEqual(brief(a));
    expect(b.matchedRuleId).toBe("r-other");
  });
  it("matchedRuleId を足しても inputsHash は入力だけから決まる（同じポリシーの computeInputsHash と一致）", () => {
    expect(run().inputsHash).toBe(computeInputsHash(P0, S_PO(), C0, F0, X0));
    expect(run({ f: { certificateValid: false } }).inputsHash).toBe(computeInputsHash(P0, S_PO(), C0, { ...F0, certificateValid: false }, X0));
  });
});

describe("nextCounters（KD §3.4-4、FR-014）", () => {
  const allow = run();
  it("tool_call：同じキーなら +1、違えば 1", () => {
    const c1 = nextCounters(C0, S_INV, allow, false);
    expect(c1.repeatKey).toBe(repeatKeyOf(S_INV));
    expect(c1.repeatCount).toBe(1);
    const c2 = nextCounters(c1, S_INV, allow, false);
    expect(c2.repeatCount).toBe(2);
    const c3 = nextCounters(c2, S_PO(), allow, false);
    expect(c3.repeatKey).toBe(repeatKeyOf(S_PO()));
    expect(c3.repeatCount).toBe(1);
  });
  it("llm_call・intent は repeat を変えない", () => {
    const c1 = nextCounters({ ...C0, repeatKey: "k", repeatCount: 3 }, L(0.1), allow, false);
    expect([c1.repeatKey, c1.repeatCount]).toEqual(["k", 3]);
    const c2 = nextCounters({ ...C0, repeatKey: "k", repeatCount: 3 }, S_PO(A0, { kind: "intent" }), allow, false);
    expect([c2.repeatKey, c2.repeatCount]).toEqual(["k", 3]);
  });
  it("deny なら deniedCount + 1、Intent を作ったら intentsCount + 1。ほかは変えない", () => {
    const denied = run({ s: T("rm_rf") });
    const c = nextCounters(C0, T("rm_rf"), denied, true);
    expect(c.deniedCount).toBe(1);
    expect(c.intentsCount).toBe(1);
    expect(nextCounters(C0, S_PO(), allow, false)).toMatchObject({
      deniedCount: 0,
      intentsCount: 0,
      stepsUsed: C0.stepsUsed,
      costUsd: C0.costUsd,
      elapsedSec: C0.elapsedSec,
    });
    expect(nextCounters(C0, S_PO(), run({ f: { killSwitchEngaged: true } }), false).deniedCount).toBe(0);
  });
  it("入力を変えない", () => {
    const c = { ...C0, unknownOutcomeKeys: [DK01] };
    const before = structuredClone(c);
    nextCounters(c, S_INV, allow, true);
    expect(c).toEqual(before);
  });
});

// ---- 性質（KD §6.5、tech:392-393） ----

const HEX = "0123456789abcdef";
const arbHex = fc.array(fc.constantFrom(...HEX), { minLength: 64, maxLength: 64 }).map((a) => a.join(""));
const mostly = <V>(main: V, other: fc.Arbitrary<V>) => fc.oneof({ arbitrary: fc.constant(main), weight: 3 }, { arbitrary: other, weight: 1 });
const LEVELS: AutonomyLevel[] = ["auto", "approve", "handoff", "deny"];
const arbAutonomy = fc
  .array(fc.constantFrom(...LEVELS), { minLength: OPERATION_TYPES.length, maxLength: OPERATION_TYPES.length })
  .map((ls) => Object.fromEntries(OPERATION_TYPES.map((op, i) => [op, ls[i]])) as Record<OperationType, AutonomyLevel>);
const RULE_POOL: EffectiveRule[] = [
  R0,
  { ...R0, id: "r-stale", tool_hash: `sha256:${"9".repeat(64)}` },
  { ...R0, id: "r-2sku", match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE", "MILK-1L"] } },
  { ...R0, id: "r-s2", match: { supplier_id: "supplier-02", "items[].sku": ["BEAN-HOUSE"] } },
  { ...R0, id: "r-nocover", match: { "items[].sku": ["BEAN-HOUSE"] } },
  { ...R0, id: "r-freedest", free: [...R0.free, "supplier_id"] },
  R_MAIL,
  R_BANK,
];
const GUARD_POOL: MergedGuard[] = [
  G0,
  G1,
  { action: "mcp.mail.send", arg: "to", in: ["owner@example.com"], empty: false },
  { action: PO, arg: "items[].sku", in: [], empty: true },
  { action: PO, arg: "items[].quantity", min: 1, max: 50, empty: false },
];
const arbPolicy: fc.Arbitrary<EffectivePolicy> = fc
  .record({
    autonomy: mostly(AUTONOMY, arbAutonomy),
    per_task_usd: fc.constantFrom(0.2, 0.5, 2),
    per_day_usd: fc.constantFrom(1, 3),
    agent_day_usd: fc.constantFrom(null, 0.5, 1),
    max_steps: fc.integer({ min: 1, max: 50 }),
    max_minutes: fc.integer({ min: 1, max: 60 }),
    same_action_repeat: fc.integer({ min: 2, max: 6 }),
    denied_attempts_max: fc.integer({ min: 1, max: 5 }),
    step_cost_usd_max: fc.constantFrom(0.1, 0.5),
    max_intents: fc.integer({ min: 1, max: 20 }),
    tools: mostly([...P0.tools], fc.subarray([...CATALOG_TOOLS])),
    llmRead: mostly(true, fc.boolean()),
    llmWrite: mostly(true, fc.boolean()),
    deliverWrite: mostly(true, fc.boolean()),
    grantKeys: mostly(Object.keys(P0.mcp.grants), fc.subarray(Object.keys(P0.mcp.grants))),
    rulesEnabled: mostly(true, fc.boolean()),
    rules: mostly([R0], fc.subarray(RULE_POOL)),
    guards: mostly([G0, G1], fc.subarray(GUARD_POOL)),
  })
  .map((r) => ({
    ...P0,
    autonomy: r.autonomy,
    budget: { per_task_usd: r.per_task_usd, per_day_usd: r.per_day_usd, agent_day_usd: r.agent_day_usd, max_steps: r.max_steps, max_minutes: r.max_minutes },
    breakers: { same_action_repeat: r.same_action_repeat, denied_attempts_max: r.denied_attempts_max, step_cost_usd_max: r.step_cost_usd_max },
    max_intents_per_task: r.max_intents,
    tools: r.tools,
    mcp: {
      llmRead: r.llmRead,
      llmWrite: r.llmWrite,
      deliverWrite: r.deliverWrite,
      grants: Object.fromEntries(r.grantKeys.map((k) => [k, P0.mcp.grants[k]!])),
    },
    rules: { enabled: r.rulesEnabled, items: r.rules },
    guards: r.guards,
  }));
const arbItem = fc.record(
  {
    sku: fc.constantFrom("BEAN-HOUSE", "MILK-1L", " BEAN-HOUSE"),
    quantity: fc.oneof(fc.integer({ min: 0, max: 40 }), fc.constant("20")),
    unit_price: fc.integer({ min: 0, max: 1200 }),
  },
  { requiredKeys: ["sku"] },
);
const arbPoArgs = fc.record(
  {
    supplier_id: fc.constantFrom("supplier-01", " supplier-01 ", "supplier-02", "SUPPLIER-01"),
    items: fc.array(arbItem, { maxLength: 3 }),
    note: fc.constantFrom("いつもの", "至急"),
    priority: fc.constant("high"),
  },
  { requiredKeys: ["supplier_id", "items"] },
);
const arbTool = (base: ToolInfo) =>
  fc
    .record({
      status: mostly<ToolInfo["status"]>("ok", fc.constant("needs_review")),
      connectorEnabled: mostly(true, fc.constant(false)),
      classification: mostly<ToolInfo["classification"]>(base.classification, fc.constantFrom("read", "write", "unclassified")),
    })
    .map((v): ToolInfo => ({ ...base, ...v }));
const arbKind = mostly<Subject["kind"]>("tool_call", fc.constant("intent"));
const arbOrigin = fc.constantFrom<Subject["origin"]>("agent", "deliver", undefined);
const arbSubject: fc.Arbitrary<Subject> = fc.oneof(
  { arbitrary: fc.record({ args: arbPoArgs, tool: arbTool(T_PO), kind: arbKind, origin: arbOrigin }).map((r) => S_PO(r.args, { tool: r.tool, kind: r.kind, origin: r.origin })), weight: 5 },
  { arbitrary: fc.record({ tool: arbTool(T_INV), kind: arbKind }).map((r) => ({ ...S_INV, tool: r.tool, kind: r.kind })), weight: 2 },
  {
    arbitrary: fc
      .record({ to: fc.constantFrom("owner@example.com", "xxx@example.com"), tool: arbTool(T_MS), kind: arbKind })
      .map((r) => S_MS(r.to, { tool: r.tool, kind: r.kind })),
    weight: 2,
  },
  { arbitrary: fc.record({ account: fc.constantFrom("ACC-LEGIT", "ACC-ATTACKER"), tool: arbTool(T_BP) }).map((r) => S_BP(r.account, { tool: r.tool })), weight: 1 },
  { arbitrary: fc.double({ min: 0, max: 1, noNaN: true }).map(L), weight: 2 },
  {
    arbitrary: fc.constantFrom("finish", "notify", "submit_report", "web_fetch", "run_command", "team_post", "rm_rf", "submit_intent").map((t) => T(t)),
    weight: 2,
  },
  {
    arbitrary: fc.constantFrom<Subject["actionType"]>("open_pr", "notify", "web_fetch").map((t): Subject => ({ kind: "intent", actionType: t, args: {}, paths: [] })),
    weight: 1,
  },
);
const STATUSES: TaskStatus[] = ["queued", "provisioning", "running", "awaiting_approval", "executing", ...TERMINAL];
interface Case {
  policy: EffectivePolicy;
  subject: Subject;
  counters: Counters;
  flags: Flags;
  taint: TaintState;
}
const arbCase: fc.Arbitrary<Case> = fc.tuple(arbPolicy, arbSubject).chain(([p, s]) => {
  const key = s.tool && s.action ? destinationKey(s.action, s.args, s.tool.argRoles) : DK01;
  return fc
    .record({
      counters: fc.record({
        stepsUsed: mostly(3, fc.integer({ min: 0, max: 50 })),
        costUsd: mostly(0.05, fc.constantFrom(0, 0.2, 0.3)),
        dayCostUsd: mostly(0.2, fc.constantFrom(0, 0.99, 1.5)),
        agentDayCostUsd: mostly(0.1, fc.constantFrom(0, 0.995)),
        elapsedSec: mostly(60, fc.integer({ min: 0, max: 4000 })),
        deniedCount: mostly(0, fc.integer({ min: 0, max: 5 })),
        repeatKey: fc.constantFrom<string | null>(null, repeatKeyOf(s), "f".repeat(64)),
        repeatCount: fc.integer({ min: 0, max: 6 }),
        intentsCount: mostly(0, fc.integer({ min: 0, max: 21 })),
        unknownOutcomeKeys: fc.subarray([key, DK01, "e".repeat(64)]),
      }),
      flags: fc.record({
        killSwitchEngaged: mostly(false, fc.constant(true)),
        taskStatus: mostly<TaskStatus>("running", fc.constantFrom(...STATUSES)),
        certificateValid: fc.boolean(),
      }),
      taint: fc.record({
        tainted: fc.boolean(),
        sources: fc.constantFrom<TaintState["sources"]>([], [{ kind: "web_search", at: "2026-10-08T09:00:00+09:00" }]),
      }),
    })
    .map((r) => ({ policy: p, subject: s, ...r }));
});
// 基準（allow）から少しずつ変えた入力。allow の境目の近くを重点的に試す
const arbNear: fc.Arbitrary<Case> = fc
  .record({
    supplier: mostly("supplier-01", fc.constantFrom(" supplier-01 ", "supplier-02", "SUPPLIER-01")),
    items: mostly<JsonObject[]>([item()], fc.array(arbItem, { maxLength: 3 })),
    extra: mostly<JsonObject>({}, fc.constantFrom<JsonObject>({ priority: "high" }, { note: "至急" })),
    tool: mostly(T_PO, arbTool(T_PO)),
    kind: arbKind,
    rules: mostly([R0], fc.subarray(RULE_POOL)),
    rulesEnabled: mostly(true, fc.constant(false)),
    guards: mostly([G0, G1], fc.subarray(GUARD_POOL)),
    mcpWrite: mostly<AutonomyLevel>("approve", fc.constantFrom<AutonomyLevel>("auto", "deny", "handoff")),
    llmWrite: mostly(true, fc.constant(false)),
    cert: mostly(true, fc.constant(false)),
    unknown: mostly<string[]>([], fc.subarray([DK01, "e".repeat(64)])),
    repeat: mostly(false, fc.constant(true)),
    tainted: fc.boolean(),
  })
  .map((r): Case => {
    const subject = S_PO({ supplier_id: r.supplier, items: r.items, note: "いつもの", ...r.extra }, { tool: r.tool, kind: r.kind });
    return {
      policy: {
        ...P0,
        autonomy: { ...AUTONOMY, mcp_write: r.mcpWrite },
        mcp: { ...P0.mcp, llmWrite: r.llmWrite },
        rules: { enabled: r.rulesEnabled, items: r.rules },
        guards: r.guards,
      },
      subject,
      counters: { ...C0, unknownOutcomeKeys: r.unknown, ...(r.repeat ? { repeatKey: repeatKeyOf(subject), repeatCount: 4 } : {}) },
      flags: { ...F0, certificateValid: r.cert },
      taint: { tainted: r.tainted, sources: [] },
    };
  });
const arbAll = fc.oneof(arbCase, arbNear);
const dec = (c: Case) => decide(c.policy, c.subject, c.counters, c.flags, c.taint);
const strip = ({ inputsHash: _h, ...rest }: DecideResult) => rest;
const deepFreeze = <V>(v: V): V => {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};
const RUNS = { numRuns: 400 };

describe("decide の性質（fast-check）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("X1：汚染を反転しても判定は同じで、inputsHash だけ変わる（BR-39・D-58）", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const a = dec(c);
        const b = dec({ ...c, taint: { ...c.taint, tainted: !c.taint.tainted } });
        expect(strip(b)).toEqual(strip(a));
        expect(b.inputsHash).not.toBe(a.inputsHash);
      }),
      RUNS,
    );
  });

  it("X2：origin を agent ↔ deliver にしても判定は同じで、inputsHash は変わる", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const a = dec({ ...c, subject: { ...c.subject, origin: "agent" } });
        const b = dec({ ...c, subject: { ...c.subject, origin: "deliver" } });
        expect(strip(b)).toEqual(strip(a));
        expect(b.inputsHash).not.toBe(a.inputsHash);
      }),
      RUNS,
    );
  });

  it("X3：型にないキー（shadow など）を足しても判定も inputsHash も同じ（BR-67）", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const extra: Case = {
          policy: { ...c.policy, shadow: true, budget: { ...c.policy.budget, per_rehearsal_usd: 0 } } as EffectivePolicy,
          subject: { ...c.subject, shadow: true, rehearsal_run_id: "r-1" } as Subject,
          counters: { ...c.counters, rehearsalCostUsd: 99 } as Counters,
          flags: { ...c.flags, shadow: true } as Flags,
          taint: { ...c.taint, shadow: true } as TaintState,
        };
        expect(dec(extra)).toEqual(dec(c));
      }),
      RUNS,
    );
  });

  it("X4：同じ入力なら同じ出力。入力を深く freeze しても例外にならない（入力を変えない）", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const a = dec(c);
        const frozen = deepFreeze(structuredClone(c));
        expect(dec(frozen)).toEqual(a);
        expect(dec(c)).toEqual(a);
      }),
      RUNS,
    );
  });

  it("X5：Date.now・Math.random を呼ばない", () => {
    const cases = fc.sample(arbAll, 300);
    const now = vi.spyOn(Date, "now");
    const rnd = vi.spyOn(Math, "random");
    for (const c of cases) {
      dec(c);
      recheckIntent(c.policy, c.subject, { unknownOutcomeKeys: c.counters.unknownOutcomeKeys, certificateValid: c.flags.certificateValid });
      nextCounters(c.counters, c.subject, dec(c), true);
    }
    expect(now).not.toHaveBeenCalled();
    expect(rnd).not.toHaveBeenCalled();
  });

  it("X6：mcp_write の allow は「有効なルールに一致・合格証あり・宛先が結果不明でない・ガードの範囲内」のときだけ（Hard Ceiling）", () => {
    let allowed = 0;
    fc.assert(
      fc.property(arbAll, (c) => {
        const r = dec(c);
        if (r.decision !== "allow" || r.operation !== "mcp_write") return;
        allowed++;
        const { subject: s, policy: p } = c;
        expect(r.reasonCode).toBe("rule_matched");
        expect(r.matchedRule).toMatch(/^rules\.items\[\d+\]$/);
        expect(c.flags.certificateValid).toBe(true);
        expect(p.rules.enabled).toBe(true);
        expect(s.tool!.classification).toBe("write");
        expect(c.counters.unknownOutcomeKeys).not.toContain(destinationKey(s.action!, s.args, s.tool!.argRoles));
        expect(firstGuardViolation(p.guards, s.action!, s.args)).toBeNull();
        const found = findMatchingRule(p.rules.items, s.action!, s.args, s.tool!, true);
        expect(found).toEqual({ matched: true, index: Number(/\d+/.exec(r.matchedRule!)![0]) });
      }),
      { numRuns: 1500 },
    );
    // 基準の近く（arbNear）から mcp_write の allow が十分に出ていること（期待値は40件ほど）
    expect(allowed).toBeGreaterThan(10);
  });

  it("X6 補足：mcp_write は autonomy_auto にならない（mcp_write: auto でもルール経由だけ）", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const p = { ...c.policy, autonomy: { ...c.policy.autonomy, mcp_write: "auto" as const } };
        const r = decide(p, c.subject, c.counters, c.flags, c.taint);
        if (r.operation === "mcp_write") expect(r.reasonCode).not.toBe("autonomy_auto");
      }),
      RUNS,
    );
  });

  it("X7：shell_network・merge・run_shell（SG-07）は allow にならない", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const r = dec(c);
        if (r.operation === "shell_network" || r.operation === "merge" || r.operation === "run_shell") expect(r.decision).not.toBe("allow");
      }),
      RUNS,
    );
  });

  it("X8：llm_call は halt か allow / not_gated だけ", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        if (c.subject.kind !== "llm_call") return;
        const r = dec(c);
        expect(r.decision === "halt" || (r.decision === "allow" && r.reasonCode === "not_gated")).toBe(true);
      }),
      RUNS,
    );
  });

  it("X9：unknownOutcomeKeys の順序を入れ替えても判定も inputsHash も同じ", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const reversed = { ...c, counters: { ...c.counters, unknownOutcomeKeys: [...c.counters.unknownOutcomeKeys].reverse() } };
        expect(dec(reversed)).toEqual(dec(c));
      }),
      RUNS,
    );
  });

  it("合格証がなければ mcp_write は allow にならない（BR-81）", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const r = dec({ ...c, flags: { ...c.flags, certificateValid: false } });
        expect(r.decision === "allow" && r.operation === "mcp_write").toBe(false);
      }),
      RUNS,
    );
  });

  it("品目の並べ替え（多重集合）で判定・理由・matchedRule は変わらない（repeatKey は順も含めて数えるので外す）", () => {
    fc.assert(
      fc.property(arbAll, (c0) => {
        const items = c0.subject.args.items;
        if (!Array.isArray(items) || items.length < 2) return;
        const c = { ...c0, counters: { ...c0.counters, repeatKey: null } };
        const a = dec(c);
        const b = dec({ ...c, subject: { ...c.subject, args: { ...c.subject.args, items: [...items].reverse() } } });
        expect([b.decision, b.reasonCode, b.matchedRule]).toEqual([a.decision, a.reasonCode, a.matchedRule]);
      }),
      RUNS,
    );
  });

  it("recheckIntent は、手順1〜3に当たらず Intent が0件のときの decide と同じ判定（M-20）", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const p: EffectivePolicy = {
          ...c.policy,
          budget: { per_task_usd: 20, per_day_usd: 200, agent_day_usd: null, max_steps: 200, max_minutes: 60 },
          breakers: { same_action_repeat: 20, denied_attempts_max: 20, step_cost_usd_max: 5 },
        };
        const ctx = { unknownOutcomeKeys: c.counters.unknownOutcomeKeys, certificateValid: c.flags.certificateValid };
        const a = decide(p, c.subject, { ...C0, unknownOutcomeKeys: ctx.unknownOutcomeKeys }, { ...F0, certificateValid: ctx.certificateValid }, c.taint);
        const b = recheckIntent(p, c.subject, ctx);
        expect(strip(b)).toEqual(strip(a));
      }),
      RUNS,
    );
  });

  it("operation は operationOf と同じ（none・unknown は null）", () => {
    fc.assert(
      fc.property(arbAll, (c) => {
        const op = operationOf(c.subject);
        expect(dec(c).operation).toBe(op === "none" || op === "unknown" ? null : op);
      }),
      RUNS,
    );
  });

  it("どの結果も inputsHash は接頭辞なしの64桁で、matchedRule は §4.2 の形", () => {
    const PATH =
      /^(budget\.(per_task_usd|per_day_usd|agent_day_usd|max_steps|max_minutes)|breakers\.(same_action_repeat|denied_attempts_max|step_cost_usd_max)|tools|mcp\.grants\..+|mcp\.(llmWrite|deliverWrite|llmRead)|max_intents_per_task|autonomy\.[a-z_]+|guards\[\d+\]|rules\.items\[\d+\])$/;
    fc.assert(
      fc.property(arbAll, (c) => {
        const r = dec(c);
        expect(r.inputsHash).toMatch(HEX64);
        if (r.matchedRule !== null) expect(r.matchedRule).toMatch(PATH);
      }),
      RUNS,
    );
  });
});
