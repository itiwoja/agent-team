// 依頼の画面に出す固定の文と、DB の行から契約（contract.ts）の型への変換（apps/app/src/asks/format.ts の WorkspaceDO 版）。LLM に書かせない文はすべてここ（形の1行は kernel の shapeLine）

import type { AskMemberRow, AskRow, AskRunRow, TaskRow } from "../../db/types.ts";
import { failReasonText, haltReasonText, shapeLine, type ComposedAnswer } from "@open-team/kernel";
import type { AskAnswerView, AskStatus, AskSummary, AskTriggerView, FormationMemberView, FormationView, NeedsConnection, StageState } from "./contract.ts";
import { FAILURE_MESSAGES } from "./planner.ts";
import { phaseOf } from "./plan.ts";

/** 「毎日18時」「毎日9時30分」「毎日9時・18時」。毎日の時刻（日 月 曜日が *、時は数字か「,」区切り）でない cron は cron そのまま */
export function triggerLabel(trigger: { cron: string; timezone: string }): string {
  const f = trigger.cron.trim().split(/\s+/);
  const minute = Number(f[0]);
  const hours = (f[1] ?? "").split(",").map((h) => (/^\d{1,2}$/.test(h) ? Number(h) : NaN));
  if (f.length === 5 && f[2] === "*" && f[3] === "*" && f[4] === "*" && Number.isInteger(minute) && hours.length > 0 && hours.every((h) => Number.isInteger(h) && h <= 23)) {
    return `毎日${hours.map((h) => (minute === 0 ? `${h}時` : `${h}時${minute}分`)).join("・")}`;
  }
  return trigger.cron;
}

export function triggerView(row: Pick<AskRow, "trigger"> & Partial<Pick<AskRow, "next_run_at">>): AskTriggerView | null {
  const t = row.trigger;
  return t === null
    ? null
    : { type: "schedule", cron: t.cron, timezone: t.timezone, label: triggerLabel(t), nextRunAt: row.next_run_at?.toISOString() ?? null };
}

/**
 * 担当の段の状態の文（ask-page.md：待っています／動いています／済み／確認待ち／失敗：〇〇／止めました）。
 * declinedWrites は送る前の確認で「送らない」にした書き込みの数で、済みのときに「済み（1件は送りませんでした）」と足す（D-108）
 */
export function stageStateOf(task: Pick<TaskRow, "status" | "fail_reason" | "halt_reason"> | null, declinedWrites = 0): { state: StageState; text: string } {
  if (task === null) return { state: "waiting", text: "待っています" };
  const p = phaseOf(task.status);
  switch (p) {
    case "none":
      return { state: "waiting", text: "待っています" };
    case "active":
      return { state: "running", text: task.status === "queued" ? "待っています" : "動いています" };
    case "awaiting":
      return { state: "awaiting_approval", text: "確認待ち" };
    case "ok":
      return { state: "done", text: declinedWrites > 0 ? `済み（${declinedWrites}件は送りませんでした）` : "済み" };
    case "stopped":
      if (task.status === "failed") return { state: "failed", text: `失敗：${failReasonText(task.fail_reason)}` };
      if (task.status === "halted") return { state: "stopped", text: `止めました（${haltReasonText(task.halt_reason)}）` };
      return { state: "stopped", text: "止めました" };
  }
}

/** 止まった担当の理由の固定文（「〇〇で止まりました（理由）」の理由） */
export function stopReasonOf(task: Pick<TaskRow, "status" | "fail_reason" | "halt_reason">): string {
  if (task.status === "failed") return failReasonText(task.fail_reason);
  if (task.status === "halted") return haltReasonText(task.halt_reason);
  if (task.status === "cancelled") return "取り消されました";
  return "止めました";
}

export function memberView(m: AskMemberRow & { agent_name: string }): FormationMemberView {
  return {
    memberId: m.id,
    agentId: m.agent_id,
    agentName: m.agent_name,
    isNew: m.is_new,
    summary: m.summary,
    position: m.position,
    dependsOn: [...m.depends_on],
    isAggregator: m.is_aggregator,
    isSpokesperson: m.is_spokesperson,
  };
}

export function formationView(ask: Pick<AskRow, "shape" | "formation">, members: ReadonlyArray<AskMemberRow & { agent_name: string }>): FormationView | null {
  if (ask.shape === null) return null;
  const views = members.map(memberView);
  const notes = Array.isArray((ask.formation as { notes?: unknown } | null)?.notes) ? ((ask.formation as { notes: unknown[] }).notes.filter((n) => typeof n === "string") as string[]) : [];
  return {
    shape: ask.shape,
    shapeLine: shapeLine(
      ask.shape,
      views.map((v, i) => ({ agentName: v.agentName, position: v.position ?? i + 1, isAggregator: v.isAggregator, dependsOn: v.dependsOn })),
    ),
    members: views,
    notes,
  };
}

