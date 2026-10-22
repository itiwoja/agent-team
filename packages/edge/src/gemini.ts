// Gemini の呼び出し（SO §3.12 callGemini。Gemini を呼ぶのは edge のパッケージだけ：D-52、ADR-032:35、15:597）。
// タスクの LLM Proxy も、設定プランナー・状況の生成（タスクの外）もここを通す。手順：
// 1 中断・価格表にないモデル（呼ばない：決定 (d)）→ 2 見積もり（入力の上限＋maxTokens＋思考の上限）→
// 3 1トランザクション：ワークスペースの行のロック → Kill Switch → checkSpend（全体・ゲスト・リハーサル。M-19）→ beforeCall（タスクの decide）→
// 4 呼ぶ（やり直しはここの1か所：429・5xx・ネットワークを 1・4・16秒で3回。送れたか・使った量が分からない失敗は見積もりを費用に数える：SO §3.12-6）→
// 5 1トランザクション：usage_records（＋ afterCall でタスクの費用・ステップ）→ 6 構造化ログ llm.called（本文は出さない）。
// トランザクションの中で Gemini を呼ばない（G-14）

import { performance } from "node:perf_hooks";
import { canonicalJson, sha256Hex } from "@open-team/kernel";
import {
  GeminiClient,
  GROUNDING_QUERIES_ESTIMATE,
  GROUNDING_QUERY_MICRO_USD,
  LLM_RETRY_DELAYS_MS,
  LlmError,
  estimateMicroUsd,
  findPrice,
  inputTokensUpperBound,
  withRetry,
  type GeminiClientOptions,
  type GeminiPurpose,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type SleepFn,
} from "@open-team/llm";
import { AppError, type Clock, type Logger } from "@open-team/platform";
import { lockWorkspace, system, type Db, type Tx, type UsagePhase, type Uuid, type WorkspaceKind } from "@open-team/db";
import { insertUsageRecord, type UsageRecordInput } from "@open-team/db/edge";
import { SPEND_LIMITS, type SpendLimits } from "./limits.ts";
import { checkSpend, spendDeniedAppError, type SpendDenied } from "./spend.ts";
import { errorMessage } from "./util.ts";

/** 誰の費用として、何のために呼ぶか（SO §2.6 の GeminiCallContext） */
export interface GeminiCallContext {
  workspaceId: Uuid;
  workspaceKind: WorkspaceKind;
  /** タスクの外の呼び出し（設定プランナー・状況の生成）は null */
  taskId: Uuid | null;
  agentId: Uuid | null;
  askId: Uuid | null;
  rehearsalRunId: Uuid | null;
  purpose: GeminiPurpose;
  /** usage_records.phase */
  phase: UsagePhase;
  /** Kill Switch で中断する */
  signal?: AbortSignal;
}

export interface GeminiUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** 実費（失敗した回の見積もりの分を含む）。整数のマイクロドル */
  costMicroUsd: number;
  estimatedMicroUsd: number;
  latencyMs: number;
  /** 呼んだ回数（やり直しを含む） */
  attempts: number;
}

/** 呼ばなかった・止まった理由 */
export type GeminiStop = { kind: "kill_switch" } | { kind: "budget"; spend: SpendDenied };

export type GeminiCallErrorKind = "kill_switch" | "budget" | "unpriced_model" | "incompatible_model" | "aborted" | "llm" | "stopped";

/** callGemini の失敗（kind で見分ける。toAppError でタスクの外の API のエラーにする） */
export class GeminiCallError extends Error {
  readonly kind: GeminiCallErrorKind;
  readonly spend: SpendDenied | null;
  readonly llmError: LlmError | null;
  /** beforeCall が返したエラー（kind: 'stopped'） */
  readonly stopError: unknown;
  constructor(kind: GeminiCallErrorKind, message: string, extra: { spend?: SpendDenied; llmError?: LlmError; stopError?: unknown } = {}) {
    super(message);
    this.name = "GeminiCallError";
    this.kind = kind;
    this.spend = extra.spend ?? null;
    this.llmError = extra.llmError ?? null;
    this.stopError = extra.stopError;
  }

