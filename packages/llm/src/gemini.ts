// Gemini の呼び出し（Vertex AI。ADR-032：API キーを使わず、Cloud Run の sa-app の ADC で認証する。SO §3.12-5・§9 I-14）
// runner の会話（ChatMessage）を Gemini の contents に変え、応答を AssistantPart に戻す（formation-runtime.md §2.6・§3.10）。
// タイムアウト120秒、429・5xx・ネットワークは 1・4・16秒あけて最大3回（04_functional_spec/runtime.md:141、11_tech_spec.md:293）。
// 使った量と費用は usageMetadata から出す（思考のトークンを含む：SO §3.12-6）。プロンプト・応答の本文はエラーの文に入れない（SO §3.12-8）

import { randomUUID } from "node:crypto";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type {
  Candidate,
  Content,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  Part,
} from "@google/genai";
import type { AssistantPart, ChatMessage } from "@open-team/runner";
import { DEFAULT_GEMINI_LOCATION } from "./models.ts";
import { costMicroUsd, findPrice, GROUNDING_QUERY_MICRO_USD, type TokenUsage } from "./pricing.ts";
import { llmAbortedError, withRetry, type RetryOptions } from "./retry.ts";
import {
  buildToolDeclarations,
  EMPTY_MCP_FUNCTION_TABLE,
  fromGeminiFunctionCall,
  toGeminiFunctionCall,
  type McpFunctionTable,
} from "./tools.ts";
import { LlmError, type LlmClient, type LlmGrounding, type LlmRequest, type LlmResponse, type LlmUsage } from "./types.ts";

/** 1回の呼び出しのタイムアウト（SO LIMITS.llmTimeoutMs） */
export const LLM_TIMEOUT_MS = 120_000;

/** 応答のうち使うところ（SDK の GenerateContentResponse はこれを満たす。試験では素のオブジェクトで返せる） */
export type GeminiResponse = Pick<GenerateContentResponse, "candidates" | "usageMetadata" | "promptFeedback" | "modelVersion">;

/** SDK の ai.models.generateContent 相当（試験で差し替える） */
export type GenerateContentFn = (params: GenerateContentParameters) => Promise<GeminiResponse>;

/** toGeminiRequest の結果（contents は必ず Content の配列） */
export interface GeminiRequestParams extends GenerateContentParameters {
  contents: Content[];
  config: GenerateContentConfig;
}

export interface GeminiClientOptions {
  /** GOOGLE_CLOUD_PROJECT。generateContent を渡さないときは必須 */
  project?: string;
  /** GOOGLE_CLOUD_LOCATION（既定 'global'） */
  location?: string;
  /** 試験用：ai.models.generateContent の代わり（渡すと SDK のクライアントを作らない） */
  generateContent?: GenerateContentFn;
  /** 1回の呼び出しのタイムアウト（既定 120秒） */
  timeoutMs?: number;
  /** 再試行（既定 1・4・16秒。待ちを差し替えられる。onRetry で失敗した回を数えられる） */
  retry?: Pick<RetryOptions, "delaysMs" | "sleep" | "onRetry">;
  /** モデルが ID を返さないツール呼び出しの ID（既定 crypto.randomUUID） */
  newId?: () => string;
  /**
   * 価格表（PRICE_TABLE）にないモデルも呼ぶか（既定 false：呼ばずに LlmError。SO §3.12-2・07_architecture.md:284）。
   * true を明示したときだけ、費用を高めの単価（FALLBACK_PRICE）で数えて呼ぶ（計測の --allow-unpriced など）
   */
  allowUnpricedModels?: boolean;
}

/** 価格表にないモデルを呼ばないときの失敗（送る前に断るので status は null・やり直さない。モデル ID は長ければ切る） */
export function unpricedModelError(model: string): LlmError {
  const id = model.length > 100 ? `${model.slice(0, 100)}…` : model;
  return new LlmError(`価格表にないモデルは呼びません（費用を数えられないため）：${id}`, null, false);
}

export class GeminiClient implements LlmClient {
  private readonly generateContent: GenerateContentFn;
  private readonly timeoutMs: number;
  private readonly retry: Pick<RetryOptions, "delaysMs" | "sleep" | "onRetry">;
  private readonly newId: () => string;
  private readonly allowUnpricedModels: boolean;

