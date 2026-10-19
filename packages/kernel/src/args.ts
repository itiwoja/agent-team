// 引数のパス・値の取り出し・比較用の正規化・判定に使う役割（KD §3.3-6・3.3-7、MT §3.3・3.4）
// パスは 'name'（最上位）か 'name[].field'（配列の要素の1段）の2つの形だけ（KD §8-14、MT D-06）
// 比べるときは欠け≡null（M-10）、配列は多重集合（並べ替えるが重複は残す。M-09）

import { canonicalJson } from "./canonical.ts";
import type { ArgPath, ArgRole, ArgRoleMap, Json, JsonObject } from "./types.ts";

export type ParsedArgPath = { kind: "scalar"; name: string } | { kind: "each"; name: string; field: string };

/** パスの1区切り。'.'・'['・']' を含まない1文字以上 */
const SEGMENT = /^[^.[\]]+$/;

/** 'name' → scalar、'name[].field' → each。ほかの形（'a.b'・'a[].b[].c'・'a[]'・''）は null（定義の検証で弾く） */
export function parseArgPath(path: ArgPath): ParsedArgPath | null {
  const i = path.indexOf("[].");
  if (i < 0) return SEGMENT.test(path) ? { kind: "scalar", name: path } : null;
  const name = path.slice(0, i);
  const field = path.slice(i + 3);
  return SEGMENT.test(name) && SEGMENT.test(field) ? { kind: "each", name, field } : null;
}

export type ArgPathRead =
  | { shape: "scalar"; found: boolean; value: Json | undefined }
  | {
      shape: "each";
      /** 容れ物が配列のときだけ true */
      containerFound: boolean;
      elements: Array<{ index: number; found: boolean; value: Json | undefined }>;
    };

function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 自分のプロパティだけを読む（'constructor'・'__proto__' などの継承した値を拾わない）。値が undefined は無いのと同じ */
function ownValue(obj: unknown, key: string): Json | undefined {
  if (!isPlainObject(obj) || !Object.hasOwn(obj, key)) return undefined;
  return obj[key];
}

/**
 * 引数のパスを読む（KD §3.3-6）。
 * - 'name'：最上位のプロパティ
 * - 'name[].field'：args[name] が配列なら要素ごと（要素がオブジェクトで field を持てば found）。配列でなければ containerFound: false
 * - 形の外れたパスは、その文字列を最上位のキーの名前として読む（定義の検証で弾く前提。厳しい側に倒れる）
 */
export function readArgPath(args: JsonObject, path: ArgPath): ArgPathRead {
  const p = parseArgPath(path);
  if (p === null || p.kind === "scalar") {
    const value = ownValue(args, path);
    return { shape: "scalar", found: value !== undefined, value };
  }
  const container = ownValue(args, p.name);
  if (!Array.isArray(container)) return { shape: "each", containerFound: false, elements: [] };
  const elements: Array<{ index: number; found: boolean; value: Json | undefined }> = [];
  for (let index = 0; index < container.length; index++) {
    const value = ownValue(container[index], p.field);
    elements.push({ index, found: value !== undefined, value });
  }
  return { shape: "each", containerFound: true, elements };
}

/**
 * 比較・ハッシュに使う値（MT §3.4 の extractArg。欠け≡null：M-10）。
 * 'name[].field' は要素ごとの値の配列（欠けた要素は null）。容れ物が配列でなければ null
 */
export function extractArg(args: JsonObject, path: ArgPath): Json {
  const r = readArgPath(args, path);
  if (r.shape === "scalar") return r.value ?? null;
  if (!r.containerFound) return null;
  return r.elements.map((e) => e.value ?? null);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 比較用の正規化（KD §3.3-7・MT §3.4。mcp-and-web.md:120）。
 * 欠け（undefined）→ null（M-10）、文字列 → trim（大文字小文字・Unicode の正規化はしない）、
 * 配列 → 要素を正規化して canonicalJson の順に並べる（重複は残す＝多重集合。M-09）、オブジェクト → 値を再帰で正規化
 */
export function normalizeForMatch(value: Json | undefined): Json {
  if (value === undefined) return null;
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        const n = normalizeForMatch(v);
        return { n, key: canonicalJson(n) };
      })
      .sort((a, b) => compareText(a.key, b.key))
      .map((e) => e.n);
  }
  if (typeof value === "object" && value !== null) {
    // Object.fromEntries は '__proto__' も自分のプロパティとして作る
    return Object.fromEntries(
      Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .map((k) => [k, normalizeForMatch(value[k])]),
    );
  }
  return value;
}

