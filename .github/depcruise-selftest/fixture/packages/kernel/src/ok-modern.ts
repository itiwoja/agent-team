import { sha } from "./ok-crypto.ts";
// 新しい構文（数値の区切り・クラスのフィールド・#private・??=・satisfies・トップレベルの await）でも依存を読めること
export const LIMIT = 1_000_000 as const;
export class Counter {
  #n = 0;
  static readonly step: number = 1;
  next(): number {
    this.#n += Counter.step;
    return this.#n;
  }
}
let cached: string | undefined;
cached ??= sha("x");
export const config = { cached } satisfies { cached: string | undefined };
export const ready = await Promise.resolve(LIMIT);