  /** タスクの外の呼び出し（設定プランナーなど）の API のエラー（M-38・cross-check §4.4） */
  toAppError(now: Date): AppError {
    switch (this.kind) {
      case "kill_switch":
        return new AppError("KILL_SWITCH_ENGAGED");
      case "budget":
        return spendDeniedAppError(this.spend ?? { scope: "global" }, now);
      case "unpriced_model":
        return new AppError("LLM_UPSTREAM_ERROR", "価格表にないモデルは呼びません");
      case "incompatible_model":
        return new AppError("LLM_UPSTREAM_ERROR", this.message);
      default:
        return new AppError("LLM_UPSTREAM_ERROR");
    }
  }
}

export interface GeminiDeps {
  db: Db;
  /** 1回だけ呼ぶクライアント（やり直しは callGemini がする。GeminiClient は createEdgeGeminiClient で作る） */
  llm: LlmClient;
  clock: Clock;
  log: Logger;
  retry?: { delaysMs?: readonly number[]; sleep?: SleepFn };
  spendLimits?: SpendLimits;
}

/** 呼ぶ前・呼んだ後に同じトランザクションで行う処理（タスクの LLM Proxy が使う） */
export interface CallGeminiHooks {
  /** Kill Switch・予算で止めるとき（同じトランザクション。タスクを halted にする）。そのあと callGemini は投げる */
  onStopped?(tx: Tx, stop: GeminiStop, now: Date): Promise<void>;
  /** 予算を通ったあと、呼ぶ前（同じトランザクション）。ok: false なら呼ばずに投げる（タスクの decide(llm_call) の halt） */
  beforeCall?(tx: Tx, estimatedMicroUsd: number, now: Date): Promise<{ ok: true } | { ok: false; error: unknown }>;
  /** usage_records と同じトランザクション（タスクの cost_usd・steps_used の加算、ツール呼び出しの判定） */
  afterCall?(tx: Tx, usage: GeminiUsage, response: LlmResponse, now: Date): Promise<void>;
  /** やり直しのあとも失敗したとき（同じトランザクション。タスクを failed(llm_unavailable) にする） */
  afterFailure?(tx: Tx, error: GeminiCallError, usage: GeminiUsage, now: Date): Promise<void>;
}

/** GeminiClient を「1回だけ呼ぶ」設定で作る（やり直しは callGemini の1か所で数える：SO §3.12-5・6） */
export function createEdgeGeminiClient(opts: Omit<GeminiClientOptions, "retry">): GeminiClient {
  return new GeminiClient({ ...opts, retry: { delaysMs: [] } });
}

/** 呼ぶ前の見積もり（BR-10：入力の上限 × 入力単価 ＋ maxTokens × 出力単価 ＋ 思考の上限 × 単価。思考の上限は maxTokens と同じにする：計測と同じ） */
export function estimateCallMicroUsd(req: LlmRequest): number {
  const tokens = estimateMicroUsd(req.model, {
    inputTokens: inputTokensUpperBound(req),
    maxOutputTokens: req.maxTokens,
    thinkingBudget: req.maxTokens,
  });
  // Google 検索の Grounding は検索の回数でも費用がかかる（web_search）
  return req.googleSearch === true ? tokens + GROUNDING_QUERIES_ESTIMATE * GROUNDING_QUERY_MICRO_USD : tokens;
}

/** プロンプトのハッシュ（usage_records.prompt_hash・llm.called。本文は保存しない：A-15・§8-32） */
export function promptHashOf(req: LlmRequest): string {
  const material = {
    model: req.model,
    system: req.system,
    messages: req.messages,
    tools: req.tools.map((t) => t.name),
    mcpTools: req.mcpTools.map((t) => `${t.connector}.${t.tool}`),
  };
  try {
    return sha256Hex(canonicalJson(material));
  } catch {
    return sha256Hex(JSON.stringify(material) ?? "");
  }
}

/** 使った量が分からない失敗（送れたか分からない：status のない LlmError・LlmError 以外） */
function usageUnknown(e: unknown): boolean {
  return !(e instanceof LlmError) || e.status === null;
}

/**
 * Gemini を呼ぶ（SO §3.12 callGemini）。止めたときは GeminiCallError（kind で見分ける）。
 * 失敗した回の見積もりの費用も usage_records に残す（数え漏れで上限を超えない）
 */
