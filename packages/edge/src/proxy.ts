// LLM Proxy（edge の llmMessages。FR-009、formation-runtime.md §3.10、M-14・M-15・M-19）
// 1 トークンでタスクを引き直す → 2 入力の検証（Zod）→ 3 1分あたり60回 → 4 Router でモデル → 5 見積もり →
// 6 callGemini の中の1トランザクション：Kill Switch・checkSpend（全体・ゲスト・リハーサル）・decide(llm_call) → 7 Gemini（やり直し）→
// 8 1トランザクション：usage_records・tasks.cost_usd／steps_used・task_events・監査ログ llm.called → 9 応答のツール呼び出しを順に decide
// （エージェントの MCP の書き込みも kind: 'tool_call' で1回だけ：M-14。書き込みはその結果で Intent にする：recordMcpIntent）。
// 1つの応答で submit_report より後ろの呼び出しは判定せず Intent にもしない（決定 (e)。記録だけ：runner が捨てるのと合わせる）

import {
  KERNEL_VERSION,
  computeInputsHash,
  decide,
  formatUsd,
  fromMicroUsd,
  nextCounters,
  type CatalogToolName,
  type Counters,
  type DecideResult,
  type Decision,
  type DecisionDetail,
  type EffectivePolicy,
  type Flags,
  type JsonObject,
  type OperationType,
  type Subject,
  type TaintState,
} from "@open-team/kernel";
import { EdgeError, type AssistantPart, type GovernanceEntry, type LlmMessagesResponse, type ToolCallPart } from "@open-team/runner";
import { modelForPhase, modelForRole, type LlmRequest } from "@open-team/llm";
import { appendAuditLog, lockWorkspace, system, type TaskRow, type Tx, type Uuid, type WorkspaceRow, type WsCtx } from "@open-team/db";
import {
  addTaskUsage,
  getTask,
  insertPolicyDecision,
  insertTaskEvent,
  listToolCallIds,
  lockTask,
  updateTaskCounters,
} from "@open-team/db/edge";
import { loadTaskSetup, type TaskSetup } from "./context.ts";
import { GeminiCallError, callGemini, promptHashOf, type GeminiCallContext } from "./gemini.ts";
import { failTask, haltCauseOf, haltCauseOfSpend, haltTask } from "./halt.ts";
import { loadDecideBase, parseMcpCallArgs, resolveMcpSubject, type DecideBase, type McpTarget } from "./inputs.ts";
import { recordMcpIntent, shadowIgnores, type RecordedMcpIntent } from "./intents.ts";
import { commandDeniedNote, commandTaintOf, judgeCommand, type CommandJudgement } from "./sandbox-command.ts";
import { notifyTerminal, runHook, type EdgeRuntime } from "./runtime.ts";
import { checkToolArguments } from "./schema-check.ts";
import { haltedDetails, isTerminalStatus, resolveTaskByToken } from "./tokens.ts";
import { charCount, toJsonObject } from "./util.ts";
import { parseLlmMessagesRequest } from "./validate.ts";

/** 判定の結果（kernel の DecideResult か、edge の境界の拒否。境界の理由コードは kernel の ReasonCode にない：BR-64 の guest_workspace） */
export interface Judged {
  decision: Decision;
  reasonCode: string;
  matchedRule: string | null;
  /** 一致したルールの id（kernel の DecideResult.matchedRuleId。SG-09） */
  matchedRuleId?: string;
  inputsHash: string;
  operation: OperationType | null;
  detail?: DecisionDetail;
}

/** 実際に効かせる判定（影の走行は Breaker・deny・approve を記録だけにする：SW §4.5-2。境界の拒否は影でも効かせる） */
export function enforcementOf(r: Pick<Judged, "decision" | "reasonCode">, shadow: boolean, boundary = false): { effective: Decision; enforced: boolean } {
  if (!shadow || boundary) return { effective: r.decision, enforced: true };
  if (shadowIgnores(r)) return { effective: "allow", enforced: false };
  return { effective: r.decision, enforced: r.decision !== "allow" };
}

