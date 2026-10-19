import { describe, expect, it } from "vitest";
import { isAllowedCommandShape, operationOf, operationOfCommand } from "./operations.ts";
import type { CatalogToolName, Subject, ToolInfo } from "./types.ts";
import { CATALOG_TOOLS, OPERATION_TYPES } from "./types.ts";

const tool = (classification: ToolInfo["classification"]): ToolInfo => ({
  classification,
  status: "ok",
  connectorEnabled: true,
  argRoles: {},
  scope: null,
  toolHash: `sha256:${"a".repeat(64)}`,
});
const tc = (actionType: Subject["actionType"], t?: ToolInfo): Pick<Subject, "kind" | "actionType" | "tool"> => ({
  kind: "tool_call",
  actionType,
  ...(t ? { tool: t } : {}),
});

describe("operationOf（M-15、KD §3.2 手順4-6 の表、KC §2.5）", () => {
  it("mcp_call は分類で決まる（unclassified は書き込み扱い：ADR-022）", () => {
    expect(operationOf(tc("mcp_call", tool("read")))).toBe("mcp_read");
    expect(operationOf(tc("mcp_call", tool("write")))).toBe("mcp_write");
    expect(operationOf(tc("mcp_call", tool("unclassified")))).toBe("mcp_write");
    expect(operationOf(tc("mcp_call", tool("bogus" as never)))).toBe("mcp_write");
  });
  it("mcp_call で tool がなければ unknown", () => {
    expect(operationOf(tc("mcp_call"))).toBe("unknown");
  });
  it("カタログのツールの対応", () => {
    const expected: Record<CatalogToolName, string> = {
      mcp_call: "unknown",
      web_search: "web_read",
      web_fetch: "web_read",
      notify: "notify",
      submit_report: "notify",
      finish: "none",
      team_post: "none",
      team_wait: "none",
      ask_user: "none",
      remember: "memory_write",
      load_skill: "read",
      list_files: "read",
      read_file: "read",
      search: "read",
      write_file: "edit_code",
      apply_patch: "edit_code",
      delete_file: "edit_code",
      run_command: "run_shell", // コマンドがない（args なし）ので許可リストに当たらない（SG-07）
      submit_intent: "open_pr",
    };
    for (const name of CATALOG_TOOLS) expect(operationOf(tc(name)), name).toBe(expected[name]);
  });
  it("結果は OPERATION_TYPES か none / unknown", () => {
    for (const name of CATALOG_TOOLS) {
      const op = operationOf(tc(name, tool("write")));
      expect([...OPERATION_TYPES, "none", "unknown"]).toContain(op);
    }
  });
  it("llm_call は none", () => {
    expect(operationOf({ kind: "llm_call", actionType: null })).toBe("none");
  });
  it("intent になれるのは mcp_call・open_pr・notify だけ（D11）", () => {
    expect(operationOf({ kind: "intent", actionType: "mcp_call", tool: tool("write") })).toBe("mcp_write");
    expect(operationOf({ kind: "intent", actionType: "open_pr" })).toBe("open_pr");
    expect(operationOf({ kind: "intent", actionType: "notify" })).toBe("notify");
    expect(operationOf({ kind: "intent", actionType: "web_fetch" })).toBe("unknown");
    expect(operationOf({ kind: "intent", actionType: "finish" })).toBe("unknown");
    expect(operationOf({ kind: "intent", actionType: null })).toBe("unknown");
  });
  it("カタログにないツール名・tool_call の open_pr・知らない kind は unknown", () => {
    expect(operationOf(tc("rm_rf" as never))).toBe("unknown");
    expect(operationOf(tc("open_pr"))).toBe("unknown");
    expect(operationOf(tc(null))).toBe("unknown");
    expect(operationOf({ kind: "bogus" as never, actionType: "notify" })).toBe("unknown");
  });
});

