// sim の問い合わせの共通（M-40、README §1）。どの問い合わせも workspace_id で絞り、別のワークスペースの行は「ない」と同じに扱う（15:517）。
// sim-world（ot_sim）は public.workspaces を読めないので、文脈は確かめた呼び出し元（MCP は sa-gateway の X-OT-Workspace-Id、
// 管理 API は sa-app の本文）が DB の行から決めて渡した workspace_id をそのまま使う（15:486）【決定：sim-persistence】

import { PG_ERROR, pgErrorInfo } from "../client.ts";
import type { WsCtx } from "../workspace.ts";

/** sim の問い合わせの文脈（WsCtx もそのまま渡せる） */
export type SimScope = Pick<WsCtx, "workspaceId">;

/** 足すときに参照先がない（外部キーの違反）もの */
export type SimReference = "workspace" | "rehearsal_run" | "execution" | "snapshot";

// 外部キーの名前 → 参照先（0004_sim.sql。名前のないものは PostgreSQL が付けた <表>_<列>_fkey）
const MISSING_BY_CONSTRAINT: Readonly<Record<string, SimReference>> = {
  executions_workspace_id_fkey: "workspace",
  events_workspace_id_fkey: "workspace",
  snapshots_workspace_id_fkey: "workspace",
  sim_executions_rehearsal_run_fk: "rehearsal_run",
  sim_executions_parent_fk: "execution",
  sim_events_execution_fk: "execution",
  sim_snapshots_execution_fk: "execution",
  sim_executions_snapshot_fk: "snapshot",
};

/**
 * 行を足す文の外部キーの違反なら、ない参照先（呼び出し側が 404 にする）。違えば null。
 * 消す文の違反（試験が参照しているスナップショット：rehearsal_cases_sim_snapshot_fk）には使わない
 */
export function simMissingReferenceOf(e: unknown): SimReference | null {
  const info = pgErrorInfo(e);
  if (!info || info.code !== PG_ERROR.foreignKeyViolation || info.constraint === null) return null;
  return MISSING_BY_CONSTRAINT[info.constraint] ?? null;
}
