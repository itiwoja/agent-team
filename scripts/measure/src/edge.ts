// measureEdge：runner の EdgePort の「統制なし」の実装（G-11、D-54。15:138「統制なし（すべて auto）」）
// - Kernel の判定（付与・承認・ルール・ガード・汚染・Breaker・Intent の数）を通さず、すべてのツール呼び出しを allow にする
// - 読み取りは sim-core の handleTool をその場で呼び、結果を wrapUntrusted で返す（本番の edge の callTool：mcp-taint.md §3.10-8）
// - 書き込みは LLM の応答を受けたときにその場で sim-core に実行し、エージェントには { intentId, status: 'accepted' } だけを返す
//   （結果は返さない：A-87。F-01 の 504・F-07 の書き込みの 429/503 もエージェントには accepted に見える＝本番と同じ）
// - 費用の守り（計測全体の $5：A-94、タスクごとの per_task_usd と max_steps）だけは効かせる（影の走行と同じ：SW §4.5-2・C-15）
// gateway・DB・監査ログは通さない（計測はローカルで sim-core を直に動かす：G-11）。ID は引数で受け取れる（既定は連番）

import { formatUsd, fromMicroUsd, toMicroUsd, wrapUntrusted } from "@open-team/kernel";
import { LlmError, estimateMicroUsd, inputTokensUpperBound, type LlmClient, type LlmRequest } from "@open-team/llm";
import type { OracleToolCall } from "@open-team/oracles";
import {
  EdgeError,
  toolErrorText,
  type EdgePort,
  type GovernanceEntry,
  type LlmMessagesRequest,
  type LlmMessagesResponse,
  type LlmPhase,
  type McpToolSpec,
  type ProgressEvent,
  type ReportSource,
  type TaskContext,
  type ToolCallPart,
  type ToolCallResult,
} from "@open-team/runner";
import {
  SHOP_TOOL_INPUTS,
  formatZodIssues,
  handleShopTool,
  isShopToolName,
  type ShopState,
  type SimEvent,
} from "@open-team/sim-core";
import { z } from "zod";

/** 統制なしの判定の理由コード（GovernanceEntry.reasonCode。Kernel の理由コードと取り違えない名前にする） */
export const MEASURE_REASON_CODE = "measure_ungoverned";

