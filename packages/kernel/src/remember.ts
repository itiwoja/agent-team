// 承認カードの [以後も許可]：出す条件（MT §3.7）とルールの作り方（MT §3.8）。形は MT に合わせた（M-24）
// 条件は 09_api/approvals.md:125-132 の番号のまま返し、API-019 の 422 RULE_NOT_ALLOWED の details.failedConditions に入れる
// ルール：destination すべて＋free でない option すべてを正規化して match に固定する（BR-69・D-60）。欠けは null（M-10）、content は入れない

import { argPathsByRole, extractArg, normalizeForMatch } from "./args.ts";
import type { ArgPath, AutonomyLevel, IsoDateTime, Json, JsonObject, Rule, ToolHash, ToolInfo, Uuid } from "./types.ts";

/** 1エージェントのルールの上限（rules.max_per_agent の既定。mcp-and-web.md:125） */
export const RULES_MAX_PER_AGENT = 20;
/** 「上限を付ける」の既定＝承認した値の何倍か（mcp-and-web.md:130、IA §2.1） */
export const GUARD_SUGGEST_MULTIPLIER = 2;

/** 外れた条件。1〜5 は 09_api/approvals.md:128-132 の番号、'limit' はルールの上限（MT §3.7-6） */
export type RememberCondition = 1 | 2 | 3 | 4 | 5 | "limit";
export type RememberOffer = { ok: true } | { ok: false; failed: RememberCondition[] };

export interface CanOfferRememberInput {
  /** 判定の時点のツール（argRoles は effectiveArgRoles の結果：M-02） */
  tool: ToolInfo;
  /** 実効ポリシーの autonomy.mcp_write */
  effectiveMcpWrite: AutonomyLevel;
  /** ワークスペースのポリシーの rules.enabled */
  rulesEnabled: boolean;
  /** Hard Ceiling で handoff だけを許す操作か（BR-36） */
  isHandoffOnly: boolean;
  /** tasks.is_dry_run（試し実行は true） */
  isDryRun: boolean;
  /** そのエージェントの今のルールの数 */
  currentRuleCount: number;
  /** 既定 RULES_MAX_PER_AGENT */
  maxPerAgent?: number;
}

/**
 * [以後も許可] を出すか（MT §3.7、mcp-and-web.md:134-148）。外れた条件をすべて番号順に返す。
 * 1 分類が write（unclassified には出さない）／2 destination が1つ以上か scope: self／3 自律レベルが approve かつ rules.enabled／
 * 4 handoff だけの操作でない／5 試し実行でない／limit 今のルール数 + 1 が上限以下（21個目は出さない）
 */
export function canOfferRemember(i: CanOfferRememberInput): RememberOffer {
  const failed: RememberCondition[] = [];
  if (i.tool.classification !== "write") failed.push(1);
  if (argPathsByRole(i.tool.argRoles, "destination").length === 0 && i.tool.scope !== "self") failed.push(2);
  // auto は mcp_write に設定できない（Hard Ceiling）。来ても出さない側に倒す
  if (i.effectiveMcpWrite !== "approve" || i.rulesEnabled !== true) failed.push(3);
  if (i.isHandoffOnly !== false) failed.push(4);
  if (i.isDryRun !== false) failed.push(5);
  const max = i.maxPerAgent ?? RULES_MAX_PER_AGENT;
  // 数えられない値は上限に当たったものとして扱う（厳しい側）
  if (!Number.isFinite(i.currentRuleCount) || !Number.isFinite(max) || i.currentRuleCount + 1 > max) failed.push("limit");
  return failed.length === 0 ? { ok: true } : { ok: false, failed };
}

export type RuleBuildErrorCode = "tool_changed" | "free_not_option";

/** buildRuleFromIntent の失敗。tool_changed → API 409 INTENT_CHANGED、free_not_option → 400 VALIDATION_ERROR（MT §3.8-1・2） */
export class RuleBuildError extends Error {
  readonly code: RuleBuildErrorCode;
  readonly argPath: ArgPath | null;
  constructor(code: RuleBuildErrorCode, argPath: ArgPath | null = null) {
    super(code === "tool_changed" ? "ツールが変わったためルールを作れない" : `毎回変わってよいにできるのは option だけ：${argPath ?? ""}`);
    this.name = "RuleBuildError";
    this.code = code;
    this.argPath = argPath;
  }
}

