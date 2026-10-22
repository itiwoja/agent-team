// 編成の実行（FR-062）：ask_members の段ごとにタスクを作り、形（ひとり・並列・まとめ・順番）に従って動かす。
// 新しい実行経路は作らない：タスクを作る → タスクのトークン → runner の runTask → edge（createEdge：LLM Proxy・decide・Intent の記録）→ gateway。
// 書き込みは必ず Kernel（decide）→ gateway を通る。
// 進め方：いまのタスクの状態から evaluateRun（plan.ts。純粋関数）が「次に始める担当・実行の状態・回答を出してよいか」を決め、
//   advanceTx（1つのトランザクション）が「担当のタスクを作る（queued）・実行と依頼の状態・回答・SSE の事象」を書く。
//   タスクは別のトランザクションの外で動かす（外部を呼ぶのはトランザクションの外：G-14）。ワークスペースの行のロックで、同じ実行を同時に進めるのを直列にする。
//   プロセスが落ちても DB の状態から続きを決められる（advanceAsk を tick・承認の確定から呼ぶ：取りこぼしの拾い直し）

import {
  appendAuditLog,
  getWorkspace,
  lockWorkspace,
  type AskMemberRow,
  type AskRow,
  type AskRunRow,
  type AskRunTrigger,
  type SessionCtx,
  type TaskRow,
  type Tx,
  type Uuid,
  type WsCtx,
} from "@open-team/db";
import { countActiveLiveTasks, getAgentRow, getTask } from "@open-team/db/edge";
import { claimQueuedTask, expireQuestionsOfTask, getAsk, getPreviousReportTask, getAskRun, getLatestLiveRun, hasActiveLiveRun, insertAskTask, insertLiveRun, insertPendingReply, listMembers, markPendingReplyConsumed, peekPendingReply, listRunTasks, markFirstMemberStarted, transitionAsk, transitionRun } from "@open-team/db/asks";
import { SPEND_LIMITS, canStartWork, createEdge, failTask, haltTask, issueTaskToken, replyWebUrlHashes, userTextWebUrlHashes, type EdgeDeps, type EdgeHooks } from "@open-team/edge";
import { taintFromInputs } from "@open-team/kernel";
import { runTask } from "@open-team/runner";
import { AppError } from "@open-team/platform";
import type { AppDeps } from "../deps.ts";
import { productionEdgeHooks } from "../check/hooks.ts";
import { TRUSTED_SKILLS } from "../packs/catalog.ts";
import { StopRequested } from "../registry.ts";
import { composeRunAnswer, latestTaskByMember, persistAnswer } from "./answer.ts";
import { emitAskEvent } from "./events.ts";
import { createFollowupsAfterTerminal, createFollowupTask, publishMessagePosted } from "./followup.ts";
import { stageStateOf, stopReasonOf } from "./format.ts";
import { evaluateRun, type PlanMember, type RunStatus } from "./plan.ts";

export type AskRunDeps = Pick<AppDeps, "db" | "log" | "clock" | "ids" | "llm" | "gatewayClient" | "registry" | "env" | "sleep"> & {
  /** 試験で差し替える（edge の LLM のやり直しの待ち・上限・費用の上限） */
  edge?: Partial<Pick<EdgeDeps, "retry" | "limits" | "spendLimits" | "newId" | "knownSecrets">>;
  /** 同時実行の待ちの間隔・上限（試験で短くする） */
  concurrency?: { pollMs: number; maxWaitMs: number };
  /** 作業場（D-116）。AppDeps の値。省略・null なら作業場の道具を渡さない */
  sandbox?: AppDeps["sandbox"];
};

type MemberRowN = AskMemberRow & { agent_name: string };

/** 1つの実行の中で同時に動かすタスクの上限が同時実行数（BR-08）を超えないための待ち */
const DEFAULT_CONCURRENCY_WAIT = { pollMs: 1_000, maxWaitMs: 10 * 60_000 };

// ---- 状態の読み出し ----

interface RunState {
  ask: AskRow;
  run: AskRunRow;
  /** この実行が動かす担当（返事の実行は窓口だけ） */
  members: MemberRowN[];
  allMembers: MemberRowN[];
  tasks: TaskRow[];
}

async function loadState(q: Tx, ctx: WsCtx, runId: Uuid): Promise<RunState | null> {
  const run = await getAskRun(q, ctx, runId);
  if (run === null) return null;
  const ask = await getAsk(q, ctx, run.ask_id);
  if (ask === null) return null;
  const allMembers = await listMembers(q, ctx, ask.id);
  // 返事の実行（trigger_type = manual）は窓口の担当だけを動かす（FR-063：回答への返事は窓口へのお願い）
  const members = run.trigger_type === "manual" ? allMembers.filter((m) => m.is_spokesperson) : allMembers;
  const tasks = await listRunTasks(q, ctx, runId);
  return { ask, run, members, allMembers, tasks };
}

/** 返事の実行は、形に関わらず1人だけを動かす（single として扱う） */
const effectiveShape = (s: RunState): NonNullable<AskRow["shape"]> => (s.run.trigger_type === "manual" ? "single" : (s.ask.shape ?? "single"));

