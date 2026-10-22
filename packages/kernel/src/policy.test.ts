import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compose, composeAll } from "./compose.ts";
import {
  AUTONOMY_LEVELS,
  AUTONOMY_STRICTNESS,
  CATALOG_DEFAULT_AUTONOMY,
  CEILINGS_VERSION,
  DAY_BOUNDARY_TIMEZONE,
  DEFAULT_BREAKERS,
  DEFAULT_CEILINGS,
  GENERAL_TEMPLATE_NAMES,
  INITIAL_AGENT_BOUNDARY,
  TEMPLATES,
  TEMPLATE_NAMES,
  clampAutonomyToCeiling,
  defaultWorkspacePolicy,
  initialAgentDefinition,
  isAutonomyLevel,
  normalizeAgentDefinition,
  parseCronSchedule,
  parseMcpAction,
  parseWatchIntervalMinutes,
  parseWorkspacePolicy,
  stricterAutonomy,
  validateAgentDefinition,
  workspacePolicySchema,
  writableAutonomy,
} from "./policy.ts";
import type { AgentDefinitionInput, ConnectorCatalog, RuleInput, WorkspacePolicy } from "./policy.ts";
import { CATALOG_TOOLS, OPERATION_TYPES } from "./types.ts";
import type { AutonomyLevel, OperationType, ToolHash, ToolInfo } from "./types.ts";

// ---- フィクスチャ（KC §2.4 の0-H の例。仕入れ係の付与は M-36：bank.register_payee あり、mail.send なし） ----

const H = (c: string): ToolHash => `sha256:${c.repeat(64)}`;
const INBOX: AgentDefinitionInput = {
  version: 2,
  name: "受信箱係",
  role: "research",
  grants: { connectors: { mail: { grant: ["list_inbox"] } } },
  autonomy: {},
  rules: [],
  budget: { per_task_usd: 0.2, per_day_usd: 1 },
  max_runs_per_day: 10,
  profile: [],
  jobs: [
    {
      id: "read-supplier-mail",
      kind: "recurring",
      template: "researcher",
      instructions: "仕入れ先からの新しいメールを読み、数量・価格・振込先の変更を要約する",
      trigger: null,
      deliver: [],
      guards: [],
    },
  ],
};
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
const RULE: RuleInput = {
  id: "r-1",
  action: "mcp.supplier.place_order",
  match: { supplier_id: "supplier-01", "items[].sku": ["BEAN-HOUSE"] },
  free: ["items[].quantity", "items[].unit_price"],
  labels: { supplier_id: "山田珈琲" },
  tool_hash: H("a"),
  added_by: "user-1",
  added_at: "2026-10-03T18:00:00+09:00",
};

const T_PO: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: H("a"),
  argRoles: { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" },
};
const TOOLS: ConnectorCatalog = {
  supplier: { connected: true, tools: { place_order: T_PO } },
};

/** JSON の写しにして手を加える */
function edit(base: AgentDefinitionInput, f: (d: any) => void): unknown {
  const d = structuredClone(base) as any;
  f(d);
  return d;
}
function issuesOf(raw: unknown, opts?: Parameters<typeof validateAgentDefinition>[1]) {
  const r = validateAgentDefinition(raw, opts);
  return r.ok ? [] : r.issues;
}
function expectInvalid(raw: unknown, path: string, opts?: Parameters<typeof validateAgentDefinition>[1]) {
  const issues = issuesOf(raw, opts);
  expect(issues.length, JSON.stringify(issues)).toBeGreaterThan(0);
  expect(issues.every((i) => i.code === "AGENT_SCHEMA_INVALID")).toBe(true);
  expect(issues.map((i) => i.path)).toContain(path);
}
function expectValid(raw: unknown, opts?: Parameters<typeof validateAgentDefinition>[1]) {
  const r = validateAgentDefinition(raw, opts);
  expect(r.ok ? [] : r.issues).toEqual([]);
}

describe("Hard Ceiling（BR-06・KC §2.2・M-59）", () => {
  it("版はコードの定数（M-59・KC §8 #26）", () => {
    expect(CEILINGS_VERSION).toBe("2026-10-14.1"); // SG-07：run_shell を足した
    expect(DEFAULT_CEILINGS.version).toBe(CEILINGS_VERSION);
  });
  it("max_minutes の上限は 0-H は 55（M-59）。per_task_usd 20・max_steps 200（BR-06）", () => {
    expect(DEFAULT_CEILINGS.budget).toEqual({ per_task_usd: 20, per_day_usd: 200, max_steps: 200, max_minutes: 55 });
    expect(DEFAULT_CEILINGS.max_intents_per_task).toBe(20);
    expect(DEFAULT_CEILINGS.max_runs_per_day).toBe(50);
  });
  it("merge・shell_network は deny だけ、サンドボックス内は auto か deny、mcp_write に auto はない、payment は handoff（BR-06・BR-36・C-16）", () => {
    expect(writableAutonomy("merge", DEFAULT_CEILINGS)).toEqual(["deny"]);
    expect(writableAutonomy("shell_network", DEFAULT_CEILINGS)).toEqual(["deny"]);
    for (const op of ["read", "edit_code", "run_tests"] as const) expect(writableAutonomy(op, DEFAULT_CEILINGS)).toEqual(["auto", "deny"]);
    expect(writableAutonomy("mcp_write", DEFAULT_CEILINGS)).toEqual(["approve", "handoff", "deny"]);
    expect(writableAutonomy("payment", DEFAULT_CEILINGS)).toEqual(["handoff", "deny"]);
    expect(writableAutonomy("mcp_read", DEFAULT_CEILINGS)).toEqual(["auto", "approve", "deny"]);
  });
  it("deny はどの操作でも書ける（KC §8 #2）", () => {
    for (const op of OPERATION_TYPES) expect(writableAutonomy(op, DEFAULT_CEILINGS)).toContain("deny");
  });
  it("共有の定数は凍結（実行中に Hard Ceiling・テンプレートを緩められない）", () => {
    expect(() => {
      (DEFAULT_CEILINGS.budget as { per_task_usd: number }).per_task_usd = 100;
    }).toThrow(TypeError);
    expect(() => {
      (DEFAULT_CEILINGS.autonomy.mcp_write as AutonomyLevel[]).push("auto");
    }).toThrow(TypeError);
    expect(() => {
      (TEMPLATES.researcher as { mcpLlm: string }).mcpLlm = "read_write";
    }).toThrow(TypeError);
    expect(DEFAULT_CEILINGS.budget.per_task_usd).toBe(20);
    expect(TEMPLATES.researcher.mcpLlm).toBe("read");
  });
});

