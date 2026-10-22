// 連絡板（FR-064・BR-73〜77。Should）：担当の team_post・team_wait と、連絡を担当に渡す処理。
// - 連絡はいつも Kernel（validateTeamMessage）を通り、通ったものだけ ask_messages に残る。断ったものは監査ログ ask.message.rejected だけ（本文は残さない）。
// - 受け取る側には「データ」として渡す（wrapUntrusted・送った担当の名前・汚染の印。指示とは混ぜない：BR-75）。渡す経路は
//   （1）タスクの開始（getTaskContext：始まる前に届いていた連絡）（2）動いている間の team_post・team_wait の結果（次のターンの入力に載る）。
//   渡した連絡は tasks.input_message_ids に足し、2度渡さない。汚染された担当の連絡を渡したら受け手も汚染する（taintOnTeamMessage）
// - 終わった担当への question の追いのターンを起こすのは app（onTeamMessagePosted）。edge は担当を新しく動かさない
// - 追いのターンの担当が reply を送ったら、その返事を報告にしてタスクを終える（A-105。reply を1通送って終わる）

import {
  flattenDirectSources,
  sha256Hex,
  taintOnTeamMessage,
  TEAM_LIMITS,
  validateTeamMessage,
  wrapUntrusted,
  type DirectTaintSource,
  type TaintState,
  type TeamMessageKind,
  type TeamMessageRejectReason,
} from "@open-team/kernel";
import { EdgeError, toolErrorText, type TaskContext, type ToolCallResult } from "@open-team/runner";
import { sleepMs } from "@open-team/llm";
import { maskSecrets } from "@open-team/platform";
import { appendAuditLog, getWorkspace, lockWorkspace, type AskMemberRow, type AskRow, type PolicyDecisionRow, type Queryable, type TaskRow, type Tx, type Uuid, type WsCtx } from "@open-team/db";
import {
  getAskRow,
  getTask,
  insertAskMessage,
  listAskMembers,
  listAskMessages,
  listLatestMemberTasks,
  lockTask,
  markMessagesDelivered,
  revokeTaskToken,
  saveTaskReport,
  setTaskTaint,
  touchTaskHeartbeat,
  type AskMessageRow,
} from "@open-team/db/edge";
import { finalizeTaskAfterLoop } from "./halt.ts";
import { notifyTerminal, runHook, type EdgeRuntime } from "./runtime.ts";
import { haltedDetails } from "./tokens.ts";
import { isPlainObject } from "./util.ts";

type MemberRow = AskMemberRow & { agent_name: string };

/** 止まった担当（失敗・停止・取り消し）。連絡の宛先にできない（recipient_stopped） */
const STOPPED_STATUSES: ReadonlySet<string> = new Set(["failed", "halted", "cancelled", "rejected"]);

/** 連絡を断った理由の文（ツールのエラーとして返す。送った担当はそのまま続ける：ag:314） */
const REJECT_TEXT: Readonly<Record<TeamMessageRejectReason, string>> = {
  board_closed: "連絡板は閉じています。分かっている範囲で進めてください。",
  single_shape: "この依頼は担当がひとりなので、連絡板は使えません。",
  recipient_not_in_ask: "宛先は、同じ依頼の担当の名前にしてください（自分には送れません）。",
  recipient_stopped: "宛先の担当は止まっているので、連絡できません。",
  kind_not_allowed_for_shape: "この宛先には、その種類の連絡は送れません。",
  reply_target_invalid: "in_reply_to には、自分宛てでまだ返事していない質問の message_id を指定してください。",
  revise_not_from_aggregator: "作り直しの依頼はまとめ役だけが送れます。",
  ask_message_limit: `この依頼の連絡は${TEAM_LIMITS.messagesPerAsk}通までです。分かっている範囲で進めてください。`,
  question_pair_limit: `同じ担当との質問は${TEAM_LIMITS.questionsPerPair}往復までです。分かっている範囲で進めてください。`,
  revise_limit: "作り直しの依頼は、担当ごとに1回までです。",
  body_too_long: `本文は${TEAM_LIMITS.bodyMaxChars}文字までです。`,
  body_empty: "本文が空です。",
};