/**
 * カレンダーの依頼と見る語（決定論。文を小文字にして、どれかを含めば "gcal"）。
 * 「予定」「スケジュール」は広いが、出すのは「未接続のときの案内」だけなので、外れても害はない
 */
const CALENDAR_WORDS = ["カレンダー", "予定", "スケジュール", "空いて", "calendar", "schedule"] as const;

/**
 * GitHub の依頼と見る語（決定論。18 §3.6）。出すのは「未接続のときの案内」だけ。
 * 「リポジトリ」「プルリク」「イシュー」は開発の依頼でほぼ GitHub を指す。カレンダーの語が先に当たればカレンダー
 */
const GITHUB_WORDS = ["github", "リポジトリ", "レポジトリ", "プルリク", "pull request", "イシュー", "issue"] as const;

/** 依頼の文が接続の要るコネクタ（Google カレンダー・GitHub）を使いそうか。使いそうになければ null */
export function needsConnectionOf(text: string): NeedsConnection | null {
  const t = text.toLowerCase();
  if (CALENDAR_WORDS.some((w) => t.includes(w))) return "gcal";
  return GITHUB_WORDS.some((w) => t.includes(w)) ? "github" : null;
}

/** 一覧・応答に載せる依頼の要約。members は編成の1行（形の1行）を作るときだけ渡す */
export function askSummary(
  ask: AskRow,
  o: { members?: ReadonlyArray<AskMemberRow & { agent_name: string }>; run?: Pick<AskRunRow, "answer"> | null } = {},
): AskSummary {
  const members = o.members ?? [];
  const fv = ask.shape === null ? null : formationView(ask, members);
  const conclusion = (o.run?.answer as { conclusion?: unknown } | null | undefined)?.conclusion;
  return {
    id: ask.id,
    text: ask.text,
    status: ask.status as AskStatus,
    shape: ask.shape,
    shapeLine: fv?.shapeLine ?? null,
    trigger: triggerView(ask),
    question: ask.status === "generating" && ask.question !== null && ask.question_answer === null ? { ...ask.question, choices: [...ask.question.choices] } : null,
    failure:
      ask.status === "failed" && ask.failure_reason !== null ? { reason: ask.failure_reason, message: FAILURE_MESSAGES[ask.failure_reason] } : null,
    answerPreview: typeof conclusion === "string" ? conclusion.split("\n").find((l) => l.trim() !== "")?.slice(0, 120) ?? null : null,
    needsConnection: needsConnectionOf(ask.text),
    createdAt: ask.created_at.toISOString(),
    updatedAt: ask.updated_at.toISOString(),
  };
}

/** 送る前の確認で「送らない」にしたものの1行（回答の結論は担当の報告のまま書き換えないので、送っていないことをここで言う：FR-063・D-108） */
export function declinedLineOf(n: number): string {
  return `あなたが「送らない」にしたもの：${n}件（送っていません）`;
}

/**
 * 担当の段の「使い回し」の1行（isNew：この依頼で作った担当。priorAsks：この依頼より前の依頼で働いた数）。
 * 新しく作った担当は「新しく作りました」、使い回した担当は前の依頼の数があれば足す
 */
export function reuseLineOf(isNew: boolean, priorAsks: number): string {
  if (isNew) return "新しく作りました";
  return priorAsks > 0 ? `いつもの担当 · 前の依頼 ${priorAsks}件でも働きました` : "いつもの担当";
}

/** 保存した回答（kernel の AskAnswer）→ 画面の回答 */
export function answerView(
  stored: ComposedAnswer & { updatedAt?: string; nextActions?: string[]; unchanged?: boolean },
  o: { answeredAt: Date | null; updatedAt: string },
): AskAnswerView {
  const n = stored.needsYou.pendingApprovals;
  const declined = stored.needsYou.declinedWrites ?? 0;
  return {
    conclusion: stored.conclusion,
    spokesperson: stored.spokesperson === null ? null : { agentId: stored.spokesperson.agentId, agentName: stored.spokesperson.agentName },
    memberLines: stored.memberLines.map((l) => ({ ...l })),
    needsYou: {
      pendingApprovals: n,
      line: n > 0 ? `あなたの確認待ち：${n}件` : null,
      stoppedMembers: [...stored.needsYou.stoppedMembers],
      declinedWrites: declined,
      declinedLine: declined > 0 ? declinedLineOf(declined) : null,
    },
    intermediate: stored.intermediate.map((i) => ({ ...i })),
    taintNote: stored.taintNote,
    nextActions: Array.isArray(stored.nextActions) ? stored.nextActions.filter((a) => typeof a === "string") : [],
    unchanged: stored.unchanged === true,
    answeredAt: (o.answeredAt ?? new Date(o.updatedAt)).toISOString(),
    updatedAt: o.updatedAt,
  };
}
