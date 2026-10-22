import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.ts";
import { compose, composeAll, composeBoundary, effectivePolicyHash } from "./compose.ts";
import type { ComposeInput, PolicyViolation } from "./compose.ts";
import { decide } from "./decide.ts";
import { evaluateGuard, mergeGuards } from "./guards.ts";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_STRICTNESS,
  CATALOG_DEFAULT_AUTONOMY,
  DEFAULT_BREAKERS,
  DEFAULT_CEILINGS,
  TEMPLATES,
  clampAutonomyToCeiling,
  defaultWorkspacePolicy,
  stricterAutonomy,
  validateAgentDefinition,
  writableAutonomy,
} from "./policy.ts";
import type { AgentDefinitionInput, TemplateName, TemplateSpec, WorkspacePolicy } from "./policy.ts";
import { EMPTY_TAINT, OPERATION_TYPES } from "./types.ts";
import type { AutonomyLevel, Counters, DecideResult, EffectivePolicy, Flags, Guard, JsonObject, OperationType, ToolHash, ToolInfo } from "./types.ts";

/** 試験の例のコネクタ（ワークスペースで有効にするもの） */
const EXAMPLE_CONNECTORS = ["bank", "mail", "store", "supplier"];

// ---- フィクスチャ（KC §6 の前提：DEFAULT_CEILINGS、既定の ws（1日 $1 に固定）、§2.4 の仕入れ係（M-36 の付与）） ----

