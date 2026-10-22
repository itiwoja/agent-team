// SCR-019 の行を作る（GET /check・GET /counts・GET /done・SSE の事象が同じ関数を使う）。
// 並び順（A-92）：送る前の確認 → 質問 → 報告。同じ種類の中は新しい順。BR-70 の開いた状態の行は送る前の確認の中で先に置く。
// 文言は reasons.ts（決まった文）。件数は行の数そのもの（見てほしいもの N）

import type { Queryable, SessionCtx } from "@open-team/db";
import {
  getAnswerRun,
  getEndedTaskReportRow,
  getEvolutionReportRow,
  getSkillProposalReportRow,
  listApprovalBundles,
  listCheckMarks,
  listDecidedApprovals,
  listRunningTasks,
  listUncheckedAnswers,
  listUncheckedEndedTasks,
  listUncheckedEvolutionEvents,
  listUncheckedSkillProposals,
  listUnknownOutcomeIntents,
  listWaitingAsks,
  type AnswerRunRow,
  type EvolutionReportRow,
  type SkillProposalReportRow,
  type TaskReportRow,
} from "@open-team/db/check";
import { failReasonText, type AskAnswer } from "@open-team/kernel";
import type { AppDeps } from "../deps.ts";
import { declinedLineOf } from "../asks/format.ts";
import type { ApprovalItem, CheckCounts, CheckItem, DoneItem, QuestionItem, ReportItem, RunningItem } from "./contract.ts";
import { buildApprovalView, newRuleIdFrom } from "./approval-view.ts";
import { calendarLinkOf } from "./calendar-link.ts";
import { actionNounOf, intentTitle, runningText, timeText } from "./reasons.ts";

/** db は Db でも Tx でもよい（SSE の事象を書くトランザクションの中でも作る） */
/** 行を作る相手（SessionCtx の一部。SSE の事象を作るときは owner の利用者で作る） */
export type Viewer = Pick<SessionCtx, "workspaceId" | "kind" | "userId" | "role">;

export type ItemDeps = Pick<AppDeps, "clock" | "ids"> & { db: Queryable };

/** 見てほしいものに出す報告の上限（古いものは「済んだもの」にチェックしないまま残る） */
export const REPORT_LIMIT = 100;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** 本文の最初の行（見出しの記号・太字・コード・リンクの記法は外して、行の題として読めるようにする） */
const firstLine = (s: string): string =>
  s
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(#{1,6}\s+|[-*・]\s+|\d+[.)]\s+|>\s*)/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]\n]+)\]\((?:[^\s()]|\([^\s()]*\))+\)/g, "$1")
        .trim(),
    )
    .find((l) => l !== "" && !/^[-*_|:\s]+$/.test(l)) ?? "";

// ---- 報告 ----

export function answerItem(r: AnswerRunRow): ReportItem {
  const a = r.run.answer as unknown as Partial<AskAnswer> | null;
  const conclusion = typeof a?.conclusion === "string" ? a.conclusion : "";
  const members = a?.memberLines ?? [];
  const sp = a?.spokesperson ?? null;
  const people = members.length;
  const lines: string[] = members.map((m) => `${m.agentName}：${m.text}`);
  const pending = a?.needsYou?.pendingApprovals ?? 0;
  if (pending > 0) lines.push(`あなたの確認待ち：${pending}件`);
  const declined = a?.needsYou?.declinedWrites ?? 0;
  if (declined > 0) lines.push(declinedLineOf(declined));
  if (typeof a?.taintNote === "string" && a.taintNote !== "") lines.push(a.taintNote);
  const at = r.run.answered_at ?? r.run.started_at;
  const failed = r.run.status === "failed";
  return {
    kind: "report",
    reportKind: "answer",
    key: `answer:${r.run.id}`,
    title: clip(firstLine(conclusion) || "回答ができました", 120),
    subtitle: [sp?.agentName ?? null, people > 0 ? `${people}人で` : null].filter((x) => x !== null).join(" · ") || null,
    agent: sp === null ? null : { id: sp.agentId, name: sp.agentName },
    askId: r.run.ask_id,
    at: at.toISOString(),
    opened: false,
    failed,
    dryRun: false,
    body: conclusion === "" ? null : conclusion,
    lines,
    link: { askId: r.run.ask_id, agentId: null },
    // どの頼みごとへの回答かを行に添える（返事の実行なら返事の文）
    request: clip(r.requestText ?? r.askText, 200),
  };
}

export function endedTaskItem(r: TaskReportRow): ReportItem {
  const t = r.task;
  const failed = t.status === "failed";
  const at = t.finished_at ?? t.updated_at;
  const title = failed ? `${failReasonText(t.fail_reason)}` : clip(t.report_title?.trim() || firstLine(t.report ?? "") || "終わりました", 120);
  return {
    kind: "report",
    reportKind: "task",
    key: `task:${t.id}`,
    title,
    subtitle: [r.agentName, timeText(at)].filter((x) => x !== null).join(" · "),
    agent: r.agentName === null ? null : { id: t.agent_id, name: r.agentName },
    askId: t.ask_id,
    at: at.toISOString(),
    opened: false,
    failed,
    dryRun: false,
    body: t.report,
    lines: [],
    link: { askId: t.ask_id, agentId: null },
    request: null,
  };
}

