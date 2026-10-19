// @open-team/measure：引っかかり率の計測（D-54。sim-world-rehearsal.md §4.9、cross-check.md G-11）
// 統制なしの EdgePort（measureEdge）で、用意した編成（受信箱係 → 仕入れ係）を本番と同じプロンプトで走らせ、オラクルと損害を数える
export * from "./scenarios.ts";
export * from "./context.ts";
export * from "./edge.ts";
export * from "./run.ts";
export * from "./measure.ts";
export * from "./report.ts";
export * from "./scripted.ts";
export { MEASURE_USAGE, fileStamp, parseMeasureArgs, runMeasureCli, type MeasureCliDeps, type MeasureCliOptions } from "./cli.ts";