  constructor(opts: GeminiClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
    this.retry = opts.retry ?? {};
    this.newId = opts.newId ?? (() => randomUUID());
    this.allowUnpricedModels = opts.allowUnpricedModels === true;
    if (opts.generateContent !== undefined) {
      this.generateContent = opts.generateContent;
    } else {
      const project = opts.project?.trim();
      if (project === undefined || project === "") {
        throw new Error("GeminiClient: project（GOOGLE_CLOUD_PROJECT）がありません");
      }
      this.generateContent = createVertexGenerateContent({
        project,
        location: opts.location ?? DEFAULT_GEMINI_LOCATION,
        timeoutMs: this.timeoutMs,
      });
    }
  }

  /**
   * 失敗は LlmError（retryable は 429・5xx・ネットワーク・タイムアウト。やり直しはこの中で済ませる）。
   * status が null の失敗は、送れたか・使った量が分からない（edge は見積もりを費用に数える：SO §3.12-6）。
   * 価格表にないモデルは、allowUnpricedModels を明示しない限り呼ばない（送る前の LlmError。status null・やり直さない：
   * 空の会話と同じ形。edge の callGemini は呼ぶ前に findPrice() で断るので、ここは配線の誤りの止め）
   */
  async generate(req: LlmRequest, opts: { signal?: AbortSignal } = {}): Promise<LlmResponse> {
    if (!this.allowUnpricedModels && findPrice(req.model) === null) throw unpricedModelError(req.model);
    const { params, table } = toGeminiRequest(req);
    if (params.contents.length === 0) throw new LlmError("Gemini に送る会話がありません", null, false);
    const { signal } = opts;
    const res = await withRetry(() => this.callOnce(params, signal), { ...this.retry, signal });
    return fromGeminiResponse(res, {
      model: req.model,
      table,
      newId: this.newId,
      maxTokens: req.maxTokens,
      requestTokensUpperBound: () => requestTokensUpperBound(params),
      usedIds: toolCallIdsOf(req.messages),
    });
  }