describe("自律度の厳しさと切り詰め（KC §3.2・§8 #1）", () => {
  it("厳しさの順は deny > handoff > approve > auto", () => {
    expect(AUTONOMY_LEVELS).toEqual(["auto", "approve", "handoff", "deny"]);
    expect(AUTONOMY_STRICTNESS).toEqual({ auto: 0, approve: 1, handoff: 2, deny: 3 });
    expect(stricterAutonomy("auto", "approve")).toBe("approve");
    expect(stricterAutonomy("handoff", "approve")).toBe("handoff");
    expect(stricterAutonomy("deny", "handoff")).toBe("deny");
    expect(stricterAutonomy("auto", "auto")).toBe("auto");
  });
  it("KC §3.2 の例：mcp_write auto → approve、web_read approve → deny、notify approve → deny、mcp_read handoff → deny、merge approve → deny、open_pr handoff → deny", () => {
    const c = (l: AutonomyLevel, op: OperationType) => clampAutonomyToCeiling(l, op, DEFAULT_CEILINGS);
    expect(c("auto", "mcp_write")).toBe("approve");
    expect(c("approve", "web_read")).toBe("deny");
    expect(c("approve", "notify")).toBe("deny");
    expect(c("handoff", "mcp_read")).toBe("deny");
    expect(c("approve", "merge")).toBe("deny");
    expect(c("handoff", "open_pr")).toBe("deny");
    expect(c("auto", "payment")).toBe("handoff");
  });
  it("書ける値はそのまま。知らない値・欠けは deny", () => {
    for (const op of OPERATION_TYPES) {
      for (const l of writableAutonomy(op, DEFAULT_CEILINGS)) expect(clampAutonomyToCeiling(l, op, DEFAULT_CEILINGS)).toBe(l);
    }
    expect(clampAutonomyToCeiling("allow", "mcp_read", DEFAULT_CEILINGS)).toBe("deny");
    expect(clampAutonomyToCeiling(undefined, "mcp_read", DEFAULT_CEILINGS)).toBe("deny");
    expect(isAutonomyLevel("handoff")).toBe(true);
    expect(isAutonomyLevel("constructor")).toBe(false);
  });
  it("性質：切り詰めた値は書ける値で、元より緩くならない（最小の厳しい値）", () => {
    fc.assert(
      fc.property(fc.constantFrom(...AUTONOMY_LEVELS), fc.constantFrom(...OPERATION_TYPES), (l, op) => {
        const out = clampAutonomyToCeiling(l, op, DEFAULT_CEILINGS);
        const allowed = writableAutonomy(op, DEFAULT_CEILINGS);
        expect(allowed).toContain(out);
        expect(AUTONOMY_STRICTNESS[out]).toBeGreaterThanOrEqual(AUTONOMY_STRICTNESS[l]);
        // out より緩い書ける値で l 以上のものはない
        for (const x of allowed) {
          if (AUTONOMY_STRICTNESS[x] >= AUTONOMY_STRICTNESS[l]) expect(AUTONOMY_STRICTNESS[x]).toBeGreaterThanOrEqual(AUTONOMY_STRICTNESS[out]);
        }
      }),
    );
  });
  it("カタログの既定値（catalogs.md:47-61）", () => {
    expect(CATALOG_DEFAULT_AUTONOMY).toMatchObject({ mcp_write: "approve", mcp_read: "auto", memory_write: "auto", shell_network: "deny", merge: "deny" });
    expect(Object.keys(CATALOG_DEFAULT_AUTONOMY).sort()).toEqual([...OPERATION_TYPES].sort());
  });
});