/** 返事を待てなかったときの決まった文（FR-064：返事がない・相手が止まった） */
export const TEAM_NO_REPLY_TEXT = "返事がないので、分かっている範囲で進めます。";
export const TEAM_RECIPIENT_STOPPED_TEXT = "相手の担当が止まったので返事はありません。分かっている範囲で進めます。";
export const TEAM_POSTED_TEXT = "連絡を送りました。";

const KIND_LABEL: Readonly<Record<TeamMessageKind, string>> = {
  share: "共有",
  question: "質問",
  reply: "返事",
  revise: "作り直しの依頼",
};

const TAINT_NOTE = "外部の内容をもとにしています";

/** 1行にする（名前などを区切りの外に出さない） */
const inline = (s: string): string => s.replace(/\s+/g, " ").trim();

// ---- 連絡板の状態の読み出し ----

export interface Board {
  ask: AskRow;
  members: MemberRow[];
  /** 送り手（自分の担当） */
  me: MemberRow;
  /** 担当ごとの最新の通常のタスク */
  latest: TaskRow[];
  messages: AskMessageRow[];
  boardOpen: boolean;
}

/** 担当の並び（context.ts の formation と同じ数え方：まとめ役は最後の段の次） */
function positionsOf(members: readonly MemberRow[]): Map<Uuid, number> {
  const workers = members.filter((m) => !m.is_aggregator);
  const out = new Map<Uuid, number>();
  members.forEach((m) => out.set(m.id, m.is_aggregator ? workers.length + 1 : (m.position ?? workers.findIndex((w) => w.id === m.id) + 1)));
  return out;
}

/** 自分の担当（タスクの ask_member_id、なければ仕事で引く：ask_members_job_uq）。依頼のタスクでなければ null */
export async function loadBoard(q: Queryable, ctx: WsCtx, task: Pick<TaskRow, "ask_id" | "ask_member_id" | "job_id">): Promise<Board | null> {
  if (task.ask_id === null) return null;
  const ask = await getAskRow(q, ctx, task.ask_id);
  if (ask === null) return null;
  const members = await listAskMembers(q, ctx, ask.id);
  const me = members.find((m) => m.id === task.ask_member_id) ?? members.find((m) => m.job_id === task.job_id);
  if (me === undefined) return null;
  const ws = await getWorkspace(q, ctx);
  // 連絡板は Kill Switch・依頼の取り消し・失敗で閉じる（ag:321）。終わった依頼でも追いのターンの返事は届ける
  const boardOpen = ws !== null && !ws.kill_switch_engaged && (ask.status === "running" || ask.status === "waiting_input" || ask.status === "done");
  return { ask, members, me, latest: await listLatestMemberTasks(q, ctx, ask.id), messages: await listAskMessages(q, ctx, ask.id), boardOpen };
}

const isStopped = (b: Board, memberId: Uuid): boolean => {
  const t = b.latest.find((x) => x.ask_member_id === memberId);
  return t !== undefined && STOPPED_STATUSES.has(t.status);
};

// ---- 渡す ----

/** 連絡を受け手に渡す文（区切り・送った担当の名前・message_id・汚染の印。runner の buildTaskInput と同じ並び） */
export function formatIncoming(messages: readonly Pick<AskMessageRow, "id" | "from_agent_name" | "kind" | "tainted" | "body">[]): string {
  const lines = ["# ほかの担当からの連絡"];
  for (const m of messages) {
    const name = inline(m.from_agent_name);
    const notes = [`message_id: ${m.id}`, ...(m.tainted ? [TAINT_NOTE] : [])].join("。");
    lines.push(`${name}からの${KIND_LABEL[m.kind]}（${notes}）：`, wrapUntrusted(`message:${name}`, m.body));
  }
  return lines.join("\n");
}

/** まだ渡していない連絡（自分宛て・全員宛ての share）。自分が送ったものと、渡し済みのものは除く。まとめ役は全員宛てを受けない */
function undelivered(b: Board, task: Pick<TaskRow, "input_message_ids">): AskMessageRow[] {
  return b.messages.filter(
    (m) =>
      m.from_member !== b.me.id &&
      (m.to_member === b.me.id || (m.to_member === null && m.kind === "share" && !b.me.is_aggregator)) &&
      !task.input_message_ids.includes(m.id),
  );
}