/** スキルの案（未決定）。案が決まると一覧から消える（SQL が proposed だけを返す） */
export function skillProposalItem(r: SkillProposalReportRow): ReportItem {
  const p = r.proposal;
  const name = p.name ?? "";
  const agentName = r.agentName ?? "担当";
  return {
    kind: "report",
    reportKind: "evolution",
    key: `skill_proposal:${p.id}`,
    title: `${agentName} にスキルの案「${clip(name, 40)}」が届きました`,
    subtitle: [r.agentName, timeText(p.created_at)].filter((x) => x !== null).join(" · "),
    agent: r.agentName === null ? null : { id: p.agent_id, name: r.agentName },
    askId: null,
    at: p.created_at.toISOString(),
    opened: false,
    failed: false,
    dryRun: false,
    body: [p.description, p.reason === null || p.reason === "" ? null : `案にした理由：${p.reason}`].filter((x): x is string => x !== null && x !== "").join("\n") || null,
    lines: [],
    link: { askId: null, agentId: p.agent_id },
    request: null,
  };
}

/** 整理の知らせ（0件の種類は出さない） */
export function evolutionItem(r: EvolutionReportRow): ReportItem {
  const e = r.event;
  const skills = e.items.filter((i) => i.type === "skill").length;
  const rules = e.items.filter((i) => i.type === "rule").length;
  const counts = [skills > 0 ? `使われていないスキル ${skills}件` : null, rules > 0 ? `ルール ${rules}件` : null].filter((x) => x !== null).join("・");
  const agentName = r.agentName ?? "担当";
  return {
    kind: "report",
    reportKind: "evolution",
    key: `evolution:${e.id}`,
    title: `${agentName}：${counts}を外しました（担当のページで戻せます）`,
    subtitle: [r.agentName, timeText(e.created_at)].filter((x) => x !== null).join(" · "),
    agent: r.agentName === null ? null : { id: e.agent_id, name: r.agentName },
    askId: null,
    at: e.created_at.toISOString(),
    opened: false,
    failed: false,
    dryRun: false,
    body: null,
    lines: e.items.map((i) => `${i.type === "skill" ? "スキル" : "ルール"}：${i.label}`),
    link: { askId: null, agentId: e.agent_id },
    request: null,
  };
}

// ---- 全体 ----

export interface CheckBuild {
  items: CheckItem[];
  running: RunningItem[];
  counts: CheckCounts;
}

const byTimeDesc = (a: { at: string }, b: { at: string }): number => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/** 見てほしいもの・やっていること・件数。focusKey の行は開いた状態にする（?item=） */
export async function buildCheck(deps: ItemDeps, s: Viewer, focusKey: string | null = null): Promise<CheckBuild> {
  const now = deps.clock.now();
  const q = deps.db;
  const [approvals, waiting, unknowns, answers, ended, proposals, evolutions, runningRows] = await Promise.all([
    listApprovalBundles(q, s, { status: "pending", notExpiredAt: now, limit: 100 }),
    listWaitingAsks(q, s, 50),
    listUnknownOutcomeIntents(q, s, 50),
    listUncheckedAnswers(q, s, REPORT_LIMIT),
    listUncheckedEndedTasks(q, s, REPORT_LIMIT),
    listUncheckedSkillProposals(q, s, REPORT_LIMIT),
    listUncheckedEvolutionEvents(q, s, REPORT_LIMIT),
    listRunningTasks(q, s, 50),
  ]);

  const approvalItems: ApprovalItem[] = [];
  for (const b of approvals) {
    const view = await buildApprovalView({ q, ctx: s, now, newRuleId: () => newRuleIdFrom(deps.ids.newId()) }, s, b);
    const key = `approval:${view.id}`;
    approvalItems.push({
      kind: "approval",
      key,
      title: view.title,
      subtitle: view.subtitle,
      agent: view.agent,
      askId: view.askId,
      at: view.createdAt,
      opened: view.openReason !== null || key === focusKey,
      approval: view,
    });
  }
  // BR-70：開いた状態の行が3つ以上あるときだけ、それらを先に（それ以外は新しい順のまま。ask-and-check.md）
  const openedCount = approvalItems.filter((a) => a.opened).length;
  approvalItems.sort((a, b) => (openedCount >= 3 ? Number(b.opened) - Number(a.opened) : 0) || byTimeDesc(a, b));

  const questions: QuestionItem[] = [
    ...waiting.map(
      (w): QuestionItem => ({
        kind: "question",
        source: "ask_question",
        key: `ask_question:${w.askId}`,
        title: w.question.text,
        subtitle: `「${clip(w.text, 24)}」について`,
        agent: null,
        askId: w.askId,
        at: w.updatedAt.toISOString(),
        opened: `ask_question:${w.askId}` === focusKey,
        question: w.question,
        reason: "仕事の途中で決められないことがあり、あなたに聞いています",
        intentId: null,
      }),
    ),
    ...unknowns.map(
      (u): QuestionItem => ({
        kind: "question",
        source: "unknown_outcome",
        key: `unknown_outcome:${u.intent.id}`,
        title: `届いたか分かりません：${intentTitle(u.intent.action)}`,
        subtitle: u.agentName,
        agent: u.agentId === null || u.agentName === null ? null : { id: u.agentId, name: u.agentName },
        askId: u.askId,
        at: u.intent.updated_at.toISOString(),
        opened: true,
        // ADR-031：選択肢は2つに固定する
        question: {
          text: `${actionNounOf(u.intent.action)}が届いたか分かりません`,
          choices: [
            { id: "executed", label: "届いていた" },
            { id: "failed", label: "届いていない" },
          ],
          allowFreeText: false,
        },
        reason: `${actionNounOf(u.intent.action)}を送ったあと、結果が返ってきませんでした。自動では送り直しません`,
        intentId: u.intent.id,
      }),
    ),
  ].sort(byTimeDesc);

  const reports: ReportItem[] = [...answers.map(answerItem), ...ended.map(endedTaskItem), ...proposals.map(skillProposalItem), ...evolutions.map(evolutionItem)]
    .map((r) => (r.key === focusKey ? { ...r, opened: true } : r))
    .sort(byTimeDesc);

  const items: CheckItem[] = [...approvalItems, ...questions, ...reports];
  const running: RunningItem[] = runningRows.map((r) => ({
    taskId: r.taskId,
    agent: { id: r.agentId, name: r.agentName },
    askId: r.askId,
    status: r.status as RunningItem["status"],
    text: runningText(r.status, r.lastTool),
    startedAt: r.startedAt?.toISOString() ?? null,
    canCancel: s.role === "owner" || r.requesterId === s.userId,
  }));
  return { items, running, counts: { attention: items.length, running: running.length, hasApproval: approvalItems.length > 0 } };
}

