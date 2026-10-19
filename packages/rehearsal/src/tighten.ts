// 締める提案（FR-045・D-82）：すり抜けた失敗から、ガードの追加・範囲を狭める・option を固定に戻す・承認への引き戻しを作り、
// kernel の checkTighteningProposal（スキーマ → compose の違反 → ルールの追加でない → classify が narrow → すり抜けを塞ぐ）に通らない案は捨てる。
// 案は仕事の定義の差分（JSON Patch）で持ち、当てた定義は同じ差分から作る。純粋関数（I/O・時刻・乱数なし）

import { canonicalJson, checkTighteningProposal, hashCanonical, readArgPath } from "@open-team/kernel";
import type {
  AgentDefinitionInput,
  ArgPath,
  CandidateRule,
  ClassifyContext,
  Guard,
  Hex64,
  Json,
  JsonObject,
  SlippedWrite,
  Subject,
  TighteningRejectReason,
} from "@open-team/kernel";
import type { TighteningProposal } from "@open-team/sim-core";

export type TightenKind = TighteningProposal["kind"];

// ---- JSON Patch（add・replace・remove だけ。締める提案が使う範囲） ----

export type PatchOp =
  | { op: "add"; path: string; value: Json }
  | { op: "replace"; path: string; value: Json }
  | { op: "remove"; path: string };

