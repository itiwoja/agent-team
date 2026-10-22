// 依頼の表示用ビュー（apps/app/src/asks/view.ts の表示の部分の WorkspaceDO 版。API-075 SCR-021・一覧・連絡板）。読むだけ。
// SQL は db/repo の asks ほか（同期の関数。DO そのものがワークスペース）。時刻は呼ぶ側（WorkspaceDO）が渡す
// 画面に出す固定の文（段の状態・手が要るもの・汚染の印・形の1行）はここで作って返し、画面はそのまま出す

import { handoffMark, taintReasonLine } from "@open-team/kernel";
import {
  countAskMessages,
  type AskMessageRow,
  firstPromptsOfRuns,
  getAsk,
  getLatestLiveRun,
  listAsks,
  listLiveRuns,
  listAskMessages,
  listAgentQuestions,
  listPendingReplies,
  listMembers,
  countPriorAsksOfAgents,
  countRejectedIntentsOfTasks,
  listPendingIntentsOfTasks,
  listRunTasks,
  listToolActivityOfTasks,
  plannerUsageOf,
} from "../../db/repo/asks.ts";
import { microToUsd } from "../../db/repo/costs.ts";
import { listTaskSnapshotSizes } from "../../db/repo/sandbox.ts";
import type { WsDb } from "../../db/sqlite.ts";
import type { AskRow, AskRunRow, TaskRow } from "../../db/types.ts";
import type {
  AskDetailResponse,
  AskMessageView,
  AskStatus,
  AskTurnView,
  HandoffView,
  ListAskMessagesResponse,
  ListAsksResponse,
  PendingIntentView,
  StageView,
} from "./contract.ts";
import { ACTIVITY_PER_TASK, activityByTask } from "./activity.ts";
import { ASK_TURN_LIMIT } from "./contract.ts";
import { latestTaskByMember, storedAnswerView } from "./answer.ts";
import { askSummary, formationView, reuseLineOf, stageStateOf, stopReasonOf } from "./format.ts";
import { evaluateRun, type PlanMember } from "./plan.ts";

type MemberRowN = ReturnType<typeof listMembers>[number];

const sortMembers = (ms: readonly MemberRowN[]): MemberRowN[] =>
  [...ms].sort((a, b) => Number(a.is_aggregator) - Number(b.is_aggregator) || (a.position ?? 99) - (b.position ?? 99));

/** 回答待ちの窓口の名前（回答がまだのとき「〇〇がまとめています」に使う） */
function spokespersonOf(ask: Pick<AskRow, "shape">, members: readonly MemberRowN[]): string | null {
  if (ask.shape === "parallel") return null;
  return members.find((m) => m.is_spokesperson)?.agent_name ?? null;
}

export function listAskSummaries(db: WsDb, o: { limit: number; status?: AskStatus }): ListAsksResponse {
  const rows = listAsks(db, o);
  const asks = [];
  for (const ask of rows) {
    const members = ask.shape === null ? [] : listMembers(db, ask.id);
    const run = getLatestLiveRun(db, ask.id);
    asks.push(askSummary(ask, { members, run }));
  }
  return { asks };
}

function stageViews(
  members: readonly MemberRowN[],
  latest: Map<string, TaskRow>,
  declined: ReadonlyMap<string, number> = new Map(),
  activity: ReadonlyMap<string, StageView["activity"]> = new Map(),
  files: ReadonlyMap<string, { files: number; bytes: number }> = new Map(),
  priorAsks: ReadonlyMap<string, number> = new Map(),
): StageView[] {
  return sortMembers(members).map((m) => {
    const t = latest.get(m.id) ?? null;
    const st = stageStateOf(t, t === null ? 0 : (declined.get(t.id) ?? 0));
    return {
      memberId: m.id,
      agentId: m.agent_id,
      agentName: m.agent_name,
      position: m.position,
      isAggregator: m.is_aggregator,
      summary: m.summary,
      isNew: m.is_new,
      reuseLine: reuseLineOf(m.is_new, priorAsks.get(m.agent_id) ?? 0),
      state: st.state,
      stateText: st.text,
      taskStatus: t?.status ?? null,
      taskId: t?.id ?? null,
      report: t?.report == null ? null : { title: t.report_title ?? "", body: t.report },
      tainted: t?.tainted ?? false,
      startedAt: t?.started_at?.toISOString() ?? null,
      finishedAt: t?.finished_at?.toISOString() ?? null,
      activity: t === null ? [] : (activity.get(t.id) ?? []),
      files: (() => {
        const f = t === null ? undefined : files.get(t.id);
        return f === undefined ? null : { count: f.files, bytes: f.bytes };
      })(),
    };
  });
}

