// gateway → sim-world のヘッダー（M-43、SW §4.1.2 の2、cross-check §4.3 の SIM_HEADERS）。
// 値は gateway がタスク・Intent の行から引き直したもの（15:486）。sim-world は呼び出し元を確かめたうえで、この値だけで状態の場所を決める

import { SIM_HEADERS } from "@open-team/sim-core";
import type { WorldId } from "@open-team/sim-core";
import { parseId } from "./ids.ts";
import type { ExecutionKey, SimExecutionRecord } from "./store.ts";

/** ヘッダーの名前（sim-core の SIM_HEADERS と同じ並び） */
export const [HEADER_WORKSPACE, HEADER_REHEARSAL_RUN, HEADER_EXECUTION, HEADER_TASK, HEADER_INTENT, HEADER_SHADOW] = SIM_HEADERS;

export interface SimCallHeaders {
  workspaceId: string;
  /** NULL＝本番（デモ店舗） */
  rehearsalRunId: string | null;
  /** NULL＝デモ店舗（rehearsalRunId も NULL のときだけ） */
  executionId: string | null;
  taskId: string | null;
  /** 書き込みのとき（計測（G-11）は Intent を持たないので省略できる） */
  intentId: string | null;
  shadow: boolean;
}

type Parsed = { ok: true; value: SimCallHeaders } | { ok: false; message: string };

/**
 * X-OT-* を読む。ワークスペースは必須。ほかは無ければ null（空の値・UUID でない値は誤り）。
 * 影はリハーサルの中だけ（tasks の CHECK：shadow → rehearsal_run_id）、リハーサルは走行の ID が要る
 * （無いままデモ店舗に落とすと、リハーサルの書き込みがデモ店舗に入る：SW-11）
 */
export function parseSimHeaders(headers: Headers): Parsed {
  const id = (name: string): { ok: true; value: string | null } | { ok: false; message: string } => {
    const raw = headers.get(name);
    if (raw === null) return { ok: true, value: null };
    const value = parseId(raw);
    return value !== null ? { ok: true, value } : { ok: false, message: `${name} が UUID ではありません` };
  };
  const workspace = id(HEADER_WORKSPACE);
  if (!workspace.ok) return workspace;
  if (workspace.value === null) return { ok: false, message: `${HEADER_WORKSPACE} がありません` };
  const run = id(HEADER_REHEARSAL_RUN);
  if (!run.ok) return run;
  const execution = id(HEADER_EXECUTION);
  if (!execution.ok) return execution;
  const task = id(HEADER_TASK);
  if (!task.ok) return task;
  const intent = id(HEADER_INTENT);
  if (!intent.ok) return intent;

  const rawShadow = headers.get(HEADER_SHADOW);
  if (rawShadow !== null && rawShadow !== "true" && rawShadow !== "false") {
    return { ok: false, message: `${HEADER_SHADOW} は true か false` };
  }
  const shadow = rawShadow === "true";
  if (shadow && run.value === null) return { ok: false, message: `影の走行には ${HEADER_REHEARSAL_RUN} が要ります` };
  if (run.value !== null && execution.value === null) {
    return { ok: false, message: `リハーサルの走行には ${HEADER_EXECUTION} が要ります` };
  }
  return {
    ok: true,
    value: {
      workspaceId: workspace.value,
      rehearsalRunId: run.value,
      executionId: execution.value,
      taskId: task.value,
      intentId: intent.value,
      shadow,
    },
  };
}

/** 状態の場所（SW §4.1.2 の3：走行の ID がなければデモ店舗） */
export function executionKeyOf(world: WorldId, h: SimCallHeaders): ExecutionKey {
  return h.executionId !== null ? { workspaceId: h.workspaceId, id: h.executionId } : { workspaceId: h.workspaceId, demoStoreOf: world };
}

/** 引いた走行がヘッダーと食い違っていれば理由（世界・リハーサル・影の印のどれか）。合っていれば null */
export function executionMismatch(exec: SimExecutionRecord, world: WorldId, h: SimCallHeaders): string | null {
  if (exec.world !== world) return `走行の世界（${exec.world}）が URL の世界（${world}）と違います`;
  if (exec.rehearsalRunId !== h.rehearsalRunId) return `${HEADER_REHEARSAL_RUN} が走行と合いません`;
  if ((exec.variant === "shadow") !== h.shadow) return `${HEADER_SHADOW} が走行の種類（${exec.variant}）と合いません`;
  return null;
}
