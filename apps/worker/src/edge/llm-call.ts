// LLM の呼び出し（SO §3.12 callGemini。packages/edge/src/gemini.ts の WorkspaceDO 版）。
// Node 版は「トランザクション → 呼ぶ → トランザクション」を1つの関数でしていた。ここでは DB の部分を DO（llmGate・llmRecord。同期）に、
// 呼ぶ部分を Worker・Workflow の側（callLlm。DO の RPC を ledger として受け取る）に分ける。手順は同じ：
// 1 中断・価格表にないモデル（呼ばない）→ 2 見積もり → 3 DO：checkSpend（やり直しの分も含めた見積もり）→
// 4 呼ぶ（やり直しはここの1か所：429・5xx・ネットワークを 1・4・16秒で3回。送れたか・使った量が分からない失敗は見積もりを費用に数える）→
// 5 DO：usage_records（失敗でも数えた分があれば残す）。
// タスクの判定（beforeCall・afterCall の decide(llm_call)・使った量）は 4c で ledger に足す

import { canonicalJson, sha256Hex } from "@open-team/kernel";
import {
  LLM_RETRY_DELAYS_MS,
  LlmError,
  computeMicroUsd,
  inputTokensUpperBound,
  withRetry,
  type GeminiPurpose,
  type LlmClient,
  type LlmRequest,
  type PriceEntry,
  type LlmResponse,
  type SleepFn,
} from "@open-team/llm";
import { insertUsageRecord, type UsageRecordInput } from "../db/repo/edge.ts";
import { CLAUDE_PRICES } from "../llm/claude.ts";
import type { WsDb } from "../db/sqlite.ts";
import type { UsagePhase, Uuid } from "../db/types.ts";
import { getWorkspace } from "../db/workspace.ts";
import { checkSpend, type SpendDenied } from "./spend.ts";

/** 誰の費用として、何のために呼ぶか（SO §2.6 の GeminiCallContext。ワークスペースは DO そのもの） */
export interface LlmCallTarget {
  /** タスクの外の呼び出し（設定プランナーなど）は null */
  taskId: Uuid | null;
  agentId: Uuid | null;
  askId: Uuid | null;
  purpose: GeminiPurpose;
  /** usage_records.phase */
  phase: UsagePhase;
}