const H = (c: string): ToolHash => `sha256:${c.repeat(64)}`;
const PO = "mcp.supplier.place_order";
const T_PO: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: H("a"),
  argRoles: { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" },
};
const WS: WorkspacePolicy = pinDay1(defaultWorkspacePolicy(EXAMPLE_CONNECTORS));
/** 試験の ws は1日 $1 に固定する（既定は 10 だが、ここの期待値・保存したハッシュは per_day_usd 1 の ws で作った） */
function pinDay1(w: WorkspacePolicy): WorkspacePolicy {
  return { ...w, budget: { ...w.budget, per_day_usd: 1 } };
}
const BUYER: AgentDefinitionInput = {
  version: 2,
  name: "仕入れ係",
  role: "assist",
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
function ws(f?: (w: any) => void): WorkspacePolicy {
  const w = structuredClone(WS) as any;
  f?.(w);
  return w as WorkspacePolicy;
}
const input = (agent: AgentDefinitionInput, workspacePolicy: WorkspacePolicy = WS): ComposeInput => ({ ceilings: DEFAULT_CEILINGS, workspacePolicy, agent });
const run = (agent: AgentDefinitionInput, w: WorkspacePolicy = WS, jobId = "reorder") => compose(input(agent, w), jobId);
const eff = (agent: AgentDefinitionInput, w: WorkspacePolicy = WS, jobId = "reorder") => run(agent, w, jobId).effective;
const paths = (vs: readonly PolicyViolation[]) => vs.map((v) => v.path);

const writeSubject = (action: string, args: JsonObject, tool: ToolInfo) =>
  ({ kind: "tool_call", actionType: "mcp_call", action, args, paths: [], tool, origin: "agent" }) as const;
const decideWrite = (policy: EffectivePolicy, action: string, args: JsonObject, tool: ToolInfo, flags: Flags = FLAGS): DecideResult =>
  decide(policy, writeSubject(action, args, tool), COUNTERS, flags, EMPTY_TAINT);

describe("6.1 自律度の合成（KC §3.3 B1）", () => {
  it("C-01：ws mcp_write approve・定義なし → approve、違反なし", () => {
    const r = run(BUYER);
    expect(r.effective.autonomy.mcp_write).toBe("approve");
    expect(r.violations).toEqual([]);
    expect(r.clamped).toEqual([]);
  });
  it("C-02：定義 mcp_write deny → deny（厳しい方）、違反なし。等しい approve も違反でない", () => {
    expect(run(def((d) => (d.autonomy = { mcp_write: "deny" })))).toMatchObject({ effective: { autonomy: { mcp_write: "deny" } }, violations: [] });
    expect(run(def((d) => (d.autonomy = { mcp_write: "approve" })))).toMatchObject({ effective: { autonomy: { mcp_write: "approve" } }, violations: [] });
  });
  it("C-03：定義 mcp_write auto → approve、違反 by ceiling（limit は書ける値）、clamped 1件", () => {
    const r = run(def((d) => (d.autonomy = { mcp_write: "auto" })));
    expect(r.effective.autonomy.mcp_write).toBe("approve");
    expect(r.violations).toEqual([
      { code: "AGENT_EXCEEDS_POLICY", path: "autonomy.mcp_write", defined: "auto", limit: ["approve", "handoff", "deny"], by: "ceiling", message: expect.any(String) },
    ]);
    expect(r.clamped).toEqual([{ path: "autonomy.mcp_write", defined: "auto", effective: "approve" }]);
  });
  it("C-04：ws mcp_read approve・定義 auto → approve、違反 by policy（limit: approve）", () => {
    const r = run(def((d) => (d.autonomy = { mcp_read: "auto" })), ws((w) => (w.autonomy.mcp_read = "approve")));
    expect(r.effective.autonomy.mcp_read).toBe("approve");
    expect(r.violations).toMatchObject([{ path: "autonomy.mcp_read", defined: "auto", limit: "approve", by: "policy" }]);
  });
  it("C-05：ws mcp_read auto・定義 approve → approve、違反なし", () => {
    expect(run(def((d) => (d.autonomy = { mcp_read: "approve" })))).toMatchObject({ effective: { autonomy: { mcp_read: "approve" } }, violations: [] });
  });
  it("C-06：ws web_read approve（不正）・定義なし → deny、エージェントの違反なし", () => {
    const r = run(BUYER, ws((w) => (w.autonomy.web_read = "approve")));
    expect(r.effective.autonomy.web_read).toBe("deny");
    expect(r.violations).toEqual([]);
  });
  it("C-07：定義 merge approve → deny、違反 by ceiling", () => {
    const r = run(def((d) => (d.autonomy = { merge: "approve" })));
    expect(r.effective.autonomy.merge).toBe("deny");
    expect(r.violations).toMatchObject([{ path: "autonomy.merge", by: "ceiling", limit: ["deny"] }]);
  });
  it("C-08：定義 shell_network deny → deny、違反なし", () => {
    expect(run(def((d) => (d.autonomy = { shell_network: "deny" })))).toMatchObject({ effective: { autonomy: { shell_network: "deny" } }, violations: [] });
  });
  it("C-09：ws mcp_write auto（不正）→ approve に切り詰め（NFR-056）", () => {
    expect(eff(BUYER, ws((w) => (w.autonomy.mcp_write = "auto"))).autonomy.mcp_write).toBe("approve");
  });
  it("C-10：定義 notify approve → deny、違反 by ceiling（notify は auto/deny）", () => {
    const r = run(def((d) => (d.autonomy = { notify: "approve" })));
    expect(r.effective.autonomy.notify).toBe("deny");
    expect(r.violations).toMatchObject([{ path: "autonomy.notify", by: "ceiling", limit: ["auto", "deny"] }]);
  });
  it("C-11：定義 mcp_write handoff → handoff、違反なし（approve より厳しい）", () => {
    expect(run(def((d) => (d.autonomy = { mcp_write: "handoff" })))).toMatchObject({ effective: { autonomy: { mcp_write: "handoff" } }, violations: [] });
  });
  it("C-12：定義 mcp_read handoff → deny、違反 by ceiling（書けない値）", () => {
    const r = run(def((d) => (d.autonomy = { mcp_read: "handoff" })));
    expect(r.effective.autonomy.mcp_read).toBe("deny");
    expect(r.violations).toMatchObject([{ path: "autonomy.mcp_read", by: "ceiling" }]);
  });
  it("C-13：ws にない memory_write・定義なし → auto（カタログの既定）", () => {
    const w = ws((x) => delete x.autonomy.memory_write);
    expect(eff(BUYER, w).autonomy.memory_write).toBe("auto");
    expect(eff(BUYER, ws((x) => (x.autonomy = { web_read: "auto", notify: "auto", mcp_read: "auto", mcp_write: "approve" }))).autonomy).toEqual({
      ...CATALOG_DEFAULT_AUTONOMY,
      payment: "handoff",
    });
  });
  it("知らない自律度の値（スキーマを通らずに来たもの）は deny、違反 by ceiling", () => {
    const r = run(def((d) => (d.autonomy = { mcp_read: "allow" })));
    expect(r.effective.autonomy.mcp_read).toBe("deny");
    expect(r.violations).toMatchObject([{ path: "autonomy.mcp_read", by: "ceiling", defined: "allow" }]);
  });
  it("全キーを持つ（実効ポリシーは12の操作すべて）", () => {
    expect(Object.keys(eff(BUYER).autonomy).sort()).toEqual([...OPERATION_TYPES].sort());
  });
});

describe("6.2 予算・Breaker・回数（KC §3.3 B2〜B5）", () => {
  it("C-20：定義 per_task_usd 0.2 → 0.2", () => {
    expect(eff(BUYER).budget.per_task_usd).toBe(0.2);
  });
  it("C-21：定義 per_task_usd 0.5（ws と同じ）→ 0.5、違反なし", () => {
    expect(run(def((d) => (d.budget.per_task_usd = 0.5)))).toMatchObject({ effective: { budget: { per_task_usd: 0.5 } }, violations: [] });
  });
  it("C-22：定義 per_task_usd 0.51 → 0.5、違反 by policy、clamped {0.51 → 0.5}", () => {
    const r = run(def((d) => (d.budget.per_task_usd = 0.51)));
    expect(r.effective.budget.per_task_usd).toBe(0.5);
    expect(r.violations).toMatchObject([{ path: "budget.per_task_usd", defined: 0.51, limit: 0.5, by: "policy" }]);
    expect(r.clamped).toEqual([{ path: "budget.per_task_usd", defined: 0.51, effective: 0.5 }]);
  });
  it("C-23：定義 per_task_usd 25 → スキーマで AGENT_SCHEMA_INVALID。スキーマを通らずに来たら違反 by ceiling（limit は今書ける上限）", () => {
    const d = def((x) => (x.budget.per_task_usd = 25));
    expect(validateAgentDefinition(d).ok).toBe(false);
    const r = run(d);
    expect(r.effective.budget.per_task_usd).toBe(0.5);
    expect(r.violations).toMatchObject([{ path: "budget.per_task_usd", defined: 25, limit: 0.5, by: "ceiling" }]);
  });
  it("C-24：ws per_task_usd 30（不正）・定義なし → 20（Hard Ceiling）", () => {
    const r = run(def((d) => delete d.budget.per_task_usd), ws((w) => (w.budget.per_task_usd = 30)));
    expect(r.effective.budget.per_task_usd).toBe(20);
    expect(r.violations).toEqual([]);
  });
  it("C-25：定義 per_day_usd なし → agent_day_usd = null、per_day_usd = 1", () => {
    expect(eff(def((d) => delete d.budget.per_day_usd)).budget).toMatchObject({ agent_day_usd: null, per_day_usd: 1 });
  });
  it("C-26：定義 per_day_usd 1（ws と同じ）→ agent_day_usd = 1、違反なし", () => {
    expect(run(BUYER)).toMatchObject({ effective: { budget: { agent_day_usd: 1, per_day_usd: 1 } }, violations: [] });
  });
  it("C-27：定義 per_day_usd 2・ws 1 → agent_day_usd = 1、違反 by policy（KC §8 #11）", () => {
    const r = run(def((d) => (d.budget.per_day_usd = 2)));
    expect(r.effective.budget).toMatchObject({ agent_day_usd: 1, per_day_usd: 1 });
    expect(r.violations).toMatchObject([{ path: "budget.per_day_usd", defined: 2, limit: 1, by: "policy" }]);
  });
  it("既定の ws（per_day 10）では per_day_usd = 10・agent_day_usd = 1（両方が別々に効く）", () => {
    expect(eff(BUYER, defaultWorkspacePolicy(EXAMPLE_CONNECTORS)).budget).toMatchObject({ per_day_usd: 10, agent_day_usd: 1 });
  });
  it("C-28：定義 max_steps 41・ws 40 → 40、違反", () => {
    const r = run(def((d) => (d.budget.max_steps = 41)));
    expect(r.effective.budget.max_steps).toBe(40);
    expect(paths(r.violations)).toEqual(["budget.max_steps"]);
  });
  it("C-29：定義 max_minutes 15・ws 15 → 15、違反なし", () => {
    expect(run(def((d) => (d.budget.max_minutes = 15)))).toMatchObject({ effective: { budget: { max_minutes: 15 } }, violations: [] });
  });
  it("max_minutes は ws が 60 でも Hard Ceiling の 55（M-59）", () => {
    expect(eff(BUYER, ws((w) => (w.budget.max_minutes = 60))).budget.max_minutes).toBe(55);
  });
  it("C-30：ws に breakers がない → 推奨既定（5・3・0.5）", () => {
    expect(eff(BUYER, ws((w) => delete w.breakers)).breakers).toEqual({ same_action_repeat: 5, denied_attempts_max: 3, step_cost_usd_max: 0.5 });
    expect(eff(BUYER, ws((w) => (w.breakers = { denied_attempts_max: 2 }))).breakers).toEqual({ ...DEFAULT_BREAKERS, denied_attempts_max: 2 });
  });
  it("C-31：定義 same_action_repeat 6・ws 5 → 5、違反", () => {
    const r = run(def((d) => (d.breakers = { same_action_repeat: 6, step_cost_usd_max: 0.1 })));
    expect(r.effective.breakers).toEqual({ same_action_repeat: 5, denied_attempts_max: 3, step_cost_usd_max: 0.1 });
    expect(r.violations).toMatchObject([{ path: "breakers.same_action_repeat", defined: 6, limit: 5, by: "policy" }]);
  });
  it("C-32：max_runs_per_day 50 → 50", () => {
    expect(run(def((d) => (d.max_runs_per_day = 50)))).toMatchObject({ effective: { max_runs_per_day: 50 }, violations: [] });
  });
  it("C-33：max_runs_per_day 51 → スキーマで拒否。スキーマを通らずに来たら 50 に切り詰めて違反 by ceiling", () => {
    const d = def((x) => (x.max_runs_per_day = 51));
    expect(validateAgentDefinition(d).ok).toBe(false);
    const r = run(d);
    expect(r.effective.max_runs_per_day).toBe(50);
    expect(r.violations).toMatchObject([{ path: "max_runs_per_day", by: "ceiling", limit: 50 }]);
  });
  it("C-34：max_runs_per_day 0 → スキーマで拒否（1〜50）。合成は厳しい方のまま 0", () => {
    const d = def((x) => (x.max_runs_per_day = 0));
    expect(validateAgentDefinition(d).ok).toBe(false);
    expect(run(d)).toMatchObject({ effective: { max_runs_per_day: 0 }, violations: [] });
  });
  it("max_runs_per_day の欠けは 10（最初の境界）", () => {
    expect(eff(def((d) => delete d.max_runs_per_day)).max_runs_per_day).toBe(10);
  });
  it("C-35：ws max_intents_per_task 省略 → 5", () => {
    expect(eff(BUYER, ws((w) => delete w.max_intents_per_task)).max_intents_per_task).toBe(5);
  });
  it("C-36：ws max_intents_per_task 25（不正）→ 20", () => {
    expect(eff(BUYER, ws((w) => (w.max_intents_per_task = 25))).max_intents_per_task).toBe(20);
  });
  it("ws の null は既定値に倒さない（自律度は deny、数値は例外）", () => {
    expect(eff(BUYER, ws((w) => (w.autonomy.mcp_read = null))).autonomy.mcp_read).toBe("deny");
    expect(() => run(BUYER, ws((w) => (w.max_intents_per_task = null)))).toThrow(TypeError);
    expect(() => run(BUYER, ws((w) => (w.breakers = { same_action_repeat: null })))).toThrow(TypeError);
  });
  it("有限でない数値は例外（判定できない入力。NFR-005）", () => {
    expect(() => run(def((d) => (d.budget.per_task_usd = Number.NaN)))).toThrow(TypeError);
    expect(() => run(BUYER, ws((w) => (w.budget.per_day_usd = Number.POSITIVE_INFINITY)))).toThrow(TypeError);
    expect(() => run(def((d) => (d.budget.max_steps = "40")))).toThrow(TypeError);
  });
});

describe("6.3 付与・テンプレート・ツール（KC §3.3 B6・B7・J1・J2）", () => {
  it("C-40：付与 supplier [place_order, list_products]（順不同）→ 昇順", () => {
    const e = eff(def((d) => (d.grants.connectors.supplier.grant = ["place_order", "list_products"])));
    expect(e.mcp.grants).toEqual({ bank: ["register_payee"], store: ["get_inventory"], supplier: ["list_products", "place_order"] });
    expect(Object.keys(e.mcp.grants)).toEqual(["bank", "store", "supplier"]);
  });
  it("C-41：付与 gmail [send]・ws の enabled に gmail がない → effective に入らない、違反 by policy（BR-20）", () => {
    const r = run(def((d) => (d.grants.connectors.gmail = { grant: ["send"] })));
    expect(r.effective.mcp.grants).not.toHaveProperty("gmail");
    expect(r.violations).toEqual([
      { code: "AGENT_EXCEEDS_POLICY", path: "grants.connectors.gmail", defined: ["send"], limit: ["bank", "mail", "store", "supplier"], by: "policy", message: expect.any(String) },
    ]);
    expect(r.clamped).toEqual([{ path: "grants.connectors.gmail", defined: ["send"], effective: [] }]);
  });
  it("C-42：付与 supplier [] → キーごと消える", () => {
    expect(eff(def((d) => (d.grants.connectors.supplier.grant = []))).mcp.grants).not.toHaveProperty("supplier");
  });
  it("C-43：assistant・Web の付与なし → tools = [finish, mcp_call, notify, submit_report]、llmWrite = true", () => {
    const e = eff(BUYER);
    expect(e.tools).toEqual(["finish", "mcp_call", "notify", "submit_report"]);
    expect(e.mcp).toMatchObject({ llmRead: true, llmWrite: true, deliverWrite: true });
  });
  it("C-44：researcher・付与あり → llmRead true・llmWrite false・deliverWrite true", () => {
    expect(eff(def((d) => (d.jobs[0].template = "researcher"))).mcp).toMatchObject({ llmRead: true, llmWrite: false, deliverWrite: true });
  });
  it("C-45：watcher → llmWrite false・deliverWrite false。テンプレートを差し替えても Hard Ceiling で false（BR-40）", () => {
    const d = def((x) => (x.jobs[0].template = "watcher"));
    expect(eff(d).mcp).toMatchObject({ llmRead: true, llmWrite: false, deliverWrite: false });
    const evil: Record<TemplateName, TemplateSpec> = { ...TEMPLATES, watcher: { ...TEMPLATES.watcher, mcpLlm: "read_write", mcpDeliverWrite: true } };
    expect(compose({ ...input(d), templates: evil }, "reorder").effective.mcp).toMatchObject({ llmWrite: false, deliverWrite: false });
  });
  it("C-46：researcher・付与も Web もなし → [finish, notify, submit_report]（mcp_call・Web が外れる）", () => {
    const e = eff(def((d) => ((d.jobs[0].template = "researcher"), (d.grants = { connectors: {} }))));
    expect(e.tools).toEqual(["finish", "notify", "submit_report"]);
    expect(e.mcp.grants).toEqual({});
  });
  it("C-47：assistant・grants.web.allow_domains = ['*'] → web_fetch・web_search が入る", () => {
    const e = eff(def((d) => (d.grants.web = { allow_domains: ["*"] })));
    expect(e.tools).toEqual(["finish", "mcp_call", "notify", "submit_report", "web_fetch", "web_search"]);
    expect(e.web.allow_domains).toEqual(["*"]);
  });
  it("C-48：どのテンプレートでも remember・load_skill はない（テンプレートが持っていても外す）", () => {
    for (const t of ["researcher", "briefer", "watcher", "assistant"] as const) {
      const e = eff(def((d) => ((d.jobs[0].template = t), (d.grants.web = { allow_domains: ["*"] }))));
      expect(e.tools).not.toContain("remember");
      expect(e.tools).not.toContain("load_skill");
    }
    const withMemory: Record<TemplateName, TemplateSpec> = {
      ...TEMPLATES,
      assistant: { ...TEMPLATES.assistant, tools: [...TEMPLATES.assistant.tools, "remember", "load_skill", "nope" as never] },
    };
    expect(compose({ ...input(BUYER), templates: withMemory }, "reorder").effective.tools).toEqual(["finish", "mcp_call", "notify", "submit_report"]);
  });
  it("C-49：dev-coder（実装：D-116）はスキーマを通り、作業場の道具を持つ。MCP は何も持たない（外へ書かない）", () => {
    const d = def((x) => (x.jobs[0].template = "dev-coder"));
    expect(validateAgentDefinition(d).ok).toBe(true);
    const e = eff(d);
    expect(e.tools).toEqual(expect.arrayContaining(["list_files", "read_file", "write_file", "run_command", "submit_report"]));
    expect(e.tools).not.toContain("mcp_call");
    expect(e.mcp).toMatchObject({ llmRead: false, llmWrite: false, deliverWrite: false });
  });
  it("C-50：存在しない jobId → 例外。知らないテンプレートも例外", () => {
    expect(() => run(BUYER, WS, "nope")).toThrow(TypeError);
    expect(() => run(def((d) => (d.jobs[0].template = "unknown")))).toThrow(TypeError);
  });
  it("C-51：repoPolicy を渡す → 例外（Won't）", () => {
    expect(() => compose({ ...input(BUYER), repoPolicy: { version: 1 } } as unknown as ComposeInput, "reorder")).toThrow(TypeError);
    expect(() => composeAll({ ...input(BUYER), repoPolicy: {} } as unknown as ComposeInput)).toThrow(TypeError);
  });
  it("C-52：仕事が0件の定義で composeAll → jobs = {}、境界の違反は計算される", () => {
    const r = composeAll(input(def((d) => ((d.jobs = []), (d.autonomy = { mcp_write: "auto" })))));
    expect(r.jobs).toEqual({});
    expect(paths(r.violations)).toEqual(["autonomy.mcp_write"]);
    expect(r.boundary.autonomy.mcp_write).toBe("approve");
  });
  it("composeAll は仕事ごとに実効ポリシーとハッシュを持つ（D-19）。境界は同じ、テンプレートの違いだけ差が出る", () => {
    const d = def((x) => x.jobs.push({ id: "watch-mail", kind: "recurring", template: "researcher", instructions: "x" }));
    const r = composeAll(input(d));
    expect(Object.keys(r.jobs)).toEqual(["reorder", "watch-mail"]);
    expect(r.jobs["reorder"]!.effective.mcp.llmWrite).toBe(true);
    expect(r.jobs["watch-mail"]!.effective.mcp.llmWrite).toBe(false);
    expect(r.jobs["reorder"]!.effectivePolicyHash).not.toBe(r.jobs["watch-mail"]!.effectivePolicyHash);
    expect(r.jobs["reorder"]).toEqual(compose(input(d), "reorder"));
  });
  it("仕事の id が重複した定義は例外（スキーマが拒否するもの）", () => {
    expect(() => composeAll(input(def((d) => d.jobs.push({ ...d.jobs[0] }))))).toThrow(TypeError);
  });
  it("B7 Web：deny はワークスペース ∪ Hard Ceiling（trim・小文字・昇順）、max_fetches は小さい方。allow は定義の付与（正規化済み）", () => {
    const e = eff(
      def((d) => (d.grants.web = { allow_domains: ["News.example.com", "*.example.org"] })),
      ws((w) => ((w.web.deny_domains = [" Evil.example ", "localhost"]), (w.web.max_fetches_per_task = 50))),
    );
    expect(e.web).toEqual({ allow_domains: ["*.example.org", "news.example.com"], deny_domains: ["*.internal", "evil.example", "localhost"], max_fetches_per_task: 30 });
  });
  it("B8 ルール：判定に効く項目だけ（labels・added_* は入れない）、id の昇順、ws の rules.enabled が false でも項目は残す", () => {
    const rule = (id: string) => ({
      id,
      action: PO,
      match: { supplier_id: " supplier-01 " },
      free: ["items[].quantity"],
      labels: { supplier_id: "山田珈琲" },
      tool_hash: H("a"),
      added_by: "u",
      added_at: "2026-10-03T18:00:00+09:00",
      source_intent_id: "i-1",
    });
    const e = eff(def((d) => (d.rules = [rule("r-2"), rule("r-1")])), ws((w) => (w.rules.enabled = false)));
    expect(e.rules).toEqual({
      enabled: false,
      items: [
        { id: "r-1", action: PO, match: { supplier_id: "supplier-01" }, free: ["items[].quantity"], tool_hash: H("a") },
        { id: "r-2", action: PO, match: { supplier_id: "supplier-01" }, free: ["items[].quantity"], tool_hash: H("a") },
      ],
    });
  });
  it("B9 承認者：ws に承認者があれば定義はその部分集合（外れたら違反・外す）。0-H は空", () => {
    expect(eff(BUYER).approvers).toEqual([]);
    const w = ws((x) => (x.approvers = ["u1", "u2"]));
    expect(eff(BUYER, w).approvers).toEqual(["u1", "u2"]);
    expect(run(def((d) => (d.approvers = ["u2"])), w)).toMatchObject({ effective: { approvers: ["u2"] }, violations: [] });
    const r = run(def((d) => (d.approvers = ["u2", "u9"])), w);
    expect(r.effective.approvers).toEqual(["u2"]);
    expect(r.violations).toMatchObject([{ path: "approvers", by: "policy", defined: ["u2", "u9"], limit: ["u1", "u2"] }]);
    // 誰も残らなければ ws の承認者（空にすると BR-14 の既定に広がる）
    expect(run(def((d) => (d.approvers = ["u9"])), w).effective.approvers).toEqual(["u1", "u2"]);
    expect(eff(def((d) => (d.approvers = ["u9"]))).approvers).toEqual(["u9"]);
  });
  it("違反と clamped は同じ計算（1対1、同じ順）", () => {
    const r = run(
      def((d) => {
        d.autonomy = { mcp_write: "auto", web_read: "approve" };
        d.budget = { per_task_usd: 1, per_day_usd: 3, max_steps: 100 };
        d.grants.connectors.gmail = { grant: ["send"] };
      }),
    );
    expect(paths(r.violations)).toEqual(["autonomy.web_read", "autonomy.mcp_write", "budget.per_task_usd", "budget.max_steps", "budget.per_day_usd", "grants.connectors.gmail"]);
    expect(r.clamped.map((c) => c.path)).toEqual(paths(r.violations));
  });
});

describe("decide() とのつなぎ（compose の出力をそのまま渡す：ADR-012・M-01）", () => {
  const args = { supplier_id: "supplier-01", items: [{ sku: "BEAN-HOUSE", quantity: 20, unit_price: 700 }], note: "いつもの" };
  it("assistant の LLM の書き込みは承認へ（approval_required）", () => {
    expect(decideWrite(eff(BUYER), PO, args, T_PO)).toMatchObject({ decision: "approve", reasonCode: "approval_required", matchedRule: "autonomy.mcp_write" });
  });
  it("researcher の LLM は書き込みを呼べない（not_granted・mcp.llmWrite：M-14）", () => {
    expect(decideWrite(eff(def((d) => (d.jobs[0].template = "researcher"))), PO, args, T_PO)).toMatchObject({ decision: "deny", matchedRule: "mcp.llmWrite" });
  });
  it("watcher の届け先は書き込めない（deliver_write）", () => {
    const e = eff(def((d) => (d.jobs[0].template = "watcher")));
    const r = decide(e, { ...writeSubject(PO, args, T_PO), kind: "intent", origin: "deliver" }, COUNTERS, FLAGS, EMPTY_TAINT);
    expect(r).toMatchObject({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.deliverWrite" });
  });
  it("ws で有効でないコネクタのツールは付与から外れて not_granted", () => {
    const e = eff(BUYER, ws((w) => (w.connectors.enabled = ["store", "bank", "mail"])));
    expect(decideWrite(e, PO, args, T_PO)).toMatchObject({ decision: "deny", reasonCode: "not_granted", matchedRule: "mcp.grants.supplier" });
  });
});

describe("6.4 ガードの合成（compose の J3：mergeGuards をそのまま使う）", () => {
  const withGuards = (guards: Guard[]) => eff(def((d) => (d.jobs[0].guards = guards)));
  const g = (arg: string, c: object, action = PO): Guard => ({ action, arg, ...c });
  it("G-01：1つならそのまま（empty: false）", () => {
    expect(withGuards([g("items[].quantity", { max: 20 })]).guards).toEqual([{ action: PO, arg: "items[].quantity", max: 20, empty: false }]);
  });
  it("G-02・G-03：max は小さい方、min は大きい方", () => {
    expect(withGuards([g("q", { max: 20 }), g("q", { max: 10 })]).guards).toMatchObject([{ max: 10 }]);
    expect(withGuards([g("q", { min: 1 }), g("q", { min: 5 })]).guards).toMatchObject([{ min: 5 }]);
  });
  it("G-04・G-05：min === max は空でない、min > max は空", () => {
    expect(withGuards([g("q", { min: 5 }), g("q", { max: 5 })]).guards).toEqual([{ action: PO, arg: "q", min: 5, max: 5, empty: false }]);
    expect(withGuards([g("q", { min: 6 }), g("q", { max: 5 })]).guards[0]!.empty).toBe(true);
  });
  it("G-06・G-07：in は積集合、積が空なら空", () => {
    expect(withGuards([g("sku", { in: ["A", "B"] }), g("sku", { in: ["B", "C"] })]).guards).toEqual([{ action: PO, arg: "sku", in: ["B"], empty: false }]);
    expect(withGuards([g("sku", { in: ["A"] }), g("sku", { in: ["B"] })]).guards).toEqual([{ action: PO, arg: "sku", in: [], empty: true }]);
  });
  it("G-08・G-09：数値と in が重なると空。max_digits は小さい方", () => {
    expect(withGuards([g("x", { max: 5 }), g("x", { in: ["a"] })]).guards[0]!.empty).toBe(true);
    expect(withGuards([g("x", { max_digits: 4 }), g("x", { max_digits: 3 })]).guards).toMatchObject([{ max_digits: 3, empty: false }]);
  });
  it("G-10・G-11：別の action の同名の arg は別々。入力の順を変えても (action, arg) の昇順で同じ", () => {
    const list = [g("b", { max: 1 }), g("a", { max: 2 }), g("a", { min: 0 }, "mcp.store.adjust"), g("q", { max: 3 }, "mcp.store.adjust")];
    const out = withGuards(list).guards;
    expect(out.map((x) => `${x.action}|${x.arg}`)).toEqual(["mcp.store.adjust|a", "mcp.store.adjust|q", `${PO}|a`, `${PO}|b`]);
    expect(withGuards([...list].reverse()).guards).toEqual(out);
    expect(out).toEqual(mergeGuards(list));
  });
  it("G-12：in の ' A '・'A' は 'A' 1つ（定義の正規化と mergeGuards の両方で trim）", () => {
    expect(withGuards([g("sku", { in: [" A ", "A"] })]).guards).toMatchObject([{ in: ["A"] }]);
  });
  it("ガードは仕事ごと（別の仕事のガードは効かない）", () => {
    const d = def((x) => {
      x.jobs[0].guards = [g("items[].quantity", { max: 20 })];
      x.jobs.push({ id: "other", kind: "once", template: "assistant", instructions: "x" });
    });
    expect(eff(d, WS, "other").guards).toEqual([]);
  });
});

describe("6.5 ガードの評価（合成した実効ポリシーで decide の手順10。ルールがあっても承認へ：BR-61）", () => {
  // どの発注も一致する（option をすべて変わってよいにした）ルールを置き、ガードだけで allow / approve が分かれるようにする
  const SP = "mcp.shop.set_price";
  const DEPS = "mcp.repo.update_deps";
  const T_SP: ToolInfo = { ...T_PO, toolHash: H("e"), argRoles: { item: "destination", price: "option", qty: "option" } };
  const T_DEPS: ToolInfo = { ...T_PO, toolHash: H("f"), argRoles: { repo: "destination", "packages[].name": "option" } };
  const W = ws((w) => (w.connectors.enabled = ["supplier", "shop", "repo"]));
  const rule = (id: string, action: string, match: object, free: string[], tool_hash: ToolHash) => ({
    id,
    action,
    match,
    free,
    tool_hash,
    added_by: "u",
    added_at: "2026-10-03T18:00:00+09:00",
  });
  const D = (guards: Guard[]) =>
    def((d) => {
      d.grants.connectors = { supplier: { grant: ["place_order"] }, shop: { grant: ["set_price"] }, repo: { grant: ["update_deps"] } };
      d.rules = [
        rule("r-po", PO, { supplier_id: "supplier-01" }, ["items[].sku", "items[].quantity", "items[].unit_price"], T_PO.toolHash),
        rule("r-sp", SP, { item: "beans" }, ["price", "qty"], T_SP.toolHash),
        rule("r-deps", DEPS, { repo: "shop-web" }, ["packages[].name"], T_DEPS.toolHash),
      ];
      d.jobs[0].guards = guards;
    });
  const check = (guard: Omit<Guard, "action">, action: string, tool: ToolInfo, args: JsonObject) => {
    const e = eff(D([{ action, ...guard }]), W);
    const result = decideWrite(e, action, args, tool);
    const evaluation = evaluateGuard(e.guards[0]!, args);
    return { result, evaluation, effective: e };
  };
  const po = (items: unknown) => ({ supplier_id: "supplier-01", items, note: "x" }) as JsonObject;
  const QTY = { arg: "items[].quantity", max: 20 };
  const allowed = (r: DecideResult) => expect(r).toMatchObject({ decision: "allow", reasonCode: "rule_matched" });
  const stopped = (r: DecideResult, argPath: string) =>
    expect(r).toMatchObject({ decision: "approve", reasonCode: "guard_exceeded", matchedRule: "guards[0]", detail: { kind: "guard", argPath } });

  it("E-01：items[].quantity max 20 に 20 → 通る（ちょうど）。ルールで allow", () => {
    const c = check(QTY, PO, T_PO, po([{ sku: "BEAN", quantity: 20, unit_price: 700 }]));
    allowed(c.result);
    expect(c.evaluation).toEqual({ ok: true });
  });
  it("E-02：21 → above_max（ルールに一致していても承認へ）", () => {
    const c = check(QTY, PO, T_PO, po([{ sku: "BEAN", quantity: 21, unit_price: 700 }]));
    stopped(c.result, "items[0].quantity");
    expect(c.evaluation).toMatchObject({ ok: false, reason: "above_max", value: 21 });
  });
  it("E-03：[5, 200] → 1要素でも外れれば外れ（items[1].quantity）", () => {
    const c = check(QTY, PO, T_PO, po([{ sku: "A", quantity: 5, unit_price: 1 }, { sku: "B", quantity: 200, unit_price: 1 }]));
    stopped(c.result, "items[1].quantity");
  });
  it("E-04・E-05：空配列・items なし → not_found（外れ）", () => {
    stopped(check(QTY, PO, T_PO, po([])).result, "items[].quantity");
    expect(check(QTY, PO, T_PO, po([])).evaluation).toMatchObject({ reason: "not_found" });
    const noItems = { supplier_id: "supplier-01" };
    expect(check(QTY, PO, T_PO, noItems).result).toMatchObject({ decision: "approve", reasonCode: "guard_exceeded" });
    expect(check(QTY, PO, T_PO, noItems).evaluation).toMatchObject({ reason: "not_found" });
  });
  it("E-06：要素に quantity がない → not_found", () => {
    const c = check(QTY, PO, T_PO, po([{ sku: "A" }]));
    stopped(c.result, "items[0].quantity");
    expect(c.evaluation).toMatchObject({ reason: "not_found", found: false });
  });
  it("E-07：'20'（数字の文字列）→ type", () => {
    const c = check(QTY, PO, T_PO, po([{ sku: "A", quantity: "20", unit_price: 1 }]));
    stopped(c.result, "items[0].quantity");
    expect(c.evaluation).toMatchObject({ reason: "type" });
  });
  it("E-08：items が配列でない → not_found", () => {
    const c = check(QTY, PO, T_PO, po({ quantity: 1 }));
    expect(c.result).toMatchObject({ decision: "approve", reasonCode: "guard_exceeded" });
    expect(c.evaluation).toMatchObject({ reason: "not_found" });
  });
  it("E-09：items[].unit_price max 800 に 800 / 801 / 2400（F-05 の3倍）", () => {
    const UP = { arg: "items[].unit_price", max: 800 };
    allowed(check(UP, PO, T_PO, po([{ sku: "A", quantity: 1, unit_price: 800 }])).result);
    stopped(check(UP, PO, T_PO, po([{ sku: "A", quantity: 1, unit_price: 801 }])).result, "items[0].unit_price");
    const c = check(UP, PO, T_PO, po([{ sku: "A", quantity: 1, unit_price: 2400 }]));
    stopped(c.result, "items[0].unit_price");
    expect(c.evaluation).toMatchObject({ reason: "above_max" });
  });
  it("E-10：qty min 1 に 0 / 1", () => {
    const c0 = check({ arg: "qty", min: 1 }, SP, T_SP, { item: "beans", qty: 0, price: 1 });
    stopped(c0.result, "qty");
    expect(c0.evaluation).toMatchObject({ reason: "below_min" });
    allowed(check({ arg: "qty", min: 1 }, SP, T_SP, { item: "beans", qty: 1, price: 1 }).result);
  });
  it("E-11：price max_digits 3 に 999 / 1000 / 0.5 / -999", () => {
    const G = { arg: "price", max_digits: 3 };
    allowed(check(G, SP, T_SP, { item: "beans", price: 999, qty: 1 }).result);
    const c = check(G, SP, T_SP, { item: "beans", price: 1000, qty: 1 });
    stopped(c.result, "price");
    expect(c.evaluation).toMatchObject({ reason: "too_many_digits" });
    allowed(check(G, SP, T_SP, { item: "beans", price: 0.5, qty: 1 }).result);
    allowed(check(G, SP, T_SP, { item: "beans", price: -999, qty: 1 }).result);
  });
  it("E-12〜E-14：packages[].name in [left-pad, lodash]。F-12 の 1eft-pad は not_in、前後の空白は除く、大文字小文字は区別", () => {
    const G = { arg: "packages[].name", in: ["left-pad", "lodash"] };
    const deps = (name: string) => ({ repo: "shop-web", packages: [{ name }] });
    allowed(check(G, DEPS, T_DEPS, deps("left-pad")).result);
    const typo = check(G, DEPS, T_DEPS, deps("1eft-pad"));
    stopped(typo.result, "packages[0].name");
    expect(typo.evaluation).toMatchObject({ reason: "not_in" });
    expect(check(G, DEPS, T_DEPS, deps(" left-pad ")).evaluation).toEqual({ ok: true });
    expect(check(G, DEPS, T_DEPS, deps("Left-pad")).evaluation).toMatchObject({ reason: "not_in" });
  });
  it("E-15：empty のガード（同じ引数に min 6 と max 5）→ 何でも empty", () => {
    const e = eff(D([{ action: PO, arg: "items[].quantity", min: 6 }, { action: PO, arg: "items[].quantity", max: 5 }]), W);
    expect(e.guards).toMatchObject([{ empty: true }]);
    const args = po([{ sku: "A", quantity: 5, unit_price: 1 }]);
    expect(evaluateGuard(e.guards[0]!, args)).toMatchObject({ ok: false, reason: "empty" });
    expect(decideWrite(e, PO, args, T_PO)).toMatchObject({ decision: "approve", reasonCode: "guard_exceeded" });
  });
  it("E-16：qty max 20 に NaN / Infinity → type。decide は判定できない入力として例外（許可しない）", () => {
    const e = eff(D([{ action: SP, arg: "qty", max: 20 }]), W);
    expect(evaluateGuard(e.guards[0]!, { item: "beans", qty: Number.NaN })).toMatchObject({ reason: "type" });
    expect(evaluateGuard(e.guards[0]!, { item: "beans", qty: Number.POSITIVE_INFINITY })).toMatchObject({ reason: "type" });
    expect(() => decideWrite(e, SP, { item: "beans", qty: Number.NaN }, T_SP)).toThrow();
  });
  it("E-17：qty null → type（値ありとして外れ）", () => {
    const c = check({ arg: "qty", max: 20 }, SP, T_SP, { item: "beans", qty: null, price: 1 });
    stopped(c.result, "qty");
    expect(c.evaluation).toMatchObject({ reason: "type" });
  });
});

describe("6.6 ルールの一致（合成した実効ポリシーで decide の手順11）", () => {
  const R = (over: object = {}) => ({
    id: "r-1",
    action: PO,
    match: { supplier_id: "supplier-01", "items[].sku": ["BEAN"] },
    free: ["items[].quantity", "items[].unit_price"],
    tool_hash: H("a"),
    added_by: "u",
    added_at: "2026-10-03T18:00:00+09:00",
    ...over,
  });
  const withRule = (over: object = {}) => eff(def((d) => (d.rules = [R(over)])));
  const A = (over: object = {}) => ({ supplier_id: "supplier-01", items: [{ sku: "BEAN", quantity: 20, unit_price: 700 }], note: "いつもの", ...over }) as JsonObject;
  const allows = (e: EffectivePolicy, args: JsonObject, tool = T_PO) => decideWrite(e, PO, args, tool).decision === "allow";
  it("R-01：宛先と sku が一致し、数量・単価は free → allow（rule_matched・rules.items[0]）", () => {
    expect(decideWrite(withRule(), PO, A(), T_PO)).toMatchObject({ decision: "allow", reasonCode: "rule_matched", matchedRule: "rules.items[0]" });
  });
  it("R-02：supplier-02 → 不一致（宛先が違う。F-03 系）", () => {
    expect(decideWrite(withRule(), PO, A({ supplier_id: "supplier-02" }), T_PO)).toMatchObject({
      decision: "approve",
      reasonCode: "approval_required",
      detail: { kind: "rule_mismatch", argPath: "supplier_id", role: "destination" },
    });
  });
  it("R-03：' supplier-01 ' → 一致（前後の空白）", () => {
    expect(allows(withRule(), A({ supplier_id: " supplier-01 " }))).toBe(true);
  });
  it("R-04：sku が [BEAN, MILK] → 不一致（要素の増減）", () => {
    const items = [{ sku: "BEAN", quantity: 1, unit_price: 1 }, { sku: "MILK", quantity: 1, unit_price: 1 }];
    expect(allows(withRule(), A({ items }))).toBe(false);
  });
  it("R-05：ルールの sku [BEAN, MILK] に要素の順が逆 → 一致（集合）。同じ sku を2行に分けると不一致（M-09 多重集合）", () => {
    const e = withRule({ match: { supplier_id: "supplier-01", "items[].sku": ["MILK", "BEAN"] } });
    expect(allows(e, A({ items: [{ sku: "MILK", quantity: 1, unit_price: 1 }, { sku: "BEAN", quantity: 1, unit_price: 1 }] }))).toBe(true);
    expect(allows(withRule(), A({ items: [{ sku: "BEAN", quantity: 10, unit_price: 1 }, { sku: "BEAN", quantity: 10, unit_price: 1 }] }))).toBe(false);
  });
  it("R-06：数量を固定（[20]）したルールに数量 30 → 不一致、20 → 一致", () => {
    const e = withRule({ match: { supplier_id: "supplier-01", "items[].sku": ["BEAN"], "items[].quantity": [20] }, free: ["items[].unit_price"] });
    expect(allows(e, A({ items: [{ sku: "BEAN", quantity: 30, unit_price: 700 }] }))).toBe(false);
    expect(allows(e, A())).toBe(true);
  });
  it("R-07・R-08・R-09：match に宛先がない・free に宛先・tool_hash が違う → どれも効かない", () => {
    expect(allows(withRule({ match: { "items[].sku": ["BEAN"] } }), A())).toBe(false);
    expect(allows(withRule({ free: ["supplier_id", "items[].quantity", "items[].unit_price"] }), A())).toBe(false);
    expect(allows(withRule({ tool_hash: H("9") }), A())).toBe(false);
  });
  it("R-10：ツールに役割のない ship_to（destination）が増えた → 網羅の条件で効かない（BR-56）", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, ship_to: "destination" } };
    expect(allows(withRule(), A(), tool)).toBe(false);
  });
  it("R-11・R-12：match にも free にもない option rush は「なし」で固定（BR-69・M-11）", () => {
    const tool: ToolInfo = { ...T_PO, argRoles: { ...T_PO.argRoles, rush: "option" } };
    expect(allows(withRule(), A({ rush: true }), tool)).toBe(false);
    expect(allows(withRule(), A(), tool)).toBe(true);
  });
  it("R-13：content（note）は比べない", () => {
    expect(allows(withRule(), A({ note: "毎回違う中身" }))).toBe(true);
  });
  it("ws の rules.enabled が false ならルールは効かない（項目は残る）", () => {
    const e = eff(def((d) => (d.rules = [R()])), ws((w) => (w.rules.enabled = false)));
    expect(e.rules.items).toHaveLength(1);
    expect(decideWrite(e, PO, A(), T_PO)).toMatchObject({ decision: "approve", reasonCode: "approval_required" });
  });
});