/** JSON Pointer の1要素（~ と / をエスケープ） */
export function pointerEscape(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
const pointerUnescape = (s: string): string => s.replace(/~1/g, "/").replace(/~0/g, "~");

/** 差分を当てた写しを返す（入力は変えない）。存在しない場所への replace・remove・範囲外の添字は例外 */
export function applyJsonPatch<T>(doc: T, ops: readonly PatchOp[]): T {
  let root: unknown = structuredClone(doc);
  for (const op of ops) {
    const segs = op.path.split("/").slice(1).map(pointerUnescape);
    if (segs.length === 0) throw new RangeError("applyJsonPatch: ルート全体は置き換えられない");
    let parent: unknown = root;
    for (const s of segs.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") throw new RangeError(`applyJsonPatch: ${op.path} の途中が見つからない`);
      parent = (parent as Record<string, unknown>)[s];
    }
    if (parent === null || typeof parent !== "object") throw new RangeError(`applyJsonPatch: ${op.path} の親が見つからない`);
    const last = segs[segs.length - 1]!;
    if (Array.isArray(parent)) {
      const idx = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new RangeError(`applyJsonPatch: 添字が範囲外 ${op.path}`);
      if (op.op === "add") parent.splice(idx, 0, structuredClone(op.value));
      else if (idx >= parent.length) throw new RangeError(`applyJsonPatch: ${op.path} がない`);
      else if (op.op === "replace") parent[idx] = structuredClone(op.value);
      else parent.splice(idx, 1);
    } else {
      const obj = parent as Record<string, unknown>;
      if (op.op !== "add" && !Object.hasOwn(obj, last)) throw new RangeError(`applyJsonPatch: ${op.path} がない`);
      if (op.op === "remove") delete obj[last];
      else obj[last] = structuredClone(op.value);
    }
  }
  return root as T;
}

// ---- 入力・出力 ----

/** すり抜けた書き込み（本番の経路で allow になったもの）。rehearsal_scenarios の行と Intent から作る */
export interface SlippedCase {
  /** rehearsal_scenarios.id（TighteningProposal.fixes に入る） */
  id: string;
  jobId: string;
  /** kind: 'tool_call'・actionType: 'mcp_call'・tool つき（M-14）。action は 'mcp.<connector>.<tool>' */
  subject: Subject;
  unknownOutcomeKeys?: readonly Hex64[];
  /** 通ったルールの id。候補のルールは 'cand-N'（withCandidateRules）。ルールなしで通ったら null */
  ruleId: string | null;
}

/** 案の数値・値の材料。世界・仕事ごとの固定の値（O-05 の「通常の3倍」など）を呼び出し側が渡す。ないものは案を作らない（値を作り出さない） */
export interface TightenHints {
  /** 引数のパス → 許す範囲。これを外れてすり抜けたものがガードの対象 */
  bounds?: Readonly<Record<ArgPath, { min?: number; max?: number }>>;
  /** ルール id → 引数のパス → 承認された（固定に戻す）値。match の形で渡す（'items[].x' は配列、スカラーは値） */
  approvedValues?: Readonly<Record<string, Readonly<Record<ArgPath, Json>>>>;
  /**
   * ルール id → 画面に出すルールの中身（「山田珈琲への発注は以後も許可」）。案の文に内部の ID（r-0001）を出さないため。
   * なければ「以後も許可にしたルール（N番目）」と出す
   */
  ruleLabels?: Readonly<Record<string, string>>;
}

export interface TightenInput {
  /** いまの定義 */
  before: AgentDefinitionInput;
  ctx: ClassifyContext;
  slipped: readonly SlippedCase[];
  /** リハーサルで試した候補のルール（G-03）。判定し直しに足す */
  candidateRules?: readonly CandidateRule[];
  hints?: TightenHints;
}

export interface DiscardedProposal {
  kind: TightenKind;
  reason: TighteningRejectReason | "not_applicable";
  fixes: string[];
}

export interface TightenResult {
  /** narrow で、すり抜けを塞ぐ案だけ（種類・差分の順に並べる） */
  proposals: TighteningProposal[];
  discarded: DiscardedProposal[];
}

// ---- 分割行（D-82） ----

export interface SplitLineFinding {
  sku: string;
  /** その sku の行の数と合計 */
  rows: number;
  total: number;
  cap: number;
}

/**
 * 発注を小分けにした行（D-82）：同じ sku の行が2つ以上あり、どの行も上限（cap）以内なのに、合計は上限を超える。
 * ガードは行ごとに評価されるので、行ごとの上限ではこの形を塞げない（kernel は凍結済みで、定義にも行数の上限の項目がない）。
 * O-05 が (注文, sku) 単位で合算して失敗にする。ここでは見つけるだけ
 */
export function findSplitLines(
  args: JsonObject,
  paths: { sku: ArgPath; quantity: ArgPath },
  capBySku: Readonly<Record<string, number>>,
): SplitLineFinding[] {
  const skus = readArgPath(args, paths.sku);
  const qtys = readArgPath(args, paths.quantity);
  if (skus.shape !== "each" || qtys.shape !== "each") return [];
  const by = new Map<string, { rows: number; total: number; max: number }>();
  skus.elements.forEach((s, i) => {
    const q = qtys.elements[i]?.value;
    if (typeof s.value !== "string" || typeof q !== "number" || !Number.isFinite(q)) return;
    const cur = by.get(s.value) ?? { rows: 0, total: 0, max: 0 };
    by.set(s.value, { rows: cur.rows + 1, total: cur.total + q, max: Math.max(cur.max, q) });
  });
  const out: SplitLineFinding[] = [];
  for (const [sku, v] of by) {
    const cap = capBySku[sku];
    if (cap !== undefined && v.rows >= 2 && v.max <= cap && v.total > cap) out.push({ sku, rows: v.rows, total: v.total, cap });
  }
  return out.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

// ---- 案の生成 ----

interface Candidate {
  kind: TightenKind;
  ops: PatchOp[];
  text: string;
}

/**
 * 案の文に出す引数の名前（画面の文言だけ。差分・ガードの arg は道筋のまま）。unit は範囲の数に付ける単位。
 * 数量の単位は商品ごとに違う（kg・袋など）ので付けない。知らない引数は道筋のまま出す（中身を隠さない）
 */
const ARG_LABELS: Readonly<Record<string, { label: string; unit?: string }>> = {
  "items[].quantity": { label: "1回の発注の数量" },
  "items[].unit_price": { label: "単価", unit: "円" },
  "items[].sku": { label: "発注する品目" },
  "items[].name": { label: "品目の名前" },
  items: { label: "発注の中身" },
  supplier_id: { label: "仕入れ先" },
  note: { label: "発注のメモ" },
  to: { label: "メールの宛先" },
  subject: { label: "メールの件名" },
  body: { label: "メールの本文" },
  account: { label: "振込先の口座" },
};

/** 引数の道筋（'items[].quantity'・'items[1].quantity'）の表示名 */
export function argLabel(arg: string): string {
  return ARG_LABELS[arg.replace(/\[\d+\]/g, "[]")]?.label ?? arg;
}

const rangeText = (g: { min?: number; max?: number }, arg: string): string => {
  const unit = ARG_LABELS[arg.replace(/\[\d+\]/g, "[]")]?.unit ?? "";
  return [g.min !== undefined ? `${g.min}${unit} 以上` : null, g.max !== undefined ? `${g.max}${unit} 以下` : null].filter((x) => x !== null).join("・");
};

function guardCandidates(before: AgentDefinitionInput, jobIdx: number, action: string, s: SlippedCase, hints: TightenHints): Candidate[] {
  const out: Candidate[] = [];
  const job = before.jobs?.[jobIdx];
  if (job === undefined) return out;
  for (const [arg, bound] of Object.entries(hints.bounds ?? {})) {
    const read = readArgPath(s.subject.args, arg);
    const values: Json[] = read.shape === "scalar" ? (read.found ? [read.value ?? null] : []) : read.elements.flatMap((e) => (e.found ? [e.value ?? null] : []));
    const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const needMax = bound.max !== undefined && nums.some((v) => v > bound.max!);
    const needMin = bound.min !== undefined && nums.some((v) => v < bound.min!);
    if (!needMax && !needMin) continue;
    const guards = job.guards ?? [];
    const gi = guards.findIndex((g) => g.action === action && g.arg === arg);
    const base = `/jobs/${jobIdx}/guards`;
    if (gi < 0) {
      const g: Guard = { action, arg, ...(needMin ? { min: bound.min! } : {}), ...(needMax ? { max: bound.max! } : {}) };
      const value = g as unknown as Json;
      out.push({
        kind: "add_guard",
        ops: job.guards === undefined ? [{ op: "add", path: base, value: [value] }] : [{ op: "add", path: `${base}/-`, value }],
        text: `「${argLabel(arg)}」に ${rangeText(g, arg)} のガードを付け、外れたら確認に回します`,
      });
      continue;
    }
    const g = guards[gi]!;
    if (g.in !== undefined) continue; // 候補のガードに数値を足すと「数値と候補の両方」になり定義の検証に通らない
    const ops: PatchOp[] = [];
    const next: { min?: number; max?: number } = {};
    if (needMax && (g.max === undefined || bound.max! < g.max)) {
      ops.push({ op: g.max === undefined ? "add" : "replace", path: `${base}/${gi}/max`, value: bound.max! });
      next.max = bound.max!;
    }
    if (needMin && (g.min === undefined || bound.min! > g.min)) {
      ops.push({ op: g.min === undefined ? "add" : "replace", path: `${base}/${gi}/min`, value: bound.min! });
      next.min = bound.min!;
    }
    if (ops.length > 0) out.push({ kind: "narrow_guard", ops, text: `「${argLabel(arg)}」のガードを ${rangeText(next, arg)} に狭めます` });
  }
  return out;
}

/**
 * 案の文に出すルールの呼び方。中身（ruleLabels）が分かれば「「山田珈琲への発注は以後も許可」のルール」、
 * 分からなければ「以後も許可にしたルール（1番目）」（定義の rules の並び。内部の ID は出さない）
 */
export function ruleNameText(ruleId: string, index: number, hints: TightenHints): string {
  const label = hints.ruleLabels?.[ruleId]?.trim();
  return label !== undefined && label !== "" ? `「${label}」のルール` : `以後も許可にしたルール（${index + 1}番目）`;
}

function ruleCandidates(before: AgentDefinitionInput, s: SlippedCase, hints: TightenHints): Candidate[] {
  if (s.ruleId === null) return [];
  const ri = (before.rules ?? []).findIndex((r) => r.id === s.ruleId);
  if (ri < 0) return []; // 候補のルール（定義にない）は取り消せない。塞げるのはガードだけ（BR-57）
  const rule = before.rules![ri]!;
  const name = ruleNameText(rule.id, ri, hints);
  const out: Candidate[] = [];
  for (const arg of rule.free ?? []) {
    const value = hints.approvedValues?.[rule.id]?.[arg];
    if (value === undefined) continue;
    out.push({
      kind: "option_to_fixed",
      ops: [
        { op: "replace", path: `/rules/${ri}/free`, value: (rule.free ?? []).filter((a) => a !== arg) },
        { op: "add", path: `/rules/${ri}/match/${pointerEscape(arg)}`, value },
      ],
      text: `${name}の「${argLabel(arg)}」を、毎回変わってよいから承認した値に固定し直します`,
    });
  }
  out.push({ kind: "remove_rule", ops: [{ op: "remove", path: `/rules/${ri}` }], text: `${name}を取り消し、同じ書き込みを確認に回します` });
  return out;
}

/**
 * 承認への引き戻し（自律度）。書き込み（mcp_write）の自律度は上限表で auto にできない（ルール経由だけ。KC §7 C-16）ので、
 * 書き込みの自律度を approve にしても何も変わらず（neutral）、塞ぐ案にならない。書き込みの引き戻しは「ルールの取り消し」が担う。
 * ここで作るのは、読み取り（mcp_read）が auto で通ったものを approve に戻す案だけ
 */
function autonomyCandidates(before: AgentDefinitionInput, s: SlippedCase): Candidate[] {
  if (s.subject.tool?.classification !== "read") return [];
  const cur = before.autonomy?.mcp_read;
  if (cur === "approve" || cur === "deny") return [];
  return [
    {
      kind: "autonomy_to_approve",
      ops: before.autonomy === undefined ? [{ op: "add", path: "/autonomy", value: { mcp_read: "approve" } }] : [{ op: "add", path: "/autonomy/mcp_read", value: "approve" }],
      text: "外部サービスの読み取りを、すべて確認に回します",
    },
  ];
}

const KIND_ORDER: Readonly<Record<TightenKind, number>> = { add_guard: 0, narrow_guard: 1, option_to_fixed: 2, remove_rule: 3, autonomy_to_approve: 4 };

/**
 * 締める提案を作る。すり抜けた書き込みごとに候補を作り、checkTighteningProposal（classify が narrow、かつその書き込みを塞ぐ）に通ったものだけ残す。
 * 同じ差分の案はまとめて fixes に足す。並びは種類（狭い変更から）→ 差分。
 * 分割行（D-82）：行ごとのガードでは塞げないので、そのとき残るのは「ルールの取り消し」「承認への引き戻し」だけ（checkTighteningProposal が塞がらない案を捨てる）
 */
export function proposeTightening(input: TightenInput): TightenResult {
  const hints = input.hints ?? {};
  const kept = new Map<string, TighteningProposal>();
  const discarded: DiscardedProposal[] = [];
  for (const s of input.slipped) {
    const jobIdx = (input.before.jobs ?? []).findIndex((j) => j.id === s.jobId);
    const action = s.subject.action;
    if (jobIdx < 0 || action === undefined) continue;
    const candidates = [
      ...guardCandidates(input.before, jobIdx, action, s, hints),
      ...ruleCandidates(input.before, s, hints),
      ...autonomyCandidates(input.before, s),
    ];
    for (const c of candidates) {
      let after: AgentDefinitionInput;
      try {
        after = applyJsonPatch(input.before, c.ops);
      } catch {
        discarded.push({ kind: c.kind, reason: "not_applicable", fixes: [s.id] });
        continue;
      }
      const slippedWrite: SlippedWrite = { jobId: s.jobId, subject: s.subject, ...(s.unknownOutcomeKeys ? { unknownOutcomeKeys: s.unknownOutcomeKeys } : {}) };
      const check = checkTighteningProposal({
        before: input.before,
        after,
        ctx: input.ctx,
        slipped: [slippedWrite],
        ...(input.candidateRules ? { candidateRules: input.candidateRules } : {}),
      });
      if (!check.ok) {
        discarded.push({ kind: c.kind, reason: check.reason, fixes: [s.id] });
        continue;
      }
      const key = canonicalJson({ kind: c.kind, patch: c.ops });
      const found = kept.get(key);
      if (found) {
        if (!found.fixes.includes(s.id)) found.fixes.push(s.id);
      } else {
        kept.set(key, {
          id: `tp-${hashCanonical({ kind: c.kind, patch: c.ops }).slice(0, 12)}`,
          kind: c.kind,
          patch: c.ops,
          classification: "narrow",
          fixes: [s.id],
          text: c.text,
        });
      }
    }
  }
  const proposals = [...kept.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { proposals, discarded };
}
