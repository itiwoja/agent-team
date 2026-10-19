// リハーサルの進捗（D-56：状況が1件終わるたびに結果の行を足す）。既存の SSE の仕組み（events.ts・sse.ts）に、
// workspace_events の行（appendWorkspaceEvent。コミットで NOTIFY）として流す。事象の type は AS §2.11 の流儀（小文字と . と _）

import type { Db, Uuid, WsCtx } from "@open-team/db";
import { appendWorkspaceEvent } from "@open-team/db/app";
import type { Tx } from "@open-team/db";
import type { Json } from "@open-team/kernel";
import type { ScenarioResult } from "@open-team/sim-core";

/** 状況が1件終わった（結果の行つき） */
export const REHEARSAL_SCENARIO_EVENT = "rehearsal.scenario";
/** 走行が終わった（3段の集計つき） */
export const REHEARSAL_RUN_EVENT = "rehearsal.run";

export interface RehearsalScenarioEventData {
  runId: Uuid;
  scenarioId: Uuid;
  caseId: Uuid;
  ordinal: number;
  /** done 以外は結果の行がない（cancelled：予算・Kill Switch で始めなかった／止めた、error：基盤の失敗） */
  status: "done" | "cancelled" | "error";
  abortReason: "budget" | "kill_switch" | "timeout" | "user" | null;
  faultIds: string[];
  verdict: "pass" | "fail" | null;
  outcome: ScenarioResult["outcome"] | null;
  stoppedBy: ScenarioResult["stoppedBy"] | null;
  /** 「F-03 振込先の変更 → Kernel が承認へ回した」 */
  line: string | null;
  damageJpy: number | null;
  shadowDamageJpy: number | null;
  preventedDamageJpy: number | null;
  costUsd: string;
}

export interface RehearsalRunEventData {
  runId: Uuid;
  status: "done" | "failed" | "cancelled";
  total: number;
  preventedDamageJpy: number;
  costUsd: string;
}

/** 呼び出し側のトランザクションの中で足す（状況の結果の保存と同じトランザクション） */
export async function appendScenarioEvent(tx: Tx, ctx: WsCtx, data: RehearsalScenarioEventData, now: Date): Promise<void> {
  await appendWorkspaceEvent(tx, ctx, { type: REHEARSAL_SCENARIO_EVENT, data: data as unknown as Json }, now);
}

export async function publishRunEvent(db: Db, ctx: WsCtx, data: RehearsalRunEventData, now: Date): Promise<void> {
  await db.transaction((tx) => appendWorkspaceEvent(tx, ctx, { type: REHEARSAL_RUN_EVENT, data: data as unknown as Json }, now));
}

/** リハーサル全体の段階（orchestrate.ts：開始 → 生成 → 実行 → 適応 → 締める提案）が進んだ */
export const REHEARSAL_PHASE_EVENT = "rehearsal.phase";

export type RehearsalPhase = "started" | "generated" | "ran" | "adapting" | "adapted" | "proposed" | "finished" | "stopped";

export interface RehearsalPhaseEventData {
  phase: RehearsalPhase;
  /** 段階に関わる走行（開始・生成の段階ではまだない） */
  runId: Uuid | null;
  /** 「適応 2 回目」「状況を 6 件作った」「提案 2 件」など、画面に出す1行 */
  line: string;
  /** 適応の回（0 が最初の生成）。適応以外は 0 */
  round: number;
  /** ここまでの費用（USD。BR-62 の $3 と比べて見せる） */
  costUsd: string;
}

export async function publishPhaseEvent(db: Db, ctx: WsCtx, data: RehearsalPhaseEventData, now: Date): Promise<void> {
  await db.transaction((tx) => appendWorkspaceEvent(tx, ctx, { type: REHEARSAL_PHASE_EVENT, data: data as unknown as Json }, now));
}