/** 渡した連絡の汚染を受け手のタスクに足す（BR-75）。送り手のタスクの汚染の出どころを upstream に平らにして持たせる */
async function taintByMessages(tx: Tx, ctx: WsCtx, b: Board, task: TaskRow, incoming: readonly AskMessageRow[], now: Date): Promise<TaintState> {
  let state: TaintState = { tainted: task.tainted, sources: Array.isArray(task.taint_sources) ? task.taint_sources : [] };
  for (const m of incoming) {
    if (!m.tainted) continue;
    const from = await getTask(tx, ctx, m.from_task_id);
    const upstream: DirectTaintSource[] = from === null ? [] : flattenDirectSources({ tainted: from.tainted, sources: from.taint_sources });
    state = taintOnTeamMessage(state, { messageId: m.id, fromTaskId: m.from_task_id, fromAgentName: m.from_agent_name, tainted: true, upstream }, now.toISOString());
  }
  if (state.tainted !== task.tainted || state.sources.length !== task.taint_sources.length) await setTaskTaint(tx, ctx, task.id, state, now);
  return state;
}

/**
 * まだ渡していない連絡を渡す（1トランザクション：汚染を足す・渡し済みに記録する）。渡した連絡と、その文を返す。
 * 追いのターンでは質問そのものは入力（followupQuestion）で渡しているので、ここには出ない
 */
export async function deliverIncoming(rt: EdgeRuntime, ctx: WsCtx, taskId: Uuid): Promise<{ messages: AskMessageRow[]; text: string | null }> {
  return rt.db.transaction(
    async (tx) => {
      await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, taskId);
      if (t === null) throw new EdgeError("UNAUTHORIZED");
      const b = await loadBoard(tx, ctx, t);
      if (b === null) return { messages: [], text: null };
      const incoming = undelivered(b, t);
      if (incoming.length === 0) return { messages: [], text: null };
      const now = rt.clock.now();
      await taintByMessages(tx, ctx, b, t, incoming, now);
      await markMessagesDelivered(tx, ctx, t.id, incoming.map((m) => m.id), now);
      const masked = incoming.map((m) => ({ ...m, body: maskSecrets(m.body, rt.knownSecrets) }));
      return { messages: incoming, text: formatIncoming(masked) };
    },
    { retryOnce: true },
  );
}

/** タスクの開始のとき、始まる前に届いていた連絡を渡す（TaskContext.input.teamMessages） */
export async function deliverAtStart(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow): Promise<TaskContext["input"]["teamMessages"]> {
  // 追いのターンは質問を followupQuestion で渡す。ほかの連絡は渡さない
  if (task.ask_id === null || task.kind !== "normal") return [];
  const { messages } = await deliverIncoming(rt, ctx, task.id);
  return messages.map((m) => ({
    messageId: m.id,
    fromAgentName: m.from_agent_name,
    kind: m.kind === "revise" ? "revise_request" : m.kind,
    tainted: m.tainted,
    body: maskSecrets(m.body, rt.knownSecrets),
  }));
}

/** 追いのターンの入力（質問と、前に出した報告）。質問が見つからなければ undefined */
export async function followupQuestionOf(q: Queryable, ctx: WsCtx, task: TaskRow, secrets: readonly string[]): Promise<TaskContext["input"]["followupQuestion"]> {
  if (task.kind !== "followup" || task.ask_id === null) return undefined;
  const messageId = task.input_message_ids[0];
  if (messageId === undefined) return undefined;
  const message = (await listAskMessages(q, ctx, task.ask_id)).find((m) => m.id === messageId);
  const parent = task.parent_task_id === null ? null : await getTask(q, ctx, task.parent_task_id);
  if (message === undefined) return undefined;
  return {
    messageId: message.id,
    fromAgentName: message.from_agent_name,
    body: maskSecrets(message.body, secrets),
    originalReport: maskSecrets(parent?.report ?? "（報告がありません）", secrets),
  };
}

// ---- team_post ----

function parsePostArgs(raw: unknown): { to: string; kind: TeamMessageKind; body: string; inReplyTo?: Uuid } | null {
  if (!isPlainObject(raw)) return null;
  const { to, kind, body, in_reply_to } = raw;
  if (typeof to !== "string" || typeof body !== "string") return null;
  const mapped: TeamMessageKind | null = kind === "revise_request" ? "revise" : kind === "share" || kind === "question" || kind === "reply" ? kind : null;
  if (mapped === null) return null;
  return { to, kind: mapped, body, ...(typeof in_reply_to === "string" && in_reply_to !== "" ? { inReplyTo: in_reply_to } : {}) };
}

