// @open-team/oracles：リハーサルと計測の合否（オラクル O-01〜O-08。sim-world-rehearsal.md §4.3）
// 純粋関数だけ（LLM・I/O・時刻・乱数を使わない）。損害の式は sim-core、判定は kernel、合否はここ（ADR-033）
export * from "./input.ts";
export * from "./oracles.ts";