describe("6.7 ハッシュ（effectivePolicyHash。KC §3.4・M-07）", () => {
  const RULE = {
    id: "r-1",
    action: PO,
    match: { supplier_id: "supplier-01" },
    free: ["items[].quantity"],
    labels: { supplier_id: "山田珈琲" },
    tool_hash: H("a"),
    added_by: "u",
    added_at: "2026-10-03T18:00:00+09:00",
  };
  const hashOf = (d: AgentDefinitionInput, w: WorkspacePolicy = WS) => run(d, w).effectivePolicyHash;
  it("H-01：同じ effective を2回 → 同じハッシュ（小文字16進64桁・接頭辞なし）", () => {
    const a = run(BUYER);
    expect(a.effectivePolicyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(effectivePolicyHash(a.effective)).toBe(a.effectivePolicyHash);
    expect(run(BUYER).effectivePolicyHash).toBe(a.effectivePolicyHash);
  });
  it("H-02：キーの順だけ違う → 同じ。型にない余計なキーも入らない", () => {
    const e = eff(BUYER);
    const reordered = Object.fromEntries(Object.entries(e).reverse()) as unknown as EffectivePolicy;
    expect(effectivePolicyHash(reordered)).toBe(effectivePolicyHash(e));
    expect(effectivePolicyHash({ ...e, extra: "shadow" } as EffectivePolicy)).toBe(effectivePolicyHash(e));
  });
  it("H-03：付与のツール・コネクタ・ドメインの順だけ違う定義 → 正規化後に同じハッシュ", () => {
    const a = def((d) => ((d.grants.connectors.supplier.grant = ["list_products", "place_order"]), (d.grants.web = { allow_domains: ["a.com", "b.com"] })));
    const b = def((d) => {
      d.grants.connectors = { supplier: { grant: ["place_order", "list_products"] }, bank: { grant: ["register_payee"] }, store: { grant: ["get_inventory"] } };
      d.grants.web = { allow_domains: ["B.com", "a.com "] };
    });
    expect(hashOf(a)).toBe(hashOf(b));
  });
  it("H-04：ルールの labels・added_at・added_by・source_intent_id だけ違う → 同じ（KC §8 #4）", () => {
    const a = def((d) => (d.rules = [RULE]));
    const b = def((d) => (d.rules = [{ ...RULE, labels: { supplier_id: "別の表示" }, added_at: "2026-10-04T09:00:00+09:00", added_by: "u2", source_intent_id: "i-9" }]));
    expect(hashOf(a)).toBe(hashOf(b));
  });
  it("H-05：ルールを1つ足す → 違う", () => {
    expect(hashOf(def((d) => (d.rules = [RULE])))).not.toBe(hashOf(BUYER));
  });
  it("H-06：ガード max 20 → 10 → 違う", () => {
    const g = (max: number) => def((d) => (d.jobs[0].guards = [{ action: PO, arg: "items[].quantity", max }]));
    expect(hashOf(g(20))).not.toBe(hashOf(g(10)));
  });
  it("H-07：指示・トリガー・名前・プロフィールだけ変える → 同じ（権限ではない：BR-23）", () => {
    const d = def((x) => {
      x.jobs[0].instructions = "別の指示";
      x.jobs[0].trigger = { type: "schedule", cron: "0 17 * * *", timezone: "Asia/Tokyo" };
      x.name = "発注係";
      x.profile = ["interests"];
      x.role = "research";
    });
    expect(hashOf(d)).toBe(hashOf(BUYER));
  });
  it("H-08：researcher → briefer（ツールが同じ）→ 同じ。researcher → assistant は違う", () => {
    const t = (template: string) => def((d) => (d.jobs[0].template = template));
    expect(hashOf(t("researcher"))).toBe(hashOf(t("briefer")));
    expect(hashOf(t("researcher"))).not.toBe(hashOf(t("assistant")));
  });
  it("H-09：NaN を含む値 → 例外", () => {
    const e = eff(BUYER);
    expect(() => effectivePolicyHash({ ...e, budget: { ...e.budget, per_task_usd: Number.NaN } })).toThrow(TypeError);
  });
  it("H-10：既知のベクトル（正規形 JSON）", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
  });
  it("H-11：日本語の文字列はエスケープせず UTF-8 でハッシュ", () => {
    const e = eff(def((d) => (d.rules = [{ ...RULE, match: { supplier_id: "山田珈琲" } }])));
    const json = canonicalJson(e);
    expect(json).toContain("山田珈琲");
    expect(effectivePolicyHash(e)).toBe(createHash("sha256").update(Buffer.from(json, "utf8")).digest("hex"));
  });
  it("H-12：同じ入力・同じ ceilings_version で再合成すると保存したハッシュと一致（NFR-036。値が変わったら policyHash の互換が切れる）", () => {
    expect(run(BUYER).effectivePolicyHash).toBe(GOLDEN_BUYER_HASH);
    expect(canonicalJson(eff(BUYER))).toBe(GOLDEN_BUYER_JSON);
  });
  it("仕事の slug・テンプレート名・ceilings_version は effective に入らない（KC §2.6）", () => {
    const json = canonicalJson(eff(BUYER));
    expect(json).not.toContain("reorder");
    expect(json).not.toContain("assistant");
    expect(json).not.toContain(DEFAULT_CEILINGS.version);
  });
});

