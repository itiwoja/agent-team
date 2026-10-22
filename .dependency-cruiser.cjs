// dependency-cruiser の設定。CI の `pnpm lint:deps` で回す（D-52）
// - packages/runner は DB・Gemini・gateway のクライアントと鍵に届くものを import しない（D-52、15:446,487-488）
// - 純粋なパッケージ（kernel と runner のロジック）は node:crypto のほかに I/O の組み込みとネットワークのパッケージを使わない
// - 循環・解決できない import・本番のコードからの devDependencies を禁止
// 規則が本当に違反を見つけるかは .github/depcruise-selftest/run.mjs で確かめる（SO-RB-01）
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const nodeModule = require("node:module");
const { spawnSync } = require("node:child_process");

// ---------------------------------------------------------------------------
// TypeScript 7 の回避（G-12）
// dependency-cruiser 18 は typescript <7 でしか .ts を読めない。ルートの typescript は 7（ネイティブ版。JS の API がない）なので、
// そのままだと .ts を1つも読まずに「違反なし」で通ってしまう。そこで dependency-cruiser から見える "typescript" を
// 「Node の型の除去（module.stripTypeScriptTypes）→ import の文だけを書き出す」小さな代わりに差し替え、
// その差し替えを先に入れた子プロセスで dependency-cruiser を動かし直す。
// - 型だけの import（import type）は消える（実行時と同じ。erasableSyntaxOnly なので型の除去で全部読める）
// - .tsx など型の除去で読めないものは、import の文を正規表現で拾う
// dependency-cruiser から typescript 5 系が見えるようにすれば（pnpm-workspace.yaml の packageExtensions）この節は要らない。
// ---------------------------------------------------------------------------
const SHIM_ENV = "OT_DEPCRUISE_TS_SHIM";
const SHIM_KEY = Symbol.for("open-team.depcruise-ts-shim");
const SHIM_URL = "open-team-depcruise:typescript";
const SHIM_PKG_URL = "open-team-depcruise:typescript/package.json";
// dependency-cruiser の版の確かめ（>=2 <7）に通る版を名乗る。`depcruise --info` では差し替えだと分かる名前で出る
const SHIM_VERSION = "5.0.0-node-strip";

// CLI（bin/dependency-cruiser.mjs）から動いているときの dependency-cruiser の本体の置き場所（実パス）。API から読まれたら null
function depcruiseCliDir() {
  const bin = process.argv[1];
  if (!bin) return null;
  try {
    const dir = path.dirname(path.dirname(fs.realpathSync(bin)));
    return path.basename(dir) === "dependency-cruiser" ? dir : null;
  } catch {
    return null;
  }
}

// dependency-cruiser の本体の置き場所（実パス）。CLI でなければ cwd の node_modules から探す
function depcruiseDir() {
  const fromCli = depcruiseCliDir();
  if (fromCli !== null) return fromCli;
  try {
    return fs.realpathSync(path.join(process.cwd(), "node_modules", "dependency-cruiser"));
  } catch {
    return null;
  }
}

// dependency-cruiser から見える typescript の大きい版。見えなければ null
function typescriptMajor(dir) {
  try {
    const { version } = nodeModule.createRequire(path.join(dir, "package.json"))("typescript/package.json");
    return Number.parseInt(String(version), 10);
  } catch {
    return null;
  }
}

// 型を除いた JS から、依存を表す文だけを書き出す（dependency-cruiser の acorn は ES2020 までなので、新しい構文を渡さない）
function importsOnlyFromJs(js, dcRequire) {
  const acorn = dcRequire("acorn");
  const walk = dcRequire("acorn-walk");
  const ast = acorn.parse(js, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
  const lines = [];
  const literal = (n) => (n && n.type === "Literal" && typeof n.value === "string" ? n.value : null);
  walk.full(ast, (node) => {
    if (node.type === "ImportDeclaration") lines.push(`import ${JSON.stringify(node.source.value)};`);
    else if (node.type === "ExportAllDeclaration") lines.push(`export * from ${JSON.stringify(node.source.value)};`);
    else if (node.type === "ExportNamedDeclaration" && node.source) lines.push(`export * from ${JSON.stringify(node.source.value)};`);
    else if (node.type === "ImportExpression") {
      const s = literal(node.source);
      if (s !== null) lines.push(`import(${JSON.stringify(s)});`);
    } else if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
      const s = node.arguments.length === 1 ? literal(node.arguments[0]) : null;
      if (s !== null) lines.push(`require(${JSON.stringify(s)});`);
    }
  });
  return lines.join("\n");
}