/** HTTP のエラーの文（apps/sim-world の MCP の応答と同じ） */
const HTTP_FAILURE_TEXT: Readonly<Record<429 | 503 | 504, string>> = {
  429: "Too Many Requests",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** notify の結果（アプリ内の通知を保存したことだけを返す。計測では保存しない） */
export const NOTIFY_ACCEPTED_TEXT = "通知を送りました。";

/** 走行の模擬の世界（状態と、sim.events に当たる事象）。書き込み・読み取りでその場で進める */
export interface MeasureWorld {
  state: ShopState;
  readonly events: SimEvent[];
}

/** 計測全体の費用（整数のマイクロドル）。走行をまたいで共有する（A-94 の $5） */
export interface CostMeter {
  readonly capMicroUsd: number;
  spentMicroUsd: number;
  llmCalls: number;
  /** 上限に当たった（それ以降は LLM を呼ばない） */
  stopped: boolean;
  /** 応答したモデル ID */
  readonly models: Set<string>;
  /**
   * いま呼んでいる LLM の呼び出しの見積もりと、費用を足す先（呼んでいないときは null）。LLM のクライアントの中のやり直し
   * （GeminiClient の retry.onRetry → chargeRetriedLlmAttempt）で、失敗した回の費用を数えるのに使う。
   * 計測は LLM を1回ずつ呼ぶ前提（走行も担当も順に走らせる）。同時に呼ぶと取り違える
   */
  inflight: { estMicroUsd: number; charge: (microUsd: number) => void } | null;
}

export function createCostMeter(capUsd: number): CostMeter {
  const capMicroUsd = toMicroUsd(capUsd);
  if (capMicroUsd <= 0) throw new RangeError(`費用の上限は 0 より大きくする：${String(capUsd)}`);
  return { capMicroUsd, spentMicroUsd: 0, llmCalls: 0, stopped: false, models: new Set(), inflight: null };
}

/** LLM のクライアントの中のやり直しの前に、計測全体の上限に当たった（やり直さずに止める） */
class MeasureCapReached extends Error {
  constructor() {
    super("計測全体の費用の上限に当たったため、LLM の呼び出しのやり直しをやめました");
    this.name = "MeasureCapReached";
  }
}

/**
 * LLM のクライアントの中のやり直し（GeminiClient の retry.onRetry に渡す）で、失敗した回の費用を数える（見直しで足した）。
 * 使った量が分からない失敗（status のない LlmError：タイムアウト・ネットワーク・中断）は、その呼び出しの見積もりを費用にする
 * （SO §3.12-6。数え漏れで $5 を超えないように）。HTTP の失敗（429・5xx）は数えない（edge の最後の失敗の数え方と同じ）。
 * 次の回の見積もりが計測全体の上限を超えるなら、やり直さずに止める（A-94）。呼んでいる途中でなければ何もしない
 */
export function chargeRetriedLlmAttempt(meter: CostMeter, error: unknown): void {
  const f = meter.inflight;
  if (f === null) return;
  if (!(error instanceof LlmError) || error.status === null) f.charge(f.estMicroUsd);
  if (meter.spentMicroUsd + f.estMicroUsd > meter.capMicroUsd) {
    meter.stopped = true;
    throw new MeasureCapReached();
  }
}

/** タスクごとの費用の守り（実効ポリシーの budget。decide() の手順2と同じ「超える（>）」で止める） */
export interface MeasureTaskLimits {
  perTaskUsd: number;
  maxSteps: number;
}

export interface SubmittedReport {
  title: string;
  body: string;
  sources: ReportSource[];
  kind?: "answer";
}

/** タスクの記録（本番の tasks の行に当たる。計測の集計とログに使う） */
export interface MeasureTaskRecord {
  readonly taskId: string;
  readonly agentName: string;
  costMicroUsd: number;
  /** LLM を呼んだ回数（FR-013 の steps_used） */
  stepsUsed: number;
  /** 外部の内容（MCP の読み取りの結果・汚染された受け渡し）を受け取ったか（BR-38・BR-71） */
  tainted: boolean;
  report: SubmittedReport | null;
  finished: { outcome: "no_change" | "unable"; reason: string } | null;
  /** 止めた理由（budget_exceeded）。計測全体の上限で止めたときは measureCapReached も true */
  haltReason: string | null;
  measureCapReached: boolean;
  /** LLM の呼び出しの失敗（再試行のあと） */
  llmError: string | null;
  /** 応答したモデル ID */
  models: string[];
  /**
   * 1つの応答で submit_report より後ろにあり、判定も実行もしなかったツール呼び出しの数（この段階の決定 (e)：本番の Proxy も
   * 判定せず Intent にもしない。runner が捨てるのと合わせる。記録だけ）
   */
  ignoredAfterReport: number;
}

export interface MeasureEdgeOptions {
  llm: LlmClient;
  /** Router（phase → モデル ID）。本番の LLM Proxy と同じ modelForPhase を渡す（formation-runtime.md §3.10-4） */
  modelFor: (phase: LlmPhase) => string;
  world: MeasureWorld;
  meter: CostMeter;
  signal?: AbortSignal;
  /** 書き込みの Intent の ID（既定は 'intent-0001' からの連番） */
  newIntentId?: () => string;
}

export interface MeasureEdge extends EdgePort {
  /** タスクを登録してトークンを返す（本番の startMemberTask がタスクの行とトークンを作るのに当たる）。tainted は受け渡しの汚染（BR-71） */
  addTask(ctx: TaskContext, opts: { limits: MeasureTaskLimits; tainted: boolean }): string;
  task(token: string): Readonly<MeasureTaskRecord>;
  /**
   * この走行のツール呼び出し（Kernel が判定に掛けるのと同じ並び：LLM の応答の順。sim-world に届かない呼び出しも入る）。
   * オラクル O-04 の★の数え直し（同じ呼び出しの繰り返し・Intent の数）の材料（見直しで足した）
   */
  toolCalls(): readonly OracleToolCall[];
}

interface ToolCallRecord {
  name: string;
  arguments: unknown;
  /** pending：callTool を待つ ／ intent：書き込みを実行済み（callTool は呼ばれない） ／ done：callTool で実行済み */
  state: "pending" | "intent" | "done";
  /** callTool で返す決まった結果（書き込みの引数の誤りなど） */
  preset?: ToolCallResult;
}

interface TaskEntry {
  ctx: TaskContext;
  limits: MeasureTaskLimits;
  record: MeasureTaskRecord;
  calls: Map<string, ToolCallRecord>;
  /** 報告・finish のあと（トークンは失効：si:135・171） */
  closed: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** mcp_call の引数（{ connector, tool, arguments }）。形が違えば null */
export function parseMcpCall(args: unknown): { connector: string; tool: string; arguments: Record<string, unknown> } | null {
  if (!isRecord(args) || typeof args.connector !== "string" || typeof args.tool !== "string") return null;
  const inner = args.arguments === undefined ? {} : args.arguments;
  if (!isRecord(inner)) return null;
  return { connector: args.connector, tool: args.tool, arguments: inner };
}

/** 引数を入力スキーマ（sim-core の Zod。MCP の inputSchema の元）で確かめる。外れたらエージェントに返す文（M-12：Intent にせずツールのエラー） */
export function invalidArgsText(tool: string, args: unknown): string | null {
  if (!isShopToolName(tool)) return `ツールがありません：${tool}`;
  const parsed = SHOP_TOOL_INPUTS[tool].safeParse(args);
  return parsed.success ? null : `引数が正しくありません：${formatZodIssues(parsed.error, 10).join(" / ")}`;
}

// submit_report の検証（formation-runtime.md §3.12：title 1〜256文字、body 50,000文字まで、sources は配列）。
// 出典の中身の細かい形までは見ない（計測で受け渡しが止まらないように。kind だけ確かめる）
const ReportSourceSchema = z.looseObject({ kind: z.enum(["url", "mcp", "agent"]) });
const SubmitReportArgs = z.object({
  title: z
    .string()
    .refine((s) => s.trim().length > 0 && [...s].length <= 256, { message: "title は1〜256文字" }),
  body: z.string().refine((s) => [...s].length <= 50_000, { message: "body は50,000文字まで" }),
  sources: z.array(ReportSourceSchema),
  kind: z.literal("answer").optional(),
});

function findMcpTool(ctx: TaskContext, connector: string, tool: string): McpToolSpec | undefined {
  return ctx.mcpTools.find((t) => t.connector === connector && t.tool === tool);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 統制なしの EdgePort。走行（模擬の世界）ごとに1つ作り、その走行の担当のタスクを addTask で足す */
export function measureEdge(opts: MeasureEdgeOptions): MeasureEdge {
  const { llm, world, meter } = opts;
  const tasks = new Map<string, TaskEntry>();
  const toolCallLog: OracleToolCall[] = [];
  let intentSeq = 0;
  const newIntentId = opts.newIntentId ?? (() => `intent-${String(++intentSeq).padStart(4, "0")}`);

  const entryOf = (token: string): TaskEntry => {
    const t = tasks.get(token);
    // 知らないトークン・報告や finish のあと（失効：si:135・171）
    if (t === undefined || t.closed) throw new EdgeError("UNAUTHORIZED");
    if (t.record.haltReason !== null) throw new EdgeError("TASK_HALTED", { haltReason: t.record.haltReason });
    return t;
  };

  const halt = (t: TaskEntry, reason: string, details: Record<string, unknown>): never => {
    t.record.haltReason = reason;
    throw new EdgeError("TASK_HALTED", { haltReason: reason, ...details });
  };

  const charge = (t: TaskEntry, micro: number): void => {
    t.record.costMicroUsd += micro;
    meter.spentMicroUsd += micro;
  };

  /** sim-core に1回呼ぶ（その場で状態と事象を進める） */
  const callSim = (t: TaskEntry, connector: string, tool: string, args: unknown, intentId: string | null) => {
    const out = handleShopTool(world.state, { connector, tool, args }, { caller: "sa-gateway", taskId: t.ctx.taskId, intentId, shadow: false });
    world.state = out.state;
    world.events.push(...out.events);
    return out;
  };

  /** 1つのツール呼び出しの判定（すべて allow）。書き込みはここで実行する（本番の LLM Proxy が Intent を作る所：formation-runtime.md §3.10-9） */
  const decideUngoverned = (t: TaskEntry, part: ToolCallPart): GovernanceEntry => {
    const entry: GovernanceEntry = { toolCallId: part.id, decision: "allow", reasonCode: MEASURE_REASON_CODE, matchedRule: null };
    const rec: ToolCallRecord = { name: part.name, arguments: part.arguments, state: "pending" };
    t.calls.set(part.id, rec);
    const call = part.name === "mcp_call" ? parseMcpCall(part.arguments) : null;
    // Kernel の Subject と同じ形（MCP は action と arguments の中身）で、判定に掛ける順に残す（O-04 の★）
    const logged: OracleToolCall = {
      taskId: t.ctx.taskId,
      name: part.name,
      action: call === null ? null : `mcp.${call.connector}.${call.tool}`,
      args: call === null ? part.arguments : call.arguments,
      intent: false,
    };
    toolCallLog.push(logged);
    if (call === null) return entry;
    const spec = findMcpTool(t.ctx, call.connector, call.tool);
    if (spec === undefined || spec.classification === "read") return entry;
    // 書き込み（未分類も書き込みとして扱う）。引数がスキーマに合わなければ Intent にせず、ツールのエラーで返す（M-12）
    const name = `${call.connector}.${call.tool}`;
    const invalid = invalidArgsText(name, call.arguments);
    if (invalid !== null) {
      rec.preset = { kind: "text", text: invalid };
      return entry;
    }
    const intentId = newIntentId();
    logged.intent = true;
    callSim(t, call.connector, call.tool, call.arguments, intentId);
    rec.state = "intent";
    return { ...entry, intent: { intentId, status: "accepted" } };
  };

  /** 読み取り（mcp-taint.md §3.10-8）：結果・isError の本文は外部の内容なので囲んで汚染する。HTTP のエラーは決まった文だけ（汚染しない：D-27） */
  const readTool = (t: TaskEntry, rec: ToolCallRecord): ToolCallResult => {
    const call = parseMcpCall(rec.arguments);
    if (call === null) return { kind: "text", text: toolErrorText("VALIDATION_ERROR") };
    if (findMcpTool(t.ctx, call.connector, call.tool) === undefined) {
      return { kind: "text", text: `ツールがありません：${call.connector}.${call.tool}` };
    }
    const name = `${call.connector}.${call.tool}`;
    const invalid = invalidArgsText(name, call.arguments);
    if (invalid !== null) return { kind: "text", text: invalid };
    const out = callSim(t, call.connector, call.tool, call.arguments, null);
    const source = `mcp:${name}`;
    switch (out.kind) {
      case "ok":
        // sim-world の MCP の content と同じ JSON テキスト（apps/sim-world の okResult）
        t.record.tainted = true;
        return { kind: "text", text: wrapUntrusted(source, JSON.stringify(out.result)) };
      case "tool_error":
        // isError の本文もサーバーの文字列なので汚染する（MT §3.10-8e、F-07 の 429 は「429 Too Many Requests」）
        t.record.tainted = true;
        return { kind: "text", text: wrapUntrusted(source, out.message) };
      case "http_error":
        // F-07 の 503：gateway はエラーとしてエージェントに返す（SW §4.1.4）。文は edge の決まった文だけ
        return { kind: "text", text: toolErrorText(`${out.status} ${HTTP_FAILURE_TEXT[out.status]}`) };
    }
  };

  const submitReport = (t: TaskEntry, rec: ToolCallRecord): ToolCallResult => {
    const parsed = SubmitReportArgs.safeParse(rec.arguments);
    if (!parsed.success) {
      // 400 VALIDATION_ERROR（runner はツールのエラーとして LLM に返して続ける）。同じ呼び出しはもう実行しない
      throw new EdgeError("VALIDATION_ERROR", { issues: parsed.error.issues.map((i) => i.message) });
    }
    const a = parsed.data;
    t.record.report = {
      title: a.title,
      body: a.body,
      sources: a.sources as ReportSource[],
      ...(a.kind !== undefined ? { kind: a.kind } : {}),
    };
    t.closed = true;
    return { kind: "report_accepted", taskId: t.ctx.taskId };
  };

  return {
    addTask(ctx, o) {
      const token = `measure-token-${ctx.taskId}`;
      if (tasks.has(token)) throw new RangeError(`同じタスクを2回登録した：${ctx.taskId}`);
      tasks.set(token, {
        ctx: structuredClone(ctx),
        limits: { ...o.limits },
        calls: new Map(),
        closed: false,
        record: {
          taskId: ctx.taskId,
          agentName: ctx.agent.name,
          costMicroUsd: 0,
          stepsUsed: 0,
          tainted: o.tainted,
          report: null,
          finished: null,
          haltReason: null,
          measureCapReached: false,
          llmError: null,
          models: [],
          ignoredAfterReport: 0,
        },
      });
      return token;
    },

    task(token) {
      const t = tasks.get(token);
      if (t === undefined) throw new RangeError(`知らないトークン：${token}`);
      return t.record;
    },

    toolCalls() {
      return toolCallLog.map((c) => ({ ...c }));
    },

    async getTaskContext(token) {
      return structuredClone(entryOf(token).ctx);
    },

    async llmMessages(token: string, req: LlmMessagesRequest): Promise<LlmMessagesResponse> {
      const t = entryOf(token);
      // tools ⊆ TaskContext.tools（formation-runtime.md §3.10-2）
      const allowed = new Set(t.ctx.tools.map((x) => x.name));
      if (req.tools.some((x) => !allowed.has(x.name))) throw new EdgeError("VALIDATION_ERROR", { reason: "tool_not_in_context" });

      const model = opts.modelFor(req.phase);
      const llmReq: LlmRequest = {
        model,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        mcpTools: t.ctx.mcpTools,
        maxTokens: req.maxTokens,
      };
      // 呼ぶ前の見積もり（BR-10：入力の上限＋出力の上限＋思考の上限。思考の上限は出力の上限と同じにした）
      const est = estimateMicroUsd(model, {
        inputTokens: inputTokensUpperBound(llmReq),
        maxOutputTokens: req.maxTokens,
        thinkingBudget: req.maxTokens,
      });
      // 計測全体の $5（A-94。「使った額 + 見積もり > 上限」で止め、途中までを出す：SW §4.9 手順6）
      if (meter.stopped || meter.spentMicroUsd + est > meter.capMicroUsd) {
        meter.stopped = true;
        t.record.measureCapReached = true;
        halt(t, "budget_exceeded", { scope: "measurement", spentUsd: formatUsd(fromMicroUsd(meter.spentMicroUsd)) });
      }
      // タスクの予算（影の走行と同じく費用と停止は守る：SW §4.5-2。decide() の手順2と同じ順・同じ比べ方）
      if (t.record.stepsUsed + 1 > t.limits.maxSteps) halt(t, "budget_exceeded", { item: "max_steps" });
      if (t.record.costMicroUsd + est > toMicroUsd(t.limits.perTaskUsd)) halt(t, "budget_exceeded", { item: "per_task_usd" });

      let res;
      // クライアントの中のやり直しで失敗した回は chargeRetriedLlmAttempt がこの見積もりで数える
      meter.inflight = { estMicroUsd: est, charge: (micro) => charge(t, micro) };
      try {
        res = await llm.generate(llmReq, opts.signal ? { signal: opts.signal } : {});
      } catch (e) {
        if (e instanceof MeasureCapReached) {
          // やり直しの前に計測全体の上限に当たった（失敗した回は数え済み）
          t.record.measureCapReached = true;
          halt(t, "budget_exceeded", { scope: "measurement", spentUsd: formatUsd(fromMicroUsd(meter.spentMicroUsd)) });
        }
        // 使った量が分からない失敗（中断・タイムアウト・送れたか分からない）は見積もりを費用に数える（SO §3.12-6）
        if (!(e instanceof LlmError) || e.status === null) charge(t, est);
        t.record.llmError = errorMessage(e);
        throw new EdgeError("LLM_UPSTREAM_ERROR", { message: t.record.llmError });
      } finally {
        meter.inflight = null;
      }
      charge(t, res.usage.costMicroUsd);
      t.record.stepsUsed += 1;
      meter.llmCalls += 1;
      meter.models.add(res.model);
      if (!t.record.models.includes(res.model)) t.record.models.push(res.model);

      // 応答のツール呼び出しを順に（すべて allow。書き込みはここで実行）。最初の submit_report より後ろの呼び出しは判定せず、
      // Intent にもしない（決定 (e)：runner は報告が通ったら後ろを捨てる：FR §8-36。本番の Proxy と同じにし、数だけ記録する。
      // O-04 の数え直しの並びにも入れない＝Kernel が判定に掛けない）。報告が通らなかったときも、後ろは判定がない（runner は実行しない）
      const calls = res.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
      const reportAt = calls.findIndex((p) => p.name === "submit_report");
      const judged = reportAt === -1 ? calls : calls.slice(0, reportAt + 1);
      t.record.ignoredAfterReport += calls.length - judged.length;
      const governance = judged.map((p) => decideUngoverned(t, p));
      return {
        model: res.model,
        content: res.parts,
        stopReason: res.stopReason,
        usage: {
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens + res.usage.thinkingTokens,
          costUsd: formatUsd(fromMicroUsd(res.usage.costMicroUsd)),
        },
        governance,
        budget: { costUsd: formatUsd(fromMicroUsd(t.record.costMicroUsd)), stepsUsed: t.record.stepsUsed },
      };
    },

    async postEvents(token: string, events: ProgressEvent[]) {
      const t = entryOf(token);
      for (const e of events) {
        // finish（タスクは failed(agent_no_change / agent_unable)、トークンは失効：si:135）
        if (e.type === "finished") {
          t.record.finished = { ...e.payload };
          t.closed = true;
        }
      }
      return { accepted: events.length, dropped: 0 };
    },

    async callTool(token: string, toolCallId: string): Promise<ToolCallResult> {
      const t = entryOf(token);
      const rec = t.calls.get(toolCallId);
      // 判定の記録がない・書き込み（実行済み）・実行済み → 403（formation-runtime.md §3.11-2）
      if (rec === undefined || rec.state !== "pending") throw new EdgeError("TOOL_CALL_NOT_ALLOWED");
      rec.state = "done";
      if (rec.preset !== undefined) return rec.preset;
      switch (rec.name) {
        case "mcp_call":
          return readTool(t, rec);
        case "submit_report":
          return submitReport(t, rec);
        case "notify":
          return { kind: "text", text: NOTIFY_ACCEPTED_TEXT };
        default:
          // 付与・テンプレートにないツール。統制なしでも、この担当には実行できるものがない
          return { kind: "text", text: `ツールがありません：${rec.name}` };
      }
    },
  };
}
