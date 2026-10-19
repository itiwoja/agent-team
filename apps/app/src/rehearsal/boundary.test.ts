// BR-67①：shadow と rehearsal_run_id はリハーサルの実行（FR-043。run.ts → insertRehearsalTask）がタスクを作るときにだけ付けられる。
// タスク作成の API・設定プランナー・エージェントのツールからは付けられない。ソースを走査して、呼び出し元の集合を固定する
// （DB の CHECK は「shadow ならリハーサルの走行つき」までしか守れないので、入口を増やしたらここで落とす）
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_SPECS } from "@open-team/runner";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const TEST_FILE = /(\.test\.ts$|(^|\/)test-helpers\.ts$|(^|\/)__fixtures__\/|(^|\/)testing-fixtures\.ts$|(^|\/)node_modules\/)/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = ["apps", "packages", "scripts"]
  .flatMap((top) => readdirSync(join(ROOT, top)).map((n) => join(ROOT, top, n, "src")))
  .filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap((d) => sources(d))
  .map((p) => ({ path: relative(ROOT, p).replaceAll("\\", "/"), text: readFileSync(p, "utf8") }))
  .filter((f) => !TEST_FILE.test(f.path));

const grep = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.path);

describe("BR-67① shadow・rehearsal_run_id を付けられる入口", () => {
  it("tasks の INSERT は db の insertRehearsalTask（リハーサル）と insertAskTask（本番の依頼のタスク）だけ。増えるときはここで確かめる", () => {
    expect(grep(/INSERT\s+INTO\s+tasks\b/i).sort()).toEqual(["packages/db/src/repo/asks.ts", "packages/db/src/repo/rehearsal.ts"]);
  });
  it("本番の依頼のタスク（insertAskTask）は shadow・rehearsal_run_id・リハーサルの印を付けない（trigger_type = 'ask'・本番だけ）", () => {
    const asks = files.find((f) => f.path === "packages/db/src/repo/asks.ts");
    expect(asks).toBeDefined();
    const insert = /INSERT\s+INTO\s+tasks\b[\s\S]*?RETURNING/i.exec(asks!.text)?.[0] ?? "";
    expect(insert).toContain("'ask', false, 'live'");
    expect(insert).not.toMatch(/\b(shadow|rehearsal_run_id|rehearsal_scenario_id|sim_execution_id)\b/);
  });
  it("tasks の UPDATE で shadow・rehearsal_run_id・execution_variant を書く所はない", () => {
    // SET の並び（WHERE・FROM・RETURNING の前まで）に、これらの列への代入があるか
    const setLists = (text: string): string[] =>
      [...text.matchAll(/UPDATE\s+tasks\s+SET((?:(?!\b(?:WHERE|FROM|RETURNING)\b)[\s\S])*)/gi)].map((m) => m[1] ?? "");
    const hits = files.filter((f) => setLists(f.text).some((l) => /\b(shadow|rehearsal_run_id|rehearsal_scenario_id|execution_variant|is_dry_run)\s*=/i.test(l)));
    expect(hits.map((f) => f.path)).toEqual([]);
  });
  it("insertRehearsalTask を呼ぶのはリハーサルの実行（run.ts）だけ", () => {
    expect(grep(/\binsertRehearsalTask\b/).sort()).toEqual(["apps/app/src/rehearsal/run.ts", "packages/db/src/repo/rehearsal.ts"]);
  });
  it("app のルート・設定プランナー・依頼の契約・エージェントのツール・edge の入力の検証は shadow・rehearsal_run_id を受け取らない", () => {
    const entries = files.filter(
      (f) =>
        f.path.startsWith("apps/app/src/routes/") ||
        f.path === "apps/app/src/asks/planner.ts" ||
        f.path === "apps/app/src/asks/contract.ts" ||
        f.path === "packages/runner/src/tools.ts" ||
        f.path === "packages/edge/src/validate.ts",
    );
    expect(entries.map((f) => f.path)).toContain("apps/app/src/asks/planner.ts");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((f) => /\b(shadow|rehearsal_run_id|rehearsalRunId)\b/.test(f.text)).map((f) => f.path)).toEqual([]);
  });
  it("エージェントのツール（LLM が呼べるもの）に shadow・rehearsal の項目はない", () => {
    const specs = Object.values(TOOL_SPECS);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.filter((t) => /shadow|rehearsal/i.test(JSON.stringify(t.inputSchema))).map((t) => t.name)).toEqual([]);
  });
});
