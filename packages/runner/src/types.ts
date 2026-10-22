// runner と edge の境界（formation-runtime.md §2.5・2.6 を正とし、会話の形を具体にしたもの）
// runner は型と自分の実装だけを持ち、DB・Gemini・gateway のクライアントを import しない（D-52）。
// edge の実装は app（本番）か scripts/measure（計測の統制なし）が渡す。

import type { Decision, IsoDateTime, Uuid } from "@open-team/kernel";

/** LLM が呼ぶツール（catalogs.md。開発系はフェーズ1で Won't） */
export type ToolName =
  | "mcp_call"
  | "web_search"
  | "web_fetch"
  | "notify"
  | "submit_report"
  | "finish"
  | "remember"
  | "load_skill"
  | "team_post"
  | "team_wait"
  | "ask_user"
  // 作業場（サンドボックス）の道具（D-116）。edge が判定してから作業場に積む
  | "list_files"
  | "read_file"
  | "search"
  | "write_file"
  | "delete_file"
  | "run_command";

export type TemplateId = "researcher" | "briefer" | "watcher" | "assistant" | "dev-coder" | "reviewer";
/** LLM の呼び出しの段階（usage_records.phase。Router がモデルを選ぶ） */
export type LlmPhase = "investigate" | "plan" | "implement" | "review" | "report";
export type TaskRunKind = "live" | "dry_run";
export type Shape = "single" | "parallel" | "aggregate" | "chain";
export type TeamMessageKind = "share" | "question" | "reply" | "revise_request";
/** '0.012345' の形（小数6桁の文字列。09_api の金額） */
export type UsdString = string;

/** 出典（BR-45） */
export type ReportSource =
  | { kind: "url"; url: string; title?: string }
  | { kind: "mcp"; connector: string; tool: string; label?: string }
  | { kind: "agent"; agentName: string };

export interface ToolArgs {
  mcp_call: { connector: string; tool: string; arguments: Record<string, unknown> };
  web_search: { query: string; max_results: number; recency?: string };
  web_fetch: { url: string };
  notify: { title: string; body: string; priority: string };
  submit_report: { title: string; body: string; sources: ReportSource[]; kind?: "answer"; summary?: string; next_actions?: string[]; changed?: boolean };
  finish: { outcome: "no_change" | "unable"; reason: string };
  remember: { content: string };
  load_skill: { name: string };
  team_post: { to: string; kind: TeamMessageKind; body: string; in_reply_to?: Uuid };
  team_wait: { message_id: Uuid; timeout: number };
  ask_user: { question: string; choices?: string[]; allow_free_text?: boolean };
  list_files: { path?: string };
  read_file: { path: string };
  search: { pattern: string; path?: string };
  write_file: { path: string; content: string; executable?: boolean };
  delete_file: { path: string };
  run_command: { command: string; timeout_sec?: number };
}

/** LLM に渡すツールの宣言（JSON Schema） */
export interface ToolSpec {
  name: ToolName;
  description: string;
  inputSchema: unknown;
}

/** mcp_call で呼べる MCP のツール（付与されたものだけ）。LLM には edge がツールごとの関数に展開して見せる */
export interface McpToolSpec {
  connector: string;
  tool: string;
  classification: "read" | "write" | "unclassified";
  description: string;
  inputSchema: unknown;
}

// ---- 会話（runner が持ち、edge がそのまま LLM に渡す） ----

export interface TextPart {
  type: "text";
  text: string;
  /** モデルが返した不透明な署名（Gemini の thought signature）。次の呼び出しでそのまま返す */
  signature?: string;
}
export interface ToolCallPart {
  type: "tool_call";
  /** edge が振る ID（モデルの ID がなければ edge が作る）。governance・callTool の鍵 */
  id: string;
  /** ToolName のどれか。モデルが知らない名前を返したらそのまま入れ、edge が unknown_action で拒否する（BR-09） */
  name: string;
  /** mcp_call は ToolArgs['mcp_call'] の形に戻したもの */
  arguments: unknown;
  signature?: string;
}
export type AssistantPart = TextPart | ToolCallPart;

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AssistantPart[] }
  | { role: "tool"; content: { toolCallId: string; name: string; result: string } };

// ---- タスクの文脈（API-036 相当） ----