/** 順番の段の間（まとめは担当 → まとめ役）の「渡したもの」。受け渡した元のタスク（input_task_ids）から作る */
function handoffViews(ask: Pick<AskRow, "shape">, members: readonly MemberRowN[], tasks: readonly TaskRow[], latest: Map<string, TaskRow>): HandoffView[] {
  if (ask.shape !== "chain" && ask.shape !== "aggregate") return [];
  const out: HandoffView[] = [];
  const byTaskId = new Map(tasks.map((t) => [t.id, t]));
  const memberOf = new Map(members.map((m) => [m.id, m]));
  for (const to of sortMembers(members)) {
    const task = latest.get(to.id);
    if (task === undefined) continue;
    for (const fromId of task.input_task_ids) {
      const from = byTaskId.get(fromId);
      const fromMember = from?.ask_member_id == null ? undefined : memberOf.get(from.ask_member_id);
      if (from === undefined || fromMember === undefined) continue;
      out.push({
        fromPosition: fromMember.position,
        toPosition: to.position,
        fromAgentName: fromMember.agent_name,
        toAgentName: to.agent_name,
        label: from.report_title?.trim() ? from.report_title : "報告",
        taintMark: handoffMark({ tainted: from.tainted, sources: from.taint_sources }),
      });
    }
  }
  return out;
}

/** 実行の種類（画面の札）。返事の実行（manual）でも返事の文が残っていなければ ask 扱い */
export function turnKindOf(run: Pick<AskRunRow, "trigger_type">, hasPrompt: boolean): AskTurnView["kind"] {
  if (run.trigger_type === "schedule") return "schedule";
  if (run.trigger_type === "manual" && hasPrompt) return "reply";
  return "ask";
}

/** 頼んだこと → 回答 の履歴（古い順）。各実行の文は担当のタスクの prompt、なければ依頼の文 */
export function turnViews(db: WsDb, ask: Pick<AskRow, "id" | "text">): AskTurnView[] {
  const runs = listLiveRuns(db, ask.id, ASK_TURN_LIMIT).reverse();
  const prompts = firstPromptsOfRuns(
    db,
    runs.map((r) => r.id),
  );
  return runs.map((r) => {
    const prompt = prompts.get(r.id);
    return {
      runId: r.id,
      runNo: r.run_no,
      kind: turnKindOf(r, prompt !== undefined),
      text: prompt ?? ask.text,
      status: r.status,
      answer: storedAnswerView(r),
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
    };
  });
}

