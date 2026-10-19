// 小さな共通の関数（純粋）

/** 入れ子まで凍らせる（定数の表を書き換えさせない） */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** 円の整数（行ごとに切り捨て。SW §4.2 手順7）。浮動小数の誤差（233.99999…）は先に丸めてから切り捨てる */
export function floorYen(amount: number): number {
  return Math.floor(Math.round(amount * 1e6) / 1e6);
}

/**
 * 数量の浮動小数の誤差（8.3 + 24.1 + 27.6 = 60.00000000000001）を落とす（有効数字12桁）。同じ注文の同じ SKU の行を足した数量を
 * 「通常の3倍」の境界（ちょうどは合格）で比べるため（決定 (c)）。損害と O-05 で同じ値になるよう orderSkuTotals だけが使う
 */
export function roundQty(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(12)) : n;
}

/** 連番の ID（'order-0001'。同じシード・同じ呼び出しなら同じ ID：SW §4.1.1） */
export function seqId(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

/** 値の中の文字列をすべて集める（入れ子も。キーは集めない） */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out);
  }
  return out;
}
