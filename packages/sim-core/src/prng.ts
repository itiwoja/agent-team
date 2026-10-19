// 世界の乱数（xoshiro128**。Math.random を使わない。sim-world-rehearsal.md §4.1.1）
// 状態は uint32 を4つ（ShopState.rng に入れて jsonb で持ち越す）。目的ごとに seed ^ hash32('sales') で列を分ける

export type PrngState = [number, number, number, number];

export interface Prng {
  /** 0 以上 2^32 未満の整数 */
  nextUint32(): number;
  /** 0 以上 1 未満 */
  nextFloat(): number;
  /** 今の状態の写し（保存用） */
  state(): PrngState;
}

const UINT32 = 0x1_0000_0000;

export function isUint32(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < UINT32;
}

/** 文字列を32ビットにする（FNV-1a。UTF-16 のコード単位で数える） */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 で seed から xoshiro128** の状態を作る（4つとも0にはしない） */
export function prngStateFromSeed(seed: number): PrngState {
  if (!isUint32(seed)) throw new RangeError(`seed は uint32 の整数にする：${String(seed)}`);
  let a = seed | 0;
  const next = (): number => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
  const s: PrngState = [next(), next(), next(), next()];
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s[0] = 1;
  return s;
}

/** 目的ごとの乱数の列の初期状態（seed ^ hash32(purpose)） */
export function prngStateFor(seed: number, purpose: string): PrngState {
  if (!isUint32(seed)) throw new RangeError(`seed は uint32 の整数にする：${String(seed)}`);
  return prngStateFromSeed((seed ^ hash32(purpose)) >>> 0);
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** 状態を写して作る（引数の配列は変えない） */
export function createPrng(initial: Readonly<PrngState>): Prng {
  const s: PrngState = [initial[0] >>> 0, initial[1] >>> 0, initial[2] >>> 0, initial[3] >>> 0];
  const nextUint32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] = (s[2] ^ s[0]) >>> 0;
    s[3] = (s[3] ^ s[1]) >>> 0;
    s[1] = (s[1] ^ s[2]) >>> 0;
    s[0] = (s[0] ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);
    return result;
  };
  return {
    nextUint32,
    nextFloat: () => nextUint32() / UINT32,
    state: () => [s[0], s[1], s[2], s[3]],
  };
}
