// デモ用のデータ（ゲストのワークスペースの「最初に入っているもの」：15 §最初に入っているもの）を直接入れる問い合わせ。
// 依頼・担当・Intent・承認の行は既存の関数（asks.ts の insertLiveRun・insertAskTask、edge.ts の insertActionIntent・insertApproval）で入れ、
// ここは「入れたタスクを、1回分を走らせ終えた状態にする」更新だけを持つ（タスクの実行そのものは動かさない）。
// 約束は README §1：SQL を必ず workspace_id で絞る。外部を呼ばない（G-14）。呼び出しは1つのトランザクションの中

import type { Tx } from "../client.ts";
import type { JsonObject, Json } from "@open-team/kernel";
import type { ReportKind, ReportSource, TaskRow, TaskStatus, UsdDecimal, Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";

export interface SeedTaskState {
  /** 'succeeded' | 'completed'（終了）か 'awaiting_approval'（承認待ちで止まっている） */
  status: Extract<TaskStatus, "succeeded" | "completed" | "awaiting_approval">;
  report: { title: string; body: string; kind: ReportKind; sources?: ReportSource[] } | null;
  stepsUsed: number;
  costUsd: UsdDecimal;
  /** 本番のタスクの開始時のデモ店舗のスナップショット（FR-066） */
  simSnapshotId: Uuid | null;
  startedAt: Date;
  /** 終了状態のときだけ（awaiting_approval では null） */
  finishedAt: Date | null;
  /** 最後に状態が変わった時刻（省けば終了の時刻、なければ開始の時刻）。awaiting_approval では止まった時刻を渡す */
  updatedAt?: Date;
  statusDetail?: string | null;
  tainted?: { tainted: boolean; sources: Json[] };
}

/** queued で入れたタスクを、走らせ終えた状態にする（トークンは持たない）。更新できたら行を返す */
export async function settleSeedTask(tx: Tx, ctx: WsCtx, taskId: Uuid, s: SeedTaskState): Promise<TaskRow | null> {
  const r = await tx.query<TaskRow>(
    `UPDATE tasks
        SET status = $3, report = $4, report_title = $5, report_kind = $6, report_sources = $7::jsonb,
            steps_used = $8, cost_usd = $9, sim_snapshot_id = $10, started_at = $11, last_heartbeat_at = $11,
            finished_at = $12, status_detail = $13,
            tainted = $14, taint_sources = $15::jsonb, updated_at = COALESCE($16, $12, $11)
      WHERE workspace_id = $1 AND id = $2 AND status = 'queued'
      RETURNING *`,
    [
      ctx.workspaceId,
      taskId,
      s.status,
      s.report?.body ?? null,
      s.report?.title ?? null,
      s.report?.kind ?? null,
      s.report?.sources === undefined ? null : (s.report.sources as unknown as JsonObject[]),
      s.stepsUsed,
      s.costUsd,
      s.simSnapshotId,
      s.startedAt,
      s.finishedAt,
      s.statusDetail ?? null,
      s.tainted?.tainted ?? false,
      (s.tainted?.sources ?? []) as unknown as JsonObject[],
      s.updatedAt ?? null,
    ],
  );
  return r.rows[0] ?? null;
}

/** デモ用のタスクの進み方の記録（task_events）。画面の「やっていること」の最後のツールにも使われる */
export async function insertSeedTaskEvent(
  tx: Tx,
  ctx: WsCtx,
  taskId: Uuid,
  type: "status_changed" | "tool_called" | "finished",
  payload: JsonObject,
  at: Date,
): Promise<void> {
  await tx.query("INSERT INTO task_events (workspace_id, task_id, type, payload, created_at) VALUES ($1, $2, $3, $4, $5)", [ctx.workspaceId, taskId, type, payload, at]);
}

/** 本番のタスクの開始時のデモ店舗のスナップショット（FR-066）を付ける。sim-world でスナップショットを作ったあとに呼ぶ */
export async function setTaskSimSnapshot(tx: Tx, ctx: WsCtx, taskId: Uuid, snapshotId: Uuid): Promise<boolean> {
  const r = await tx.query("UPDATE tasks SET sim_snapshot_id = $3 WHERE workspace_id = $1 AND id = $2 AND rehearsal_run_id IS NULL", [ctx.workspaceId, taskId, snapshotId]);
  return r.rowCount === 1;
}

/** 事前に走らせたリハーサルの結果（15 §最初に入っているもの）を行ごとそのまま入れられる表 */
const SEED_ROW_TABLES = ["rehearsal_cases", "rehearsal_runs", "rehearsal_scenarios", "tasks", "action_intents", "policy_decisions"] as const;
export type SeedRowTable = (typeof SEED_ROW_TABLES)[number];

/**
 * 事前に走らせたリハーサルの行（to_jsonb の形。workspace_id は持たず、ここで ctx のものを付ける）を表にそのまま入れる。
 * 列は行のキーから決める（表と列の名前は固定の許可リストと英小文字・数字・_ だけ。値は jsonb_populate_record で表の型に直す）。
 * ID・時刻・他の行への参照は呼び出し側で入れ先のものに直してから渡す。生成列は渡さない
 */
export async function insertSeedRows(tx: Tx, ctx: WsCtx, table: SeedRowTable, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  if (!SEED_ROW_TABLES.includes(table)) throw new TypeError(`insertSeedRows: 入れられない表：${table}`);
  for (const row of rows) {
    const cols = Object.keys(row);
    for (const c of cols) if (!/^[a-z][a-z0-9_]*$/.test(c) || c === "workspace_id") throw new TypeError(`insertSeedRows: 列の名前が不正：${c}`);
    await tx.query(
      `INSERT INTO ${table} (workspace_id, ${cols.join(", ")})
       SELECT $1::uuid, ${cols.map((c) => `r.${c}`).join(", ")} FROM jsonb_populate_record(NULL::${table}, $2::jsonb) r`,
      [ctx.workspaceId, row as never],
    );
  }
}

/** 事前に走らせたリハーサルの状況に、sim-world の走行（本番の経路）を結びつける。状況の行と、その状況の本番の経路のタスクに付ける */
export async function setSeedScenarioExecution(tx: Tx, ctx: WsCtx, scenarioId: Uuid, executionId: Uuid): Promise<void> {
  await tx.query("UPDATE rehearsal_scenarios SET governed_execution_id = $3 WHERE workspace_id = $1 AND id = $2", [ctx.workspaceId, scenarioId, executionId]);
  await tx.query("UPDATE tasks SET sim_execution_id = $3 WHERE workspace_id = $1 AND rehearsal_scenario_id = $2 AND execution_variant = 'governed'", [ctx.workspaceId, scenarioId, executionId]);
}