/** 正規化したうえで等しいか（MT §3.4 の matchEquals）。glob・正規表現・'@me' のような別名は使わない */
export function valuesEqualForMatch(a: Json | undefined, b: Json | undefined): boolean {
  return canonicalJson(normalizeForMatch(a)) === canonicalJson(normalizeForMatch(b));
}

/** 引数の役割（mcp-and-web.md:61-65、MT §2.3） */
export const ARG_ROLES = ["destination", "content", "option"] as const satisfies readonly ArgRole[];

function isArgRole(v: unknown): v is ArgRole {
  return v === "destination" || v === "content" || v === "option";
}

/**
 * パスの役割の読み方（判定・ハッシュ・ルール・[以後も許可] で共通）。argRoles に無い・値が undefined なら undefined（役割なし。
 * 正規形 JSON でも undefined のキーは無いのと同じ）。content・option 以外の値（知らない文字列・null）は destination と読む（BR-56：未確定は destination）。
 * 役割の表が壊れていても「destination にも option にも数えず、余計な引数（M-12）にもならない＝比べない引数」を作らない
 */
export function argRoleAt(roles: ArgRoleMap, path: ArgPath): ArgRole | undefined {
  const r: unknown = Object.hasOwn(roles, path) ? roles[path] : undefined;
  if (r === undefined) return undefined;
  return r === "content" || r === "option" ? r : "destination";
}

/** 役割が role のパス（辞書順）。役割は argRoleAt で読む（content・option 以外は destination） */
export function argPathsByRole(roles: ArgRoleMap, role: ArgRole): ArgPath[] {
  return Object.keys(roles)
    .filter((p) => argRoleAt(roles, p) === role)
    .sort(compareText);
}

function schemaProperties(schema: unknown): JsonObject {
  if (!isPlainObject(schema)) return {};
  const props = ownValue(schema, "properties");
  return isPlainObject(props) ? props : {};
}

/** 要素がオブジェクトの配列（type: array・items.type: object）なら要素の properties。そうでなければ null */
function elementProperties(propSchema: Json | undefined): JsonObject | null {
  if (!isPlainObject(propSchema) || ownValue(propSchema, "type") !== "array") return null;
  const items = ownValue(propSchema, "items");
  if (!isPlainObject(items) || ownValue(items, "type") !== "object") return null;
  return schemaProperties(items);
}

/** 要素がオブジェクトの配列なら要素のフィールド名。そうでなければ null（形の外れた名前があっても null） */
function elementFields(propSchema: Json | undefined): string[] | null {
  const props = elementProperties(propSchema);
  if (props === null) return null;
  const fields = Object.keys(props);
  return fields.length > 0 && fields.every((f) => SEGMENT.test(f)) ? fields : null;
}

/**
 * 引数の名前からの役割の提案（MT §3.3、mcp-and-web.md:63-65）。最上位のプロパティ名の完全一致だけ（大文字小文字は区別）。
 * 提案は owner が確定するまで判定に効かない（未確定は destination：mcp-and-web.md:69）
 */
export const ROLE_SUGGESTIONS = {
  destination: ["channel", "to", "cc", "bcc", "recipient", "email", "url", "share_with", "calendar_id", "path"],
  content: ["text", "body", "message", "subject", "title", "description"],
  option: ["unfurl_links", "reply_broadcast", "visibility", "send_at"],
} as const satisfies Readonly<Record<ArgRole, readonly string[]>>;

/** 入力スキーマの最上位のプロパティのうち ROLE_SUGGESTIONS にある名前の役割（MT §3.3 suggestArgRoles）。ない名前は提案しない */
export function suggestArgRoles(inputSchema: Json): Partial<Record<ArgPath, ArgRole>> {
  const out: Partial<Record<ArgPath, ArgRole>> = {};
  for (const p of Object.keys(schemaProperties(inputSchema)).sort(compareText)) {
    const role = ARG_ROLES.find((r) => (ROLE_SUGGESTIONS[r] as readonly string[]).includes(p));
    if (role !== undefined) out[p] = role;
  }
  return out;
}

/** 分類の提案（MT §3.3）：annotations.readOnlyHint === true のときだけ 'read'。分類は unclassified のまま（ADR-022:10。annotations は信用しない） */
export function suggestClassification(annotations: Json | null): "read" | null {
  return isPlainObject(annotations) && ownValue(annotations, "readOnlyHint") === true ? "read" : null;
}

