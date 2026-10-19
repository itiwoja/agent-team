import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LlmError } from "./types.ts";

interface Ledger { version: 1; limitMicroUsd: number; chargedMicroUsd: number }
/** Fail closed on contention, stale locks or corrupt state. Never auto-reset a trial. */
export class TrialLedger {
  private readonly path: string;
  private readonly limit: number;
  constructor(path: string, limit: number) {
    this.limit = limit;
    this.path = resolve(path);
    this.update(0, false);
  }
  private read(): Ledger {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, "utf8")); }
    catch (e) { throw e; } // Missing is not zero: never recreate a lost trial ledger.
    const s = raw as Ledger;
    if (!s || s.version !== 1 || s.limitMicroUsd !== this.limit || !Number.isSafeInteger(s.chargedMicroUsd) || s.chargedMicroUsd < 0) throw new Error("invalid ledger");
    return s;
  }
  remaining(): number {
    try { return this.limit - this.read().chargedMicroUsd; }
    catch { throw new LlmError("試験予算台帳が不正です。送信を停止しました", null, false); }
  }
  update(delta: number, checkLimit = true): void {
    const lock = `${this.path}.lock`;
    let held = false;
    try {
      mkdirSync(lock); held = true;
      const state = this.read();
      const next = state.chargedMicroUsd + delta;
      if (!Number.isSafeInteger(next) || next < 0 || (checkLimit && next > this.limit)) throw new Error("budget");
      writeFileSync(`${this.path}.next`, JSON.stringify({ ...state, chargedMicroUsd: next }) + "\n", { mode: 0o600 });
      renameSync(`${this.path}.next`, this.path);
    } catch { throw new LlmError("試験予算台帳の上限・競合・状態を確認してください。送信を停止しました", null, false); }
    finally { if (held) rmdirSync(lock); }
  }
}