// 型の除去で読めないとき（.tsx・非消去の構文）の予備。import type は拾わない（実行時に消えるため）
function importsOnlyByRegex(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  const lines = [];
  const patterns = [
    [/\bimport\s+(?!type\s)(?:[\w$*{},\s]+?\s+from\s+)?(["'])([^"'\n]+)\1/g, (s) => `import ${s};`],
    [/\bexport\s+(?!type\s)(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\1/g, (s) => `export * from ${s};`],
    [/\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g, (s) => `import(${s});`],
    [/\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g, (s) => `require(${s});`],
  ];
  for (const [re, emit] of patterns) {
    for (const m of code.matchAll(re)) lines.push(emit(JSON.stringify(m[2])));
  }
  return lines.join("\n");
}

// 子プロセスで最初に（--require で）呼ぶ。dependency-cruiser の中の "typescript" だけを差し替える
function installTypescriptShim(dcDir) {
  if (globalThis[SHIM_KEY]) return;
  if (typeof nodeModule.registerHooks !== "function" || typeof nodeModule.stripTypeScriptTypes !== "function") {
    throw new Error("lint:deps: Node 22.18 以上が要る（module.registerHooks・module.stripTypeScriptTypes）");
  }
  const dcRequire = nodeModule.createRequire(path.join(dcDir, "package.json"));
  globalThis[SHIM_KEY] = {
    version: SHIM_VERSION,
    transpileModule(source) {
      let outputText;
      try {
        outputText = importsOnlyFromJs(nodeModule.stripTypeScriptTypes(source, { mode: "strip" }), dcRequire);
      } catch {
        outputText = importsOnlyByRegex(source);
      }
      return { outputText, diagnostics: [] };
    },
  };
  const fromDepcruise = (parentURL) => typeof parentURL === "string" && parentURL.includes("/dependency-cruiser/");
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (fromDepcruise(context.parentURL)) {
        if (specifier === "typescript") return { url: SHIM_URL, format: "module", shortCircuit: true };
        if (specifier === "typescript/package.json") return { url: SHIM_PKG_URL, format: "json", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === SHIM_URL) {
        // SyntaxKind は dependency-cruiser が読み込み時に参照するだけ（tsc の解析は使わない：parser は acorn）
        const source = [
          `const shim = globalThis[Symbol.for(${JSON.stringify(SHIM_KEY.description)})];`,
          `export const version = shim.version;`,
          `export const transpileModule = shim.transpileModule;`,
          `export const SyntaxKind = Object.freeze({});`,
          `export default { version, transpileModule, SyntaxKind };`,
        ].join("\n");
        return { format: "module", source, shortCircuit: true };
      }
      if (url === SHIM_PKG_URL) {
        return { format: "json", source: JSON.stringify({ name: "typescript", version: SHIM_VERSION }), shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

const DC_DIR = depcruiseDir();
let useShim = false;
if (process.env[SHIM_ENV] === "1") {
  if (DC_DIR === null) throw new Error("lint:deps: dependency-cruiser の場所が分からない");
  installTypescriptShim(DC_DIR);
  useShim = true;
} else {
  const major = DC_DIR === null ? null : typescriptMajor(DC_DIR);
  const nativeOk = major !== null && major < 7;
  if (!nativeOk) {
    // .ts を読めないまま「違反なし」で通さない。CLI なら差し替えを入れて動かし直し、API なら止める
    if (depcruiseCliDir() === null) {
      throw new Error(`lint:deps: dependency-cruiser から typescript <7 が見えない（CLI の depcruise で動かすか、${SHIM_ENV}=1 と --require でこの設定を先に読む）`);
    }
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, "--disable-warning=ExperimentalWarning", "--require", __filename, ...process.argv.slice(1)],
      { stdio: "inherit", env: { ...process.env, [SHIM_ENV]: "1" } },
    );
    if (child.error) throw child.error;
    process.exit(child.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// 規則
// パスは cwd（リポジトリのルート）からの相対で、シンボリックリンクは実パスに直してから比べる（pnpm のワークスペースは packages/<名前>/…）
// ---------------------------------------------------------------------------

// テスト・テスト用の置き物（本番では読み込まれない）
const TEST_FILES = "(^|/)(__fixtures__|__golden__|__mocks__)/|\\.(test|spec)\\.[cm]?tsx?$|(^|/)test-helpers\\.[cm]?ts$";
// ビルドの設定（devDependencies を使ってよい）
const BUILD_CONFIG_FILES = "(^|/)(vite|vitest)\\.config\\.[cm]?[jt]s$";

// npm のパッケージ名に当てる。解決できたもの（node_modules/.pnpm/<名前>@<版>/node_modules/<名前>/…）と、
// 解決できなかったもの（書いたままの名前）の両方に当たる。量指定子を入れ子にしない（dependency-cruiser が危ない正規表現として拒む）
function npm(...names) {
  return `(^|(^|/)node_modules/|(^|/)node_modules/\\.pnpm/[^/]+/node_modules/)(${names.join("|")})(/|$)`;
}
// ワークスペースのパッケージに当てる。実パス（packages/<名前>/…）と、解決できなかった名前（@open-team/<名前>）の両方
function workspace(...names) {
  return `^(packages/(${names.join("|")})/|@open-team/(${names.join("|")})(/|$))`;
}

// 純粋なパッケージ（kernel）と runner のロジック
const PURE = "^packages/(kernel|runner)/";
// I/O を持たない組み込みだけ許す（node:crypto は Kernel のハッシュに使う：cross-check §3.1）。
// fs・net・http(s)・http2・tls・dgram・dns・child_process・worker_threads・cluster・os・process・vm・sqlite・timers・perf_hooks などは不可
const PURE_BUILTINS = "^(node:)?(crypto|util|util/types|assert|assert/strict|buffer|string_decoder|url|querystring|punycode|path|path/posix|path/win32|events)$";

// D-52：runner から届いてはいけないもの
const DB_CLIENTS = [npm("pg", "pg-[\\w.-]+", "postgres"), workspace("db")];
const LLM_CLIENTS = [npm("@google/genai"), workspace("llm", "edge")];
const GATEWAY_CLIENTS = ["^apps/gateway/", workspace("gateway[\\w-]*"), npm("@modelcontextprotocol/sdk")];
const SECRETS = [workspace("platform"), "^apps/"];

// ネットワーク・外部 I/O のパッケージ（純粋なパッケージから禁止）
const NETWORK_PACKAGES = [
  npm(
    "@google/genai",
    "gaxios",
    "@modelcontextprotocol/sdk",
    "@hono/node-server",
    "undici",
    "node-fetch",
    "cross-fetch",
    "axios",
    "got",
    "ky",
    "ws",
    "pg",
    "pg-[\\w.-]+",
    "postgres",
  ),
  workspace("llm", "edge", "db", "platform", "gateway[\\w-]*"),
  "^apps/",
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "runner-no-db-client",
      comment: "D-52：packages/runner は DB のクライアント（pg・postgres・packages/db）を import しない。runner は edge の関数を通してしか外に届かない（15:446,488）",
      severity: "error",
      from: { path: "^packages/runner/" },
      to: { path: DB_CLIENTS, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "runner-no-llm-client",
      comment: "D-52：packages/runner は Gemini API のクライアント（@google/genai・packages/llm・packages/edge）を import しない。LLM は注入された EdgePort 経由だけ",
      severity: "error",
      from: { path: "^packages/runner/" },
      to: { path: LLM_CLIENTS, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "runner-no-gateway-client",
      comment: "D-52：packages/runner は gateway のクライアントと MCP の SDK を import しない。書き込みは gateway だけが行う（15:445-446）",
      severity: "error",
      from: { path: "^packages/runner/" },
      to: { path: GATEWAY_CLIENTS, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "runner-no-secrets",
      comment: "15:487「runner は鍵・DB に届かない」：環境変数（鍵）を読む packages/platform・apps/* を import しない",
      severity: "error",
      from: { path: "^packages/runner/" },
      to: { path: SECRETS, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "pure-no-io-builtins",
      comment: "純粋なパッケージ（kernel・runner のロジック）は node:crypto など I/O のない組み込みだけを使う。時刻・乱数・ID は引数で受け取る",
      severity: "error",
      from: { path: PURE, pathNot: TEST_FILES },
      to: { dependencyTypes: ["core"], dependencyTypesNot: ["type-only"], pathNot: PURE_BUILTINS },
    },
    {
      name: "pure-no-network-packages",
      comment: "純粋なパッケージはネットワーク・DB・クラウドのパッケージと、I/O を持つワークスペースのパッケージ・apps を import しない",
      severity: "error",
      from: { path: PURE, pathNot: TEST_FILES },
      to: { path: NETWORK_PACKAGES, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-circular",
      comment: "循環を作らない（型だけの import は実行時に消えるので数えない）",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
    {
      name: "not-to-unresolvable",
      comment: "解決できない import は禁止（package.json に書いていない依存は、pnpm の厳密な配置とイメージで実行時に落ちる）",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-non-package-json",
      comment: "いちばん近い package.json に書いていない npm のパッケージを使わない",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "not-to-dev-dep",
      comment: "apps・packages の本番のコードから devDependencies を使わない（Docker のイメージは本番の依存だけを入れる）。テストとビルドの設定は除く",
      severity: "error",
      from: { path: "^(apps|packages)/", pathNot: [TEST_FILES, BUILD_CONFIG_FILES] },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    doNotFollow: { path: ["(^|/)node_modules/"] },
    // 自分たちのビルド結果だけを除く（node_modules の中の dist/ まで除くと npm の依存が消え、規則が当たらなくなる）
    exclude: { path: ["^(apps|packages)/[^/]+/(dist|coverage)/"] },
    moduleSystems: ["es6", "cjs"],
    // 差し替えのときは型の情報がないので acorn で読む。typescript 5 系が見えるなら型だけの import も数える
    tsPreCompilationDeps: !useShim,
    parser: useShim ? "acorn" : "tsc",
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