function planMembers(s: RunState): PlanMember[] {
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
function askStatusFor(ask: AskRow, runStatus: RunStatus): AskRow["status"] {
  if (runStatus === "waiting_input") return "waiting_input";
  if (runStatus === "running") return "running";
  if (ask.trigger !== null) return "running";
  return runStatus;
}

// ---- タスクを作る（1つのトランザクションの中） ----

/** 担当のタスクを作る（queued）。受け渡し（input_task_ids）と汚染の引き継ぎ（BR-71）を決める。外部は呼ばない */
export async function createMemberTask(
  tx: Tx,
  ctx: WsCtx,
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
): Promise<TaskRow> {
  const agent = await getAgentRow(tx, ctx, member.agent_id);
  if (agent === null || agent.current_snapshot_id === null || (agent.status !== "active" && agent.status !== "idle")) {
    throw new AppError("TASK_NOT_RUNNABLE", `担当「${member.agent_name}」は動かせません`);
  }
  const byId = new Map([...s.tasks, ...(o.extraTasks ?? [])].map((t) => [t.id, t]));
  const nameOf = (t: TaskRow): string => s.members.find((m) => m.id === t.ask_member_id)?.agent_name ?? s.allMembers.find((m) => m.id === t.ask_member_id)?.agent_name ?? "担当";
  const inputs = inputTaskIds.flatMap((id) => {
    const t = byId.get(id);
    return t === undefined ? [] : [{ taskId: t.id, agentName: nameOf(t), taint: { tainted: t.tainted, sources: t.taint_sources } }];
  });
  const task = await insertAskTask(tx, ctx, {
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
    // - o.reply：回答への返事（routes/asks.ts の API-077 の body.text を maskUserText したもの）。ただし画面の「次はこれをしましょうか？」の
    //   ボタン（AskPage の NextActions）は、担当が書いた提案の文をそのまま返事として送る。提案と同じ文なら何も入れず、
    //   提案に出てくる URL も入れない（replyWebUrlHashes。提案は o.replySuggestions）
    // 担当の指示（プランナーの LLM が書いた instructions）と、前の段・前の回答のタスクの中身は入れない（それらの見た URL は db 側で集合ごと写す）
    userWebUrlHashes: [...userTextWebUrlHashes([s.ask.text]), ...replyWebUrlHashes(o.reply, o.replySuggestions ?? [])],
    // 前の回答のタスク（返事の実行）・前の回の報告のタスク（定期の見張り）は、入力の並べ方にかかわらず集合を写す（同じワークスペースのものだけ）
    inheritWebUrlsFrom: (o.extraTasks ?? []).map((t) => t.id),
    now: o.now,
  });
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "ask.step.started",
      actorType: "system",
      actorId: "asks",
      taskId: task.id,
      payload: { askId: s.ask.id, askRunId: s.run.id, memberId: member.id, taskId: task.id, inputTaskIds: [...inputTaskIds], tainted: task.tainted },
    },
    o.now,
  );
  await emitAskEvent(
    tx,
    ctx,
    { type: "ask.step.started", askId: s.ask.id, runId: s.run.id, memberId: member.id, agentName: member.agent_name, taskId: task.id, position: member.position },
    o.now,
  );
  return task;
}

/** 担当に渡す「お願い」の本文（依頼の文。返事の実行は返事の文）。秘密情報は依頼・返事を受けるときにマスク済み */
function promptOf(s: RunState, reply?: string): string | null {
  return reply ?? s.ask.text;
}

// ---- 1歩進める ----

interface StepResult {
  /** この歩みで作ったタスク（あとで動かす） */
  tasks: TaskRow[];
  runStatus: RunStatus | null;
}

/**
 * 実行を1歩進める（1つのトランザクション）：評価 → 作るタスク → 実行・依頼の状態 → 回答。
 * Kill Switch 発動中は何も始めない（状態は Kill Switch の hook が cancelled にする）。動いていない実行は何もしない
 */
