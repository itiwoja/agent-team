// ガード（BR-61・D-57）：合成（KC §3.5）・評価（KC §3.6）・decide() の手順10（KD §3.3-8）
// compose() も decide() も同じ実装を使う（M-04・M-13）。迷ったら外れ（＝人の確認）に倒す

import { parseArgPath, readArgPath } from "./args.ts";
import type { ArgPath, Guard, Json, JsonObject, MergedGuard } from "./types.ts";

export type GuardFailure = "empty" | "not_found" | "type" | "below_min" | "above_max" | "too_many_digits" | "not_in";
export type GuardEvaluation =
  | { ok: true }
  /** path は添字つき（'items[1].quantity'）。見つからないときは found: false・value: null */
  | { ok: false; reason: GuardFailure; path: string; value: Json | null; found: boolean };
export interface GuardViolation {
  /** policy.guards の添字（matchedRule 'guards[i]'） */
  index: number;
  argPath: string;
  value: Json | null;
  found: boolean;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasNumeric(g: Guard): boolean {
  return g.min !== undefined || g.max !== undefined || g.max_digits !== undefined;
}

/** 有限でない境界・文字列でない候補・条件が1つもないガードは壊れている（どの値も外れにする。KD §3.3-8-4・§8-20） */
function isBroken(g: Guard): boolean {
  const badNumber = (n: number | undefined) => n !== undefined && (typeof n !== "number" || !Number.isFinite(n));
  if (badNumber(g.min) || badNumber(g.max) || badNumber(g.max_digits)) return true;
  if (g.in !== undefined && (!Array.isArray(g.in) || g.in.some((c) => typeof c !== "string"))) return true;
  return !hasNumeric(g) && g.in === undefined;
}

/**
 * 同じ (action, arg) のガードを積でまとめる（KC §3.5、policy-and-schema.md:297）。
 * min は最大・max は最小・max_digits は最小・in は積集合（trim・昇順・重複なし）。
 * empty：min > max、in が空、数値の条件と in の重なり（どの値も両方は満たせない）、壊れたガード。
 * (action, arg) の昇順で返す（matchedRule 'guards[i]' の i はこの並び）
 */
export function mergeGuards(guards: readonly Guard[]): MergedGuard[] {
  const groups = new Map<string, Guard[]>();
  for (const g of guards) {
    const key = JSON.stringify([g.action, g.arg]);
    const list = groups.get(key);
    if (list) list.push(g);
    else groups.set(key, [g]);
  }
  const out: MergedGuard[] = [];
  for (const list of groups.values()) {
    const first = list[0]!;
    const broken = list.some(isBroken);
    const nums = (pick: (g: Guard) => number | undefined) =>
      list.map(pick).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    const mins = nums((g) => g.min);
    const maxs = nums((g) => g.max);
    const digits = nums((g) => g.max_digits);
    let candidates: string[] | undefined;
    for (const g of list) {
      if (!Array.isArray(g.in)) continue;
      const set = [...new Set(g.in.filter((c): c is string => typeof c === "string").map((c) => c.trim()))];
      candidates = candidates === undefined ? set : candidates.filter((c) => set.includes(c));
    }
    const merged: MergedGuard = { action: first.action, arg: first.arg, empty: false };
    if (mins.length > 0) merged.min = Math.max(...mins);
    if (maxs.length > 0) merged.max = Math.min(...maxs);
    if (digits.length > 0) merged.max_digits = Math.min(...digits);
    if (candidates !== undefined) merged.in = [...candidates].sort(compareText);
    merged.empty =
      broken ||
      (merged.min !== undefined && merged.max !== undefined && merged.min > merged.max) ||
      (merged.in !== undefined && (merged.in.length === 0 || hasNumeric(merged)));
    out.push(merged);
  }
  return out.sort((a, b) => compareText(a.action, b.action) || compareText(a.arg, b.arg));
}

/** 整数部の桁数（絶対値。0 は1桁。999.99 は3桁）。String(1e21) は '1e+21' になるので BigInt で数える（KD §8-19） */
function intDigits(v: number): number {
  return BigInt(Math.trunc(Math.abs(v))).toString().length;
}

function checkValue(g: Guard, v: Json): GuardFailure | null {
  if (hasNumeric(g)) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "type"; // '20' のような数字の文字列も外れ
    if (g.min !== undefined && v < g.min) return "below_min"; // min ちょうどは通る
    if (g.max !== undefined && v > g.max) return "above_max"; // max ちょうどは通る
    if (g.max_digits !== undefined && intDigits(v) > g.max_digits) return "too_many_digits";
  }
  if (g.in !== undefined) {
    if (typeof v !== "string") return "type";
    const s = v.trim(); // 前後の空白を除いて比べる。大文字小文字は区別する（KD §8-16）
    if (!g.in.some((c) => typeof c === "string" && c.trim() === s)) return "not_in";
  }
  return null;
}