/** team_post（FR-064）：検査 → 保存 → 監査ログ。追いのターンの reply はタスクも終える。コミットのあと onTeamMessagePosted */
export async function teamPost(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow, row: PolicyDecisionRow): Promise<ToolCallResult> {
  const args = parsePostArgs(row.subject.args);
  if (args === null) throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "arguments", reason: "to・kind・body は必須（kind は share / question / reply / revise_request）" }] });
  const body = maskSecrets(args.body, rt.knownSecrets);
  type Outcome =
    | { ok: false; reason: TeamMessageRejectReason | "not_an_ask_task" }
    | { ok: true; message: AskMessageRow; toMemberId: Uuid | null; finished: { status: TaskRow["status"]; terminal: boolean } | null };
  const outcome = await rt.db.transaction(
    async (tx): Promise<Outcome> => {
      const now = rt.clock.now();
      await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, task.id);
      if (t === null) throw new EdgeError("UNAUTHORIZED");
      if (t.status !== "running") throw new EdgeError("TASK_HALTED", haltedDetails(t));
      const b = await loadBoard(tx, ctx, t);
      if (b === null) return { ok: false, reason: "not_an_ask_task" };
      const positions = positionsOf(b.members);
      const verdict = validateTeamMessage({
        ask: { id: b.ask.id, shape: b.ask.shape ?? "single", boardOpen: b.boardOpen },
        members: b.members.map((m) => ({ memberId: m.id, agentName: m.agent_name, position: positions.get(m.id) ?? 0, isAggregator: m.is_aggregator, stopped: isStopped(b, m.id) })),
        fromMemberId: b.me.id,
        message: { to: args.to, kind: args.kind, body, ...(args.inReplyTo === undefined ? {} : { inReplyTo: args.inReplyTo }) },
        history: b.messages.map((m) => ({ id: m.id, fromMember: m.from_member, toMember: m.to_member, kind: m.kind, inReplyTo: m.in_reply_to })),
      });
      if (!verdict.ok) {
        await appendAuditLog(
          tx,
          ctx.workspaceId,
          {
            eventType: "ask.message.rejected",
            actorType: "agent",
            actorId: t.agent_id,
            taskId: t.id,
            payload: { askId: b.ask.id, fromMemberId: b.me.id, kind: args.kind, reason: verdict.reason },
          },
          now,
        );
        return { ok: false, reason: verdict.reason };
      }
      const message = await insertAskMessage(tx, ctx, {
        askId: b.ask.id,
        askRunId: t.ask_run_id,
        fromMember: b.me.id,
        toMember: verdict.toMemberId,
        kind: args.kind,
        body,
        inReplyTo: args.inReplyTo ?? null,
        // 送った時点の送り手の汚染（ask_messages.tainted。受け手の汚染はこの値で決まる：BR-75）
        tainted: t.tainted,
        fromTaskId: t.id,
        now,
      });
      await appendAuditLog(
        tx,
        ctx.workspaceId,
        {
          eventType: "ask.message.posted",
          actorType: "agent",
          actorId: t.agent_id,
          taskId: t.id,
          // 本文は入れない（ハッシュだけ）
          payload: {
            askId: b.ask.id,
            messageId: message.id,
            fromMemberId: b.me.id,
            toMemberId: verdict.toMemberId,
            kind: args.kind,
            bodyHash: sha256Hex(body),
            tainted: t.tainted,
          },
        },
        now,
      );
      // 追いのターンは reply を1通送って終わる（A-105）：返事を報告にして、タスクを終える
      let finished: { status: TaskRow["status"]; terminal: boolean } | null = null;
      if (t.kind === "followup" && args.kind === "reply") {
        const saved = await saveTaskReport(tx, ctx, t.id, { title: "追いのターンの返事", body, kind: "normal", sources: [] }, now);
        if (saved) {
          await revokeTaskToken(tx, ctx, t.id, now);
          const fin = await finalizeTaskAfterLoop(tx, ctx, { ...t, report: body }, now);
          finished = { status: fin.status, terminal: fin.terminal };
        }
      }
      return { ok: true, message, toMemberId: verdict.toMemberId, finished };
    },
    { retryOnce: true },
  );

  if (!outcome.ok) {
    if (outcome.reason === "not_an_ask_task") return { kind: "text", text: toolErrorText("TEAM_BOARD_NOT_AVAILABLE") };
    return { kind: "text", text: `${toolErrorText(`TEAM_${outcome.reason.toUpperCase()}`)} ${REJECT_TEXT[outcome.reason]}` };
  }
  const posted = outcome.message;
  const hook = rt.hooks.onTeamMessagePosted;
  if (hook) {
    await runHook(rt, "onTeamMessagePosted", task.id, () =>
      hook(ctx, { askId: posted.ask_id, messageId: posted.id, kind: posted.kind, fromTaskId: task.id, toMemberId: outcome.toMemberId }),
    );
  }
  if (outcome.finished !== null) {
    if (outcome.finished.terminal) await notifyTerminal(rt, ctx, task.id, outcome.finished.status);
    return { kind: "report_accepted", taskId: task.id };
  }
  // 返事を待たずに続ける担当にも、届いている連絡を渡す（次のターンの入力）
  const incoming = await deliverIncoming(rt, ctx, task.id);
  const head = `${TEAM_POSTED_TEXT}（message_id: ${posted.id}）`;
  return { kind: "text", text: incoming.text === null ? head : `${head}\n\n${incoming.text}` };
}

