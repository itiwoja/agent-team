// @open-team/db/sim：sim スキーマの問い合わせ（M-40。sim.executions・events・snapshots）。
// apps/sim-world の PostgresSimStore（ot_sim のロール）だけが使う。どの関数も workspace_id で絞る（scope.ts の注記）
export { simMissingReferenceOf, type SimReference, type SimScope } from "./scope.ts";
export {
  ensureSimDemoStore,
  forkSimExecution,
  getSimExecution,
  getSimExecutionWithEvents,
  insertSimExecution,
  lockSimExecution,
  updateSimExecutionState,
  type ForkSimExecutionResult,
  type NewSimExecution,
  type SimExecutionKey,
} from "./executions.ts";
export { SimEventSeqError, appendSimEvents, assertSimEventSeqs, copySimEvents, lastSimEventSeq, listSimEvents } from "./events.ts";
export { getSimSnapshot, insertSimSnapshot, type NewSimSnapshot } from "./snapshots.ts";
export { deleteSimWorkspaceRows, type SimDeleteCounts } from "./cleanup.ts";
export type { SimEventRow, SimExecutionRow, SimSnapshotRow, SimWorld } from "../types.ts";