export async function callGemini(
  deps: GeminiDeps,
  ctx: GeminiCallContext,
  req: LlmRequest,
  hooks: CallGeminiHooks = {},
): Promise<{ response: LlmResponse; usage: GeminiUsage }> {
  // usage_records の持ち主は task・agent・ask・rehearsal_run のどれか1つ以上（DB の CHECK。呼ぶ前に確かめる）
  if (ctx.taskId === null && ctx.agentId === null && ctx.askId === null && ctx.rehearsalRunId === null) {
    throw new TypeError("callGemini: 費用の持ち主（taskId・agentId・askId・rehearsalRunId）がない");
  }
  if (ctx.signal?.aborted) throw new GeminiCallError("aborted", "LLM の呼び出しを中断しました");
  const price = deps.llm.priceFor ? deps.llm.priceFor(req.model) : findPrice(req.model);
  if (price === null) throw new GeminiCallError("unpriced_model", "価格表にないモデルは呼びません");
  try { deps.llm.preflight?.(req); } catch (e) {
    throw new GeminiCallError("incompatible_model", e instanceof LlmError ? e.message : "モデルの能力・設定を確認してください");
  }
  const est = deps.llm.estimateMicroUsd ? deps.llm.estimateMicroUsd(req) : estimateCallMicroUsd(req);
  // HTTP adapters may have sent a request even when usage is unknown. Check all
  // permitted attempts upfront; actual attempts are charged below, never at zero.
  const budgetEstimate = deps.llm.estimateMicroUsd ? est * ((deps.retry?.delaysMs ?? LLM_RETRY_DELAYS_MS).length + 1) : est;
  if (!Number.isSafeInteger(budgetEstimate)) throw new GeminiCallError("incompatible_model", "再試行を含む料金見積もりが大きすぎます");
  const limits = deps.spendLimits ?? SPEND_LIMITS;
  const target = { workspaceId: ctx.workspaceId, workspaceKind: ctx.workspaceKind, rehearsalRunId: ctx.rehearsalRunId };
  const wsCtx = { workspaceId: ctx.workspaceId, kind: ctx.workspaceKind, userId: null };

  // 3. 呼ぶ前の確かめ（止めた記録はコミットしてから投げる）
  const pre = await deps.db.transaction(
    async (tx): Promise<{ ok: true } | { ok: false; error: GeminiCallError }> => {
      const now = deps.clock.now();
      const ws = await lockWorkspace(tx, wsCtx);
      if (ws === null) throw new Error(`ワークスペース ${ctx.workspaceId} が見つからない`);
      if (ws.kill_switch_engaged) {
        await hooks.onStopped?.(tx, { kind: "kill_switch" }, now);
        return { ok: false, error: new GeminiCallError("kill_switch", "Kill Switch が発動中です") };
      }
      const spend = await checkSpend(tx, target, budgetEstimate, now, limits);
      if (!spend.ok) {
        await hooks.onStopped?.(tx, { kind: "budget", spend }, now);
        return { ok: false, error: new GeminiCallError("budget", `費用の上限を超えます（${spend.scope}）`, { spend }) };
      }
      const before = (await hooks.beforeCall?.(tx, budgetEstimate, now)) ?? { ok: true as const };
      if (!before.ok) return { ok: false, error: new GeminiCallError("stopped", "呼ぶ前の判定で止めました", { stopError: before.error }) };
      return { ok: true };
    },
    { retryOnce: true },
  );
  if (!pre.ok) throw pre.error;

  // 4. 呼ぶ（トランザクションの外）
  let chargedMicro = 0;
  let attempts = 0;
  const started = performance.now();
  let response: LlmResponse;
  try {
    response = await withRetry(
      async () => {
        attempts += 1;
        try {
          return await deps.llm.generate(req, ctx.signal ? { signal: ctx.signal } : {});
        } catch (e) {
          // LlmError 以外の失敗も「送れたか分からない」としてやり直さない LlmError にそろえる
          throw e instanceof LlmError ? e : new LlmError(`LLM の呼び出しに失敗しました：${errorMessage(e)}`, null, false);
        }
      },
      {
        delaysMs: deps.retry?.delaysMs ?? LLM_RETRY_DELAYS_MS,
        ...(deps.retry?.sleep ? { sleep: deps.retry.sleep } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onRetry: (info) => {
          if (usageUnknown(info.error)) chargedMicro += est;
          // 再試行が見えないと、504 のタイムアウトの待ち（1回 最大120秒）が空白に見える（2026-10-06 の本番で7分）
          deps.log.warn("llm.retry", "LLM の呼び出しをやり直します", {
            workspaceId: ctx.workspaceId,
            taskId: ctx.taskId,
            rehearsalRunId: ctx.rehearsalRunId,
            purpose: ctx.purpose,
            model: req.model,
            retry: info.retry,
            delayMs: info.delayMs,
            status: info.error instanceof LlmError ? info.error.status : null,
            elapsedMs: Math.round(performance.now() - started),
          });
        },
      },
    );
  } catch (e) {
    if (usageUnknown(e)) chargedMicro += est;
    const llmError = e instanceof LlmError ? e : new LlmError(errorMessage(e), null, false);
    const aborted = ctx.signal?.aborted === true;
    const error = new GeminiCallError(aborted ? "aborted" : "llm", aborted ? "LLM の呼び出しを中断しました" : llmError.message, { llmError });
    const usage: GeminiUsage = {
      model: req.model,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      costMicroUsd: chargedMicro,
      estimatedMicroUsd: est,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      attempts,
    };
    await deps.db.transaction(
      async (tx) => {
        const now = deps.clock.now();
        await lockWorkspace(tx, wsCtx);
        if (chargedMicro > 0) await insertUsageRecord(tx, wsCtx, usageRow(ctx, req, usage, usageProviderOf(deps.llm)), now);
        await hooks.afterFailure?.(tx, error, usage, now);
      },
      { retryOnce: true },
    );
    deps.log.warn("llm.failed", "LLM の呼び出しに失敗しました", {
      workspaceId: ctx.workspaceId,
      taskId: ctx.taskId,
      rehearsalRunId: ctx.rehearsalRunId,
      model: req.model,
      attempts,
      status: llmError.status,
      chargedUsd: system.microToUsd(chargedMicro),
    });
    throw error;
  }

  // 5. 費用の記録
  const usage: GeminiUsage = {
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    thinkingTokens: response.usage.thinkingTokens,
    costMicroUsd: response.usage.costMicroUsd + chargedMicro,
    estimatedMicroUsd: est,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    attempts,
  };
  await deps.db.transaction(
    async (tx) => {
      const now = deps.clock.now();
      await lockWorkspace(tx, wsCtx);
      await insertUsageRecord(tx, wsCtx, usageRow(ctx, req, usage, usageProviderOf(deps.llm)), now);
      await hooks.afterCall?.(tx, usage, response, now);
    },
    { retryOnce: true },
  );
  // 6. 構造化ログ（プロンプトと応答の本文は出さない：SO §3.12-8）
  deps.log.info("llm.called", "LLM を呼びました", {
    workspaceId: ctx.workspaceId,
    taskId: ctx.taskId,
    rehearsalRunId: ctx.rehearsalRunId,
    purpose: ctx.purpose,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    thinkingTokens: usage.thinkingTokens,
    costUsd: system.microToUsd(usage.costMicroUsd),
    attempts,
    latencyMs: usage.latencyMs,
  });
  return { response, usage };
}

/** usage_records.provider。llm の provider 未設定（Gemini）は google。それ以外は設定した提供元の名前 */
function usageProviderOf(llm: LlmClient): UsageRecordInput["provider"] {
  return llm.provider === undefined || llm.provider === "gemini" ? "google" : llm.provider;
}

function usageRow(ctx: GeminiCallContext, req: LlmRequest, usage: GeminiUsage, provider: UsageRecordInput["provider"]) {
  return {
    taskId: ctx.taskId,
    agentId: ctx.agentId,
    askId: ctx.askId,
    rehearsalRunId: ctx.rehearsalRunId,
    provider,
    model: usage.model,
    phase: ctx.phase,
    inputTokens: usage.inputTokens,
    // 思考のトークンは出力の単価で数える（usage_records に思考の列がないので出力に入れる：SO §3.12-6）
    outputTokens: usage.outputTokens + usage.thinkingTokens,
    estimatedCostUsd: system.microToUsd(usage.estimatedMicroUsd),
    costUsd: system.microToUsd(usage.costMicroUsd),
    latencyMs: usage.latencyMs,
    promptHash: promptHashOf(req),
  };
}
