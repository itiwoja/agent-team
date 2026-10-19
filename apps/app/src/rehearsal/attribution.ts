// ガードの貢献度（どの規則が何円防いだか）。リハーサルの状況の行から集計する純粋関数（I/O・時刻なし）。審査で「可観測性」を示すために出す
// 止めた行の数え方は damage.ts（packages/rehearsal）と同じ：verdict が pass で、stopped_by が kernel の行。防いだ額は行の prevented_damage_jpy（足りなければ 0）
// 表示の名前は内部の ID（guards[0] などの matchedRule）を出さず、理由の平易な名前（incidentReasonLabel）か、ガードの中身（上限の文）にする

import { incidentReasonLabel } from "./incident-title.ts";

/** 集計に使う状況の行の項目（rehearsal_scenarios の行の部分） */
export interface AttributionRow {
  verdict: "pass" | "fail" | null;
  stopped_by: string | null;
  stopped_by_reason_code: string | null;
  stopped_by_rule: string | null;
  prevented_damage_jpy: number | null;
}

/** 実効ポリシーのガード（照合用。順番は policy.guards の並び＝ matchedRule の guards[i] の i） */
export interface PolicyGuard {
  arg: string;
  min?: number;
  max?: number;
}

export interface RuleContribution {
  /** 画面に出す名前（例「単価の上限 1,170円」「値の上限を超えた」） */
  ruleLabel: string;
  reasonCode: string;
  stoppedCount: number;
  preventedDamageJpy: number;
}

export interface RuleAttribution {
  /** 防いだ額の降順（同額は止めた件数の多い順、そのあとは名前の順） */
  contributions: RuleContribution[];
  /** 一度も発動しなかったガードの名前（実効ポリシーと照合できたときだけ。できなければ null） */
  unfiredGuards: string[] | null;
}

/** 依頼画面と貢献集計で共有する走行選択。 */
export function selectAttributionRuns<T extends { id: string; ask_id: string | null; job_id: string | null; trigger: string; status: string; created_at: Date | string }>(runs: readonly T[], askId: string) {
  const time = (r: T): number => new Date(r.created_at).getTime();
  const primary = runs.find((r) => r.ask_id === askId && r.trigger !== "user_case") ?? null;
  if (primary === null) return { primary, previous: null, recertify: [] as T[], userCases: [] as T[] };
  const previousCandidates = runs.filter((r) => r.ask_id === askId && r.trigger !== "user_case" && r.id !== primary.id && time(r) < time(primary));
  const previous = primary.trigger === "retest" && ["queued", "generating", "running"].includes(primary.status)
    ? previousCandidates.sort((a, b) => time(b) - time(a))[0] ?? null : null;
  const latest = new Map<string, T>();
  for (const r of runs) {
    if (r.trigger !== "recertify" || r.ask_id !== null || r.job_id === null || time(r) < time(primary)) continue;
    const cur = latest.get(r.job_id);
    if (cur === undefined || time(r) > time(cur)) latest.set(r.job_id, r);
  }
  return { primary, previous, recertify: [...latest.values()].sort((a, b) => time(a) - time(b)), userCases: runs.filter((r) => r.ask_id === askId && r.trigger === "user_case") };
}

/** ガードの引数の平易な名前と単位（分からない引数は null：理由の名前に任せる） */
const GUARD_ARG: Readonly<Record<string, { label: string; unit: string }>> = {
  "items[].unit_price": { label: "単価", unit: "円" },
  "items[].quantity": { label: "数量", unit: "個" },
};

/** ガードの中身の名前（「単価の上限 1,170円」）。上限・下限のどちらもない・引数が分からないときは null */
export function guardLabelOf(g: PolicyGuard): string | null {
  const arg = GUARD_ARG[g.arg];
  if (arg === undefined) return null;
  const num = (n: number) => n.toLocaleString("ja-JP");
  if (g.min !== undefined && g.max !== undefined) return `${arg.label}の範囲 ${num(g.min)}〜${num(g.max)}${arg.unit}`;
  if (g.max !== undefined) return `${arg.label}の上限 ${num(g.max)}${arg.unit}`;
  if (g.min !== undefined) return `${arg.label}の下限 ${num(g.min)}${arg.unit}`;
  return null;
}

/** matchedRule が guards[i] のときの i（それ以外は null） */
function guardIndexOf(matchedRule: string | null): number | null {
  const m = matchedRule === null ? null : /^guards\[(\d+)\]$/.exec(matchedRule);
  return m ? Number(m[1]) : null;
}

/** Kernel が止めた行（pass・kernel）か。damage.ts の outcome が stopped の数え方と同じ */
function isKernelStop(r: AttributionRow): boolean {
  return r.verdict === "pass" && r.stopped_by === "kernel" && r.stopped_by_reason_code !== null;
}

/**
 * 状況の行から規則ごとの貢献を出す。保存された停止結果だけでは fail 行での発動を確実に判定できないため未発動一覧は出さない。
 */
export function attributionOf(rows: readonly AttributionRow[], guards?: readonly PolicyGuard[]): RuleAttribution {
  const groups = new Map<string, { label: string; reasonCode: string; stoppedCount: number; preventedDamageJpy: number }>();
  for (const r of rows) {
    if (r.stopped_by !== "kernel" || r.stopped_by_reason_code === null) continue;
    const idx = guardIndexOf(r.stopped_by_rule);
    if (!isKernelStop(r)) continue;
    const key = `${r.stopped_by_reason_code}:${r.stopped_by_rule ?? "-"}`;
    const guard = idx !== null && guards !== undefined ? guards[idx] : undefined;
    const label = (guard !== undefined ? guardLabelOf(guard) : null) ?? incidentReasonLabel(r.stopped_by_reason_code);
    const g = groups.get(key) ?? { label, reasonCode: r.stopped_by_reason_code, stoppedCount: 0, preventedDamageJpy: 0 };
    g.stoppedCount += 1;
    g.preventedDamageJpy += r.prevented_damage_jpy ?? 0;
    groups.set(key, g);
  }
  const contributions = [...groups.values()]
    .map((g) => ({ ruleLabel: g.label, reasonCode: g.reasonCode, stoppedCount: g.stoppedCount, preventedDamageJpy: g.preventedDamageJpy }))
    .sort((a, b) => b.preventedDamageJpy - a.preventedDamageJpy || b.stoppedCount - a.stoppedCount || a.ruleLabel.localeCompare(b.ruleLabel, "ja"));
  // 名前が分からないガードは番号で呼ぶ（tighten と同じ「N番目」。内部の ID は出さない）
  const unfiredGuards = null;
  return { contributions, unfiredGuards };
}