describe("ワークスペースのポリシーの既定値（KC §2.3・M-59・BR-62）", () => {
  const owner = defaultWorkspacePolicy("owner");
  const guest = defaultWorkspacePolicy("guest");
  it("オーナーの per_day_usd は 10（M-59）、ゲストは 4（BR-62・D-105・D-106：edge のゲスト1日 $4 と同じ）。ほかは同じ", () => {
    expect(owner.budget.per_day_usd).toBe(10);
    expect(guest.budget.per_day_usd).toBe(4);
    expect({ ...owner, budget: { ...owner.budget, per_day_usd: 0 } }).toEqual({ ...guest, budget: { ...guest.budget, per_day_usd: 0 } });
  });
  it("例の値（policy-and-schema.md:43-65）と推奨の Breaker（KC §8 #20）", () => {
    expect(guest).toEqual({
      version: 1,
      autonomy: { web_read: "auto", notify: "auto", mcp_read: "auto", mcp_write: "approve", open_pr: "approve", memory_write: "auto" },
      budget: { per_task_usd: 0.5, per_day_usd: 4, max_steps: 40, max_minutes: 15 },
      breakers: { same_action_repeat: 5, denied_attempts_max: 3, step_cost_usd_max: 0.5 },
      web: { deny_domains: ["*.internal", "localhost"], max_fetches_per_task: 30 },
      connectors: { enabled: [] },
      rules: { enabled: true, max_per_agent: 20 },
      approvers: [],
      max_intents_per_task: 5,
    });
    expect(DEFAULT_BREAKERS).toEqual({ same_action_repeat: 5, denied_attempts_max: 3, step_cost_usd_max: 0.5 });
  });
  it("有効なコネクタの既定は空。渡せば差し替え（trim・昇順・重複なし）", () => {
    expect(defaultWorkspacePolicy("owner").connectors.enabled).toEqual([]);
    expect(defaultWorkspacePolicy("guest", [" news ", "mail", "mail"]).connectors.enabled).toEqual(["mail", "news"]);
  });
  it("日の区切りは Asia/Tokyo（M-59）", () => {
    expect(DAY_BOUNDARY_TIMEZONE).toBe("Asia/Tokyo");
  });
  it("呼ぶたびに新しいオブジェクト（呼び出し側が書き換えても既定値は変わらない）", () => {
    const a = defaultWorkspacePolicy("owner");
    (a.budget as { per_task_usd: number }).per_task_usd = 99;
    expect(defaultWorkspacePolicy("owner").budget.per_task_usd).toBe(0.5);
  });
  it("スキーマを通る。Hard Ceiling を超える値も形が合えば通る（範囲の検証は Q-30。compose が切り詰める）", () => {
    expect(parseWorkspacePolicy(owner)).toEqual(owner);
    expect(workspacePolicySchema.safeParse({ ...guest, budget: { ...guest.budget, per_task_usd: 30 } }).success).toBe(true);
    expect(workspacePolicySchema.safeParse({ ...guest, autonomy: { ...guest.autonomy, mcp_write: "auto" } }).success).toBe(true);
  });
  it("スキーマ：未知のキー・欠け・負の値・有限でない値は拒否", () => {
    expect(workspacePolicySchema.safeParse({ ...guest, extra: 1 }).success).toBe(false);
    const { web: _web, ...noWeb } = guest;
    expect(workspacePolicySchema.safeParse(noWeb).success).toBe(false);
    expect(workspacePolicySchema.safeParse({ ...guest, budget: { ...guest.budget, per_day_usd: -1 } }).success).toBe(false);
    expect(workspacePolicySchema.safeParse({ ...guest, budget: { ...guest.budget, per_day_usd: Number.POSITIVE_INFINITY } }).success).toBe(false);
    expect(workspacePolicySchema.safeParse({ ...guest, autonomy: { ...guest.autonomy, browser_submit: "approve" } }).success).toBe(false);
    expect(() => parseWorkspacePolicy({ version: 2 })).toThrow();
  });
  it("breakers・max_intents_per_task は省略できる（DB の形：db-schema.md §3）", () => {
    const { breakers: _b, max_intents_per_task: _m, ...rest } = guest;
    expect(workspacePolicySchema.safeParse(rest).success).toBe(true);
  });
});

describe("テンプレート（KC §2.5・D-32・BR-40・ADR-013）", () => {
  it("汎用の4つは submit_report・notify・finish を持つ（D-32）", () => {
    for (const t of GENERAL_TEMPLATE_NAMES) {
      expect(TEMPLATES[t].tools).toEqual(expect.arrayContaining(["submit_report", "notify", "finish"]));
      expect(TEMPLATES[t].name).toBe(t);
    }
  });
  it("watcher は書き込みを持たない（BR-40）。researcher・briefer の mcp_call は読み取りのみ。assistant は 0-H で書き込みあり（KC §7 C-6）", () => {
    expect(TEMPLATES.watcher).toMatchObject({ mcpLlm: "read", mcpDeliverWrite: false });
    // 見張る先を探す・ニュースの変化を見るための検索は読み取り（10/14）。書き込みのツールは持たない
    expect(TEMPLATES.watcher.tools).toContain("web_search");
    expect(TEMPLATES.watcher.tools).not.toContain("submit_intent");
    expect(TEMPLATES.researcher).toMatchObject({ mcpLlm: "read", mcpDeliverWrite: true });
    expect(TEMPLATES.assistant).toMatchObject({ mcpLlm: "read_write", mcpDeliverWrite: true });
    expect(GENERAL_TEMPLATE_NAMES).toContain("assistant");
  });
  it("researcher と briefer はツール・MCP が同じ（H-08 の前提）", () => {
    expect({ ...TEMPLATES.researcher, name: "x" }).toEqual({ ...TEMPLATES.briefer, name: "x" });
  });
  it("remember・load_skill はどのテンプレートにもない（メモリ・Skill はフェーズ1。C-20）。開発テンプレートはフェーズ1でツールなし", () => {
    for (const t of TEMPLATE_NAMES) {
      expect(TEMPLATES[t].tools).not.toContain("remember");
      expect(TEMPLATES[t].tools).not.toContain("load_skill");
      for (const tool of TEMPLATES[t].tools) expect(CATALOG_TOOLS).toContain(tool);
    }
    // triager はまだ道具なし。dev-coder・reviewer は作業場の道具を持ち（D-116）、MCP は持たない。reviewer は書き換えない
    expect(TEMPLATES.triager).toMatchObject({ tools: [], mcpLlm: "none", phase: 1 });
    for (const t of ["dev-coder", "reviewer"] as const) expect(TEMPLATES[t]).toMatchObject({ mcpLlm: "none", mcpDeliverWrite: false });
    expect(TEMPLATES["dev-coder"].tools).toEqual(expect.arrayContaining(["write_file", "run_command"]));
    expect(TEMPLATES.reviewer.tools).not.toContain("write_file");
    expect(TEMPLATES.reviewer.tools).not.toContain("delete_file");
    expect(GENERAL_TEMPLATE_NAMES).toEqual(["researcher", "briefer", "watcher", "assistant", "dev-coder", "reviewer"]);
  });
});

