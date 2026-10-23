// 担当のタスクを1件動かす Workflow（apps/app/src/asks/run.ts の executeTask の Workflows 版）。DO（asks/drive.ts）がタスクを provisioning にしてから起動する。
// runner の runTask をそのまま回し、EdgePort の呼び出しを1つずつ歩み（step.do）で包む。やり直し（replay）のときは歩みの結果だけで runner が分岐するので、同じ道をたどる。
// - タスクの「トークン」の代わりに taskId を渡す（Workflow の引数と歩みの結果は Cloudflare 側に残るので、秘密を載せない）
// - EdgeError は歩みの中で投げず値（edge/fault.ts の EdgeOutcome）で返し、外で投げ直す（中で投げると Workflow のやり直しにかかる）
// - LLM の1回は1歩：DO の準備（edgeLlmPrepare）→ DO の確かめ（edgeLlmBegin）→ 呼ぶ（やり直しは generateWithRetry の中だけ）→ DO の記録と判定（edgeLlmSettle）。
//   この歩みと道具の歩みは Workflow ではやり直さない（二重の課金・二重の実行を防ぐ）
// - 待ち（RATE_LIMITED）は step.sleep
// 終わったら DO の taskFinished（後始末 → 1歩進める → 次のタスクを起動）

import type { LlmRequest, LlmResponse } from "@open-team/llm";
import type { EdgePort, LlmMessagesResponse, LlmPhase, RunTaskEnd, TaskContext, ToolCallResult } from "@open-team/runner";
import { EdgeError, runTask } from "@open-team/runner";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { unwrapEdge, type EdgeOutcome } from "../edge/fault.ts";
import { generateWithRetry, LlmCallError, LlmGenerateFailure, prepareLlmCall, usageProviderOf, type LlmCallErrorKind, type LlmCallUsage } from "../edge/llm-call.ts";
import { llmOf } from "../llm.ts";
import type { LlmProvider } from "../db/types.ts";

export interface TaskRunParams {
  workspaceId: string;
  taskId: string;
}

const NO_RETRY: WorkflowStepConfig = { retries: { limit: 0, delay: 1_000 } };

/**
 * LLM の1回（やり直しを含む）の打ち切り。歩みはやり直さないので、ここで切らないと Claude が詰まったときに歩みが長く止まり、
 * 落ちると費用が記録されない。切れたときは中断（aborted）として、その回の見積もりを費用に数えて閉じる（edgeLlmFail）
 */
const LLM_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * 歩み（step.do）。結果は JSON にできる値だが、step.do の Serializable の型は unknown を含む型（LlmMessagesResponse・TaskContext など）を通さないので、
 * ここで1か所だけ型を戻す
 */
