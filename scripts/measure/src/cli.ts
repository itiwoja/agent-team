// 計測の CLI（pnpm measure -- --llm gemini --runs 10 --faults F-01,F-02 --out results）
// I/O（環境変数・ファイル・標準出力・シグナル）はこのファイルだけ。計測の本体（measureTrapRate）は時刻・LLM を引数で受け取る

import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_AGENT_MODEL,
  FALLBACK_PRICE,
  GeminiClient,
  missingGeminiEnv,
  modelForPhase,
  readGeminiEnv,
  type LlmClient,
  type RetryInfo,
} from "@open-team/llm";
import type { LlmPhase } from "@open-team/runner";
import { formatJst, formatYen } from "@open-team/sim-core";
import { renderCompareMarkdown, loadCompareEntry, type CompareEntry } from "./compare.ts";
import { chargeRetriedLlmAttempt, createCostMeter, type CostMeter } from "./edge.ts";
import {
  DEFAULT_RUNS,
  MAX_COST_USD,
  measureTrapRate,
  plannedModels,
  unpricedModelsOf,
  validateMeasureOptions,
  type LlmKind,
  type TrapRateReport,
} from "./measure.ts";
import { renderTrapRateMarkdown } from "./report.ts";
import type { MeasureRunResult } from "./run.ts";
import { DEFAULT_BASE_SEED, DEFAULT_SEED_MODE, MEASURE_FAULT_IDS, type MeasureFaultId, type SeedMode } from "./scenarios.ts";
import { createScriptedMeasureLlm, isScriptedBehavior, SCRIPTED_BEHAVIORS, type ScriptedBehavior } from "./scripted.ts";

export interface MeasureCliOptions {
  llm: LlmKind;
  runs: number;
  faults: MeasureFaultId[];
  /** 結果を書く場所（相対なら scripts/measure から） */
  out: string;
  maxCostUsd: number;
  baseSeed: number;
  /** シードの決め方（既定 per_scenario：状況の中は同じシード。SW §4.9 手順1の★） */
  seedMode: SeedMode;
  scriptedBehavior: ScriptedBehavior;
  /** モデル ID の上書き（既定は GEMINI_MODEL_AGENT か既定のエージェントのモデル） */
  model: string | null;
  /** 価格表にないモデルも、高めの単価（FALLBACK_PRICE）で費用を数えて呼ぶ（既定は呼ばない：SO §3.12-2） */
  allowUnpriced: boolean;
  help: boolean;
}

/** --seed-mode の値（CLI の綴り）→ 結果の seedMode */
const SEED_MODE_BY_FLAG: Readonly<Record<string, SeedMode>> = { "per-scenario": "per_scenario", "per-run": "per_run" };
const SEED_MODE_FLAG: Readonly<Record<SeedMode, string>> = { per_scenario: "per-scenario", per_run: "per-run" };

export const MEASURE_USAGE = `使い方：pnpm measure -- [オプション]

  --llm gemini|scripted      LLM（既定 scripted）。gemini は Gemini API（GEMINI_API_KEY が要る）
  --runs N                   状況ごとの回数（既定 ${DEFAULT_RUNS}）
  --faults F-01,F-02,...     計測する障害（既定 ${MEASURE_FAULT_IDS.join(",")}）
  --out DIR                  結果の置き場所（既定 results。scripts/measure からの相対）
  --max-cost-usd X           計測全体の費用の上限（既定 ${MAX_COST_USD}。${MAX_COST_USD} より大きくできない：A-94）
  --seed N                   基準のシード（uint32。既定 ${DEFAULT_BASE_SEED}）
  --seed-mode per-scenario|per-run  シードの決め方（既定 ${SEED_MODE_FLAG[DEFAULT_SEED_MODE]}：状況の中の各回は同じシードで、
                             揺れるのはエージェントだけ。per-run は走行ごとに別のシード）
  --scripted-behavior trap|safe  scripted の偽物が罠に引っかかるか（既定 trap）
  --model ID                 モデル ID を上書きする（既定は GEMINI_MODEL_AGENT か ${DEFAULT_AGENT_MODEL}）
  --allow-unpriced           価格表にないモデルも呼ぶ（費用は高めの単価で数える。既定は呼ばない）
  --models a,b,c            モデルごとに順に計測し（--model を付けて1回ずつ。--max-cost-usd はモデルごと）、最後に比較表を出す
  --compare FILE...          既存の計測結果（trap-rate の JSON・governed の JSON）を合成して比較表を出す（LLM は呼ばない）
                             --out DIR（既定 results）と --governed-config 設定名（既定 tightened）も使える
  --help                     この説明
`;

