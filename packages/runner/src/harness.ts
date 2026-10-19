// Harness のループ（FR-008。formation-runtime.md §3.8・§8-7・§8-36）
// runner の出口は EdgePort だけ。DB・Gemini・gateway のクライアントを import しない（D-52）
// 状態は runTask の呼び出しの中（タスクごと）にだけ持ち、モジュールの変数・/tmp に置かない（15:487、BD-05）
// 終わり方（completed など）は runner が決めない。edge が報告・finished・Intent から決める（§3.12）

import { EdgeError } from "./types.ts";
import type {
  ChatMessage,
  EdgeErrorCode,
  EdgePort,
  LlmMessagesResponse,
  LlmPhase,
  ProgressEvent,
  TaskContext,
  ToolCallPart,
  ToolCallResult,
} from "./types.ts";
import {
  NO_DECISION_TEXT,
  actNudgeText,
  buildSystemPrompt,
  hasActionTools,
  buildTaskInput,
  intentResultText,
  noReportReason,
  phaseAdvanceText,
  policyDeniedText,
  reportNudgeText,
  summarizeResult,
  toolErrorText,
  toolResultText,
} from "./prompts.ts";

/** 繰り返し（LLM の応答の数）の既定の上限。Hard Ceiling の max_steps ≤ 200（BR-06）と同じにし、ポリシーの上限より先に切らない */
export const DEFAULT_MAX_TURNS = 200;
/** postEvents の1回の上限（si:133） */
export const EVENTS_PER_REQUEST = 20;
/** RATE_LIMITED の待ちの上限（秒）。LLM Proxy の制限は1分あたり（si:106） */
export const RATE_LIMIT_WAIT_MAX_SEC = 60;
/**
 * finished を送る回数の上限（送り直しを含む）。edge は進捗を毎秒10件までしか受けず、超えた分は捨てる（rt:152）ので、
 * 捨てられたら1秒待って送り直す。届かないとタスクは running のまま残り、ハートビートの切れで failed(sandbox_lost) になる
 */
export const FINISHED_SEND_ATTEMPTS = 3;
/** finished が捨てられたときに待つ時間（rt:152 の上限は1秒あたり） */
const FINISHED_RETRY_WAIT_MS = 1000;

