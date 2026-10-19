// モジュールの定数（テンプレート・ツールの宣言）を凍らせる。タスクの間で値を書き換えて混ぜないため（BD-05）
// index.ts からは出さない（runner の中だけで使う）

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
