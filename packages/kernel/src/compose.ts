// compose()（FR-023。KC §3.3）：Hard Ceiling ∧ ワークスペースのポリシー ∧ エージェントの境界 ∧ 仕事のテンプレート ∧ 仕事のガード
// を項目ごとに厳しい方で合成し、仕事ごとの実効ポリシー（types.ts の EffectivePolicy。M-01）と policyHash を作る（D-19）。
// 定義がポリシーより緩い項目は violations（保存の前は AGENT_EXCEEDS_POLICY）と clamped（反映後は AGENT_CLAMPED）に同じ計算で出す（BR-21）。
// 純粋関数：LLM・I/O・時刻・乱数を使わず、入力を変えない（ADR-012）。判定できない値（有限でない数値など）は例外

import { normalizeForMatch } from "./args.ts";
import { hashCanonical } from "./canonical.ts";
import { mergeGuards } from "./guards.ts";
import {
  AUTONOMY_STRICTNESS,
  CATALOG_DEFAULT_AUTONOMY,
  DEFAULT_BREAKERS,
  DEFAULT_MAX_INTENTS_PER_TASK,
  TEMPLATES,
  clampAutonomyToCeiling,
  isAutonomyLevel,
  isCatalogToolName,
  normalizeAgentDefinition,
  stricterAutonomy,
  writableAutonomy,
} from "./policy.ts";
import type { AgentDefinition, AgentDefinitionInput, AgentJob, Ceilings, TemplateName, TemplateSpec, WorkspacePolicy } from "./policy.ts";
import { OPERATION_TYPES } from "./types.ts";
import type {
  ArgPath,
  AutonomyLevel,
  CatalogToolName,
  EffectivePolicy,
  EffectiveRule,
  Hex64,
  Json,
  MergedGuard,
  OperationType,
  ToolHash,
} from "./types.ts";

export interface ComposeInput {
  ceilings: Ceilings;
  workspacePolicy: WorkspacePolicy;
  /** リポジトリのポリシーはフェーズ1（開発テンプレート）。0-H で値が来たら例外（KC §6.3 C-51） */
  repoPolicy?: undefined;
  /** 適用済みでも変更案（未適用）でもよい */
  agent: AgentDefinitionInput;
  /** 既定は TEMPLATES */
  templates?: Readonly<Record<TemplateName, TemplateSpec>>;
}

/** 定義がポリシー・Hard Ceiling より緩い項目（09 common.md:144 の形） */
export interface PolicyViolation {
  code: "AGENT_EXCEEDS_POLICY";
  /** 'autonomy.mcp_write'・'budget.per_task_usd'・'grants.connectors.gmail' など */
  path: string;
  /** 定義に書いた値 */
  defined: Json;
  /** 超えた上限の値（自律度で by: ceiling のときは書ける値の一覧） */
  limit: Json;
  /** ワークスペースのポリシーを変えても書けないなら ceiling */
  by: "policy" | "ceiling";
  message: string;
}

/** 切り詰めた項目（定義の値と、実際に効く値） */
export interface ClampedItem {
  path: string;
  defined: Json;
  effective: Json;
}

/** 仕事によらないエージェントの境界（KC §3.3 B1〜B9） */
export interface AgentBoundary {
  version: 1;
  autonomy: Readonly<Record<OperationType, AutonomyLevel>>;
  budget: EffectivePolicy["budget"];
  breakers: EffectivePolicy["breakers"];
  max_intents_per_task: number;
  max_runs_per_day: number;
  /** connector → 付与したツール（ワークスペースで有効なものだけ。キー・値とも昇順） */
  grants: Readonly<Record<string, readonly string[]>>;
  web: EffectivePolicy["web"];
  rules: EffectivePolicy["rules"];
  approvers: readonly string[];
}

export interface BoundaryResult {
  boundary: AgentBoundary;
  violations: PolicyViolation[];
  clamped: ClampedItem[];
}

export interface ComposeResult {
  effective: EffectivePolicy;
  /** 小文字16進64桁（接頭辞なし：M-07） */
  effectivePolicyHash: Hex64;
  /** 保存・反映の前ならエラー（AGENT_EXCEEDS_POLICY） */
  violations: PolicyViolation[];
  /** 反映済みの定義をポリシーが厳しくなってから合成したなら警告（AGENT_CLAMPED） */
  clamped: ClampedItem[];
}

