// 敵対的な見直し（統制を破る入力を探す）で見つけた穴の再現と、判定と独立に書いた照合による性質の試験。
// 対象：宛先の固定（BR-56・BR-69・M-12）・ガード（BR-61）・ルールの有効性（MT §3.6）・Hard Ceiling・classify の widen（KC §3.8）
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { argPathsByRole, argRoleAt, effectiveArgRoles, normalizeForMatch } from "./args.ts";
import { canonicalJson, hashCanonical } from "./canonical.ts";
import { classify } from "./classify.ts";
import type { ClassifyContext } from "./classify.ts";
import { compose } from "./compose.ts";
import { decide, recheckIntent } from "./decide.ts";
import { mergeGuards } from "./guards.ts";
import { destinationKey } from "./hashes.ts";
import { DEFAULT_CEILINGS, defaultWorkspacePolicy, validateAgentDefinition } from "./policy.ts";
import type { AgentDefinitionInput, ConnectorCatalog } from "./policy.ts";
import { buildRuleFromIntent, canOfferRemember } from "./remember.ts";
import { findMatchingRule, ruleValidity } from "./rules.ts";
import { OPERATION_TYPES } from "./types.ts";
import type {
  ArgRoleMap,
  AutonomyLevel,
  Counters,
  DecideResult,
  EffectivePolicy,
  EffectiveRule,
  Flags,
  Guard,
  Json,
  JsonObject,
  OperationType,
  Subject,
  TaintState,
  ToolHash,
  ToolInfo,
} from "./types.ts";

/** 試験の例のコネクタ（ワークスペースで有効にするもの） */
const EXAMPLE_CONNECTORS = ["bank", "mail", "store", "supplier"];

// ---- フィクスチャ ----