export type ArgRoleKeyErrorReason = "unknown_property" | "not_array_of_objects" | "both_whole_and_element" | "bad_role";
export interface ArgRoleKeyError {
  path: string;
  reason: ArgRoleKeyErrorReason;
}
export type ArgRoleKeyValidation = { ok: true } | { ok: false; errors: ArgRoleKeyError[] };

/**
 * 確定する役割のキーの検査（MT §3.3 validateArgRoleKeys。API-071 の 400 VALIDATION_ERROR と manifest の検査）：
 * 1 キーは 'p'（inputSchema.properties の最上位）か 'p[].f'（p が要素オブジェクトの配列で f ∈ items.properties）だけ。
 *   p がない・f がない・形の外れたパス → unknown_property、p が要素オブジェクトの配列でない → not_array_of_objects
 * 2 同じ p に 'p' と 'p[].*' の両方 → both_whole_and_element（p に1つ）
 * 3 役割が destination・content・option でない → bad_role
 * すべての誤りを返す：キーの昇順（同じキーはパス → 役割の順）、そのあと both_whole_and_element を p の昇順
 */
export function validateArgRoleKeys(inputSchema: Json, roles: ArgRoleMap): ArgRoleKeyValidation {
  const props = schemaProperties(inputSchema);
  const errors: ArgRoleKeyError[] = [];
  const wholes = new Set<string>();
  const elementOf = new Set<string>();
  for (const key of Object.keys(roles).sort(compareText)) {
    const parsed = parseArgPath(key);
    if (parsed === null || !Object.hasOwn(props, parsed.name)) {
      errors.push({ path: key, reason: "unknown_property" });
    } else if (parsed.kind === "scalar") {
      wholes.add(parsed.name);
    } else {
      const elementProps = elementProperties(props[parsed.name]);
      if (elementProps === null) errors.push({ path: key, reason: "not_array_of_objects" });
      else if (!Object.hasOwn(elementProps, parsed.field)) errors.push({ path: key, reason: "unknown_property" });
      else elementOf.add(parsed.name);
    }
    if (!isArgRole(roles[key])) errors.push({ path: key, reason: "bad_role" });
  }
  for (const p of [...wholes].filter((x) => elementOf.has(x)).sort(compareText)) {
    errors.push({ path: p, reason: "both_whole_and_element" });
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * 判定に使う役割（MT §3.3。ToolInfo.argRoles に入れる）。入力スキーマの最上位のプロパティごとに：
 * a. 確定の役割があればそれ
 * b. 要素がオブジェクトの配列で、確定に 'p[].f' があれば要素のフィールドごと（未確定は destination）。
 *    どれか1つでも destination なら p 全体を destination（A-84）
 * c. それ以外は destination（未確定・スキーマの変更で増えた引数。BR-56）
 * 'p' と 'p[].f' の両方が確定にある（validateArgRoleKeys の both_whole_and_element）ときも厳しい側の destination にする
 */
export function effectiveArgRoles(inputSchema: Json, confirmed: ArgRoleMap): ArgRoleMap {
  // 組みを集めて Object.fromEntries で作る（'__proto__' という名前のプロパティを代入すると prototype の setter に吸われ、役割が消える）
  const out: Array<[ArgPath, ArgRole]> = [];
  const props = schemaProperties(inputSchema);
  const confirmedKeys = Object.keys(confirmed);
  for (const p of Object.keys(props).sort(compareText)) {
    const whole = Object.hasOwn(confirmed, p) ? confirmed[p] : undefined;
    const hasElementKeys = confirmedKeys.some((k) => k.startsWith(`${p}[].`));
    if (whole !== undefined && !hasElementKeys) {
      out.push([p, isArgRole(whole) ? whole : "destination"]);
      continue;
    }
    if (whole === undefined && hasElementKeys) {
      const fields = elementFields(props[p]);
      if (fields !== null) {
        const roles = fields.map((f): [ArgPath, ArgRole] => {
          const key = `${p}[].${f}`;
          const r = Object.hasOwn(confirmed, key) ? confirmed[key] : undefined;
          return [key, isArgRole(r) ? r : "destination"];
        });
        if (roles.every(([, r]) => r !== "destination")) {
          out.push(...roles);
          continue;
        }
      }
    }
    out.push([p, "destination"]);
  }
  return Object.fromEntries(out);
}