function stepDo<T>(step: WorkflowStep, name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T> {
  return step.do(name, config, fn as () => Promise<never>) as Promise<T>;
}

/**
 * WorkspaceDO の edge の RPC（workspace-do.ts の edge* と taskFinished）。stub の型の変換（Rpc.Provider）は LlmRequest などの深い型で止まるので、
 * 約束の形をここに書いて stub をこの型で使う
 */
interface TaskEdgeRpc {
  edgeTaskContext(taskId: string): Promise<EdgeOutcome<TaskContext>>;
  edgeLlmPrepare(taskId: string, rawReq: unknown): Promise<EdgeOutcome<{ llmReq: LlmRequest; phase: LlmPhase }>>;
  edgeLlmBegin(taskId: string, a: { budgetEstimateMicroUsd: number; model: string; phase: LlmPhase }): Promise<EdgeOutcome<null>>;
  edgeLlmSettle(
    taskId: string,
    a: { llmReq: LlmRequest; phase: LlmPhase; usage: LlmCallUsage; response: LlmResponse; provider: LlmProvider },
  ): Promise<EdgeOutcome<LlmMessagesResponse>>;
  edgeLlmFail(
    taskId: string,
    a: { llmReq: LlmRequest; phase: LlmPhase; kind: LlmCallErrorKind; llmStatus: number | null; message: string; usage: LlmCallUsage | null; provider: LlmProvider },
  ): Promise<EdgeOutcome<LlmMessagesResponse>>;
  edgePostEvents(taskId: string, events: unknown): Promise<EdgeOutcome<{ accepted: number; dropped: number }>>;
  edgeCallTool(taskId: string, toolCallId: string): Promise<EdgeOutcome<ToolCallResult>>;
  taskFinished(taskId: string, ended: RunTaskEnd | "error"): Promise<void>;
}

/** LLM の1回（runner の llmMessages）。DO の3つの RPC の間で LLM を呼ぶ */
async function llmTurn(env: Env, ws: TaskEdgeRpc, taskId: string, rawReq: unknown): Promise<EdgeOutcome<LlmMessagesResponse>> {
  const prep = await ws.edgeLlmPrepare(taskId, rawReq);
  if (!prep.ok) return prep;
  const { llmReq, phase } = prep.value;
  const { client } = llmOf(env);
  const provider = usageProviderOf(client);
  const fail = (kind: LlmCallErrorKind, message: string, llmStatus: number | null, usage: LlmCallUsage | null) =>
    ws.edgeLlmFail(taskId, { llmReq, phase, kind, llmStatus, message, usage, provider });

  let prepared: ReturnType<typeof prepareLlmCall>;
  try {
    prepared = prepareLlmCall(client, llmReq);
  } catch (e) {
    if (e instanceof LlmCallError) return fail(e.kind, e.message, null, null);
    throw e;
  }
  const begun = await ws.edgeLlmBegin(taskId, { budgetEstimateMicroUsd: prepared.budgetEstimateMicroUsd, model: llmReq.model, phase });
  if (!begun.ok) return begun;
  try {
    const { response, usage } = await generateWithRetry(client, llmReq, prepared, { signal: AbortSignal.timeout(LLM_TURN_TIMEOUT_MS) });
    return await ws.edgeLlmSettle(taskId, { llmReq, phase, usage, response, provider });
  } catch (e) {
    if (e instanceof LlmGenerateFailure) return fail(e.error.kind, e.error.message, e.error.llmError?.status ?? null, e.usage);
    throw e;
  }
}

export class TaskRunWorkflow extends WorkflowEntrypoint<Env, TaskRunParams> {
  async run(event: WorkflowEvent<TaskRunParams>, step: WorkflowStep): Promise<{ ended: RunTaskEnd | "error" }> {
    const { workspaceId, taskId } = event.payload;
    const ws = () => this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId)) as unknown as TaskEdgeRpc;
    // 歩みの名前は呼んだ順の番号（やり直しでも同じ順に呼ぶので同じ名前になる）
    let n = 0;
    const edge: EdgePort = {
      getTaskContext: async () => unwrapEdge(await stepDo(step, "context", {}, async () => ws().edgeTaskContext(taskId))),
      llmMessages: async (_token, req) => unwrapEdge(await stepDo(step, `llm-${++n}`, NO_RETRY, async () => llmTurn(this.env, ws(), taskId, req))),
      // 進み具合の記録はやり直さない（DO が記録してから RPC の戻りで落ちると、やり直しで二重に入る）。落ちたら捨てた分として続ける
      postEvents: async (_token, events) => {
        const name = `events-${++n}`;
        try {
          return unwrapEdge(await stepDo(step, name, NO_RETRY, async () => ws().edgePostEvents(taskId, events)));
        } catch (e) {
          if (e instanceof EdgeError) throw e;
          console.warn("task.events_dropped", { taskId, step: name, error: e instanceof Error ? e.message : String(e) });
          return { accepted: 0, dropped: Array.isArray(events) ? events.length : 0 };
        }
      },
      callTool: async (_token, toolCallId) => unwrapEdge(await stepDo(step, `tool-${++n}`, NO_RETRY, async () => ws().edgeCallTool(taskId, toolCallId))),
    };
    let ended: RunTaskEnd | "error" = "error";
    try {
      const r = await runTask(edge, taskId, { signal: new AbortController().signal, sleep: (ms) => step.sleep(`wait-${++n}`, ms) });
      ended = r.end;
    } catch (e) {
      console.error("task.run_crashed", { taskId, error: e instanceof Error ? e.message : String(e) });
    }
    await step.do("finish", async () => ws().taskFinished(taskId, ended));
    return { ended };
  }
}
