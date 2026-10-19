// 連絡板（FR-064）の app 側：連絡が載ったことを SSE で届け、終わった担当への question には追いのターンのタスクを作る（A-105）。
// 追いのターン：同じ仕事・同じスナップショット（同じ境界）で、parent_task_id は元のタスク、書き込みのツールなし、reply を1通送って終わる。
// 汚染は親のタスクから始め、質問の連絡の分を足す（taintOnTeamMessage：BR-75）。予算は担当の仕事の予算から（同じ仕事のタスクとして数える）。
// 動かすのはトランザクションの外（run.ts の executeTask）。ここはタスクを作る（queued）ところまで

import { appendAuditLog, lockWorkspace, type AskMemberRow, type TaskRow, type Uuid, type WsCtx } from "@open-team/db";
import { getAgentRow, getTask, listLatestMemberTasks } from "@open-team/db/edge";
import { getAsk, hasFollowupForMessage, insertFollowupTask, listAskMessages, listMembers, listUnansweredQuestionsTo } from "@open-team/db/asks";
import { flattenDirectSources, taintOnTeamMessage } from "@open-team/kernel";
import type { AppDeps } from "../deps.ts";
import { emitAskEvent } from "./events.ts";
import { messageView } from "./view.ts";

type FollowupDeps = Pick<AppDeps, "db" | "clock">;

/** 追いのターンを起こしてよい担当のタスクの状態（終わって、報告がある）。動いているうちは次のターンの入力で届く */
const FINISHED_WITH_REPORT: ReadonlySet<string> = new Set(["succeeded", "completed"]);

/** SSE（ask.message.posted）：連絡が増えたことを画面に届ける */
export async function publishMessagePosted(deps: FollowupDeps, ctx: WsCtx, askId: Uuid, messageId: Uuid): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const m = (await listAskMessages(tx, ctx, askId)).find((x) => x.id === messageId);
    if (m !== undefined) await emitAskEvent(tx, ctx, { type: "ask.message.posted", askId, message: messageView(m) }, deps.clock.now());
  });
}

/**
 * 質問 messageId への追いのターンのタスクを作る（queued）。作らないとき null：質問でない・返事済み・宛先の担当のタスクがまだ動いている／止まっている・
 * もう作ってある・Kill Switch 中・担当が動かせない。同じ質問に2つ作らない（ワークスペースの行のロックの下で確かめる）
 */
export async function createFollowupTask(deps: FollowupDeps, ctx: WsCtx, messageId: Uuid, askId: Uuid): Promise<{ task: TaskRow; member: AskMemberRow & { agent_name: string } } | null> {
  return deps.db.transaction(async (tx) => {
    const now = deps.clock.now();
    const ws = await lockWorkspace(tx, ctx);
    if (ws === null || ws.kill_switch_engaged) return null;
    const ask = await getAsk(tx, ctx, askId);
    if (ask === null || (ask.status !== "running" && ask.status !== "waiting_input" && ask.status !== "done")) return null;
    const messages = await listAskMessages(tx, ctx, askId);
    const q = messages.find((m) => m.id === messageId);
    if (q === undefined || q.kind !== "question" || q.to_member === null) return null;
    if (messages.some((m) => m.kind === "reply" && m.in_reply_to === q.id)) return null;
    if (await hasFollowupForMessage(tx, ctx, q.id)) return null;
    const parent = (await listLatestMemberTasks(tx, ctx, askId)).find((t) => t.ask_member_id === q.to_member);
    if (parent === undefined || !FINISHED_WITH_REPORT.has(parent.status) || parent.report === null) return null;
    const member = (await listMembers(tx, ctx, askId)).find((m) => m.id === q.to_member);
    if (member === undefined) return null;
    const agent = await getAgentRow(tx, ctx, member.agent_id);
    if (agent === null || (agent.status !== "active" && agent.status !== "idle")) return null;

    // 親のタスクの汚染から始め、質問を送った担当の汚染を足す
    const from = await getTask(tx, ctx, q.from_task_id);
    const base = { tainted: parent.tainted, sources: parent.taint_sources };
    const taint = taintOnTeamMessage(
      base,
      {
        messageId: q.id,
        fromTaskId: q.from_task_id,
        fromAgentName: q.from_agent_name,
        tainted: q.tainted,
        upstream: from === null ? [] : flattenDirectSources({ tainted: from.tainted, sources: from.taint_sources }),
      },
      now.toISOString(),
    );
    const task = await insertFollowupTask(tx, ctx, { parent, messageId: q.id, taint, now });
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      {
        eventType: "ask.followup.started",
        actorType: "system",
        actorId: "asks",
        taskId: task.id,
        payload: { askId, messageId: q.id, memberId: member.id, parentTaskId: parent.id, taskId: task.id, tainted: task.tainted },
      },
      now,
    );
    return { task, member };
  });
}

/** 担当のタスクが終わったとき、まだ返事のない質問があれば追いのターンを作る（動いている間に届いて、返事をしないまま終わった担当の質問） */
export async function createFollowupsAfterTerminal(deps: FollowupDeps, ctx: WsCtx, task: TaskRow): Promise<Array<{ task: TaskRow; member: AskMemberRow & { agent_name: string } }>> {
  if (task.ask_id === null || task.ask_member_id === null || task.kind !== "normal" || !FINISHED_WITH_REPORT.has(task.status)) return [];
  const open = await listUnansweredQuestionsTo(deps.db, ctx, task.ask_id, task.ask_member_id);
  const out: Array<{ task: TaskRow; member: AskMemberRow & { agent_name: string } }> = [];
  for (const m of open) {
    const made = await createFollowupTask(deps, ctx, m.id, task.ask_id);
    if (made !== null) out.push(made);
  }
  return out;
}
