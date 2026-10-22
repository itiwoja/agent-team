// classify()（FR-036。KC §3.8）：エージェントの定義の変更を narrow / neutral / widen に分け、widen の項目の一覧を返す（ADR-027）。
// before・after を同じ ctx（同じワークスペースのポリシー・Hard Ceiling）で compose() し、実効の値どうしを項目ごとに比べる（governance.md:110）。
// 「許す範囲」が同じ → 項目なし、後 ⊂ 前 → narrow、一部でも広がる・比べられない → widen。全体は最も広い分類（項目がなければ neutral）。
// 純粋関数（I/O・時刻・乱数を使わない）

import { argRoleAt, valuesEqualForMatch } from "./args.ts";
import { canonicalJson } from "./canonical.ts";
import { composeAll } from "./compose.ts";
import type { AgentBoundary, ComposeAllResult, PolicyViolation } from "./compose.ts";
import {
  AUTONOMY_STRICTNESS,
  normalizeAgentDefinition,
  parseCronSchedule,
  parseMcpAction,
  parseWatchIntervalMinutes,
} from "./policy.ts";
import type {
  AgentDefinition,
  AgentDefinitionInput,
  AgentJob,
  Ceilings,
  ConnectorCatalog,
  JobDeliver,
  TemplateName,
  TemplateSpec,
  WorkspacePolicy,
} from "./policy.ts";
import { findMatchingRule, ruleValidity } from "./rules.ts";
import { OPERATION_TYPES } from "./types.ts";
import type { CatalogToolName, EffectivePolicy, EffectiveRule, Json, JsonObject, MergedGuard, ToolInfo } from "./types.ts";

export const CHANGE_CLASSES = ["narrow", "neutral", "widen"] as const;
export type ChangeClass = (typeof CHANGE_CLASSES)[number];
/** 全体の分類の順（「最も広い分類」governance.md:112） */
export const CHANGE_ORDER: Readonly<Record<ChangeClass, number>> = Object.freeze({ narrow: 0, neutral: 1, widen: 2 });

