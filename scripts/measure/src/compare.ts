// モデル比較（FR-068）：既存の計測結果（trap-rate の JSON と、統制ありの計測 governed の JSON）を読み、モデルごとに1行の比較表にする
// 純粋関数だけ（I/O は cli.ts）。文はすべて決まった文、数字は読んだ JSON の値だけを使う（LLM に書かせない）

import { formatYen } from "@open-team/sim-core";

/** 状況ごとの数（統制なし＝影の走行の失敗の回数） */
export interface ComparePerFault {
  fault: string;
  /** 数えた走行 */
  runs: number;
  /** 統制なしで失敗した走行 */
  failedRuns: number;
}

/** 統制ありの走行の結果（governed の JSON だけ） */
export interface CompareGoverned {
  /** 設定の名前（candidate_rule・tightened など） */
  config: string;
  runs: number;
  /** 統制が止めた走行（outcome が stopped） */
  stopped: number;
  /** 統制ありで出た損害（円） */
  damageJpy: number;
  failed: number;
}

export interface CompareEntry {
  /** 元のファイルの名前（表の出典に出す） */
  source: string;
  kind: "trap-rate" | "governed";
  /** 条件のモデル（scripted のときは偽物の名前と、--model で指定した ID） */
  model: string;
  date: string;
  llm: string;
  /** 偽物のエージェントの結果か（比較に使わない印を出す） */
  scripted: boolean;
  /** 価格表にないモデルを高めの単価で数えた結果か */
  unpriced: boolean;
  /** 途中までの結果か（費用の上限・中断） */
  complete: boolean;
  perFault: ComparePerFault[];
  /** 統制なしの損害の合計（円）。影の走行の記録がない結果は null */
  ungovernedDamageJpy: number | null;
  /** 費用（USD） */
  costUsd: number;
  /** 統制ありの結果（統制ありの計測がない結果は null） */
  governed: CompareGoverned | null;
}

export interface LoadCompareOptions {
  /** governed の JSON で使う設定（既定は tightened。なければ最初の設定） */
  governedConfig?: string;
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} がオブジェクトではない`);
  return v as Record<string, unknown>;
}

function asNumber(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${what} が数ではない`);
  return v;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} が文字列ではない`);
  return v;
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} が配列ではない`);
  return v;
}

/** 計測結果の JSON（trap-rate か governed）を読み、比較の1行にする。形が違えば例外（何が違うかを言う） */
export function loadCompareEntry(raw: unknown, source: string, opts: LoadCompareOptions = {}): CompareEntry {
  const top = asRecord(raw, source);
  if ("rows" in top) return fromTrapRate(top, source);
  if ("records" in top) return fromGoverned(top, source, opts);
  throw new Error(`${source}：計測結果の形ではない（rows も records もない）`);
}

function fromTrapRate(top: Record<string, unknown>, source: string): CompareEntry {
  const c = asRecord(top.conditions, `${source} の conditions`);
  const rows = asArray(top.rows, `${source} の rows`).map((r) => asRecord(r, `${source} の row`));
  const perFault = rows.map((row) => ({
    fault: asString(row.fault, `${source} の fault`),
    runs: asNumber(row.runs, `${source} の runs`),
    failedRuns: asNumber(row.failedRuns, `${source} の failedRuns`),
  }));
  const ungovernedDamageJpy: number | null = rows.reduce((sum, row) => sum + asNumber(row.totalDamageJpy, `${source} の totalDamageJpy`), 0);
  const llm = asString(c.llm, `${source} の llm`);
  return {
    source,
    kind: "trap-rate",
    model: asString(c.model, `${source} の model`),
    date: asString(c.date, `${source} の date`),
    llm,
    scripted: llm === "scripted",
    unpriced: Array.isArray(c.unpricedModels) && c.unpricedModels.length > 0,
    complete: top.complete !== false,
    perFault,
    ungovernedDamageJpy,
    costUsd: Number(asString(top.costUsd, `${source} の costUsd`)),
    governed: null,
  };
}

function fromGoverned(top: Record<string, unknown>, source: string, opts: LoadCompareOptions): CompareEntry {
  const c = asRecord(top.conditions, `${source} の conditions`);
  const records = asArray(top.records, `${source} の records`).map((r) => asRecord(r, `${source} の record`));
  const configs = [...new Set(records.map((r) => asString(r.config, `${source} の config`)))];
  const config = opts.governedConfig ?? (configs.includes("tightened") ? "tightened" : configs[0]);
  if (config === undefined || !configs.includes(config)) {
    throw new Error(`${source}：設定 ${config ?? "（なし）"} がない（ある設定：${configs.join("・") || "なし"}）`);
  }
  const picked = records.filter((r) => r.config === config);

  // 統制なし（影）の走行は shadow を持つ記録（計測では影を別の設定の走行と一緒に数えるため、設定を問わず集める）
  const shadowed = records.filter((r) => r.shadow !== null && r.shadow !== undefined);
  const byFault = new Map<string, ComparePerFault>();
  for (const r of shadowed) {
    const fault = asString(r.fault, `${source} の fault`);
    const shadow = asRecord(r.shadow, `${source} の shadow`);
    const cur = byFault.get(fault) ?? { fault, runs: 0, failedRuns: 0 };
    cur.runs += 1;
    if (shadow.failed === true) cur.failedRuns += 1;
    byFault.set(fault, cur);
  }
  const ungovernedDamageJpy =
    shadowed.length === 0
      ? null
      : shadowed.reduce((sum, r) => sum + asNumber(asRecord(r.shadow, `${source} の shadow`).damageJpy, `${source} の damageJpy`), 0);
  const completed = picked.filter((r) => r.status === undefined || r.status === "completed");
  const governed: CompareGoverned = {
    config,
    runs: completed.length,
    failed: picked.length - completed.length,
    stopped: completed.filter((r) => r.outcome === "stopped").length,
    damageJpy: completed.reduce((sum, r) => {
      if (r.governed == null) return sum;
      return sum + asNumber(asRecord(r.governed, `${source} の governed`).damageJpy, `${source} の damageJpy`);
    }, 0),
  };
  const llm = asString(c.llm, `${source} の llm`);
  return {
    source,
    kind: "governed",
    model: asString(c.model, `${source} の model`),
    date: asString(c.date, `${source} の date`),
    llm,
    scripted: llm === "scripted",
    unpriced: false,
    complete: c.stopped == null && (c.runsPerScenario === undefined || records.length >= Object.keys(c.faultParams && typeof c.faultParams === "object" ? c.faultParams : Object.fromEntries(records.map((r) => [String(r.fault), true]))).length * asNumber(c.runsPerScenario, `${source} の runsPerScenario`)) && picked.every((r) => r.status === undefined || r.status === "completed"),
    perFault: [...byFault.values()],
    ungovernedDamageJpy,
    // 費用は設定をまたいだ全体（conditions の costMicroUsd）
    costUsd: asNumber(c.costMicroUsd, `${source} の costMicroUsd`) / 1_000_000,
    governed,
  };
}