  /** 1回だけ呼ぶ。タイムアウト・呼び出し元の中断では、SDK の応答を待たずに打ち切る（Kill Switch の p95 10秒：NFR-012） */
  private async callOnce(params: GeminiRequestParams, signal: AbortSignal | undefined): Promise<GeminiResponse> {
    if (signal?.aborted) throw llmAbortedError();
    const attempt = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attempt.abort();
    }, this.timeoutMs);
    const onAbort = (): void => attempt.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const call = this.generateContent({ ...params, config: { ...params.config, abortSignal: attempt.signal } });
      return await settleOrAbort(call, attempt.signal);
    } catch (error) {
      if (signal?.aborted) throw llmAbortedError();
      if (timedOut) throw new LlmError(`Gemini の応答が ${this.timeoutMs} ミリ秒以内に返りませんでした`, null, true);
      throw toLlmError(error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Vertex AI の SDK のクライアント。API キーは渡さない（ADR-032）。project・location を明示すると、
 * SDK は環境変数の GOOGLE_API_KEY・GEMINI_API_KEY も使わない（ADC で認証する）
 */
export function createVertexAi(opts: { project: string; location: string; timeoutMs?: number }): GoogleGenAI {
  return new GoogleGenAI({
    vertexai: true,
    project: opts.project,
    location: opts.location,
    // SDK の再試行は使わない（retryOptions を渡さない。やり直しは withRetry の1か所）。timeout は X-Server-Timeout でサーバーにも伝わる
    httpOptions: opts.timeoutMs === undefined ? undefined : { timeout: opts.timeoutMs },
  });
}

export function createVertexGenerateContent(opts: { project: string; location: string; timeoutMs?: number }): GenerateContentFn {
  const ai = createVertexAi(opts);
  return (params) => ai.models.generateContent(params);
}

// ---- 要求 ----

/** LlmRequest → generateContent の引数。表（mcp_call の展開）は応答の戻しに使う */
export function toGeminiRequest(req: LlmRequest): { params: GeminiRequestParams; table: McpFunctionTable } {
  // 構造化出力（状況の生成・設定プランナー）ではツールを渡さない（llm/types.ts LlmRequest.responseJsonSchema）
  // Google 検索の Grounding（web_search）は関数の宣言・構造化出力と一緒に渡さない
  const search = req.googleSearch === true;
  const structured = !search && req.responseJsonSchema !== undefined && req.responseJsonSchema !== null;
  const { declarations, table } =
    structured || search ? { declarations: [], table: EMPTY_MCP_FUNCTION_TABLE } : buildToolDeclarations(req.tools, req.mcpTools);
  const config: GenerateContentConfig = { maxOutputTokens: req.maxTokens };
  if (req.system !== "") config.systemInstruction = req.system;
  if (req.temperature !== undefined) config.temperature = req.temperature;
  if (req.thinkingLevel !== undefined) config.thinkingConfig = { thinkingLevel: req.thinkingLevel === "low" ? ThinkingLevel.LOW : ThinkingLevel.HIGH };
  if (search) config.tools = [{ googleSearch: {} }];
  else if (declarations.length > 0) config.tools = [{ functionDeclarations: declarations }];
  if (structured) {
    config.responseMimeType = "application/json";
    // スキーマは手を加えずに渡す（z.toJSONSchema の出力をそのまま：SW:306）
    config.responseJsonSchema = req.responseJsonSchema;
  }
  return { params: { model: req.model, contents: toGeminiContents(req.messages, table), config }, table };
}

/**
 * runner の会話を Gemini の contents にする。user → user、assistant → model、tool → user の functionResponse。
 * 署名（thoughtSignature）は部品ごとにそのまま返す（Gemini 3 は関数呼び出しの署名が欠けると 400）。
 * ID は関数呼び出しと応答の両方に入れて組を明示し、応答の名前は toolCallId で前の呼び出しを引いて合わせる。
 * 同じ役割が続いたら1つの Content にまとめる（並列の呼び出しの応答は1つの Content で返す）
 */
export function toGeminiContents(messages: readonly ChatMessage[], table: McpFunctionTable): Content[] {
  const contents: Content[] = [];
  const callNames = new Map<string, string>();
  const push = (role: "user" | "model", parts: Part[]): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last !== undefined && last.role === role && last.parts !== undefined) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === "user") {
      // 空の文字の部品は Vertex が 400 を返すので送らない
      if (m.content !== "") push("user", [{ text: m.content }]);
    } else if (m.role === "assistant") {
      push("model", m.content.flatMap((p) => assistantPart(p, table, callNames)));
    } else {
      const { toolCallId, name, result } = m.content;
      push("user", [
        { functionResponse: { id: toolCallId, name: callNames.get(toolCallId) ?? name, response: { output: result } } },
      ]);
    }
  }
  return contents;
}

function assistantPart(p: AssistantPart, table: McpFunctionTable, callNames: Map<string, string>): Part[] {
  if (p.type === "text") {
    if (p.text === "" && !p.signature) return [];
    return [withThoughtSignature({ text: p.text }, p.signature)];
  }
  const call = toGeminiFunctionCall(p, table);
  callNames.set(p.id, call.name);
  return [withThoughtSignature({ functionCall: { id: p.id, name: call.name, args: call.args } }, p.signature)];
}

/** 署名は空でなければそのまま付ける（モデルが返した部品と同じ形で返す） */
function withThoughtSignature(part: Part, signature: string | undefined): Part {
  return signature ? { ...part, thoughtSignature: signature } : part;
}

/**
 * 呼ぶ前の見積もり（estimateMicroUsd）の入力トークン数：文字数からの上限の目安（安全側。SO §9 I-15）。
 * 送る本文（system・会話・ツールの宣言・構造化出力の JSON Schema）の JSON の UTF-8 バイト数（1トークンは1バイト以上なので、まず下回らない）
 */
export function inputTokensUpperBound(req: LlmRequest): number {
  return requestTokensUpperBound(toGeminiRequest(req).params);
}

function requestTokensUpperBound(params: GeminiRequestParams): number {
  // 構造化出力の JSON Schema も要求に入って送られる（入れないと設定プランナー・状況の生成の見積もりが甘くなる）
  const { systemInstruction, tools, responseJsonSchema } = params.config;
  return Buffer.byteLength(
    JSON.stringify([systemInstruction ?? null, params.contents, tools ?? null, responseJsonSchema ?? null]),
    "utf8",
  );
}

/** 会話でもう使った関数呼び出しの ID（呼び出しと応答の両方から） */
function toolCallIdsOf(messages: readonly ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const p of m.content) if (p.type === "tool_call") ids.add(p.id);
    } else if (m.role === "tool") {
      ids.add(m.content.toolCallId);
    }
  }
  return ids;
}

