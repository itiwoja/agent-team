// 送る前の確認のリスク評価（intents.md:109-117。M-24：kernel に1つ）と、BR-70 の出し方（D-59）
// 「開いて出す」きっかけは4つだけ：guard_exceeded・unknown_outcome_pending・widen の設定変更・初めての宛先（BR-70）。
// 汚染だけなら閉じたまま宛先の下に1行（taintReasonLine）。理由の文は reasonCode から決まった文で作り、LLM に書かせない（ask-and-check.md:135）
// 文の作り方は UI §4.6.3（buildConfirmPresentation）、reasonLines の形は UI の ReasonLine（M-23）、汚染の文は MT §3.15（M-06）

import { argPathsByRole, extractArg, valuesEqualForMatch } from "./args.ts";
import { canonicalJson } from "./canonical.ts";
import { guardFailureFor } from "./guards.ts";
import type { GuardFailure } from "./guards.ts";
import { ruleValidity } from "./rules.ts";
import { isTainted, taintReasonLine } from "./taint.ts";
import type {
  ArgPath,
  DecisionDetail,
  EffectiveRule,
  Json,
  JsonObject,
  ReasonCode,
  TaintState,
  ToolInfo,
} from "./types.ts";

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
/** 加点の理由のコード（intents.md:111-117 の表の行。名前は IA §3.7-3 の提案） */
export const RISK_REASON_CODES = [
  "tainted",
  "destination_not_in_rules",
  "profile_value_in_content",
  "agent_direct_call",
  "scope_self",
] as const;
export type RiskReasonCode = (typeof RISK_REASON_CODES)[number];
/** approvals.risk_reasons の1件（09_api/approvals.md:85-88 の形） */
export interface RiskReason {
  code: RiskReasonCode;
  points: number;
  detail: string | null;
}
export interface McpRisk {
  score: number;
  level: RiskLevel;
  reasons: RiskReason[];
}

export interface McpRiskInput {
  /** タスクが tainted（Intent を作った時点の汚染） */
  tainted: boolean;
  /** 宛先がどれかの有効なルールに一致する（destinationMatchesAnyRule） */
  matchesAnyRule: boolean;
  /** 中身にプロフィールの値を含む（0-H はプロフィールがないので常に false） */
  containsProfileValue: boolean;
  origin: "agent" | "deliver";
  /** ツールが scope: self */
  scopeSelf: boolean;
}