const H = (c: string): ToolHash => `sha256:${c.repeat(64)}`;
const SEND = "mcp.mail.send";
const PO = "mcp.supplier.place_order";
const ALL_DENY = Object.fromEntries(OPERATION_TYPES.map((op) => [op, "deny"])) as Record<OperationType, AutonomyLevel>;
const policyOf = (o: { rules?: EffectiveRule[]; guards?: EffectivePolicy["guards"]; tools?: unknown; grants?: Record<string, string[]> } = {}): EffectivePolicy => ({
  version: 1,
  autonomy: { ...ALL_DENY, mcp_read: "auto", mcp_write: "approve", notify: "auto" },
  budget: { per_task_usd: 0.5, per_day_usd: 1, agent_day_usd: null, max_steps: 40, max_minutes: 15 },
  breakers: { same_action_repeat: 5, denied_attempts_max: 3, step_cost_usd_max: 0.5 },
  max_intents_per_task: 5,
  max_runs_per_day: 10,
  tools: (o.tools ?? ["mcp_call", "notify", "submit_report", "finish"]) as EffectivePolicy["tools"],
  mcp: { llmRead: true, llmWrite: true, deliverWrite: true, grants: o.grants ?? { mail: ["send"], supplier: ["place_order"], svc: ["write"] } },
  web: { allow_domains: [], deny_domains: [], max_fetches_per_task: 0 },
  rules: { enabled: true, items: o.rules ?? [] },
  guards: o.guards ?? [],
  approvers: [],
});
const C0: Counters = {
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
const F0: Flags = { killSwitchEngaged: false, taskStatus: "running" };
const X0: TaintState = { tainted: false, sources: [] };
const mailTool = (argRoles: Record<string, unknown>, over: Partial<ToolInfo> = {}): ToolInfo => ({
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: H("c"),
  argRoles: argRoles as ArgRoleMap,
  ...over,
});
const mailCall = (tool: ToolInfo, args: JsonObject): Subject => ({ kind: "tool_call", actionType: "mcp_call", action: SEND, args, paths: [], tool, origin: "agent" });
const R_OWNER: EffectiveRule = { id: "r-mail", action: SEND, match: { to: "owner@example.com" }, free: [], tool_hash: H("c") };
const brief = (r: DecideResult) => [r.decision, r.reasonCode, r.matchedRule];
const APPROVAL = ["approve", "approval_required", "autonomy.mcp_write"];

describe("宛先の固定：役割の表に destination・content・option 以外の値があっても比べない引数を作らない（BR-56・BR-69・M-12）", () => {
  // 穴：argRoles の値が知らない文字列・null・undefined だと、その引数は destination にも option にも数えられず、
  // しかも argRoles に「ある」ので余計な引数（M-12）にもならなかった。宛先（bcc）を LLM が自由に変えても allow になった
  for (const [label, bad] of [
    ["知らない文字列（綴りの誤り）", "destinaton"],
    ["null（JSON の列で役割を消した値）", null],
    ["大文字の 'Destination'", "Destination"],
  ] as const) {
    it(`BR-56：役割が${label}の bcc を宛先として比べる → ルールが bcc を固定していなければ approval_required`, () => {
      const tool = mailTool({ to: "destination", bcc: bad, body: "content" });
      const r = decide(policyOf({ rules: [R_OWNER] }), mailCall(tool, { to: "owner@example.com", bcc: "attacker@evil.example", body: "x" }), C0, F0, X0);
      expect(brief(r)).toEqual(APPROVAL);
      // ルールは網羅の条件（bcc は destination）で無効
      expect(ruleValidity(R_OWNER, { action: SEND, tool, rulesEnabled: true })).toEqual({ valid: false, reason: "not_covering" });
    });
  }
  it("M-12：役割が undefined の bcc は役割なし（正規形 JSON でも無いのと同じ）→ 余計な引数として不一致（role: unknown）", () => {
    const tool = mailTool({ to: "destination", bcc: undefined, body: "content" });
    const r = decide(policyOf({ rules: [R_OWNER] }), mailCall(tool, { to: "owner@example.com", bcc: "attacker@evil.example", body: "x" }), C0, F0, X0);
    expect(brief(r)).toEqual(APPROVAL);
    expect(r.detail).toEqual({ kind: "rule_mismatch", ruleIndex: 0, argPath: "bcc", role: "unknown" });
  });
  it("NFR-036：役割の表の undefined の値は無いのと同じ（inputsHash が同じなら判定も同じ）", () => {
    const withUndef = mailTool({ to: "destination", bcc: undefined, body: "content" });
    const without = mailTool({ to: "destination", body: "content" });
    for (const args of [{ to: "owner@example.com", body: "x" }, { to: "owner@example.com", bcc: "a@evil.example", body: "x" }] as JsonObject[]) {
      const a = decide(policyOf({ rules: [R_OWNER] }), mailCall(withUndef, args), C0, F0, X0);
      const b = decide(policyOf({ rules: [R_OWNER] }), mailCall(without, args), C0, F0, X0);
      expect(a.inputsHash).toBe(b.inputsHash);
      expect(a).toEqual(b);
    }
  });
  it("BR-56：役割の壊れた bcc を固定したルールは、bcc を変えると不一致（destination の食い違い）、同じなら一致", () => {
    const tool = mailTool({ to: "destination", bcc: "bogus", body: "content" });
    const rule: EffectiveRule = { ...R_OWNER, match: { to: "owner@example.com", bcc: "audit@example.com" } };
    const call = (bcc: string) => decide(policyOf({ rules: [rule] }), mailCall(tool, { to: "owner@example.com", bcc, body: "x" }), C0, F0, X0);
    const evil = call("attacker@evil.example");
    expect(brief(evil)).toEqual(APPROVAL);
    expect(evil.detail).toEqual({ kind: "rule_mismatch", ruleIndex: 0, argPath: "bcc", role: "destination" });
    expect(brief(call(" audit@example.com "))).toEqual(["allow", "rule_matched", "rules.items[0]"]);
  });
  it("BR-68：役割の壊れた引数も destinationKey に入る（結果の分からない書き込みの出し直しを宛先違いと見なさない）", () => {
    const roles = { to: "destination", bcc: null, body: "content" } as unknown as ArgRoleMap;
    const a = destinationKey(SEND, { to: "owner@example.com", bcc: "a@evil.example" }, roles);
    const b = destinationKey(SEND, { to: "owner@example.com", bcc: "b@evil.example" }, roles);
    expect(a).not.toBe(b);
    expect(destinationKey(SEND, { to: "owner@example.com", bcc: "a@evil.example" }, { to: "destination", bcc: "destination", body: "content" })).toBe(a);
  });
  it("argRoleAt・argPathsByRole：content・option 以外の値は destination、argRoles にない・値が undefined のパスは undefined", () => {
    const roles = { ...(JSON.parse('{"to":"destination","bcc":null,"cc":"bogus","body":"content","rush":"option"}') as object), gone: undefined } as unknown as ArgRoleMap;
    expect(argRoleAt(roles, "bcc")).toBe("destination");
    expect(argRoleAt(roles, "cc")).toBe("destination");
    expect(argRoleAt(roles, "body")).toBe("content");
    expect(argRoleAt(roles, "rush")).toBe("option");
    expect(argRoleAt(roles, "gone")).toBeUndefined();
    expect(argRoleAt(roles, "nothing")).toBeUndefined();
    expect(argRoleAt(roles, "constructor")).toBeUndefined();
    expect(argPathsByRole(roles, "destination")).toEqual(["bcc", "cc", "to"]);
    expect(argPathsByRole(roles, "option")).toEqual(["rush"]);
  });
  it("MT §3.7・§3.8：[以後も許可] も役割の壊れた引数を destination として扱い、ルールに固定する", () => {
    const tool = mailTool({ to: "destination", bcc: "bogus", body: "content" });
    expect(canOfferRemember({ tool: mailTool({ body: "content", note: "bogus" }), effectiveMcpWrite: "approve", rulesEnabled: true, isHandoffOnly: false, isDryRun: false, currentRuleCount: 0 })).toEqual({ ok: true });
    const rule = buildRuleFromIntent({
      intent: { id: "i-1", action: SEND, args: { to: "owner@example.com", bcc: "audit@example.com", body: "x" }, toolHash: H("c") },
      tool,
      freeOptions: [],
      labels: {},
      addedBy: "u",
      now: "2026-10-03T09:00:00.000Z",
      newId: "r-1",
      createdWhileTainted: false,
    });
    expect(rule.match).toEqual({ to: "owner@example.com", bcc: "audit@example.com" });
    expect(ruleValidity({ ...rule }, { action: SEND, tool, rulesEnabled: true })).toEqual({ valid: true });
    expect(findMatchingRule([rule], SEND, { to: "owner@example.com", bcc: "attacker@evil.example" }, tool, true).matched).toBe(false);
  });
});

describe("ルールの tool_hash（MT §3.6-4・RU-04）と手順4-4 のツールの一覧（BR-09）：壊れた入力で通さない", () => {
  it("RU-04：ツールにもルールにも tool_hash がない（両方 undefined）→ tool_changed（undefined === undefined で有効にしない）", () => {
    const tool = { ...mailTool({ to: "destination", body: "content" }), toolHash: undefined } as unknown as ToolInfo;
    const rule = { ...R_OWNER, tool_hash: undefined } as unknown as EffectiveRule;
    expect(ruleValidity(rule, { action: SEND, tool, rulesEnabled: true })).toEqual({ valid: false, reason: "tool_changed" });
    expect(brief(decide(policyOf({ rules: [rule] }), mailCall(tool, { to: "owner@example.com", body: "x" }), C0, F0, X0))).toEqual(APPROVAL);
  });
  it("BR-09：実効ポリシーの tools が配列でない（文字列）なら部分一致で通さない → not_granted", () => {
    const tool = mailTool({ to: "destination", body: "content" });
    const p = policyOf({ rules: [R_OWNER], tools: "finish,mcp_call" });
    const r = decide(p, mailCall(tool, { to: "owner@example.com", body: "x" }), C0, F0, X0);
    expect(brief(r)).toEqual(["deny", "not_granted", "tools"]);
    expect(brief(recheckIntent(p, mailCall(tool, { to: "owner@example.com", body: "x" }), { unknownOutcomeKeys: [] }))).toEqual([
      "deny",
      "not_granted",
      "tools",
    ]);
  });
});

describe("effectiveArgRoles：スキーマのプロパティ名 '__proto__' も役割を持つ（MT §3.3。代入で消えない）", () => {
  const SCHEMA = JSON.parse('{"type":"object","properties":{"to":{"type":"string"},"__proto__":{"type":"string"},"body":{"type":"string"}}}') as Json;
  it("AR-02：確定のない '__proto__' は自分のプロパティとして destination（代入だと prototype の setter に吸われて役割がなくなっていた）", () => {
    const roles = effectiveArgRoles(SCHEMA, { to: "destination", body: "content" });
    expect(Object.hasOwn(roles, "__proto__")).toBe(true);
    expect(argRoleAt(roles, "__proto__")).toBe("destination");
    expect(Object.getPrototypeOf(roles)).toBe(Object.prototype);
    expect(argPathsByRole(roles, "destination")).toEqual(["__proto__", "to"]);
  });
  it("MT §3.8：'__proto__' の宛先もルールに固定され（prototype を差し替えない）、値が違えば不一致", () => {
    const roles = effectiveArgRoles(SCHEMA, { to: "destination", body: "content" });
    const tool = mailTool(roles);
    const args = JSON.parse('{"to":"owner@example.com","__proto__":"audit@example.com","body":"x"}') as JsonObject;
    const rule = buildRuleFromIntent({ intent: { id: "i-1", action: SEND, args, toolHash: H("c") }, tool, freeOptions: [], labels: JSON.parse('{"__proto__":"監査"}'), addedBy: "u", now: "2026-10-03T09:00:00.000Z", newId: "r-1", createdWhileTainted: false });
    expect(Object.hasOwn(rule.match, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(rule.match)).toBe(Object.prototype);
    expect(Object.hasOwn(rule.labels ?? {}, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(rule.labels ?? {}, "__proto__")?.value).toBe("監査");
    expect(ruleValidity(rule, { action: SEND, tool, rulesEnabled: true })).toEqual({ valid: true });
    const same = JSON.parse('{"to":"owner@example.com","__proto__":"audit@example.com","body":"y"}') as JsonObject;
    const evil = JSON.parse('{"to":"owner@example.com","__proto__":"attacker@evil.example","body":"y"}') as JsonObject;
    expect(brief(decide(policyOf({ rules: [rule] }), mailCall(tool, same), C0, F0, X0))).toEqual(["allow", "rule_matched", "rules.items[0]"]);
    expect(brief(decide(policyOf({ rules: [rule] }), mailCall(tool, evil), C0, F0, X0))).toEqual(APPROVAL);
  });
});

// ---- classify（KC §3.8）：無効なルールを有効にする変更・届け先の content ----

const T_PO: ToolInfo = {
  classification: "write",
  status: "ok",
  connectorEnabled: true,
  scope: null,
  toolHash: H("a"),
  argRoles: { supplier_id: "destination", "items[].sku": "option", "items[].quantity": "option", "items[].unit_price": "option", note: "content" },
};
const read = (h: string): ToolInfo => ({ classification: "read", status: "ok", connectorEnabled: true, scope: null, toolHash: H(h), argRoles: {} });
const T_MS = mailTool({ to: "destination", body: "content" });
const TOOLS: ConnectorCatalog = {
  store: { connected: true, tools: { get_inventory: read("1") } },
  supplier: { connected: true, tools: { list_products: read("2"), place_order: T_PO } },
  mail: { connected: true, tools: { list_inbox: read("3"), send: T_MS } },
};
const CTX: ClassifyContext = { ceilings: DEFAULT_CEILINGS, workspacePolicy: defaultWorkspacePolicy(EXAMPLE_CONNECTORS), tools: TOOLS };
const ruleInput = (match: Record<string, Json>, free: string[], id = "r-1") => ({
  id,
  action: PO,
  match,
  free,
  tool_hash: H("a"),
  added_by: "u",
  added_at: "2026-10-03T18:00:00+09:00",
});
const buyer = (o: { rules?: unknown[]; guards?: Guard[]; deliver?: unknown[]; template?: string } = {}): AgentDefinitionInput =>
  ({
    version: 2,
    name: "仕入れ係",
    grants: { connectors: { store: { grant: ["get_inventory"] }, supplier: { grant: ["list_products", "place_order"] }, mail: { grant: ["send"] } } },
    rules: o.rules ?? [],
    jobs: [
      { id: "reorder", kind: "recurring", template: o.template ?? "assistant", instructions: "x", trigger: null, deliver: o.deliver ?? [], guards: o.guards ?? [] },
    ],
  }) as AgentDefinitionInput;
const poCall = (quantity: number): Subject => ({
  kind: "tool_call",
  actionType: "mcp_call",
  action: PO,
  args: { supplier_id: "supplier-01", items: [{ sku: "BEAN", quantity, unit_price: 700 }], note: "" },
  paths: [],
  tool: T_PO,
  origin: "agent",
});
const effectiveOf = (d: AgentDefinitionInput) => compose({ ceilings: CTX.ceilings, workspacePolicy: CTX.workspacePolicy, agent: d }, "reorder").effective;
const judge = (d: AgentDefinitionInput, s: Subject) => recheckIntent(effectiveOf(d), s, { unknownOutcomeKeys: [] });

describe("classify：free と match の両方にあるキー（無効なルール：match_bad_key）を外して有効にする変更は widen（KC §3.8 ルールの細目）", () => {
  // 穴：重なったキーは前後とも FREE と読むので、重なりを外す変更が引数の状態の比較に出ず、項目なしの neutral になった。
  // 何も許さなかったルールが数量を自由にして有効になるのに、確認カードが出なかった
  const overlapping = buyer({ rules: [ruleInput({ supplier_id: "supplier-01", "items[].sku": ["BEAN"], "items[].quantity": [20] }, ["items[].quantity", "items[].unit_price"])] });
  const fixedUp = buyer({ rules: [ruleInput({ supplier_id: "supplier-01", "items[].sku": ["BEAN"] }, ["items[].quantity", "items[].unit_price"])] });
  it("前提：重なったルールは無効で何も許さず、重なりを外すと数量 200 が allow になる（実際に広がる）", () => {
    expect(brief(judge(overlapping, poCall(200)))).toEqual(APPROVAL);
    expect(brief(judge(fixedUp, poCall(200)))).toEqual(["allow", "rule_matched", "rules.items[0]"]);
  });
  it("K-24 系：重なりを外す変更 → widen（rule_changed）。確認カードの対象になる", () => {
    const r = classify({ before: overlapping, after: fixedUp, ctx: CTX });
    expect(r.classification).toBe("widen");
    expect(r.widenItems.map((i) => [i.kind, i.path])).toEqual([["rule_changed", "rules[r-1]"]]);
  });
  it("ツールの情報がない（未接続）ときも widen に倒す（有効か分からない）", () => {
    const ctx: ClassifyContext = { ...CTX, tools: { ...TOOLS, supplier: { connected: false, tools: {} } } };
    expect(classify({ before: overlapping, after: fixedUp, ctx }).classification).toBe("widen");
  });
  it("重なったまま値だけ変える（どちらも無効）・有効なルールに重なりを足す（無効になる）は widen にしない", () => {
    const overlapping2 = buyer({ rules: [ruleInput({ supplier_id: "supplier-01", "items[].sku": ["BEAN"], "items[].quantity": [5] }, ["items[].quantity", "items[].unit_price"])] });
    expect(classify({ before: overlapping, after: overlapping2, ctx: CTX }).widenItems).toEqual([]);
    expect(classify({ before: fixedUp, after: overlapping, ctx: CTX }).widenItems).toEqual([]);
  });
});

describe("届け先の content で destination・option を埋めない（mcp-and-web.md:176「宛先は定義から来たもの」、KC §3.8 届け先の細目）", () => {
  const R_MAIL = { id: "r-mail", action: SEND, match: { to: "owner@example.com" }, free: [], tool_hash: H("c"), added_by: "u", added_at: "2026-10-03T18:00:00+09:00" };
  const withDeliver = (content: Record<string, string>) =>
    buyer({ rules: [R_MAIL], template: "researcher", deliver: [{ to: SEND, args: { to: "owner@example.com" }, content }] });
  it("K-46 系：content で宛先（to）を報告の本文から埋める届け先は、args が既存のルールに一致しても widen（deliver_added_unmatched）", () => {
    const r = classify({ before: buyer({ rules: [R_MAIL], template: "researcher" }), after: withDeliver({ to: "{{report.body}}" }), ctx: CTX });
    expect(r.classification).toBe("widen");
    expect(r.widenItems.map((i) => i.kind)).toEqual(["deliver_added_unmatched"]);
  });
  it("content が content の引数（body）だけなら、既存のルールに一致する届け先は neutral（deliver_added_matched）のまま", () => {
    const r = classify({ before: buyer({ rules: [R_MAIL], template: "researcher" }), after: withDeliver({ body: "{{report.summary}}" }), ctx: CTX });
    expect(r.classification).toBe("neutral");
    expect(r.items.map((i) => i.kind)).toEqual(["deliver_added_matched"]);
  });
  it("K-47 系：同じ {to, args} の届け先で content だけを変え、宛先（to）を報告の本文から埋めるようにした → widen（定義が固定した宛先の届け先ではなくなる）", () => {
    const r = classify({ before: withDeliver({ body: "{{report.summary}}" }), after: withDeliver({ body: "{{report.summary}}", to: "{{report.body}}" }), ctx: CTX });
    expect(r.classification).toBe("widen");
    expect(r.items.map((i) => [i.kind, i.class])).toEqual([
      ["deliver_removed", "narrow"],
      ["deliver_added_unmatched", "widen"],
    ]);
    // content の文面だけの変更は neutral のまま（KC §3.8 届け先の細目）
    const plain = classify({ before: withDeliver({ body: "{{report.summary}}" }), after: withDeliver({ body: "{{report.body}}" }), ctx: CTX });
    expect(plain.items.map((i) => [i.kind, i.class])).toEqual([["deliver_content_changed", "neutral"]]);
  });
  it("FR-022：ツールの情報を渡した検証は、content に destination・option・役割のない引数を書いた届け先を AGENT_SCHEMA_INVALID にする", () => {
    const issues = (content: Record<string, string>) => {
      const v = validateAgentDefinition(withDeliver(content), { tools: TOOLS });
      return v.ok ? [] : v.issues.map((i) => i.path);
    };
    expect(issues({ body: "{{report.summary}}" })).toEqual([]);
    expect(issues({ to: "{{report.body}}" })).toEqual(["jobs[0].deliver[0].content.to"]);
    expect(issues({ cc: "{{report.title}}" })).toEqual(["jobs[0].deliver[0].content.cc"]);
    // ツールの情報がないときは見ない（guards と同じ）
    expect(validateAgentDefinition(withDeliver({ to: "{{report.body}}" })).ok).toBe(true);
  });
});

// ---- 性質：判定と独立に書いた照合（仕様の文から）で、mcp_write の allow を確かめ直す（KD §6.5 X6 を独立の実装で） ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** BR-56：argRoles にあるパスの役割。content・option 以外は destination。無い・undefined は役割なし */
const specRole = (roles: Obj, p: string): "destination" | "content" | "option" | undefined =>
  !Object.hasOwn(roles, p) || roles[p] === undefined ? undefined : roles[p] === "content" || roles[p] === "option" ? roles[p] : "destination";
/** mcp-and-web.md:120：文字列は trim、配列は多重集合（並べ替え・重複は残す）、オブジェクトは値を再帰で、欠けは null（M-10） */
const specNorm = (v: unknown): unknown => {
  if (v === undefined) return null;
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(specNorm).sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0));
  if (isObj(v)) return Object.fromEntries(Object.keys(v).filter((k) => v[k] !== undefined).map((k) => [k, specNorm(v[k])]));
  return v;
};
const specEq = (a: unknown, b: unknown) => canonicalJson(specNorm(a)) === canonicalJson(specNorm(b));
const ownOrNull = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) && o[k] !== undefined ? o[k] : null);
/** 'p' は最上位、'p[].f' は要素ごとの値の配列（容れ物が配列でなければ null） */
const specExtract = (args: Obj, p: string): unknown => {
  const i = p.indexOf("[].");
  if (i < 0) return ownOrNull(args, p);
  const c = ownOrNull(args, p.slice(0, i));
  return Array.isArray(c) ? c.map((e) => ownOrNull(e, p.slice(i + 3))) : null;
};
/** 有効なルールが「すべての destination と free でない option を完全一致で固定し、余計な引数がない」ことを満たすか（MT §3.6・BR-69・M-12） */
function specRuleAllows(rule: EffectiveRule, action: string, args: Obj, tool: ToolInfo): boolean {
  const roles = tool.argRoles as Obj;
  if (rule.action !== action || tool.classification !== "write") return false;
  if (typeof rule.tool_hash !== "string" || rule.tool_hash !== tool.toolHash) return false;
  const paths = Object.keys(roles).filter((p) => specRole(roles, p) !== undefined);
  const dests = paths.filter((p) => specRole(roles, p) === "destination");
  const opts = paths.filter((p) => specRole(roles, p) === "option");
  if (dests.length === 0 && tool.scope !== "self") return false;
  const match = rule.match as unknown;
  if (!isObj(match)) return false;
  const free: readonly string[] = Array.isArray(rule.free) ? rule.free : [];
  if (free.some((f) => specRole(roles, f) !== "option")) return false;
  if (Object.keys(match).some((k) => specRole(roles, k) === undefined || specRole(roles, k) === "content" || free.includes(k))) return false;
  if (!dests.every((d) => Object.hasOwn(match, d) && specEq(match[d], specExtract(args, d)))) return false;
  if (!opts.every((o) => free.includes(o) || specEq(Object.hasOwn(match, o) ? match[o] : null, specExtract(args, o)))) return false;
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (v === undefined) continue;
    if (/[.[\]]/.test(k)) return false;
    if (specRole(roles, k) !== undefined) continue;
    const fields = paths.filter((p) => p.startsWith(`${k}[].`)).map((p) => p.slice(k.length + 3));
    if (fields.length === 0) return false;
    if (v === null) continue;
    if (!Array.isArray(v) || !v.every((e) => isObj(e) && Object.keys(e).every((f) => e[f] === undefined || fields.includes(f)))) return false;
  }
  return true;
}
/** BR-61：元のガード（合成の前）をすべて満たすか。見つからない・型違い・空配列は外れ */
function specGuardsOk(guards: readonly Guard[], action: string, args: Obj): boolean {
  return guards
    .filter((g) => g.action === action)
    .every((g) => {
      const numeric = g.min !== undefined || g.max !== undefined || g.max_digits !== undefined;
      if (!numeric && g.in === undefined) return false;
      const i = g.arg.indexOf("[].");
      let values: unknown[];
      if (i < 0) {
        if (!Object.hasOwn(args, g.arg) || args[g.arg] === undefined) return false;
        values = [args[g.arg]];
      } else {
        const c = Object.hasOwn(args, g.arg.slice(0, i)) ? args[g.arg.slice(0, i)] : undefined;
        const f = g.arg.slice(i + 3);
        if (!Array.isArray(c) || c.length === 0 || !c.every((e) => isObj(e) && Object.hasOwn(e, f) && e[f] !== undefined)) return false;
        values = c.map((e) => (e as Obj)[f]);
      }
      return values.every((v) => {
        if (numeric) {
          if (typeof v !== "number" || !Number.isFinite(v)) return false;
          if (g.min !== undefined && v < g.min) return false;
          if (g.max !== undefined && v > g.max) return false;
          if (g.max_digits !== undefined && BigInt(Math.trunc(Math.abs(v))).toString().length > g.max_digits) return false;
        }
        if (g.in !== undefined) {
          if (typeof v !== "string" || !g.in.some((c) => c.trim() === v.trim())) return false;
        }
        return true;
      });
    });
}
/** BR-68：action と全 destination の正規形 */
const specDestKey = (action: string, args: Obj, roles: Obj) =>
  hashCanonical({
    action,
    destination: Object.fromEntries(
      Object.keys(roles)
        .filter((p) => specRole(roles, p) === "destination")
        .map((p) => [p, specNorm(specExtract(args, p))]),
    ),
  });