export async function advanceTx(tx: Tx, ctx: WsCtx, runId: Uuid, o: { requesterId: Uuid; now: Date; aggregatorWaitMs?: number; reply?: string; replyOf?: Uuid }): Promise<StepResult> {
  const ws = await lockWorkspace(tx, ctx);
  if (ws === null || ws.kill_switch_engaged) return { tasks: [], runStatus: null };
  const s = await loadState(tx, ctx, runId);
  if (s === null || s.run.status !== "running") return { tasks: [], runStatus: null };
  const plan = evaluateRun({
    shape: effectiveShape(s),
    members: planMembers(s),
    now: o.now,
    firstStartedAt: s.run.first_member_started_at,
    ...(o.aggregatorWaitMs === undefined ? {} : { aggregatorWaitMs: o.aggregatorWaitMs }),
  });

  // 返事の実行：前の回答のタスクを「データ」として渡す（汚染も引き継ぐ）
  const replyTask = o.replyOf === undefined ? null : await getTask(tx, ctx, o.replyOf);
  // 定期の実行（見張り）：最初の段の担当に、その担当の前の回の報告を渡す（前回と比べて変化を判断する。汚染も引き継ぐ）
  const previousOf = async (member: MemberRowN, inputTaskIds: readonly Uuid[]): Promise<TaskRow | null> =>
    s.run.trigger_type === "schedule" && replyTask === null && inputTaskIds.length === 0 && !member.is_aggregator
      ? getPreviousReportTask(tx, ctx, member.id, s.run.id)
      : null;
  // 担当のタスクを作る
  const created: TaskRow[] = [];
  let failedToStart: string | null = null;
  for (const st of plan.start) {
    const member = s.members.find((m) => m.id === st.memberId);
    if (member === undefined) continue;
    try {
      const previous = await previousOf(member, st.inputTaskIds);
      const extra = replyTask ?? previous;
      created.push(
        await createMemberTask(tx, ctx, s, member, extra === null ? st.inputTaskIds : [extra.id], {
          requesterId: o.requesterId,
          prompt: promptOf(s, o.reply),
          now: o.now,
          ...(extra === null ? {} : { extraTasks: [extra] }),
          ...(o.reply === undefined ? {} : { reply: o.reply }),
          // 画面の提案のボタンが出すのは、最新の実行の回答のタスク（ask_runs.answer_task_id）の report_meta.nextActions（answer.ts の answerExtrasOf）。
          // 返事の API（routes/asks.ts の API-077）は replyOf にその answer_task_id を渡すので、replyTask の提案がボタンの文と同じものになる
          ...(o.reply === undefined || replyTask === null ? {} : { replySuggestions: replyTask.report_meta?.nextActions ?? [] }),
        }),
      );
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== "TASK_NOT_RUNNABLE") throw e;
      failedToStart = member.agent_name;
    }
  }
  if (created.length > 0) await markFirstMemberStarted(tx, ctx, runId, o.now);
  if (failedToStart !== null) {
    // 担当が動かせない（停止・削除）：実行を失敗として閉じる（作った分は動かす）。依頼は止まった旨を回答に出す
    plan.status = "failed";
  }

  // 実行・依頼の状態
  let status: RunStatus = created.length > 0 ? "running" : plan.status;
  if (status !== s.run.status) {
    const moved = await transitionRun(tx, ctx, runId, ["running"], status, o.now);
    if (moved === null) return { tasks: created, runStatus: null };
  }
  const askTo = askStatusFor(s.ask, status);
  if (askTo !== s.ask.status) {
    const moved = await transitionAsk(tx, ctx, s.ask.id, ["running", "waiting_input"], askTo, o.now);
    if (moved !== null) await emitAskEvent(tx, ctx, { type: "ask.status", askId: s.ask.id, status: askTo }, o.now);
  }

  // 回答（窓口の報告・並列は Kernel が組み立て）。確認が残っていても待たず、済んだら手が要るものの行だけを書き換える
  if (plan.answerReady && plan.status !== "waiting_input") {
    const tasksNow = created.length > 0 ? [...s.tasks, ...created] : s.tasks;
    const composed = await composeRunAnswer(tx, ctx, { ask: s.ask, run: s.run, members: s.members, tasks: tasksNow });
    await persistAnswer(tx, ctx, s.run, composed, o.now);
  }
  if (status === "done" || status === "failed") {
    await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.run.finished", actorType: "system", actorId: "asks", payload: { askId: s.ask.id, askRunId: runId, status } }, o.now);
  }
  return { tasks: created, runStatus: status };
}

// ---- タスクを動かす（トランザクションの外） ----

/** 動かしている追いのターン（試験が settleFollowups で待つ。プロセスの中だけ） */
const followupRuns = new Set<Promise<void>>();

/** 追いのターンのタスクをバックグラウンドで動かす（連絡を送った担当を待たせない。同時実行数・費用の確かめは executeTask の中） */
function runFollowups(deps: AskRunDeps, ctx: WsCtx, made: ReadonlyArray<{ task: TaskRow; member: MemberRowN }>): void {
  for (const { task, member } of made) {
    const p: Promise<void> = executeTask(deps, ctx, liveEdge(deps), task.id, member)
      .catch((error) => deps.log.error("ask.followup_crashed", "追いのターンが想定外の失敗で止まった", { workspaceId: ctx.workspaceId, taskId: task.id, error }))
      .finally(() => followupRuns.delete(p));
    followupRuns.add(p);
  }
}

/** 追いのターンがすべて落ち着くまで待つ（試験用） */
export async function settleFollowups(): Promise<void> {
  while (followupRuns.size > 0) await Promise.allSettled([...followupRuns]);
}

/** 連絡板の hook（FR-064）：連絡を SSE で届け、終わった担当への質問は追いのターンを起こす。終わったタスクに残った質問も拾う */
function teamHooks(deps: AskRunDeps, base: NonNullable<EdgeHooks>): NonNullable<EdgeHooks> {
  return {
    ...base,
    async onTeamMessagePosted(ctx, e) {
      await publishMessagePosted(deps, ctx, e.askId, e.messageId);
      if (e.kind !== "question") return;
      const made = await createFollowupTask(deps, ctx, e.messageId, e.askId);
      if (made !== null) runFollowups(deps, ctx, [made]);
    },
    // 担当から利用者への質問（ask_user）：依頼の画面に知らせる（画面は取り直して質問のカードを出す・消す）
    async onAgentQuestion(ctx, e) {
      await base.onAgentQuestion?.(ctx, e);
      const now = deps.clock.now();
      await deps.db.transaction((tx) => emitAskEvent(tx, ctx, { type: "ask.agent_question", askId: e.askId, questionId: e.questionId, status: e.status }, now));
    },
    async onTaskTerminal(ctx, e) {
      await base.onTaskTerminal?.(ctx, e);
      // 終わったタスクの質問は、もう誰も答えを待っていない
      await expireQuestionsOfTask(deps.db, ctx, e.taskId);
      const t = await getTask(deps.db, ctx, e.taskId);
      if (t !== null) runFollowups(deps, ctx, await createFollowupsAfterTerminal(deps, ctx, t));
    },
  };
}

