// 編成の実行（FR-062。apps/app/src/asks/run.ts の DB 側の WorkspaceDO 版）：ask_members の段ごとにタスクを作り、形（ひとり・並列・まとめ・順番）に従って進める。
// 進め方：いまのタスクの状態から evaluateRun（views/asks/plan.ts。純粋関数）が「次に始める担当・実行の状態・回答を出してよいか」を決め、
//   advanceTx（1つのトランザクション）が「担当のタスクを作る（queued）・実行と依頼の状態・回答・SSE の事象」を書く。
//   タスクはトランザクションの外で動かす（外部を呼ぶのはトランザクションの外：G-14）。
// Node 版との違い：
// - どれも DO の中で呼ぶ同期の関数。ワークスペースの行のロック（lockWorkspace）は要らない（DO の中は1本の流れ）
// - 実行を始めるのは startAskRunTx（beginRunTx と最初の advanceTx を1つのトランザクションで）。作ったタスクを返すので、呼ぶ側がそれを動かす
// - タスクを動かす部分（driveRun・executeTask・startWhenRoom・追いのターン・順番待ちの返事・再開）はここにない（第4段の 4c で移す）

import { taintFromInputs } from "@open-team/kernel";
import { AppError } from "@open-team/platform";
import { appendAuditLog } from "../db/audit.ts";
import {
  getAsk,
  getAskRun,
  getPreviousReportTask,
  insertAskTask,
  insertLiveRun,
  listMembers,
  listRunTasks,
  markFirstMemberStarted,
  transitionAsk,
  transitionRun,
} from "../db/repo/asks.ts";
import { getAgentRow, getTask } from "../db/repo/edge.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { AskMemberRow, AskRow, AskRunRow, AskRunTrigger, TaskRow, Uuid } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";
import { replyWebUrlHashes, userTextWebUrlHashes } from "../edge/web-seen.ts";
import { latestTaskByMember } from "../views/asks/answer.ts";
import { evaluateRun, type PlanMember, type RunStatus } from "../views/asks/plan.ts";
import { emitAskEvent } from "./accept.ts";
import { composeRunAnswer, persistAnswer } from "./answer.ts";

type MemberRowN = AskMemberRow & { agent_name: string };

// ---- 状態の読み出し ----

export interface RunState {
  ask: AskRow;
  run: AskRunRow;
  /** この実行が動かす担当（返事の実行は窓口だけ） */
  members: MemberRowN[];
  allMembers: MemberRowN[];
  tasks: TaskRow[];
}

export function loadState(db: WsDb, runId: Uuid): RunState | null {
  const run = getAskRun(db, runId);
  if (run === null) return null;
  const ask = getAsk(db, run.ask_id);
  if (ask === null) return null;
  const allMembers = listMembers(db, ask.id);
  // 返事の実行（trigger_type = manual）は窓口の担当だけを動かす（FR-063：回答への返事は窓口へのお願い）
  const members = run.trigger_type === "manual" ? allMembers.filter((m) => m.is_spokesperson) : allMembers;
  const tasks = listRunTasks(db, runId);
  return { ask, run, members, allMembers, tasks };
}

/** 返事の実行は、形に関わらず1人だけを動かす（single として扱う） */
export const effectiveShape = (s: RunState): NonNullable<AskRow["shape"]> => (s.run.trigger_type === "manual" ? "single" : (s.ask.shape ?? "single"));

export function planMembers(s: RunState): PlanMember[] {
  const latest = latestTaskByMember(s.tasks);
  return s.members.map((m, i) => {
    const t = latest.get(m.id) ?? null;
    return {
      memberId: m.id,
      position: m.position ?? i + 1,
      isAggregator: m.is_aggregator,
      task: t === null ? null : { id: t.id, status: t.status, hasReport: t.report !== null },
      dependsOn: m.depends_on,
    };
  });
}

