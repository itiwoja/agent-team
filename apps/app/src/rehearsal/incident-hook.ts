// 本番の停止を回帰の試験（source = incident）にする（FR-066・BR-80・D-77・D-81）
// - Kernel の approve / deny・送る前の確認の却下・実行中の Kill Switch が起きたら、そのタスクの開始時の sim スナップショットとシードから状況を作り、
//   その仕事の試験に足す。障害 ID は reasonCode と argPath から LLM なしで決める（packages/rehearsal の incidentFaults：D-81）
// - リハーサルの実行（is_dry_run・rehearsal_run_id）と影（shadow）では足さない（本番の実行だけ）
// - 仕事ごとに20件（planAddCase。超えたら同じ reasonCode の古い incident から1件にまとめる）。足したら仕事の合格証を切る（case_added）
// - 呼ぶ側のトランザクションの中で動く（外部を呼ばない：G-14）。ロックの順はワークスペースが最初（M-21）なので、
//   Kernel・確認の側は、ワークスペースの行を取ったあとで呼ぶ。同じ停止を2回呼んでも1件しか足さない（intentId・タスクで見る）

import type { ActionIntentRow, FaultId, IncidentKind, RehearsalCaseRow, StoppedWrite, Tx, Uuid, WsCtx } from "@open-team/db";
import { appendAuditLog } from "@open-team/db";
import { getTask } from "@open-team/db/edge";
import {
  applyCaseMerges,
  findIncidentCase,
  insertRehearsalCase,
  listActiveRehearsalCases,
  listIntentsOfTasks,
  revokeJobCertificate,
} from "@open-team/db/rehearsal";
import { getSimSnapshot } from "@open-team/db/sim";
import type { JsonObject } from "@open-team/kernel";
import { incidentFaults, planAddCase, type IncidentFaultInput } from "@open-team/rehearsal";
import { createLogger } from "@open-team/platform";
import { agentRunsFor, ScenarioSchema } from "@open-team/sim-core";
import type { TasksTerminatedHook } from "../deps.ts";
import { incidentTitle } from "./incident-title.ts";
import { lockWorkspace, toRecord } from "./persist.ts";

const PENDING_ID = "pending-new-case";
const hookLog = createLogger({ service: "app" });

export interface IncidentTrigger {
  taskId: Uuid;
  kind: IncidentKind;
  /** 止まった Intent（kernel_approve・kernel_deny・user_reject）。kill_switch は null（期限切れにした未実行の Intent を拾う） */
  intentId: Uuid | null;
}

export type IncidentSkipReason =
  /** リハーサルの実行・影（本番の実行ではない） */
  | "dry_run"
  | "shadow"
  | "no_task"
  /** 開始時の sim スナップショットがない（再生できない） */
  | "no_snapshot"
  | "no_intent"
  /** すでに足してある（外されたものも数える） */
  | "duplicate"
  /** 20件に収まらず、まとめられる incident も尽きた */
  | "limit_reached"
  | "invalid_scenario";

export type RecordIncidentResult =
  | { recorded: true; row: RehearsalCaseRow; mergedIds: Uuid[]; revokedCertificateId: Uuid | null }
  | { recorded: false; reason: IncidentSkipReason };

