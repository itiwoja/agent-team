// 操作の種類（M-15：subject.actionType はカタログのツール名で、操作の種類はここで導く。KD §3.2 手順4-6、KC §2.5）
// policy_decisions.action_type には DecideResult.operation（＝この結果）を入れる

import { CATALOG_TOOLS } from "./types.ts";
import type { CatalogToolName, OperationType, Subject } from "./types.ts";

/** ツール → 操作の種類。'none' は判定の外（finish は常に許可、連絡板は読み取りの扱い：M-22、KC §8 #32） */
const TOOL_OPERATION: Readonly<Record<CatalogToolName, OperationType | "by_classification" | "none">> = {
  mcp_call: "by_classification", // read → mcp_read、write・unclassified → mcp_write（ADR-022）
  web_search: "web_read",
  web_fetch: "web_read",
  notify: "notify",
  submit_report: "notify", // catalogs.md:82
  finish: "none",
  team_post: "none",
  team_wait: "none",
  // 利用者に聞くだけ（外へは何も出さず、権限も変えない）。連絡板と同じく判定の外
  ask_user: "none",
  remember: "memory_write",
  load_skill: "read",
  list_files: "read",
  read_file: "read",
  search: "read",
  write_file: "edit_code",
  apply_patch: "edit_code",
  delete_file: "edit_code",
  // 作業場（サンドボックス）の中の実行（D-116）。決まった形のテストのコマンドは run_tests、それ以外は run_shell（SG-07）。
  // 写し先は operationOf の中で commandOperationOf が決める（この表の値は形が許可リストにあるときのもの）。
  // 外へ出る shell_network は Hard Ceiling で常に deny のまま（作業場の外でコマンドを動かす経路は作らない）
  run_command: "run_tests",
  submit_intent: "open_pr",
};

function isCatalogTool(name: unknown): name is CatalogToolName {
  return typeof name === "string" && (CATALOG_TOOLS as readonly string[]).includes(name);
}

/**
 * 判定の対象の操作の種類。
 * - llm_call・finish・team_post・team_wait・ask_user → 'none'（判定の外）
 * - tool_call はカタログのツール名から、intent は 'mcp_call'・'open_pr'・'notify' だけ（KD §3.2 4-2）
 * - mcp_call は ToolInfo.classification で mcp_read / mcp_write（unclassified と不明な値は書き込み扱い）。tool がなければ 'unknown'
 * - run_command は run_tests か run_shell（SG-07。commandOperationOf）
 * - それ以外 → 'unknown'
 */
export function operationOf(
  subject: Pick<Subject, "kind" | "actionType" | "tool"> & Partial<Pick<Subject, "args" | "commandOperation">>,
): OperationType | "none" | "unknown" {
  const t = subject.actionType;
  if (subject.kind === "llm_call") return "none";
  if (subject.kind === "intent") {
    if (t === "open_pr") return "open_pr";
    if (t === "notify") return "notify";
    if (t !== "mcp_call") return "unknown";
  } else if (subject.kind !== "tool_call" || !isCatalogTool(t)) {
    return "unknown";
  }
  if (t === "run_command") return commandOperationOf(subject);
  const op = TOOL_OPERATION[t];
  if (op !== "by_classification") return op;
  if (!subject.tool) return "unknown";
  return subject.tool.classification === "read" ? "mcp_read" : "mcp_write";
}

// ---- 作業場のコマンドの写し先（SG-07） ----
//
// 形の許可リストはコード実行の境界ではない：テストの中身（package.json の scripts・conftest.py・テストのファイル）は担当が
// edit_code で書けるので、npm test でも任意のコードが動く。本当の境界は網（作業場から外へ出られるのはレジストリの読み取りだけ：フェーズ1）。
// 判定の層でやるのは次の2つだけ：
//  (a) 汚染の出口：タスクが外の内容を読んだあとは、形にかかわらず run_shell（自動では動かさない）。
//      プロンプト注入で書かされたコードを、人の確認なしに動かす経路を閉じる
//  (b) 許可リストにない形（パイプ・リダイレクト・;・&&・$()・引用符などのシェルの構文、curl・wget・nc・ssh・npm publish など）は、
//      汚染の有無にかかわらず run_shell
// 許可リストは argv の完全一致の形で書き、前方一致は使わない（R-10：「npm test」で始まる「npm testx」「npm test; curl x」を通さない）。
//
// 汚染（tainted）は「どの操作として判定するか」を決めるここでだけ使う。decide() の手順の条件には入れない（BR-39・decide.ts の冒頭）。
// edge が判定の入力を作るときにこの関数を呼び、結果を Subject.commandOperation に入れる。