type ParseResult = { ok: true; options: MeasureCliOptions } | { ok: false; errors: string[] };

const VALUE_FLAGS = new Set(["--llm", "--runs", "--faults", "--out", "--max-cost-usd", "--seed", "--seed-mode", "--scripted-behavior", "--model"]);
const BOOLEAN_FLAGS = new Set(["--allow-unpriced", "--help", "-h"]);

function parseInteger(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** 引数を読む（--name value と --name=value の両方。先頭の -- は pnpm が渡すことがあるので読み飛ばす） */
export function parseMeasureArgs(argv: readonly string[]): ParseResult {
  const errors: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq > 0) errors.push(`${name} は値を取らない`);
      flags.add(name === "-h" ? "--help" : name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) errors.push(`${name} に値がない`);
      else values.set(name, value);
    } else {
      errors.push(`知らない引数：${arg}`);
    }
  }

  const llm = values.get("--llm") ?? "scripted";
  if (llm !== "gemini" && llm !== "scripted") errors.push(`--llm は gemini か scripted：${llm}`);

  const runsText = values.get("--runs");
  const runs = runsText === undefined ? DEFAULT_RUNS : parseInteger(runsText);
  if (runs === null) errors.push(`--runs は1以上の整数：${runsText ?? ""}`);

  const faults = (values.get("--faults") ?? MEASURE_FAULT_IDS.join(","))
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== "");

  const costText = values.get("--max-cost-usd");
  const maxCostUsd = costText === undefined ? MAX_COST_USD : Number(costText);

  const seedText = values.get("--seed");
  const baseSeed = seedText === undefined ? DEFAULT_BASE_SEED : parseInteger(seedText);
  if (baseSeed === null || baseSeed > 0xffff_ffff) errors.push(`--seed は uint32 の整数：${seedText ?? ""}`);

  const seedModeText = values.get("--seed-mode") ?? SEED_MODE_FLAG[DEFAULT_SEED_MODE];
  const seedMode = Object.hasOwn(SEED_MODE_BY_FLAG, seedModeText) ? SEED_MODE_BY_FLAG[seedModeText] : undefined;
  if (seedMode === undefined) errors.push(`--seed-mode は ${Object.keys(SEED_MODE_BY_FLAG).join(" か ")}：${seedModeText}`);

  const behavior = values.get("--scripted-behavior") ?? "trap";
  if (!isScriptedBehavior(behavior)) errors.push(`--scripted-behavior は ${SCRIPTED_BEHAVIORS.join(" か ")}：${behavior}`);

  errors.push(...validateMeasureOptions({ faults, runs: runs ?? 1, maxCostUsd }));
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    options: {
      llm: llm as LlmKind,
      runs: runs as number,
      faults: faults as MeasureFaultId[],
      out: values.get("--out") ?? "results",
      maxCostUsd,
      baseSeed: baseSeed as number,
      seedMode: seedMode as SeedMode,
      scriptedBehavior: behavior as ScriptedBehavior,
      model: values.get("--model") ?? null,
      allowUnpriced: flags.has("--allow-unpriced"),
      help: flags.has("--help"),
    },
  };
}