/** 合計 1以下 low（負も low）、2〜3 medium、4以上 high（intents.md:109） */
export function riskLevelOf(score: number): RiskLevel {
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/**
 * MCP の書き込みのリスク（intents.md:109-117、MT §3.15 mcpRiskScore）。ルールベースで LLM を使わない。
 * tainted +2、宛先がどのルールにも一致しない +2、中身にプロフィールの値 +2、origin = agent +1、scope: self −1。
 * 判定（decide）には使わない。承認カードの「ルールによる判定」として表示し、approvals.risk_* に保存する
 */
export function mcpRiskScore(i: McpRiskInput): McpRisk {
  const reasons: RiskReason[] = [];
  const add = (code: RiskReasonCode, points: number) => reasons.push({ code, points, detail: null });
  if (i.tainted === true) add("tainted", 2);
  if (i.matchesAnyRule !== true) add("destination_not_in_rules", 2);
  if (i.containsProfileValue === true) add("profile_value_in_content", 2);
  if (i.origin !== "deliver") add("agent_direct_call", 1); // 分からない origin はエージェントの直接の呼び出しとして数える
  if (i.scopeSelf === true) add("scope_self", -1);
  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  return { score, level: riskLevelOf(score), reasons };
}

/**
 * 宛先がどれかのルールに一致するか（リスクの「宛先がどのルールにも一致しない」の判定）。
 * 同じ action の有効なルール（ruleValidity：rules.enabled・write・tool_hash・網羅など）のうち、
 * すべての destination の値が正規化して一致するものがあるか。option・content は見ない（宛先だけの比較）
 */
export function destinationMatchesAnyRule(
  rules: readonly EffectiveRule[],
  action: string,
  args: JsonObject,
  tool: ToolInfo,
  rulesEnabled: boolean,
): boolean {
  const dests = argPathsByRole(tool.argRoles, "destination");
  return rules.some((rule) => {
    const v = ruleValidity(rule, { action, tool, rulesEnabled });
    if (v === "not_applicable" || !v.valid) return false;
    return dests.every((d) => valuesEqualForMatch(rule.match[d], extractArg(args, d)));
  });
}

// ここから BR-70 の出し方

/** 理由の1行（UI §3.5 の ReasonLine。M-23）。bold は太字にする部分（超えた値・宛先）、link は前の書き込みの行 */
export interface ReasonLine {
  text: string;
  bold: string[];
  link?: { label: string; itemKey: string };
}
export type GuardDecisionDetail = Extract<DecisionDetail, { kind: "guard" }>;

/** 3桁区切り（「2,400」）。指数表記になる大きさ・有限でない値はそのまま */
function formatNumber(n: number): string {
  const s = String(n);
  if (!Number.isFinite(n) || /e/i.test(s)) return s;
  const neg = s.startsWith("-");
  const [intPart = "", frac] = (neg ? s.slice(1) : s).split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac === undefined ? "" : `.${frac}`}`;
}

/** 表示の値。数は3桁区切りに単位を付ける。文字はそのまま（空は「（空）」）、null は「（なし）」、ほかは正規形 JSON */
function displayValue(v: Json | null, unit: string): string {
  if (typeof v === "number") return `${formatNumber(v)}${unit}`;
  if (typeof v === "string") return v === "" ? "（空）" : v;
  if (v === null) return "（なし）";
  return canonicalJson(v);
}

/**
 * decide() の detail（kind: 'guard'）から、どの条件で外れたかを決め直す。evaluateGuard と同じ関数（guardFailureFor）で決めるので順も同じ：
 * 空・壊れたガード → 見つからない → 型・下限・上限・桁数・候補（KC §3.6）。範囲の中の値（壊れた入力）は empty として出す
 */
export function guardFailureOf(d: GuardDecisionDetail): GuardFailure {
  return guardFailureFor(d.guard, d.found === true, d.value) ?? "empty";
}

/**
 * guard_exceeded の理由の1行（UI §4.6.3-3、ask-and-check.md:128 の例「いつもの上限（20個）を超えています：200個」）。
 * 単位は manifest の units（G-13。'items[].quantity' →「個」）から呼び出し側が渡す。分からなければ null（単位なし）
 */
export function guardReasonLine(d: GuardDecisionDetail, unit: string | null): ReasonLine {
  const u = unit ?? "";
  const g = d.guard;
  const value = displayValue(d.value, u);
  switch (guardFailureOf(d)) {
    case "above_max":
      return { text: `いつもの上限（${formatNumber(g.max ?? 0)}${u}）を超えています：${value}`, bold: [value] };
    case "below_min":
      return { text: `いつもの下限（${formatNumber(g.min ?? 0)}${u}）を下回っています：${value}`, bold: [value] };
    case "too_many_digits":
      return { text: `いつもの桁数（${g.max_digits ?? 0}桁）を超えています：${value}`, bold: [value] };
    case "not_in":
      return { text: `いつもの候補にない値です：${value}`, bold: [value] };
    case "not_found":
      return { text: `確かめる値（${g.arg}）が見つかりません`, bold: [] };
    default:
      return { text: `いつもの範囲に入らない値です：${value}`, bold: [value] };
  }
}

export interface ConfirmPresentationInput {
  /** intent は Intent の送る前の確認（API-019）、config_change は widen の設定変更（API-063） */
  confirmType: "intent" | "config_change";
  /** decide() の reasonCode（Intent のとき） */
  reasonCode: ReasonCode | null;
  /** decide() の detail（guard_exceeded のとき） */
  guard: GuardDecisionDetail | null;
  /** 前の書き込み（届いたか分からないもの）の行のキー（unknown_outcome_pending のとき） */
  unknownItemKey: string | null;
  /** その仕事で人が承認したことのない destinationKey（BR-70。approvals.first_destination） */
  firstDestination: boolean;
  /** 2行目の宛先（「山田珈琲（supplier-01）」） */
  destinationText: string | null;
  /** widen で増えること（config_change のとき） */
  gains: readonly string[];
  /** 操作の名前（「発注」。manifest の actionNoun：G-13）。なければ「送信」 */
  actionNoun: string | null;
  /** Intent を作った時点の汚染（action_intents.taint_snapshot：MT D-28） */
  taint: TaintState | null;
  /** 引数のパス → 単位（manifest の units：G-13） */
  units?: Readonly<Record<ArgPath, string>>;
}
export interface ConfirmPresentation {
  /** BR-70 の4つのきっかけのどれかに当たる（＝ reasonLines が1行以上） */
  open: boolean;
  /** 1行目の上の理由。ガード → 結果の分からない書き込み → widen → 初めての宛先 の順 */
  reasonLines: ReasonLine[];
  /** 2行目（widen の「できることが増えます：〇〇」） */
  secondLines: string[];
  /** 汚染の1行（宛先の下）。開いた行でも出す */
  taintLine: string | null;
}

/** 開いた行を先に寄せるのは、送る前の確認の開いた行がこの数以上のときだけ（ask-and-check.md:136） */
export const OPEN_ROWS_FIRST_THRESHOLD = 3;

const CHECK_KIND_ORDER = { confirm: 0, question: 1, report: 2 } as const;

/**
 * SCR-019「見てほしいもの」の並び順（IA §3.11-5、UI §4.6.2、ask-and-check.md:96-97・136、A-92）。
 * 種類の順は 送る前の確認 → 質問 → 報告、同じ種類の中は新しい順（at の降順。同じ時刻は key の昇順、読めない時刻は後ろ）。
 * 送る前の確認で open の行が3つ以上のときだけ、それらを確認の中で先に置く（2つ以下なら新しい順のまま）
 */
export function sortCheckItems<T extends { kind: "confirm" | "question" | "report"; at: string; key: string; open?: boolean }>(
  items: readonly T[],
): T[] {
  const openConfirms = items.filter((x) => x.kind === "confirm" && x.open === true).length;
  const openFirst = openConfirms >= OPEN_ROWS_FIRST_THRESHOLD;
  const time = (x: T) => {
    const ms = Date.parse(x.at);
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  return [...items].sort((a, b) => {
    const kind = CHECK_KIND_ORDER[a.kind] - CHECK_KIND_ORDER[b.kind];
    if (kind !== 0) return kind;
    if (openFirst && a.kind === "confirm") {
      const open = Number(b.open === true) - Number(a.open === true);
      if (open !== 0) return open;
    }
    const ta = time(a);
    const tb = time(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * 送る前の確認の出し方（BR-70・D-59、UI §4.6.3、IA §3.11）。操作（○ と5秒の取り消し）は変えず、押す前に目に入るものだけ変える。
 * 複数のきっかけに当たれば全部をこの順で出す：ガード → 結果の分からない書き込み → widen → 初めての宛先
 */
export function buildConfirmPresentation(i: ConfirmPresentationInput): ConfirmPresentation {
  const reasonLines: ReasonLine[] = [];
  const secondLines: string[] = [];
  if (i.reasonCode === "guard_exceeded") {
    if (i.guard !== null) {
      const units = i.units;
      const unit = units !== undefined && Object.hasOwn(units, i.guard.guard.arg) ? (units[i.guard.guard.arg] ?? null) : null;
      reasonLines.push(guardReasonLine(i.guard, unit));
    } else {
      reasonLines.push({ text: "いつもの範囲に入らない値です", bold: [] }); // detail がなくても開いて出す
    }
  }
  if (i.reasonCode === "unknown_outcome_pending") {
    const noun = i.actionNoun !== null && i.actionNoun !== "" ? i.actionNoun : "送信";
    const line: ReasonLine = { text: `前の${noun}が届いたか分かっていません`, bold: [] };
    if (i.unknownItemKey !== null) line.link = { label: `前の${noun}を見る`, itemKey: i.unknownItemKey };
    reasonLines.push(line);
  }
  if (i.confirmType === "config_change") {
    reasonLines.push({ text: "このエージェントができることが増えます", bold: [] });
    for (const gain of i.gains) secondLines.push(`できることが増えます：${gain}`);
  }
  if (i.firstDestination === true) {
    reasonLines.push({ text: "初めての送り先です", bold: i.destinationText === null ? [] : [i.destinationText] });
  }
  return {
    open: reasonLines.length > 0,
    reasonLines,
    secondLines,
    taintLine: i.taint !== null && isTainted(i.taint) ? taintReasonLine(i.taint) : null,
  };
}
