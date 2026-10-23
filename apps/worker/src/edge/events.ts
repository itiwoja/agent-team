// 進捗（packages/edge/src/events.ts の postEvents の WorkspaceDO 版。API-038：si:133・135、FR-018：rt:152）
// 1回20件まで（超えた分は dropped：HL-24 の案）、1タスク毎秒10件まで（超えた分は捨てて dropped に数える）。finished は数えない。
// ハートビートを兼ねる（last_heartbeat_at）。finished → タスクを failed（agent_no_change / agent_unable）（si:135）。
// Node 版との違い：同期。トークンの代わりに taskId。終わったタスクの通知（onTaskTerminal）はなく、回数の数えを捨てるだけ

import type { JsonObject } from "@open-team/kernel";
import type { ProgressEvent } from "@open-team/runner";
import { maskSecrets } from "@open-team/platform";
import { getTask, insertTaskEvent, touchTaskHeartbeat } from "../db/repo/edge.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { TaskRow } from "../db/types.ts";
import { failTask } from "./halt.ts";
import { forgetTask, type TaskEdgeRuntime } from "./runtime.ts";
import { resolveTask } from "./tokens.ts";
import { truncateChars } from "./util.ts";
import { parseProgressEvents } from "./validate.ts";

/** 保存する payload（runner の値はマスクして上限で切る。by: 'runner' で edge の記録と見分ける） */
function storedPayload(rt: TaskEdgeRuntime, e: Exclude<ProgressEvent, { type: "finished" }>): JsonObject {
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
function finishTask(db: WsDb, rt: TaskEdgeRuntime, taskId: string, e: Extract<ProgressEvent, { type: "finished" }>, now: Date): TaskRow | null {
  const reason = truncateChars(maskSecrets(e.payload.reason, rt.knownSecrets), rt.limits.finishReasonMaxChars);
  return db.transaction(() => {
    const t = getTask(db, taskId);
    if (t === null || t.status !== "running") return null;
    insertTaskEvent(db, t.id, "finished", { outcome: e.payload.outcome, reason, by: "runner" }, now);
    return failTask(db, t, e.payload.outcome === "no_change" ? "agent_no_change" : "agent_unable", now, { outcome: e.payload.outcome }, {
      type: "agent",
      id: t.agent_id,
    });
  });
}

export function edgePostEvents(db: WsDb, rt: TaskEdgeRuntime, taskId: string, raw: unknown, now: Date): { accepted: number; dropped: number } {
  const { task } = resolveTask(db, taskId, now);
  const events = parseProgressEvents(raw);
  const considered = events.slice(0, rt.limits.eventsPerRequest);
  const finished = considered.filter((e): e is Extract<ProgressEvent, { type: "finished" }> => e.type === "finished");
  const others = considered.filter((e): e is Exclude<ProgressEvent, { type: "finished" }> => e.type !== "finished");
  const { allowed } = rt.eventLimiter.tryAcquire(task.id, now.getTime(), others.length);
  const kept = others.slice(0, allowed);
  db.transaction(() => {
    for (const e of kept) insertTaskEvent(db, task.id, e.type, storedPayload(rt, e), now);
    touchTaskHeartbeat(db, task.id, now);
  });
  const first = finished[0];
  if (first !== undefined && finishTask(db, rt, task.id, first, now) !== null) forgetTask(rt, task.id);
  const accepted = kept.length + finished.length;
  return { accepted, dropped: events.length - accepted };
}
