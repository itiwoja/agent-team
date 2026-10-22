// 入口の下準備：`/?text=…` で開かれたときの文と、例文の選び方（どちらも純関数）

/** 入力欄に入れる文の上限（入力欄の maxLength と同じ） */
export const PREFILL_MAX = 2000;

/** `?text=` の文を取り出す。無い・空白だけのときは null。長すぎるときは上限で切る */
export function readPrefill(search: string): string | null {
  const raw = new URLSearchParams(search).get("text");
  if (raw === null) return null;
  const t = raw.trim();
  if (t === "") return null;
  return t.length > PREFILL_MAX ? t.slice(0, PREFILL_MAX) : t;
}

/** 候補から重ならないように n 個を選ぶ（exclude に入っているものは外す）。候補が足りなければ有るだけ返す */
export function pickExamples(pool: readonly string[], n: number, exclude: readonly string[] = [], rand: () => number = Math.random): string[] {
  const rest = pool.filter((s) => !exclude.includes(s));
  // Fisher-Yates で混ぜてから先頭を取る
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = rest[i];
    const b = rest[j];
    if (a === undefined || b === undefined) continue;
    rest[i] = b;
    rest[j] = a;
  }
  return rest.slice(0, Math.max(0, n));
}
