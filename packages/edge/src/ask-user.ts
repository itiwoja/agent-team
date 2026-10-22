// 利用者への質問（ask_user。10/14：答えを返すだけでなく、外すと困る選択は担当から聞けるようにする）
// - 本番の依頼のタスクだけ（ツールを渡すのも context.ts の selectTaskTools でそこに絞る）。試し実行では質問を作らない
// - 質問は agent_questions に残し（status = open）、決まった時間（limits.askUserWaitSec）だけ答えを見に行く。
//   答えが来たらその文を返し、来なければ expired にして「返事がありません」を返す。担当はそのまま自分で決めて進める
// - 外へは何も出さず、権限も変えない（Kernel の判定の外：decide 4-3）。利用者の答えは利用者の言葉なので汚染しない
// - 画面には app の hook（onAgentQuestion）が SSE で知らせる。edge は依頼の画面の事象の形を知らない

import { sha256Hex } from "@open-team/kernel";
import { ASK_USER_CHOICES_MAX, ASK_USER_CHOICE_MAX_CHARS, ASK_USER_QUESTION_MAX_CHARS, EdgeError, toolErrorText, type ToolCallResult } from "@open-team/runner";
import { sleepMs } from "@open-team/llm";
import { maskSecrets } from "@open-team/platform";
import { appendAuditLog, lockWorkspace, type PolicyDecisionRow, type TaskRow, type WsCtx } from "@open-team/db";
import { expireAgentQuestion, getAgentQuestion, getAgentRow, getTask, insertAgentQuestion, lockTask, touchTaskHeartbeat } from "@open-team/db/edge";
import { runHook, type EdgeRuntime } from "./runtime.ts";
import { haltedDetails } from "./tokens.ts";
import { charCount, isPlainObject } from "./util.ts";

/** 返事が来なかったときの決まった文 */
export const ASK_USER_NO_ANSWER_TEXT = "利用者から返事がありませんでした。外しても困らない形で自分で決めて進め、置いた前提を報告に書いてください。";
/** 聞ける回数を使い切った */
export const ASK_USER_LIMIT_TEXT = "このタスクで利用者に聞ける回数を使い切りました。自分で決めて進め、置いた前提を報告に書いてください。";
/** 質問できないタスク（依頼のタスクでない・試し実行） */
export const ASK_USER_UNAVAILABLE_TEXT = "このタスクでは利用者に質問できません。自分で決めて進めてください。";

export interface AskUserArgs {
  question: string;
  choices: Array<{ id: string; label: string }>;
  allowFreeText: boolean;
}

/** 引数を確かめて整える。質問の形が崩れていれば VALIDATION_ERROR（担当が直して呼び直せる） */
export function parseAskUserArgs(raw: unknown): AskUserArgs {
  const a = isPlainObject(raw) ? raw : {};
  const question = typeof a.question === "string" ? a.question.replace(/\s+/g, " ").trim() : "";
  if (question === "" || charCount(question) > ASK_USER_QUESTION_MAX_CHARS) {
    throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "question", reason: `質問は1〜${ASK_USER_QUESTION_MAX_CHARS}文字` }] });
  }
  const labels: string[] = [];
  if (a.choices !== undefined) {
    if (!Array.isArray(a.choices)) throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "choices", reason: "選択肢は文字列の配列" }] });
    for (const c of a.choices) {
      const t = typeof c === "string" ? c.replace(/\s+/g, " ").trim() : "";
      if (t === "" || charCount(t) > ASK_USER_CHOICE_MAX_CHARS) {
        throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "choices", reason: `選択肢は1つ1〜${ASK_USER_CHOICE_MAX_CHARS}文字` }] });
      }
      if (!labels.includes(t)) labels.push(t);
    }
  }
  if (labels.length > ASK_USER_CHOICES_MAX) {
    throw new EdgeError("VALIDATION_ERROR", { issues: [{ field: "choices", reason: `選択肢は${ASK_USER_CHOICES_MAX}つまで` }] });
  }
  // 選択肢がなければ自由に書いてもらうしかない
  const allowFreeText = labels.length === 0 ? true : a.allow_free_text !== false;
  return { question, choices: labels.map((label, i) => ({ id: `c${i + 1}`, label })), allowFreeText };
}

/** 答えを担当に返す文（利用者の言葉。選択肢を押したときはその文） */
export function answerText(answer: string): string {
  return `利用者の答え：${answer}`;
}