/** edge を組み立てる（本番のタスク。書き込みは decide → Intent → gateway。承認なしで通る Intent（ルールの allow）だけここから gateway を起こす） */
function liveEdge(deps: AskRunDeps) {
  return createEdge({
    db: deps.db,
    llm: deps.llm,
    gateway: deps.gatewayClient,
    clock: deps.clock,
    log: deps.log,
    models: { agentModel: deps.env.gemini.agentModel, plannerModel: deps.env.gemini.plannerModel },
    // Haiku 5.5 uses more tokens for the same text; file-producing calls need room.
    ...(deps.env.llm?.provider === "anthropic" && deps.env.gemini.agentModel === "claude-haiku-5-5" ? { limits: { maxTokensDefault: 8192 }, retry: { delaysMs: [] } } : {}),
    signalFor: (taskId) => deps.registry.get(taskId)?.controller.signal,
    hooks: teamHooks(deps, productionEdgeHooks(deps)),
    // 作業場（D-116）：本番の依頼のタスクだけ（edge が sandboxAllowed で絞る）
    ...(deps.sandbox == null ? {} : { sandbox: deps.sandbox }),
    // load_skill が信頼して渡すスキル（運営のパックと同じ中身だけ：SG-05）
    trustedSkills: TRUSTED_SKILLS,
    ...deps.edge,
  });
}

/**
 * 同時実行数（BR-08）・費用の上限・Kill Switch を確かめて、タスクを取る（queued → provisioning）。待つのは同時実行数だけ。
 * 確かめ（canStartWork）はロックの外で読むので、取るときにワークスペースの行をロックしたうえで同時実行数を数え直す（確かめと取得の間に
 * ほかの取得が入っても上限を超えない）。上限なら queued のまま待つ。取れたら発行したトークンを返す
 */
export type StartOutcome = { kind: "started"; token: string } | { kind: "halt"; gate: "kill_switch" | "budget" | "timeout" } | { kind: "left" };

export async function startWhenRoom(deps: AskRunDeps, ctx: WsCtx, taskId: Uuid, signal: AbortSignal): Promise<StartOutcome> {
  const cfg = deps.concurrency ?? DEFAULT_CONCURRENCY_WAIT;
  let waited = 0;
  // 止める判断（Kill Switch・費用・timeout）は、ロックの中でタスクがまだ queued のときだけ halt にする。
  // 別の instance がすでに取っていた（provisioning/running など）なら、止めずに left（その実行が続きを担う）
  const haltIfQueued = (gate: "kill_switch" | "budget" | "timeout") =>
    deps.db.transaction(async (tx): Promise<StartOutcome> => {
      await lockWorkspace(tx, ctx);
      const t = await getTask(tx, ctx, taskId);
      return t !== null && t.status === "queued" ? { kind: "halt", gate } : { kind: "left" };
    });
  for (;;) {
    // 取る前に止められた：プロセスの停止なら取らずに残す（queued のまま。次のプロセスが拾う）。Kill Switch なら止める
    if (signal.aborted) return signal.reason instanceof StopRequested && signal.reason.stopCause === "shutdown" ? { kind: "left" } : haltIfQueued("kill_switch");
    const ws = await getWorkspace(deps.db, ctx);
    if (ws === null) return haltIfQueued("kill_switch");
    const r = await canStartWork(deps.db, ws, deps.clock.now(), { ...SPEND_LIMITS, ...deps.edge?.spendLimits });
    if (!r.ok && r.reason === "kill_switch") return haltIfQueued("kill_switch");
    if (!r.ok && r.reason !== "concurrency") return haltIfQueued("budget");
    if (r.ok) {
      const got = await deps.db.transaction(async (tx) => {
        const locked = await lockWorkspace(tx, ctx);
        if (locked === null || locked.kill_switch_engaged) return "kill" as const;
        const current = await getTask(tx, ctx, taskId);
        if (current === null || current.status !== "queued") return "gone" as const;
        if ((await countActiveLiveTasks(tx, ctx)) >= locked.max_concurrent_tasks) return "full" as const;
        const c = await claimQueuedTask(tx, ctx, taskId, deps.clock.now());
        if (c === null) return "gone" as const;
        return { token: await issueTaskToken(tx, ctx, taskId, deps.clock.now()) };
      });
      if (got === "kill") return haltIfQueued("kill_switch");
      if (got === "gone") return { kind: "left" };
      if (got !== "full") return { kind: "started", token: got.token };
      // 上限まで取られていた：待つ（下）
    }
    if (waited >= cfg.maxWaitMs) return haltIfQueued("timeout");
    await deps.sleep(cfg.pollMs);
    waited += cfg.pollMs;
  }
}

const TERMINAL = new Set(["succeeded", "completed", "rejected", "failed", "cancelled", "halted"]);

// ---- 停止（プロセスの終了）。SIGTERM・SIGINT で呼ぶ（server.ts） ----