/** 依頼の状態を実行の状態に合わせる。定期の依頼は、実行が終わっても次の実行を待つので running のまま（止まっている waiting_input だけ映す） */
export function askStatusFor(ask: AskRow, runStatus: RunStatus): AskRow["status"] {
  if (runStatus === "waiting_input") return "waiting_input";
  if (runStatus === "running") return "running";
  if (ask.trigger !== null) return "running";
  return runStatus;
}

// ---- タスクを作る（1つのトランザクションの中） ----

/** 担当のタスクを作る（queued）。受け渡し（input_task_ids）と汚染の引き継ぎ（BR-71）を決める。外部は呼ばない。呼ぶ側のトランザクションの中で */
export function createMemberTask(
  db: WsDb,
  s: RunState,
  member: MemberRowN,
  inputTaskIds: readonly Uuid[],
  o: {
    requesterId: Uuid;
    prompt: string | null;
    now: Date;
    /** この実行の外のタスク（返事のとき、前の回答のタスク） */
    extraTasks?: readonly TaskRow[];
    /** 利用者の返事の文（API-077 の body.text をマスクしたもの。返事の実行のときだけ） */
    reply?: string;
    /** 返事が答える前の回答の「次の手の提案」（前の回答のタスクの report_meta.nextActions。返事の実行のときだけ） */
    replySuggestions?: readonly string[];
  },
): TaskRow {
  const agent = getAgentRow(db, member.agent_id);
  if (agent === null || agent.current_snapshot_id === null || (agent.status !== "active" && agent.status !== "idle")) {
    throw new AppError("TASK_NOT_RUNNABLE", `担当「${member.agent_name}」は動かせません`);
  }
  const byId = new Map([...s.tasks, ...(o.extraTasks ?? [])].map((t) => [t.id, t]));
  const nameOf = (t: TaskRow): string => s.members.find((m) => m.id === t.ask_member_id)?.agent_name ?? s.allMembers.find((m) => m.id === t.ask_member_id)?.agent_name ?? "担当";
  const inputs = inputTaskIds.flatMap((id) => {
    const t = byId.get(id);
    return t === undefined ? [] : [{ taskId: t.id, agentName: nameOf(t), taint: { tainted: t.tainted, sources: t.taint_sources } }];
  });
  const task = insertAskTask(db, {
    requesterId: o.requesterId,
    agentId: member.agent_id,
    agentSnapshotId: agent.current_snapshot_id,
    jobId: member.job_id,
    askId: s.ask.id,
    askRunId: s.run.id,
    askMemberId: member.id,
    inputTaskIds,
    taint: taintFromInputs(inputs, o.now.toISOString()),
    prompt: o.prompt,
    // SG-04：汚染後も辿れる URL として、利用者自身が書いた文の URL だけを入れる。
    // - s.ask.text：入口で利用者が書いた依頼の文（acceptAsk の body.text を maskUserText したもの）か、運営が固定で持つ準備済みの依頼の文。
    //   作ったあとに書き換える所はない（プランナーは ask_members と仕事の instructions を書く）
    // - o.reply：回答への返事（API-077 の body.text を maskUserText したもの）。ただし画面の「次はこれをしましょうか？」の
    //   ボタン（AskPage の NextActions）は、担当が書いた提案の文をそのまま返事として送る。提案と同じ文なら何も入れず、
    //   提案に出てくる URL も入れない（replyWebUrlHashes。提案は o.replySuggestions）
    // 担当の指示（プランナーの LLM が書いた instructions）と、前の段・前の回答のタスクの中身は入れない（それらの見た URL は db 側で集合ごと写す）
    userWebUrlHashes: [...userTextWebUrlHashes([s.ask.text]), ...replyWebUrlHashes(o.reply, o.replySuggestions ?? [])],
    // 前の回答のタスク（返事の実行）・前の回の報告のタスク（定期の見張り）は、入力の並べ方にかかわらず集合を写す
    inheritWebUrlsFrom: (o.extraTasks ?? []).map((t) => t.id),
    now: o.now,
  });
  appendAuditLog(
    db,
    {
      eventType: "ask.step.started",
      actorType: "system",
      actorId: "asks",
      taskId: task.id,
      payload: { askId: s.ask.id, askRunId: s.run.id, memberId: member.id, taskId: task.id, inputTaskIds: [...inputTaskIds], tainted: task.tainted },
    },
    o.now,
  );
  emitAskEvent(db, { type: "ask.step.started", askId: s.ask.id, runId: s.run.id, memberId: member.id, agentName: member.agent_name, taskId: task.id, position: member.position }, o.now);
  return task;
}

