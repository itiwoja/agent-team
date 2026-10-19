// 本番の停止を回帰の試験にする入口（FR-066・BR-80）：Kernel の判定（approve・deny）と、ユーザーの確認の却下から incident-hook.ts の recordIncident を呼ぶ。
// Kill Switch は deps.hooks.tasksTerminated（incident-hook.ts の incidentOnTasksTerminated）が受ける。ここは Intent 単位の入口
// - Kernel の判定：edge は Intent を保存した「コミットのあと」に EdgeHooks.onIntentRecorded を呼ぶ（edge は app を import しない）。
//   本番の edge を組み立てる側は、onIntentRecorded の中で incidentOnIntentRecorded(deps) を呼ぶ（実行を起こす処理と並べる）
// - ユーザーの却下：承認の API が却下を保存したトランザクションの中で recordUserRejection を呼ぶ
// - 試験にするのは「止まった」ものだけ。ふだんの確認（ルールがなく既定で確認に回る）・合格証がないための確認（certificate_missing）は
//   止まったことにしない（毎回試験が増えて合格証が切れ続け、切れたから確認に回り、また試験になる、を避ける）。
//   approve のうち試験にする理由：guard_exceeded・unknown_outcome_pending・tool_needs_review・汚染あり・宛先の固定に不一致。deny は halt 以外すべて
// - 失敗しても本番の処理（実行・却下）を妨げない（SAVEPOINT で隔離し、ログに残す）
// - 結果から SCR-019 の報告の行の文を取れる（incidentReportLine）

import type { ActionIntentRow, IncidentKind, Tx, Uuid, WsCtx } from "@open-team/db";
import { listIntentsOfTasks } from "@open-team/db/rehearsal";
import type { EdgeHooks } from "@open-team/edge";
import type { AppDeps } from "../deps.ts";
import { recordIncident, type RecordIncidentResult } from "./incident-hook.ts";

/** SCR-019 の報告の行に出す文（試験に入れたとき） */
export const INCIDENT_REPORT_LINE = "止めた発注を、次の安全チェックに足しました";

export type IncidentFlowResult = RecordIncidentResult | { recorded: false; reason: "not_incident" | "error" };

/** 試験にした結果から、報告の行の文を取る（試験にしなかったとき・すでにあるときは null） */
export function incidentReportLine(r: IncidentFlowResult): string | null {
  return r.recorded ? INCIDENT_REPORT_LINE : null;
}

/** approve のうち、止まったこととして試験にする理由 */
const APPROVE_INCIDENT_REASONS: ReadonlySet<string> = new Set(["guard_exceeded", "unknown_outcome_pending", "tool_needs_review"]);
/** deny でも試験にしない（Kernel が止めたのではなく、タスクの終わり・Kill Switch の halt のもの） */
const DENY_SKIP_REASONS: ReadonlySet<string> = new Set(["kill_switch", "task_terminated"]);

/** Intent の判定が「止まった」として試験にするものか。ふだんの確認・合格証がないための確認は null */
export function incidentKindOfIntent(
  i: Pick<ActionIntentRow, "decision" | "reason_code" | "taint_snapshot" | "decision_detail">,
): Extract<IncidentKind, "kernel_approve" | "kernel_deny"> | null {
  if (i.decision === "deny") return DENY_SKIP_REASONS.has(i.reason_code) ? null : "kernel_deny";
  if (i.decision !== "approve") return null;
  if (i.reason_code === "certificate_missing") return null;
  if (APPROVE_INCIDENT_REASONS.has(i.reason_code)) return "kernel_approve";
  if (i.taint_snapshot.tainted === true) return "kernel_approve";
  const d = i.decision_detail;
  if (d?.kind === "rule_mismatch" && d.role === "destination") return "kernel_approve";
  return null;
}

type FlowDeps = Pick<AppDeps, "db" | "clock" | "log">;

/**
 * Kernel の判定を試験にする（本番の Intent だけ。影・リハーサルは recordIncident が足さない）。
 * edge の EdgeHooks.onIntentRecorded から呼ぶ（コミットのあと。自分のトランザクションで足す）
 */
export async function recordKernelIncident(deps: FlowDeps, ctx: WsCtx, e: { taskId: Uuid; intentId: Uuid; shadow: boolean }): Promise<IncidentFlowResult> {
  if (e.shadow) return { recorded: false, reason: "shadow" };
  try {
    return await deps.db.transaction(async (tx) => {
      const intent = (await listIntentsOfTasks(tx, ctx, [e.taskId])).find((i) => i.id === e.intentId);
      if (intent === undefined) return { recorded: false, reason: "no_intent" } as const;
      const kind = incidentKindOfIntent(intent);
      if (kind === null) return { recorded: false, reason: "not_incident" } as const;
      return recordIncident(tx, ctx, { taskId: e.taskId, kind, intentId: e.intentId }, deps.clock.now());
    });
  } catch (error) {
    deps.log.error("rehearsal.incident_failed", "Kernel の判定を回帰の試験にできなかった。実行は続ける", { workspaceId: ctx.workspaceId, taskId: e.taskId, intentId: e.intentId, error });
    return { recorded: false, reason: "error" };
  }
}

/** EdgeHooks.onIntentRecorded に渡す処理（結果は捨てる：報告の行は recordKernelIncident の返り値で取る呼び出し側が使う） */
export function incidentOnIntentRecorded(deps: FlowDeps): NonNullable<EdgeHooks["onIntentRecorded"]> {
  return async (ctx, e) => {
    await recordKernelIncident(deps, ctx, e);
  };
}

/**
 * ユーザーが送る前の確認を却下した（承認の API が却下を保存したトランザクションの中で呼ぶ。ワークスペースのロックを先に取っておく：M-21）。
 * SAVEPOINT で隔離するので、試験を足せなくても却下そのものは成立する
 */
export async function recordUserRejection(tx: Tx, ctx: WsCtx, e: { taskId: Uuid; intentId: Uuid }, now: Date, log?: FlowDeps["log"]): Promise<IncidentFlowResult> {
  try {
    return await tx.savepoint((sp) => recordIncident(sp, ctx, { taskId: e.taskId, kind: "user_reject", intentId: e.intentId }, now));
  } catch (error) {
    log?.error("rehearsal.incident_failed", "却下を回帰の試験にできなかった。却下は成立させる", { workspaceId: ctx.workspaceId, taskId: e.taskId, intentId: e.intentId, error });
    return { recorded: false, reason: "error" };
  }
}
