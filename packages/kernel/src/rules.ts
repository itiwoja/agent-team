// 「以後も許可」のルールの有効性と一致（decide() の手順11。MT §3.6、KD §3.3-9、mcp-and-web.md:120-125）
// 一致：destination と固定の option は正規化して完全一致、free の option と content は比べない（D-60）。
// match にも free にもない option は「無いこと（＝null）」を求める（BR-69・M-11）。欠け≡null（M-10）、配列は多重集合（M-09）。
// argRoles にない余計な引数があれば一致しない（M-12）。汚染は見ない（BR-39）

import { argPathsByRole, argRoleAt, extractArg, parseArgPath, valuesEqualForMatch } from "./args.ts";
import type { ArgPath, ArgRoleMap, EffectiveRule, JsonObject, ToolInfo } from "./types.ts";

/** ルールが無効な理由（MT §2.6 の列挙。API の RuleView.invalidReason もこの値：M-60） */
export const RULE_INVALID_REASONS = [
  "rules_disabled", // ワークスペースの rules.enabled = false
  "not_write", // ツールが write でない（unclassified はルールを持てない）
  "tool_changed", // tool_hash が今のツールと違う
  "no_destination", // destination が0で scope != self
  "not_covering", // match にすべての destination がない（網羅の条件）
  "free_not_option", // free に option 以外がある
  "match_bad_key", // match に content・存在しない引数・free と重なるキーがある
] as const;
export type RuleInvalidReason = (typeof RULE_INVALID_REASONS)[number];
export type RuleValidity = { valid: true } | { valid: false; reason: RuleInvalidReason };

export interface RuleMismatch {
  ruleIndex: number;
  argPath: ArgPath;
  role: "destination" | "option" | "unknown";
}
export type RuleSearch = { matched: true; index: number } | { matched: false; firstMismatch: RuleMismatch | null };

const SEGMENT = /^[^.[\]]+$/;

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function freeOf(rule: EffectiveRule): readonly ArgPath[] {
  return Array.isArray(rule.free) ? rule.free : []; // 欠けは []（M-03）
}

/** ルールの有効性（MT §3.6。上から順に最初に当たったもの）。action が違えば 'not_applicable' */
export function ruleValidity(
  rule: EffectiveRule,
  ctx: { action: string; tool: ToolInfo; rulesEnabled: boolean },
): RuleValidity | "not_applicable" {
  if (rule.action !== ctx.action) return "not_applicable";
  const invalid = (reason: RuleInvalidReason): RuleValidity => ({ valid: false, reason });
  const { tool } = ctx;
  if (ctx.rulesEnabled !== true) return invalid("rules_disabled");
  if (tool.classification !== "write") return invalid("not_write");
  // 文字列どうしで比べる（両方が欠けて undefined === undefined で有効にならないように）
  if (typeof tool.toolHash !== "string" || rule.tool_hash !== tool.toolHash) return invalid("tool_changed");
  const dests = argPathsByRole(tool.argRoles, "destination");
  if (dests.length === 0 && tool.scope !== "self") return invalid("no_destination");
  if (!isPlainObject(rule.match)) return invalid("match_bad_key");
  const match = rule.match;
  if (dests.some((d) => !Object.hasOwn(match, d))) return invalid("not_covering");
  const free = freeOf(rule);
  if (free.some((f) => argRoleAt(tool.argRoles, f) !== "option")) return invalid("free_not_option");
  const badKey = Object.keys(match).some((k) => {
    const role = argRoleAt(tool.argRoles, k);
    return role === undefined || role === "content" || free.includes(k);
  });
  if (badKey) return invalid("match_bad_key");
  return { valid: true };
}

/**
 * argRoles にない引数のパス（最初の1つ）。なければ null（KD §3.3-9-4・§8-17、M-12）。
 * 最上位のキーが argRoles にも 'key[].…' にもない、'[]' の容れ物が配列でない・要素がオブジェクトでない、
 * 要素に argRoles にないフィールドがある → 余計な引数。形の外れたキー名（'.'・'[' を含む）も余計な引数として扱う。
 * 値が null の容れ物は欠けと同じ（M-10）
 */
function unknownArgPath(args: JsonObject, roles: ArgRoleMap): string | null {
  // 役割の読み方は argRoleAt と同じ（値が undefined のキーは役割なし＝余計な引数の側。比べない引数を作らない）
  const rolePaths = Object.keys(roles).filter((p) => argRoleAt(roles, p) !== undefined);
  for (const k of Object.keys(args).sort()) {
    const value = args[k];
    if (value === undefined) continue;
    if (!SEGMENT.test(k)) return k;
    if (argRoleAt(roles, k) !== undefined) continue;
    const fields = new Set<string>();
    for (const p of rolePaths) {
      const parsed = parseArgPath(p);
      if (parsed?.kind === "each" && parsed.name === k) fields.add(parsed.field);
    }
    if (fields.size === 0) return k;
    if (value === null) continue;
    if (!Array.isArray(value)) return k;
    for (const e of value) {
      if (!isPlainObject(e)) return k;
      for (const f of Object.keys(e).sort()) {
        if (e[f] !== undefined && !fields.has(f)) return `${k}[].${f}`;
      }
    }
  }
  return null;
}

/** 有効なルールで最初に食い違ったパス。destination → 固定の option → 余計な引数 の順（「宛先の固定で承認へ」の表示に宛先を優先して出す） */
function mismatchOf(rule: EffectiveRule, args: JsonObject, roles: ArgRoleMap): Omit<RuleMismatch, "ruleIndex"> | null {
  const match = rule.match;
  for (const d of argPathsByRole(roles, "destination")) {
    if (!valuesEqualForMatch(match[d], extractArg(args, d))) return { argPath: d, role: "destination" };
  }
  const free = freeOf(rule);
  for (const o of argPathsByRole(roles, "option")) {
    if (free.includes(o)) continue;
    // match に書いていない option は「無いこと」を求める（BR-69）。欠け≡null（M-10）
    const expected = Object.hasOwn(match, o) ? match[o] : null;
    if (!valuesEqualForMatch(expected, extractArg(args, o))) return { argPath: o, role: "option" };
  }
  const extra = unknownArgPath(args, roles);
  return extra === null ? null : { argPath: extra, role: "unknown" };
}

/**
 * 手順11のルールの照合（KD §3.3-9、M-04 の形）。添字の小さい順に見て、有効で一致する最初のルール。
 * 一致しなければ、同じ action の最初の有効なルールで最初に食い違ったパスを firstMismatch に入れる（なければ null）
 */
export function findMatchingRule(
  rules: readonly EffectiveRule[],
  action: string,
  args: JsonObject,
  tool: ToolInfo,
  rulesEnabled: boolean,
): RuleSearch {
  let firstMismatch: RuleMismatch | null = null;
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]!;
    const validity = ruleValidity(rule, { action, tool, rulesEnabled });
    if (validity === "not_applicable" || !validity.valid) continue;
    const m = mismatchOf(rule, args, tool.argRoles);
    if (m === null) return { matched: true, index };
    firstMismatch ??= { ruleIndex: index, ...m };
  }
  return { matched: false, firstMismatch };
}