function agentModelOf(rt: EdgeRuntime): string {
  return modelForRole(rt.models, "agent");
}

/** 判定の記録（policy_decisions）と、allow 以外・Intent への判定の監査ログ decision.made（API-037 の副作用・platform.md:128） */
async function recordDecision(
  tx: Tx,
  ctx: WsCtx,
  task: Pick<TaskRow, "id" | "agent_id">,
  d: {
    subjectKind: "tool_call" | "llm_call";
    subject: JsonObject;
    action: string | null;
    counters: Counters;
    flags: Flags;
    taint: TaintState;
    result: Judged;
    enforced: boolean;
    intentId: Uuid | null;
  },
  now: Date,
): Promise<void> {
  await insertPolicyDecision(
    tx,
    ctx,
    {
      taskId: task.id,
      intentId: d.intentId,
      subjectKind: d.subjectKind,
      actionType: d.result.operation,
      subject: d.subject,
      counters: d.counters as unknown as JsonObject,
      flags: d.flags as unknown as JsonObject,
      taint: d.taint,
      decision: d.result.decision,
      reasonCode: d.result.reasonCode,
      matchedRule: d.result.matchedRule,
      matchedRuleId: d.result.matchedRuleId ?? null,
      detail: d.result.detail === undefined ? null : (structuredClone(d.result.detail) as unknown as JsonObject),
      enforced: d.enforced,
      inputsHash: d.result.inputsHash,
      kernelVersion: KERNEL_VERSION,
    },
    now,
  );
  if (d.result.decision !== "allow" || d.intentId !== null) {
    await appendAuditLog(
      tx,
      ctx.workspaceId,
      {
        eventType: "decision.made",
        actorType: "agent",
        actorId: task.agent_id,
        taskId: task.id,
        payload: {
          taskId: task.id,
          subjectKind: d.subjectKind,
          action: d.action,
          operation: d.result.operation,
          decision: d.result.decision,
          reasonCode: d.result.reasonCode,
          matchedRule: d.result.matchedRule,
          // ルールに一致したときだけ id を足す（SG-09。ほかの判定の payload は今までの形のまま）
          ...(d.result.matchedRuleId === undefined ? {} : { matchedRuleId: d.result.matchedRuleId }),
          inputsHash: d.result.inputsHash,
          enforced: d.enforced,
          intentId: d.intentId,
        },
      },
      now,
    );
  }
}

/** 判定に掛けるツール呼び出しの subject（M-15：actionType はカタログのツール名。知らない名前もそのまま入れて decide が unknown_action） */
interface BuiltCall {
  subject: Subject;
  mcp: McpTarget | null;
  /** edge の境界で先に拒否する（BR-64：ゲストの web_search。decide の前：KD §8-38） */
  boundary: { reasonCode: string; operation: OperationType } | null;
  /** run_command の写し先（SG-07）。ほかのツールは null */
  command: CommandJudgement | null;
}

async function buildCallSubject(tx: Tx, ctx: WsCtx, call: ToolCallPart, workspace: WorkspaceRow, taint: TaintState): Promise<BuiltCall> {
  if (call.name === "mcp_call") {
    const parsed = parseMcpCallArgs(call.arguments);
    if (parsed === null) {
      return { subject: { kind: "tool_call", actionType: "mcp_call", args: {}, paths: [], origin: "agent" }, mcp: null, boundary: null, command: null };
    }
    const r = await resolveMcpSubject(tx, ctx, parsed);
    return { subject: r.subject, mcp: r.mcp, boundary: null, command: null };
  }
  const subject: Subject = {
    kind: "tool_call",
    // 知らない名前もそのまま（decide がカタログにないものを unknown_action にする：BR-09）
    actionType: call.name as CatalogToolName,
    args: toJsonObject(call.arguments) ?? {},
    paths: [],
    origin: "agent",
  };
  if (call.name === "web_search" && workspace.kind === "guest") {
    return { subject, mcp: null, boundary: { reasonCode: "guest_workspace", operation: "web_read" }, command: null };
  }
  if (call.name === "run_command") {
    // SG-07：汚染（外の内容を読んだか）と形から、run_tests と run_shell のどちらとして判定するかをここで決める。
    // 汚染は decide の手順の条件には入れない（BR-39）。decide は subject.commandOperation と形だけを見る
    const command = judgeCommand(subject.args, taint);
    return { subject: { ...subject, commandOperation: command.operation }, mcp: null, boundary: null, command };
  }
  return { subject, mcp: null, boundary: null, command: null };
}