let stopping = false;

/** プロセスを止めるとき：これから新しくタスクを取らない・実行を歩めない（queued のまま残す。次のプロセスの tick が拾って動かす） */
export function stopStartingAskTasks(): void {
  stopping = true;
}

/** 試験用：停止の印を外す */
export function resetAskStopForTest(): void {
  stopping = false;
}

/** 動いている実行の後始末（中断したタスクを failed にする）が終わるまで待つ。上限の時間で打ち切る */
export async function settleDrivingRuns(timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const settle = async () => {
    while (driving.size > 0 || followupRuns.size > 0) {
      await Promise.allSettled([
        ...[...driving.values()].map((s) => s.promise),
        ...followupRuns,
      ]);
    }
  };
  await Promise.race([settle(), timeout]);
  clearTimeout(timer);
}

/** 段の終わりを SSE に出す（追いのターンは段の状態を変えないので出さない：FR-064）。tx の中で呼ぶ */
export async function emitStepFinished(tx: Tx, ctx: WsCtx, task: TaskRow, member: { id: Uuid; agent_name: string }, at: Date): Promise<void> {
  if (task.kind !== "normal") return;
  const st = stageStateOf(task);
  await emitAskEvent(
    tx,
    ctx,
    { type: "ask.step.finished", askId: task.ask_id ?? "", runId: task.ask_run_id ?? "", memberId: member.id, agentName: member.agent_name, taskId: task.id, state: st.state, stateText: st.text },
    at,
  );
}

/**
 * タスクを1件動かす。終わったら ask.step.finished。想定外の失敗・止まらずに残ったタスクは failed にする（running のまま残さない）。
 * 中断：Kill Switch・終了状態の中断は halt・task_terminated の側が済んでいる。プロセスの終了（shutdown）で中断したものは sandbox_lost で failed にする
 * （やり直しは利用者が決める：順番の失敗からの再開。取り直すと、外部への書き込みが二重になるおそれがあるので自動ではやり直さない）
 */
export async function executeTask(deps: AskRunDeps, ctx: WsCtx, edge: ReturnType<typeof liveEdge>, taskId: Uuid, member: MemberRowN): Promise<void> {
  if (stopping) return;
  const controller = new AbortController();
  deps.registry.register(taskId, ctx.workspaceId, controller, "task");
  let ended: "report_submitted" | "finished" | "halted" | "unauthorized" | "aborted" | "llm_unavailable" | "error" = "error";
  try {
    const start = await startWhenRoom(deps, ctx, taskId, controller.signal);
    if (start.kind === "left") return;
    if (start.kind === "halt") {
      const gate = start.gate;
      await deps.db.transaction(async (tx) => {
        const at = deps.clock.now();
        await lockWorkspace(tx, ctx);
        const t = await getTask(tx, ctx, taskId);
        if (t === null || t.status !== "queued") return;
        if (gate === "kill_switch") await haltTask(tx, ctx, t, { reason: "kill_switch" }, at);
        else await haltTask(tx, ctx, t, { reason: gate === "budget" ? "budget_exceeded" : "timeout", audit: { scope: "ask_start", gate } }, at);
      });
      ended = "halted";
    } else {
      const r = await runTask(edge, start.token, { signal: controller.signal });
      ended = r.end;
    }
  } catch (error) {
    if (controller.signal.aborted || controller.signal.reason instanceof StopRequested) ended = "aborted";
    else deps.log.error("ask.task_crashed", "依頼の担当のタスクが想定外の失敗で止まった", { workspaceId: ctx.workspaceId, taskId, error });
  } finally {
    deps.registry.unregister(taskId);
  }
  const stoppedBy = controller.signal.reason instanceof StopRequested ? controller.signal.reason.stopCause : null;

  // 後始末：終わっていない（running などで残った）タスクは failed にする
  await deps.db.transaction(async (tx) => {
    const at = deps.clock.now();
    await lockWorkspace(tx, ctx);
    const t = await getTask(tx, ctx, taskId);
    if (t === null) return;
    const open = !TERMINAL.has(t.status) && t.status !== "awaiting_approval" && t.status !== "executing";
    // 停止（shutdown）で中断したものは、止めた理由どおり sandbox_lost（LLM の呼び出し中の中断は halted(aborted) で返るので、ended より先に見る）
    if (open && stoppedBy === "shutdown") {
      await failTask(tx, ctx, t, "sandbox_lost", at, { cleanup: "shutdown" });
    } else if (open && ended !== "aborted") {
      await failTask(tx, ctx, t, ended === "llm_unavailable" ? "llm_unavailable" : "agent_unable", at, { cleanup: "ask_run" });
    }
    const after = (await getTask(tx, ctx, taskId)) ?? t;
    await emitStepFinished(tx, ctx, after, member, at);
  });
}

// ---- 実行を動かし続ける ----

const driving = new Map<Uuid, { again: boolean; promise: Promise<void> }>();

/**
 * 実行を、動かすタスクがなくなるまで進める（バックグラウンドで呼ぶ。例外は投げずログに残す）。
 * 同じ実行を同時に2つ動かさない：動いている間に呼ばれたら「もう一度見る」印だけ付けて、動いているほうの終わりを返す。
 * 担当のタスクは同時に動かし（ワークスペースの同時実行数まで）、1つ終わるたびに1歩進める。
 * 全員の終わりを待たないので、依存が済んだ担当は、ほかの担当が動いている間に始まる
 */
