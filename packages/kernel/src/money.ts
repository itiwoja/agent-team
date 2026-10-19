// 金額は整数のマイクロドルで比べる（KD §8-12、cross-check §1.7）。浮動小数のままだと 0.1 + 0.2 > 0.3 が真になり、境界ちょうどで止まる
// API の金額は小数点以下6桁の文字列（09_api/common.md:47。例 "1.120000"）

const MICRO = 1_000_000;

/** USD → 整数のマイクロドル（Math.round(usd * 1e6)）。有限でない値は例外（判定できないなら許可しない：NFR-005） */
export function toMicroUsd(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd)) throw new TypeError("toMicroUsd: 有限の数値だけ扱える");
  const micro = Math.round(usd * MICRO);
  return micro === 0 ? 0 : micro; // -0 を 0 にそろえる
}

/** 整数のマイクロドル → USD */
export function fromMicroUsd(micro: number): number {
  if (typeof micro !== "number" || !Number.isFinite(micro)) throw new TypeError("fromMicroUsd: 有限の数値だけ扱える");
  return micro / MICRO;
}

/** USD → 小数点以下6桁の文字列（'0.012345'・'1.120000'）。マイクロドルの整数から組み立てるので toFixed の誤差が出ない */
export function formatUsd(usd: number): string {
  const micro = toMicroUsd(usd);
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / MICRO);
  const frac = abs - whole * MICRO;
  return `${micro < 0 ? "-" : ""}${whole}.${String(frac).padStart(6, "0")}`;
}
