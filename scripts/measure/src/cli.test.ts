// CLI（pnpm measure -- --llm gemini --runs 10 --faults F-01,F-02 --out results）の試験。ネットワークは使わない
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GeminiClient, type GeminiResponse } from "@open-team/llm";
import { MEASURE_USAGE, fileStamp, parseMeasureArgs, runMeasureCli, type MeasureCliDeps } from "./cli.ts";
import type { TrapRateReport } from "./measure.ts";
import { DEFAULT_BASE_SEED, MEASURE_FAULT_IDS } from "./scenarios.ts";
import { fixedClock, scriptedLlm } from "./test-helpers.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "measure-cli-"));
  dirs.push(d);
  return d;
}

function deps(cwd: string, over: Partial<MeasureCliDeps> = {}): MeasureCliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    env: {},
    cwd,
    now: fixedClock("2026-10-05T10:00:00+09:00"),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    out,
    err,
    ...over,
  };
}

describe("parseMeasureArgs", () => {
  it("既定：scripted・10回・F-01〜F-07・results・$5・基準のシード・状況の中は同じシード（SW §4.9 の★）・trap・価格表にないモデルは呼ばない", () => {
    expect(parseMeasureArgs([])).toEqual({
      ok: true,
      options: {
        llm: "scripted",
        runs: 10,
        faults: [...MEASURE_FAULT_IDS],
        out: "results",
        maxCostUsd: 5,
        baseSeed: DEFAULT_BASE_SEED,
        seedMode: "per_scenario",
        scriptedBehavior: "trap",
        model: null,
        allowUnpriced: false,
        help: false,
      },
    });
  });

  it("仕様の形（pnpm が渡す先頭の -- を読み飛ばす）と --name=value の形", () => {
    const r = parseMeasureArgs([
      "--",
      "--llm",
      "gemini",
      "--runs",
      "10",
      "--faults",
      "F-01,f-02",
      "--out",
      "results",
      "--max-cost-usd=2.5",
      "--seed=7",
      "--seed-mode",
      "per-run",
      "--model",
      "gemini-2.5-flash",
      "--allow-unpriced",
    ]);
    expect(r).toMatchObject({
      ok: true,
      options: { llm: "gemini", runs: 10, faults: ["F-01", "F-02"], out: "results", maxCostUsd: 2.5, baseSeed: 7, seedMode: "per_run", model: "gemini-2.5-flash", allowUnpriced: true },
    });
    expect(parseMeasureArgs(["--seed-mode=per-scenario"])).toMatchObject({ ok: true, options: { seedMode: "per_scenario" } });
  });

  it("誤り：知らない引数・値なし・知らない LLM・回数 0・F-08・$5 超え・負のシード・知らない振る舞い", () => {
    const cases: string[][] = [
      ["--foo"],
      ["--runs"],
      ["--llm", "openai"],
      ["--runs", "0"],
      ["--runs", "1.5"],
      ["--faults", "F-08"],
      ["--max-cost-usd", "6"],
      ["--seed", "-1"],
      ["--seed", "4294967296"],
      ["--scripted-behavior", "evil"],
      ["--seed-mode", "same"],
      ["--seed-mode", "per_run"],
      ["--seed-mode"],
      ["--same-seed"],
      ["--allow-unpriced=1"],
      ["--out", "--runs"],
    ];
    for (const argv of cases) expect(parseMeasureArgs(argv).ok, argv.join(" ")).toBe(false);
  });

  it("結果のファイル名の時刻は JST", () => {
    expect(fileStamp(new Date(Date.parse("2026-10-05T01:02:03Z")))).toBe("20261005-100203");
  });
});