export interface RunTaskOptions {
  /** 止める（Kill Switch など）。止まったら次の edge の呼び出しの前に戻る */
  signal: AbortSignal;
  /** LLM の応答を受け取る回数の上限。超えたら finished(unable) を送って終える。既定 DEFAULT_MAX_TURNS */
  maxTurns?: number;
  /** 待ち（RATE_LIMITED の retryAfterSec）。試験・計測で差し替える。既定は setTimeout で、signal で切れる */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** ループの終わり方（タスクの状態ではない。呼び出し側のログ・計測のため） */
export type RunTaskEnd =
  /** submit_report が受け付けられた（API-056）、またはすでに報告済み */
  | "report_submitted"
  /** finished を送った（エージェントの finish か、runner が代わりに送ったもの） */
  | "finished"
  /** 判定の halt・TASK_HALTED・callTool の halted */
  | "halted"
  /** トークンが無効（終わったタスク） */
  | "unauthorized"
  /** LLM_UPSTREAM_ERROR（edge がタスクを failed(llm_unavailable) にする） */
  | "llm_unavailable"
  /** signal で止めた */
  | "aborted";

export interface RunTaskResult {
  end: RunTaskEnd;
  /** LLM の応答を受け取った回数 */
  turns: number;
  /** finished を送ったとき */
  finished?: { outcome: "no_change" | "unable"; reason: string; by: "agent" | "runner" };
  /** halted のとき：判定の reasonCode か、TASK_HALTED の details.haltReason */
  haltReason?: string;
}

type Stop = { end: RunTaskEnd; haltReason?: string };
type FinishedPayload = { outcome: "no_change" | "unable"; reason: string };

/** edge のエラーか（別のモジュールの複製でも名前とコードで見分ける） */
function asEdgeError(e: unknown): EdgeError | null {
  if (e instanceof EdgeError) return e;
  if (e instanceof Error && e.name === "EdgeError" && typeof (e as { code?: unknown }).code === "string") {
    return e as EdgeError;
  }
  return null;
}

function haltReasonOf(e: EdgeError): string {
  const d = e.details;
  if (typeof d === "object" && d !== null && typeof (d as { haltReason?: unknown }).haltReason === "string") {
    return (d as { haltReason: string }).haltReason;
  }
  return e.code;
}

/** どの edge の呼び出しでも、続けられないエラー */
function stopOf(e: EdgeError): Stop | null {
  switch (e.code) {
    case "TASK_HALTED":
      return { end: "halted", haltReason: haltReasonOf(e) };
    case "UNAUTHORIZED":
      return { end: "unauthorized" };
    case "REPORT_ALREADY_SUBMITTED":
      return { end: "report_submitted" };
    default:
      return null;
  }
}

function rateLimitWaitMs(retryAfterSec: number | null): number {
  const sec = retryAfterSec !== null && Number.isFinite(retryAfterSec) ? retryAfterSec : 1;
  return Math.min(Math.max(sec, 1), RATE_LIMIT_WAIT_MAX_SEC) * 1000;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** finish の引数（catalogs.md:79）。edge の検証で落ちないよう、知らない outcome は unable にする */
function finishArgs(args: unknown): FinishedPayload {
  const a = typeof args === "object" && args !== null ? (args as { outcome?: unknown; reason?: unknown }) : {};
  const outcome = a.outcome === "no_change" ? "no_change" : "unable";
  const reason = typeof a.reason === "string" && a.reason.trim() !== "" ? a.reason : "理由が書かれていません";
  return { outcome, reason };
}

/**
 * タスクを1件動かす（§3.8）。
 * 応答のツール呼び出しは応答の順に1つずつ処理する。halt で即終了、submit_report が受け付けられたら終える（後ろの呼び出しは捨てる：§8-36）。
 * isDryRun・runKind では分岐しない（経路を変えない：ADR-015）
 */
export async function runTask(edge: EdgePort, token: string, opts: RunTaskOptions): Promise<RunTaskResult> {
  const { signal } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const sleep = opts.sleep ?? abortableSleep;
  let turns = 0;
  const done = (stop: Stop, finished?: RunTaskResult["finished"]): RunTaskResult => ({
    end: stop.end,
    turns,
    ...(finished ? { finished } : {}),
    ...(stop.haltReason !== undefined ? { haltReason: stop.haltReason } : {}),
  });

  if (signal.aborted) return done({ end: "aborted" });

  // 1. 文脈（最初の呼び出しでタスクは running になる：si:43）
  let ctx: TaskContext;
  try {
    ctx = await edge.getTaskContext(token);
  } catch (e) {
    const ee = asEdgeError(e);
    const stop = ee ? stopOf(ee) : null;
    if (stop) return done(stop);
    throw e;
  }

  // 進捗（API-038）。edge の呼び出しの前にまとめて送る。ハートビートを兼ねる
  const pending: ProgressEvent[] = [];
  const flush = async (): Promise<Stop | null> => {
    while (pending.length > 0) {
      if (signal.aborted) return { end: "aborted" };
      const batch = pending.splice(0, EVENTS_PER_REQUEST);
      try {
        await edge.postEvents(token, batch);
      } catch (e) {
        const ee = asEdgeError(e);
        if (!ee) throw e;
        const stop = stopOf(ee);
        if (stop) return stop;
        // ほかは進捗の取りこぼし（FR-018 の dropped と同じ扱い）として続ける
      }
    }
    return null;
  };

  /**
   * finished を届ける（§3.8 の postEvents([finished])：ほかの進捗を先に送ってから、単独で送る）。
   * 毎秒の上限で捨てられた（accepted が 0）・RATE_LIMITED なら待って送り直す（rt:152。FINISHED_SEND_ATTEMPTS 回まで）。
   * VALIDATION_ERROR などは同じものを送り直しても通らないので、そこでやめる
   */
  const sendFinished = async (payload: FinishedPayload): Promise<Stop | null> => {
    const before = await flush();
    if (before) return before;
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) return { end: "aborted" };
      let waitMs = FINISHED_RETRY_WAIT_MS;
      try {
        const r = await edge.postEvents(token, [{ type: "finished", payload }]);
        if (r.accepted >= 1) return null;
      } catch (e) {
        const ee = asEdgeError(e);
        if (!ee) throw e;
        const stop = stopOf(ee);
        if (stop) return stop;
        if (ee.code !== "RATE_LIMITED") return null;
        waitMs = rateLimitWaitMs(ee.retryAfterSec);
      }
      if (attempt >= FINISHED_SEND_ATTEMPTS) return null;
      await sleep(waitMs, signal);
    }
  };