/** 項目の種類（KC §2.7。memory_changed・approvers_changed は表の 16・17（Won't）を数えるために足した） */
export const CHANGE_KINDS = [
  "autonomy_loosened",
  "autonomy_tightened",
  "budget_raised",
  "budget_lowered",
  "agent_day_cap_added",
  "agent_day_cap_removed",
  "breaker_raised",
  "breaker_lowered",
  "runs_raised",
  "runs_lowered",
  "grant_added",
  "grant_removed",
  "web_granted",
  "web_revoked",
  "domains_widened",
  "domains_narrowed",
  "rule_added",
  "rule_removed",
  "rule_changed",
  "rule_rebound",
  "rule_option_freed",
  "rule_option_fixed",
  "guard_added",
  "guard_removed",
  "guard_narrowed",
  "guard_widened",
  "job_added",
  "job_removed",
  "template_changed",
  "template_widened",
  "instructions_changed",
  "trigger_changed",
  "kind_changed",
  "notify_changed",
  "deliver_added_notify",
  "deliver_added_matched",
  "deliver_added_unmatched",
  "deliver_removed",
  "deliver_content_changed",
  "profile_changed",
  "name_changed",
  "appearance_changed",
  "role_changed",
  "memory_changed",
  "approvers_changed",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ChangeItem {
  kind: ChangeKind;
  class: ChangeClass;
  /**
   * 例 'autonomy.mcp_read'・'grants.connectors.supplier[place_order]'・'rules[r-1].args[items[].quantity]'・
   * 'jobs[reorder].guards[mcp.supplier.place_order|items[].quantity]'
   */
  path: string;
  /** 仕事の項目だけ（jobId がなければエージェントの全仕事：KC §8 #36） */
  jobId?: string;
  before?: Json;
  after?: Json;
}

/** 足りないもの（governance.md:115） */
export type MissingItem =
  | { kind: "connector_not_connected"; connector: string }
  | { kind: "tool_not_found"; connector: string; tool: string }
  | { kind: "tool_unclassified"; connector: string; tool: string };

export interface ClassifyContext {
  ceilings: Ceilings;
  workspacePolicy: WorkspacePolicy;
  /** 既定は TEMPLATES */
  templates?: Readonly<Record<TemplateName, TemplateSpec>>;
  /** 届け先の照合・ルールの有効性・「足りないもの」に使う今のツールの情報（KC §7 C-19） */
  tools: ConnectorCatalog;
}

export interface ClassifyInput {
  /** いまの定義 */
  before: AgentDefinitionInput;
  /** 変更案を当てた定義 */
  after: AgentDefinitionInput;
  ctx: ClassifyContext;
}

export interface ClassifyResult {
  /** 全体（最も広いもの。変更がなければ neutral） */
  classification: ChangeClass;
  /** すべての項目（記録・変更履歴用） */
  items: ChangeItem[];
  /** 確認カードに並べる（governance.md:112） */
  widenItems: ChangeItem[];
  /** D-46：narrow の項目が1つでもあれば、その仕事の running のタスクを cancelled（policy_narrowed）にする（KC §8 #18） */
  hasNarrow: boolean;
  missing: MissingItem[];
  /** 後の定義の1日の起動回数の見込みが max_runs_per_day を超える（Should。分類には入れない） */
  runsWarning: { estimatedRunsPerDay: number; maxRunsPerDay: number } | null;
  /** compose(after) の violations。空でなければ呼び出し側は反映しない（UC-026 E1） */
  violations: PolicyViolation[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asJson(v: unknown): Json {
  return v === undefined ? null : (structuredClone(v) as Json);
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** 判定の時点のツールの情報（なければ undefined） */
function toolOf(tools: ConnectorCatalog, action: string): ToolInfo | undefined {
  const p = parseMcpAction(action);
  const connector = p === null ? undefined : own(tools, p.connector);
  if (p === null || connector === undefined || connector.connected !== true) return undefined;
  return own(connector.tools, p.tool);
}

// ---- Web のドメインの包含（KC §8 #16） ----

/** パターン p が q を含むか：'*' はすべて、同じ文字列、'*.x' は '.x' で終わるもの（'*.y.x' も含む。'x' 自身は含まない） */
function domainContains(p: string, q: string): boolean {
  if (p === "*" || p === q) return true;
  return p.startsWith("*.") && q.endsWith(p.slice(1));
}

/** after の各パターンが before のどれかに含まれる（判定できないものは含まれない＝widen に倒す） */
function domainsWithin(after: readonly string[], before: readonly string[]): boolean {
  return after.every((q) => before.some((p) => domainContains(p, q)));
}

// ---- ガードの包含（KC §3.8 ガードの細目） ----

/** a の許す値 ⊆ b の許す値。前の各制約について、後が同じかより厳しい制約を持つこと */
function guardWithin(a: MergedGuard, b: MergedGuard): boolean {
  if (a.empty) return true;
  if (b.empty) return false;
  if (b.min !== undefined && (a.min === undefined || a.min < b.min)) return false;
  if (b.max !== undefined && (a.max === undefined || a.max > b.max)) return false;
  if (b.max_digits !== undefined && (a.max_digits === undefined || a.max_digits > b.max_digits)) return false;
  if (b.in !== undefined && (a.in === undefined || a.in.some((v) => !b.in!.includes(v)))) return false;
  return true;
}

/** 許す値が同じ（制約がすべて等しい。どちらも empty なら同じ） */
function sameGuard(a: MergedGuard, b: MergedGuard): boolean {
  if (a.empty && b.empty) return true;
  return (
    a.empty === b.empty &&
    a.min === b.min &&
    a.max === b.max &&
    a.max_digits === b.max_digits &&
    canonicalJson(a.in ?? null) === canonicalJson(b.in ?? null)
  );
}

// ---- ルールの引数ごとの状態（KC §3.8 ルールの細目） ----

type ArgState = { state: "free" } | { state: "fixed"; value: Json } | { state: "absent" };

function argState(r: EffectiveRule, k: string): ArgState {
  if (r.free.includes(k)) return { state: "free" };
  if (Object.hasOwn(r.match, k)) return { state: "fixed", value: r.match[k] ?? null };
  return { state: "absent" }; // 「なし」で固定（BR-69）
}

function stateJson(s: ArgState): Json {
  return s.state === "fixed" ? { state: "fixed", value: asJson(s.value) } : { state: s.state };
}

/** ツールの情報で有効と分かるか。情報がない・無効なら false */
function knownValid(r: EffectiveRule, tools: ConnectorCatalog): boolean {
  const tool = toolOf(tools, r.action);
  if (tool === undefined) return false;
  const v = ruleValidity(r, { action: r.action, tool, rulesEnabled: true });
  return v !== "not_applicable" && v.valid;
}

/** ツールの情報で無効と分かるか（無効なルールは何も許さない） */
function knownInvalid(r: EffectiveRule, tools: ConnectorCatalog): boolean {
  const tool = toolOf(tools, r.action);
  if (tool === undefined) return false;
  const v = ruleValidity(r, { action: r.action, tool, rulesEnabled: true });
  return v !== "not_applicable" && !v.valid;
}

// ---- テンプレートの細目（KC §3.8） ----

/** 前の境界で付与済みか（finish・submit_report・notify は最初の境界の組み込み） */
function grantedIn(t: CatalogToolName, b: AgentBoundary): boolean {
  if (t === "finish" || t === "submit_report" || t === "notify") return true;
  if (t === "web_search" || t === "web_fetch") return b.web.allow_domains.length > 0;
  if (t === "mcp_call") return Object.keys(b.grants).length > 0;
  return false;
}

/** テンプレートで決まる実効ポリシーの能力の旗（KC §2.6 の mcp.*。compose の J2） */
const MCP_FLAGS = ["llmRead", "llmWrite", "deliverWrite"] as const;
type McpFlag = (typeof MCP_FLAGS)[number];

/**
 * 付与（connector → tool）に、読み取り・書き込みに当たるツールがあるか。decide と同じく read 以外（write・unclassified）は
 * 書き込み（ADR-022）。ctx.tools に情報がない（未接続・ないツール）ものは分類が分からないので両方に数える（安全側）
 */
function grantKinds(grants: Readonly<Record<string, readonly string[]>>, tools: ConnectorCatalog): { read: boolean; write: boolean } {
  let read = false;
  let write = false;
  for (const [c, ts] of Object.entries(grants)) {
    const connector = own(tools, c);
    for (const t of ts) {
      const info = connector === undefined || connector.connected !== true ? undefined : own(connector.tools, t);
      if (info === undefined || info.classification === "read") read = true;
      if (info === undefined || info.classification !== "read") write = true;
    }
  }
  return { read, write };
}

/**
 * その旗が後の実効ポリシーで効くか（使えない旗は「できるようになること」として出さない：KC §3.8 テンプレートの細目と同じ考え方）。
 * LLM の旗は mcp_call が渡され（付与あり。J1）、届け先の旗は付与があるときだけ。読み取り／書き込みの旗は、それに当たるツールの付与があるときだけ
 */
function flagUsable(flag: McpFlag, e: EffectivePolicy, kinds: { read: boolean; write: boolean }): boolean {
  if (flag === "deliverWrite") return kinds.write;
  if (!e.tools.includes("mcp_call")) return false;
  return flag === "llmRead" ? kinds.read : kinds.write;
}

// ---- 実行回数の見込み（Should。KC §8 #17） ----

/** 1日の起動回数の見込み（最大）。once・トリガーなし・manual は 0。読めない cron・間隔は最悪の値 */
function runsPerDay(job: AgentJob): number {
  const t = job.trigger;
  if (job.kind === "once" || t === null || t.type === "manual") return 0;
  if (t.type === "schedule") {
    const s = parseCronSchedule(t.cron);
    return s === null ? 1440 : s.minutes.length * s.hours.length;
  }
  const m = parseWatchIntervalMinutes(t.interval);
  return m === null ? 1440 : Math.ceil(1440 / m);
}

/** occurrence つきの鍵で並べる（同じ id が2つあっても取りこぼさない。スキーマは重複を拒否する） */
function keyedRules(items: readonly EffectiveRule[]): Map<string, { id: string; rule: EffectiveRule }> {
  const out = new Map<string, { id: string; rule: EffectiveRule }>();
  const count = new Map<string, number>();
  for (const rule of items) {
    const n = count.get(rule.id) ?? 0;
    count.set(rule.id, n + 1);
    out.set(JSON.stringify([rule.id, n]), { id: rule.id, rule });
  }
  return out;
}

function sortedUnion<T>(a: Map<string, T>, b: Map<string, T>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort(compareText);
}

/**
 * 変更の分類（FR-036）。before・after は保存されている形のままでよい（入口で正規化する）。
 * 呼び出し側：narrow・neutral はすぐ反映、widen は確認カード。violations が空でなければ反映しない。
 * 外部の内容に影響されたタスクからの変更案は分類に関係なく確認カード（BR-51：classify の外）
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const { ctx } = input;
  const before = normalizeAgentDefinition(input.before);
  const after = normalizeAgentDefinition(input.after);
  const composeOf = (agent: AgentDefinition): ComposeAllResult =>
    composeAll({
      ceilings: ctx.ceilings,
      workspacePolicy: ctx.workspacePolicy,
      agent,
      ...(ctx.templates === undefined ? {} : { templates: ctx.templates }),
    });
  const B = composeOf(before);
  const A = composeOf(after);
  const items: ChangeItem[] = [];
  const push = (kind: ChangeKind, cls: ChangeClass, path: string, extra: { jobId?: string; before?: unknown; after?: unknown } = {}) => {
    const item: ChangeItem = { kind, class: cls, path };
    if (extra.jobId !== undefined) item.jobId = extra.jobId;
    if ("before" in extra) item.before = asJson(extra.before);
    if ("after" in extra) item.after = asJson(extra.after);
    items.push(item);
  };

  // 9 名前・役割・見た目・プロフィールの公開（すべて neutral：BR-48・BR-50）
  if (before.name !== after.name) push("name_changed", "neutral", "name", { before: before.name, after: after.name });
  if (before.role !== after.role) push("role_changed", "neutral", "role", { before: before.role, after: after.role });
  if (!same(before.appearance, after.appearance)) {
    push("appearance_changed", "neutral", "appearance", { before: before.appearance, after: after.appearance });
  }
  if (!same(before.profile, after.profile)) push("profile_changed", "neutral", "profile", { before: before.profile, after: after.profile });

  const bb = B.boundary;
  const ab = A.boundary;

  // 1 自律度（実効値の厳しさ）
  for (const op of OPERATION_TYPES) {
    const d = AUTONOMY_STRICTNESS[ab.autonomy[op]] - AUTONOMY_STRICTNESS[bb.autonomy[op]];
    if (d > 0) push("autonomy_tightened", "narrow", `autonomy.${op}`, { before: bb.autonomy[op], after: ab.autonomy[op] });
    else if (d < 0) push("autonomy_loosened", "widen", `autonomy.${op}`, { before: bb.autonomy[op], after: ab.autonomy[op] });
  }

  // 2〜5 予算・Breaker・実行回数（大きいほど緩い）
  const numeric = (path: string, x: number, y: number, raised: ChangeKind, lowered: ChangeKind) => {
    if (y > x) push(raised, "widen", path, { before: x, after: y });
    else if (y < x) push(lowered, "narrow", path, { before: x, after: y });
  };
  for (const k of ["per_task_usd", "max_steps", "max_minutes"] as const) {
    numeric(`budget.${k}`, bb.budget[k], ab.budget[k], "budget_raised", "budget_lowered");
  }
  // 3 agent_day_usd：null は上限なし（∞）
  const dayB = bb.budget.agent_day_usd;
  const dayA = ab.budget.agent_day_usd;
  if (dayB === null && dayA !== null) push("agent_day_cap_added", "narrow", "budget.agent_day_usd", { before: null, after: dayA });
  else if (dayB !== null && dayA === null) push("agent_day_cap_removed", "widen", "budget.agent_day_usd", { before: dayB, after: null });
  else if (dayB !== null && dayA !== null) numeric("budget.agent_day_usd", dayB, dayA, "budget_raised", "budget_lowered");
  for (const k of ["same_action_repeat", "denied_attempts_max", "step_cost_usd_max"] as const) {
    numeric(`breakers.${k}`, bb.breakers[k], ab.breakers[k], "breaker_raised", "breaker_lowered");
  }
  numeric("max_runs_per_day", bb.max_runs_per_day, ab.max_runs_per_day, "runs_raised", "runs_lowered");
  // per_day_usd・max_intents_per_task・web.deny_domains・max_fetches_per_task・rules.enabled はワークスペースの項目（ctx が1つなので変わらない：K-55）

  // 6 コネクタのツールの付与：(connector, tool) の集合。読み取りのツールでも足せば widen
  const pairs = (g: Readonly<Record<string, readonly string[]>>) =>
    new Map(Object.entries(g).flatMap(([c, ts]) => ts.map((t): [string, [string, string]] => [JSON.stringify([c, t]), [c, t]])));
  const grantsB = pairs(bb.grants);
  const grantsA = pairs(ab.grants);
  for (const key of sortedUnion(grantsB, grantsA)) {
    const [c, t] = (grantsA.get(key) ?? grantsB.get(key))!;
    const path = `grants.connectors.${c}[${t}]`;
    if (!grantsB.has(key)) push("grant_added", "widen", path, { after: t });
    else if (!grantsA.has(key)) push("grant_removed", "narrow", path, { before: t });
  }

  // 7 Web の付与・ドメイン（Should）
  const webB = bb.web.allow_domains;
  const webA = ab.web.allow_domains;
  if (webB.length === 0 && webA.length > 0) push("web_granted", "widen", "grants.web.allow_domains", { before: webB, after: webA });
  else if (webB.length > 0 && webA.length === 0) push("web_revoked", "narrow", "grants.web.allow_domains", { before: webB, after: webA });
  else if (webB.length > 0) {
    const narrowed = domainsWithin(webA, webB);
    if (!(narrowed && domainsWithin(webB, webA))) {
      const detail = { before: webB, after: webA };
      if (narrowed) push("domains_narrowed", "narrow", "grants.web.allow_domains", detail);
      else push("domains_widened", "widen", "grants.web.allow_domains", detail);
    }
  }

  // 8 ルール（id で突き合わせる。labels・added_by・added_at・source_intent_id・created_while_tainted は実効ポリシーに入らないので比べない：SG-09）
  const rulesB = keyedRules(bb.rules.items);
  const rulesA = keyedRules(ab.rules.items);
  for (const key of sortedUnion(rulesB, rulesA)) {
    const rb = rulesB.get(key);
    const ra = rulesA.get(key);
    if (rb === undefined) {
      push("rule_added", "widen", `rules[${ra!.id}]`, { after: ra!.rule }); // 「以後も許可」のルールの追加
      continue;
    }
    if (ra === undefined) {
      push("rule_removed", "narrow", `rules[${rb.id}]`, { before: rb.rule }); // ルールの取り消し
      continue;
    }
    const x = rb.rule;
    const y = ra.rule;
    const path = `rules[${rb.id}]`;
    if (x.action !== y.action) {
      push("rule_changed", "widen", `${path}.action`, { before: x.action, after: y.action });
      continue;
    }
    let widened = false;
    let changed = false;
    if (x.tool_hash !== y.tool_hash) {
      widened = true;
      push("rule_rebound", "widen", `${path}.tool_hash`, { before: x.tool_hash, after: y.tool_hash }); // 再確認で引き継いだ
    }
    const keys = [...new Set([...Object.keys(x.match), ...x.free, ...Object.keys(y.match), ...y.free])].sort(compareText);
    for (const k of keys) {
      const sb = argState(x, k);
      const sa = argState(y, k);
      if (sb.state === sa.state && (sb.state !== "fixed" || valuesEqualForMatch(sb.value, (sa as { value: Json }).value))) continue;
      changed = true;
      const p = `${path}.args[${k}]`;
      const detail = { before: stateJson(sb), after: stateJson(sa) };
      if (sb.state === "free") {
        push("rule_option_fixed", "narrow", p, detail); // 変わってよい → 固定・なし（D-60）
        continue;
      }
      widened = true;
      if (sa.state === "free") push("rule_option_freed", "widen", p, detail); // 固定・なし → 変わってよい（D-60）
      else push("rule_changed", "widen", p, detail); // 値の変更・固定 ↔ なし（宛先がなしになると実際は無効だが安全側に widen）
    }
    // free と match の両方にあるキー（無効なルール：match_bad_key）は前後とも FREE と読むので、重なりを外す・足す変更が
    // 引数の状態の比較に出ない。match・free の中身が違えば変更として数え、下の補い（無効 → 有効なら widen）にかける
    if (!changed && (!same(x.match, y.match) || !same(x.free, y.free))) changed = true;
    // 前のルールが無効（何も許さない）だったのに後で有効になり得るなら、引数ごとの比較が narrow でも広がる（安全側の補い）
    if (changed && !widened && !knownValid(x, ctx.tools) && !knownInvalid(y, ctx.tools)) {
      push("rule_changed", "widen", path, { before: x, after: y });
    }
  }

  // 17 承認者（Won't）：空は BR-14 の既定。比べられないものは widen
  const apB = bb.approvers;
  const apA = ab.approvers;
  if (!same(apB, apA)) {
    const narrowed = apB.length > 0 && apA.length > 0 && apA.every((a) => apB.includes(a));
    push("approvers_changed", narrowed ? "narrow" : "widen", "approvers", { before: apB, after: apA });
  }
  // 16 メモリ（Won't）：無効にする・上限を下げる → narrow、有効にする・上げる → widen
  const memB = before.memory?.enabled === true ? before.memory.max_items : null;
  const memA = after.memory?.enabled === true ? after.memory.max_items : null;
  if (memB !== memA) {
    const narrowed = memA === null || (memB !== null && memA < memB);
    push("memory_changed", narrowed ? "narrow" : "widen", "memory", { before: before.memory, after: after.memory });
  }

  // 10〜15 仕事（id で突き合わせる）
  const existingRules = bb.rules.items.filter((r) => ab.rules.items.some((s) => same(r, s)));
  const rulesEnabled = ab.rules.enabled;
  /**
   * 届け先が「既存のルール」（前の定義のルールで後にも同じ中身で残るもの）に一致するか（KC §8 #14）。情報がない・needs_review は一致しない。
   * content で destination・option（・役割のない引数）を埋める届け先は、宛先を報告の本文（LLM）が決めるので一致としない
   * （mcp-and-web.md:176「宛先は定義から来たもの」。実行時は args ＋ content で判定するので args だけの照合では足りない：IA §3.6-3）
   */
  const deliverMatched = (d: JobDeliver): boolean => {
    if (!rulesEnabled) return false;
    const tool = toolOf(ctx.tools, d.to);
    if (tool === undefined || tool.status !== "ok" || tool.connectorEnabled !== true) return false;
    if (fillsNonContent(d)) return false;
    return findMatchingRule(existingRules, d.to, (d.args ?? {}) as JsonObject, tool, true).matched;
  };
  /** MCP の届け先の content が content 以外の引数（destination・option・役割のない引数）を埋めるか。ツールの情報があるときだけ分かる */
  function fillsNonContent(d: JobDeliver): boolean {
    if (d.to === "notify") return false;
    const tool = toolOf(ctx.tools, d.to);
    return tool !== undefined && Object.keys(d.content ?? {}).some((k) => argRoleAt(tool.argRoles, k) !== "content");
  }
  const jobsB = new Map(before.jobs.map((j) => [j.id, j]));
  const jobsA = new Map(after.jobs.map((j) => [j.id, j]));
  for (const id of sortedUnion(jobsB, jobsA)) {
    const jb = jobsB.get(id);
    const ja = jobsA.get(id);
    const at = (suffix: string) => `jobs[${id}]${suffix}`;
    const opt = (extra: { before?: unknown; after?: unknown } = {}) => ({ jobId: id, ...extra });
    if (ja === undefined) {
      push("job_removed", "narrow", at(""), opt({ before: { template: jb!.template } })); // 仕事を消す（governance.md:119）
      continue;
    }
    // 13 テンプレート：後に使うツール（付与で絞ったあと）が前の境界で付与済みでなければ widen（governance.md:111）。
    //    付与済みの範囲なら template_changed（neutral。governance.md:120）。能力の旗が広がる分は下の 13b で別に widen にする
    const ea = A.jobs[id]!.effective;
    const ungranted = ea.tools.filter((t) => !grantedIn(t, bb));
    if (jb === undefined) {
      push("job_added", "neutral", at(""), opt({ after: { template: ja.template } })); // 仕事の追加そのものは neutral（governance.md:113）
      if (ungranted.length > 0) push("template_widened", "widen", at(".template"), opt({ before: null, after: ja.template }));
    } else if (jb.template !== ja.template) {
      if (ungranted.length > 0) push("template_widened", "widen", at(".template"), opt({ before: jb.template, after: ja.template }));
      else push("template_changed", "neutral", at(".template"), opt({ before: jb.template, after: ja.template }));
    }
    // 13b 能力の旗（実効ポリシーの mcp.llmRead・llmWrite・deliverWrite）：テンプレートの変更・仕事の追加で false → true になり、
    //     後の付与でそれが効くなら widen（この段階の決定 (a)。BR-47 の趣旨：LLM・届け先が書き込めるようになる変更を設定プランナーが
    //     確認なしで反映しない。KC §8 #15 の代案を採り、K-40 を widen に直した）。前は、両方にある仕事ならその仕事の前の実効ポリシー、
    //     仕事の追加なら前の定義のどれかの仕事（エージェントにもうある能力。消して足し直しても旗の分はすり抜けない）。
    //     旗は ceilings（watcherNoWrite）とテンプレートだけで決まるので、テンプレートが同じなら項目は出ない。true → false は neutral のまま（K-42）
    const kinds = grantKinds(ea.mcp.grants, ctx.tools);
    for (const flag of MCP_FLAGS) {
      const had = jb === undefined ? Object.values(B.jobs).some((j) => j.effective.mcp[flag]) : B.jobs[id]!.effective.mcp[flag];
      if (!had && ea.mcp[flag] && flagUsable(flag, ea, kinds)) {
        push("template_widened", "widen", at(`.mcp.${flag}`), opt({ before: false, after: true }));
      }
    }
    if (jb !== undefined) {
      // 12 指示・調整メモ・トリガー・種類・通知の設定（neutral。トリガーの頻度は max_runs_per_day で頭打ち）
      if (jb.instructions !== ja.instructions) {
        push("instructions_changed", "neutral", at(".instructions"), opt({ before: jb.instructions, after: ja.instructions }));
      }
      if ((jb.tuning ?? "") !== (ja.tuning ?? "")) {
        push("instructions_changed", "neutral", at(".tuning"), opt({ before: jb.tuning, after: ja.tuning }));
      }
      if (!same(jb.trigger, ja.trigger)) push("trigger_changed", "neutral", at(".trigger"), opt({ before: jb.trigger, after: ja.trigger }));
      if (jb.kind !== ja.kind) push("kind_changed", "neutral", at(".kind"), opt({ before: jb.kind, after: ja.kind }));
      if (!same(jb.notify, ja.notify)) push("notify_changed", "neutral", at(".notify"), opt({ before: jb.notify, after: ja.notify }));
    }

    // 14 届け先：鍵は {to, args}（content は鍵に入れない）。同じ鍵が複数あれば数で比べる
    const group = (list: readonly JobDeliver[]) => {
      const m = new Map<string, JobDeliver[]>();
      for (const d of list) {
        const k = canonicalJson({ to: d.to, args: d.args ?? {} });
        m.set(k, [...(m.get(k) ?? []), d]);
      }
      return m;
    };
    const dB = group(jb?.deliver ?? []);
    const dA = group(ja.deliver);
    for (const k of sortedUnion(dB, dA)) {
      const xs = dB.get(k) ?? [];
      const ys = dA.get(k) ?? [];
      const n = Math.min(xs.length, ys.length);
      for (let i = 0; i < n; i++) {
        const x = xs[i]!;
        const y = ys[i]!;
        if (same(x.content ?? {}, y.content ?? {})) continue;
        if (fillsNonContent(y)) {
          // content で宛先・option を報告の本文から埋めるようになった＝定義が固定した宛先の届け先ではなくなる（mcp-and-web.md:176）。
          // 「content だけの変更（neutral）」ではないので、前の届け先を外して既存のルールに一致しない届け先を足したものとして数える
          push("deliver_removed", "narrow", at(`.deliver[${x.to}]`), opt({ before: x }));
          push("deliver_added_unmatched", "widen", at(`.deliver[${y.to}]`), opt({ after: y }));
        } else push("deliver_content_changed", "neutral", at(`.deliver[${y.to}]`), opt({ before: x, after: y }));
      }
      for (const d of ys.slice(n)) {
        const p = at(`.deliver[${d.to}]`);
        if (d.to === "notify") push("deliver_added_notify", "neutral", p, opt({ after: d }));
        else if (deliverMatched(d)) push("deliver_added_matched", "neutral", p, opt({ after: d }));
        else push("deliver_added_unmatched", "widen", p, opt({ after: d })); // 既存のルールに一致しない宛先（mcp-and-web.md:178）
      }
      for (const d of xs.slice(n)) push("deliver_removed", "narrow", at(`.deliver[${d.to}]`), opt({ before: d }));
    }

    // 15 ガード（mergeGuards 後の (action, arg) ごと）：追加・狭める・候補を減らす → narrow、削除・広げる・候補を足す → widen（BR-61）
    const guardMap = (list: readonly MergedGuard[]) => new Map(list.map((g) => [JSON.stringify([g.action, g.arg]), g]));
    const gB = guardMap(jb === undefined ? [] : B.jobs[id]!.effective.guards);
    const gA = guardMap(A.jobs[id]!.effective.guards);
    for (const k of sortedUnion(gB, gA)) {
      const x = gB.get(k);
      const y = gA.get(k);
      const g = (y ?? x)!;
      const p = at(`.guards[${g.action}|${g.arg}]`);
      if (x === undefined) push("guard_added", "narrow", p, opt({ after: y }));
      else if (y === undefined) push("guard_removed", "widen", p, opt({ before: x }));
      else if (sameGuard(x, y)) continue;
      else if (guardWithin(y, x)) push("guard_narrowed", "narrow", p, opt({ before: x, after: y }));
      else push("guard_widened", "widen", p, opt({ before: x, after: y }));
    }
  }

  // 足りないもの：後の定義の付与のうち、未接続のコネクタ・ないツール・未分類のツール（未分類は書き込み扱いでルールを持てない）
  const missing: MissingItem[] = [];
  for (const c of Object.keys(after.grants.connectors).sort(compareText)) {
    const connector = own(ctx.tools, c);
    if (connector === undefined || connector.connected !== true) {
      missing.push({ kind: "connector_not_connected", connector: c });
      continue;
    }
    for (const t of after.grants.connectors[c]!.grant) {
      const tool = own(connector.tools, t);
      if (tool === undefined) missing.push({ kind: "tool_not_found", connector: c, tool: t });
      else if (tool.classification === "unclassified") missing.push({ kind: "tool_unclassified", connector: c, tool: t });
    }
  }

  const estimated = after.jobs.reduce((sum, j) => sum + runsPerDay(j), 0);
  const runsWarning = estimated > ab.max_runs_per_day ? { estimatedRunsPerDay: estimated, maxRunsPerDay: ab.max_runs_per_day } : null;

  const classification = items.reduce<ChangeClass>(
    (acc, i) => (CHANGE_ORDER[i.class] > CHANGE_ORDER[acc] ? i.class : acc),
    items.length === 0 ? "neutral" : "narrow",
  );
  return {
    classification,
    items,
    widenItems: items.filter((i) => i.class === "widen"),
    hasNarrow: items.some((i) => i.class === "narrow"),
    missing,
    runsWarning,
    violations: A.violations,
  };
}
