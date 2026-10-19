// リハーサルの試験の保存（薄い層）：生成した状況を rehearsal_cases（source = generated）に、
// 自分の言葉の悪い日を rehearsal_user_inputs と rehearsal_cases（source = user）に書く。SQL は packages/db の repo/rehearsal.ts。
// - 仕事ごとの上限20件・まとめ方は packages/rehearsal の planAddCase で決める（generated・user はまとめない。収まらなければ追加せず理由を返す）
// - ロックの順はワークスペース → …（M-21）。トランザクションの中で Gemini などを呼ばない（G-14）：呼んだあとに、結果だけをここで書く

import { appendAuditLog } from "@open-team/db";
import type { Db, FaultId, RehearsalCaseRow, Tx, Uuid, WsCtx } from "@open-team/db";
import {
  applyCaseMerges,
  finishUserInput,
  insertRehearsalCase,
  insertUserInput,
  listActiveRehearsalCases,
  listUserInputCreatedAts,
  type CaseSubject,
} from "@open-team/db/rehearsal";
import type { JsonObject } from "@open-team/kernel";
import { countOnSameJstDay, planAddCase, userCaseQuota } from "@open-team/rehearsal";
import type { CaseRecord } from "@open-team/rehearsal";
import type { Scenario } from "@open-team/sim-core";
import type { InterpretResult } from "./interpret.ts";

const PENDING_ID = "pending-new-case";

export function toRecord(row: RehearsalCaseRow): CaseRecord {
  return {
    id: row.id,
    // 対象は仕事か依頼のどちらか。planAddCase は同じ jobId の試験だけを数えるので、依頼も同じ文字列に写す
    jobId: row.job_id ?? row.ask_id ?? "",
    source: row.source,
    reasonCode: row.reason_code,
    createdAt: row.created_at.toISOString(),
    removedAt: row.removed_at === null ? null : row.removed_at.toISOString(),
  };
}

export const subjectKey = (s: CaseSubject): string => s.jobId ?? s.askId ?? "";

const uniqueFaultIds = (scenario: Scenario): FaultId[] => [...new Set(scenario.faults.map((f) => f.id))];

/** 試験を1件足す。上限（20件）に収まるように古い incident をまとめ、収まらなければ追加しない */
async function addCase(
  tx: Tx,
  ctx: WsCtx,
  args: { subject: CaseSubject; source: "generated" | "user"; scenario: Scenario; userText?: string; originRunId?: Uuid | null; now: Date },
): Promise<{ ok: true; row: RehearsalCaseRow; mergedIds: Uuid[] } | { ok: false; reason: "limit_reached"; activeCount: number }> {
  const existing = (await listActiveRehearsalCases(tx, ctx, args.subject)).map(toRecord);
  const plan = planAddCase(existing, {
    id: PENDING_ID,
    jobId: subjectKey(args.subject),
    source: args.source,
    reasonCode: null,
    createdAt: args.now.toISOString(),
    removedAt: null,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason, activeCount: plan.activeCount };
  const mergedIds = await applyCaseMerges(tx, ctx, plan.merges, args.now);
  const row = await insertRehearsalCase(tx, ctx, {
    subject: args.subject,
    source: args.source,
    faultIds: uniqueFaultIds(args.scenario),
    scenario: args.scenario as unknown as JsonObject,
    seed: args.scenario.seed,
    ...(args.source === "user" ? { userText: args.userText ?? null } : {}),
    originRunId: args.originRunId ?? null,
    createdBy: ctx.userId,
    createdAt: args.now,
  });
  // 試験を足したことを監査ログに残す（誰が・どの種類で：generated は起動した人、user は書いた人）。まとめた試験の id も残す
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "rehearsal.case_added",
      actorType: ctx.userId ? "user" : "system",
      actorId: ctx.userId ?? "rehearsal",
      payload: {
        caseId: row.id,
        source: args.source,
        ...(args.subject.jobId !== undefined ? { jobId: args.subject.jobId } : { askId: args.subject.askId as Uuid }),
        faultIds: uniqueFaultIds(args.scenario),
        mergedCaseIds: mergedIds,
      },
    },
    args.now,
  );
  return { ok: true, row, mergedIds };
}

/** ワークスペースの行を FOR NO KEY UPDATE で取る（最初に取るロック：M-21。同時の追加で20件を超えないように） */
export async function lockWorkspace(tx: Tx, ctx: WsCtx): Promise<void> {
  const r = await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE", [ctx.workspaceId]);
  if (r.rowCount === 0) throw new Error(`ワークスペースがない：${ctx.workspaceId}`);
}

export interface SaveGeneratedCasesResult {
  /** 保存した試験（rehearsal_cases の行。並びは scenarios の順） */
  saved: RehearsalCaseRow[];
  /** 上限に収まらず保存しなかった状況の番号（scenarios の中の位置） */
  skippedIndexes: number[];
  /** まとめて外した incident の id（removed_reason = 'merged'） */
  mergedIds: Uuid[];
}

/**
 * 生成した状況を rehearsal_cases（source = generated）に保存する（FR-042）。1回のトランザクション。
 * 上限に収まらないもの（まとめられる incident が尽きた）は保存せず、skippedIndexes で返す（黙って捨てない）
 */