/**
 * 1つの値がガードのどの条件で外れるか（KC §3.6 の順：空・壊れたガード → 見つからない → 型・下限・上限・桁数・候補）。通れば null。
 * evaluateGuard と、decide() の detail から理由を決め直す risk.ts の guardFailureOf の両方がこれを使う（同じ規則を2か所に書かない：M-04）
 */
export function guardFailureFor(guard: Guard & { readonly empty?: boolean }, found: boolean, value: Json | null): GuardFailure | null {
  if (guard.empty === true || isBroken(guard)) return "empty";
  if (!found) return "not_found";
  return checkValue(guard, value);
}

type Probe = { path: string; found: boolean; value: Json | null };

/** ガードの対象の値を添字の小さい順に並べる。見つからないものも1件として入る */
function probes(arg: ArgPath, args: JsonObject): Probe[] {
  const p = parseArgPath(arg);
  const r = readArgPath(args, arg);
  if (r.shape === "scalar") return [{ path: arg, found: r.found, value: r.value ?? null }];
  // 容れ物がない・配列でない・空配列は見つからない（KC §8 #9、KD §3.3-8-2）
  if (!r.containerFound || r.elements.length === 0 || p === null || p.kind !== "each") return [{ path: arg, found: false, value: null }];
  return r.elements.map((e) => ({ path: `${p.name}[${e.index}].${p.field}`, found: e.found, value: e.value ?? null }));
}

/**
 * 1つのガードを評価する（KC §3.6）。値が1つでも範囲・候補の外なら外れ。配列は要素ごと（添字の小さい順に最初の外れを返す）。
 * 見つからない（引数がない・配列でない・空配列・要素にフィールドがない）は外れ。null は値ありとして型で外れる。
 * 型は見ない（option 以外に付けたガードを止めるのは保存時の検証。KC §8 #10）
 */
export function evaluateGuard(guard: Guard & { readonly empty?: boolean }, args: JsonObject): GuardEvaluation {
  const list = probes(guard.arg, args);
  if (guard.empty === true || isBroken(guard)) {
    const head = list[0]!;
    return { ok: false, reason: "empty", path: head.path, value: head.value, found: head.found };
  }
  for (const pr of list) {
    const reason = guardFailureFor(guard, pr.found, pr.value);
    if (reason !== null) return { ok: false, reason, path: pr.path, value: pr.found ? pr.value : null, found: pr.found };
  }
  return { ok: true };
}

/** decide() の手順10（KD §3.3-8）：action が同じガードを添字の小さい順に見て、最初の外れ。なければ null */
export function firstGuardViolation(guards: readonly MergedGuard[], action: string, args: JsonObject): GuardViolation | null {
  for (let index = 0; index < guards.length; index++) {
    const g = guards[index]!;
    if (g.action !== action) continue;
    const r = evaluateGuard(g, args);
    if (!r.ok) return { index, argPath: r.path, value: r.value, found: r.found };
  }
  return null;
}
