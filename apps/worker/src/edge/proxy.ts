// LLM Proxy（packages/edge/src/proxy.ts の llmMessages の WorkspaceDO 版。FR-009、formation-runtime.md §3.10、M-14・M-15・M-19）
// Node 版は1つの関数で「1 トークンでタスクを引き直す → 2 入力の検証（Zod）→ 3 1分あたり60回 → 4 Router でモデル → 5 見積もり →
// 6 callGemini の中の1トランザクション：checkSpend（全体）・decide(llm_call) → 7 Gemini（やり直し）→
// 8 1トランザクション：usage_records・tasks.cost／steps_used・task_events・監査ログ llm.called → 9 応答のツール呼び出しを順に decide」をしていた。
// WorkspaceDO 版は LLM の呼び出し（5・7）を Workflow の側（workflows/task-run.ts・llm-call.ts）に出し、DO の側を同期の4つに分ける：
//   edgeLlmPrepare（1〜4）→ edgeLlmBegin（6）→ [Workflow が呼ぶ] → edgeLlmSettle（8・9）／edgeLlmFail（呼べなかった・失敗した）。
// 判定（エージェントの MCP の書き込みも kind: 'tool_call' で1回だけ：M-14）と、書き込みの Intent（recordMcpIntent）は Node 版と同じ。
// 1つの応答で submit_report より後ろの呼び出しは判定せず Intent にもしない（決定 (e)。記録だけ：runner が捨てるのと合わせる）。
// 失敗は runner の EdgeError を投げる（DO の側が captureEdge で値にする）。記録を残してから投げるもの（halt など）は、
// トランザクションをコミットしてから投げる（db.transaction の中で投げると記録まで戻るため）

