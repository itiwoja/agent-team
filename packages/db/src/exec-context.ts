// 実行の文脈（DB §4.6・§10、M-17）。本番とリハーサルを混ぜない：unknownOutcomeKeys（BR-68）・承認待ちの置き換え（BR-60）・
// 初めての宛先（BR-70）・回帰の試験（BR-80）は、本番どうし（rehearsal_run_id IS NULL）か、同じ sim の走行どうしで絞る

import type { TaskRow, Uuid } from "./types.ts";

export type ExecContext = { kind: "live" } | { kind: "rehearsal"; simExecutionId: Uuid };

export class ExecContextError extends Error {
  constructor(taskId: Uuid) {
    super(`リハーサルのタスクに sim の走行がない：${taskId}（デモ店舗に落とさない）`);
    this.name = "ExecContextError";
  }
}

/** タスクの行から文脈を作る。リハーサルのタスクで sim_execution_id がなければ例外（本番の文脈に倒さない） */
export function execContextOf(t: Pick<TaskRow, "id" | "rehearsal_run_id" | "sim_execution_id">): ExecContext {
  if (t.rehearsal_run_id === null) return { kind: "live" };
  if (t.sim_execution_id === null) throw new ExecContextError(t.id);
  return { kind: "rehearsal", simExecutionId: t.sim_execution_id };
}

/**
 * 文脈の条件の SQL 片（tasks の別名 alias に対して）。params の次の番号 nextParam から使う。
 * 例：const c = execContextSql(ec, "t", 3); `... AND ${c.sql}`、params は [...base, ...c.params]
 */
export function execContextSql(ec: ExecContext, alias: string, nextParam: number): { sql: string; params: unknown[] } {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`別名の形が違う：${alias}`);
  if (ec.kind === "live") return { sql: `${alias}.rehearsal_run_id IS NULL`, params: [] };
  return { sql: `${alias}.sim_execution_id = $${nextParam}`, params: [ec.simExecutionId] };
}