/** コマンドの文字列の上限（これより長いものは形を見ずに run_shell） */
export const COMMAND_MAX_CHARS = 300;
/** スクリプト（node・python）・テストに渡せる引数の数の上限 */
export const COMMAND_MAX_ARGS = 16;

/**
 * コマンドに使える文字。シェルが特別に読む文字（空白以外の区切り・引用符・$・`・;・&・|・<・>・(・)・{・}・*・?・[・]・~・!・#・\・改行・タブ）と
 * ASCII の外の文字は含めない。= は argv の途中ではただの文字だが、先頭の語に来ると環境変数の代入になる（先頭は必ずプログラム名なので通らない）
 */
const SAFE_COMMAND = /^[A-Za-z0-9 ._/:=@%+,-]+$/;
/** npm run の名前（^[a-z0-9:_-]{1,40}$ のうち、先頭は英小文字か数字：- で始まる名前を npm のオプションと読ませない） */
const NPM_SCRIPT_NAME = /^[a-z0-9][a-z0-9:_-]{0,39}$/;
/** npm run でも自動にしない名前（外へ出す意図の名前。中身は担当が書けるので網が本当の境界：補助の印） */
const NPM_SCRIPT_NAME_DENY = /publish|deploy|release|upload/;
/** 作業場の根からの相対パスの1区切り（英数字か _ で始まる：-・. で始まるもの（オプション・..・隠しファイル）は通さない） */
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** pytest の対象の後ろに付けられる '::名前' */
const PYTEST_NODE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** python -m unittest の対象のモジュール名（tests.test_x） */
const PY_MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
/** pytest のオプション（決めたものだけ。-p（プラグイン）・-c（設定）・-o・--rootdir などは通さない） */
const PYTEST_OPTIONS: ReadonlySet<string> = new Set(["-q", "-v", "-vv", "-x", "-s", "--tb=short", "--tb=line", "--tb=no", "--no-header"]);
/** python -m unittest のオプション */
const UNITTEST_OPTIONS: ReadonlySet<string> = new Set(["-v", "-q"]);
const PYTHON = new Set(["python", "python3"]);

/** 作業場の根からの相対パス。絶対パス・..・空の区切り・- や . で始まる区切りは通さない（先頭の ./ だけは許す）。dir なら末尾の / を許す */
function isRelativePath(p: string, opts: { dir?: boolean } = {}): boolean {
  let rest = p.startsWith("./") ? p.slice(2) : p;
  if (opts.dir === true && rest.endsWith("/")) rest = rest.slice(0, -1);
  if (rest === "" || rest.length > 200) return false;
  return rest.split("/").every((seg) => PATH_SEGMENT.test(seg));
}

/** 拡張子つきの相対パスのファイル（区切りは . で始まれないので、'.js' だけのものは通らない） */
function isRelativeFile(p: string, exts: readonly string[]): boolean {
  return isRelativePath(p) && exts.some((e) => p.endsWith(e));
}

/** スクリプトに渡す引数：シェルの文字は SAFE_COMMAND で除いてある。絶対パスと .. は通さない（作業場の外を指させない） */
function isScriptArg(a: string): boolean {
  return a !== "" && !a.startsWith("/") && !a.includes("..");
}

/** pytest の対象：相対パス（ファイルかディレクトリ）に '::名前' を2つまで */
function isPytestTarget(a: string): boolean {
  const [file, ...names] = a.split("::");
  if (file === undefined || names.length > 2 || !names.every((n) => PYTEST_NODE_NAME.test(n))) return false;
  return isRelativePath(file, { dir: names.length === 0 });
}

function pytestArgsAllowed(args: readonly string[]): boolean {
  return args.length <= COMMAND_MAX_ARGS && args.every((a) => PYTEST_OPTIONS.has(a) || isPytestTarget(a));
}