const SVC = "mcp.svc.write";
const PATHS = ["to", "cc", "subject", "priority", "items", "items[].sku", "items[].qty", "items[].price"] as const;
const arbRole = fc.oneof(
  { arbitrary: fc.constant<unknown>("destination"), weight: 3 },
  { arbitrary: fc.constant<unknown>("option"), weight: 5 },
  { arbitrary: fc.constant<unknown>("content"), weight: 2 },
  { arbitrary: fc.constantFrom<unknown>("bogus", null, "Destination", undefined), weight: 1 },
);
// 'items' と 'items[].x' の両方がある表（effectiveArgRoles は作らない形）も混ぜる
const arbRoles: fc.Arbitrary<Obj> = fc
  .subarray([...PATHS], { minLength: 1 })
  .chain((ps) => fc.tuple(...ps.map(() => arbRole)).map((rs) => Object.fromEntries(ps.map((p, i) => [p, rs[i]]))));
const arbStr = fc.constantFrom("a@x", " a@x ", "b@x", "A@X", "a@x​", "", "high", "low");
const arbNum = fc.constantFrom(0, 1, 5, 20, 21, -3, 999, 1000, 0.5);
const arbScalar = fc.oneof(arbStr, arbNum, fc.constantFrom<unknown>(null, true, "5", ["a@x"]));
// 役割のない要素のフィールド（ship_to）は改変（extraField）で足す
const arbElem = fc.record({ sku: fc.constantFrom("BEAN", " BEAN", "MILK"), qty: arbNum, price: arbNum }, { requiredKeys: [] });
const arbArgs: fc.Arbitrary<Obj> = fc.record(
  { to: arbScalar, cc: arbScalar, subject: arbScalar, priority: arbScalar, items: fc.oneof(fc.array(arbElem, { maxLength: 3 }), fc.constantFrom<unknown>(null, "x")) },
  { requiredKeys: [] },
);
/** 呼び出しの改変（承認したものから少しずらす）。余計な引数・'__proto__'・要素の追加・並べ替え・null・欠け */
type Mutation =
  | { op: "set"; key: string; value: unknown }
  | { op: "extra"; key: string; value: unknown }
  | { op: "drop"; key: string }
  | { op: "elem"; how: "dup" | "reverse" | "extraField" | "nonObject" | "pop" | "split" };