export interface ComposeAllResult {
  boundary: AgentBoundary;
  /** 仕事の id → 結果。仕事が0件なら {} */
  jobs: Record<string, ComposeResult>;
  violations: PolicyViolation[];
  clamped: ClampedItem[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(list: Iterable<string>): string[] {
  return [...new Set(list)].sort(compareText);
}

/** 比べる数値。有限でなければ例外（欠けた上限で比較が素通りしないように） */
function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`compose: ${path} が有限の数値でない`);
  return v;
}

/** 欠け（undefined）だけ既定値にする。null など不正な値は既定値に倒さず、そのまま検査に回す（判定できないなら許可しない） */
function orDefault<T>(v: T | undefined, d: T): T {
  return v === undefined ? d : v;
}

/** 保存の形の値を Json として写す（violations・clamped に入れる値を入力・出力と共有しない） */
function asJson(v: unknown): Json {
  return v === undefined ? null : (structuredClone(v) as Json);
}

/** 境界の合成（KC §3.3 B1〜B9）。agent は正規化済み */
function boundaryOf(ceilings: Ceilings, ws: WorkspacePolicy, agent: AgentDefinition): BoundaryResult {
  const violations: PolicyViolation[] = [];
  const clamped: ClampedItem[] = [];
  const violate = (path: string, defined: unknown, limit: unknown, by: "policy" | "ceiling", effective: unknown, message: string) => {
    violations.push({ code: "AGENT_EXCEEDS_POLICY", path, defined: asJson(defined), limit: asJson(limit), by, message });
    clamped.push({ path, defined: asJson(defined), effective: asJson(effective) });
  };

  // B1 自律度：ワークスペースの値も Hard Ceiling で切り詰める（NFR-056）。等しいのは違反でない
  const autonomy = {} as Record<OperationType, AutonomyLevel>;
  for (const op of OPERATION_TYPES) {
    const wsRaw = Object.hasOwn(ws.autonomy, op) ? ws.autonomy[op] : undefined;
    const wsLevel = clampAutonomyToCeiling(orDefault(wsRaw, CATALOG_DEFAULT_AUTONOMY[op]), op, ceilings);
    const defined: unknown = Object.hasOwn(agent.autonomy, op) ? agent.autonomy[op] : undefined;
    if (defined === undefined) {
      autonomy[op] = wsLevel;
      continue;
    }
    const path = `autonomy.${op}`;
    const allowed = writableAutonomy(op, ceilings);
    if (!isAutonomyLevel(defined)) {
      autonomy[op] = "deny"; // 知らない値は deny（判定できないなら許可しない）
      violate(path, defined, allowed, "ceiling", "deny", `${path} に ${String(defined)} は書けない（書ける値：${allowed.join("・")}）`);
      continue;
    }
    const eff = clampAutonomyToCeiling(stricterAutonomy(wsLevel, defined), op, ceilings);
    autonomy[op] = eff;
    if (!allowed.includes(defined)) {
      violate(path, defined, allowed, "ceiling", eff, `${path} に ${defined} は書けない（Hard Ceiling で書ける値：${allowed.join("・")}）`);
    } else if (AUTONOMY_STRICTNESS[defined] < AUTONOMY_STRICTNESS[wsLevel]) {
      violate(path, defined, wsLevel, "policy", eff, `${path} の ${defined} はワークスペースのポリシー（${wsLevel}）より緩い`);
    }
  }

  // B2・B3 予算・Breaker：最小値。定義の値が上限を「超える」と違反（等しいのは違反でない）
  const capped = (path: string, ceil: number, wsValue: number, defined: number | undefined): number => {
    const c = num(ceil, `ceilings.${path}`);
    const limit = Math.min(c, num(wsValue, `workspacePolicy.${path}`));
    if (defined === undefined) return limit;
    const d = num(defined, `agent.${path}`);
    if (d > limit) {
      const by = d > c ? "ceiling" : "policy";
      violate(path, d, limit, by, limit, `${path} の ${d} は上限 ${limit} を超える（${by === "ceiling" ? "Hard Ceiling" : "ワークスペースのポリシー"}）`);
    }
    return Math.min(limit, d);
  };
  const cb = ceilings.budget;
  const wb = ws.budget;
  const ab = agent.budget;
  const per_task_usd = capped("budget.per_task_usd", cb.per_task_usd, wb.per_task_usd, ab.per_task_usd);
  const max_steps = capped("budget.max_steps", cb.max_steps, wb.max_steps, ab.max_steps);
  const max_minutes = capped("budget.max_minutes", cb.max_minutes, wb.max_minutes, ab.max_minutes);
  // per_day_usd はワークスペースの日次の上限、agent_day_usd はエージェントの日次の上限。両方が別々に効く（policy-and-schema.md:291）
  const per_day_usd = Math.min(
    num(cb.per_day_usd, "ceilings.budget.per_day_usd"),
    num(wb.per_day_usd, "workspacePolicy.budget.per_day_usd"),
  );
  // エージェントの per_day_usd がワークスペースより大きいのも違反（KC §8 #11）
  const agent_day_usd = ab.per_day_usd === undefined ? null : capped("budget.per_day_usd", cb.per_day_usd, wb.per_day_usd, ab.per_day_usd);

  const wbr = ws.breakers ?? {};
  const abr = agent.breakers ?? {};
  const cbr = ceilings.breakers;
  const breakers = {
    same_action_repeat: capped(
      "breakers.same_action_repeat",
      cbr.same_action_repeat,
      orDefault(wbr.same_action_repeat, DEFAULT_BREAKERS.same_action_repeat),
      abr.same_action_repeat,
    ),
    denied_attempts_max: capped(
      "breakers.denied_attempts_max",
      cbr.denied_attempts_max,
      orDefault(wbr.denied_attempts_max, DEFAULT_BREAKERS.denied_attempts_max),
      abr.denied_attempts_max,
    ),
    step_cost_usd_max: capped(
      "breakers.step_cost_usd_max",
      cbr.step_cost_usd_max,
      orDefault(wbr.step_cost_usd_max, DEFAULT_BREAKERS.step_cost_usd_max),
      abr.step_cost_usd_max,
    ),
  };

  // B4 Intent の数：ワークスペースの項目（定義には書けない）
  const max_intents_per_task = Math.min(
    num(ceilings.max_intents_per_task, "ceilings.max_intents_per_task"),
    num(orDefault(ws.max_intents_per_task, DEFAULT_MAX_INTENTS_PER_TASK), "workspacePolicy.max_intents_per_task"),
  );

  // B5 実行回数：51 以上はスキーマで拒否するが、スキーマを通らずに来たら Hard Ceiling の違反にする
  const runsCeil = num(ceilings.max_runs_per_day, "ceilings.max_runs_per_day");
  const runsDefined = num(agent.max_runs_per_day, "agent.max_runs_per_day");
  if (runsDefined > runsCeil) {
    const message = `max_runs_per_day の ${runsDefined} は上限 ${runsCeil} を超える（Hard Ceiling）`;
    violate("max_runs_per_day", runsDefined, runsCeil, "ceiling", runsCeil, message);
  }
  const max_runs_per_day = Math.min(runsCeil, runsDefined);

  // B6 コネクタの付与：ワークスペースで有効なコネクタの部分集合（BR-20）。外れたものは effective から外す
  const enabled = new Set(ws.connectors.enabled.map((c) => c.trim()));
  const granted: Array<[string, readonly string[]]> = [];
  for (const c of Object.keys(agent.grants.connectors).sort(compareText)) {
    const grant = agent.grants.connectors[c]!.grant;
    if (enabled.has(c)) granted.push([c, [...grant]]);
    else violate(`grants.connectors.${c}`, grant, uniqueSorted(enabled), "policy", [], `コネクタ ${c} はワークスペースで有効になっていない`);
  }
  // Object.fromEntries は '__proto__' も自分のプロパティとして作る
  const grants: Readonly<Record<string, readonly string[]>> = Object.fromEntries(granted);

  // B7 Web：allow は定義の付与、deny はワークスペース ∪ Hard Ceiling（両方に当たるドメインは deny が勝つ。判定は Web 取得プロキシ）
  const web = {
    allow_domains: [...(agent.grants.web?.allow_domains ?? [])],
    deny_domains: uniqueSorted(
      [...ws.web.deny_domains, ...ceilings.web_always_deny].map((d) => d.trim().toLowerCase()).filter((d) => d !== ""),
    ),
    max_fetches_per_task: Math.min(
      num(ceilings.max_fetches_per_task, "ceilings.max_fetches_per_task"),
      num(ws.web.max_fetches_per_task, "workspacePolicy.web.max_fetches_per_task"),
    ),
  };

  // B8 ルール：判定に効く項目だけ（labels・added_*・source_intent_id・created_while_tainted は入れない：KC §8 #4・SG-09）。enabled = false でも項目は残す
  const rules = {
    enabled: ws.rules.enabled === true,
    items: agent.rules.map(
      (r): EffectiveRule => ({ id: r.id, action: r.action, match: r.match, free: [...r.free], tool_hash: r.tool_hash }),
    ),
  };

  // B9 承認者：ワークスペースに承認者があれば定義の指定はその部分集合（policy-and-schema.md:295）。0-H は空（Won't）
  const wsApprovers = uniqueSorted(ws.approvers);
  let approvers: string[] = agent.approvers === undefined ? wsApprovers : [...agent.approvers];
  if (wsApprovers.length > 0 && agent.approvers !== undefined) {
    const outside = agent.approvers.filter((a) => !wsApprovers.includes(a));
    if (outside.length > 0) {
      // 外れた人を除く。誰も残らなければワークスペースの承認者（空にすると BR-14 の既定に広がる）
      const kept = agent.approvers.filter((a) => wsApprovers.includes(a));
      approvers = kept.length > 0 ? kept : wsApprovers;
      violate("approvers", agent.approvers, wsApprovers, "policy", approvers, `承認者 ${outside.join("・")} はワークスペースのポリシーの承認者でない`);
    }
  }

  return {
    boundary: {
      version: 1,
      autonomy,
      budget: { per_task_usd, per_day_usd, agent_day_usd, max_steps, max_minutes },
      breakers,
      max_intents_per_task,
      max_runs_per_day,
      grants,
      web,
      rules,
      approvers,
    },
    violations,
    clamped,
  };
}

