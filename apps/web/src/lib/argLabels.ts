// 送る前の確認に出る引数名（unit_price など内部のキー）を、人が読める日本語に直す表示専用の変換。
// 値・intentHash・API に送る値は触らない（見た目のラベルだけ）。よく使われるキーと、Google カレンダー・GitHub のツール定義のキー

/** 末尾のキー（配列の添字を除いたあとの1段）→ 日本語 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  items: "品目",
  name: "名前",
  quantity: "数量",
  unit_price: "単価",
  amount: "金額",
  total: "金額",
  currency: "通貨",
  note: "備考",
  to: "宛先",
  body: "本文",
  subject: "件名",
  limit: "最大の件数",
  title: "題名",
  path: "ファイル",
  message: "メッセージ",
};

function labelOfKey(key: string): string {
  return Object.prototype.hasOwnProperty.call(KEY_LABELS, key) ? (KEY_LABELS[key] as string) : key;
}

/**
 * 引数のパス（例：title、items[].quantity、items[0].quantity）を日本語にする。
 * 添字つきは「品目1の数量」、添字なし（[]）は「品目の数量」。未知のキーは元のまま。
 */
export function argLabel(path: string): string {
  const parts = path.split(".");
  let out = "";
  for (const part of parts) {
    const m = /^([^[\]]+)((?:\[\d*\])*)$/.exec(part);
    if (!m) {
      out += part;
      continue;
    }
    const name = labelOfKey(m[1] as string);
    const idx = [...(m[2] ?? "").matchAll(/\[(\d*)\]/g)]
      .map((x) => (x[1] === "" ? "" : String(Number(x[1]) + 1)))
      .join("-");
    out += name + idx;
    if (part !== parts[parts.length - 1]) out += "の";
  }
  return out;
}