const arbMutation: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({ op: fc.constant("set" as const), key: fc.constantFrom("to", "cc", "subject", "priority"), value: arbScalar }),
  fc.record({ op: fc.constant("extra" as const), key: fc.constantFrom("bcc", "zzz", "__proto__", "constructor"), value: arbScalar }),
  fc.record({ op: fc.constant("drop" as const), key: fc.constantFrom("to", "cc", "subject", "priority", "items") }),
  fc.record({ op: fc.constant("elem" as const), how: fc.constantFrom("dup", "reverse", "extraField", "nonObject", "pop", "split") as fc.Arbitrary<"dup"> }),
);
function mutate(base: Obj, ms: readonly Mutation[]): Obj {
  const a: Obj = structuredClone(base);
  for (const m of ms) {
    if (m.op === "set") a[m.key] = m.value;
    else if (m.op === "extra") Object.defineProperty(a, m.key, { value: m.value, enumerable: true, writable: true, configurable: true });
    else if (m.op === "drop") delete a[m.key];
    else if (Array.isArray(a.items)) {
      const items = a.items as unknown[];
      if (m.how === "dup" && items.length > 0) items.push(structuredClone(items[0]));
      else if (m.how === "reverse") items.reverse();
      else if (m.how === "extraField" && isObj(items[0])) items[0].ship_to = "evil";
      else if (m.how === "nonObject") items.push("x");
      else if (m.how === "pop") items.pop();
      else if (m.how === "split" && isObj(items[0])) items.push({ ...items[0] }); // 同じ品目を2行に分ける
    }
  }
  return a;
}
/** 重みつきで「なし」を多めに（allow の境目の近くを試すため） */
const mostlyNone = <V>(none: V, some: fc.Arbitrary<V>) => fc.oneof({ arbitrary: fc.constant(none), weight: 3 }, { arbitrary: some, weight: 1 });
const GUARD_POOL_X: Guard[] = [
  { action: SVC, arg: "items[].qty", max: 20 },
  { action: SVC, arg: "items[].qty", min: 1 },
  { action: SVC, arg: "items[].price", max: 800, max_digits: 3 },
  { action: SVC, arg: "items[].sku", in: ["BEAN"] },
  { action: SVC, arg: "priority", in: ["high"] },
  { action: SVC, arg: "to", max: 3 },
  { action: "mcp.svc.other", arg: "items[].qty", max: 0 },
];
/** buildRuleFromIntent と同じ作り方を仕様の文から（destination と free でない option を固定）。少しずらした壊れたルールも混ぜる */
const arbCaseX = fc
  .record({
    roles: arbRoles,
    base: arbArgs,
    mutations: mostlyNone<Mutation[]>([], fc.array(arbMutation, { minLength: 1, maxLength: 2 })),
    freePick: fc.array(fc.boolean(), { minLength: PATHS.length, maxLength: PATHS.length }),
    ruleTweak: mostlyNone("none", fc.constantFrom("dropKey", "tweakSubject", "staleHash", "freeAll")),
    scope: fc.constantFrom<ToolInfo["scope"]>(null, null, null, "self"),
    classification: mostlyNone<ToolInfo["classification"]>("write", fc.constantFrom("unclassified", "read")),
    guardPick: mostlyNone<Guard[]>([], fc.subarray(GUARD_POOL_X, { minLength: 1, maxLength: 3 })),
    unknownPick: mostlyNone<Array<"base" | "call" | "other">>([], fc.subarray(["base", "call", "other"] as const, { minLength: 1 })),
    kind: fc.constantFrom<Subject["kind"]>("tool_call", "tool_call", "intent"),
    rulesEnabled: mostlyNone(true, fc.constant(false)),
  })
  .map((c) => {
    const roles = c.roles;
    // 承認した呼び出しは役割のある引数だけ（余計な引数は改変で足す）。allow の境目の近くを多く試すため
    const base: Obj = Object.fromEntries(
      Object.entries(c.base).filter(([k]) => Object.hasOwn(roles, k) || Object.keys(roles).some((p) => p.startsWith(`${k}[].`))),
    );
    const tool: ToolInfo = { classification: c.classification, status: "ok", connectorEnabled: true, scope: c.scope, toolHash: H("e"), argRoles: roles as ArgRoleMap };
    const paths = Object.keys(roles);
    let free = paths.filter((p, i) => specRole(roles, p) === "option" && c.freePick[i % c.freePick.length] === true);
    if (c.ruleTweak === "freeAll") free = paths;
    const fixed = paths.filter((p) => (specRole(roles, p) === "destination" || specRole(roles, p) === "option") && !free.includes(p));
    const match: Record<string, Json> = Object.fromEntries(fixed.map((p) => [p, specNorm(specExtract(base, p)) as Json]));
    if (c.ruleTweak === "dropKey" && fixed.length > 0) delete match[fixed[0]!];
    if (c.ruleTweak === "tweakSubject") match.subject = "x";
    const rule: EffectiveRule = { id: "r-x", action: SVC, match, free, tool_hash: c.ruleTweak === "staleHash" ? H("9") : H("e") };
    const args = mutate(base, c.mutations);
    const keys = { base: specDestKey(SVC, base, roles), call: specDestKey(SVC, args, roles), other: "e".repeat(64) };
    const policy: EffectivePolicy = {
      ...policyOf({ rules: [rule], guards: mergeGuards(c.guardPick) }),
      rules: { enabled: c.rulesEnabled, items: [rule] },
    };
    const subject: Subject = { kind: c.kind, actionType: "mcp_call", action: SVC, args: args as JsonObject, paths: [], tool, origin: c.kind === "intent" ? "deliver" : "agent" };
    const counters: Counters = { ...C0, unknownOutcomeKeys: c.unknownPick.map((k) => keys[k]) };
    return { policy, subject, counters, flags: F0, rawGuards: c.guardPick, rule };
  });