export interface BuildRuleFromIntentInput {
  intent: { id: Uuid; action: string; args: JsonObject; toolHash: ToolHash };
  /** 今のツール（argRoles は effectiveArgRoles の結果） */
  tool: ToolInfo;
  /** ユーザーが「毎回変わってよい」にした option（D-60） */
  freeOptions: readonly ArgPath[];
  /** 宛先の表示名（D-31：gateway が read ツールで引いた名前かユーザーが付けた名前。LLM の名前は入れない） */
  labels: Readonly<Record<ArgPath, string>>;
  addedBy: string;
  now: IsoDateTime;
  newId: string;
  /**
   * 汚染されたタスク（外部の内容を読んだ後）の Intent か（SG-09）。ルールは作れる（BR-57 は変えない）が、記録に残す。
   * 判定には効かない（実効ポリシーに入らない）
   */
  createdWhileTainted: boolean;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 承認した Intent から「以後も許可」のルールを作る（MT §3.8、mcp-and-web.md:130、BR-69）。
 * match = すべての destination ＋ freeOptions 以外のすべての option の、承認した Intent の実際の値（normalizeForMatch。欠けは null）。
 * free は重複を除いて昇順、空でも [] を持つ（M-03）。labels は空なら持たない。tool_hash は Intent の toolHash。
 * 出どころの記録（SG-09）：id・added_by・added_at・source_intent_id・created_while_tainted（汚染でも作る。記録するだけ）。
 * 呼び出し側は先に canOfferRemember を確かめ、新しいスナップショットに足す（widen だが確認カードは重ねない：BR-47①）
 */
export function buildRuleFromIntent(i: BuildRuleFromIntentInput): Rule {
  if (i.intent.toolHash !== i.tool.toolHash) throw new RuleBuildError("tool_changed");
  const roles = i.tool.argRoles;
  const free = [...new Set(i.freeOptions)].sort(compareText);
  for (const p of free) {
    // destination・content・存在しない引数は切り替えられない（BR-69）
    if (typeof p !== "string" || !Object.hasOwn(roles, p) || roles[p] !== "option") throw new RuleBuildError("free_not_option", String(p));
  }
  const fixed = [
    ...argPathsByRole(roles, "destination"),
    ...argPathsByRole(roles, "option").filter((p) => !free.includes(p)),
  ].sort(compareText);
  // Object.fromEntries で作る（'__proto__' という名前の引数を代入すると prototype の setter に吸われ、宛先がルールから消える）
  const match: Record<ArgPath, Json> = Object.fromEntries(fixed.map((p) => [p, normalizeForMatch(extractArg(i.intent.args, p))]));
  const labels: Record<ArgPath, string> = Object.fromEntries(Object.entries(i.labels).filter((e): e is [string, string] => typeof e[1] === "string"));
  const rule: Rule = {
    id: i.newId,
    action: i.intent.action,
    match,
    free,
    tool_hash: i.intent.toolHash,
    added_by: i.addedBy,
    added_at: i.now,
    source_intent_id: i.intent.id,
    created_while_tainted: i.createdWhileTainted === true,
  };
  return Object.keys(labels).length > 0 ? { ...rule, labels } : rule;
}

/**
 * 「毎回変わってよい」にした数値の option に出す「上限を付ける」の既定値（IA §3.8-5、mcp-and-web.md:130）。
 * 承認した値の2倍。配列の要素（'p[].f'）は要素の最大値の2倍。数でない値・空・欠けがあれば null（出さない）
 */
export function suggestedGuardMax(args: JsonObject, path: ArgPath): number | null {
  const v = extractArg(args, path);
  const values = Array.isArray(v) ? v : [v];
  if (values.length === 0) return null;
  let max = -Infinity;
  for (const x of values) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    if (x > max) max = x;
  }
  return GUARD_SUGGEST_MULTIPLIER * max;
}
