// Kernel の入出力の型（パッケージをまたぐ契約。変えるときは使っている側をすべて直す）
// 出典：scratchpad の spec/cross-check.md §4.1（M-01〜M-20 の結論）、kernel-decide.md §2、kernel-compose-classify.md §2.6
// apps は Node の型の除去で動くので、enum・引数プロパティ・namespace は使わない（erasableSyntaxOnly）

export const KERNEL_VERSION = "0.1.0";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

/** 小文字16進64桁（policyHash・intentHash・inputsHash・destinationKey・repeatKey・optionDigest・caseSetHash・certificateHash） */
export type Hex64 = string;
/** tool_hash だけ接頭辞つき（M-07） */
export type ToolHash = `sha256:${string}`;
export type Uuid = string;
/** ISO 8601（タイムゾーンつき） */
export type IsoDateTime = string;

/** 'name' か 'name[].field'（1段だけ。A-84・15 の items[].sku） */
export type ArgPath = string;
export type ArgRole = "destination" | "content" | "option";
export type ArgRoleMap = Readonly<Record<ArgPath, ArgRole>>;
export type ToolClassification = "read" | "write" | "unclassified";
export type ToolStatus = "ok" | "needs_review";
export type ToolScope = "self" | null;

export const OPERATION_TYPES = [
  "read",
  "edit_code",
  "run_tests",
  // 作業場の任意のコマンド（SG-07）。決まった形のテストのコマンド以外と、外の内容を読んだあとの run_command はこれで判定する
  "run_shell",
  "shell_network",
  "open_pr",
  "merge",
  "memory_write",
  "web_read",
  "mcp_read",
  "mcp_write",
  "notify",
  "payment",
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];
export type AutonomyLevel = "auto" | "approve" | "handoff" | "deny";

/** LLM が呼べるツールの名前（操作カタログのツール）。0-H で LLM に渡すのは mcp_call・notify・submit_report・finish と web_*（Should）・team_*（Should） */
export const CATALOG_TOOLS = [
  "mcp_call",
  "web_search",
  "web_fetch",
  "notify",
  "submit_report",
  "finish",
  "team_post",
  "team_wait",
  "ask_user",
  "remember",
  "load_skill",
  "list_files",
  "read_file",
  "search",
  "write_file",
  "apply_patch",
  "delete_file",
  "run_command",
  "submit_intent",
] as const;
export type CatalogToolName = (typeof CATALOG_TOOLS)[number];

export type TaskStatus =
  | "queued"
  | "provisioning"
  | "running"
  | "awaiting_approval"
  | "executing"
  | "succeeded"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled"
  | "halted";

/** decide() の手順4・5・11 が読む、判定の時点のツールの情報（M-02） */
export interface ToolInfo {
  classification: ToolClassification;
  status: ToolStatus;
  connectorEnabled: boolean;
  /** effectiveArgRoles(inputSchema, 確定の役割) の結果。未確定は destination（BR-56） */
  argRoles: ArgRoleMap;
  scope: ToolScope;
  toolHash: ToolHash;
}

/**
 * 「以後も許可」のルール（エージェント定義の rules[]。M-03）。
 * 出どころの記録（SG-09）：id（作るときに決め、以後変えない）・added_by（created_by：決めた利用者）・added_at（created_at）・
 * source_intent_id（created_from_intent）・created_while_tainted。記録の項目は実効ポリシーに入らず、照合・ガード・classify に効かない。
 * 記録のないルール（SG-09 より前に作ったもの）もそのまま読める
 */
export interface Rule {
  /** 作るときに決める安定した id（判定の記録 policy_decisions.matched_rule_id でも指す） */
  id: string;
  /** 'mcp.<connector>.<tool>' */
  action: string;
  /** すべての destination と固定の option。欠けは null（M-10）。配列は並べ替えるが重複は残す（M-09） */
  match: Readonly<Record<ArgPath, Json>>;
  /** 毎回変わってよい option（D-60）。既定 [] */
  free: readonly ArgPath[];
  labels?: Readonly<Record<ArgPath, string>>;
  tool_hash: ToolHash;
  /** 作った利用者の id（SG-09 の created_by） */
  added_by: string;
  /** 作った時刻（SG-09 の created_at） */
  added_at: IsoDateTime;
  /** 作るもとにした Intent（SG-09 の created_from_intent） */
  source_intent_id?: Uuid;
  /** 外部の内容を読んだ後（汚染されたタスク）の Intent から作ったか（SG-09）。ない＝記録より前のルール（不明） */
  created_while_tainted?: boolean;
}
export type EffectiveRule = Pick<Rule, "id" | "action" | "match" | "free" | "tool_hash">;