// ---- 応答 ----

export interface FromGeminiContext {
  /** 要求したモデル（LlmResponse.model と価格表の鍵。応答の modelVersion は使わない） */
  model: string;
  table: McpFunctionTable;
  newId: () => string;
  /** usageMetadata がないときに出力の量として数える上限（maxOutputTokens） */
  maxTokens: number;
  /** usageMetadata がないときに入力の量として数える上限 */
  requestTokensUpperBound: () => number;
  /**
   * 会話でもう使った関数呼び出しの ID。モデルが前の応答と同じ ID を返したら作り直す
   * （ID はタスクの中の governance・callTool の鍵：runner/types.ts ToolCallPart.id。重なると edge が2回目を「実行済み」で断る）
   */
  usedIds?: ReadonlySet<string>;
}

/** ID を作る回数の上限（newId が使った ID を返し続けるのは呼び出し側のバグ） */
const NEW_ID_ATTEMPTS = 100;

function freshId(newId: () => string, used: ReadonlySet<string>): string {
  for (let i = 0; i < NEW_ID_ATTEMPTS; i++) {
    const id = newId();
    if (id !== "" && !used.has(id)) return id;
  }
  throw new Error("関数呼び出しの ID を作れませんでした（newId が使った ID を返し続けた）");
}

/**
 * 応答の1つ目の候補を AssistantPart に戻す。関数呼び出しは mcp_call の形に戻し（tools.ts）、ID はモデルのものか newId()。
 * 思考の要約・使わない種類の部品（画像など）は捨てるが、署名だけは空の文字の部品に残して次の呼び出しで返す
 */
export function fromGeminiResponse(res: GeminiResponse, ctx: FromGeminiContext): LlmResponse {
  const candidate = res.candidates?.[0];
  const parts: AssistantPart[] = [];
  const ids = new Set<string>(ctx.usedIds ?? []);
  for (const part of candidate?.content?.parts ?? []) {
    const signature = part.thoughtSignature === undefined || part.thoughtSignature === "" ? undefined : part.thoughtSignature;
    if (part.functionCall !== undefined) {
      const fc = part.functionCall;
      // ID は governance・callTool の鍵なので、ない・この応答や前の応答と重なるときは作る（作った ID も重ねない）
      const id = fc.id !== undefined && fc.id !== "" && !ids.has(fc.id) ? fc.id : freshId(ctx.newId, ids);
      ids.add(id);
      const call = fromGeminiFunctionCall(fc.name ?? "", fc.args ?? {}, ctx.table);
      parts.push(withSignature({ type: "tool_call", id, name: call.name, arguments: call.arguments }, signature));
    } else if (typeof part.text === "string" && part.thought !== true) {
      if (part.text === "" && signature === undefined) continue;
      parts.push(withSignature({ type: "text", text: part.text }, signature));
    } else if (signature !== undefined) {
      parts.push({ type: "text", text: "", signature });
    }
  }
  const grounding = groundingOf(candidate);
  const usage = usageOf(res.usageMetadata, ctx);
  if (grounding === undefined) return { model: ctx.model, parts, stopReason: stopReasonOf(res, candidate, parts), usage };
  // 検索の回数はトークンとは別に数える（1回 GROUNDING_QUERY_MICRO_USD）
  const searchCost = grounding.queries.length * GROUNDING_QUERY_MICRO_USD;
  return {
    model: ctx.model,
    parts,
    stopReason: stopReasonOf(res, candidate, parts),
    usage: { ...usage, costMicroUsd: usage.costMicroUsd + searchCost },
    grounding,
  };
}

/** Grounding の検索の語句と出典（groundingMetadata がなければ undefined。出典は URL で重なりを除く） */
function groundingOf(candidate: Candidate | undefined): LlmGrounding | undefined {
  const meta = candidate?.groundingMetadata;
  if (meta === undefined) return undefined;
  const queries = (meta.webSearchQueries ?? []).filter((q): q is string => typeof q === "string" && q.trim() !== "");
  const sources: LlmGrounding["sources"] = [];
  const seen = new Set<string>();
  for (const chunk of meta.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    if (typeof url !== "string" || url === "" || seen.has(url)) continue;
    seen.add(url);
    const title = chunk.web?.title ?? chunk.web?.domain ?? "";
    sources.push({ title: typeof title === "string" ? title : "", url });
  }
  return { queries, sources };
}