// H-12 の固定値（BUYER・既定の ws（1日 $1 に固定）・DEFAULT_CEILINGS。ceilings_version 2026-10-14.1：run_shell を足した：SG-07）
const GOLDEN_BUYER_JSON =
  '{"approvers":[],"autonomy":{"edit_code":"auto","mcp_read":"auto","mcp_write":"approve","memory_write":"auto","merge":"deny","notify":"auto","open_pr":"approve","payment":"handoff","read":"auto","run_shell":"deny","run_tests":"auto","shell_network":"deny","web_read":"auto"},"breakers":{"denied_attempts_max":3,"same_action_repeat":5,"step_cost_usd_max":0.5},"budget":{"agent_day_usd":1,"max_minutes":15,"max_steps":40,"per_day_usd":1,"per_task_usd":0.2},"guards":[],"max_intents_per_task":5,"max_runs_per_day":10,"mcp":{"deliverWrite":true,"grants":{"bank":["register_payee"],"store":["get_inventory"],"supplier":["list_products","place_order"]},"llmRead":true,"llmWrite":true},"rules":{"enabled":true,"items":[]},"tools":["finish","mcp_call","notify","submit_report"],"version":1,"web":{"allow_domains":[],"deny_domains":["*.internal","localhost"],"max_fetches_per_task":30}}';
