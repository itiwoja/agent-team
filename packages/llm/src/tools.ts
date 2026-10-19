// mcp_call の展開と戻し（llm/types.ts の LlmRequest.mcpTools、formation-runtime.md §2.5・§3.10-9）
// LLM には付与された MCP のツールを1つずつ関数 mcp__<connector>__<tool> として見せ（入力スキーマはそのまま）、
// 応答の関数呼び出しは mcp_call の形（{ connector, tool, arguments }）に戻す。
// 表にない名前はそのまま返し、edge が unknown_action / not_granted で拒否する（BR-09）。名前から connector・tool を推し量らない。
// ただしモデルが宣言していない mcp_call を直に呼んだときはカタログのツールなので、edge はその引数のまま通常どおり判定する（判定は外れない）

import { createHash } from "node:crypto";
import type { FunctionDeclaration } from "@google/genai";
import type { McpToolSpec, ToolSpec } from "@open-team/runner";

export const MCP_FUNCTION_PREFIX = "mcp__";
/** 関数名の長さの上限。Gemini の上限（SDK の説明は128）より短くして、どの版でも通るようにする */
const FUNCTION_NAME_MAX = 64;
/** 英字か _ で始まり、英数字・_・- だけ（Gemini は . : も許すが使わない） */
const SAFE_FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface McpToolRef {
  connector: string;
  tool: string;
}

/** 1回の呼び出しの中の「関数名 ⇔ MCP のツール」の表。宣言・応答の戻し・履歴の展開で同じものを使う */
export interface McpFunctionTable {
  readonly byName: ReadonlyMap<string, McpToolRef>;
  /** toolKey(connector, tool) → 関数名 */
  readonly byTool: ReadonlyMap<string, string>;
}

export const EMPTY_MCP_FUNCTION_TABLE: McpFunctionTable = { byName: new Map(), byTool: new Map() };

export interface ToolDeclarations {
  declarations: FunctionDeclaration[];
  table: McpFunctionTable;
}

const toolKey = (connector: string, tool: string): string => `${connector}\u0000${tool}`;

/**
 * mcp__<connector>__<tool>。使えない文字を含む・長すぎるときは、文字を _ に替えて切り詰め、connector・tool の短いハッシュを付ける。
 * 戻しは表で引く（名前を __ で割って復元しない。connector に __ を含んでも取り違えない）
 */
export function mcpFunctionName(connector: string, tool: string): string {
  const raw = `${MCP_FUNCTION_PREFIX}${connector}__${tool}`;
  if (SAFE_FUNCTION_NAME.test(raw) && raw.length <= FUNCTION_NAME_MAX) return raw;
  return hashedFunctionName(connector, tool);
}

function hashedFunctionName(connector: string, tool: string): string {
  const safe = `${MCP_FUNCTION_PREFIX}${connector}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const hash = createHash("sha256").update(toolKey(connector, tool), "utf8").digest("hex").slice(0, 8);
  return `${safe.slice(0, FUNCTION_NAME_MAX - hash.length - 1)}_${hash}`;
}

/** 名前がほかと重なったら、ハッシュつき → 番号つきの順で空いている名前にする（宣言の順で決まる） */
function uniqueFunctionName(connector: string, tool: string, used: ReadonlySet<string>): string {
  const base = mcpFunctionName(connector, tool);
  if (!used.has(base)) return base;
  const hashed = hashedFunctionName(connector, tool);
  if (!used.has(hashed)) return hashed;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const candidate = `${hashed.slice(0, FUNCTION_NAME_MAX - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Gemini に渡す関数の宣言。カタログのツールはそのまま、mcp_call は宣言せずに mcpTools を1つずつ展開する。
 * tools に mcp_call がなければ mcpTools は無視する（llm/types.ts）。同じ名前・同じツールは1つにする（重なると Gemini が 400 を返す）
 */
export function buildToolDeclarations(tools: readonly ToolSpec[], mcpTools: readonly McpToolSpec[]): ToolDeclarations {
  const declarations: FunctionDeclaration[] = [];
  const used = new Set<string>();
  let expandMcp = false;
  for (const t of tools) {
    if (t.name === "mcp_call") {
      expandMcp = true;
      continue;
    }
    if (used.has(t.name)) continue;
    used.add(t.name);
    declarations.push(declaration(t.name, t.description, t.inputSchema));
  }
  const byName = new Map<string, McpToolRef>();
  const byTool = new Map<string, string>();
  if (expandMcp) {
    for (const t of mcpTools) {
      const key = toolKey(t.connector, t.tool);
      if (byTool.has(key)) continue;
      const name = uniqueFunctionName(t.connector, t.tool, used);
      used.add(name);
      byName.set(name, { connector: t.connector, tool: t.tool });
      byTool.set(key, name);
      declarations.push(declaration(name, t.description, t.inputSchema));
    }
  }
  return { declarations, table: { byName, byTool } };
}

/** 入力スキーマは手を加えずに parametersJsonSchema へ（JSON Schema のまま。引数のないツールは省く） */
function declaration(name: string, description: string, inputSchema: unknown): FunctionDeclaration {
  return inputSchema === undefined || inputSchema === null
    ? { name, description }
    : { name, description, parametersJsonSchema: inputSchema };
}

/** 応答の関数呼び出しを runner の形に戻す。表にある名前だけ mcp_call にし、ほか（カタログ・知らない名前）はそのまま */
export function fromGeminiFunctionCall(
  name: string,
  args: Record<string, unknown>,
  table: McpFunctionTable,
): { name: string; arguments: unknown } {
  const ref = table.byName.get(name);
  if (ref === undefined) return { name, arguments: args };
  return { name: "mcp_call", arguments: { connector: ref.connector, tool: ref.tool, arguments: args } };
}

/**
 * 履歴の呼び出しを Gemini の関数呼び出しにする。mcp_call は展開した名前に戻す（モデルが出したときと同じ名前）。
 * 今回の表にない MCP のツール（付与が外れた等）も mcpFunctionName の名前で見せる。args は JSON のオブジェクトでなければ {}
 */
export function toGeminiFunctionCall(
  call: { name: string; arguments: unknown },
  table: McpFunctionTable,
): { name: string; args: Record<string, unknown> } {
  if (call.name === "mcp_call" && isPlainObject(call.arguments)) {
    const { connector, tool, arguments: inner } = call.arguments;
    if (typeof connector === "string" && typeof tool === "string") {
      return {
        name: table.byTool.get(toolKey(connector, tool)) ?? mcpFunctionName(connector, tool),
        args: isPlainObject(inner) ? inner : {},
      };
    }
  }
  return { name: call.name, args: isPlainObject(call.arguments) ? call.arguments : {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
