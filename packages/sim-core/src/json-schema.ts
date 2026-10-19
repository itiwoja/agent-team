// Zod から JSON Schema を作る（MCP の inputSchema・Gemini の構造化出力。SW §3.3・§3.4）

import { z } from "zod";
import type { Json, JsonObject } from "@open-team/kernel";

/**
 * 入力側（既定値のある項目は省略可）の JSON Schema。`$schema` は外す
 * （MCP のツール定義と Gemini の関数宣言・構造化出力に余計なキーを渡さないため。tool_hash は外したあとの形で決まる）
 */
export function inputJsonSchema(schema: z.ZodType): JsonObject {
  const raw = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = raw;
  return JSON.parse(JSON.stringify(rest)) as JsonObject;
}

/**
 * 構造化出力に渡す形にそろえる（意味は変えない）：`const: v` → `enum: [v]`、何も絞らない `propertyNames: {type: 'string'}` を外す。
 * 対応するキーワードの少ない実装でも識別子（障害の id）を落とさないため。検証は受け取ったあとに Zod でもう一度する
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