describe("parseMcpAction（KC §8 #7）", () => {
  it("connector は点を含まず、tool は残り全部", () => {
    expect(parseMcpAction("mcp.supplier.place_order")).toEqual({ connector: "supplier", tool: "place_order" });
    expect(parseMcpAction("mcp.repo.pulls.create")).toEqual({ connector: "repo", tool: "pulls.create" });
  });
  it("形の外れたものは null", () => {
    for (const a of ["supplier.place_order", "mcp.", "mcp.supplier", "mcp.supplier.", "mcp..x", "notify", ""]) expect(parseMcpAction(a)).toBeNull();
  });
});

describe("定義の検証 validateAgentDefinition（FR-022・KC §2.2 の範囲・§4・§8）", () => {
  it("0-H の例（受信箱係・仕入れ係。M-36 の付与）は通り、正規化した定義が返る", () => {
    const r = validateAgentDefinition(BUYER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.definition.grants.connectors).toEqual({ bank: { grant: ["register_payee"] }, store: { grant: ["get_inventory"] }, supplier: { grant: ["list_products", "place_order"] } });
    expectValid(INBOX);
  });
  it("C-23：per_task_usd 25 は範囲外（0.1〜20）。境界 0.1・20 は通り、0.09 は外れ", () => {
    expectInvalid(edit(BUYER, (d) => (d.budget.per_task_usd = 25)), "budget.per_task_usd");
    expectValid(edit(BUYER, (d) => (d.budget.per_task_usd = 20)));
    expectValid(edit(BUYER, (d) => (d.budget.per_task_usd = 0.1)));
    expectInvalid(edit(BUYER, (d) => (d.budget.per_task_usd = 0.09)), "budget.per_task_usd");
  });
  it("per_day_usd は 0.1〜200、max_steps は 1〜200 の整数", () => {
    expectInvalid(edit(BUYER, (d) => (d.budget.per_day_usd = 201)), "budget.per_day_usd");
    expectValid(edit(BUYER, (d) => (d.budget.per_day_usd = 200)));
    expectInvalid(edit(BUYER, (d) => (d.budget.max_steps = 201)), "budget.max_steps");
    expectInvalid(edit(BUYER, (d) => (d.budget.max_steps = 1.5)), "budget.max_steps");
    expectValid(edit(BUYER, (d) => (d.budget.max_steps = 200)));
  });
  it("max_minutes は 5〜55（M-59：Hard Ceiling と同じ上端）", () => {
    expectValid(edit(BUYER, (d) => (d.budget.max_minutes = 55)));
    expectInvalid(edit(BUYER, (d) => (d.budget.max_minutes = 56)), "budget.max_minutes");
    expectInvalid(edit(BUYER, (d) => (d.budget.max_minutes = 60)), "budget.max_minutes");
    expectValid(edit(BUYER, (d) => (d.budget.max_minutes = 5)));
    expectInvalid(edit(BUYER, (d) => (d.budget.max_minutes = 4)), "budget.max_minutes");
  });
  it("Breaker の範囲（same_action_repeat 2〜20・denied_attempts_max 1〜20・step_cost_usd_max 0.01〜5）", () => {
    expectInvalid(edit(BUYER, (d) => (d.breakers = { same_action_repeat: 1 })), "breakers.same_action_repeat");
    expectValid(edit(BUYER, (d) => (d.breakers = { same_action_repeat: 2, denied_attempts_max: 20, step_cost_usd_max: 5 })));
    expectInvalid(edit(BUYER, (d) => (d.breakers = { same_action_repeat: 21 })), "breakers.same_action_repeat");
    expectInvalid(edit(BUYER, (d) => (d.breakers = { denied_attempts_max: 0 })), "breakers.denied_attempts_max");
    expectInvalid(edit(BUYER, (d) => (d.breakers = { step_cost_usd_max: 0.009 })), "breakers.step_cost_usd_max");
  });
  it("C-32〜C-34：max_runs_per_day は 1〜50（51・0 は拒否）", () => {
    expectValid(edit(BUYER, (d) => (d.max_runs_per_day = 50)));
    expectInvalid(edit(BUYER, (d) => (d.max_runs_per_day = 51)), "max_runs_per_day");
    expectInvalid(edit(BUYER, (d) => (d.max_runs_per_day = 0)), "max_runs_per_day");
    expectValid(edit(BUYER, (d) => (d.max_runs_per_day = 1)));
  });
  it("C-49：triager はスキーマで拒否。dev-coder・reviewer（D-116）・watcher・briefer は通る", () => {
    expectInvalid(edit(BUYER, (d) => (d.jobs[0].template = "triager")), "jobs[0].template");
    expectValid(edit(BUYER, (d) => (d.jobs[0].template = "dev-coder")));
    expectValid(edit(BUYER, (d) => (d.jobs[0].template = "reviewer")));
    expectValid(edit(BUYER, (d) => (d.jobs[0].template = "watcher")));
    expectValid(edit(BUYER, (d) => (d.jobs[0].template = "briefer")));
  });
  it("仕事は10個まで（A-81）。11個目は拒否", () => {
    const jobs = (n: number) => Array.from({ length: n }, (_, i) => ({ ...BUYER.jobs![0]!, id: `job-${String(i).padStart(2, "0")}` }));
    expectValid(edit(BUYER, (d) => (d.jobs = jobs(10))));
    expectInvalid(edit(BUYER, (d) => (d.jobs = jobs(11))), "jobs");
  });
  it("仕事の id は ^[a-z0-9-]{2,40}$ で一意。ルールの id も一意", () => {
    expectInvalid(edit(BUYER, (d) => (d.jobs[0].id = "a")), "jobs[0].id");
    expectInvalid(edit(BUYER, (d) => (d.jobs[0].id = "Reorder")), "jobs[0].id");
    expectInvalid(edit(BUYER, (d) => (d.jobs[0].id = "x".repeat(41))), "jobs[0].id");
    expectValid(edit(BUYER, (d) => (d.jobs[0].id = "x".repeat(40))));
    expectInvalid(edit(BUYER, (d) => d.jobs.push({ ...d.jobs[0] })), "jobs[1].id");
    expectInvalid(edit(BUYER, (d) => (d.rules = [RULE, { ...RULE }])), "rules[1].id");
  });
  it("未知のキーは拒否（最上位・仕事・ルール・付与）", () => {
    expect(issuesOf(edit(BUYER, (d) => (d.extra = 1))).length).toBeGreaterThan(0);
    expect(issuesOf(edit(BUYER, (d) => (d.jobs[0].shadow = true))).length).toBeGreaterThan(0);
    expect(issuesOf(edit(BUYER, (d) => (d.rules = [{ ...RULE, rehearsal_run_id: "x" }]))).length).toBeGreaterThan(0);
    expect(issuesOf(edit(BUYER, (d) => (d.grants.connectors.supplier.limit = 1))).length).toBeGreaterThan(0);
  });
  it("カタログにない自律度のキー（browser_submit：KC §8 #29）・知らない値は拒否", () => {
    expect(issuesOf(edit(BUYER, (d) => (d.autonomy = { browser_submit: "approve" }))).length).toBeGreaterThan(0);
    expectInvalid(edit(BUYER, (d) => (d.autonomy = { mcp_write: "allow" })), "autonomy.mcp_write");
    // Hard Ceiling を超える値（mcp_write: auto）はスキーマでは通り、compose の violations（by: ceiling）になる（C-03）
    expectValid(edit(BUYER, (d) => (d.autonomy = { mcp_write: "auto" })));
  });
  it("名前は1〜40文字（文字で数える）、指示は 8,000 文字まで", () => {
    expectInvalid(edit(BUYER, (d) => (d.name = "")), "name");
    expectInvalid(edit(BUYER, (d) => (d.name = "   ")), "name");
    expectValid(edit(BUYER, (d) => (d.name = "係".repeat(40))));
    expectInvalid(edit(BUYER, (d) => (d.name = "係".repeat(41))), "name");
    expectValid(edit(BUYER, (d) => (d.name = "😀".repeat(40))));
    expectValid(edit(BUYER, (d) => (d.jobs[0].instructions = "あ".repeat(8000))));
    expectInvalid(edit(BUYER, (d) => (d.jobs[0].instructions = "あ".repeat(8001))), "jobs[0].instructions");
  });
  it("届け先が付与されていないツールは拒否（KC §8 #27）。付与済み・notify は通る", () => {
    expectInvalid(edit(BUYER, (d) => (d.jobs[0].deliver = [{ to: "mcp.mail.send", args: { to: "owner@example.com" } }])), "jobs[0].deliver[0].to");
    expectValid(
      edit(BUYER, (d) => {
        d.grants.connectors.mail = { grant: ["send"] };
        d.jobs[0].deliver = [{ to: "mcp.mail.send", args: { to: "owner@example.com" }, content: { body: "{{report.summary}}" } }, { to: "notify" }];
      }),
    );
  });
  it("watcher の仕事は MCP に届けられない（BR-40・KC §8 #28）。notify は通る", () => {
    const w = (deliver: unknown[]) =>
      edit(BUYER, (d) => {
        d.grants.connectors.mail = { grant: ["send"] };
        d.jobs[0].template = "watcher";
        d.jobs[0].deliver = deliver;
      });
    expectInvalid(w([{ to: "mcp.mail.send", args: { to: "owner@example.com" } }]), "jobs[0].deliver[0].to");
    expectValid(w([{ to: "notify" }]));
  });
  it("content に使える変数は report.title・summary・body・sources_markdown だけ（mcp-and-web.md:176）", () => {
    const withContent = (body: string) =>
      edit(BUYER, (d) => {
        d.grants.connectors.mail = { grant: ["send"] };
        d.jobs[0].deliver = [{ to: "mcp.mail.send", args: { to: "a@example.com" }, content: { body } }];
      });
    expectValid(withContent("{{report.title}}\n{{ report.body }}\n{{report.sources_markdown}}"));
    expect(issuesOf(withContent("{{env.SECRET}}")).length).toBeGreaterThan(0);
  });
  it("ガードは数値の範囲か候補のどちらか一方（BR-61）。条件なしも拒否", () => {
    const g = (guard: object) => edit(BUYER, (d) => (d.jobs[0].guards = [{ action: "mcp.supplier.place_order", arg: "items[].quantity", ...guard }]));
    expectValid(g({ max: 20 }));
    expectValid(g({ min: 1, max: 20, max_digits: 2 }));
    expectValid(g({ in: ["A"] }));
    expectInvalid(g({ max: 5, in: ["a"] }), "jobs[0].guards[0]");
    expectInvalid(g({}), "jobs[0].guards[0]");
    expectInvalid(g({ max_digits: 0 }), "jobs[0].guards[0].max_digits");
    expect(issuesOf(g({ max: Number.NaN })).length).toBeGreaterThan(0);
  });
  it("ガードを option 以外に付けたら拒否（ツールの情報があるとき。KC §8 #10）", () => {
    const g = (arg: string) => edit(BUYER, (d) => (d.jobs[0].guards = [{ action: "mcp.supplier.place_order", arg, max: 1 }]));
    expectInvalid(g("supplier_id"), "jobs[0].guards[0].arg", { tools: TOOLS });
    expectInvalid(g("note"), "jobs[0].guards[0].arg", { tools: TOOLS });
    expectInvalid(g("ship_to"), "jobs[0].guards[0].arg", { tools: TOOLS }); // 役割なし＝destination（BR-56）
    expectValid(g("items[].quantity"), { tools: TOOLS });
    expectValid(g("supplier_id")); // 情報がなければ見ない
  });
  it("スケジュールの最短間隔は1時間（BR-25）。タイムゾーンは IANA の名前", () => {
    const s = (trigger: object) => edit(BUYER, (d) => (d.jobs[0].trigger = trigger));
    expectValid(s({ type: "schedule", cron: "0 18 * * *", timezone: "Asia/Tokyo" }));
    expectValid(s({ type: "schedule", cron: "15 */2 * * 1-5", timezone: "UTC" }));
    expectInvalid(s({ type: "schedule", cron: "*/30 * * * *", timezone: "Asia/Tokyo" }), "jobs[0].trigger.cron");
    expectInvalid(s({ type: "schedule", cron: "0,30 9 * * *", timezone: "Asia/Tokyo" }), "jobs[0].trigger.cron");
    expectInvalid(s({ type: "schedule", cron: "0 18 * *", timezone: "Asia/Tokyo" }), "jobs[0].trigger.cron");
    expectInvalid(s({ type: "schedule", cron: "0 18 * * *", timezone: "Asia/Nowhere" }), "jobs[0].trigger.timezone");
    expectValid(s({ type: "watch", interval: "1h", targets: ["https://example.com"] }));
    expectInvalid(s({ type: "watch", interval: "30m", targets: ["https://example.com"] }), "jobs[0].trigger.interval");
    expectValid(s({ type: "manual" }));
    expect(issuesOf(s({ type: "github_label", label: "x" })).length).toBeGreaterThan(0);
  });
  it("ルールの形：tool_hash は 'sha256:' つきの小文字16進64桁（M-07）、操作名・引数のパス・日時", () => {
    const r = (over: object) => edit(BUYER, (d) => (d.rules = [{ ...RULE, ...over }]));
    expectValid(r({}));
    expectValid(r({ free: undefined })); // free の欠けは [] として読む（M-03）
    expectInvalid(r({ tool_hash: "a".repeat(64) }), "rules[0].tool_hash");
    expectInvalid(r({ tool_hash: `sha256:${"A".repeat(64)}` }), "rules[0].tool_hash");
    expectInvalid(r({ action: "supplier.place_order" }), "rules[0].action");
    expectInvalid(r({ action: "mcp.Supplier.place_order" }), "rules[0].action");
    expect(issuesOf(r({ match: { "a.b": 1 } })).length).toBeGreaterThan(0);
    expect(issuesOf(r({ match: { "items[].a[].b": 1 } })).length).toBeGreaterThan(0);
    expectInvalid(r({ added_at: "2026-10-03 18:00" }), "rules[0].added_at");
  });
  it("コネクタの slug は英小文字・数字・'-'（前後の空白は除いて見る）。ツール名に空白は使えない", () => {
    expectInvalid(edit(BUYER, (d) => (d.grants.connectors = { Store: { grant: ["get_inventory"] } })), 'grants.connectors.Store');
    expect(issuesOf(edit(BUYER, (d) => (d.grants.connectors = { "a.b": { grant: ["x"] } }))).length).toBeGreaterThan(0);
    expect(issuesOf(edit(BUYER, (d) => (d.grants.connectors.store.grant = ["get inventory"]))).length).toBeGreaterThan(0);
    const r = validateAgentDefinition(edit(BUYER, (d) => (d.grants.connectors = { " store ": { grant: [" get_inventory "] } })));
    expect(r.ok && r.definition.grants.connectors).toEqual({ store: { grant: ["get_inventory"] } });
  });
  it("項目のパスと日本語のメッセージ", () => {
    const issues = issuesOf(edit(BUYER, (d) => (d.budget.per_task_usd = 25)));
    expect(issues).toEqual([{ code: "AGENT_SCHEMA_INVALID", path: "budget.per_task_usd", message: expect.stringMatching(/[ぁ-んァ-ン一-龥]/) }]);
    expect(issuesOf(null).length).toBeGreaterThan(0);
    expect(issuesOf({ version: 1, name: "x" }).length).toBeGreaterThan(0);
  });
});