export interface JudgedCalls {
  /** 応答の部品（ID を作り直したもの。runner はこの ID で governance・callTool を引く） */
  content: AssistantPart[];
  governance: GovernanceEntry[];
  intents: RecordedMcpIntent[];
  halted: boolean;
  /** submit_report より後ろで判定しなかった呼び出しの数（決定 (e)） */
  ignored: number;
}

/** モデルの ID が空・長すぎる・このタスクで使った ID と重なるときは作り直す（ID は governance・callTool の鍵） */
function freshId(rt: EdgeRuntime, used: ReadonlySet<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = rt.newId();
    if (id !== "" && charCount(id) <= rt.limits.toolCallIdMaxChars && !used.has(id)) return id;
  }
  throw new Error("ツール呼び出しの ID を作れなかった");
}

/**
 * 応答のツール呼び出しを応答の順に判定する（formation-runtime.md §3.10-9、§8-36）。同じトランザクション（usage の記録のあと）。
 * カウンタは1回ずつ nextCounters で進め、最後にタスクの行に書く。halt（効かせるもの）で止め、残りは判定しない
 */
export async function judgeToolCalls(
  rt: EdgeRuntime,
  tx: Tx,
  ctx: WsCtx,
  task: TaskRow,
  setup: TaskSetup,
  parts: readonly AssistantPart[],
  now: Date,
): Promise<JudgedCalls> {
  const used = new Set(await listToolCallIds(tx, ctx, task.id));
  const content: AssistantPart[] = parts.map((p) => {
    if (p.type !== "tool_call") return structuredClone(p);
    const id = typeof p.id === "string" && p.id !== "" && charCount(p.id) <= rt.limits.toolCallIdMaxChars && !used.has(p.id) ? p.id : freshId(rt, used);
    used.add(id);
    return { ...structuredClone(p), id };
  });
  const calls = content.filter((p): p is ToolCallPart => p.type === "tool_call");
  const reportAt = calls.findIndex((c) => c.name === "submit_report");
  const judgedCalls = reportAt === -1 ? calls : calls.slice(0, reportAt + 1);
  const ignored = calls.length - judgedCalls.length;
  if (judgedCalls.length === 0) return { content, governance: [], intents: [], halted: false, ignored };

  const base: DecideBase = await loadDecideBase(tx, ctx, task, now, { modelId: agentModelOf(rt), taskPolicy: setup.taskPolicy });
  const policy: EffectivePolicy = base.taskPolicy.policy;
  let counters = base.counters;
  const governance: GovernanceEntry[] = [];
  const intents: RecordedMcpIntent[] = [];
  let halted = false;

  // SG-07：run_command の写し先に使う汚染（作業場が受け取る控えの汚染を先に足したもの）。run_command があるときだけ読む
  const commandTaint = judgedCalls.some((c) => c.name === "run_command") ? await commandTaintOf(tx, ctx, task, base.taint, now) : base.taint;
  for (const call of judgedCalls) {
    const built = await buildCallSubject(tx, ctx, call, base.workspace, commandTaint);
    let kernelResult: DecideResult | null = null;
    let result: Judged;
    if (built.boundary !== null) {
      result = {
        decision: "deny",
        reasonCode: built.boundary.reasonCode,
        matchedRule: null,
        inputsHash: computeInputsHash(policy, built.subject, counters, base.flags, base.taint),
        operation: built.boundary.operation,
      };
    } else {
      kernelResult = decide(policy, built.subject, counters, base.flags, base.taint);
      result = kernelResult;
    }
    const outcome = enforcementOf(result, task.shadow, built.boundary !== null);

    // MCP の書き込み（未分類も書き込み：ADR-022）は判定の結果で Intent にする（M-14）
    let intent: RecordedMcpIntent | null = null;
    let invalidArgs: string[] | null = null;
    const mcp = built.mcp;
    if (mcp !== null && mcp.info.classification !== "read" && kernelResult !== null) {
      // 実行されうる（allow・影）か承認に回る（approve）Intent は、入力スキーマに合わなければ作らない（M-12。ツールのエラーで返す）
      const pendingOrRun = outcome.effective === "allow" || (outcome.effective === "approve" && kernelResult.decision === "approve");
      if (pendingOrRun) {
        const check = checkToolArguments(mcp.tool.input_schema, built.subject.args, rt.limits.mcpArgsMaxBytes);
        if (!check.ok) invalidArgs = check.issues;
      }
      if (invalidArgs === null) {
        intent = await recordMcpIntent(tx, ctx, {
          task,
          mcp,
          args: built.subject.args,
          origin: "agent",
          result: kernelResult,
          policy,
          policyHash: base.taskPolicy.policyHash,
          taint: base.taint,
          now,
        });
        intents.push(intent);
      }
    }

    const effective: Decision = invalidArgs !== null ? "allow" : outcome.effective;
    const callRecord: JsonObject = {
      toolCallId: call.id,
      name: call.name,
      effective,
      ...(intent !== null ? { intentId: intent.intentId } : {}),
      ...(invalidArgs !== null ? { invalidArgs } : {}),
    };
    await recordDecision(
      tx,
      ctx,
      task,
      {
        subjectKind: "tool_call",
        subject: { ...(built.subject as unknown as JsonObject), call: callRecord },
        action: built.subject.action ?? built.subject.actionType ?? null,
        counters,
        flags: base.flags,
        taint: base.taint,
        result,
        enforced: outcome.enforced,
        intentId: intent?.intentId ?? null,
      },
      now,
    );
    // 進捗（TBL-007 の tool_called：ツール名・判定。API-037 の副作用）。runner の進捗とは by で見分ける
    await insertTaskEvent(
      tx,
      ctx,
      task.id,
      "tool_called",
      {
        toolCallId: call.id,
        name: call.name,
        decision: result.decision,
        reasonCode: result.reasonCode,
        effective,
        by: "proxy",
        ...(intent !== null ? { intentId: intent.intentId, intentStatus: intent.status } : {}),
      },
      now,
    );
    counters = nextCounters(counters, built.subject, { ...result, decision: result.decision } as DecideResult, intent !== null);

    // SG-07：run_shell として実行しないコマンドには、ここでは動かせないことと使える形を添える
    const note = built.command !== null && result.operation === "run_shell" && effective !== "allow" ? commandDeniedNote(built.command) : undefined;
    governance.push({
      toolCallId: call.id,
      decision: effective,
      reasonCode: invalidArgs !== null ? "invalid_arguments" : result.reasonCode,
      matchedRule: result.matchedRule,
      ...(intent !== null ? { intent: { intentId: intent.intentId, status: intent.agentStatus } } : {}),
      ...(note !== undefined ? { note } : {}),
    });

    if (outcome.effective === "halt") {
      const cause = kernelResult === null ? null : haltCauseOf(kernelResult);
      if (cause !== null) await haltTask(tx, ctx, task, cause, now);
      halted = true;
      break;
    }
  }
  await updateTaskCounters(tx, ctx, task.id, { deniedCount: counters.deniedCount, repeatKey: counters.repeatKey, repeatCount: counters.repeatCount }, now);
  return { content, governance, intents, halted, ignored };
}