export interface TaskContext {
  taskId: Uuid;
  runKind: TaskRunKind;
  /** runner は分岐に使わない（経路を変えない。ADR-015） */
  isDryRun: boolean;
  template: TemplateId;
  phases: Array<{ name: string; llmPhase: LlmPhase; systemPrompt: string }>;
  tools: ToolSpec[];
  /** mcp_call で呼べるツール（付与されたもの）。プロンプトの説明と、edge の展開に使う */
  mcpTools: McpToolSpec[];
  /** 固定の文テンプレートで作った実効ポリシーの要約 */
  policySummary: string[];
  /** 実効ポリシー（参考。強制はサーバー側。ADR-003） */
  policy: unknown;
  agent: {
    name: string;
    /** 利用者が書いたデータとして区切る */
    jobInstructions: string;
    tuning: string | null;
    /** 担当のスキル（名前と説明。中身は load_skill で読む）。パックで入る（D-116） */
    skills: Array<{ name: string; description: string }>;
    memories: [];
  };
  input: {
    /** 依頼の本文など（≤2,000） */
    prompt: string | null;
    /** 順番の前の段の報告（BR-71） */
    handoffs: Array<{ fromAgentName: string; fromTaskId: Uuid; tainted: boolean; body: string }>;
    /** 定期の実行（見張り）で、この担当が前の回に出した報告。at はその報告を出した時刻 */
    previousReport?: { at: IsoDateTime; tainted: boolean; body: string };
    teamMessages: Array<{ messageId: Uuid; fromAgentName: string; kind: TeamMessageKind; tainted: boolean; body: string }>;
    followupQuestion?: { messageId: Uuid; fromAgentName: string; body: string; originalReport: string };
    reviseReason?: string;
  };
  formation: null | {
    askId: Uuid;
    shape: Shape;
    position: number;
    stageCount: number;
    isSpokesperson: boolean;
    isAggregator: boolean;
    /** dependsOn は順番のときだけ：結果を受け取る段の position（ないときは1つ前の段） */
    members: Array<{ name: string; position: number; isAggregator: boolean; dependsOn?: number[] }>;
  };
  /** 今の時刻（JST）。プロンプトに「今」として出す */
  now: IsoDateTime;
  limits: { maxTokens: number };
}

export interface LlmMessagesRequest {
  phase: LlmPhase;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface GovernanceEntry {
  toolCallId: string;
  decision: Decision;
  reasonCode: string;
  matchedRule?: string | null;
  /** MCP の書き込みだけ（結果は待たない。A-87） */
  intent?: { intentId: Uuid; status: "pending_approval" | "accepted" | "denied" };
  /** 実行しなかった呼び出しの拒否の文に添える説明（edge の固定の文。SG-07：作業場で動かせないコマンド） */
  note?: string;
}

export interface LlmMessagesResponse {
  model: string;
  content: AssistantPart[];
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: UsdString };
  governance: GovernanceEntry[];
  budget: { costUsd: UsdString; stepsUsed: number };
}

export type ProgressEvent =
  | { type: "phase_started"; payload: { phase: string } }
  | { type: "tool_called"; payload: { toolCallId: string; name: string; resultSummary: string } }
  | { type: "message"; payload: { text: string } }
  | { type: "finished"; payload: { outcome: "no_change" | "unable"; reason: string } };

export type ToolCallResult =
  /** 外部の内容は wrapUntrusted 済み */
  | { kind: "text"; text: string }
  | { kind: "intent"; intentId: Uuid; status: "pending_approval" | "accepted" | "denied" }
  | { kind: "report_accepted"; taskId: Uuid }
  | { kind: "denied"; reasonCode: string }
  | { kind: "halted"; reasonCode: string };

export type EdgeErrorCode =
  | "UNAUTHORIZED"
  | "TASK_HALTED"
  | "RATE_LIMITED"
  | "LLM_UPSTREAM_ERROR"
  | "VALIDATION_ERROR"
  | "REPORT_ALREADY_SUBMITTED"
  | "TOOL_CALL_NOT_ALLOWED";

export class EdgeError extends Error {
  readonly code: EdgeErrorCode;
  readonly details: unknown;
  /** RATE_LIMITED のときの待ち時間（秒） */
  readonly retryAfterSec: number | null;
  constructor(code: EdgeErrorCode, details?: unknown, retryAfterSec: number | null = null) {
    super(code);
    this.name = "EdgeError";
    this.code = code;
    this.details = details;
    this.retryAfterSec = retryAfterSec;
  }
}

/** runner の唯一の出口（API-036〜038・056 を関数にしたもの） */
export interface EdgePort {
  /** 最初の呼び出しでタスクを running にする */
  getTaskContext(token: string): Promise<TaskContext>;
  llmMessages(token: string, req: LlmMessagesRequest): Promise<LlmMessagesResponse>;
  /** 1回20件まで。ハートビートを兼ねる */
  postEvents(token: string, events: ProgressEvent[]): Promise<{ accepted: number; dropped: number }>;
  /** allow と判定されたツール呼び出しの実行。引数は渡さない（edge が判定のときに記録したものを使う） */
  callTool(token: string, toolCallId: string): Promise<ToolCallResult>;
}