/** 担当に渡す「お願い」の本文（依頼の文。返事の実行は返事の文）。秘密情報は依頼・返事を受けるときにマスク済み */
export function promptOf(s: RunState, reply?: string): string | null {
  return reply ?? s.ask.text;
}

// ---- 1歩進める ----

export interface StepResult {
  /** この歩みで作ったタスク（あとで動かす） */
  tasks: TaskRow[];
  runStatus: RunStatus | null;
}

/**
 * 実行を1歩進める（1つのトランザクション）：評価 → 作るタスク → 実行・依頼の状態 → 回答。
 * 動いていない実行は何もしない
 */
export function advanceTx(db: WsDb, runId: Uuid, o: { requesterId: Uuid; now: Date; aggregatorWaitMs?: number; reply?: string; replyOf?: Uuid }): StepResult {
  return db.transaction((): StepResult => {
    if (getWorkspace(db) === null) return { tasks: [], runStatus: null };
    const s = loadState(db, runId);
    if (s === null || s.run.status !== "running") return { tasks: [], runStatus: null };
    const plan = evaluateRun({
      shape: effectiveShape(s),
      members: planMembers(s),
      now: o.now,
      firstStartedAt: s.run.first_member_started_at,
      ...(o.aggregatorWaitMs === undefined ? {} : { aggregatorWaitMs: o.aggregatorWaitMs }),
    });

    // 返事の実行：前の回答のタスクを「データ」として渡す（汚染も引き継ぐ）
    const replyTask = o.replyOf === undefined ? null : getTask(db, o.replyOf);
    // 定期の実行（見張り）：最初の段の担当に、その担当の前の回の報告を渡す（前回と比べて変化を判断する。汚染も引き継ぐ）
    const previousOf = (member: MemberRowN, inputTaskIds: readonly Uuid[]): TaskRow | null =>
      s.run.trigger_type === "schedule" && replyTask === null && inputTaskIds.length === 0 && !member.is_aggregator ? getPreviousReportTask(db, member.id, s.run.id) : null;
    // 担当のタスクを作る
    const created: TaskRow[] = [];
    let failedToStart: string | null = null;
    for (const st of plan.start) {
      const member = s.members.find((m) => m.id === st.memberId);
      if (member === undefined) continue;
      try {
        const previous = previousOf(member, st.inputTaskIds);
        const extra = replyTask ?? previous;
        created.push(
          createMemberTask(db, s, member, extra === null ? st.inputTaskIds : [extra.id], {
            requesterId: o.requesterId,
            prompt: promptOf(s, o.reply),
            now: o.now,
            ...(extra === null ? {} : { extraTasks: [extra] }),
            ...(o.reply === undefined ? {} : { reply: o.reply }),
            // 画面の提案のボタンが出すのは、最新の実行の回答のタスク（ask_runs.answer_task_id）の report_meta.nextActions（answerExtrasOf）。
            // 返事の API（API-077）は replyOf にその answer_task_id を渡すので、replyTask の提案がボタンの文と同じものになる
            ...(o.reply === undefined || replyTask === null ? {} : { replySuggestions: replyTask.report_meta?.nextActions ?? [] }),
          }),
        );
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== "TASK_NOT_RUNNABLE") throw e;
        failedToStart = member.agent_name;
      }
    }
    if (created.length > 0) markFirstMemberStarted(db, runId, o.now);
    if (failedToStart !== null) {
      // 担当が動かせない（停止・削除）：実行を失敗として閉じる（作った分は動かす）。依頼は止まった旨を回答に出す
      plan.status = "failed";
    }

    // 実行・依頼の状態
    const status: RunStatus = created.length > 0 ? "running" : plan.status;
    if (status !== s.run.status) {
      const moved = transitionRun(db, runId, ["running"], status, o.now);
      if (moved === null) return { tasks: created, runStatus: null };
    }
    const askTo = askStatusFor(s.ask, status);
    if (askTo !== s.ask.status) {
      const moved = transitionAsk(db, s.ask.id, ["running", "waiting_input"], askTo, o.now);
      if (moved !== null) emitAskEvent(db, { type: "ask.status", askId: s.ask.id, status: askTo }, o.now);
    }

    // 回答（窓口の報告・並列は Kernel が組み立て）。確認が残っていても待たず、済んだら手が要るものの行だけを書き換える
    if (plan.answerReady && plan.status !== "waiting_input") {
      const tasksNow = created.length > 0 ? [...s.tasks, ...created] : s.tasks;
      const composed = composeRunAnswer(db, { ask: s.ask, run: s.run, members: s.members, tasks: tasksNow });
      persistAnswer(db, s.run, composed, o.now);
    }
    if (status === "done" || status === "failed") {
      appendAuditLog(db, { eventType: "ask.run.finished", actorType: "system", actorId: "asks", payload: { askId: s.ask.id, askRunId: runId, status } }, o.now);
    }
    return { tasks: created, runStatus: status };
  });
}

