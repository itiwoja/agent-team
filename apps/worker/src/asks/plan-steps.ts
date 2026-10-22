// 設定プランナーの生成の DO の側（apps/app/src/asks/create.ts の generateAsk の WorkspaceDO 版）。
// Node 版はプロセスの中で「材料 → 計画（Gemini）→ 保存 → 実行の開始」を続けて行った。ここでは Workflow（workflows/plan-ask.ts）が歩みに分け、
// 材料と保存は DO のこの関数を RPC で呼ぶ。計画の結果は歩みをまたぐので、失敗も値（kind: "failed"）で受け取る

import type { WsDb } from "../db/sqlite.ts";
import type { AskFailureReason } from "../views/asks/contract.ts";
import { closeFailedStart, failGeneration, materializeFormation, savePlanQuestion } from "./generate.ts";
import { AskPlanError, type PlanResult } from "./planner.ts";
import { startAskRunTx } from "./run.ts";

/** Workflow の計画の歩みの結果 */
export type PlanStepResult = PlanResult | { kind: "failed"; reason: AskFailureReason; detail: string };

/** 保存の結果（formed なら作った実行と queued のタスク。タスクを動かすのは 4c） */
export type PlanSaveOutcome =
  | { outcome: "formed"; runId: string | null; taskIds: string[] }
  | { outcome: "question" | "failed" | "skipped" };

/** 計画の結果を保存する：失敗は ask.failed、質問は ask.question、編成は保存して最初の実行を始める（すぐ動かす：D-67） */
export function savePlanResult(db: WsDb, a: { askId: string; requesterId: string; result: PlanStepResult; now: Date; secrets: readonly string[] }): PlanSaveOutcome {
  const { askId, result, now, secrets } = a;
  if (result.kind === "failed") {
    failGeneration(db, { askId, reason: result.reason, detail: result.detail, now, secrets });
    return { outcome: "failed" };
  }
  if (result.kind === "question") return { outcome: savePlanQuestion(db, askId, result.question, now) ? "question" : "skipped" };

  let formed: ReturnType<typeof materializeFormation>;
  try {
    formed = materializeFormation(db, { askId, requesterId: a.requesterId, planned: result.formation, now });
  } catch (e) {
    const reason = e instanceof AskPlanError ? e.code : "planner_error";
    failGeneration(db, { askId, reason, detail: e instanceof Error ? e.message : String(e), now, secrets });
    return { outcome: "failed" };
  }
  if (formed === null) return { outcome: "skipped" };
  // 編成の保存のあとに始められなかったら、running のまま残さず閉じる
  try {
    const started = startAskRunTx(db, askId, { requesterId: formed.ask.created_by, trigger: "initial", now });
    return { outcome: "formed", runId: started?.run.id ?? null, taskIds: started?.tasks.map((t) => t.id) ?? [] };
  } catch (e) {
    closeFailedStart(db, { askId, error: e, now, secrets });
    return { outcome: "failed" };
  }
}