/** 仕事ごとの合成（KC §3.3 J1〜J4） */
function effectiveForJob(
  boundary: AgentBoundary,
  job: AgentJob,
  ceilings: Ceilings,
  templates: Readonly<Record<TemplateName, TemplateSpec>>,
): EffectivePolicy {
  const template = Object.hasOwn(templates, job.template) ? templates[job.template] : undefined;
  if (template === undefined) throw new TypeError(`compose: テンプレート ${String(job.template)} がない`);
  // J1 ツール：テンプレート ∩ 付与。remember・load_skill は 0-H では常に外す（メモリ・Skill はフェーズ1。memory.enabled = false の規則もこれで満たす）
  const hasWeb = boundary.web.allow_domains.length > 0;
  const hasGrants = Object.keys(boundary.grants).length > 0;
  const tools = uniqueSorted(
    template.tools.filter((t): t is CatalogToolName => {
      if (!isCatalogToolName(t) || t === "remember" || t === "load_skill") return false;
      if (t === "web_search" || t === "web_fetch") return hasWeb;
      if (t === "mcp_call") return hasGrants;
      return true;
    }),
  ) as CatalogToolName[];
  // J2 MCP：watcher は書き込みを持たない（BR-40 の Hard Ceiling。テンプレートの指定にかかわらず false）
  const noWrite = ceilings.watcherNoWrite === true && job.template === "watcher";
  const mcp = {
    llmRead: template.mcpLlm === "read" || template.mcpLlm === "read_write",
    llmWrite: !noWrite && template.mcpLlm === "read_write",
    deliverWrite: !noWrite && template.mcpDeliverWrite === true,
    grants: boundary.grants,
  };
  // J3 ガード：同じ (action, arg) は範囲・候補の積（D-57）。(action, arg) の昇順（matchedRule 'guards[i]' の i）
  const guards: MergedGuard[] = mergeGuards(job.guards);
  // J4 仕事どうし・境界と値を共有しない（呼び出し側が1つを書き換えても、ほかの仕事の実効ポリシーとハッシュがずれない）
  return structuredClone({
    version: 1 as const,
    autonomy: boundary.autonomy,
    budget: boundary.budget,
    breakers: boundary.breakers,
    max_intents_per_task: boundary.max_intents_per_task,
    max_runs_per_day: boundary.max_runs_per_day,
    tools,
    mcp,
    web: boundary.web,
    rules: boundary.rules,
    guards,
    approvers: boundary.approvers,
  });
}