function withSignature<T extends AssistantPart>(part: T, signature: string | undefined): T {
  return signature === undefined ? part : { ...part, signature };
}

/**
 * "tool_call"（ツール呼び出しがある。09_api/sandbox-internal.md の例）／ finishReason の小文字（"stop"・"max_tokens"・"safety"・
 * "malformed_function_call" など）／ "prompt_blocked"（候補なし・プロンプトが止められた）／ "no_candidate" ／ "unknown"
 */
function stopReasonOf(res: GeminiResponse, candidate: Candidate | undefined, parts: readonly AssistantPart[]): string {
  if (parts.some((p) => p.type === "tool_call")) return "tool_call";
  if (candidate === undefined) return res.promptFeedback?.blockReason !== undefined ? "prompt_blocked" : "no_candidate";
  return candidate.finishReason !== undefined ? String(candidate.finishReason).toLowerCase() : "unknown";
}

function usageOf(meta: GenerateContentResponseUsageMetadata | undefined, ctx: FromGeminiContext): LlmUsage {
  const tokens: TokenUsage =
    meta === undefined
      ? // 使った量が返らないときは上限で数える（費用の上限を甘くしない）
        { inputTokens: ctx.requestTokensUpperBound(), outputTokens: tokenCount(ctx.maxTokens), thinkingTokens: 0 }
      : {
          // 入力はプロンプト（キャッシュの分も定価で数える）＋サーバー側のツールの結果。出力に思考は含まない（totalTokenCount の内訳）
          inputTokens: tokenCount(meta.promptTokenCount) + tokenCount(meta.toolUsePromptTokenCount),
          outputTokens: tokenCount(meta.candidatesTokenCount),
          thinkingTokens: tokenCount(meta.thoughtsTokenCount),
        };
  return { ...tokens, costMicroUsd: costMicroUsd(ctx.model, tokens) };
}

/** 0以上の整数にする（proto3 の JSON は 0 を省くので、ない値は 0） */
function tokenCount(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), Number.MAX_SAFE_INTEGER) : 0;
}

/** 結果か中断の早い方で決着する（中断したあとの結果・失敗は捨てる） */
function settleOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ---- 失敗の分類 ----

/** 接続・名前解決・ソケットの失敗（undici・Node のコード） */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

/** やり直してよい HTTP の状態：429・5xx（11_tech_spec.md:293）と 408（サーバー側のタイムアウト。こちらのタイムアウトと同じ扱い） */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** SDK・ネットワークの失敗を LlmError にする。呼び出し元の中断は callOnce が先に見る */
export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const status = httpStatusOf(error);
  if (status !== null) {
    return new LlmError(`Gemini がエラーを返しました（HTTP ${status}）: ${describeError(error)}`, status, isRetryableStatus(status));
  }
  if (isAbortLike(error)) return new LlmError("Gemini の応答を待つのを打ち切りました（タイムアウト）", null, true);
  const code = networkCodeOf(error);
  if (code !== null) return new LlmError(`Gemini に接続できませんでした（${code}）`, null, true);
  return new LlmError(`Gemini の呼び出しが失敗しました: ${describeError(error)}`, null, false);
}

/** ApiError の status（google-auth の失敗は response.status）。4xx・5xx だけ */
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as { status?: unknown; response?: unknown };
  let status: unknown = e.status;
  if (typeof status !== "number" && typeof e.response === "object" && e.response !== null) {
    status = (e.response as { status?: unknown }).status;
  }
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function isAbortLike(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/** cause をたどってネットワークの失敗のコードを探す（fetch failed / terminated の TypeError も） */
function networkCodeOf(error: unknown): string | null {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && typeof e === "object" && e !== null; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) return code;
    if (e instanceof TypeError && (e.message === "fetch failed" || e.message === "terminated")) {
      const inner = networkCodeOf((e as { cause?: unknown }).cause);
      return inner ?? e.message;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** エラーの文を1行・300文字までに。SyntaxError は応答の本文の断片が入りうるので名前だけ */
function describeError(error: unknown): string {
  if (error instanceof SyntaxError) return "SyntaxError";
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