describe("性質：mcp_write の allow を判定と独立に書いた照合で確かめ直す（KD §6.5 X6、BR-39・BR-56・BR-61・BR-68・BR-69、M-09〜M-12）", () => {
  it("X6（独立の照合）：allow なら、rules.enabled・ルールが宛先と free でない option を完全一致で固定・余計な引数なし・ガードの範囲内・宛先が結果不明でない", () => {
    let allowed = 0;
    fc.assert(
      fc.property(arbCaseX, (c) => {
        const r = decide(c.policy, c.subject, c.counters, c.flags, X0);
        if (r.decision !== "allow" || r.operation !== "mcp_write") return;
        allowed++;
        const args = c.subject.args as Obj;
        const tool = c.subject.tool!;
        expect(c.policy.rules.enabled).toBe(true);
        expect(c.policy.rules.items.some((rule) => specRuleAllows(rule, SVC, args, tool)), JSON.stringify({ roles: tool.argRoles, args, rule: c.rule })).toBe(true);
        expect(specGuardsOk(c.rawGuards, SVC, args)).toBe(true);
        expect(c.counters.unknownOutcomeKeys).not.toContain(specDestKey(SVC, args, tool.argRoles as Obj));
      }),
      { numRuns: 3000 },
    );
    expect(allowed).toBeGreaterThan(150);
  }, 60_000);
  it("逆向き：独立の照合がすべて満たされる書き込みは allow（照合が判定と同じ規則を書いていることの確かめ）", () => {
    let checked = 0;
    fc.assert(
      fc.property(arbCaseX, (c) => {
        const args = c.subject.args as Obj;
        const tool = c.subject.tool!;
        const ok =
          c.policy.rules.enabled &&
          c.policy.rules.items.some((rule) => specRuleAllows(rule, SVC, args, tool)) &&
          specGuardsOk(c.rawGuards, SVC, args) &&
          !c.counters.unknownOutcomeKeys.includes(specDestKey(SVC, args, tool.argRoles as Obj));
        if (!ok) return;
        checked++;
        expect(brief(decide(c.policy, c.subject, c.counters, c.flags, X0))).toEqual(["allow", "rule_matched", "rules.items[0]"]);
      }),
      { numRuns: 3000 },
    );
    expect(checked).toBeGreaterThan(150);
  }, 60_000);
});