/** 型にあるキーだけを取り出す（余計なキーを誤って持たせてもハッシュが変わらない。KD §3.3-3 と同じ考え方） */
function projectEffective(p: EffectivePolicy) {
  return {
    version: p.version,
    autonomy: Object.fromEntries(OPERATION_TYPES.map((op) => [op, p.autonomy[op]])),
    budget: {
      per_task_usd: p.budget.per_task_usd,
      per_day_usd: p.budget.per_day_usd,
      agent_day_usd: p.budget.agent_day_usd,
      max_steps: p.budget.max_steps,
      max_minutes: p.budget.max_minutes,
    },
    breakers: {
      same_action_repeat: p.breakers.same_action_repeat,
      denied_attempts_max: p.breakers.denied_attempts_max,
      step_cost_usd_max: p.breakers.step_cost_usd_max,
    },
    max_intents_per_task: p.max_intents_per_task,
    max_runs_per_day: p.max_runs_per_day,
    tools: p.tools,
    mcp: { llmRead: p.mcp.llmRead, llmWrite: p.mcp.llmWrite, deliverWrite: p.mcp.deliverWrite, grants: p.mcp.grants },
    web: { allow_domains: p.web.allow_domains, deny_domains: p.web.deny_domains, max_fetches_per_task: p.web.max_fetches_per_task },
    rules: {
      enabled: p.rules.enabled,
      items: p.rules.items.map((r) => ({ id: r.id, action: r.action, match: r.match, free: r.free, tool_hash: r.tool_hash })),
    },
    guards: p.guards.map((g) => ({
      action: g.action,
      arg: g.arg,
      min: g.min,
      max: g.max,
      max_digits: g.max_digits,
      in: g.in,
      empty: g.empty,
    })),
    approvers: p.approvers,
  };
}