/** 'items[1].quantity' のような添字つきの道筋で引数の値を読む（なければ undefined） */
function readArg(args: unknown, argPath: string): unknown {
  let cur: unknown = args;
  for (const m of argPath.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (cur === null || typeof cur !== "object") return undefined;
    const key = m[2] !== undefined ? Number(m[2]) : (m[1] as string);
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

const asNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** ガードの道筋 'items[1].quantity' の同じ行の sku（'items[1].sku'）。なければ items[0] */
function skuOf(args: unknown, argPath: string | null): string | null {
  const row = argPath === null ? null : /^(.*)\.[^.]+$/.exec(argPath)?.[1];
  return asString(readArg(args, row ? `${row}.sku` : "items[0].sku")) ?? asString(readArg(args, "sku"));
}

function faultInputOf(trigger: IncidentTrigger, intent: ActionIntentRow, mine: readonly ActionIntentRow[]): IncidentFaultInput {
  const detail = intent.decision_detail;
  const args = intent.payload.arguments;
  const argPath = detail?.kind === "guard" ? detail.argPath : null;
  const sameAction = mine.filter((i) => i.action === intent.action);
  const upTo = sameAction.findIndex((i) => i.id === intent.id);
  const orderedUnitPrice = argPath !== null && /unit_price$/.test(argPath) ? asNumber(readArg(args, argPath)) : null;
  return {
    stoppedBy: trigger.kind,
    reasonCode: intent.reason_code,
    detail,
    tainted: intent.taint_snapshot.tainted === true,
    destinationMismatch: false,
    // 行の action は 'mcp.supplier.place_order'。試験の道具の名前は 'supplier.place_order'
    tool: intent.action.replace(/^mcp\./, ""),
    nthCall: upTo < 0 ? sameAction.length : upTo + 1,
    observedFailures: sameAction.filter((i) => i.status === "failed").length,
    observedCalls: sameAction.length,
    // 記録済みのツール説明はここでは分からない（tool_needs_review はスナップショットの F-08 を使う）
    recordedToolDescription: null,
    sku: skuOf(args, argPath),
    snapshot: { caseSize: null, normalUnitPrice: null, orderedUnitPrice },
  };
}

function stoppedWriteOf(i: ActionIntentRow, kind: IncidentKind, jobId: Uuid, now: Date): StoppedWrite {
  return {
    intentId: i.id,
    sourceTaskId: i.task_id,
    jobId,
    action: i.action,
    destinationKey: i.destination_key,
    optionDigest: i.option_digest,
    argumentsSnapshot: i.payload.arguments,
    stoppedBy: kind,
    reasonCode: i.reason_code,
    occurredAt: now.toISOString(),
  };
}

/**
 * 止まった実行を試験にする。足したら { recorded: true }、足さなかったら理由を返す（黙って捨てない）。
 * 呼び出し側のトランザクションの中で呼ぶ
 */
export async function recordIncident(tx: Tx, ctx: WsCtx, trigger: IncidentTrigger, now: Date): Promise<RecordIncidentResult> {
  const task = await getTask(tx, ctx, trigger.taskId);
  if (task === null) return { recorded: false, reason: "no_task" };
  if (task.is_dry_run || task.rehearsal_run_id !== null) return { recorded: false, reason: "dry_run" };
  if (task.shadow) return { recorded: false, reason: "shadow" };
  if (task.sim_snapshot_id === null) return { recorded: false, reason: "no_snapshot" };
  const snapshot = await getSimSnapshot(tx, ctx, task.sim_snapshot_id);
  if (snapshot === null) return { recorded: false, reason: "no_snapshot" };

  const intents = await listIntentsOfTasks(tx, ctx, [task.id]);
  let stopped: ActionIntentRow[];
  if (trigger.intentId !== null) {
    const one = intents.find((i) => i.id === trigger.intentId);
    if (one === undefined) return { recorded: false, reason: "no_intent" };
    stopped = [one];
  } else {
    // Kill Switch：期限切れにされた未実行の書き込み（なくてもタスクを再生して O-08 の対象を空にせず、状況だけ残す）
    stopped = intents.filter((i) => i.status === "expired" && i.expire_reason === "kill_switch");
  }
  const first = stopped[0];

  await lockWorkspace(tx, ctx);
  const dup = await findIncidentCase(tx, ctx, { sourceTaskId: task.id, incidentKind: trigger.kind, intentId: trigger.intentId });
  if (dup !== null) return { recorded: false, reason: "duplicate" };

  const plan = first
    ? incidentFaults(faultInputOf(trigger, first, intents))
    : incidentFaults({
        stoppedBy: trigger.kind,
        reasonCode: "kill_switch",
        tainted: false,
        destinationMismatch: false,
        tool: null,
        nthCall: 1,
        observedFailures: 0,
        observedCalls: 0,
        recordedToolDescription: null,
        sku: null,
        snapshot: { caseSize: null, normalUnitPrice: null, orderedUnitPrice: null },
      });
  const reasonCode = first?.reason_code ?? "kill_switch";

  const parsed = ScenarioSchema.safeParse({
    schemaVersion: 1,
    world: snapshot.world,
    seed: snapshot.seed,
    title: incidentTitle(trigger.kind, reasonCode),
    faults: plan.faults,
    agentRuns: agentRunsFor(plan.faults),
    endAt: "day2_end",
    origin: { source: "incident", sourceTaskId: task.id },
  });
  if (!parsed.success) return { recorded: false, reason: "invalid_scenario" };
  const scenario = parsed.data;

  const subject = { jobId: task.job_id };
  const existing = (await listActiveRehearsalCases(tx, ctx, subject)).map(toRecord);
  const addPlan = planAddCase(existing, {
    id: PENDING_ID,
    jobId: task.job_id,
    source: "incident",
    reasonCode,
    createdAt: now.toISOString(),
    removedAt: null,
  });
  if (!addPlan.ok) return { recorded: false, reason: "limit_reached" };
  const mergedIds = await applyCaseMerges(tx, ctx, addPlan.merges, now);

  const faultIds = [...new Set<FaultId>([...scenario.faults.map((f) => f.id), ...plan.snapshotFaultIds])];
  const row = await insertRehearsalCase(tx, ctx, {
    subject,
    source: "incident",
    faultIds,
    scenario: scenario as unknown as JsonObject,
    seed: scenario.seed,
    incident: {
      simSnapshotId: snapshot.id,
      sourceTaskId: task.id,
      reasonCode,
      incidentKind: trigger.kind,
      stoppedWrites: stopped.map((i) => stoppedWriteOf(i, trigger.kind, task.job_id, now)),
    },
    createdAt: now,
  });
  // 試験が増えたので、仕事の合格証は切れる（FR-067）。再リハーサルは tick が拾う
  const revoked = await revokeJobCertificate(tx, ctx, task.job_id, "case_added", now);
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "rehearsal.case_added",
      actorType: "system",
      actorId: "rehearsal",
      taskId: task.id,
      payload: {
        caseId: row.id,
        source: "incident",
        jobId: task.job_id,
        incidentKind: trigger.kind,
        reasonCode,
        faultIds,
        mergedCaseIds: mergedIds,
        notes: plan.notes,
      },
    },
    now,
  );
  return { recorded: true, row, mergedIds, revokedCertificateId: revoked?.id ?? null };
}

/**
 * Kill Switch で終わったタスクの処理（deps.hooks.tasksTerminated に足す）。
 * リハーサル・影のタスクは recordIncident が足さない。足せなかった理由はここでは握りつぶさず、そのまま無視する（Kill Switch を妨げない）。
 * 試験を足すのは副次の処理なので、タスクごとに SAVEPOINT で隔離する。recordIncident が例外を投げても、そのタスクの
 * 書き込みだけ戻して続け、Kill Switch 本体（halted・失効・監査ログ）は必ず成立させる（FR-015 を BR-80 より優先）
 */
export const incidentOnTasksTerminated: TasksTerminatedHook = async (tx, ctx, e) => {
  for (const t of e.tasks) {
    if (t.shadow || t.rehearsalRunId !== null) continue;
    try {
      await tx.savepoint((sp) => recordIncident(sp, ctx, { taskId: t.id, kind: "kill_switch", intentId: null }, e.now));
    } catch (err) {
      hookLog.error("rehearsal.incident_hook_failed", "Kill Switch の回帰の試験を足せなかった。Kill Switch は成立させる", {
        workspaceId: ctx.workspaceId,
        taskId: t.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