// ---- 実行を始める ----

/** 実行を始めるトランザクションの中身。動いている実行があれば null */
export function beginRunTx(db: WsDb, askId: Uuid, trigger: AskRunTrigger, now: Date): AskRunRow | null {
  return db.transaction(() => {
    if (getWorkspace(db) === null) throw new AppError("NOT_FOUND");
    const ask = getAsk(db, askId);
    if (ask === null) throw new AppError("NOT_FOUND");
    if (ask.status !== "running" && ask.status !== "done") return null;
    const r = insertLiveRun(db, askId, trigger, now);
    if (r === null) return null;
    appendAuditLog(db, { eventType: "ask.run.started", actorType: "system", actorId: "asks", payload: { askId, askRunId: r.id, runNo: r.run_no, trigger } }, now);
    if (ask.status === "done") {
      // 終わった依頼に返事・手動で動かすとき：もう一度動かす
      const moved = transitionAsk(db, askId, ["done"], "running", now);
      if (moved !== null) emitAskEvent(db, { type: "ask.status", askId, status: "running" }, now);
    }
    return r;
  });
}

/**
 * 本番の実行を始める（初回・手動・定期・返事）：実行の行を作り、最初の1歩（advanceTx）で担当のタスクを queued で作る。1つのトランザクション。
 * 動いている実行があれば始めず null。
 * Node 版の startAskRun の DB 側（driveRun の最初の歩みまで）。作ったタスクを動かすのは呼ぶ側（4c）
 */
export function startAskRunTx(
  db: WsDb,
  askId: Uuid,
  o: { requesterId: Uuid; trigger: AskRunTrigger; now: Date; reply?: string; replyOf?: Uuid },
): { run: AskRunRow; tasks: TaskRow[] } | null {
  return db.transaction(() => {
    const begun = beginRunTx(db, askId, o.trigger, o.now);
    if (begun === null) return null;
    const step = advanceTx(db, begun.id, {
      requesterId: o.requesterId,
      now: o.now,
      ...(o.reply === undefined ? {} : { reply: o.reply }),
      ...(o.replyOf === undefined ? {} : { replyOf: o.replyOf }),
    });
    return { run: getAskRun(db, begun.id) ?? begun, tasks: step.tasks };
  });
}