// ---- team_wait ----

/** team_wait（FR-064）：自分が送った question への返事を、timeout 秒（最大 A-104）まで待つ。Kill Switch・取り消し・タスクの停止ではすぐ返る */
export async function teamWait(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow, row: PolicyDecisionRow): Promise<ToolCallResult> {
  const raw = isPlainObject(row.subject.args) ? row.subject.args : {};
  const messageId = typeof raw.message_id === "string" ? raw.message_id : "";
  const timeoutSec = typeof raw.timeout === "number" && Number.isFinite(raw.timeout) ? Math.floor(raw.timeout) : 0;
  if (messageId === "" || timeoutSec < 1) {
    throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "arguments", reason: "message_id は文字列、timeout は1以上の整数（秒）" }] });
  }
  const pollMs = Math.max(1, rt.limits.teamWaitPollMs);
  const polls = Math.max(1, Math.ceil((Math.min(timeoutSec, TEAM_LIMITS.waitMaxSec) * 1000) / pollMs));
  const sleep = rt.retry.sleep ?? sleepMs;
  const signal = rt.signalFor?.(task.id);

  for (let i = 0; ; i += 1) {
    const t = await getTask(rt.db, ctx, task.id);
    const b = t === null ? null : await loadBoard(rt.db, ctx, t);
    if (t === null || b === null) return { kind: "text", text: toolErrorText("TEAM_BOARD_NOT_AVAILABLE") };
    // 止められた（Kill Switch・取り消し・タスクの終了）：待たずに返る
    if (t.status !== "running" || signal?.aborted === true) return { kind: "halted", reasonCode: haltedDetails(t).haltReason };
    const question = b.messages.find((m) => m.id === messageId && m.from_member === b.me.id && m.kind === "question");
    if (question === undefined) return { kind: "text", text: toolErrorText("TEAM_MESSAGE_NOT_FOUND") };
    const replied = b.messages.some((m) => m.kind === "reply" && m.in_reply_to === question.id);
    if (replied || undelivered(b, t).length > 0) {
      const got = await deliverIncoming(rt, ctx, task.id);
      if (got.text !== null) return { kind: "text", text: got.text };
    }
    if (question.to_member !== null && isStopped(b, question.to_member)) return { kind: "text", text: TEAM_RECIPIENT_STOPPED_TEXT };
    if (!b.boardOpen) return { kind: "halted", reasonCode: "task_terminated" };
    if (i + 1 >= polls) return { kind: "text", text: TEAM_NO_REPLY_TEXT };
    // ハートビートを兼ねる（待っている間も止まったタスクとして拾われない）
    await touchTaskHeartbeat(rt.db, ctx, task.id, rt.clock.now());
    try {
      await sleep(pollMs, signal);
    } catch {
      return { kind: "halted", reasonCode: "kill_switch" };
    }
  }
}