/** ガード（BR-61・D-57）。数値の範囲（min・max・max_digits）か文字列の候補（in） */
export interface Guard {
  action: string;
  arg: ArgPath;
  min?: number;
  max?: number;
  max_digits?: number;
  in?: readonly string[];
}
/** 合成後のガード（M-13）。empty は「範囲・候補の積が空」＝どの値も外れ */
export interface MergedGuard extends Guard {
  empty: boolean;
}

/** compose() の出力（仕事ごと。D-19・M-01）。decide() の policy には常にこれを渡す */
export interface EffectivePolicy {
  version: 1;
  autonomy: Readonly<Record<OperationType, AutonomyLevel>>;
  budget: {
    per_task_usd: number;
    per_day_usd: number;
    agent_day_usd: number | null;
    max_steps: number;
    max_minutes: number;
  };
  breakers: { same_action_repeat: number; denied_attempts_max: number; step_cost_usd_max: number };
  max_intents_per_task: number;
  max_runs_per_day: number;
  /** この仕事で LLM に渡すツール（テンプレート ∩ 付与） */
  tools: readonly CatalogToolName[];
  mcp: {
    /** LLM が MCP の読み取りを呼べるか */
    llmRead: boolean;
    /** LLM が MCP の書き込みを呼べるか（kind: 'tool_call'） */
    llmWrite: boolean;
    /** 届け先（deliver）が書き込めるか（kind: 'intent'） */
    deliverWrite: boolean;
    /** connector slug → 付与したツール名 */
    grants: Readonly<Record<string, readonly string[]>>;
  };
  web: { allow_domains: readonly string[]; deny_domains: readonly string[]; max_fetches_per_task: number };
  rules: { enabled: boolean; items: readonly EffectiveRule[] };
  guards: readonly MergedGuard[];
  approvers: readonly string[];
}

/** 判定の対象（M-14・M-15）。エージェントの mcp_call は書き込みも tool_call として1回だけ判定する。deliver だけ intent */
export interface Subject {
  kind: "tool_call" | "llm_call" | "intent";
  /** カタログのツール名。llm_call は null */
  actionType: CatalogToolName | "open_pr" | null;
  /** MCP は 'mcp.<connector>.<tool>' */
  action?: string;
  /** llm_call は {} */
  args: JsonObject;
  /** 0-H は [] */
  paths: readonly string[];
  /** llm_call だけ */
  estimatedCostUsd?: number;
  /** actionType = 'mcp_call' のとき必須 */
  tool?: ToolInfo;
  /** 記録用。判定に使わない */
  origin?: "agent" | "deliver";
  /**
   * run_command の写し先（SG-07）。edge が判定の入力を作るときに operationOfCommand(command, 汚染) で決める。
   * 汚染は decide に入れず、ここ（どの操作として判定するか）でだけ使う（BR-39）。
   * run_command 以外では使わない。欠けても、形が許可リストにないコマンドは Kernel が run_shell にする（厳しい側だけに効く）
   */
  commandOperation?: "run_tests" | "run_shell";
}

/** 判定の入力のカウンタ（edge の loadDecideInputs が作る。G-01）。全体 $10・リハーサル $0.5 は持たない（M-19） */
export interface Counters {
  stepsUsed: number;
  costUsd: number;
  dayCostUsd: number;
  agentDayCostUsd: number;
  elapsedSec: number;
  deniedCount: number;
  repeatKey: Hex64 | null;
  repeatCount: number;
  intentsCount: number;
  /** 同じ仕事で unknown_outcome のまま確定していない Intent の destinationKey（BR-68） */
  unknownOutcomeKeys: readonly Hex64[];
}