/** ask_user：質問を残し、答えを待つ。Kill Switch・取り消し・タスクの停止ではすぐ返る */
export async function askUser(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow, row: PolicyDecisionRow): Promise<ToolCallResult> {
  const args = parseAskUserArgs(row.subject.args);
  const question = maskSecrets(args.question, rt.knownSecrets);
  const choices = args.choices.map((c) => ({ id: c.id, label: maskSecrets(c.label, rt.knownSecrets) }));

  type Posted = { ok: true; id: string; askId: string } | { ok: false; text: string };
  const posted = await rt.db.transaction(
    async (tx): Promise<Posted> => {
      const now = rt.clock.now();
      await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, task.id);
      if (t === null) throw new EdgeError("UNAUTHORIZED");
      if (t.status !== "running") throw new EdgeError("TASK_HALTED", haltedDetails(t));
      if (t.ask_id === null || t.is_dry_run) return { ok: false, text: ASK_USER_UNAVAILABLE_TEXT };
      const asked = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_questions WHERE workspace_id = $1 AND task_id = $2", [ctx.workspaceId, t.id]);
      if ((asked.rows[0]?.n ?? 0) >= rt.limits.askUserPerTask) return { ok: false, text: ASK_USER_LIMIT_TEXT };
      const agent = await getAgentRow(tx, ctx, t.agent_id);
      const q = await insertAgentQuestion(tx, ctx, {
        askId: t.ask_id,
        askRunId: t.ask_run_id,
        taskId: t.id,
        agentId: t.agent_id,
        agentName: (agent?.name ?? "担当").slice(0, 60),
        question,
        choices,
        allowFreeText: args.allowFreeText,
        now,
      });
      await appendAuditLog(
        tx,
        ctx.workspaceId,
        {
          eventType: "ask.agent_question.posted",
          actorType: "agent",
          actorId: t.agent_id,
          taskId: t.id,
          // 本文は入れない（ハッシュだけ）
          payload: { taskId: t.id, askId: t.ask_id, questionId: q.id, questionHash: sha256Hex(question), choices: choices.length },
        },
        now,
      );
      return { ok: true, id: q.id, askId: t.ask_id };
    },
    { retryOnce: true },
  );
  if (!posted.ok) return { kind: "text", text: posted.text };

  const notify = async (status: "posted" | "expired") => {
    const hook = rt.hooks.onAgentQuestion;
    if (hook) await runHook(rt, "onAgentQuestion", task.id, () => hook(ctx, { askId: posted.askId, questionId: posted.id, taskId: task.id, status }));
  };
  await notify("posted");

  const pollMs = Math.max(1, rt.limits.teamWaitPollMs);
  const polls = Math.max(1, Math.ceil((rt.limits.askUserWaitSec * 1000) / pollMs));
  const sleep = rt.retry.sleep ?? sleepMs;
  const signal = rt.signalFor?.(task.id);
  for (let i = 0; ; i += 1) {
    const q = await getAgentQuestion(rt.db, ctx, posted.id);
    if (q === null) return { kind: "text", text: toolErrorText("QUESTION_NOT_FOUND") };
    if (q.status === "answered" && q.answer !== null) return { kind: "text", text: answerText(maskSecrets(q.answer, rt.knownSecrets)) };
    const t = await getTask(rt.db, ctx, task.id);
    if (t === null || t.status !== "running" || signal?.aborted === true) {
      await expireAgentQuestion(rt.db, ctx, posted.id);
      await notify("expired");
      return { kind: "halted", reasonCode: t === null ? "task_terminated" : haltedDetails(t).haltReason };
    }
    if (i + 1 >= polls) {
      // 待ちの終わりと答えが重なったら、答えを使う
      const expired = await expireAgentQuestion(rt.db, ctx, posted.id);
      if (expired === null) {
        const late = await getAgentQuestion(rt.db, ctx, posted.id);
        if (late?.status === "answered" && late.answer !== null) return { kind: "text", text: answerText(maskSecrets(late.answer, rt.knownSecrets)) };
      }
      await notify("expired");
      return { kind: "text", text: ASK_USER_NO_ANSWER_TEXT };
    }
    // ハートビートを兼ねる（待っている間も止まったタスクとして拾われない）
    await touchTaskHeartbeat(rt.db, ctx, task.id, rt.clock.now());
    try {
      await sleep(pollMs, signal);
    } catch {
      await expireAgentQuestion(rt.db, ctx, posted.id);
      await notify("expired");
      return { kind: "halted", reasonCode: "kill_switch" };
    }
  }
}