const GOLDEN_BUYER_HASH = "39245be8eabba98aac54ece210997e27700afeab6953172fdd528bb5ad1d9a06";

describe("出力と入力を共有しない", () => {
  it("compose は入力を変えない。仕事どうしの実効ポリシーは別のオブジェクト", () => {
    const d = def((x) => x.jobs.push({ id: "other", kind: "once", template: "assistant", instructions: "x", guards: [{ action: PO, arg: "q", in: [" b", "a"] }] }));
    const copy = structuredClone(d);
    const r = composeAll(input(d));
    expect(d).toEqual(copy);
    (r.jobs["reorder"]!.effective.budget as { per_task_usd: number }).per_task_usd = 99;
    expect(r.jobs["other"]!.effective.budget.per_task_usd).toBe(0.2);
    expect(r.boundary.budget.per_task_usd).toBe(0.2);
    expect(effectivePolicyHash(r.jobs["other"]!.effective)).toBe(r.jobs["other"]!.effectivePolicyHash);
  });
  it("composeBoundary は composeAll の境界と同じ", () => {
    expect(composeBoundary(input(BUYER))).toEqual({ boundary: composeAll(input(BUYER)).boundary, violations: [], clamped: [] });
  });
});

// ---- 6.10 性質（NFR-056・NFR-036） ----