function yen(n: number): string {
  return `¥${formatYen(Math.round(n))}`;
}

function usd(n: number): string {
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : "—";
}

/** 表のセルに入れる文（| と改行を崩さない） */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** 状況の列（ファイルをまたいで全部の状況の ID を並べる） */
export function faultColumns(entries: readonly CompareEntry[]): string[] {
  return [...new Set(entries.flatMap((e) => e.perFault.map((f) => f.fault)))].sort();
}

/** 比較表の Markdown（1モデル1行。状況は失敗した回／走らせた回） */
export function renderCompareMarkdown(entries: readonly CompareEntry[]): string {
  entries = mergeCompareEntries(entries);
  const lines: string[] = ["## モデル比較（FR-068）", ""];
  if (entries.length === 0) return `${lines.concat("比べる結果がない。").join("\n")}\n`;

  if (entries.some((e) => e.scripted)) {
    lines.push("> **偽物のエージェント（scripted）の結果を含む**。配管の確認用で、モデルの比較ではない。", "");
  }
  if (entries.some((e) => e.unpriced)) {
    lines.push("> **価格表にないモデルを高めの単価で数えた結果を含む**。費用と引っかかり率の比較には使わない。", "");
  }
  if (entries.some((e) => !e.complete)) {
    lines.push("> **途中までの結果を含む**（費用の上限・中断）。", "");
  }

  const faults = faultColumns(entries);
  const header = ["モデル", "出典", "日付", ...faults.map((f) => `${f} 失敗`), "統制なしの損害", "統制ありで止めた件数", "統制ありの損害", "費用"];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map((_, i) => (i < 3 ? "---" : "---:")).join("|")}|`);
  for (const e of entries) {
    const byFault = new Map(e.perFault.map((f) => [f.fault, f]));
    const faultCells = faults.map((f) => {
      const row = byFault.get(f);
      return row === undefined || row.runs === 0 ? "—" : `${row.failedRuns}/${row.runs}`;
    });
    const g = e.governed;
    const stoppedCell = g === null ? "—" : `${g.stopped}/${g.runs}（${g.config}${g.failed ? `・失敗${g.failed}件` : ""}）`;
    const govDamageCell = g === null ? "—" : yen(g.damageJpy);
    const cells = [
      cell(e.model),
      cell(e.source),
      e.date,
      ...faultCells,
      e.ungovernedDamageJpy === null ? "—" : yen(e.ungovernedDamageJpy),
      stoppedCell,
      govDamageCell,
      usd(e.costUsd),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    "- 統制なし：失敗は統制なし（影）の走行の数、損害は統制なしの損害の合計。",
    "- 統制あり：統制ありの計測（governed）の結果がある行だけ。止めた件数は統制が止めた走行の数（走らせた数に対して）。統制ありの計測がない行は「—」。",
    "- 費用：その結果の LLM の費用の合計（--models では計測全体で上限を共有）。",
  );
  return `${lines.join("\n")}\n`;
}

/** 同じ計測条件のファイルをモデルごとに1行へ統合。shadow は複数ファイルで重複計上しない。 */
function mergeCompareEntries(entries: readonly CompareEntry[]): CompareEntry[] {
  const grouped = new Map<string, CompareEntry>();
  for (const entry of entries) {
    const key = `${entry.model}\0${entry.date}\0${entry.llm}`;
    const current = grouped.get(key);
    if (!current) { grouped.set(key, { ...entry }); continue; }
    const uniqueSource = new Set([...current.source.split("・"), entry.source]);
    const preferred = current.kind === "governed" ? current : entry.kind === "governed" ? entry : current;
    const trap = current.kind === "trap-rate" ? current : entry.kind === "trap-rate" ? entry : null;
    grouped.set(key, { ...preferred, source: [...uniqueSource].join("・"), complete: current.complete && entry.complete,
      scripted: current.scripted || entry.scripted, unpriced: current.unpriced || entry.unpriced,
      perFault: trap?.perFault ?? current.perFault, ungovernedDamageJpy: trap?.ungovernedDamageJpy ?? current.ungovernedDamageJpy,
      costUsd: Math.max(current.costUsd, entry.costUsd), governed: current.governed ?? entry.governed });
  }
  return [...grouped.values()];
}