// ---- 性質：ルールの引数ごとの状態の変更（free と match の重なりを含む）で、widen の項目がなければ allow の集合が増えない（KC §6.10 PB-07） ----

const RULE_KEYS = ["supplier_id", "items[].sku", "items[].quantity", "items[].unit_price", "note", "ghost"] as const;
type KeyState = "fixed" | "fixed2" | "free" | "absent" | "both";
const V1: Record<(typeof RULE_KEYS)[number], Json> = { supplier_id: "s1", "items[].sku": ["A"], "items[].quantity": [20], "items[].unit_price": [700], note: "n", ghost: "g" };
const V2: Record<(typeof RULE_KEYS)[number], Json> = { supplier_id: "s2", "items[].sku": ["A", "B"], "items[].quantity": [5], "items[].unit_price": [800], note: "m", ghost: "h" };
// content（note）・役割のない引数（ghost）をルールに書くと無効なので、ほとんどは absent にする（有効なルールの近くを試す）
const arbKeyStates = fc.tuple(
  ...RULE_KEYS.map((k) =>
    k === "note" || k === "ghost"
      ? fc.oneof({ arbitrary: fc.constant<KeyState>("absent"), weight: 6 }, { arbitrary: fc.constantFrom<KeyState>("fixed", "free", "both"), weight: 1 })
      : k === "supplier_id"
        ? fc.constantFrom<KeyState>("fixed", "fixed", "fixed", "fixed2", "free", "absent", "both")
        : fc.constantFrom<KeyState>("fixed", "fixed2", "free", "absent", "both", "both"),
  ),
);
const arbRuleSpec = fc.record({ states: arbKeyStates, hash: fc.constantFrom(H("a"), H("a"), H("a"), H("b")) });
/** 引数の状態を変える（key が RULE_KEYS.length なら tool_hash）か、重なりを外す・足す（both ↔ free、fixed → both） */
type RuleEdit = { key: number; state: KeyState } | { key: number; toggle: true };
const arbEdits = fc.array(
  fc.oneof(
    { arbitrary: fc.record({ key: fc.integer({ min: 0, max: RULE_KEYS.length }), state: fc.constantFrom<KeyState>("fixed", "fixed2", "free", "absent", "both") }), weight: 2 },
    { arbitrary: fc.record({ key: fc.integer({ min: 0, max: RULE_KEYS.length - 1 }), toggle: fc.constant(true as const) }), weight: 1 },
  ) as fc.Arbitrary<RuleEdit>,
  { minLength: 1, maxLength: 2 },
);
function ruleOfStates(spec: { states: KeyState[]; hash: ToolHash }) {
  const match: Record<string, Json> = {};
  const free: string[] = [];
  RULE_KEYS.forEach((k, i) => {
    const st = spec.states[i];
    if (st === "fixed" || st === "both") match[k] = V1[k];
    if (st === "fixed2") match[k] = V2[k];
    if (st === "free" || st === "both") free.push(k);
  });
  return ruleInput(match, free);
}
const RULE_SUBJECTS: Subject[] = [];
for (const supplier_id of ["s1", "s2"]) {
  for (const skus of [["A"], ["A", "B"]]) {
    for (const quantity of [20, 5]) {
      for (const unit_price of [700, 800]) {
        RULE_SUBJECTS.push({ ...poCall(0), args: { supplier_id, items: skus.map((sku) => ({ sku, quantity, unit_price })), note: "n" } });
      }
    }
  }
}
const allowedOf = (d: AgentDefinitionInput) => RULE_SUBJECTS.map((s) => judge(d, s).decision === "allow");

