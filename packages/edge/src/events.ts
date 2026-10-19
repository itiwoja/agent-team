// 進捗（edge の postEvents。API-038：si:133・135、FR-018：rt:152）
// 1回20件まで（超えた分は dropped：HL-24 の案）、1タスク毎秒10件まで（超えた分は捨てて dropped に数える）。finished は数えない。
// ハートビートを兼ねる（last_heartbeat_at）。finished → タスクを failed（agent_no_change / agent_unable）、トークンを失効（si:135）

import type { JsonObject } from "@open-team/kernel";
import type { ProgressEvent } from "@open-team/runner";
import { maskSecrets } from "@open-team/platform";
import { lockWorkspace, type TaskRow, type WsCtx } from "@open-team/db";
import { insertTaskEvent, lockTask, touchTaskHeartbeat } from "@open-team/db/edge";
import { failTask } from "./halt.ts";
import { notifyTerminal, type EdgeRuntime } from "./runtime.ts";
import { resolveTaskByToken } from "./tokens.ts";
import { truncateChars } from "./util.ts";
import { parseProgressEvents } from "./validate.ts";

/** 保存する payload（runner の値はマスクして上限で切る。by: 'runner' で edge の記録と見分ける） */
function storedPayload(rt: EdgeRuntime, e: Exclude<ProgressEvent, { type: "finished" }>): JsonObject {
  const m = (s: string, max: number) => truncateChars(maskSecrets(s, rt.knownSecrets), max);
  switch (e.type) {
    case "phase_started":
      return { phase: m(e.payload.phase, rt.limits.phaseNameMaxChars), by: "runner" };
    case "tool_called":
      return {
        toolCallId: truncateChars(e.payload.toolCallId, rt.limits.toolCallIdMaxChars),
        name: truncateChars(e.payload.name, 200),
        resultSummary: m(e.payload.resultSummary, rt.limits.resultSummaryMaxChars),
        by: "runner",
      };
    case "message":
      return { text: m(e.payload.text, rt.limits.eventTextMaxChars), by: "runner" };
  }
}

/** finished（エージェントの finish・runner が代わりに送ったもの）：タスクを failed にする。もう running でなければ何もしない */
async function finishTask(rt: EdgeRuntime, ctx: WsCtx, task: TaskRow, e: Extract<ProgressEvent, { type: "finished" }>): Promise<TaskRow | null> {
  const reason = truncateChars(maskSecrets(e.payload.reason, rt.knownSecrets), rt.limits.finishReasonMaxChars);
  return rt.db.transaction(
    async (tx) => {
      const now = rt.clock.now();
      await lockWorkspace(tx, ctx);
      const t = await lockTask(tx, ctx, task.id);
      if (t === null || t.status !== "running") return null;
      await insertTaskEvent(tx, ctx, t.id, "finished", { outcome: e.payload.outcome, reason, by: "runner" }, now);
      return failTask(tx, ctx, t, e.payload.outcome === "no_change" ? "agent_no_change" : "agent_unable", now, { outcome: e.payload.outcome }, {
        type: "agent",
        id: t.agent_id,
      });
    },
    { retryOnce: true },
  );
}

export async function postEvents(rt: EdgeRuntime, token: string, raw: unknown): Promise<{ accepted: number; dropped: number }> {
  const now = rt.clock.now();
  const { ctx, task } = await resolveTaskByToken(rt.db, token, now);
  const events = parseProgressEvents(raw);
  const considered = events.slice(0, rt.limits.eventsPerRequest);
  const finished = considered.filter((e): e is Extract<ProgressEvent, { type: "finished" }> => e.type === "finished");
  const others = considered.filter((e): e is Exclude<ProgressEvent, { type: "finished" }> => e.type !== "finished");
  const { allowed } = rt.eventLimiter.tryAcquire(task.id, now.getTime(), others.length);
  const kept = others.slice(0, allowed);
  for (const e of kept) await insertTaskEvent(rt.db, ctx, task.id, e.type, storedPayload(rt, e), now);
  await touchTaskHeartbeat(rt.db, ctx, task.id, now);
  const first = finished[0];
  if (first !== undefined) {
    const ended = await finishTask(rt, ctx, task, first);
    if (ended !== null) await notifyTerminal(rt, ctx, task.id, ended.status);
  }
  const accepted = kept.length + finished.length;
  return { accepted, dropped: events.length - accepted };
}