export async function saveGeneratedCases(
  db: Db | Tx,
  ctx: WsCtx,
  args: { subject: CaseSubject; scenarios: readonly Scenario[]; now: Date; originRunId?: Uuid | null },
): Promise<SaveGeneratedCasesResult> {
  const run = async (tx: Tx): Promise<SaveGeneratedCasesResult> => {
    await lockWorkspace(tx, ctx);
    const out: SaveGeneratedCasesResult = { saved: [], skippedIndexes: [], mergedIds: [] };
    for (const [i, scenario] of args.scenarios.entries()) {
      if (scenario.origin.source !== "generated") throw new TypeError(`saveGeneratedCases: origin.source が generated ではない（${i} 番目）`);
      const r = await addCase(tx, ctx, { subject: args.subject, source: "generated", scenario, originRunId: args.originRunId ?? null, now: args.now });
      if (r.ok) {
        out.saved.push(r.row);
        out.mergedIds.push(...r.mergedIds);
      } else out.skippedIndexes.push(i);
    }
    return out;
  };
  return db.inTransaction ? run(db) : db.transaction(run);
}

export type RecordInterpretationResult =
  | { recorded: false; reason: "not_called" | "quota_exceeded" }
  | { recorded: true; inputId: Uuid; status: "matched" | "no_match" | "failed"; caseId: Uuid | null; mergedIds: Uuid[]; reason?: "limit_reached" };

/**
 * 解釈の結果を保存する（FR-065）。Gemini を呼んだもの（matched・unmatched・rejected）は rehearsal_user_inputs に1行残す
 * （1日5件はこの行で数える：M-51。失敗・カタログにないものも数える）。matched は rehearsal_cases（source = user）も足す
 * （合格・不合格にかかわらず試験として残す：15）。Gemini を呼んでいない結果（入力が不正・上限・費用）は何も書かない。
 * 試験が上限（20件）に収まらないときは、試験を足さず入力を failed にして reason = limit_reached を返す（実行しない：締める側）
 */
export async function recordInterpretation(
  db: Db | Tx,
  ctx: WsCtx & { userId: Uuid },
  args: { subject: CaseSubject; result: InterpretResult; now: Date; /** 渡すと、ロックの中で今日の件数を数え直して上限（ゲスト1日5件）を超えるなら書かない（並行の起動で超えないように） */ workspaceKind?: "owner" | "guest" },
): Promise<RecordInterpretationResult> {
  const r = args.result;
  if (r.kind === "quota_exceeded" || r.kind === "budget_exceeded" || r.kind === "invalid_input") return { recorded: false, reason: "not_called" };
  const run = async (tx: Tx): Promise<RecordInterpretationResult> => {
    await lockWorkspace(tx, ctx);
    if (args.workspaceKind !== undefined) {
      // 解釈の前の数え方は並行の起動に負ける。ロックを取ってから数え直し、足りなければ行を書かない
      const used = await listUserInputCreatedAts(tx, ctx, new Date(args.now.getTime() - 48 * 3600_000));
      const usedToday = countOnSameJstDay(used.map((d) => d.toISOString()) as never, args.now.toISOString() as never);
      if (!userCaseQuota({ workspaceKind: args.workspaceKind, usedToday }).allowed) return { recorded: false, reason: "quota_exceeded" };
    }
    const input = await insertUserInput(tx, ctx, { subject: args.subject, text: r.inputText, createdAt: args.now });
    if (r.kind === "unmatched") {
      await finishUserInput(tx, ctx, input.id, {
        status: "no_match",
        interpretation: {
          message: r.message,
          ...(r.reason === undefined ? {} : { reason: r.reason }),
          candidate: { text: r.candidate.text, nearestFaultId: r.candidate.nearestFaultId },
        },
        nearestFaultId: r.nearestFaultId,
        caseId: null,
      });
      return { recorded: true, inputId: input.id, status: "no_match", caseId: null, mergedIds: [] };
    }
    if (r.kind === "rejected") {
      await finishUserInput(tx, ctx, input.id, { status: "failed", interpretation: { message: r.message, reasons: r.reasons }, nearestFaultId: null, caseId: null });
      return { recorded: true, inputId: input.id, status: "failed", caseId: null, mergedIds: [] };
    }
    const added = await addCase(tx, ctx, { subject: args.subject, source: "user", scenario: r.scenario, userText: r.inputText, now: args.now });
    if (!added.ok) {
      await finishUserInput(tx, ctx, input.id, {
        status: "failed",
        interpretation: { message: "試験が上限（20件）に達しているので、足しません", line: r.interpretation, faultIds: r.faultIds },
        nearestFaultId: null,
        caseId: null,
      });
      return { recorded: true, inputId: input.id, status: "failed", caseId: null, mergedIds: [], reason: "limit_reached" };
    }
    await finishUserInput(tx, ctx, input.id, {
      status: "matched",
      interpretation: { line: r.interpretation, faultIds: r.faultIds },
      nearestFaultId: null,
      caseId: added.row.id,
    });
    return { recorded: true, inputId: input.id, status: "matched", caseId: added.row.id, mergedIds: added.mergedIds };
  };
  return db.inTransaction ? run(db) : db.transaction(run);
}

/** interpretUserBadDay の userInputCreatedAts に渡す値（ISO 文字列。今日の分だけでよいが、数え方は packages/rehearsal が決める） */
export async function loadUserInputCreatedAts(db: Db | Tx, ctx: WsCtx, since?: Date): Promise<string[]> {
  return (await listUserInputCreatedAts(db, ctx, since)).map((d) => d.toISOString());
}