export interface LlmCallUsage {
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

export type LlmCallErrorKind = "budget" | "unpriced_model" | "incompatible_model" | "aborted" | "llm";

/** callLlm の失敗（kind で見分ける。Workflow の歩みをまたぐときは name・kind・message だけが残る） */
export class LlmCallError extends Error {
  readonly kind: LlmCallErrorKind;
  readonly spend: SpendDenied | null;
  readonly llmError: LlmError | null;
  constructor(kind: LlmCallErrorKind, message: string, extra: { spend?: SpendDenied; llmError?: LlmError } = {}) {
    super(message);
    this.name = "LlmCallError";
    this.kind = kind;
    this.spend = extra.spend ?? null;
    this.llmError = extra.llmError ?? null;
  }
}

// =====================================================================
// DO の側（同期。WorkspaceDO の RPC から呼ぶ）
// =====================================================================

/** 呼ぶ前の確かめの結果 */
export type LlmGate = { ok: true } | { ok: false; kind: "budget"; spend: SpendDenied };

/** 3. 呼ぶ前の確かめ：費用の上限（全体。M-19） */
export function llmGate(db: WsDb, budgetEstimateMicroUsd: number, now: Date): LlmGate {
  if (getWorkspace(db) === null) throw new Error("ワークスペースの行がない");
  const spend = checkSpend(db, budgetEstimateMicroUsd, now);
  if (!spend.ok) return { ok: false, kind: "budget", spend };
  return { ok: true };
}

/** 5. 費用の記録（数えた額が0の失敗は残さない） */
export function llmRecord(db: WsDb, usage: UsageRecordInput, now: Date): void {
  db.transaction(() => insertUsageRecord(db, usage, now));
}

// =====================================================================
// 呼ぶ側（Worker・Workflow の歩みの中）
// =====================================================================

/** DO の記録の窓口（WorkspaceDO の stub がそのまま満たす） */
export interface LlmLedger {
  llmGate(budgetEstimateMicroUsd: number, now: Date): Promise<LlmGate>;
  llmRecord(usage: UsageRecordInput, now: Date): Promise<void>;
}

export interface LlmCallDeps {
  ledger: LlmLedger;
  /** 1回だけ呼ぶクライアント（llm.ts の llmOf） */
  llm: LlmClient;
  now: () => Date;
  retry?: { delaysMs?: readonly number[]; sleep?: SleepFn };
}

/**
 * 呼ぶ前の見積もり（BR-10：入力の上限 × 入力単価 ＋ maxTokens × 出力単価）。Claude の出力のトークンは思考を含み max_tokens の中に収まるので、
 * 思考の分を別に足さない
 */
export function estimateCallMicroUsd(req: LlmRequest, price: PriceEntry | undefined = CLAUDE_PRICES[req.model]): number {
  if (price === undefined) throw new LlmCallError("unpriced_model", "料金表にないモデルは呼びません");
  return computeMicroUsd(price, inputTokensUpperBound(req), req.maxTokens, 0);
}

/** プロンプトのハッシュ（usage_records.prompt_hash。本文は保存しない：A-15・§8-32） */
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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** usage_records.provider。Worker は Claude だけなので、provider を持たないクライアント（試験の台本）も anthropic として残す */
export function usageProviderOf(llm: LlmClient): UsageRecordInput["provider"] {
  return llm.provider === undefined ? "anthropic" : llm.provider === "gemini" ? "google" : llm.provider;
}

function usageRow(target: LlmCallTarget, req: LlmRequest, usage: LlmCallUsage, provider: UsageRecordInput["provider"]): UsageRecordInput {
  return {
    taskId: target.taskId,
    agentId: target.agentId,
    askId: target.askId,
    provider,
    model: usage.model,
    phase: target.phase,
    inputTokens: usage.inputTokens,
    // 思考のトークンは出力の単価で数える（usage_records に思考の列がないので出力に入れる：SO §3.12-6）
    outputTokens: usage.outputTokens + usage.thinkingTokens,
    estimatedCostMicroUsd: usage.estimatedMicroUsd,
    costMicroUsd: usage.costMicroUsd,
    latencyMs: usage.latencyMs,
    promptHash: promptHashOf(req),
  };
}

/** 呼ぶ前の準備（価格表・能力の確かめと見積もり）。呼べなければ LlmCallError（unpriced_model・incompatible_model・aborted） */
export interface PreparedLlmCall {
  /** 1回分の見積もり（送れたか分からない失敗はこれを費用に数える） */
  estimateMicroUsd: number;
  /** 予算の確かめに使う見積もり（HTTP のアダプターはやり直しの分も含める） */
  budgetEstimateMicroUsd: number;
  delaysMs: readonly number[];
}

export function prepareLlmCall(llm: LlmClient, req: LlmRequest, o: { delaysMs?: readonly number[]; signal?: AbortSignal } = {}): PreparedLlmCall {
  if (o.signal?.aborted) throw new LlmCallError("aborted", "LLM の呼び出しを中断しました");
  // 料金はクライアントの表（llm/claude.ts の ClaudeClient）。表を持たないクライアント（試験の台本）は Claude の料金表で数える
  const price = llm.priceFor ? llm.priceFor(req.model) : (CLAUDE_PRICES[req.model] ?? null);
  if (price === null) throw new LlmCallError("unpriced_model", "価格表にないモデルは呼びません");
  try {
    llm.preflight?.(req);
  } catch (e) {
    throw new LlmCallError("incompatible_model", e instanceof LlmError ? e.message : "モデルの能力・設定を確認してください");
  }
  const est = llm.estimateMicroUsd ? llm.estimateMicroUsd(req) : estimateCallMicroUsd(req, price);
  const delaysMs = o.delaysMs ?? LLM_RETRY_DELAYS_MS;
  // HTTP のアダプターは使った量が分からなくても送っていることがある。やり直しの分も先に見積もる（実際の回数で数える）
  const budgetEstimate = llm.estimateMicroUsd ? est * (delaysMs.length + 1) : est;
  if (!Number.isSafeInteger(budgetEstimate)) throw new LlmCallError("incompatible_model", "再試行を含む料金見積もりが大きすぎます");
  return { estimateMicroUsd: est, budgetEstimateMicroUsd: budgetEstimate, delaysMs };
}

/** 呼んでも失敗した（usage は数えた費用。0 なら null） */
export class LlmGenerateFailure extends Error {
  readonly error: LlmCallError;
  readonly usage: LlmCallUsage | null;
  constructor(error: LlmCallError, usage: LlmCallUsage | null) {
    super(error.message);
    this.name = "LlmGenerateFailure";
    this.error = error;
    this.usage = usage;
  }
}

/** 4. 呼ぶ（やり直しはここの1か所）。失敗は LlmGenerateFailure（送れたか分からない回の見積もりを費用として持つ） */
export async function generateWithRetry(
  llm: LlmClient,
  req: LlmRequest,
  prepared: PreparedLlmCall,
  o: { sleep?: SleepFn; signal?: AbortSignal } = {},
): Promise<{ response: LlmResponse; usage: LlmCallUsage }> {
  const est = prepared.estimateMicroUsd;
  let chargedMicro = 0;
  let attempts = 0;
  const started = Date.now();
  let response: LlmResponse;
  try {
    response = await withRetry(
      async () => {
        attempts += 1;
        try {
          return await llm.generate(req, o.signal ? { signal: o.signal } : {});
        } catch (e) {
          // LlmError 以外の失敗も「送れたか分からない」としてやり直さない LlmError にそろえる
          throw e instanceof LlmError ? e : new LlmError(`LLM の呼び出しに失敗しました：${errorMessage(e)}`, null, false);
        }
      },
      {
        delaysMs: prepared.delaysMs,
        ...(o.sleep ? { sleep: o.sleep } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
        onRetry: (info) => {
          if (usageUnknown(info.error)) chargedMicro += est;
        },
      },
    );
  } catch (e) {
    if (usageUnknown(e)) chargedMicro += est;
    const llmError = e instanceof LlmError ? e : new LlmError(errorMessage(e), null, false);
    const aborted = o.signal?.aborted === true;
    const error = new LlmCallError(aborted ? "aborted" : "llm", aborted ? "LLM の呼び出しを中断しました" : llmError.message, { llmError });
    const usage: LlmCallUsage | null =
      chargedMicro > 0
        ? { model: req.model, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, costMicroUsd: chargedMicro, estimatedMicroUsd: est, latencyMs: Math.max(0, Date.now() - started), attempts }
        : null;
    throw new LlmGenerateFailure(error, usage);
  }
  return {
    response,
    usage: {
      model: response.model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      thinkingTokens: response.usage.thinkingTokens,
      costMicroUsd: response.usage.costMicroUsd + chargedMicro,
      estimatedMicroUsd: est,
      latencyMs: Math.max(0, Date.now() - started),
      attempts,
    },
  };
}

/**
 * タスクの外の LLM の呼び出し（設定プランナーなど。SO §3.12 callGemini）。止めたときは LlmCallError（kind で見分ける）。
 * 失敗した回の見積もりの費用も usage_records に残す（数え漏れで上限を超えない）。
 * タスクの中の呼び出しは workflows/task-run.ts（同じ prepareLlmCall・generateWithRetry に、タスクの判定を挟む）
 */
export async function callLlm(
  deps: LlmCallDeps,
  target: LlmCallTarget,
  req: LlmRequest,
  signal?: AbortSignal,
): Promise<{ response: LlmResponse; usage: LlmCallUsage }> {
  if (target.taskId === null && target.agentId === null && target.askId === null) {
    throw new TypeError("callLlm: 費用の持ち主（taskId・agentId・askId）がない");
  }
  const prepared = prepareLlmCall(deps.llm, req, { ...(deps.retry?.delaysMs ? { delaysMs: deps.retry.delaysMs } : {}), ...(signal ? { signal } : {}) });

  // 3. 呼ぶ前の確かめ（DO）
  const gate = await deps.ledger.llmGate(prepared.budgetEstimateMicroUsd, deps.now());
  if (!gate.ok) {
    throw new LlmCallError("budget", `費用の上限を超えます（${gate.spend.scope}）`, { spend: gate.spend });
  }

  // 4. 呼ぶ → 5. 費用の記録（DO）
  const provider = usageProviderOf(deps.llm);
  try {
    const called = await generateWithRetry(deps.llm, req, prepared, { ...(deps.retry?.sleep ? { sleep: deps.retry.sleep } : {}), ...(signal ? { signal } : {}) });
    await deps.ledger.llmRecord(usageRow(target, req, called.usage, provider), deps.now());
    return called;
  } catch (e) {
    if (!(e instanceof LlmGenerateFailure)) throw e;
    if (e.usage !== null) await deps.ledger.llmRecord(usageRow(target, req, e.usage, provider), deps.now());
    throw e.error;
  }
}
