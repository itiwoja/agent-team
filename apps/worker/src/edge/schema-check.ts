// MCP の引数を入力スキーマで確かめる（packages/edge/src/schema-check.ts の写し。M-12、KD §8-17：スキーマにない最上位のキーがある呼び出しは Intent にせずツールのエラーで返す）。
// 1. 最上位のキーが inputSchema.properties にあるか（properties がなければ、どのキーもない扱い＝厳しい側）
// 2. JSON のバイト数（64KB。IA §3.5-2）
// 3. zod の fromJSONSchema で中身も確かめる。
//    スキーマを変換できなければ 3 は飛ばす（1・2 は必ず効く）

import { z } from "zod";
import { canonicalJson, type JsonObject } from "@open-team/kernel";
import { EDGE_LIMITS } from "./limits.ts";
import { isPlainObject, jsonBytes } from "./util.ts";

export type ArgsCheck = { ok: true } | { ok: false; issues: string[] };

const ISSUES_MAX = 10;
const CACHE_MAX = 200;
/** 変換したスキーマ（正規形 JSON → zod。変換できなかったものは null） */
const schemaCache = new Map<string, z.ZodType | null>();

function compiled(inputSchema: unknown): z.ZodType | null {
  let key: string;
  try {
    key = canonicalJson(inputSchema);
  } catch {
    return null;
  }
  if (schemaCache.has(key)) return schemaCache.get(key) ?? null;
  let schema: z.ZodType | null = null;
  try {
    schema = z.fromJSONSchema(inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    schema = null;
  }
  if (schemaCache.size >= CACHE_MAX) {
    const first = schemaCache.keys().next();
    if (!first.done) schemaCache.delete(first.value);
  }
  schemaCache.set(key, schema);
  return schema;
}

function pathText(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? "(引数)" : path.map((p) => (typeof p === "number" ? `[${p}]` : String(p))).join(".").replace(/\.\[/g, "[");
}

/** MCP のツールの引数を確かめる（M-12） */
export function checkToolArguments(inputSchema: unknown, args: JsonObject, maxBytes: number = EDGE_LIMITS.mcpArgsMaxBytes): ArgsCheck {
  const issues: string[] = [];
  const props = isPlainObject(inputSchema) && isPlainObject(inputSchema.properties) ? inputSchema.properties : {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(props, key)) issues.push(`スキーマにない引数：${key}`);
  }
  if (jsonBytes(args) > maxBytes) issues.push(`引数が大きすぎます（${maxBytes} バイトまで）`);
  if (issues.length > 0) return { ok: false, issues: issues.slice(0, ISSUES_MAX) };
  const schema = compiled(inputSchema);
  if (schema === null) return { ok: true };
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true };
  return { ok: false, issues: parsed.error.issues.slice(0, ISSUES_MAX).map((i) => `${pathText(i.path)}：${i.message}`) };
}

/** エージェントに返すツールのエラーの文（決まった形。外から来た文字列は入れない：ツールの名前は safe な文字だけ） */
export function argsErrorText(tool: string, issues: readonly string[]): string {
  const name = tool.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 128);
  return `ツールの引数が入力スキーマに合いません（${name}）：${issues.join(" / ")}`;
}