export function driveRun(deps: AskRunDeps, ctx: WsCtx, runId: Uuid, o: { requesterId: Uuid; reply?: string; replyOf?: Uuid; aggregatorWaitMs?: number }): Promise<void> {
  const existing = driving.get(runId);
  if (existing !== undefined) {
    existing.again = true;
    return existing.promise;
  }
  // 先に登録する（中身が同期に終わっても、後始末の delete が登録より先に走って古い印が残らないように）
  const state = { again: false, promise: Promise.resolve() };
  driving.set(runId, state);
  state.promise = (async () => {
    const edge = liveEdge(deps);
    // 動かしているタスク（終わると自分で消える）
    const inFlight = new Map<Uuid, Promise<void>>();
    try {
      for (;;) {
        // 停止の最中は歩まない（残りは queued のまま。次のプロセスの tick が拾う）
        if (stopping) break;
        state.again = false;
        const step = await deps.db.transaction((tx) => advanceTx(tx, ctx, runId, { ...o, now: deps.clock.now() }), { retryOnce: true });
        // この歩みで作ったタスクと、queued のまま残っているタスク（承認の確定の hook が作ったもの・落ちたインスタンスのもの）
        const queued = (await listRunTasks(deps.db, ctx, runId)).filter((t) => t.status === "queued" && deps.registry.get(t.id) === undefined);
        const todo = [...new Map([...step.tasks, ...queued].map((t) => [t.id, t])).values()].filter((t) => !inFlight.has(t.id));
        if (todo.length > 0) {
          const all = await listMembers(deps.db, ctx, todo[0]!.ask_id as Uuid);
          const ws = await getWorkspace(deps.db, ctx);
          const limit = Math.max(1, ws?.max_concurrent_tasks ?? 2);
          // 上限を超えた分は queued のまま残り、どれかが終わった次の歩みで拾う
          for (const t of todo) {
            if (inFlight.size >= limit) break;
            const member = all.find((m) => m.id === t.ask_member_id);
            if (member === undefined) continue;
            const p = executeTask(deps, ctx, edge, t.id, member)
              .catch((error) => deps.log.error("ask.run_failed", "依頼の実行を進められなかった", { workspaceId: ctx.workspaceId, askRunId: runId, taskId: t.id, error }))
              .finally(() => inFlight.delete(t.id));
            inFlight.set(t.id, p);
          }
        }
        if (inFlight.size > 0) {
          await Promise.race(inFlight.values());
          continue;
        }
        if (state.again) continue;
        break;
      }
    } catch (error) {
      deps.log.error("ask.run_failed", "依頼の実行を進められなかった", { workspaceId: ctx.workspaceId, askRunId: runId, error });
    } finally {
      // 歩めなくなっても、始めたタスクは最後まで動かす（後始末は executeTask の中）
      await Promise.allSettled(inFlight.values());
      driving.delete(runId);
    }
    // 順番待ちの返事があれば、次の実行として始める（動かせないときは何もしない。取りこぼしは tick が拾う）
    if (!stopping) await startQueuedReplyAfter(deps, ctx, runId);
  })();
  return state.promise;
}

export interface StartRunResult {
  run: AskRunRow;
  /** 実行が落ち着くまで（動かすタスクがなくなるまで）。呼び出し側は待たなくてよい（試験は待つ） */
  done: Promise<void>;
}

/** 実行を始めるトランザクションの中身（ワークスペースの行ロックの中で）。動いている実行があれば null。Kill Switch 発動中は 423 */
async function beginRunTx(tx: Tx, ctx: WsCtx, askId: Uuid, trigger: AskRunTrigger, now: Date): Promise<AskRunRow | null> {
  const ws = await lockWorkspace(tx, ctx);
  if (ws === null) throw new AppError("NOT_FOUND");
  if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
  const ask = await getAsk(tx, ctx, askId);
  if (ask === null) throw new AppError("NOT_FOUND");
  if (ask.status !== "running" && ask.status !== "done") return null;
  const r = await insertLiveRun(tx, ctx, askId, trigger, now);
  if (r === null) return null;
  await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.run.started", actorType: "system", actorId: "asks", payload: { askId, askRunId: r.id, runNo: r.run_no, trigger } }, now);
  if (ask.status === "done") {
    // 終わった依頼に返事・手動で動かすとき：もう一度動かす
    const moved = await transitionAsk(tx, ctx, askId, ["done"], "running", now);
    if (moved !== null) await emitAskEvent(tx, ctx, { type: "ask.status", askId, status: "running" }, now);
  }
  return r;
}

/**
 * 本番の実行を始める（初回・手動・定期・返事）。動いている実行があれば始めず null。Kill Switch 発動中は 423。
 * 担当のタスクはバックグラウンドで動かす
 */
export async function startAskRun(
  deps: AskRunDeps,
  ctx: WsCtx,
  askId: Uuid,
  o: { requesterId: Uuid; trigger: AskRunTrigger; reply?: string; replyOf?: Uuid },
): Promise<StartRunResult | null> {
  const now = deps.clock.now();
  const run = await deps.db.transaction((tx) => beginRunTx(tx, ctx, askId, o.trigger, now));
  if (run === null) return null;
  const done = driveRun(deps, ctx, run.id, { requesterId: o.requesterId, ...(o.reply === undefined ? {} : { reply: o.reply }), ...(o.replyOf === undefined ? {} : { replyOf: o.replyOf }) });
  return { run, done };
}