describe("性質：ルールの引数ごとの状態の変更（KC §3.8 ルールの細目・§6.10 PB-07）", () => {
  it("PB-07：widen の項目がない変更では allow になる呼び出しが増えない（free と match の重なり・無効なルールの有効化を含む）", () => {
    let checked = 0;
    fc.assert(
      fc.property(arbRuleSpec, arbEdits, (b, edits) => {
        // after は before の引数1〜2個の状態（か tool_hash）を変えたもの
        const a = { states: [...b.states], hash: b.hash };
        for (const e of edits) {
          const cur = a.states[e.key];
          if ("toggle" in e) a.states[e.key] = cur === "both" ? "free" : cur === "free" || cur === "fixed" ? "both" : (cur ?? "absent");
          else if (e.key === RULE_KEYS.length) a.hash = e.state === "fixed" ? H("a") : H("b");
          else a.states[e.key] = e.state;
        }
        const before = buyer({ rules: [{ ...ruleOfStates(b), tool_hash: b.hash }] });
        const after = buyer({ rules: [{ ...ruleOfStates(a), tool_hash: a.hash }] });
        const r = classify({ before, after, ctx: CTX });
        if (r.widenItems.length > 0) return;
        checked++;
        const allowB = allowedOf(before);
        allowedOf(after).forEach((ok, i) => {
          if (ok) expect(allowB[i], JSON.stringify({ before: b, after: a, subject: RULE_SUBJECTS[i]!.args })).toBe(true);
        });
      }),
      { numRuns: 2000 },
    );
    expect(checked).toBeGreaterThan(300);
  }, 120_000);
});