  /** runner が代わりに finished を送って終える（報告なし・上限など。タスクは edge が failed(agent_unable) にする） */
  const finishByRunner = async (reason: string): Promise<RunTaskResult> => {
    const fin: FinishedPayload = { outcome: "unable", reason };
    const stop = await sendFinished(fin);
    if (stop) return done(stop);
    return done({ end: "finished" }, { ...fin, by: "runner" });
  };

  const phases = ctx.phases;
  const first = phases[0];
  if (first === undefined) return finishByRunner("タスクにフェーズがありません");

  // 2. システムプロンプトと最初の入力（§3.9）
  let phaseIndex = 0;
  let phase = first;
  let system = buildSystemPrompt(ctx, phaseIndex);
  const messages: ChatMessage[] = [{ role: "user", content: buildTaskInput(ctx) }];
  let nudged = false;
  // 最初のフェーズを、手を動かすツールがあるのに1度も呼ばずに終えようとしたら1回だけ促す（答えを返すだけで終えない）
  let actNudged = !(phases.length > 1 && hasActionTools(ctx));
  let toolCalled = false;
  pending.push({ type: "phase_started", payload: { phase: first.name } });

  const callLlm = async (llmPhase: LlmPhase): Promise<{ res: LlmMessagesResponse } | { stop: Stop } | { rejected: EdgeErrorCode }> => {
    for (;;) {
      if (signal.aborted) return { stop: { end: "aborted" } };
      try {
        const res = await edge.llmMessages(token, {
          phase: llmPhase,
          system,
          messages: [...messages],
          tools: ctx.tools,
          maxTokens: ctx.limits.maxTokens,
        });
        return { res };
      } catch (e) {
        const ee = asEdgeError(e);
        if (!ee) throw e;
        if (ee.code === "RATE_LIMITED") {
          await sleep(rateLimitWaitMs(ee.retryAfterSec), signal);
          continue;
        }
        // LLM_UPSTREAM_ERROR：edge がタスクを failed(llm_unavailable) にする（03_use_cases/tasks.md:139）
        if (ee.code === "LLM_UPSTREAM_ERROR") return { stop: { end: "llm_unavailable" } };
        const stop = stopOf(ee);
        if (stop) return { stop };
        // VALIDATION_ERROR など：同じ要求は通らないので、続けられないとして終える
        return { rejected: ee.code };
      }
    }
  };

  const callTool = async (toolCallId: string): Promise<{ result: ToolCallResult } | { stop: Stop } | { error: EdgeErrorCode }> => {
    for (;;) {
      if (signal.aborted) return { stop: { end: "aborted" } };
      try {
        return { result: await edge.callTool(token, toolCallId) };
      } catch (e) {
        const ee = asEdgeError(e);
        if (!ee) throw e;
        if (ee.code === "RATE_LIMITED") {
          await sleep(rateLimitWaitMs(ee.retryAfterSec), signal);
          continue;
        }
        const stop = stopOf(ee);
        if (stop) return { stop };
        // VALIDATION_ERROR・TOOL_CALL_NOT_ALLOWED など：ツールのエラーとして LLM に返して続ける
        return { error: ee.code };
      }
    }
  };

