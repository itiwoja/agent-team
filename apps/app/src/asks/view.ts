// 依頼の表示用ビュー（API-075 SCR-021・一覧・連絡板）。読むだけ（トランザクションを張らない）。SQL は db の asks リポジトリ（workspace_id で絞る）
// 画面に出す固定の文（段の状態・手が要るもの・汚染の印・形の1行）はここで作って返し、画面はそのまま出す

import type { AskRow, AskRunRow, Queryable, TaskRow, WsCtx } from "@open-team/db";
import { getRehearsalRunPolicies } from "@open-team/db/edge";
import { listTaskSnapshotSizes } from "@open-team/db/sandbox";
import { findActiveRehearsalRun, hasBudgetStoppedRecertification, listCurrentCertificatesOfJobs, listRehearsalRuns, listRehearsalScenarios } from "@open-team/db/rehearsal";
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
  listMembers,
  countPriorAsksOfAgents,
  countRejectedIntentsOfTasks,
  listPendingIntentsOfTasks,
  listRunTasks,
  listToolActivityOfTasks,
  plannerUsageOf,
} from "@open-team/db/asks";
import { handoffMark, taintReasonLine } from "@open-team/kernel";
import type {
  AskDetailResponse,
  AskMessageView,
  AskRehearsalView,
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
import { attributionOf, selectAttributionRuns } from "../rehearsal/attribution.ts";

type MemberRowN = Awaited<ReturnType<typeof listMembers>>[number];

const sortMembers = (ms: readonly MemberRowN[]): MemberRowN[] =>
  [...ms].sort((a, b) => Number(a.is_aggregator) - Number(b.is_aggregator) || (a.position ?? 99) - (b.position ?? 99));

/** 回答待ちの窓口の名前（回答がまだのとき「〇〇がまとめています」に使う） */
function spokespersonOf(ask: Pick<AskRow, "shape">, members: readonly MemberRowN[]): string | null {
  if (ask.shape === "parallel") return null;
  return members.find((m) => m.is_spokesperson)?.agent_name ?? null;
}

export async function listAskSummaries(q: Queryable, ctx: WsCtx, o: { limit: number; status?: AskStatus }): Promise<ListAsksResponse> {
  const rows = await listAsks(q, ctx, o);
  const asks = [];
  for (const ask of rows) {
    const members = ask.shape === null ? [] : await listMembers(q, ctx, ask.id);
    const run = await getLatestLiveRun(q, ctx, ask.id);
    asks.push(askSummary(ask, { members, run }));
  }
  return { asks };
}

/** 失効の理由の固定文（画面にそのまま出す） */
const REVOKE_TEXTS: Record<string, string> = {
  widen: "権限を広げる変更があったため",
  tool_hash: "ツールの説明が変わったため",
  model: "モデルが変わったため",
  case_added: "試験が追加されたため",
  superseded: "新しい合格証に切り替わったため",
};

/** 担当の合計。同じ走行（依頼の走行は担当ごとに1枚ずつ出す：D-101）の合格証は同じ試験で出すので、その走行の試験の数は1回だけ数える */
function caseCountOf(certs: ReadonlyArray<{ case_count: number; rehearsal_run_id?: string }>): number {
  const perRun = new Map<string, number>();
  certs.forEach((c, i) => perRun.set(c.rehearsal_run_id ?? `#${i}`, Math.max(perRun.get(c.rehearsal_run_id ?? `#${i}`) ?? 0, c.case_count)));
  return [...perRun.values()].reduce((n, v) => n + v, 0);
}

/** 担当の仕事ごとの現行の合格証を、依頼の1つの状態にまとめる：失効が1枚でもあれば revoked（理由はその1枚）、出していない担当があれば none、全担当が有効なら valid */
export function certificateOfJobs(
  certs: ReadonlyArray<{ revoked_at: Date | null; revoke_reason: string | null; case_count: number; issued_at: Date; rehearsal_run_id?: string }>,
  jobCount: number,
): { state: "valid" | "revoked" | "none"; revokeReason: AskRehearsalView["certificateRevokeReason"]; caseCount: number | null; issuedAt: string | null } {
  if (certs.length === 0) return { state: "none", revokeReason: null, caseCount: null, issuedAt: null };
  const revoked = certs.find((c) => c.revoked_at !== null);
  const state = revoked !== undefined ? "revoked" : certs.length < jobCount ? "none" : "valid";
  const latest = certs.reduce((a, c) => (c.issued_at > a ? c.issued_at : a), certs[0]!.issued_at);
  return {
    state,
    revokeReason: revoked === undefined ? null : ((revoked.revoke_reason ?? "superseded") as AskRehearsalView["certificateRevokeReason"]),
    caseCount: caseCountOf(certs),
    issuedAt: latest.toISOString(),
  };
}

async function rehearsalOf(q: Queryable, ctx: WsCtx, ask: AskRow): Promise<AskRehearsalView | null> {
  // リハーサルは順番（chain）の編成全体で1回（D-71）。ほかの形は担当の仕事ごとなのでここには出さない
  if (ask.shape !== "chain") return null;
  const allRuns = await listRehearsalRuns(q, ctx, { subject: { askId: ask.id }, limit: 100, withMemberRecertify: true });
  const { primary: run, previous, recertify, userCases } = selectAttributionRuns(allRuns, ask.id);
  if (run === null) return null;
  const members = await listMembers(q, ctx, ask.id);
  const jobIds = [...new Set(members.map((m) => m.job_id))];
  const cert = certificateOfJobs(await listCurrentCertificatesOfJobs(q, ctx, jobIds), jobIds.length);
  // 切れた合格証の自動の再リハーサルは担当の仕事ごとの走行（re-rehearse.ts）なので、依頼の走行の一覧には出ない。ここで拾う
  const recertifying = (await Promise.all(jobIds.map((jobId) => findActiveRehearsalRun(q, ctx, { jobId })))).some((r) => r !== null);
  // 切れたあとの再リハーサルが費用の上限で止まった（翌日にやり直す：D-107）。走っている間・切れていない間は false
  const recertifyStoppedByBudget = cert.state === "revoked" && !recertifying && (await hasBudgetStoppedRecertification(q, ctx, jobIds));
  // 規則の貢献。ガードの照合は実効ポリシーが1つ（仕事が1つ）のときだけ（ガードの番号 guards[i] は仕事ごとなので、複数の仕事では照合しない）
  const policies = await getRehearsalRunPolicies(q, ctx, run.id);
  const onePolicy = policies !== null && Object.keys(policies).length === 1 ? Object.values(policies)[0] : undefined;
  // 画面と同じ集合：主走行、自分の悪い日、仕事ごとの再リハーサル。
  // 再試験中は表示中の前回結果と同様に前走行を集計対象にする。
  const displayedRunIds = previous !== null ? [previous.id] : [run.id, ...userCases.map((r) => r.id), ...recertify.map((r) => r.id)];
  const attributionRows = (await Promise.all(displayedRunIds.map((id) => listRehearsalScenarios(q, ctx, id)))).flat();
  const attribution = attributionOf(attributionRows, onePolicy?.policy.guards);
  return {
    runId: run.id,
    status: run.status,
    certificate: cert.state === "valid" ? "valid" : "none",
    certificateState: cert.state,
    certificateRevokeReason: cert.revokeReason,
    certificateRevokeText: cert.revokeReason === null ? null : (REVOKE_TEXTS[cert.revokeReason] ?? null),
    certificateCaseCount: cert.caseCount,
    certificateIssuedAt: cert.issuedAt,
    recertifying,
    recertifyStoppedByBudget,
    preventedDamageJpy: run.prevented_damage_jpy,
    damageJpy: run.damage_jpy,
    attribution,
    createdAt: run.created_at.toISOString(),
    finishedAt: run.finished_at?.toISOString() ?? null,
  };
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
export async function turnViews(q: Queryable, ctx: WsCtx, ask: Pick<AskRow, "id" | "text">): Promise<AskTurnView[]> {
  const runs = (await listLiveRuns(q, ctx, ask.id, ASK_TURN_LIMIT)).reverse();
  const prompts = await firstPromptsOfRuns(
    q,
    ctx,
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

export async function buildAskDetail(q: Queryable, ctx: WsCtx, askId: string): Promise<AskDetailResponse | null> {
  const ask = await getAsk(q, ctx, askId);
  if (ask === null) return null;
  const members = await listMembers(q, ctx, askId);
  const run: AskRunRow | null = await getLatestLiveRun(q, ctx, askId);
  const tasks = run === null ? [] : await listRunTasks(q, ctx, run.id);
  // 返事の実行（trigger_type = manual）は窓口だけを動かす。段はその回で動いた担当（窓口）だけを出す（ほかの担当を「待っています」と見せない）。
  // 最初・定期の実行は編成全体を出し、その実行の最新のタスクがあるものだけ状態を持つ
  const latest = latestTaskByMember(tasks);
  const shownMembers = run?.trigger_type === "manual" ? members.filter((m) => latest.has(m.id)) : members;
  const formation = formationView(ask, members);
  const answer = run === null ? null : storedAnswerView(run);
  const pending = await listPendingIntentsOfTasks(
    q,
    ctx,
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
    const plan = evaluateRun({ shape: ask.shape, members: planMembers, now: new Date(), firstStartedAt: run.first_member_started_at });
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
    turns: await turnViews(q, ctx, ask),
    stages: stageViews(
      shownMembers,
      latest,
      await countRejectedIntentsOfTasks(q, ctx, latestIds),
      activityByTask(await listToolActivityOfTasks(q, ctx, latestIds, ACTIVITY_PER_TASK)),
      await listTaskSnapshotSizes(q, ctx, latestIds),
      await countPriorAsksOfAgents(q, ctx, [...new Set(shownMembers.map((m) => m.agent_id))], { askId: ask.id, createdAt: ask.created_at }),
    ),
    handoffs: handoffViews(ask, shownMembers, tasks, latest),
    pendingIntents,
    agentQuestions: (await listAgentQuestions(q, ctx, askId))
      .filter((x) => x.status === "open")
      .map((x) => ({
        questionId: x.id,
        agentName: x.agent_name,
        text: x.question,
        choices: x.choices.map((c) => ({ id: c.id, label: c.label })),
        allowFreeText: x.allow_free_text,
        createdAt: x.created_at.toISOString(),
      })),
    rehearsal: await rehearsalOf(q, ctx, ask),
    resume,
    messageCount: await countAskMessages(q, ctx, askId),
    planner: await plannerUsageOf(q, ctx, askId),
  };
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

export async function listMessages(q: Queryable, ctx: WsCtx, askId: string): Promise<ListAskMessagesResponse | null> {
  if ((await getAsk(q, ctx, askId)) === null) return null;
  const rows = await listAskMessages(q, ctx, askId);
  return { messages: rows.map(messageView) };
}