function unittestArgsAllowed(args: readonly string[]): boolean {
  if (args.length > COMMAND_MAX_ARGS) return false;
  const rest = args.filter((a) => !UNITTEST_OPTIONS.has(a));
  if (rest.length === 1 && rest[0] === "discover") return true;
  return rest.every((a) => a !== "discover" && (PY_MODULE_NAME.test(a) || isRelativeFile(a, [".py"])));
}

/**
 * 許可リスト（argv の完全一致の形）。どれにも当たらなければ false
 * - npm test ／ npm ci ／ npm install（引数なし）／ npm run <名前>（NPM_SCRIPT_NAME。publish・deploy・release・upload を含む名前は除く）
 * - pytest [オプション|対象...] ／ python|python3 -m pytest [同じ]
 * - python|python3 -m unittest [-v|-q] [discover | モジュール名|相対パス.py ...]
 * - node --test [相対パス...] ／ node <相対パス>.js|.mjs|.cjs [引数...]
 * - python|python3 <相対パス>.py [引数...]
 */
function isAllowedArgv(argv: readonly string[]): boolean {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "npm": {
      const [sub, ...rest] = args;
      if (sub === "test" || sub === "ci" || sub === "install") return rest.length === 0;
      if (sub === "run") {
        const [name, ...more] = rest;
        return more.length === 0 && name !== undefined && NPM_SCRIPT_NAME.test(name) && !NPM_SCRIPT_NAME_DENY.test(name);
      }
      return false;
    }
    case "pytest":
      return pytestArgsAllowed(args);
    case "node": {
      const [first, ...rest] = args;
      if (first === "--test") return rest.length <= COMMAND_MAX_ARGS && rest.every((a) => isRelativePath(a, { dir: true }));
      return first !== undefined && isRelativeFile(first, [".js", ".mjs", ".cjs"]) && rest.length <= COMMAND_MAX_ARGS && rest.every(isScriptArg);
    }
    case "python":
    case "python3": {
      const [first, ...rest] = args;
      if (first === "-m") {
        const [mod, ...more] = rest;
        if (mod === "pytest") return pytestArgsAllowed(more);
        if (mod === "unittest") return unittestArgsAllowed(more);
        return false;
      }
      return first !== undefined && isRelativeFile(first, [".py"]) && rest.length <= COMMAND_MAX_ARGS && rest.every(isScriptArg);
    }
    default:
      return false;
  }
}

/** コマンドの形が許可リストにあるか（汚染は見ない）。シェルの構文・許可されない文字・長すぎるものは false */
export function isAllowedCommandShape(command: unknown): boolean {
  // 文字の検査は前後を除く前に行う（String.prototype.trim は全角の空白・改行も除くが、作業場の /bin/sh -c には元の文字列が渡る）
  if (typeof command !== "string" || command.length > COMMAND_MAX_CHARS || !SAFE_COMMAND.test(command)) return false;
  const argv = command.split(" ").filter((w) => w !== "");
  return argv.length > 0 && isAllowedArgv(argv);
}

/**
 * run_command をどの操作として判定するか（SG-07。純粋関数）。
 * (a) 汚染のあと（tainted）なら形にかかわらず run_shell、(b) 形が許可リストになければ run_shell、それ以外は run_tests。
 * tainted は「外の内容を読んだか」（taint.ts の taintedByOutsideContent）。edge が判定の入力を作るときに呼ぶ
 */
export function operationOfCommand(command: unknown, tainted: boolean): "run_tests" | "run_shell" {
  if (tainted !== false) return "run_shell"; // 真偽でない値も厳しい側
  return isAllowedCommandShape(command) ? "run_tests" : "run_shell";
}

/**
 * Subject の run_command の操作。edge が決めた commandOperation（汚染を含む）と、Kernel が args.command の形から決めたものの厳しい方。
 * commandOperation が欠けていても形の検査は効く（edge が呼び忘れても、許可リストにない形は自動にならない）
 */
function commandOperationOf(subject: Partial<Pick<Subject, "args" | "commandOperation">>): "run_tests" | "run_shell" {
  if (subject.commandOperation !== undefined && subject.commandOperation !== "run_tests") return "run_shell";
  const args = subject.args;
  const command = args !== null && typeof args === "object" && !Array.isArray(args) ? args.command : undefined;
  return operationOfCommand(command, false);
}
