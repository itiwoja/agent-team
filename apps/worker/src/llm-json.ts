// LLM の構造化出力の共通部分：Zod から JSON Schema を作る・構造化出力に渡す形にそろえる・応答のテキストを JSON として読む。
// 設定プランナー（asks/planner.ts）とスキルの学習（evolution/learn.ts）が使う。純粋な関数だけ（I/O・時刻・乱数なし）
// apps/app/src/llm-json.ts の WorkspaceDO 版（中身は同じ。runner の型は型だけ読む）

import { z } from "zod";
import type { Json, JsonObject } from "@open-team/kernel";
import type { AssistantPart } from "@open-team/runner";

/**
 * 入力側（既定値のある項目は省略可）の JSON Schema。`$schema` は外す
 * （Gemini の関数宣言・構造化出力に余計なキーを渡さないため）
 */
export function inputJsonSchema(schema: z.ZodType): JsonObject {
  const raw = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  return JSON.parse(JSON.stringify(rest)) as JsonObject;
}

/**
 * 構造化出力に渡す形にそろえる（意味は変えない）：`const: v` → `enum: [v]`、何も絞らない `propertyNames: {type: 'string'}` を外す。
 * 対応するキーワードの少ない実装でも識別子を落とさないため。検証は受け取ったあとに Zod でもう一度する
 */
export function structuredOutputSchema(schema: JsonObject): JsonObject {
  const SCHEMA_MAPS = new Set(["properties", "$defs", "patternProperties"]);
  const walk = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "propertyNames" && JSON.stringify(x) === '{"type":"string"}') continue;
      if (k === "const") out.enum = [x];
      else if (k === "default" || k === "enum") out[k] = x;
      // 引数の名前の表はキーをそのまま残し、値（スキーマ）だけを見る
      else if (SCHEMA_MAPS.has(k) && x !== null && typeof x === "object" && !Array.isArray(x)) {
        out[k] = Object.fromEntries(Object.entries(x).map(([name, sub]) => [name, walk(sub)]));
      } else out[k] = walk(x);
    }
    return out;
  };
  return walk(schema) as JsonObject;
}

/** `maxItems` を外す（構造化出力の実装が配列の上限で応答を切らないように。上限は受け取ったあとの Zod で確かめる） */
export function withoutMaxItems<T>(v: T): T {
  if (Array.isArray(v)) return v.map(withoutMaxItems) as T;
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "maxItems").map(([k, x]) => [k, withoutMaxItems(x)])) as T;
}

export type ParsedJson = { ok: true; value: unknown } | { ok: false; reason: string };

/** 応答のテキストを JSON として読む（構造化出力は素の JSON。念のためコードフェンスは外す）。ツール呼び出しは無視する */
export function parseModelJson(parts: readonly AssistantPart[]): ParsedJson {
  const text = parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("")
    .trim();
  if (text === "") return { ok: false, reason: "応答にテキストがない" };
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return { ok: true, value: JSON.parse(unfenced) as unknown };
  } catch {
    return { ok: false, reason: "応答が JSON として読めない" };
  }
}