/** 1つの行（SSE の check.upsert・POST の応答用）。もうなければ null */
export async function buildOneItem(deps: ItemDeps, s: Viewer, key: string): Promise<CheckItem | null> {
  const { items } = await buildCheck(deps, s, key);
  return items.find((i) => i.key === key) ?? null;
}

/** 報告のキー → 行（チェック済みでも作る。済んだもの用） */
export async function reportItemOfKey(deps: ItemDeps, s: Viewer, key: string): Promise<ReportItem | null> {
  const m = /^([a-z_]+):([0-9a-f-]{36})$/.exec(key);
  if (!m) return null;
  const [, kind, id] = m;
  const q = deps.db;
  switch (kind) {
    case "answer": {
      const r = await getAnswerRun(q, s, id!);
      return r === null ? null : answerItem(r);
    }
    case "task": {
      const r = await getEndedTaskReportRow(q, s, id!);
      return r === null ? null : endedTaskItem(r);
    }
    case "skill_proposal": {
      const r = await getSkillProposalReportRow(q, s, id!);
      return r === null ? null : skillProposalItem(r);
    }
    case "evolution": {
      const r = await getEvolutionReportRow(q, s, id!);
      return r === null ? null : evolutionItem(r);
    }
    default:
      return null;
  }
}

/** 済んだもの：チェックした報告と、決定した承認を新しい順に */
export async function buildDone(deps: ItemDeps, s: Viewer, o: { limit: number; before: Date | null }): Promise<{ items: DoneItem[]; nextCursor: string | null }> {
  const marks = await listCheckMarks(deps.db, s, { limit: o.limit, ...(o.before ? { before: o.before } : {}) });
  const decided = await listDecidedApprovals(deps.db, s, { limit: o.limit, ...(o.before ? { before: o.before } : {}) });
  const items: DoneItem[] = [];
  for (const m of marks) {
    const item = await reportItemOfKey(deps, s, m.item_key);
    if (item === null) continue; // 消えた行（試験を外した・走行を消した）は出さない
    items.push({ key: item.key, kind: "report", title: item.title, subtitle: item.subtitle, outcome: null, askId: item.askId, doneAt: m.checked_at.toISOString() });
  }
  for (const b of decided) {
    const outcome = b.approval.status === "approved" ? "approved" : "rejected";
    items.push({
      key: `approval:${b.approval.id}`,
      kind: "approval",
      title: intentTitle(b.intent.action),
      subtitle: [b.agentName, outcome === "approved" ? "送りました" : "送りませんでした"].filter((x) => x !== null).join(" · "),
      outcome,
      askId: b.task.ask_id,
      doneAt: (b.approval.decided_at ?? b.approval.updated_at).toISOString(),
      // 実行されたものだけ「カレンダーで開く」を出す（結果は外部から来るので calendarLinkOf で検証する）
      calendarLink: b.intent.status === "executed" ? calendarLinkOf(b.intent.action, b.intent.result) : null,
    });
  }
  items.sort((a, b) => (a.doneAt < b.doneAt ? 1 : a.doneAt > b.doneAt ? -1 : 0));
  const page = items.slice(0, o.limit);
  const more = items.length > o.limit || marks.length === o.limit || decided.length === o.limit;
  return { items: page, nextCursor: more && page.length > 0 ? page[page.length - 1]!.doneAt : null };
}