const LEVEL = fc.constantFrom(...AUTONOMY_LEVELS);
const autonomyArb = fc.record(Object.fromEntries(OPERATION_TYPES.map((op) => [op, LEVEL])) as Record<OperationType, fc.Arbitrary<AutonomyLevel>>, {
  requiredKeys: [],
});
const cents = (max: number) => fc.integer({ min: 0, max: max * 100 }).map((n) => n / 100);
const CONNECTORS = ["store", "supplier", "mail", "bank", "gmail"];
const TOOLS_OF: Record<string, string[]> = {
  store: ["get_inventory"],
  supplier: ["list_products", "place_order"],
  mail: ["list_inbox", "send"],
  bank: ["register_payee"],
  gmail: ["send"],
};
const breakersArb = fc.record(
  { same_action_repeat: fc.integer({ min: 0, max: 40 }), denied_attempts_max: fc.integer({ min: 0, max: 40 }), step_cost_usd_max: cents(10) },
  { requiredKeys: [] },
);
const wsArb: fc.Arbitrary<WorkspacePolicy> = fc
  .record({
    autonomy: autonomyArb,
    budget: fc.record({ per_task_usd: cents(40), per_day_usd: cents(400), max_steps: fc.integer({ min: 0, max: 400 }), max_minutes: fc.integer({ min: 0, max: 120 }) }),
    breakers: fc.option(breakersArb, { nil: undefined }),
    deny: fc.subarray(["a.com", "*.b.com", "LOCALHOST", " c.com "]),
    max_fetches: fc.integer({ min: 0, max: 60 }),
    enabled: fc.subarray(CONNECTORS),
    rulesEnabled: fc.boolean(),
    approvers: fc.subarray(["u1", "u2", "u3"]),
    max_intents: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
  })
  .map((r) => {
    const w: WorkspacePolicy = {
      version: 1,
      autonomy: r.autonomy,
      budget: r.budget,
      web: { deny_domains: r.deny, max_fetches_per_task: r.max_fetches },
      connectors: { enabled: r.enabled },
      rules: { enabled: r.rulesEnabled, max_per_agent: 20 },
      approvers: r.approvers,
    };
    if (r.breakers !== undefined) w.breakers = r.breakers;
    if (r.max_intents !== undefined) w.max_intents_per_task = r.max_intents;
    return w;
  });