  // 3. 繰り返す
  for (;;) {
    if (signal.aborted) return done({ end: "aborted" });
    if (turns >= maxTurns) return finishByRunner(`繰り返しの上限（${maxTurns}回）に達しました`);
    const flushed = await flush();
    if (flushed) return done(flushed);

    // 3-1. LLM を呼ぶ（TASK_HALTED はすぐ戻る：rt:113、RATE_LIMITED は待ってやり直す）
    const r = await callLlm(phase.llmPhase);
    if ("stop" in r) return done(r.stop);
    if ("rejected" in r) return finishByRunner(`LLM の呼び出しが受け付けられませんでした（${r.rejected}）`);
    turns += 1;
    const res = r.res;

    // 3-2. 応答を assistant の発言として足す（署名はそのまま返す）。テキストは message の進捗
    if (res.content.length > 0) messages.push({ role: "assistant", content: res.content });
    for (const part of res.content) {
      if (part.type === "text" && part.text.trim() !== "") pending.push({ type: "message", payload: { text: part.text } });
    }
    const calls = res.content.filter((p): p is ToolCallPart => p.type === "tool_call");

    // 3-3. ツール呼び出しがない：次のフェーズへ。最後のフェーズなら1回だけ促し、2回目は finish(unable) と同じ扱い（§8-7）
    if (calls.length === 0) {
      if (phaseIndex === 0 && !toolCalled && !actNudged) {
        actNudged = true;
        messages.push({ role: "user", content: actNudgeText() });
        continue;
      }
      const next = phases[phaseIndex + 1];
      if (next !== undefined) {
        phaseIndex += 1;
        phase = next;
        system = buildSystemPrompt(ctx, phaseIndex);
        messages.push({ role: "user", content: phaseAdvanceText(next.name) });
        pending.push({ type: "phase_started", payload: { phase: next.name } });
        continue;
      }
      if (!nudged) {
        nudged = true;
        messages.push({ role: "user", content: reportNudgeText(ctx) });
        continue;
      }
      return finishByRunner(noReportReason(ctx));
    }

    // 3-4. 応答の順に1つずつ（§8-36）
    toolCalled = true;
    for (const call of calls) {
      const g = res.governance.find((x) => x.toolCallId === call.id);
      if (g?.decision === "halt") return done({ end: "halted", haltReason: g.reasonCode });

      if (call.name === "finish") {
        // タスクは edge が failed(agent_no_change / agent_unable) にする（rt:117、si:135）
        const fin = finishArgs(call.arguments);
        const stop = await sendFinished(fin);
        if (stop) return done(stop);
        return done({ end: "finished" }, { ...fin, by: "agent" });
      }

      let resultText: string;
      if (g === undefined) {
        resultText = NO_DECISION_TEXT;
      } else if (g.intent !== undefined) {
        // MCP の書き込みは Proxy で Intent になっている。結果は待たず、何も実行しない（A-87）
        resultText = intentResultText(g.intent);
      } else if (g.decision === "allow") {
        // 先に進捗を送る（submit_report が通るとトークンが失効する：si:171）
        const before = await flush();
        if (before) return done(before);
        const t = await callTool(call.id);
        if ("stop" in t) return done(t.stop);
        if ("error" in t) {
          resultText = toolErrorText(t.error);
        } else {
          if (t.result.kind === "halted") return done({ end: "halted", haltReason: t.result.reasonCode });
          // submit_report が通った：残りの呼び出しは処理せず、ループを終える
          if (t.result.kind === "report_accepted") return done({ end: "report_submitted" });
          resultText = toolResultText(t.result);
        }
      } else {
        // deny・handoff・書き込みでない approve：実行しない（rt:113、BR-09）。edge の説明があれば添える（SG-07）
        resultText = g.note === undefined ? policyDeniedText(g.reasonCode) : `${policyDeniedText(g.reasonCode)} ${g.note}`;
      }

      messages.push({ role: "tool", content: { toolCallId: call.id, name: call.name, result: resultText } });
      pending.push({
        type: "tool_called",
        payload: { toolCallId: call.id, name: call.name, resultSummary: summarizeResult(resultText) },
      });
    }
  }
}