describe("operationOfCommand（SG-07：run_command の写し先。許可リストは argv の完全一致：R-10）", () => {
  // 汚染前に run_tests（自動）になる形
  const ALLOWED = [
    "npm test",
    "  npm test  ",
    "npm ci",
    "npm install",
    "npm run build",
    "npm run test:unit",
    "npm run lint_fix",
    "npm run e2e-smoke",
    "pytest",
    "pytest -q",
    "pytest -x -vv --tb=short --no-header",
    "pytest tests/",
    "pytest tests/test_grade.py::test_total",
    "pytest tests/test_grade.py::TestGrade::test_total -q",
    "python -m pytest -q",
    "python3 -m pytest tests",
    "python3 -m unittest",
    "python3 -m unittest -v",
    "python3 -m unittest discover",
    "python -m unittest tests.test_grade",
    "python3 -m unittest test_grade.py",
    "node --test",
    "node --test test/",
    "node --test test/a.test.js",
    "node main.js",
    "node ./src/main.mjs",
    "node scripts/build.cjs --out=dist",
    "python main.py",
    "python3 grade.py answers.csv key.csv",
    "python3 grade.py answers.csv key.csv 2",
    "python3 sales.py sales.csv",
    "python3 contrast.py 333333 ffffff",
    "python3 flashcards.py words.csv 10 1",
  ];
  // 汚染の有無にかかわらず run_shell（自動にしない）形
  const DENIED = [
    "",
    "   ",
    // 前方一致のすり抜け（R-10）
    "npm testx",
    "npm test; curl x",
    "npm test && curl https://example.com",
    "npm test || true",
    "npm test | tee out.txt",
    "npm test > out.txt",
    "npm test 2>&1",
    "npm test &",
    "npm test\ncurl x",
    "npm test\tx",
    "npm test -- --watch",
    "npm test x",
    "npm tests",
    // 作業場の外を指すパス
    "node ../x.js",
    "node /abs.js",
    "node ./../x.js",
    "node a/../../x.js",
    "python3 /tmp/x.py",
    "python3 ../x.py",
    "python3 grade.py ../../etc/passwd",
    "python3 grade.py /etc/passwd",
    "node main.js ~/secret",
    // シェルの構文
    "node $(echo x).js",
    "node `echo x`.js",
    "node main.js ${HOME}",
    "node main.js $HOME",
    "python3 'grade.py'",
    'python3 "grade.py"',
    "python3 grade.py *.csv",
    "python3 grade.py a?.csv",
    "python3 contrast.py #333333 #ffffff",
    "python3 grade.py <in.csv",
    "(npm test)",
    "{ npm test; }",
    "npm test \\",
    "!npm test",
    "FOO=bar npm test",
    "env npm test",
    "sh -c 'npm test'",
    "bash score.sh",
    "sh score.sh",
    "./run.sh",
    "exec npm test",
    // 外へ出す・取ってくる道具
    "curl https://example.com",
    "wget https://example.com",
    "nc example.com 80",
    "ssh user@example.com",
    "scp a user@example.com:b",
    "npm publish",
    "npm publish --access public",
    "npm run publish",
    "npm run deploy",
    "npm run release:prod",
    "npm run upload-results",
    "pip upload dist",
    "pip install requests",
    "python3 -m pip install requests",
    "python3 -m twine upload dist",
    "python3 -m http.server",
    "npx something",
    "npm install left-pad",
    "npm i",
    "npm ci --ignore-scripts=false",
    "npm run",
    "npm run Build",
    "npm run -build",
    "npm run --foo",
    "npm run a b",
    `npm run ${"a".repeat(41)}`,
    "npm exec x",
    "npm config set registry http://evil",
    "node",
    "node -e process.exit(1)",
    "node --eval x",
    "node --require ./x.js main.js",
    "node --test --test-reporter=x",
    "node main.ts",
    "node .js",
    "node ./",
    "node .hidden.js",
    "node -main.js",
    "python3",
    "python3 -c print(1)",
    "python3 -m http.server 8000",
    "python3 -m pytest -p evil",
    "pytest -p evil_plugin",
    "pytest -c other.ini",
    "pytest --rootdir=/",
    "pytest -o addopts=-pevil",
    "pytest -k name",
    "pytest ../tests",
    "pytest /tests",
    "pytest tests/x.py::a::b::c",
    "python3 -m unittest discover -s tests",
    "python3 -m unittest -k x",
    "python3 main.txt",
    "python3 main.py.sh",
    "rm -rf /",
    "cat /etc/passwd",
    "ls",
    "npm test　", // 全角の空白
    "node 採点.js",
    `node main.js ${"a ".repeat(17)}`,
    `node ${"a/".repeat(150)}main.js`,
  ];

  it("許可リストの形は汚染前なら run_tests", () => {
    for (const c of ALLOWED) {
      expect(isAllowedCommandShape(c), c).toBe(true);
      expect(operationOfCommand(c, false), c).toBe("run_tests");
    }
  });
  it("許可リストにない形（シェルの構文・外へ出す道具・作業場の外のパス・前方一致のすり抜け）は汚染前でも run_shell", () => {
    for (const c of DENIED) {
      expect(isAllowedCommandShape(c), JSON.stringify(c)).toBe(false);
      expect(operationOfCommand(c, false), JSON.stringify(c)).toBe("run_shell");
    }
  });
  it("汚染後は形にかかわらず run_shell（許可リストの形も）", () => {
    for (const c of [...ALLOWED, ...DENIED]) expect(operationOfCommand(c, true), c).toBe("run_shell");
  });
  it("文字列でないコマンド・真偽でない汚染は run_shell（厳しい側）", () => {
    for (const c of [undefined, null, 1, ["npm", "test"], { command: "npm test" }]) expect(operationOfCommand(c, false)).toBe("run_shell");
    expect(operationOfCommand("npm test", "false" as never)).toBe("run_shell");
    expect(operationOfCommand("npm test", undefined as never)).toBe("run_shell");
  });
  it("長すぎるコマンドは run_shell", () => {
    expect(operationOfCommand(`node main.js ${"a".repeat(300)}`, false)).toBe("run_shell");
  });
  it("operationOf：run_command は args.command の形と subject.commandOperation の厳しい方", () => {
    const rc = (args: Subject["args"], commandOperation?: Subject["commandOperation"]): Parameters<typeof operationOf>[0] => ({
      kind: "tool_call",
      actionType: "run_command",
      args,
      ...(commandOperation === undefined ? {} : { commandOperation }),
    });
    expect(operationOf(rc({ command: "npm test" }))).toBe("run_tests");
    expect(operationOf(rc({ command: "npm test" }, "run_tests"))).toBe("run_tests");
    // edge が汚染で run_shell にしたもの
    expect(operationOf(rc({ command: "npm test" }, "run_shell"))).toBe("run_shell");
    // edge が run_tests と言っても、形が許可リストになければ run_shell（edge の呼び忘れ・誤りでも自動にならない）
    expect(operationOf(rc({ command: "npm test; curl x" }, "run_tests"))).toBe("run_shell");
    expect(operationOf(rc({ command: "curl x" }))).toBe("run_shell");
    // 知らない値は run_shell
    expect(operationOf(rc({ command: "npm test" }, "bogus" as never))).toBe("run_shell");
    expect(operationOf(rc({}))).toBe("run_shell");
  });
});