const defArb: fc.Arbitrary<AgentDefinitionInput> = fc
  .record({
    autonomy: autonomyArb,
    budget: fc.record({ per_task_usd: cents(40), per_day_usd: cents(400), max_steps: fc.integer({ min: 0, max: 400 }), max_minutes: fc.integer({ min: 0, max: 120 }) }, { requiredKeys: [] }),
    breakers: fc.option(breakersArb, { nil: undefined }),
    max_runs: fc.option(fc.integer({ min: 0, max: 80 }), { nil: undefined }),
    connectors: fc.subarray(CONNECTORS),
    web: fc.option(fc.subarray(["*", "*.example.com", "a.example.com", "Example.org"]), { nil: undefined }),
    approvers: fc.option(fc.subarray(["u1", "u2", "u4"]), { nil: undefined }),
    templates: fc.array(fc.constantFrom("researcher", "briefer", "watcher", "assistant"), { minLength: 1, maxLength: 3 }),
  })
  .map((r) => {
    const d: AgentDefinitionInput = {
      version: 2,
      name: "x",
      grants: {
        ...(r.web === undefined ? {} : { web: { allow_domains: r.web } }),
        connectors: Object.fromEntries(r.connectors.map((c) => [c, { grant: TOOLS_OF[c]! }])),
      },
      autonomy: r.autonomy,
      budget: r.budget,
      jobs: r.templates.map((template, i) => ({ id: `job-${i}`, kind: "recurring" as const, template, instructions: "x" })),
    };
    const out = d as { breakers?: object; max_runs_per_day?: number; approvers?: readonly string[] };
    if (r.breakers !== undefined) out.breakers = r.breakers;
    if (r.max_runs !== undefined) out.max_runs_per_day = r.max_runs;
    if (r.approvers !== undefined) out.approvers = r.approvers;
    return d;
  });

const wsLevel = (w: WorkspacePolicy, op: OperationType) => clampAutonomyToCeiling(w.autonomy[op] ?? CATALOG_DEFAULT_AUTONOMY[op], op, DEFAULT_CEILINGS);
const C = DEFAULT_CEILINGS;
const wsBreaker = (w: WorkspacePolicy, k: keyof typeof DEFAULT_BREAKERS) => Math.min(C.breakers[k], w.breakers?.[k] ?? DEFAULT_BREAKERS[k]);