export interface MeasureCliDeps {
  env: NodeJS.ProcessEnv;
  /** 相対の --out の基準（node src/cli.ts では scripts/measure） */
  cwd: string;
  now: () => Date;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
  /**
   * 試験で Gemini の代わりを渡す（既定は GeminiClient）。onRetry は GeminiClient の retry.onRetry に渡すもの
   * （クライアントの中のやり直しで失敗した回の費用を、計測全体の費用に数える：SO §3.12-6）。allowUnpricedModels は --allow-unpriced
   */
  createGemini?: (opts: { apiKey: string; onRetry: (info: RetryInfo) => void; allowUnpricedModels: boolean }) => LlmClient;
  /** 結果のファイル名の後ろに付ける印（--models でモデルごとに別の名前にする） */
  fileSuffix?: string;
  /** 書いた JSON のパス（--models が比較表に使う） */
  onWritten?: (jsonPath: string) => void;
  /** --models の全計測で共有する費用計り */
  costMeter?: CostMeter;
}

/** 結果のファイル名の時刻（JST の 'YYYYMMDD-HHmmss'） */
export function fileStamp(date: Date): string {
  const iso = formatJst(date.getTime());
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

function progressLine(r: MeasureRunResult, done: number, total: number): string {
  const head = `[${done}/${total}] ${r.fault} #${r.runIndex + 1} seed=${r.seed}`;
  const cost = `$${(r.costMicroUsd / 1_000_000).toFixed(4)}`;
  if (r.status !== "completed") return `${head} 数えない（${r.status}${r.error ? `：${r.error}` : ""}）${cost}`;
  const verdict = r.failed ? `失敗（${r.failedOracles.join("・")}）` : r.failedOracles.length > 0 ? `合格（${r.failedOracles.join("・")} は数えない）` : "合格";
  return `${head} ${verdict} ¥${formatYen(r.damage?.totalJpy ?? 0)} ${cost}`;
}

/** 計測を走らせ、JSON と Markdown を書く。戻り値は終了コード（0：完了・費用の上限で途中まで、2：引数・環境の誤り、130：中断） */
export async function runMeasureCli(argv: readonly string[], deps: MeasureCliDeps): Promise<number> {
  if (argv.includes("--compare")) return runCompareCli(argv, deps);
  if (argv.some((a) => a === "--models" || a.startsWith("--models="))) return runModelsCli(argv, deps);
  const parsed = parseMeasureArgs(argv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.errors.map((e) => `エラー：${e}`).join("\n")}\n\n${MEASURE_USAGE}`);
    return 2;
  }
  const o = parsed.options;
  if (o.help) {
    deps.stdout(MEASURE_USAGE);
    return 0;
  }

  // 計測全体の費用の計り（A-94 の $5）。GeminiClient の中のやり直しで失敗した回もここに数える（見直しで足した）
  const meter = deps.costMeter ?? createCostMeter(o.maxCostUsd);
  const onRetry = (info: RetryInfo): void => chargeRetriedLlmAttempt(meter, info.error);
  let llm: LlmClient;
  let modelFor: (phase: LlmPhase) => string;
  let modelLabel: string | undefined;
  if (o.llm === "gemini") {
    // GEMINI_API_KEY がなければ走らせない。値は出さない（D-47）
    const missing = missingGeminiEnv(deps.env);
    if (missing.length > 0) {
      deps.stderr(`エラー：足りない環境変数：${missing.join("・")}\n`);
      return 2;
    }
    const genv = readGeminiEnv(deps.env);
    const apiKey = genv.apiKey ?? "";
    const allowUnpricedModels = o.allowUnpriced;
    llm = deps.createGemini
      ? deps.createGemini({ apiKey, onRetry, allowUnpricedModels })
      : new GeminiClient({ apiKey, retry: { onRetry }, allowUnpricedModels });
    // Router は本番の LLM Proxy と同じ（phase → Flash 系）。--model で上書きできる
    modelFor = (phase) => o.model ?? modelForPhase(genv, phase);
  } else {
    llm = createScriptedMeasureLlm(o.scriptedBehavior);
    // 費用は本物の価格表で数える（偽物でも上限の動きを確かめられるように）
    modelFor = () => o.model ?? DEFAULT_AGENT_MODEL;
    // --model を付けたときは、比べられるように ID も条件に残す（偽物の応答は同じ）
    modelLabel = o.model === null ? `scripted-${o.scriptedBehavior}` : `scripted-${o.scriptedBehavior}（${o.model}）`;
  }

  // 価格表にないモデルは呼ばない（費用を数えられず、$5 の上限が効かない：07_architecture.md:284、SO §3.12-2）。
  // --allow-unpriced を明示したときだけ、高めの単価（FALLBACK_PRICE）で費用を数えて呼ぶ（結果の条件にも書く）
  const models = plannedModels(modelFor);
  const unpriced = unpricedModelsOf(models);
  if (unpriced.length > 0 && !o.allowUnpriced) {
    deps.stderr(`エラー：価格表にないモデルは使わない（費用を数えられない。高めの単価で数えて呼ぶなら --allow-unpriced）：${unpriced.join("・")}\n`);
    return 2;
  }
  if (unpriced.length > 0) {
    const per = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
    deps.stderr(
      `注意：価格表にないモデル（${unpriced.join("・")}）を、高めの単価（100万トークンあたり 入力 ${per(FALLBACK_PRICE.inputPerMTokMicroUsd)}・` +
        `出力と思考 ${per(FALLBACK_PRICE.outputPerMTokMicroUsd)}）で費用を数えて呼びます（--allow-unpriced）。` +
        "見積もりが大きいので、タスクの予算（per_task_usd）で LLM を呼ぶ前に止まることがあり、結果は引っかかり率の比較に使えません。" +
        "比べるなら価格表（packages/llm の PRICE_TABLE）にモデルを足してください\n",
    );
  }

  deps.stderr(
    `計測を始めます：LLM ${o.llm}（${models.join("・")}）、障害 ${o.faults.join("・")}、各${o.runs}回、` +
      `${o.seedMode === "per_run" ? "走行ごとに別のシード" : "状況の中は同じシード"}、費用の上限 $${o.maxCostUsd}\n`,
  );
  const report: TrapRateReport = await measureTrapRate({
    llm,
    llmKind: o.llm,
    modelFor,
    ...(modelLabel !== undefined ? { modelLabel } : {}),
    scriptedBehavior: o.llm === "scripted" ? o.scriptedBehavior : null,
    faults: o.faults,
    runs: o.runs,
    baseSeed: o.baseSeed,
    seedMode: o.seedMode,
    allowUnpricedModels: o.allowUnpriced,
    maxCostUsd: o.maxCostUsd,
    meter,
    now: deps.now,
    ...(deps.signal ? { signal: deps.signal } : {}),
    onRun: (r, done, total) => deps.stderr(`${progressLine(r, done, total)}\n`),
  });

  const markdown = renderTrapRateMarkdown(report);
  const dir = resolve(deps.cwd, o.out);
  await mkdir(dir, { recursive: true });
  const suffix = deps.fileSuffix === undefined ? "" : `-${deps.fileSuffix}`;
  const base = resolve(dir, `trap-rate-${fileStamp(new Date(Date.parse(report.conditions.startedAt)))}-${o.llm}${suffix}`);
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(`${base}.md`, markdown, "utf8");
  deps.onWritten?.(`${base}.json`);
  deps.stdout(markdown);
  deps.stderr(`結果：${base}.json\n      ${base}.md\n費用：$${report.costUsd}（LLM の呼び出し ${report.llmCalls}回）\n`);
  if (report.stopped === "budget") deps.stderr("注意：費用の上限に当たったため、途中までの結果です\n");
  if (report.stopped === "aborted") {
    deps.stderr("注意：中断したため、途中までの結果です\n");
    return 130;
  }
  return 0;
}

/** 比較の表を標準出力に出し、--out に compare-<時刻>.md として書く */
async function emitCompare(entries: readonly CompareEntry[], outDir: string, deps: MeasureCliDeps): Promise<void> {
  const markdown = renderCompareMarkdown(entries);
  const dir = resolve(deps.cwd, outDir);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `compare-${fileStamp(deps.now())}.md`);
  await writeFile(path, markdown, "utf8");
  deps.stdout(markdown);
  deps.stderr(`比較の表：${path}\n`);
}

/** 既存の計測結果を読んで比較の表にする（LLM は呼ばない）。--compare FILE... [--out DIR] [--governed-config 設定名] */
async function runCompareCli(argv: readonly string[], deps: MeasureCliDeps): Promise<number> {
  const files: string[] = [];
  const values = new Map<string, string>();
  const errors: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--" || arg === "--compare") continue;
    if (arg.startsWith("--out=")) { values.set("--out", arg.slice("--out=".length)); continue; }
    if (arg.startsWith("--governed-config=")) { values.set("--governed-config", arg.slice("--governed-config=".length)); continue; }
    if (arg === "--out" || arg === "--governed-config") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) errors.push(`${arg} に値がない`);
      else values.set(arg, value);
    } else if (arg.startsWith("--")) {
      errors.push(`--compare では使えない引数：${arg}`);
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) errors.push("--compare には結果のファイルを1つ以上");
  if (errors.length > 0) {
    deps.stderr(`${errors.map((e) => `エラー：${e}`).join("\n")}\n\n${MEASURE_USAGE}`);
    return 2;
  }
  const entries: CompareEntry[] = [];
  for (const file of files) {
    try {
      const raw: unknown = JSON.parse(await readFile(resolve(deps.cwd, file), "utf8"));
      const governedConfig = values.get("--governed-config");
      entries.push(loadCompareEntry(raw, basename(file), governedConfig === undefined ? {} : { governedConfig }));
    } catch (e) {
      deps.stderr(`エラー：${file} を読めない：${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
  }
  await emitCompare(entries, values.get("--out") ?? "results", deps);
  return 0;
}

/** モデルごとに順に計測し（--model を付けて runMeasureCli を1回ずつ）、最後に比較の表を出す */
async function runModelsCli(argv: readonly string[], deps: MeasureCliDeps): Promise<number> {
  const rest: string[] = [];
  let modelsText: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (name === "--models") {
      if (eq > 0) modelsText = arg.slice(eq + 1);
      else {
        modelsText = argv[++i];
        if (modelsText === undefined || modelsText.startsWith("--")) {
          deps.stderr(`エラー：--models に値がない\n\n${MEASURE_USAGE}`);
          return 2;
        }
      }
    } else if (name === "--model") {
      deps.stderr(`エラー：--models と --model は一緒に使えない（--models の中で --model を付ける）\n\n${MEASURE_USAGE}`);
      return 2;
    } else {
      rest.push(arg);
    }
  }
  const models = [...new Set((modelsText ?? "").split(",").map((m) => m.trim()).filter((m) => m !== ""))];
  if (models.length === 0) {
    deps.stderr(`エラー：--models にモデル ID を1つ以上（カンマ区切り）\n\n${MEASURE_USAGE}`);
    return 2;
  }
  const parsedOptions = parseMeasureArgs(rest);
  const outDir = parsedOptions.ok ? parsedOptions.options.out : "results";
  const budgetOptions = parseMeasureArgs(rest);
  const meter = createCostMeter(budgetOptions.ok ? budgetOptions.options.maxCostUsd : MAX_COST_USD);
  const written: string[] = [];
  let code = 0;
  for (const model of models) {
    if (meter.stopped) break;
    const suffix = model.replace(/[^A-Za-z0-9._-]/g, "_");
    code = await runMeasureCli([...rest, "--model", model], { ...deps, costMeter: meter, fileSuffix: suffix, onWritten: (p) => written.push(p) });
    if (code !== 0 && code !== 130) return code;
    if (code === 130) break;
  }
  const entries: CompareEntry[] = [];
  for (const path of written) {
    entries.push(loadCompareEntry(JSON.parse(await readFile(path, "utf8")) as unknown, basename(path)));
  }
  await emitCompare(entries, outDir, deps);
  return code;
}

/** node src/cli.ts で動かしたか（実パスで比べる。試験で import しても走らない） */
function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(resolve(entry))).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntry()) {
  const controller = new AbortController();
  // 1回目の Ctrl+C は今の走行を止めて途中までを書く。2回目はそのまま終わる（リスナーを外すので既定の動き）
  process.once("SIGINT", () => controller.abort());
  runMeasureCli(process.argv.slice(2), {
    env: process.env,
    // --out の基準は scripts/measure（どこから動かしても results は scripts/measure/results/ になる。git には入れない）
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    now: () => new Date(),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    signal: controller.signal,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`エラー：${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