describe("正規化 normalizeAgentDefinition（KC §3.1）", () => {
  const messy: AgentDefinitionInput = {
    version: 2,
    name: "仕入れ係",
    grants: {
      web: { allow_domains: [" Example.COM ", "*", "example.com", ""] },
      connectors: {
        supplier: { grant: ["place_order", " list_products", "place_order"] },
        " supplier ": { grant: ["get_price"] },
        store: { grant: [] },
      },
    },
    autonomy: { mcp_read: "approve" },
    rules: [
      { ...RULE, id: "r-2", match: { supplier_id: " supplier-01 ", "items[].sku": ["MILK", "BEAN", "MILK"] }, free: ["items[].unit_price", "items[].quantity", "items[].unit_price"] },
      { ...RULE, id: "r-1", free: undefined },
    ],
    profile: ["b", "a", "b"],
    approvers: ["u2", "u1", "u2"],
    jobs: [
      { id: "zz", kind: "once", template: "researcher", instructions: "z" },
      { id: "aa", kind: "recurring", template: "assistant", instructions: "a", guards: [{ action: "mcp.supplier.place_order", arg: "items[].sku", in: [" B ", "A", "B"] }] },
    ],
  };
  const n = normalizeAgentDefinition(messy);
  it("コネクタ名・ツール名は trim、grant は重複なしの昇順、空の grant のキーは消す（同じ名前は合わせる）", () => {
    expect(n.grants.connectors).toEqual({ supplier: { grant: ["get_price", "list_products", "place_order"] } });
  });
  it("ドメインは trim・小文字・重複なしの昇順", () => {
    expect(n.grants.web).toEqual({ allow_domains: ["*", "example.com"] });
  });
  it("ルールの match：文字列は trim、配列は並べ替えるが重複は残す（M-09）。free は重複なしの昇順、欠けは []（M-03）", () => {
    expect(n.rules.map((r) => r.id)).toEqual(["r-1", "r-2"]);
    expect(n.rules[1]!.match).toEqual({ supplier_id: "supplier-01", "items[].sku": ["BEAN", "MILK", "MILK"] });
    expect(n.rules[1]!.free).toEqual(["items[].quantity", "items[].unit_price"]);
    expect(n.rules[0]!.free).toEqual([]);
    expect(n.rules[0]!.labels).toEqual({ supplier_id: "山田珈琲" }); // 表示用の項目は定義には残す
  });
  it("ガードの in は trim・重複なし・昇順。仕事は id の昇順、欠けたキーを埋める", () => {
    expect(n.jobs.map((j) => j.id)).toEqual(["aa", "zz"]);
    expect(n.jobs[0]!.guards[0]!.in).toEqual(["A", "B"]);
    expect(n.jobs[1]).toMatchObject({ trigger: null, deliver: [], guards: [] });
    expect(n).toMatchObject({ role: null, max_runs_per_day: 10, budget: {}, profile: ["a", "b"], approvers: ["u1", "u2"] });
  });
  it("最小の定義でも欠けたキーを埋める", () => {
    expect(normalizeAgentDefinition({ version: 2, name: "x" })).toEqual({
      version: 2,
      name: "x",
      role: null,
      grants: { connectors: {} },
      autonomy: {},
      rules: [],
      budget: {},
      max_runs_per_day: 10,
      profile: [],
      jobs: [],
    });
  });
  it("冪等。入力を変えず、入力と値を共有しない", () => {
    const copy = structuredClone(messy);
    expect(normalizeAgentDefinition(n)).toEqual(n);
    expect(messy).toEqual(copy);
    const m = normalizeAgentDefinition(messy);
    (m.budget as { per_task_usd?: number }).per_task_usd = 1;
    expect(messy.budget).toBeUndefined();
  });
  it("version 2 以外は例外（v1 の読み替えは 0-H では作らない）", () => {
    expect(() => normalizeAgentDefinition({ version: 1, name: "x" } as unknown as AgentDefinitionInput)).toThrow(TypeError);
    expect(() => normalizeAgentDefinition(null as unknown as AgentDefinitionInput)).toThrow(TypeError);
  });
  it("自律度はカタログのキーだけ残す", () => {
    const d = normalizeAgentDefinition({ version: 2, name: "x", autonomy: { mcp_read: "auto", browser_submit: "auto" } as never });
    expect(d.autonomy).toEqual({ mcp_read: "auto" });
  });
});