/**
 * policyHash（KC §3.4、governance.md:97）：実効ポリシーの正規形 JSON（RFC 8785 相当）の SHA-256。小文字16進64桁で接頭辞なし（M-07）。
 * intentHash の effectivePolicyHash・action_intents.policy_hash・スナップショットに使う。
 * 集合の配列は compose が昇順に並べてあるので、入力の順が違っても同じ値になる。NaN などは例外
 */
export function effectivePolicyHash(effective: EffectivePolicy): Hex64 {
  return hashCanonical(projectEffective(effective));
}

function prepare(input: ComposeInput): { agent: AgentDefinition; templates: Readonly<Record<TemplateName, TemplateSpec>> } {
  // 開発テンプレートのリポジトリのポリシーは 0-H では Won't（C-51）
  if ((input as { repoPolicy?: unknown }).repoPolicy !== undefined) throw new TypeError("compose: repoPolicy は 0-H では扱わない");
  const agent = normalizeAgentDefinition(input.agent);
  const seen = new Set<string>();
  for (const j of agent.jobs) {
    if (seen.has(j.id)) throw new TypeError(`compose: 仕事の id ${j.id} が重複している`);
    seen.add(j.id);
  }
  return { agent, templates: input.templates ?? TEMPLATES };
}

/** 境界の合成（仕事によらない）。classify は境界どうしを比べる */
export function composeBoundary(input: ComposeInput): BoundaryResult {
  const { agent } = prepare(input);
  return boundaryOf(input.ceilings, input.workspacePolicy, agent);
}

function resultFor(
  b: BoundaryResult,
  job: AgentJob,
  input: ComposeInput,
  templates: Readonly<Record<TemplateName, TemplateSpec>>,
): ComposeResult {
  const effective = effectiveForJob(b.boundary, job, input.ceilings, templates);
  return {
    effective,
    effectivePolicyHash: effectivePolicyHash(effective),
    violations: b.violations.map((v) => ({ ...v })),
    clamped: b.clamped.map((c) => ({ ...c })),
  };
}

/**
 * 仕事ごとの実効ポリシー（FR-023、D-19）。jobId の仕事がなければ例外（呼び出し側のバグ）。
 * 使い方：保存・反映の前は violations が1件でもあれば反映しない。反映済みの定義の再合成では clamped を記録して effective で動かす。
 * decide() の policy には常にこの effective を渡す
 */
export function compose(input: ComposeInput, jobId: string): ComposeResult {
  const { agent, templates } = prepare(input);
  const job = agent.jobs.find((j) => j.id === jobId);
  if (job === undefined) throw new TypeError(`compose: 仕事 ${jobId} がない`);
  return resultFor(boundaryOf(input.ceilings, input.workspacePolicy, agent), job, input, templates);
}

/** すべての仕事の実効ポリシー。仕事が0件でも境界の違反は計算する（C-52） */
export function composeAll(input: ComposeInput): ComposeAllResult {
  const { agent, templates } = prepare(input);
  const b = boundaryOf(input.ceilings, input.workspacePolicy, agent);
  const jobs: Record<string, ComposeResult> = Object.fromEntries(agent.jobs.map((job) => [job.id, resultFor(b, job, input, templates)]));
  return { boundary: b.boundary, jobs, violations: b.violations, clamped: b.clamped };
}
