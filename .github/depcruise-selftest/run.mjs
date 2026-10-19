// lint:deps（.dependency-cruiser.cjs）が本当に違反を見つけるかの自己テスト（SO-RB-01、D-52）
// fixture/ に違反の見本（bad-*）と違反でない見本（ok-*）を置き、リポジトリの設定のまま dependency-cruiser を流して確かめる。
// .ts を読めずに「違反なし」で通る（TypeScript 7 で起きた）ことをここで落とす。
// 使い方：node .github/depcruise-selftest/run.mjs（依存を入れたあと。CI の ci.yml から呼ぶ）
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fixture = join(here, "fixture");
const bin = join(realpathSync(join(root, "node_modules", "dependency-cruiser")), "bin", "dependency-cruiser.mjs");

// [規則, 違反の元のファイル]。どれか1つでも出なければ失敗
const EXPECTED = [
  ["runner-no-db-client", "packages/runner/src/bad-db-pg.ts"],
  ["runner-no-db-client", "packages/runner/src/bad-db-postgres.ts"],
  ["runner-no-db-client", "packages/runner/src/bad-db-relative.ts"],
  ["runner-no-llm-client", "packages/runner/src/bad-llm-genai.ts"],
  ["runner-no-llm-client", "packages/runner/src/bad-llm-workspace.ts"],
  ["runner-no-llm-client", "packages/runner/src/bad-llm-dynamic.ts"],
  ["runner-no-gateway-client", "packages/runner/src/bad-gateway-mcp.ts"],
  ["runner-no-secrets", "packages/runner/src/bad-secrets-platform.ts"],
  ["pure-no-io-builtins", "packages/runner/src/bad-io-net.ts"],
  ["pure-no-io-builtins", "packages/kernel/src/bad-io-fs.ts"],
  ["pure-no-io-builtins", "packages/sim-core/src/bad-io-http.ts"],
  ["pure-no-io-builtins", "packages/oracles/src/bad-io-child.ts"],
  ["pure-no-network-packages", "packages/sim-core/src/bad-net-undici.ts"],
  ["no-circular", "packages/oracles/src/bad-cycle-a.ts"],
  ["no-circular", "apps/web/src/bad-cycle-x.tsx"],
];
// 型の除去と import の抜き出しが新しい構文でも効くこと（この依存が見えなければ .ts を読めていない）
const EXPECTED_DEPENDENCY = ["packages/kernel/src/ok-modern.ts", "packages/kernel/src/ok-crypto.ts"];

const depcruise = (outputType) => {
  const r = spawnSync(
    process.execPath,
    [bin, "--config", join(root, ".dependency-cruiser.cjs"), "--output-type", outputType, "packages", "apps"],
    { cwd: fixture, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error) throw r.error;
  return r;
};
const run = depcruise("json");

let result;
try {
  result = JSON.parse(run.stdout);
} catch {
  process.stderr.write(run.stderr);
  throw new Error(`dependency-cruiser の出力が JSON でない（終了コード ${run.status}）`);
}

const violations = result.summary.violations;
const problems = [];
for (const [rule, from] of EXPECTED) {
  if (!violations.some((v) => v.rule.name === rule && v.from === from)) problems.push(`見つからない：${rule} ← ${from}`);
}
for (const v of violations) {
  if (/(^|\/)ok-[^/]*$/.test(v.from)) problems.push(`違反でないはずのファイルで違反：${v.rule.name} ← ${v.from} → ${v.to}`);
}
const [depFrom, depTo] = EXPECTED_DEPENDENCY;
const modern = result.modules.find((m) => m.source === depFrom);
if (!modern?.dependencies.some((d) => d.resolved === depTo)) problems.push(`依存を読めていない：${depFrom} → ${depTo}`);
// pnpm lint:deps と同じ出力（err）なら、違反の数だけ終了コードが 0 でなくなる（json の出力では常に 0）
const errRun = depcruise("err");
if (errRun.status === 0) problems.push("違反があるのに dependency-cruiser（--output-type err）の終了コードが 0");

if (problems.length > 0) {
  process.stderr.write(`lint:deps の自己テストに失敗（${problems.length}件）\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `lint:deps の自己テスト：OK（見本 ${result.summary.totalCruised} モジュール、期待した違反 ${EXPECTED.length} 件をすべて検出）\n`,
);