describe("runMeasureCli", () => {
  it("--llm scripted はネットワークなしで最後まで通り、JSON と Markdown を --out に書き、Markdown を標準出力に出す", async () => {
    const cwd = await tempDir();
    const d = deps(cwd);
    const code = await runMeasureCli(["--", "--llm", "scripted", "--runs", "1", "--faults", "F-03", "--out", "results"], d);
    expect(code).toBe(0);
    const files = (await readdir(join(cwd, "results"))).sort();
    expect(files).toEqual(["trap-rate-20261005-100000-scripted.json", "trap-rate-20261005-100000-scripted.md"]);
    const report = JSON.parse(await readFile(join(cwd, "results", files[0]!), "utf8")) as TrapRateReport;
    expect(report.rows[0]).toMatchObject({ fault: "F-03", runs: 1, failedRuns: 1, failedOracles: { "O-02": 1, "O-03": 1 }, totalDamageJpy: 184_000 });
    expect(report.conditions).toMatchObject({ llm: "scripted", model: "scripted-trap", scriptedBehavior: "trap" });
    const md = await readFile(join(cwd, "results", files[1]!), "utf8");
    expect(d.out.join("")).toBe(md);
    expect(d.err.join("")).toContain("[1/1] F-03 #1 seed=");
    expect(d.err.join("")).toContain("失敗（O-02・O-03） ¥184,000");
  });

  it("--help は使い方だけ出す", async () => {
    const d = deps(await tempDir());
    expect(await runMeasureCli(["--help"], d)).toBe(0);
    expect(d.out.join("")).toBe(MEASURE_USAGE);
  });

  it("引数の誤りは終了コード 2 と使い方", async () => {
    const d = deps(await tempDir());
    expect(await runMeasureCli(["--runs", "0"], d)).toBe(2);
    expect(d.err.join("")).toContain("エラー：");
    expect(d.err.join("")).toContain("使い方");
  });

  it("--llm gemini：GEMINI_API_KEY がない → 走らせない（値は出さない：D-47）", async () => {
    const missing = deps(await tempDir(), { env: { GEMINI_API_KEY: "  " } });
    expect(await runMeasureCli(["--llm", "gemini"], missing)).toBe(2);
    expect(missing.err.join("")).toContain("GEMINI_API_KEY");
    const unset = deps(await tempDir());
    expect(await runMeasureCli(["--llm", "gemini"], unset)).toBe(2);
    expect(unset.err.join("")).toContain("GEMINI_API_KEY");
  });

  it("--llm gemini：Router は本番と同じ（GEMINI_MODEL_AGENT）。Gemini の代わりを差し込んで最後まで通る", async () => {
    const cwd = await tempDir();
    let created: { apiKey: string; onRetry: unknown; allowUnpricedModels: boolean } | null = null;
    const llm = scriptedLlm("safe");
    const d = deps(cwd, {
      env: { GEMINI_API_KEY: "my-key", GEMINI_MODEL_AGENT: "gemini-2.5-flash" },
      createGemini: (o) => {
        created = o;
        return llm;
      },
    });
    expect(await runMeasureCli(["--llm", "gemini", "--runs", "1", "--faults", "F-04", "--out", "out"], d)).toBe(0);
    expect(created).toEqual({ apiKey: "my-key", onRetry: expect.any(Function), allowUnpricedModels: false });
    expect(new Set(llm.requests.map((r) => r.model))).toEqual(new Set(["gemini-2.5-flash"]));
    const files = await readdir(join(cwd, "out"));
    expect(files.some((f) => f.endsWith("-gemini.json"))).toBe(true);
  });

  it("--llm gemini：GeminiClient の中のやり直し（status のない失敗）も計測全体の費用に数える（onRetry を費用の計りにつなぐ：SO §3.12-6）", async () => {
    const reply: GeminiResponse = {
      candidates: [
        {
          content: { role: "model", parts: [{ functionCall: { id: "r", name: "submit_report", args: { title: "まとめ", body: "特にありません", sources: [] } } }] },
          finishReason: "STOP" as never,
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
    };
    const costOf = async (failFirst: boolean): Promise<number> => {
      const cwd = await tempDir();
      let n = 0;
      const d = deps(cwd, {
        env: { GEMINI_API_KEY: "p" },
        createGemini: (o) =>
          new GeminiClient({
            generateContent: async () => {
              if (failFirst && n++ === 0) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
              return reply;
            },
            retry: { delaysMs: [0], sleep: async () => {}, onRetry: o.onRetry },
          }),
      });
      expect(await runMeasureCli(["--llm", "gemini", "--runs", "1", "--faults", "F-04", "--out", "o"], d)).toBe(0);
      const file = (await readdir(join(cwd, "o"))).find((f) => f.endsWith(".json"))!;
      return Number((JSON.parse(await readFile(join(cwd, "o", file), "utf8")) as TrapRateReport).costUsd);
    };
    const plain = await costOf(false);
    expect(plain).toBeGreaterThan(0);
    // 1回目の呼び出しの失敗の分（見積もり）だけ多い
    expect(await costOf(true)).toBeGreaterThan(plain);
  });

  it("価格表にないモデルは使わない（費用を数えられず $5 の上限が効かない）→ 終了コード 2。--allow-unpriced で呼べることを案内する", async () => {
    const d = deps(await tempDir(), { env: { GEMINI_API_KEY: "p" }, createGemini: () => scriptedLlm("trap") });
    expect(await runMeasureCli(["--llm", "gemini", "--model", "gemini-9-ultra"], d)).toBe(2);
    expect(d.err.join("")).toContain("価格表にないモデル");
    expect(d.err.join("")).toContain("--allow-unpriced");
    const s = deps(await tempDir());
    expect(await runMeasureCli(["--model", "unknown-model"], s)).toBe(2);
    // GEMINI_MODEL_AGENT（Router）が表にないモデルでも同じ
    const env = deps(await tempDir(), { env: { GEMINI_API_KEY: "p", GEMINI_MODEL_AGENT: "gemini-9-ultra" }, createGemini: () => scriptedLlm("trap") });
    expect(await runMeasureCli(["--llm", "gemini"], env)).toBe(2);
  });

  it("--allow-unpriced：表にないモデルを高めの単価で数えて呼ぶ（GeminiClient にも allowUnpricedModels を渡す）。注意を出し、結果の条件に残す", async () => {
    const reply: GeminiResponse = {
      candidates: [
        {
          content: { role: "model", parts: [{ functionCall: { id: "r", name: "submit_report", args: { title: "まとめ", body: "特にありません", sources: [] } } }] },
          finishReason: "STOP" as never,
        },
      ],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
    };
    const cwd = await tempDir();
    let allowed: boolean | null = null;
    const models: string[] = [];
    const d = deps(cwd, {
      env: { GEMINI_API_KEY: "p" },
      createGemini: (o) => {
        allowed = o.allowUnpricedModels;
        return new GeminiClient({
          generateContent: async (params) => {
            models.push(params.model);
            return reply;
          },
          retry: { delaysMs: [] },
          allowUnpricedModels: o.allowUnpricedModels,
        });
      },
    });
    expect(await runMeasureCli(["--llm", "gemini", "--model", "gemini-9-ultra", "--allow-unpriced", "--runs", "1", "--faults", "F-04", "--out", "o"], d)).toBe(0);
    expect(allowed).toBe(true);
    expect(d.err.join("")).toContain("注意：価格表にないモデル（gemini-9-ultra）を、高めの単価");
    expect(d.err.join("")).toContain("タスクの予算（per_task_usd）で LLM を呼ぶ前に止まることがあり");
    const file = (await readdir(join(cwd, "o"))).find((f) => f.endsWith(".json"))!;
    const report = JSON.parse(await readFile(join(cwd, "o", file), "utf8")) as TrapRateReport;
    expect(report.conditions.unpricedModels).toEqual(["gemini-9-ultra"]);
    // 高めの単価の見積もりはタスクの予算 $0.2 を1回目で超えるので、Gemini（の代わり）は呼ばれない（費用の守りは緩めない）
    expect(models).toEqual([]);
    expect(d.out.join("")).toContain("価格表にないモデル（gemini-9-ultra）を高めの単価で数えた結果（--allow-unpriced）");
    expect(d.out.join("")).toContain("価格表にないモデル（gemini-9-ultra）は高めの単価で数えた");
    // scripted でも同じ（--model の上書き）
    const s = deps(await tempDir());
    expect(await runMeasureCli(["--model", "unknown-model", "--allow-unpriced", "--runs", "1", "--faults", "F-04"], s)).toBe(0);
  });

  it("開始の行にシードの決め方を出す（既定は状況の中は同じシード、--seed-mode per-run は走行ごとに別）", async () => {
    const a = deps(await tempDir());
    expect(await runMeasureCli(["--runs", "1", "--faults", "F-04"], a)).toBe(0);
    expect(a.err.join("")).toContain("状況の中は同じシード");
    const b = deps(await tempDir());
    expect(await runMeasureCli(["--runs", "2", "--faults", "F-04", "--seed-mode", "per-run"], b)).toBe(0);
    expect(b.err.join("")).toContain("走行ごとに別のシード");
    const seeds = [...b.err.join("").matchAll(/seed=(\d+)/g)].map((m) => m[1]);
    expect(new Set(seeds).size).toBe(2);
  });

  it("中断（signal）したら途中までを書いて終了コード 130", async () => {
    const cwd = await tempDir();
    const controller = new AbortController();
    controller.abort();
    const d = deps(cwd, { signal: controller.signal });
    expect(await runMeasureCli(["--runs", "1", "--out", "r"], d)).toBe(130);
    expect(d.err.join("")).toContain("中断したため");
    expect((await readdir(join(cwd, "r"))).length).toBe(2);
  });
});

describe("--models と --compare（モデル比較・LLM は呼ばない）", () => {
  it("--models は費用計りを共有し、上限到達後に次モデルを走らせない（scripted）", async () => {
    const cwd = await tempDir();
    const d = deps(cwd);
    expect(await runMeasureCli(["--llm", "scripted", "--models", "gemini-3.8-flash,gemini-3.1-pro-preview", "--runs", "1", "--faults", "F-03", "--max-cost-usd", "0.000001"], d)).toBe(0);
    const files = await readdir(join(cwd, "results"));
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(files.some((f) => f.includes("gemini-3.8-flash"))).toBe(true);
    expect(files.some((f) => f.includes("gemini-3.1-pro-preview"))).toBe(false);
    expect(d.err.join("")).toContain("費用の上限に当たった");
  });

  it("--models --out=DIR は個別結果と比較表で同じ出力先を使う（scripted）", async () => {
    const cwd = await tempDir();
    expect(await runMeasureCli(["--llm", "scripted", "--models", "gemini-3.8-flash", "--runs", "1", "--faults", "F-03", "--out=cmp"], deps(cwd))).toBe(0);
    expect((await readdir(join(cwd, "cmp"))).some((f) => f.startsWith("compare-"))).toBe(true);
    expect((await readdir(join(cwd, "results")).catch(() => [])).length).toBe(0);
  });
  it("--models：モデルごとに計測して結果を別の名前で書き、最後に比較の表を --out に書く（scripted の配管）", async () => {
    const cwd = await tempDir();
    const d = deps(cwd);
    const code = await runMeasureCli(["--llm", "scripted", "--models", "gemini-3.8-flash,gemini-3.1-pro-preview", "--runs", "1", "--faults", "F-03"], d);
    expect(code).toBe(0);
    const files = (await readdir(join(cwd, "results"))).sort();
    expect(files).toEqual([
      "compare-20261005-100000.md",
      "trap-rate-20261005-100000-scripted-gemini-3.1-pro-preview.json",
      "trap-rate-20261005-100000-scripted-gemini-3.1-pro-preview.md",
      "trap-rate-20261005-100000-scripted-gemini-3.8-flash.json",
      "trap-rate-20261005-100000-scripted-gemini-3.8-flash.md",
    ]);
    const table = d.out.join("");
    expect(table).toContain("## モデル比較（FR-068）");
    expect(table).toContain("| scripted-trap（gemini-3.8-flash） |");
    expect(table).toContain("| scripted-trap（gemini-3.1-pro-preview） |");
    expect(table).toContain("偽物のエージェント（scripted）の結果を含む");
    const compareFile = await readFile(join(cwd, "results", "compare-20261005-100000.md"), "utf8");
    expect(compareFile.startsWith("## モデル比較（FR-068）")).toBe(true);
    expect(table.endsWith(compareFile)).toBe(true);
  });

  it("--models：価格表にないモデルは、そのモデルで止まり終了コード 2（比較は書かない）", async () => {
    const cwd = await tempDir();
    const d = deps(cwd);
    expect(await runMeasureCli(["--llm", "scripted", "--models", "no-such-model", "--runs", "1", "--faults", "F-03"], d)).toBe(2);
    expect(d.err.join("")).toContain("価格表にないモデルは使わない");
    expect(d.out.join("")).toBe("");
  });

  it("--models と --model は一緒に使えない。--models の値がなければ終了コード 2", async () => {
    expect(await runMeasureCli(["--models", "gemini-3.8-flash", "--model", "gemini-3.1-pro-preview"], deps(await tempDir()))).toBe(2);
    expect(await runMeasureCli(["--models", ","], deps(await tempDir()))).toBe(2);
    expect(await runMeasureCli(["--models"], deps(await tempDir()))).toBe(2);
  });

  it("--compare：既存の計測結果（scripted で書いた JSON）を合成し、表を標準出力と --out に出す。LLM は呼ばない", async () => {
    const cwd = await tempDir();
    expect(await runMeasureCli(["--llm", "scripted", "--runs", "1", "--faults", "F-03", "--out", "r"], deps(cwd))).toBe(0);
    const json = "r/trap-rate-20261005-100000-scripted.json";
    const d = deps(cwd, { now: fixedClock("2026-10-06T09:00:00+09:00") });
    expect(await runMeasureCli(["--compare", json, json, "--out", "cmp"], d)).toBe(0);
    expect(d.out.join("")).toContain("| scripted-trap | trap-rate-20261005-100000-scripted.json | 2026-10-05 | 1/1 |");
    expect((await readdir(join(cwd, "cmp"))).sort()).toEqual(["compare-20261006-090000.md"]);
  });

  it("--compare：ファイルがない・形が違う・知らない引数は終了コード 2", async () => {
    const cwd = await tempDir();
    expect(await runMeasureCli(["--compare"], deps(cwd))).toBe(2);
    const missing = deps(cwd);
    expect(await runMeasureCli(["--compare", "nope.json"], missing)).toBe(2);
    expect(missing.err.join("")).toContain("nope.json を読めない");
    expect(await runMeasureCli(["--compare", "a.json", "--runs", "3"], deps(cwd))).toBe(2);
  });
});
