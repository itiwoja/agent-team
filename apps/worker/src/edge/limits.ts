// edge の上限と既定値（packages/edge/src/limits.ts の WorkspaceDO 版。formation-runtime.md §2.1 の TOOL_LIMITS・LLM_LIMITS・EVENT_LIMITS）
// 試験では createTaskEdgeRuntime の limits で差し替える（既定はここの値）。
// 費用の上限（SPEND_LIMITS）・1日の区切り（BUDGET_TIME_ZONE）は spend.ts にある。
// Node 版との違い：tokenTtlExtraMinutes（トークンの期限）は持たない（Workflow はトークンの代わりに taskId を使う）

/** LLM Proxy・進捗・ツールの上限 */
export const EDGE_LIMITS = {
  /** 1タスクの LLM の呼び出し（si:106。超えたら 429 RATE_LIMITED） */
  llmCallsPerMinute: 60,
  /** 1タスクの進捗（rt:152。超えた分は捨てて dropped に数える。finished は数えない） */
  eventsPerSecond: 10,
  /** 1回の postEvents（si:133「最大20件」。超えた分は dropped：HL-24 の案） */
  eventsPerRequest: 20,
  /** system と messages の合計（si:102。JSON の UTF-8 のバイト数） */
  messagesMaxBytes: 1024 * 1024,
  maxTokensMin: 1,
  maxTokensMax: 16_000,
  /**
   * TaskContext.limits.maxTokens の既定（エージェントの1ステップ）。formation-runtime.md §8-7 の案 8,000 から 4,096 に下げた（D-106）。
   * 実測の出力＋思考は1回 約1,000。費用の見積もり（BR-10）は思考の上限も maxTokens で数えるので、8,000 では1回 約 $0.15 と
   * 実費（約 $0.01）の十倍以上になり、仕事の予算（per_task_usd 0.2）が実費 約 $0.05 で打ち切られていた
   */
  maxTokensDefault: 4_096,
  /** MCP の引数（IA §3.5-2 の推奨 64KB） */
  mcpArgsMaxBytes: 64 * 1024,
  /** MCP の読み取りの結果（A-86。gateway も 64KB で切る。edge でも切る） */
  mcpResultMaxBytes: 64 * 1024,
  /** submit_report（ab:194、cat:82） */
  reportTitleMax: 256,
  reportBodyMax: 50_000,
  /** notify（cat:86） */
  notifyTitleMax: 60,
  notifyBodyMax: 500,
  /** 進捗の message の本文を保存するときの上限（文字。プロンプト・応答の全文は保存しない：A-15・§8-32） */
  eventTextMaxChars: 2_000,
  /** tool_called の resultSummary（si:136） */
  resultSummaryMaxChars: 500,
  /** finished の理由・フェーズの名前を保存するときの上限（文字） */
  finishReasonMaxChars: 500,
  phaseNameMaxChars: 100,
  /** toolCallId の長さ（AS の toolCallId：1〜200） */
  toolCallIdMaxChars: 200,
  /** team_wait が返事を見に行く間隔（ミリ秒。FR-064。待ち時間の上限は kernel の TEAM_LIMITS.waitMaxSec） */
  teamWaitPollMs: 1_000,
  /** ask_user が利用者の答えを待つ時間（秒）。連絡板の待ち（A-104）と同じ5分。答えを見に行く間隔は teamWaitPollMs */
  askUserWaitSec: 300,
  /** ask_user を1つのタスクで出せる回数（聞きすぎて仕事が進まないのを防ぐ） */
  askUserPerTask: 2,
} as const;

export type EdgeLimits = { -readonly [K in keyof typeof EDGE_LIMITS]: number };