/**
 * API-037 相当（formation-runtime.md §3.10）。エラーは runner の EdgeError：401 UNAUTHORIZED・409 TASK_HALTED（details.haltReason）・
 * 400 VALIDATION_ERROR・429 RATE_LIMITED（retryAfterSec）・502 LLM_UPSTREAM_ERROR（タスクは failed(llm_unavailable)）
 */
export async function llmMessages(rt: EdgeRuntime, token: string, rawReq: unknown): Promise<LlmMessagesResponse> {
  const startedAt = rt.clock.now();
  const { ctx, task, workspace } = await resolveTaskByToken(rt.db, token, startedAt);
  const req = parseLlmMessagesRequest(rawReq, rt.limits);
  const setup = await loadTaskSetup(rt.db, ctx, task, workspace, undefined, { sandboxProvider: rt.sandbox !== null, trustedSkills: rt.trustedSkills });
  // tools ⊆ TaskContext.tools（§3.10-2）。宣言の中身は runner の値ではなく edge が作ったものを使う
  const outside = req.tools.map((t) => t.name).filter((n) => !setup.toolNames.has(n));
  if (outside.length > 0) throw new EdgeError("VALIDATION_ERROR", { reason: "tool_not_in_context", tools: outside });
  const requested = new Set(req.tools.map((t) => t.name));
  const tools = setup.tools.filter((t) => requested.has(t.name)).map((t) => structuredClone(t));

  // 3. 1分あたりの回数（si:106）
  const acquired = rt.llmLimiter.tryAcquire(task.id, startedAt.getTime());
  if (acquired.allowed === 0) {
    throw new EdgeError("RATE_LIMITED", { limitPerMinute: rt.limits.llmCallsPerMinute }, Math.max(1, Math.ceil(acquired.retryAfterMs / 1000)));
  }

  // 4. Router（0-H はどの phase も Flash 系：§8-7）
  const model = modelForPhase(rt.models, req.phase);
  const llmReq: LlmRequest = {
    model,
    system: req.system,
    messages: req.messages,
    tools,
    mcpTools: tools.some((t) => t.name === "mcp_call") ? setup.mcpTools : [],
    maxTokens: req.maxTokens,
  };
  const signal = rt.signalFor?.(task.id);
  const gctx: GeminiCallContext = {
    workspaceId: ctx.workspaceId,
    workspaceKind: ctx.kind,
    taskId: task.id,
    agentId: task.agent_id,
    askId: null,
    rehearsalRunId: task.rehearsal_run_id,
    purpose: "agent",
    phase: req.phase,
    ...(signal !== undefined ? { signal } : {}),
  };

  const state: {
    judged: JudgedCalls | null;
    afterHalt: EdgeError | null;
    budget: { cost_usd: string; steps_used: number } | null;
    terminal: boolean;
  } = { judged: null, afterHalt: null, budget: null, terminal: false };

  let called;
  try {
    called = await callGemini(
      { db: rt.db, llm: rt.llm, clock: rt.clock, log: rt.log, retry: rt.retry, spendLimits: rt.spendLimits },
      gctx,
      llmReq,
      {
        // Kill Switch・全体 $15・ゲスト $4・リハーサル $3（M-19）。タスクの中で止めたら halted(budget_exceeded)＋監査ログ budget.exceeded
        onStopped: async (tx, stop, now) => {
          const t = await lockTask(tx, ctx, task.id);
          if (t === null || isTerminalStatus(t.status)) return;
          const cause = stop.kind === "kill_switch" ? { reason: "kill_switch" as const } : haltCauseOfSpend(stop.spend);
          if ((await haltTask(tx, ctx, t, cause, now)) !== null) state.terminal = true;
        },
        // 6. decide(llm_call)：予算（per_task_usd・per_day_usd・agent_day_usd・max_steps・max_minutes）と Breaker
        beforeCall: async (tx, est, now) => {
          const t = await lockTask(tx, ctx, task.id);
          if (t === null) return { ok: false, error: new EdgeError("UNAUTHORIZED") };
          if (t.status !== "running") return { ok: false, error: new EdgeError("TASK_HALTED", haltedDetails(t)) };
          const subject: Subject = { kind: "llm_call", actionType: null, args: {}, paths: [], estimatedCostUsd: fromMicroUsd(est) };
          const base = await loadDecideBase(tx, ctx, t, now, { modelId: agentModelOf(rt), taskPolicy: setup.taskPolicy });
          const r = decide(base.taskPolicy.policy, subject, base.counters, base.flags, base.taint);
          const outcome = enforcementOf(r, t.shadow);
          await recordDecision(
            tx,
            ctx,
            t,
            {
              subjectKind: "llm_call",
              subject: { ...(subject as unknown as JsonObject), phase: req.phase, model },
              action: null,
              counters: base.counters,
              flags: base.flags,
              taint: base.taint,
              result: r,
              enforced: outcome.enforced,
              intentId: null,
            },
            now,
          );
          if (outcome.effective !== "halt") return { ok: true };
          const cause = haltCauseOf(r);
          if (cause !== null && (await haltTask(tx, ctx, t, cause, now)) !== null) state.terminal = true;
          return {
            ok: false,
            error: new EdgeError("TASK_HALTED", { haltReason: cause?.reason ?? r.reasonCode, reasonCode: r.reasonCode, matchedRule: r.matchedRule }),
          };
        },
        // 8・9. 費用とステップを足し、応答のツール呼び出しを判定する
        afterCall: async (tx, usage, response, now) => {
          const t = await lockTask(tx, ctx, task.id);
          if (t === null) return;
          const added = await addTaskUsage(tx, ctx, t.id, system.microToUsd(usage.costMicroUsd), 1, now);
          if (added === null) return;
          state.budget = added;
          const calls = response.parts.filter((p) => p.type === "tool_call").length;
          await insertTaskEvent(
            tx,
            ctx,
            t.id,
            "llm_called",
            {
              model: usage.model,
              phase: req.phase,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens + usage.thinkingTokens,
              costUsd: system.microToUsd(usage.costMicroUsd),
              toolCalls: calls,
            },
            now,
          );
          // Kill Switch・停止が呼んでいる間に来た：費用だけ数え、ツール呼び出しは判定しない
          if (t.status !== "running") {
            state.afterHalt = new EdgeError("TASK_HALTED", haltedDetails(t));
            await auditLlmCalled(tx, ctx, t, usage, llmReq, 0, now);
            return;
          }
          const refreshed: TaskRow = { ...t, cost_usd: added.cost_usd, steps_used: added.steps_used };
          state.judged = await judgeToolCalls(rt, tx, ctx, refreshed, setup, response.parts, now);
          await auditLlmCalled(tx, ctx, t, usage, llmReq, state.judged.ignored, now);
          if (state.judged.halted) state.terminal = true;
        },
        // 7. やり直しのあとも失敗 → failed(llm_unavailable)（送れたか分からない回の見積もりは費用に足す）
        afterFailure: async (tx, error, usage, now) => {
          const t = await lockTask(tx, ctx, task.id);
          if (t === null) return;
          if (usage.costMicroUsd > 0) await addTaskUsage(tx, ctx, t.id, system.microToUsd(usage.costMicroUsd), 0, now);
          if (error.kind === "llm" && t.status === "running") {
            const ended = await failTask(tx, ctx, t, "llm_unavailable", now, { llmStatus: error.llmError?.status ?? null });
            if (ended !== null) state.terminal = true;
          }
        },
      },
    );
  } catch (e) {
    if (state.terminal) await notifyTerminalOf(rt, ctx, task.id);
    if (!(e instanceof GeminiCallError)) throw e;
    switch (e.kind) {
      case "stopped":
        throw e.stopError instanceof EdgeError ? e.stopError : new EdgeError("TASK_HALTED", { haltReason: "task_terminated" });
      case "kill_switch":
        throw new EdgeError("TASK_HALTED", { haltReason: "kill_switch" });
      case "budget":
        throw new EdgeError("TASK_HALTED", { haltReason: "budget_exceeded", scope: e.spend?.scope ?? null });
      case "unpriced_model": {
        // 価格表にないモデルは呼ばない（決定 (d)）。費用を数えられないので、このタスクは続けられない
        const ended = await rt.db.transaction(async (tx) => {
          await lockWorkspace(tx, ctx);
          const t = await lockTask(tx, ctx, task.id);
          return t === null || t.status !== "running" ? null : failTask(tx, ctx, t, "llm_unavailable", rt.clock.now(), { reason: "unpriced_model", model });
        });
        if (ended !== null) await notifyTerminal(rt, ctx, task.id, ended.status);
        throw new EdgeError("LLM_UPSTREAM_ERROR", { reason: "unpriced_model" });
      }
      case "aborted":
        throw new EdgeError("TASK_HALTED", { haltReason: "aborted" });
      case "llm":
        throw new EdgeError("LLM_UPSTREAM_ERROR", { status: e.llmError?.status ?? null });
    }
  }

  // コミットのあと
  if (state.judged !== null) {
    for (const i of state.judged.intents) {
      const hook = rt.hooks.onIntentRecorded;
      if (hook) await runHook(rt, "onIntentRecorded", task.id, () => hook(ctx, { taskId: task.id, intentId: i.intentId, status: i.status, shadow: task.shadow }));
    }
  }
  if (state.terminal) await notifyTerminalOf(rt, ctx, task.id);
  if (state.afterHalt !== null) throw state.afterHalt;

  const { response, usage } = called;
  const judged = state.judged;
  return {
    model: response.model,
    content: judged?.content ?? structuredClone(response.parts),
    stopReason: response.stopReason,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens + usage.thinkingTokens,
      costUsd: formatUsd(fromMicroUsd(usage.costMicroUsd)),
    },
    governance: judged?.governance ?? [],
    budget: { costUsd: state.budget?.cost_usd ?? task.cost_usd, stepsUsed: state.budget?.steps_used ?? task.steps_used },
  };
}