import {
  KERNEL_VERSION,
  decide,
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
import { EdgeError, type AssistantPart, type GovernanceEntry, type LlmMessagesResponse, type LlmPhase, type ToolCallPart } from "@open-team/runner";
import { modelForPhase, type LlmRequest, type LlmResponse } from "@open-team/llm";
import { appendAuditLog } from "../db/audit.ts";
import { microToUsd } from "../db/repo/costs.ts";
import { addTaskUsage, getTask, insertPolicyDecision, insertTaskEvent, insertUsageRecord, listToolCallIds, updateTaskCounters } from "../db/repo/edge.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { LlmProvider, TaskRow, Uuid } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";
import { loadTaskSetup, type TaskSetup } from "./context.ts";
import { failTask, haltCauseOf, haltCauseOfSpend, haltTask, type HaltCause } from "./halt.ts";
import { loadDecideBase, loadTaskPolicy, parseMcpCallArgs, resolveMcpSubject, type DecideBase, type McpTarget } from "./inputs.ts";
import { recordMcpIntent, type RecordedMcpIntent } from "./intents.ts";
import { promptHashOf, type LlmCallErrorKind, type LlmCallUsage } from "./llm-call.ts";
import { forgetTask, type TaskEdgeRuntime } from "./runtime.ts";
import { commandDeniedNote, commandTaintOf, judgeCommand, type CommandJudgement } from "./sandbox-command.ts";
import { checkToolArguments } from "./schema-check.ts";
import { checkSpend } from "./spend.ts";
import { haltedDetails, isTerminalStatus, resolveTask } from "./tokens.ts";
import { charCount, toJsonObject } from "./util.ts";
import { parseLlmMessagesRequest } from "./validate.ts";

/** 判定の結果（kernel の DecideResult） */
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

/** 判定の記録（policy_decisions）と、allow 以外・Intent への判定の監査ログ decision.made（API-037 の副作用・platform.md:128） */
function recordDecision(
  db: WsDb,
  task: Pick<TaskRow, "id" | "agent_id">,
  d: {
    subjectKind: "tool_call" | "llm_call";
    subject: JsonObject;
    action: string | null;
    counters: Counters;
    flags: Flags;
    taint: TaintState;
    result: Judged;
    intentId: Uuid | null;
  },
  now: Date,
): void {
  insertPolicyDecision(
    db,
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
      enforced: true,
      inputsHash: d.result.inputsHash,
      kernelVersion: KERNEL_VERSION,
    },
    now,
  );
  if (d.result.decision !== "allow" || d.intentId !== null) {
    appendAuditLog(
      db,
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
          enforced: true,
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
  /** run_command の写し先（SG-07）。ほかのツールは null */
  command: CommandJudgement | null;
}

function buildCallSubject(db: WsDb, call: ToolCallPart, taint: TaintState): BuiltCall {
  if (call.name === "mcp_call") {
    const parsed = parseMcpCallArgs(call.arguments);
    if (parsed === null) {
      return { subject: { kind: "tool_call", actionType: "mcp_call", args: {}, paths: [], origin: "agent" }, mcp: null, command: null };
    }
    const r = resolveMcpSubject(db, parsed);
    return { subject: r.subject, mcp: r.mcp, command: null };
  }
  const subject: Subject = {
    kind: "tool_call",
    // 知らない名前もそのまま（decide がカタログにないものを unknown_action にする：BR-09）
    actionType: call.name as CatalogToolName,
    args: toJsonObject(call.arguments) ?? {},
    paths: [],
    origin: "agent",
  };
  if (call.name === "run_command") {
    // SG-07：汚染（外の内容を読んだか）と形から、run_tests と run_shell のどちらとして判定するかをここで決める。
    // 汚染は decide の手順の条件には入れない（BR-39）。decide は subject.commandOperation と形だけを見る
    const command = judgeCommand(subject.args, taint);
    return { subject: { ...subject, commandOperation: command.operation }, mcp: null, command };
  }
  return { subject, mcp: null, command: null };
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
function freshId(rt: TaskEdgeRuntime, used: ReadonlySet<string>): string {
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
export function judgeToolCalls(rt: TaskEdgeRuntime, db: WsDb, task: TaskRow, setup: TaskSetup, parts: readonly AssistantPart[], now: Date): JudgedCalls {
  const used = new Set(listToolCallIds(db, task.id));
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

  const base: DecideBase = loadDecideBase(db, task, now, { taskPolicy: setup.taskPolicy });
  const policy: EffectivePolicy = base.taskPolicy.policy;
  let counters = base.counters;
  const governance: GovernanceEntry[] = [];
  const intents: RecordedMcpIntent[] = [];
  let halted = false;

  // SG-07：run_command の写し先に使う汚染（作業場が受け取る控えの汚染を先に足したもの）。run_command があるときだけ読む
  const commandTaint = judgedCalls.some((c) => c.name === "run_command") ? commandTaintOf(db, task, base.taint, now) : base.taint;
  for (const call of judgedCalls) {
    const built = buildCallSubject(db, call, commandTaint);
    const kernelResult: DecideResult = decide(policy, built.subject, counters, base.flags, base.taint);
    const result: Judged = kernelResult;

    // MCP の書き込み（未分類も書き込み：ADR-022）は判定の結果で Intent にする（M-14）
    let intent: RecordedMcpIntent | null = null;
    let invalidArgs: string[] | null = null;
    const mcp = built.mcp;
    if (mcp !== null && mcp.info.classification !== "read") {
      // 実行されうる（allow）か承認に回る（approve）Intent は、入力スキーマに合わなければ作らない（M-12。ツールのエラーで返す）
      if (result.decision === "allow" || result.decision === "approve") {
        const check = checkToolArguments(mcp.tool.input_schema, built.subject.args, rt.limits.mcpArgsMaxBytes);
        if (!check.ok) invalidArgs = check.issues;
      }
      if (invalidArgs === null) {
        intent = recordMcpIntent(db, {
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

    const effective: Decision = invalidArgs !== null ? "allow" : result.decision;
    const callRecord: JsonObject = {
      toolCallId: call.id,
      name: call.name,
      effective,
      ...(intent !== null ? { intentId: intent.intentId } : {}),
      ...(invalidArgs !== null ? { invalidArgs } : {}),
    };
    recordDecision(
      db,
      task,
      {
        subjectKind: "tool_call",
        subject: { ...(built.subject as unknown as JsonObject), call: callRecord },
        action: built.subject.action ?? built.subject.actionType ?? null,
        counters,
        flags: base.flags,
        taint: base.taint,
        result,
        intentId: intent?.intentId ?? null,
      },
      now,
    );
    // 進捗（TBL-007 の tool_called：ツール名・判定。API-037 の副作用）。runner の進捗とは by で見分ける
    insertTaskEvent(
      db,
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

    if (result.decision === "halt") {
      const cause = haltCauseOf(kernelResult);
      if (cause !== null) haltTask(db, task, cause, now);
      halted = true;
      break;
    }
  }
  updateTaskCounters(db, task.id, { deniedCount: counters.deniedCount, repeatKey: counters.repeatKey, repeatCount: counters.repeatCount }, now);
  return { content, governance, intents, halted, ignored };
}

// =====================================================================
// llmMessages の4つ（API-037 相当。エラーは runner の EdgeError：401 UNAUTHORIZED・409 TASK_HALTED（details.haltReason）・
// 400 VALIDATION_ERROR・429 RATE_LIMITED（retryAfterSec）・502 LLM_UPSTREAM_ERROR（タスクは failed(llm_unavailable)））
// =====================================================================

/**
 * 1〜4：タスクを引き直す → 入力の検証 → tools ⊆ TaskContext.tools → 1分あたりの回数 → Router でモデル → LlmRequest。
 * 宣言の中身は runner の値ではなく edge が作ったものを使う。見積もり（5）は Workflow の側（llm-call.ts の prepareLlmCall）
 */
export function edgeLlmPrepare(db: WsDb, rt: TaskEdgeRuntime, taskId: string, rawReq: unknown, now: Date): { llmReq: LlmRequest; phase: LlmPhase } {
  const { task, workspace } = resolveTask(db, taskId, now);
  const req = parseLlmMessagesRequest(rawReq, rt.limits);
  const setup = loadTaskSetup(db, task, workspace, undefined, { sandboxProvider: false, trustedSkills: rt.trustedSkills });
  // tools ⊆ TaskContext.tools（§3.10-2）
  const outside = req.tools.map((t) => t.name).filter((n) => !setup.toolNames.has(n));
  if (outside.length > 0) throw new EdgeError("VALIDATION_ERROR", { reason: "tool_not_in_context", tools: outside });
  const requested = new Set(req.tools.map((t) => t.name));
  const tools = setup.tools.filter((t) => requested.has(t.name)).map((t) => structuredClone(t));

  // 3. 1分あたりの回数（si:106）
  const acquired = rt.llmLimiter.tryAcquire(task.id, now.getTime());
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
  return { llmReq, phase: req.phase };
}

/**
 * 6：呼ぶ前の1トランザクション（Node 版の callGemini の「呼ぶ前」＋ onStopped・beforeCall）。
 * checkSpend（全体。M-19）で止めたら halted（budget_exceeded＋監査ログ budget.exceeded）→ TASK_HALTED。
 * そのあと decide(llm_call)：予算（per_task_usd・per_day_usd・agent_day_usd・max_steps・max_minutes）と Breaker。判定は記録し、halt なら止める。
 * 止めた記録はコミットしてから投げる
 */
export function edgeLlmBegin(
  db: WsDb,
  rt: TaskEdgeRuntime,
  taskId: string,
  a: { budgetEstimateMicroUsd: number; model: string; phase: LlmPhase },
  now: Date,
): void {
  const outcome = db.transaction((): { ok: true } | { ok: false; error: EdgeError; terminal: boolean } => {
    if (getWorkspace(db) === null) throw new Error("ワークスペースの行がない");
    const t = getTask(db, taskId);
    if (t === null) return { ok: false, error: new EdgeError("UNAUTHORIZED"), terminal: false };
    // 全体 $15（M-19）。タスクの中で止めたら halted。止めた理由は Node 版の GeminiCallError の写しと同じ形
    const stop = (cause: HaltCause, error: EdgeError) => {
      const ended = isTerminalStatus(t.status) ? null : haltTask(db, t, cause, now);
      return { ok: false as const, error, terminal: ended !== null };
    };
    const spend = checkSpend(db, a.budgetEstimateMicroUsd, now);
    if (!spend.ok) return stop(haltCauseOfSpend(spend), new EdgeError("TASK_HALTED", { haltReason: "budget_exceeded", scope: spend.scope }));
    // decide(llm_call)
    if (t.status !== "running") return { ok: false, error: new EdgeError("TASK_HALTED", haltedDetails(t)), terminal: false };
    const subject: Subject = { kind: "llm_call", actionType: null, args: {}, paths: [], estimatedCostUsd: fromMicroUsd(a.budgetEstimateMicroUsd) };
    const base = loadDecideBase(db, t, now, { taskPolicy: loadTaskPolicy(db, t) });
    const r = decide(base.taskPolicy.policy, subject, base.counters, base.flags, base.taint);
    recordDecision(
      db,
      t,
      {
        subjectKind: "llm_call",
        subject: { ...(subject as unknown as JsonObject), phase: a.phase, model: a.model },
        action: null,
        counters: base.counters,
        flags: base.flags,
        taint: base.taint,
        result: r,
        intentId: null,
      },
      now,
    );
    if (r.decision !== "halt") return { ok: true };
    const cause = haltCauseOf(r);
    const ended = cause === null ? null : haltTask(db, t, cause, now);
    return {
      ok: false,
      error: new EdgeError("TASK_HALTED", { haltReason: cause?.reason ?? r.reasonCode, reasonCode: r.reasonCode, matchedRule: r.matchedRule }),
      terminal: ended !== null,
    };
  });
  if (!outcome.ok) {
    if (outcome.terminal) forgetTask(rt, taskId);
    throw outcome.error;
  }
}

/** usage_records の1行（llm-call.ts の usageRow と同じ形。持ち主はタスクとそのエージェント） */
function usageRow(task: Pick<TaskRow, "id" | "agent_id">, llmReq: LlmRequest, phase: LlmPhase, usage: LlmCallUsage, provider: LlmProvider) {
  return {
    taskId: task.id,
    agentId: task.agent_id,
    askId: null,
    provider,
    model: usage.model,
    phase,
    inputTokens: usage.inputTokens,
    // 思考のトークンは出力の単価で数える（usage_records に思考の列がないので出力に入れる：SO §3.12-6）
    outputTokens: usage.outputTokens + usage.thinkingTokens,
    estimatedCostMicroUsd: usage.estimatedMicroUsd,
    costMicroUsd: usage.costMicroUsd,
    latencyMs: usage.latencyMs,
    promptHash: promptHashOf(llmReq),
  };
}

/**
 * 8・9：呼んだあとの1トランザクション（Node 版の callGemini の「呼んだあと」＋ afterCall）。
 * usage_records → tasks の費用とステップ（addTaskUsage）→ task_events の llm_called →（まだ running なら）応答のツール呼び出しの判定 → 監査ログ llm.called。
 * 呼んでいる間に停止でタスクが止まっていたら、費用だけ数え、ツール呼び出しは判定せず TASK_HALTED（記録はコミットしてから投げる）。
 * 記録した Intent の通知（Node 版の onIntentRecorded）は 4d で DO の側がつなぐ（Intent は action_intents に残っている）
 */
export function edgeLlmSettle(
  db: WsDb,
  rt: TaskEdgeRuntime,
  taskId: string,
  a: { llmReq: LlmRequest; phase: LlmPhase; usage: LlmCallUsage; response: LlmResponse; provider: LlmProvider },
  now: Date,
): LlmMessagesResponse {
  const { llmReq, phase, usage, response } = a;
  const state = db.transaction(
    (): { kind: "gone" } | { kind: "halted"; error: EdgeError } | { kind: "judged"; judged: JudgedCalls; budget: { cost_micro_usd: number; steps_used: number } } => {
      const t = getTask(db, taskId);
      if (t === null) return { kind: "gone" };
      insertUsageRecord(db, usageRow(t, llmReq, phase, usage, a.provider), now);
      const added = addTaskUsage(db, t.id, usage.costMicroUsd, 1, now);
      if (added === null) return { kind: "gone" };
      const calls = response.parts.filter((p) => p.type === "tool_call").length;
      insertTaskEvent(
        db,
        t.id,
        "llm_called",
        {
          model: usage.model,
          phase,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens + usage.thinkingTokens,
          costUsd: microToUsd(usage.costMicroUsd),
          toolCalls: calls,
        },
        now,
      );
      // 停止が呼んでいる間に来た：費用だけ数え、ツール呼び出しは判定しない
      const ws = getWorkspace(db);
      if (ws === null) throw new Error("ワークスペースの行がない");
      if (t.status !== "running") {
        auditLlmCalled(db, t, usage, llmReq, 0, now);
        return { kind: "halted", error: new EdgeError("TASK_HALTED", haltedDetails(t)) };
      }
      const refreshed: TaskRow = { ...t, cost_micro_usd: added.cost_micro_usd, steps_used: added.steps_used };
      const setup = loadTaskSetup(db, refreshed, ws, undefined, { sandboxProvider: false, trustedSkills: rt.trustedSkills });
      const judged = judgeToolCalls(rt, db, refreshed, setup, response.parts, now);
      auditLlmCalled(db, t, usage, llmReq, judged.ignored, now);
      return { kind: "judged", judged, budget: added };
    },
  );
  // タスクの行がない（消えた）：費用は記録できない。Node 版はツール呼び出しを判定せずに応答を返していたが、判定のない呼び出しを runner に渡さない
  if (state.kind === "gone") throw new EdgeError("UNAUTHORIZED");
  if (state.kind === "halted") {
    forgetTask(rt, taskId);
    throw state.error;
  }
  if (state.judged.halted) forgetTask(rt, taskId);
  return {
    model: response.model,
    content: state.judged.content,
    stopReason: response.stopReason,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens + usage.thinkingTokens,
      costUsd: microToUsd(usage.costMicroUsd),
    },
    governance: state.judged.governance,
    budget: { costUsd: microToUsd(state.budget.cost_micro_usd), stepsUsed: state.budget.steps_used },
  };
}

/**
 * 呼べなかった・失敗した（Node 版の afterFailure と、llmMessages の catch の switch）。必ず EdgeError を投げる。
 * - 数えた費用（送れたか分からない回の見積もり）があれば usage_records とタスクの費用に足す（ステップは数えない）
 * - llm（やり直しのあとも失敗）→ failed(llm_unavailable)。unpriced_model・incompatible_model（費用を数えられない・呼べない）→ failed(llm_unavailable)
 * - budget：Node 版では呼ぶ前の確かめ（onStopped）でタスクを止めていた。ここに来たら（Workflow の側の確かめで止めた）同じく halted にする
 * - aborted：タスクは変えない（止めた側がすでに状態を決めている）
 */
export function edgeLlmFail(
  db: WsDb,
  rt: TaskEdgeRuntime,
  taskId: string,
  a: { llmReq: LlmRequest; phase: LlmPhase; kind: LlmCallErrorKind; llmStatus: number | null; message: string; usage: LlmCallUsage | null; provider: LlmProvider },
  now: Date,
): never {
  const terminal = db.transaction((): boolean => {
    const t = getTask(db, taskId);
    if (t === null) return false;
    if (a.usage !== null && a.usage.costMicroUsd > 0) {
      insertUsageRecord(db, usageRow(t, a.llmReq, a.phase, a.usage, a.provider), now);
      addTaskUsage(db, t.id, a.usage.costMicroUsd, 0, now);
    }
    if (t.status !== "running") return false;
    switch (a.kind) {
      case "llm":
        return failTask(db, t, "llm_unavailable", now, { llmStatus: a.llmStatus }) !== null;
      case "unpriced_model":
      case "incompatible_model":
        // 価格表にないモデルは呼ばない（決定 (d)）。費用を数えられないので、このタスクは続けられない
        return failTask(db, t, "llm_unavailable", now, { reason: a.kind, model: a.llmReq.model, message: a.message }) !== null;
      case "budget":
        return haltTask(db, t, { reason: "budget_exceeded", audit: { scope: "global" } }, now) !== null;
      case "aborted":
        return false;
    }
  });
  if (terminal) forgetTask(rt, taskId);
  switch (a.kind) {
    case "budget":
      throw new EdgeError("TASK_HALTED", { haltReason: "budget_exceeded", scope: "global" });
    case "incompatible_model":
    case "unpriced_model":
      throw new EdgeError("LLM_UPSTREAM_ERROR", { reason: a.kind, message: a.message });
    case "aborted":
      throw new EdgeError("TASK_HALTED", { haltReason: "aborted" });
    case "llm":
      throw new EdgeError("LLM_UPSTREAM_ERROR", { status: a.llmStatus });
  }
}

/** 監査ログ llm.called（モデル・トークン数・費用・プロンプトのハッシュ。本文は入れない：§3.10-8） */
function auditLlmCalled(db: WsDb, task: Pick<TaskRow, "id" | "agent_id">, usage: LlmCallUsage, req: LlmRequest, ignoredToolCalls: number, now: Date): void {
  appendAuditLog(
    db,
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
        costUsd: microToUsd(usage.costMicroUsd),
        attempts: usage.attempts,
        promptHash: promptHashOf(req),
        // 決定 (e)：submit_report より後ろで判定しなかった呼び出しの数（記録だけ）
        ignoredToolCalls,
      },
    },
    now,
  );
}