// ---- 順番待ちの返事（動いている間に送った返事。終わったら古い順に1つずつ始める） ----

/**
 * 返事を順番待ちに入れる。ワークスペースの行ロックの中で「動いている実行がある、または先に待っている返事がある」ことを確かめてから入れる
 * （確かめと入れるのの間に実行が終わって取りこぼすのを防ぐ。実行の終わりも同じロックの中。先の返事を追い越さない）。
 * どちらもなければ入れず null（呼び出し側がそのまま始める）。
 * 動いている実行がなく先の返事だけが残っているとき（tick 待ち）は、すぐ始めるよう促す（kick）
 */
export async function queueReply(deps: AskRunDeps, ctx: WsCtx, askId: Uuid, o: { requesterId: Uuid; text: string }): Promise<{ replyId: Uuid; kick: Promise<void> } | null> {
  const now = deps.clock.now();
  const queued = await deps.db.transaction(async (tx) => {
    const ws = await lockWorkspace(tx, ctx);
    if (ws === null) throw new AppError("NOT_FOUND");
    if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
    if (!(await hasActiveLiveRun(tx, ctx, askId)) && (await peekPendingReply(tx, ctx, askId)) === null) return null;
    const row = await insertPendingReply(tx, ctx, askId, { text: o.text, requesterId: o.requesterId, now });
    await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.reply.queued", actorType: "user", actorId: o.requesterId, payload: { askId, replyId: row.id } }, now);
    await emitAskEvent(tx, ctx, { type: "ask.reply.queue", askId, replyId: row.id, status: "queued" }, now);
    return row.id;
  });
  if (queued === null) return null;
  const kick = startQueuedReply(deps, ctx, askId)
    .then((r) => r?.done)
    .catch((error) => deps.log.warn("ask.queued_reply_failed", "順番待ちの返事を始められなかった", { workspaceId: ctx.workspaceId, askId, error }));
  return { replyId: queued, kick: kick.then(() => undefined) };
}

/**
 * 順番待ちのいちばん古い返事で、返事の実行を始める（動いている実行がある・待ちがない・始められない依頼なら null）。
 * 実行を作るのと消化の印は同じトランザクション（二重に始めない：insertLiveRun が動いている実行で null、印は未消化のときだけ付く）
 */
export async function startQueuedReply(deps: AskRunDeps, ctx: WsCtx, askId: Uuid): Promise<StartRunResult | null> {
  const now = deps.clock.now();
  const begun = await deps.db.transaction(async (tx) => {
    const ws = await lockWorkspace(tx, ctx);
    if (ws === null || ws.kill_switch_engaged) return null;
    const pending = await peekPendingReply(tx, ctx, askId);
    if (pending === null) return null;
    // 直前の実行の回答（返事の元）。実行を作る前に読む
    const previous = await getLatestLiveRun(tx, ctx, askId);
    const run = await beginRunTx(tx, ctx, askId, "manual", now);
    if (run === null) return null;
    if (!(await markPendingReplyConsumed(tx, ctx, pending.id, now))) throw new Error("順番待ちの返事を消化できなかった");
    await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.reply.started", actorType: "system", actorId: "asks", payload: { askId, askRunId: run.id, replyId: pending.id } }, now);
    await emitAskEvent(tx, ctx, { type: "ask.reply.queue", askId, replyId: pending.id, status: "started" }, now);
    return { run, pending, replyOf: previous?.answer_task_id ?? null };
  });
  if (begun === null) return null;
  const done = driveRun(deps, ctx, begun.run.id, {
    requesterId: begun.pending.requester_id as Uuid,
    reply: begun.pending.text,
    ...(begun.replyOf === null ? {} : { replyOf: begun.replyOf as Uuid }),
  });
  return { run: begun.run, done };
}

/** 実行が終わったあと、順番待ちの返事があれば始めて、その実行が落ち着くまで待つ（例外は投げずログに残す） */
async function startQueuedReplyAfter(deps: AskRunDeps, ctx: WsCtx, runId: Uuid): Promise<void> {
  try {
    const run = await getAskRun(deps.db, ctx, runId);
    if (run === null) return;
    const started = await startQueuedReply(deps, ctx, run.ask_id as Uuid);
    if (started !== null) await started.done;
  } catch (error) {
    deps.log.warn("ask.queued_reply_failed", "順番待ちの返事を始められなかった", { workspaceId: ctx.workspaceId, askRunId: runId, error });
  }
}

/** 動いている実行の続きを進める（tick・承認の確定・取りこぼしの拾い直し。冪等）。動いている実行がなければ何もしない */
export async function advanceAsk(deps: AskRunDeps, ctx: WsCtx, askId: Uuid): Promise<void> {
  const ask = await getAsk(deps.db, ctx, askId);
  if (ask === null) return;
  const run = await getLatestLiveRun(deps.db, ctx, askId);
  if (run === null || run.status !== "running") return;
  await driveRun(deps, ctx, run.id, { requesterId: ask.created_by });
}

// ---- 順番の失敗からの再開（API-074） ----