describe("最初の境界 initialAgentDefinition（agents.md:61-70・A-79・KC §6.10）", () => {
  const guest = defaultWorkspacePolicy("guest");
  it("I-01：ゲストの ws（per_day 4）で per_task_usd 0.2・per_day_usd 4（D-105・D-106）・max_runs_per_day 10、違反なし", () => {
    const d = initialAgentDefinition({ name: "新しい係", workspacePolicy: guest, workspaceKind: "guest" });
    expect(d.budget).toEqual({ per_task_usd: 0.2, per_day_usd: 4 });
    expect(d.max_runs_per_day).toBe(10);
    expect(d.autonomy).toEqual({ web_read: "auto", memory_write: "auto" });
    expect(d.grants).toEqual({ connectors: {} }); // ゲストは Web を付けない（KC §8 #22）
    expect(d).toMatchObject({ rules: [], jobs: [], profile: [], role: null });
    expect(composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy: guest, agent: d }).violations).toEqual([]);
    expectValid(d);
  });
  it("I-02：ws の per_task_usd 0.1 なら最初の境界も 0.1（ws に合わせる）", () => {
    const ws: WorkspacePolicy = { ...guest, budget: { ...guest.budget, per_task_usd: 0.1 } };
    expect(initialAgentDefinition({ name: "x", workspacePolicy: ws, workspaceKind: "guest" }).budget.per_task_usd).toBe(0.1);
  });
  it("I-03：ws の web_read が deny なら最初の境界も deny（ws の範囲で持つ）。不正な ws の値も切り詰めてから", () => {
    const ws: WorkspacePolicy = { ...guest, autonomy: { ...guest.autonomy, web_read: "deny" } };
    expect(initialAgentDefinition({ name: "x", workspacePolicy: ws, workspaceKind: "guest" }).autonomy.web_read).toBe("deny");
    const bad: WorkspacePolicy = { ...guest, autonomy: { ...guest.autonomy, web_read: "approve" } };
    expect(initialAgentDefinition({ name: "x", workspacePolicy: bad, workspaceKind: "guest" }).autonomy.web_read).toBe("deny");
  });
  it("オーナーは Web の付与 ['*']（KC §8 #22）、per_day_usd は 1（ws 10 より低い初期値）", () => {
    const d = initialAgentDefinition({ name: "x", role: "research", workspacePolicy: defaultWorkspacePolicy("owner"), workspaceKind: "owner" });
    expect(d.grants.web).toEqual({ allow_domains: ["*"] });
    expect(d.budget.per_day_usd).toBe(1);
    expect(d.role).toBe("research");
    expect(INITIAL_AGENT_BOUNDARY).toEqual({ autonomy: { web_read: "auto", memory_write: "auto" }, budget: { per_task_usd: 0.2, per_day_usd: 1 }, guest_per_day_usd: 4, max_runs_per_day: 10 });
  });
  it("D-105・D-106：ゲストの担当の1日は 4 まで。ws がそれより低ければ ws に合わせる（ゲストの ws が 1・2 のままの古いワークスペースではその値）", () => {
    expect(initialAgentDefinition({ name: "x", workspacePolicy: { ...guest, budget: { ...guest.budget, per_day_usd: 1 } }, workspaceKind: "guest" }).budget.per_day_usd).toBe(1);
    expect(initialAgentDefinition({ name: "x", workspacePolicy: { ...guest, budget: { ...guest.budget, per_day_usd: 2 } }, workspaceKind: "guest" }).budget.per_day_usd).toBe(2);
    expect(initialAgentDefinition({ name: "x", workspacePolicy: { ...guest, budget: { ...guest.budget, per_day_usd: 5 } }, workspaceKind: "guest" }).budget.per_day_usd).toBe(4);
    // オーナーは ws が 4 でも 1（変えない）
    expect(initialAgentDefinition({ name: "x", workspacePolicy: guest, workspaceKind: "owner" }).budget.per_day_usd).toBe(1);
  });
  it("性質：どのワークスペースのポリシーでも、最初の境界は違反を出さない（ws より緩くならない）", () => {
    const level = fc.constantFrom(...AUTONOMY_LEVELS);
    fc.assert(
      fc.property(
        fc.record({
          web_read: level,
          memory_write: level,
          per_task: fc.double({ min: 0.01, max: 30, noNaN: true }),
          per_day: fc.double({ min: 0.01, max: 300, noNaN: true }),
          kind: fc.constantFrom("owner" as const, "guest" as const),
        }),
        (r) => {
          const ws: WorkspacePolicy = {
            ...guest,
            autonomy: { ...guest.autonomy, web_read: r.web_read, memory_write: r.memory_write },
            budget: { ...guest.budget, per_task_usd: r.per_task, per_day_usd: r.per_day },
          };
          const d = initialAgentDefinition({ name: "x", workspacePolicy: ws, workspaceKind: r.kind });
          expect(composeAll({ ceilings: DEFAULT_CEILINGS, workspacePolicy: ws, agent: d }).violations).toEqual([]);
        },
      ),
    );
  });
  it("最初の境界に仕事を足しても compose できる（仕事がないうちは境界だけ）", () => {
    const d = initialAgentDefinition({ name: "x", workspacePolicy: guest, workspaceKind: "guest" });
    const withJob = { ...d, jobs: [{ id: "news", kind: "recurring" as const, template: "researcher" as const, instructions: "x" }] };
    expect(compose({ ceilings: DEFAULT_CEILINGS, workspacePolicy: guest, agent: withJob }, "news").effective.tools).toEqual(["finish", "notify", "submit_report"]);
  });
});