export interface Flags {
  killSwitchEngaged: boolean;
  taskStatus: TaskStatus;
  /** 合格証が有効か（BR-81）。リハーサル・影の走行・FR-065・回帰の試験・FR-069 の再判定では true を渡す */
  certificateValid: boolean;
}

/** 汚染の出どころ（M-06。mcp-taint・db と同じ形） */
export type DirectTaintSource =
  | { kind: "mcp_read"; connectorId: string; connectorSlug: string; connectorName: string; tool: string; at: IsoDateTime }
  | { kind: "web_search"; at: IsoDateTime }
  | { kind: "web_fetch"; url: string; at: IsoDateTime }
  /** 作業場（サンドボックス）でコマンドを動かした出力（入れたパッケージ・書いたコードの出力は外から来た内容と同じに扱う） */
  | { kind: "sandbox_run"; at: IsoDateTime }
  /**
   * load_skill で読んだスキルの本文が、運営のパックの本文または人が承認した中身と一致しなかった（カタログにない・書き換えられた：SG-05）。
   * name・packId は DB の値（信用できないので表示の文には入れない）
   */
  | { kind: "skill"; name: string; packId: string | null; at: IsoDateTime };
export type TaintSource =
  | DirectTaintSource
  | { kind: "handoff"; fromTaskId: Uuid; fromAgentName: string; upstream: DirectTaintSource[]; at: IsoDateTime }
  /**
   * 汚染されたタスクが残した作業場の控え（ファイル）を受け取った（SG-05）。upstream は控えを残したタスクの汚染を平らにしたもの。
   * 控えは同じ担当のものなので、担当の名前は持たない
   */
  | { kind: "workspace_snapshot"; snapshotId: Uuid; fromTaskId: Uuid; upstream: DirectTaintSource[]; at: IsoDateTime }
  | {
      kind: "team_message";
      messageId: Uuid;
      fromTaskId: Uuid;
      fromAgentName: string;
      upstream: DirectTaintSource[];
      at: IsoDateTime;
    };
export interface TaintState {
  tainted: boolean;
  sources: readonly TaintSource[];
}
export const EMPTY_TAINT: TaintState = { tainted: false, sources: [] };

export type Decision = "allow" | "deny" | "approve" | "handoff" | "halt";
export type ReasonCode =
  | "kill_switch"
  | "task_terminated"
  | "budget_exceeded"
  | "breaker_tripped"
  | "unknown_action"
  | "not_granted"
  | "tool_needs_review"
  | "connector_disabled"
  | "intent_limit"
  | "path_denied"
  | "path_not_allowed"
  | "autonomy_deny"
  | "approval_required"
  | "unknown_outcome_pending"
  | "guard_exceeded"
  | "certificate_missing"
  | "autonomy_auto"
  | "rule_matched"
  | "not_gated"
  | "autonomy_handoff";

export type DecisionDetail =
  | {
      kind: "budget";
      item: "max_steps" | "per_task_usd" | "per_day_usd" | "agent_day_usd" | "max_minutes";
      used: number;
      adding: number;
      limit: number;
    }
  | {
      kind: "breaker";
      breaker: "same_action_repeat" | "denied_attempts_max" | "step_cost_usd_max";
      value: number;
      threshold: number;
    }
  | { kind: "not_granted"; what: "tools" | "grants" | "llm_write" | "deliver_write" }
  | { kind: "intent_limit"; count: number; limit: number }
  | { kind: "unknown_outcome"; destinationKey: Hex64 }
  /** argPath は添字つき（'items[1].quantity'） */
  | { kind: "guard"; argPath: string; value: Json | null; found: boolean; guard: MergedGuard }
  | { kind: "rule_mismatch"; ruleIndex: number; argPath: string; role: "destination" | "option" | "unknown" };

export interface DecideResult {
  decision: Decision;
  reasonCode: ReasonCode;
  /** ポリシー上のキーのパス（例 'guards[0]'・'rules.items[2]'・'autonomy.mcp_write'。cross-check §4.2） */
  matchedRule: string | null;
  /** 手順11でルールに一致したとき（rule_matched・certificate_missing）だけ、そのルールの id（SG-09。添字は定義の変更でずれるので id でも指す） */
  matchedRuleId?: string;
  inputsHash: Hex64;
  operation: OperationType | null;
  detail?: DecisionDetail;
}