export function buildAskDetail(db: WsDb, askId: string, now: Date = new Date()): AskDetailResponse | null {
  const ask = getAsk(db, askId);
  if (ask === null) return null;
  const members = listMembers(db, askId);
  const run: AskRunRow | null = getLatestLiveRun(db, askId);
  const tasks = run === null ? [] : listRunTasks(db, run.id);
  // 返事の実行（trigger_type = manual）は窓口だけを動かす。段はその回で動いた担当（窓口）だけを出す（ほかの担当を「待っています」と見せない）。
  // 最初・定期の実行は編成全体を出し、その実行の最新のタスクがあるものだけ状態を持つ
  const latest = latestTaskByMember(tasks);
  const shownMembers = run?.trigger_type === "manual" ? members.filter((m) => latest.has(m.id)) : members;
  const formation = formationView(ask, members);
  const answer = run === null ? null : storedAnswerView(run);
  const pending = listPendingIntentsOfTasks(
    db,
    tasks.map((t) => t.id),
  );
  const pendingIntents: PendingIntentView[] = pending.map((p) => ({
    intentId: p.intent_id,
    approvalId: p.approval_id,
    taskId: p.task_id,
    agentName: p.agent_name,
    action: p.action,
    intentHash: p.intent_hash,
    taintLine: taintReasonLine(p.taint_snapshot),
    createdAt: p.created_at.toISOString(),
  }));

  let resume: AskDetailResponse["resume"] = null;
  if (ask.status === "waiting_input" && run !== null && ask.shape !== null) {
    const planMembers: PlanMember[] = members.map((m, i) => {
      const t = latest.get(m.id) ?? null;
      return { memberId: m.id, position: m.position ?? i + 1, isAggregator: m.is_aggregator, task: t === null ? null : { id: t.id, status: t.status, hasReport: t.report !== null } };
    });
    const plan = evaluateRun({ shape: ask.shape, members: planMembers, now, firstStartedAt: run.first_member_started_at });
    const stopped = members.find((m) => m.id === plan.stoppedMemberId);
    const stoppedTask = stopped === undefined ? null : (latest.get(stopped.id) ?? null);
    if (stopped !== undefined && stoppedTask !== null) resume = { agentName: stopped.agent_name, reason: stopReasonOf(stoppedTask) };
  }

  const finished = ask.status === "failed" || ask.status === "cancelled";
  const latestIds = [...latest.values()].map((t) => t.id);
  return {
    ask: askSummary(ask, { members, run }),
    formation,
    run:
      run === null
        ? null
        : {
            runId: run.id,
            runNo: run.run_no,
            status: run.status,
            triggerType: run.trigger_type,
            startedAt: run.started_at.toISOString(),
            finishedAt: run.finished_at?.toISOString() ?? null,
          },
    answer,
    answerPending: answer === null && run !== null && !finished && ask.status !== "waiting_input" ? { spokespersonName: spokespersonOf(ask, members) } : null,
    turns: turnViews(db, ask),
    stages: stageViews(
      shownMembers,
      latest,
      countRejectedIntentsOfTasks(db, latestIds),
      activityByTask(listToolActivityOfTasks(db, latestIds, ACTIVITY_PER_TASK)),
      listTaskSnapshotSizes(db, latestIds),
      countPriorAsksOfAgents(db, [...new Set(shownMembers.map((m) => m.agent_id))], { askId: ask.id, createdAt: ask.created_at }),
    ),
    handoffs: handoffViews(ask, shownMembers, tasks, latest),
    pendingIntents,
    agentQuestions: listAgentQuestions(db, askId)
      .filter((x) => x.status === "open")
      .map((x) => ({
        questionId: x.id,
        agentName: x.agent_name,
        text: x.question,
        choices: x.choices.map((c) => ({ id: c.id, label: c.label })),
        allowFreeText: x.allow_free_text,
        createdAt: x.created_at.toISOString(),
      })),
    pendingReplies: listPendingReplies(db, askId).map((x) => ({ id: x.id, text: x.text, createdAt: x.created_at.toISOString() })),
    resume,
    messageCount: countAskMessages(db, askId),
    planner: plannerView(plannerUsageOf(db, askId)),
  };
}

/** 編成を作った Gemini の呼び出し。費用はマイクロドルの整数から、前と同じ小数6桁の USD の文字列（'0.003000'）にする */
function plannerView(u: ReturnType<typeof plannerUsageOf>): AskDetailResponse["planner"] {
  return u === null ? null : { model: u.model, calls: u.calls, latencyMs: u.latencyMs, costUsd: microToUsd(u.costMicroUsd) };
}

/** 連絡板の1通の見え方（GET /asks/:id/messages と SSE の ask.message.posted が同じ形） */
export function messageView(m: AskMessageRow): AskMessageView {
  return {
    id: m.id,
    fromAgentName: m.from_agent_name,
    toAgentName: m.to_agent_name,
    kind: m.kind,
    body: m.body,
    inReplyTo: m.in_reply_to,
    tainted: m.tainted,
    createdAt: m.created_at.toISOString(),
  };
}

export function listMessages(db: WsDb, askId: string): ListAskMessagesResponse | null {
  if (getAsk(db, askId) === null) return null;
  const rows = listAskMessages(db, askId);
  return { messages: rows.map(messageView) };
}