describe("cron・見張りの間隔（BR-25・KC §8 #17）", () => {
  it("parseCronSchedule：分と時の値の集合", () => {
    expect(parseCronSchedule("0 18 * * *")).toEqual({ minutes: [0], hours: [18] });
    expect(parseCronSchedule("15 */6 * * 1-5")).toEqual({ minutes: [15], hours: [0, 6, 12, 18] });
    expect(parseCronSchedule("0 9-11,20 * * MON")).toEqual({ minutes: [0], hours: [9, 10, 11, 20] });
    expect(parseCronSchedule("*/20 3 * * *")).toEqual({ minutes: [0, 20, 40], hours: [3] });
    expect(parseCronSchedule("0 5/8 * * *")).toEqual({ minutes: [0], hours: [5, 13, 21] });
  });
  it("parseCronSchedule：読めないものは null", () => {
    for (const c of ["", "0 18 * *", "60 18 * * *", "0 24 * * *", "0 18 * * * *", "a 18 * * *", "0 5-3 * * *", "0 */0 * * *", "0 18 ? * *"]) {
      expect(parseCronSchedule(c)).toBeNull();
    }
  });
  it("parseWatchIntervalMinutes", () => {
    expect(parseWatchIntervalMinutes("1h")).toBe(60);
    expect(parseWatchIntervalMinutes("90m")).toBe(90);
    expect(parseWatchIntervalMinutes("1d")).toBe(1440);
    expect(parseWatchIntervalMinutes("0h")).toBeNull();
    expect(parseWatchIntervalMinutes("1 hour")).toBeNull();
  });
});