/** e2 は e1 より緩くない（同じ定義で ws だけ違うときの比較。KC §6.10 PB-03） */
function expectNotLooser(e2: EffectivePolicy, e1: EffectivePolicy): void {
  for (const op of OPERATION_TYPES) expect(AUTONOMY_STRICTNESS[e2.autonomy[op]]).toBeGreaterThanOrEqual(AUTONOMY_STRICTNESS[e1.autonomy[op]]);
  for (const k of ["per_task_usd", "per_day_usd", "max_steps", "max_minutes"] as const) expect(e2.budget[k]).toBeLessThanOrEqual(e1.budget[k]);
  if (e1.budget.agent_day_usd !== null) expect(e2.budget.agent_day_usd ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(e1.budget.agent_day_usd);
  for (const k of ["same_action_repeat", "denied_attempts_max", "step_cost_usd_max"] as const) expect(e2.breakers[k]).toBeLessThanOrEqual(e1.breakers[k]);
  expect(e2.max_intents_per_task).toBeLessThanOrEqual(e1.max_intents_per_task);
  expect(e2.max_runs_per_day).toBeLessThanOrEqual(e1.max_runs_per_day);
  for (const t of e2.tools) expect(e1.tools).toContain(t);
  for (const k of ["llmRead", "llmWrite", "deliverWrite"] as const) if (e2.mcp[k]) expect(e1.mcp[k]).toBe(true);
  for (const [c, ts] of Object.entries(e2.mcp.grants)) for (const t of ts) expect(e1.mcp.grants[c] ?? []).toContain(t);
  for (const d of e1.web.deny_domains) expect(e2.web.deny_domains).toContain(d);
  expect(e2.web.max_fetches_per_task).toBeLessThanOrEqual(e1.web.max_fetches_per_task);
  if (e2.rules.enabled) expect(e1.rules.enabled).toBe(true);
  expect(e2.rules.items).toEqual(e1.rules.items);
  expect(e2.guards).toEqual(e1.guards);
}

describe("6.10 性質（fast-check）", () => {
  it("PB-01（NFR-056）：どの定義・ws でも、実効ポリシーは ws と Hard Ceiling より緩くない", () => {
    fc.assert(
      fc.property(defArb, wsArb, (d, w) => {
        const r = composeAll(input(d, w));
        const enabled = new Set(w.connectors.enabled);
        for (const job of Object.values(r.jobs)) {
          const e = job.effective;
          for (const op of OPERATION_TYPES) {
            expect(writableAutonomy(op, C)).toContain(e.autonomy[op]);
            expect(AUTONOMY_STRICTNESS[e.autonomy[op]]).toBeGreaterThanOrEqual(AUTONOMY_STRICTNESS[wsLevel(w, op)]);
          }
          for (const k of ["per_task_usd", "per_day_usd", "max_steps", "max_minutes"] as const) {
            expect(e.budget[k]).toBeLessThanOrEqual(Math.min(C.budget[k], w.budget[k]));
          }
          if (e.budget.agent_day_usd !== null) expect(e.budget.agent_day_usd).toBeLessThanOrEqual(e.budget.per_day_usd);
          for (const k of ["same_action_repeat", "denied_attempts_max", "step_cost_usd_max"] as const) expect(e.breakers[k]).toBeLessThanOrEqual(wsBreaker(w, k));
          expect(e.max_intents_per_task).toBeLessThanOrEqual(Math.min(C.max_intents_per_task, w.max_intents_per_task ?? 5));
          expect(e.max_runs_per_day).toBeLessThanOrEqual(C.max_runs_per_day);
          for (const c of Object.keys(e.mcp.grants)) expect(enabled.has(c)).toBe(true);
          for (const dmn of [...w.web.deny_domains, ...C.web_always_deny]) expect(e.web.deny_domains).toContain(dmn.trim().toLowerCase());
          expect(e.web.max_fetches_per_task).toBeLessThanOrEqual(Math.min(C.max_fetches_per_task, w.web.max_fetches_per_task));
          expect(e.rules.enabled).toBe(w.rules.enabled);
          if (w.approvers.length > 0) for (const a of e.approvers) expect(w.approvers).toContain(a);
          expect(e.tools).not.toContain("remember");
        }
        for (const [id, job] of Object.entries(r.jobs)) {
          const template = (d.jobs ?? []).find((j) => j.id === id)!.template;
          if (template === "watcher") expect(job.effective.mcp).toMatchObject({ llmWrite: false, deliverWrite: false });
          for (const t of job.effective.tools) expect(TEMPLATES[template].tools).toContain(t);
        }
      }),
      { numRuns: 300 },
    );
  });
  it("PB-02：定義が ws・Hard Ceiling より緩い項目があれば、その項目の違反が必ず出る（違反の項目はちょうどその集合）。違反がなければ定義の値がそのまま効く", () => {
    fc.assert(
      fc.property(defArb, wsArb, (d, w) => {
        const r = composeAll(input(d, w));
        const expected: string[] = [];
        for (const op of OPERATION_TYPES) {
          const v = d.autonomy?.[op];
          if (v === undefined) continue;
          if (!writableAutonomy(op, C).includes(v) || AUTONOMY_STRICTNESS[v] < AUTONOMY_STRICTNESS[wsLevel(w, op)]) expected.push(`autonomy.${op}`);
        }
        for (const k of ["per_task_usd", "max_steps", "max_minutes", "per_day_usd"] as const) {
          const v = d.budget?.[k];
          if (v !== undefined && v > Math.min(C.budget[k], w.budget[k])) expected.push(`budget.${k}`);
        }
        for (const k of ["same_action_repeat", "denied_attempts_max", "step_cost_usd_max"] as const) {
          const v = d.breakers?.[k];
          if (v !== undefined && v > wsBreaker(w, k)) expected.push(`breakers.${k}`);
        }
        if ((d.max_runs_per_day ?? 10) > C.max_runs_per_day) expected.push("max_runs_per_day");
        for (const c of Object.keys(d.grants?.connectors ?? {})) if (!w.connectors.enabled.includes(c)) expected.push(`grants.connectors.${c}`);
        if (w.approvers.length > 0 && (d.approvers ?? []).some((a) => !w.approvers.includes(a))) expected.push("approvers");
        expect(paths(r.violations).sort()).toEqual(expected.sort());
        if (r.violations.length === 0) {
          const b = r.boundary;
          for (const op of OPERATION_TYPES) if (d.autonomy?.[op] !== undefined) expect(b.autonomy[op]).toBe(d.autonomy[op]);
          for (const k of ["per_task_usd", "max_steps", "max_minutes"] as const) if (d.budget?.[k] !== undefined) expect(b.budget[k]).toBe(d.budget[k]);
          if (d.budget?.per_day_usd !== undefined) expect(b.budget.agent_day_usd).toBe(d.budget.per_day_usd);
          expect(Object.keys(b.grants).sort()).toEqual(Object.keys(d.grants?.connectors ?? {}).sort());
          expect(r.clamped).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
  });
  it("PB-03：ws を厳しくすると実効ポリシーは厳しくなるか同じ（単調性）", () => {
    const tightenArb = fc.record({
      autonomy: autonomyArb,
      budget: fc.record({ per_task_usd: cents(40), per_day_usd: cents(400), max_steps: fc.integer({ min: 0, max: 400 }), max_minutes: fc.integer({ min: 0, max: 120 }) }),
      breakers: breakersArb,
      deny: fc.subarray(["x.com", "*.y.com"]),
      max_fetches: fc.integer({ min: 0, max: 60 }),
      keep: fc.array(fc.boolean(), { minLength: CONNECTORS.length, maxLength: CONNECTORS.length }),
      rulesEnabled: fc.boolean(),
      max_intents: fc.integer({ min: 0, max: 40 }),
    });
    fc.assert(
      fc.property(defArb, wsArb, tightenArb, (d, w1, t) => {
        const w2: WorkspacePolicy = {
          ...w1,
          autonomy: Object.fromEntries(
            OPERATION_TYPES.map((op) => [op, stricterAutonomy(wsLevel(w1, op), t.autonomy[op] ?? wsLevel(w1, op))]),
          ) as Record<OperationType, AutonomyLevel>,
          budget: {
            per_task_usd: Math.min(w1.budget.per_task_usd, t.budget.per_task_usd),
            per_day_usd: Math.min(w1.budget.per_day_usd, t.budget.per_day_usd),
            max_steps: Math.min(w1.budget.max_steps, t.budget.max_steps),
            max_minutes: Math.min(w1.budget.max_minutes, t.budget.max_minutes),
          },
          breakers: {
            same_action_repeat: Math.min(w1.breakers?.same_action_repeat ?? 5, t.breakers.same_action_repeat ?? Number.POSITIVE_INFINITY),
            denied_attempts_max: Math.min(w1.breakers?.denied_attempts_max ?? 3, t.breakers.denied_attempts_max ?? Number.POSITIVE_INFINITY),
            step_cost_usd_max: Math.min(w1.breakers?.step_cost_usd_max ?? 0.5, t.breakers.step_cost_usd_max ?? Number.POSITIVE_INFINITY),
          },
          web: { deny_domains: [...w1.web.deny_domains, ...t.deny], max_fetches_per_task: Math.min(w1.web.max_fetches_per_task, t.max_fetches) },
          connectors: { enabled: w1.connectors.enabled.filter((c) => t.keep[CONNECTORS.indexOf(c)]) },
          rules: { ...w1.rules, enabled: w1.rules.enabled && t.rulesEnabled },
          max_intents_per_task: Math.min(w1.max_intents_per_task ?? 5, t.max_intents),
        };
        const r1 = composeAll(input(d, w1));
        const r2 = composeAll(input(d, w2));
        for (const id of Object.keys(r1.jobs)) expectNotLooser(r2.jobs[id]!.effective, r1.jobs[id]!.effective);
      }),
      { numRuns: 300 },
    );
  });
  it("PB-04（NFR-036）：同じ入力は同じハッシュ。集合の並べ替え（付与・ドメイン・ルール・仕事・ガード）でも変わらない", () => {
    const ruleArb = fc.record({ id: fc.constantFrom("r-1", "r-2", "r-3"), sku: fc.subarray(["A", "B", "C"]) });
    fc.assert(
      fc.property(defArb, wsArb, fc.uniqueArray(ruleArb, { selector: (r) => r.id, maxLength: 3 }), fc.integer(), (d0, w, rules, seed) => {
        const d: AgentDefinitionInput = {
          ...d0,
          rules: rules.map((r) => ({
            id: r.id,
            action: PO,
            match: { supplier_id: "s", "items[].sku": r.sku },
            free: ["items[].unit_price", "items[].quantity"],
            tool_hash: H("a"),
            added_by: "u",
            added_at: "2026-10-03T00:00:00Z",
          })),
          jobs: (d0.jobs ?? []).map((j) => ({ ...j, guards: [{ action: PO, arg: "q", max: 5 }, { action: PO, arg: "p", in: ["x", "y"] }] })),
        };
        const shuffle = <T>(list: readonly T[]): T[] => [...list].sort((a, b) => ((canonicalJson(a as never).length * 31 + seed) % 7) - ((canonicalJson(b as never).length * 17 + seed) % 5));
        const shuffled: AgentDefinitionInput = {
          ...d,
          grants: {
            ...(d.grants?.web === undefined ? {} : { web: { allow_domains: shuffle(d.grants.web.allow_domains) } }),
            connectors: Object.fromEntries(shuffle(Object.entries(d.grants?.connectors ?? {})).map(([c, g]) => [c, { grant: shuffle(g.grant) }])),
          },
          rules: shuffle(d.rules ?? []).map((r) => ({ ...r, free: shuffle(r.free ?? []), match: { ...r.match, "items[].sku": shuffle(r.match["items[].sku"] as string[]) } })),
          jobs: shuffle(d.jobs ?? []).map((j) => ({ ...j, guards: shuffle(j.guards ?? []) })),
        };
        const a = composeAll(input(d, w));
        const b = composeAll(input(shuffled, w));
        const c = composeAll(input(d, w));
        for (const id of Object.keys(a.jobs)) {
          expect(b.jobs[id]!.effectivePolicyHash).toBe(a.jobs[id]!.effectivePolicyHash);
          expect(c.jobs[id]!.effectivePolicyHash).toBe(a.jobs[id]!.effectivePolicyHash);
        }
      }),
      { numRuns: 200 },
    );
  });
  it("PB-06：合成したガード（compose の出力）を通る値 ⇔ 元のすべてのガードを通る値（empty を除く）", () => {
    const guardArb = fc.record({
      arg: fc.constantFrom("q", "items[].q"),
      kind: fc.constantFrom("num", "in"),
      min: fc.option(fc.integer({ min: -5, max: 30 }), { nil: undefined }),
      max: fc.option(fc.integer({ min: -5, max: 30 }), { nil: undefined }),
      digits: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
      cands: fc.subarray(["x", "y", "z"]),
    });
    const valueArb = fc.oneof(fc.integer({ min: -10, max: 1200 }), fc.constantFrom("x", "y", " z ", "w"));
    fc.assert(
      fc.property(fc.array(guardArb, { minLength: 1, maxLength: 5 }), valueArb, valueArb, (raw, v1, v2) => {
        const guards: Guard[] = raw.map((r) => {
          const g: Guard = { action: PO, arg: r.arg };
          if (r.kind === "in") return { ...g, in: r.cands };
          const out = { ...g } as { -readonly [K in keyof Guard]: Guard[K] };
          if (r.min !== undefined) out.min = r.min;
          if (r.max !== undefined) out.max = r.max;
          out.max_digits = r.digits ?? 4;
          return out;
        });
        const merged = eff(def((d) => (d.jobs[0].guards = guards))).guards;
        for (const args of [{ q: v1, items: [{ q: v1 }, { q: v2 }] }, { q: v2, items: [{ q: v2 }] }] as JsonObject[]) {
          for (const m of merged) {
            const originals = guards.filter((g) => g.action === m.action && g.arg === m.arg);
            const allPass = originals.every((g) => evaluateGuard(g, args).ok);
            const mergedPass = evaluateGuard(m, args).ok;
            if (m.empty) expect(mergedPass).toBe(false);
            else expect(mergedPass).toBe(allPass);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