/** 監査ログ llm.called（モデル・トークン数・費用・プロンプトのハッシュ。本文は入れない：§3.10-8） */
async function auditLlmCalled(
  tx: Tx,
  ctx: WsCtx,
  task: Pick<TaskRow, "id" | "agent_id">,
  usage: { model: string; inputTokens: number; outputTokens: number; thinkingTokens: number; costMicroUsd: number; attempts: number },
  req: LlmRequest,
  ignoredToolCalls: number,
  now: Date,
): Promise<void> {
  await appendAuditLog(
    tx,
    ctx.workspaceId,
    {
      eventType: "llm.called",
      actorType: "agent",
      actorId: task.agent_id,
      taskId: task.id,
      payload: {
        taskId: task.id,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        thinkingTokens: usage.thinkingTokens,
        costUsd: system.microToUsd(usage.costMicroUsd),
        attempts: usage.attempts,
        promptHash: promptHashOf(req),
        // 決定 (e)：submit_report より後ろで判定しなかった呼び出しの数（記録だけ）
        ignoredToolCalls,
      },
    },
    now,
  );
}

/** 終了状態になったタスクの状態を読み直してから onTaskTerminal を呼ぶ */
async function notifyTerminalOf(rt: EdgeRuntime, ctx: WsCtx, taskId: Uuid): Promise<void> {
  const t = await getTask(rt.db, ctx, taskId);
  if (t !== null && isTerminalStatus(t.status)) await notifyTerminal(rt, ctx, taskId, t.status);
}