export type ResumeAction = "retry" | "finish";

/**
 * 順番の止まった段について、「やり直す」（止まった担当に新しいタスクを作って再開）か「ここまでで終える」（止まった旨を回答にして終える）。
 * waiting_input でなければ 409 ASK_NOT_WAITING
 */
export async function resumeAsk(deps: AskRunDeps, s: SessionCtx, askId: Uuid, action: ResumeAction): Promise<{ ask: AskRow; done: Promise<void> | null }> {
  const now = deps.clock.now();
  const ctx: WsCtx = s;
  const out = await deps.db.transaction(async (tx) => {
    const ws = await lockWorkspace(tx, ctx);
    if (ws === null) throw new AppError("NOT_FOUND");
    if (ws.kill_switch_engaged) throw new AppError("KILL_SWITCH_ENGAGED");
    const ask = await getAsk(tx, ctx, askId);
    if (ask === null) throw new AppError("NOT_FOUND");
    if (ask.status !== "waiting_input") throw new AppError(ask.status === "done" || ask.status === "failed" || ask.status === "cancelled" ? "ASK_ALREADY_FINISHED" : "ASK_NOT_WAITING");
    const run = await getLatestLiveRun(tx, ctx, askId);
    if (run === null || run.status !== "waiting_input") throw new AppError("ASK_NOT_WAITING");
    const state = await loadState(tx, ctx, run.id);
    if (state === null) throw new AppError("NOT_FOUND");
    const plan = evaluateRun({ shape: effectiveShape(state), members: planMembers(state), now, firstStartedAt: run.first_member_started_at });
    const stoppedId = plan.stoppedMemberId;
    const stopped = state.members.find((m) => m.id === stoppedId);
    if (stopped === undefined) throw new AppError("ASK_NOT_WAITING");
    const latest = latestTaskByMember(state.tasks);
    const stoppedTask = latest.get(stopped.id) ?? null;

    if (action === "retry") {
      // 止まった担当に新しいタスクを作る（依存する段の結果を同じように渡す）
      const inputs = state.members
        .filter((m) => !m.is_aggregator && m.position !== null && stopped.depends_on.includes(m.position))
        .flatMap((m) => latest.get(m.id)?.id ?? []);
      await createMemberTask(tx, ctx, state, stopped, inputs, { requesterId: s.userId, prompt: promptOf(state), now });
      await transitionRun(tx, ctx, run.id, ["waiting_input"], "running", now);
      const moved = await transitionAsk(tx, ctx, askId, ["waiting_input"], "running", now);
      await emitAskEvent(tx, ctx, { type: "ask.status", askId, status: "running" }, now);
      await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.resumed", actorType: "user", actorId: s.userId, payload: { askId, askRunId: run.id, action, memberId: stopped.id } }, now);
      return { ask: moved ?? ask, runId: run.id, retry: true };
    }

    // finish：止まった旨を回答にして終える
    const composed = await composeRunAnswer(
      tx,
      ctx,
      { ask: state.ask, run, members: state.members, tasks: state.tasks },
      { stoppedBeforeEnd: { agentName: stopped.agent_name, reason: stoppedTask === null ? "止めました" : stopReasonOf(stoppedTask) } },
    );
    await persistAnswer(tx, ctx, run, composed, now);
    await transitionRun(tx, ctx, run.id, ["waiting_input"], "done", now);
    const to = askStatusFor(state.ask, "done");
    const moved = await transitionAsk(tx, ctx, askId, ["waiting_input"], to, now);
    await emitAskEvent(tx, ctx, { type: "ask.status", askId, status: to }, now);
    await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.resumed", actorType: "user", actorId: s.userId, payload: { askId, askRunId: run.id, action, memberId: stopped.id } }, now);
    return { ask: moved ?? ask, runId: run.id, retry: false };
  });
  const done = out.retry ? driveRun(deps, ctx, out.runId, { requesterId: s.userId }) : null;
  return { ask: out.ask, done };
}

// ---- Kill Switch ----

/**
 * Kill Switch で止めたタスクの依頼：実行と依頼を cancelled にする（同じトランザクションで。tasksTerminated の hook。外部は呼ばない）。
 * 生成中の依頼は、登録簿の中断（StopRequested）を受けた生成の側が failed（kill_switch）にする
 */
export async function cancelRunsOfHaltedTasks(
  tx: Tx,
  ctx: WsCtx,
  tasks: ReadonlyArray<{ askId: Uuid | null; askRunId: Uuid | null }>,
  now: Date,
): Promise<void> {
  const runIds = [...new Set(tasks.flatMap((t) => (t.askRunId === null ? [] : [t.askRunId])))];
  for (const runId of runIds) {
    const run = await transitionRun(tx, ctx, runId, ["running", "waiting_input"], "cancelled", now);
    if (run === null) continue;
    const moved = await transitionAsk(tx, ctx, run.ask_id, ["running", "waiting_input"], "cancelled", now);
    if (moved !== null) await emitAskEvent(tx, ctx, { type: "ask.status", askId: run.ask_id, status: "cancelled" }, now);
    await appendAuditLog(tx, ctx.workspaceId, { eventType: "ask.cancelled", actorType: "system", actorId: "kill_switch", payload: { askId: run.ask_id, askRunId: runId } }, now);
  }
}
