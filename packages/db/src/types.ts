// 全部の表の行の型（db-schema.md §3.1 を cross-check の結論で直したもの。DDL は migrations/0001〜0004）
// 列名は snake_case のまま。値は client.ts の変換のあとの形：timestamptz → Date、numeric → 文字列、int8 → number、
// bytea → Buffer、jsonb → 値。中身の形を他の担当が決める jsonb（状況・損害・要約など）は JsonObject / Json にしてある

import type {
  ArgRoleMap,
  Decision,
  DecisionDetail,
  EffectivePolicy,
  Hex64,
  Json,
  JsonObject,
  TaintSource,
  TaintState,
  TaskStatus,
  ToolClassification,
  ToolHash,
  ToolScope,
  ToolStatus,
  Uuid,
} from "@open-team/kernel";

export type { ArgRoleMap, Hex64, Json, JsonObject, ToolClassification, ToolHash, ToolScope, ToolStatus, Uuid };

/** numeric(12,6) の USD。小数6桁の文字列（'0.120000'）。足し算は整数のマイクロドルで（DB §2） */
export type UsdDecimal = string;
/** bigint の円（2^53 未満） */
export type Jpy = number;

// ===== 列挙（DDL の CHECK と同じ順） =====
/** ワークスペースはオーナーの1つだけ（ゲストは 0024 で廃止） */
export const WORKSPACE_KINDS = ["owner"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const WORKSPACE_STATUSES = ["active", "suspended"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
export const MEMBER_ROLES = ["owner", "maintainer", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
/** 入口の試行の結果。guest_created・guest_reset・capacity・ip_limit は過去の行の値（ゲストは 0024 で廃止。新しくは書かない） */
export const ENTRY_OUTCOMES = ["owner", "guest_created", "guest_reset", "wrong_token", "capacity", "ip_limit"] as const;
export type EntryOutcome = (typeof ENTRY_OUTCOMES)[number];
export const ACTOR_TYPES = ["user", "system", "agent"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const CONNECTOR_KINDS = ["mcp_remote"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export type ConnectorAuth =
  | { type: "none" }
  /** 0-H は Won't（BR-66） */
  | { type: "api_key"; ciphertext: string }
  /** Google・GitHub のときは資格情報（connector_credentials）を見る。秘密はこの値に入れない（ADR-040・18 §3.3） */
  | { type: "oauth"; provider: OAuthProvider };
export const TOOL_VERIFY_MODES = ["none", "readback"] as const;
export type ToolVerifyMode = (typeof TOOL_VERIFY_MODES)[number];

export const AGENT_STATUSES = ["idle", "active", "invalid", "disabled", "removed"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const AGENT_ROLES = ["research", "watch", "brief", "assist", "dev"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const JOB_KINDS = ["once", "recurring", "watch"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const JOB_TEMPLATES = ["researcher", "briefer", "watcher", "assistant", "dev-coder", "reviewer"] as const;
export type JobTemplate = (typeof JOB_TEMPLATES)[number];
export const JOB_STATUSES = ["waiting_input", "active", "paused", "done"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const CHANGE_ORIGINS = [
  "user_request",
  "feedback",
  "failure",
  "engagement",
  "manual",
  "revert",
  "move",
  "approval_rule",
  "ask",
  /** 過去の行だけ（0023 でリハーサルをやめた） */
  "rehearsal_tighten",
  "prune",
] as const;
export type ChangeOrigin = (typeof CHANGE_ORIGINS)[number];
export const CLASSIFICATIONS = ["narrow", "neutral", "widen"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const CHANGE_STATUSES = ["proposed", "applied", "rejected", "reverted"] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];
export const MESSAGE_AUTHORS = ["user", "agent", "system"] as const;
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number];
export const MESSAGE_KINDS = ["text", "question", "connect", "confirm", "approval", "result", "change", "delegate"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const ASK_SHAPES = ["single", "parallel", "aggregate", "chain"] as const;
export type AskShape = (typeof ASK_SHAPES)[number];
export const ASK_STATUSES = ["generating", "running", "waiting_input", "done", "failed", "cancelled"] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];
export const ASK_FAILURE_REASONS = ["formation_invalid", "timeout", "budget_exceeded", "kill_switch", "agent_limit", "planner_error"] as const;
export type AskFailureReason = (typeof ASK_FAILURE_REASONS)[number];
/** M-33：initial を足した */
export const ASK_RUN_TRIGGERS = ["initial", "manual", "schedule", "resume"] as const;
export type AskRunTrigger = (typeof ASK_RUN_TRIGGERS)[number];
export const ASK_RUN_STATUSES = ["running", "waiting_input", "done", "failed", "cancelled"] as const;
export type AskRunStatus = (typeof ASK_RUN_STATUSES)[number];
export const TEAM_MESSAGE_KINDS = ["share", "question", "reply", "revise"] as const;
export type TeamMessageKind = (typeof TEAM_MESSAGE_KINDS)[number];

export const TASK_KINDS = ["normal", "followup", "revise"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
/** M-32：依頼から動くタスクは 'ask'、試し実行は 'dry_run' */
export const TRIGGER_TYPES = ["manual", "schedule", "dry_run", "ask"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export const TASK_STATUSES = [
  "queued",
  "provisioning",
  "running",
  "awaiting_approval",
  "executing",
  "succeeded",
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "halted",
] as const satisfies readonly TaskStatus[];
export type { TaskStatus };
export const TASK_TERMINAL = ["succeeded", "completed", "rejected", "failed", "cancelled", "halted"] as const satisfies readonly TaskStatus[];
/** 同時実行数に数える状態（BR-08） */
export const TASK_ACTIVE_FOR_CONCURRENCY = ["provisioning", "running"] as const satisfies readonly TaskStatus[];
export const HALT_REASONS = [
  "budget_exceeded",
  "breaker_tripped",
  "timeout",
  "kill_switch",
  "policy_violation",
  "approval_expired",
  "agent_disabled",
] as const;
export type HaltReason = (typeof HALT_REASONS)[number];
/** M-32：sandbox_lost（status.md:53） */
export const TASK_FAIL_REASONS = [
  "sandbox_lost",
  "llm_unavailable",
  "precondition_failed",
  "agent_no_change",
  "agent_unable",
  "action_failed",
] as const;
export type TaskFailReason = (typeof TASK_FAIL_REASONS)[number];
export const REPORT_KINDS = ["normal", "answer"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const TASK_EVENT_TYPES = ["phase_started", "tool_called", "llm_called", "status_changed", "budget_updated", "message", "finished"] as const;
export type TaskEventType = (typeof TASK_EVENT_TYPES)[number];

export const INTENT_STATUSES = [
  "proposed",
  "simulated",
  "denied",
  "pending_approval",
  "approved",
  "rejected",
  "expired",
  "executing",
  "executed",
  "verified",
  "failed",
  "unknown_outcome",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];
export type { Decision };
export const INTENT_FAIL_REASONS = ["tool_error", "unreachable", "auth_required", "precondition_failed", "confirmed_not_delivered"] as const;
export type IntentFailReason = (typeof INTENT_FAIL_REASONS)[number];
/** M-20：policy_changed を足した */
export const INTENT_EXPIRE_REASONS = [
  "approval_timeout",
  "superseded",
  "tool_changed",
  "task_cancelled",
  "kill_switch",
  "task_ended",
  /** リハーサルの終わり（0023 でリハーサルをやめた。過去の行だけ） */
  "rehearsal_end",
  "policy_changed",
] as const;
export type IntentExpireReason = (typeof INTENT_EXPIRE_REASONS)[number];
export const INTENT_RESOLUTIONS = ["confirmed_delivered", "confirmed_not_delivered", "retried"] as const;
export type IntentResolution = (typeof INTENT_RESOLUTIONS)[number];
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const SUBJECT_KINDS = ["tool_call", "llm_call", "intent"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
/** usage_records.provider。Gemini API は google（llm の gemini）。openai は過去の行の CHECK 用に残す（0021） */
export const LLM_PROVIDERS = ["google", "anthropic", "deepseek", "openrouter"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
/** runner・FR の LlmPhase（M-32）＋設定プランナー。rehearsal_* は過去の行だけ（0023 でリハーサルをやめた） */
export const USAGE_PHASES = [
  "plan",
  "investigate",
  "implement",
  "test",
  "summarize",
  "review",
  "report",
  "planner",
  "rehearsal_generate",
  "rehearsal_interpret",
  "rehearsal_tighten",
] as const;
export type UsagePhase = (typeof USAGE_PHASES)[number];

// ===== jsonb の中身（形が決まっているもの） =====
/** workspace_policies.policy（pas:43-65、mcp-and-web.md:125） */
export interface WorkspacePolicy {
  version: 1;
  autonomy: {
    web_read: "auto" | "approve" | "deny";
    notify: "auto" | "deny";
    mcp_read: "auto" | "deny";
    mcp_write: "approve" | "deny";
    open_pr?: "approve" | "deny";
  };
  budget: { per_task_usd: number; per_day_usd: number; max_steps: number; max_minutes: number };
  web: { deny_domains: string[]; max_fetches_per_task: number };
  /** connectors.slug の一覧 */
  connectors: { enabled: string[] };
  rules: { enabled: boolean; max_per_agent: number };
  /** 既定5、Hard Ceiling 20（A-85） */
  max_intents_per_task: number;
  /** 空なら BR-14 の既定 */
  approvers: Uuid[];
}

/** agent_snapshots.effective_policies：仕事の slug → その仕事の実効ポリシーとハッシュ（D-19・M-01） */
export type EffectivePolicies = Record<string, { policy: EffectivePolicy; hash: Hex64 }>;

/** asks.trigger（定期のときだけ。最短間隔1時間：BR-25） */
export interface AskTrigger {
  type: "schedule";
  cron: string;
  timezone: string;
}
/** asks.question（生成中の質問1つ。選択肢は4つまで：A-93。形は M-37 の { id, label }） */
export interface AskQuestion {
  text: string;
  choices: Array<{ id: string; label: string }>;
  allowFreeText: boolean;
}

/** action_intents.payload（08ti:124） */
export interface McpIntentPayload {
  connectorId: Uuid;
  tool: string;
  arguments: JsonObject;
  toolHash: ToolHash;
}
export interface RiskReason {
  code: string;
  points: number;
  detail: string | null;
}

/** tasks.report_sources（BR-45、M-31。runner の ReportSource と同じ形） */
export type ReportSource =
  | { kind: "url"; url: string; title?: string }
  | { kind: "mcp"; connector: string; tool: string; label?: string }
  | { kind: "agent"; agentName: string };

/**
 * tasks.report_meta（0011）。本文とは分けて持つ報告の付け足し。
 * nextActions：窓口が出す「次の手の提案」（利用者がそのまま頼める文。3つまで）。changed：見張りの「前回から変化があったか」（言わなければ無い）
 */
export interface ReportMeta {
  nextActions?: string[];
  changed?: boolean;
}

export const AGENT_QUESTION_STATUSES = ["open", "answered", "expired"] as const;
export type AgentQuestionStatus = (typeof AGENT_QUESTION_STATUSES)[number];

// ---- 作業場・スキル・パック（0012・D-116） ----

export const SANDBOX_TOOLS = ["list_files", "read_file", "search", "write_file", "delete_file", "run_command"] as const;
export type SandboxTool = (typeof SANDBOX_TOOLS)[number];
export type SandboxSessionStatus = "starting" | "running" | "closed";
export type SandboxCommandStatus = "queued" | "running" | "done" | "expired";

/** sandbox_sessions：タスクの作業場1つ */
export interface SandboxSessionRow {
  id: Uuid;
  workspace_id: Uuid;
  task_id: Uuid;
  agent_id: Uuid;
  token_hash: Buffer;
  status: SandboxSessionStatus;
  provider: string;
  provider_ref: string | null;
  close_reason: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  closed_at: Date | null;
}

/** sandbox_commands：edge が積み、作業場が実行するコマンド */
export interface SandboxCommandRow {
  id: Uuid;
  workspace_id: Uuid;
  session_id: Uuid;
  task_id: Uuid;
  tool: SandboxTool;
  args: JsonObject;
  status: SandboxCommandStatus;
  ok: boolean | null;
  output: string | null;
  exit_code: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** agent_workspace_snapshots：担当の作業場のファイルの控え（tar.gz） */
export interface AgentWorkspaceSnapshotRow {
  id: Uuid;
  workspace_id: Uuid;
  agent_id: Uuid;
  task_id: Uuid | null;
  source: "task" | "pack" | "reset";
  archive: Buffer;
  files: number;
  bytes: string;
  /** 控えを残したタスクの汚染（SG-05・0013）。パックの控えは汚染なし。受け取ったタスクに持ち越す */
  tainted: boolean;
  taint_sources: TaintSource[];
  created_at: Date;
}

/** agent_skills：担当が load_skill で読む手順書 */
export interface AgentSkillRow {
  id: Uuid;
  workspace_id: Uuid;
  agent_id: Uuid;
  name: string;
  description: string;
  body: string;
  pack_id: string | null;
  created_at: Date;
  /** 出どころ。learned は承認した人がいて、approved_digest が今の中身と合うときだけ信頼される（0022） */
  origin: SkillOrigin;
  approved_by: Uuid | null;
  approved_at: Date | null;
  /** 承認したときの (名前, 説明, 本文) の SHA-256（小文字16進64桁） */
  approved_digest: string | null;
  proposal_id: Uuid | null;
  /** 本番のタスクで load_skill で読んだ最後の時刻 */
  last_used_at: Date | null;
  /** 整理で外した時刻。NULL なら使える */
  removed_at: Date | null;
}

export const SKILL_ORIGINS = ["pack", "learned"] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];

export type SkillProposalStatus = "proposed" | "approved" | "rejected" | "skipped";

/** skill_proposals：繰り返しの作業からできたスキルの案（skipped は「繰り返しの手順はない」の印） */
export interface SkillProposalRow {
  id: Uuid;
  workspace_id: Uuid;
  agent_id: Uuid;
  status: SkillProposalStatus;
  name: string | null;
  description: string | null;
  body: string | null;
  reason: string | null;
  source_task_ids: Uuid[];
  created_at: Date;
  decided_by: Uuid | null;
  decided_at: Date | null;
  skill_id: Uuid | null;
}

/** agent_evolution_events.items の1件 */
export interface EvolutionItem {
  type: "skill" | "rule";
  /** skill は agent_skills.id、rule はルールの id */
  id: string;
  label: string;
  /** 戻した時刻（ISO）。まだなら null */
  restoredAt: string | null;
}

/** agent_evolution_events：整理の記録（知らせと「戻す」の元） */
export interface AgentEvolutionEventRow {
  id: Uuid;
  workspace_id: Uuid;
  agent_id: Uuid;
  kind: "pruned";
  items: EvolutionItem[];
  config_change_id: Uuid | null;
  created_at: Date;
}

/** pack_installs：入れたパック */
export interface PackInstallRow {
  id: Uuid;
  workspace_id: Uuid;
  pack_id: string;
  pack_version: number;
  installed_by: Uuid | null;
  agent_ids: Uuid[];
  created_at: Date;
}

/** ask_pending_replies（0020）：順番待ちの返事（動いている間に送った返事。実行が終わったら古い順に始める） */
export interface AskPendingReplyRow {
  id: Uuid;
  workspace_id: Uuid;
  ask_id: Uuid;
  text: string;
  requester_id: Uuid;
  created_at: Date;
  consumed_at: Date | null;
}

/** agent_questions（0011）：動いている担当から利用者への質問（ask_user） */
export interface AgentQuestionRow {
  id: Uuid;
  workspace_id: Uuid;
  ask_id: Uuid;
  ask_run_id: Uuid | null;
  task_id: Uuid;
  agent_id: Uuid;
  agent_name: string;
  question: string;
  choices: Array<{ id: string; label: string }>;
  allow_free_text: boolean;
  status: AgentQuestionStatus;
  answer: string | null;
  answered_by: Uuid | null;
  answered_at: Date | null;
  created_at: Date;
}

// ===== 行の型 =====
export interface SchemaMigrationRow {
  version: string;
  name: string;
  checksum: Hex64;
  applied_at: Date;
}

export interface UserRow {
  id: Uuid;
  github_user_id: number | null;
  login: string;
  name: string | null;
  locale: "ja" | "en";
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceRow {
  id: Uuid;
  kind: WorkspaceKind;
  status: WorkspaceStatus;
  kill_switch_engaged: boolean;
  kill_switch_engaged_at: Date | null;
  kill_switch_engaged_by: Uuid | null;
  kill_switch_reason: string | null;
  timezone: string;
  max_concurrent_tasks: number;
  audit_seq: number;
  audit_last_hash: Buffer;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface MembershipRow {
  id: Uuid;
  workspace_id: Uuid;
  user_id: Uuid;
  role: MemberRole;
  created_at: Date;
  updated_at: Date;
}

export interface SessionRow {
  id: Uuid;
  workspace_id: Uuid;
  user_id: Uuid;
  /** SHA-256(Cookie の値) */
  token_hash: Buffer;
  csrf_token: string;
  user_agent: string | null;
  /** HMAC の16進64桁（M-55） */
  ip_hash: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface EntryAttemptRow {
  id: number;
  ip_hash: string;
  outcome: EntryOutcome;
  workspace_id: Uuid | null;
  created_at: Date;
}

export interface AuditLogRow {
  workspace_id: Uuid;
  seq: number;
  occurred_at: Date;
  event_type: string;
  actor_type: ActorType;
  actor_id: string | null;
  task_id: Uuid | null;
  payload: JsonObject;
  prev_hash: Buffer;
  hash: Buffer;
}

export interface WorkspacePolicyRow {
  id: Uuid;
  workspace_id: Uuid;
  version: number;
  policy: WorkspacePolicy;
  policy_hash: Hex64;
  created_by: Uuid | null;
  created_at: Date;
}

export interface ConnectorRow {
  id: Uuid;
  workspace_id: Uuid;
  slug: string;
  display_name: string;
  kind: ConnectorKind;
  url: string;
  auth: ConnectorAuth;
  enabled: boolean;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** コネクタの資格情報（connector_credentials の行。refresh_token_enc は gateway だけが読む：ot_app は SELECT できない） */
export interface ConnectorCredentialRow {
  id: Uuid;
  workspace_id: Uuid;
  connector_id: Uuid;
  provider: OAuthProvider;
  subject: string;
  /** Google だけ（GitHub は null） */
  email: string | null;
  scopes: string[];
  /** "v1.<iv>.<ct>"（platform の sealSecret）。Google だけ。復号は gateway だけ */
  refresh_token_enc: string | null;
  /** Google だけ */
  calendar_id: string | null;
  /** Google だけ */
  time_zone: string | null;
  /** GitHub だけ：GitHub App のインストールの ID（bigint。文字列で返る） */
  installation_id: string | null;
  /** GitHub だけ：つないだ GitHub の利用者名 */
  account_login: string | null;
  /** GitHub だけ：保護したブランチ（既定のブランチ・main・master）への書き込みを利用者が許したか（18 §2-5） */
  allow_protected_write: boolean;
  created_at: Date;
  revoked_at: Date | null;
}

/** 画面に出す Google の接続（秘密なし。app が読む） */
export interface GoogleConnection {
  connectorId: Uuid;
  email: string;
  calendarId: string;
  timeZone: string;
  createdAt: Date;
}

/** 画面に出す GitHub の接続（秘密なし。app が読む） */
export interface GithubConnection {
  connectorId: Uuid;
  credentialId: Uuid;
  accountLogin: string;
  installationId: string;
  allowProtectedWrite: boolean;
  createdAt: Date;
}

export interface ConnectorToolRow {
  id: Uuid;
  workspace_id: Uuid;
  connector_id: Uuid;
  name: string;
  description: string;
  input_schema: Json;
  annotations: Json | null;
  classification: ToolClassification;
  status: ToolStatus;
  /** 確定した役割だけ（未確定のキーは入れない） */
  arg_roles: ArgRoleMap;
  scope: ToolScope;
  verify: ToolVerifyMode;
  tool_hash: ToolHash;
  /** needs_review の間の新しい定義。一覧から消えたツールは needs_review ＋ null（MT §3.12.4） */
  pending: { description: string; inputSchema: Json; annotations: Json | null; detectedAt: string } | null;
  classified_by: string | null;
  classified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentRow {
  id: Uuid;
  workspace_id: Uuid;
  slug: string;
  name: string;
  name_source: "user" | "suggested";
  role: AgentRole | null;
  appearance: JsonObject;
  status: AgentStatus;
  current_snapshot_id: Uuid | null;
  disabled_by: Uuid | null;
  disabled_reason: string | null;
  disabled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentMessageRow {
  id: Uuid;
  workspace_id: Uuid;
  agent_id: Uuid;
  ask_id: Uuid | null;
  author: MessageAuthor;
  kind: MessageKind;
  body: string | null;
  ref_id: Uuid | null;
  created_at: Date;
}

export interface AgentJobRow {
  id: Uuid;
  workspace_id: Uuid;
  agent_id: Uuid;
  slug: string;
  kind: JobKind;
  template: JobTemplate;
  status: JobStatus;
  source_message_id: Uuid | null;
  created_at: Date;
  updated_at: Date;
}

export interface AskRow {
  id: Uuid;
  workspace_id: Uuid;
  created_by: Uuid;
  text: string;
  mention_agent_id: Uuid | null;
  /** パックの作業場から出した依頼のとき、そのパックの id（0018。D-116）。設定プランナーにパックの担当を優先させるヒント */
  pack_id: string | null;
  shape: AskShape | null;
  status: AskStatus;
  trigger: AskTrigger | null;
  next_run_at: Date | null;
  /** FR-061 の出力の記録（正は ask_members） */
  formation: JsonObject | null;
  planner_attempts: number;
  question: AskQuestion | null;
  question_answer: string | null;
  failure_reason: AskFailureReason | null;
  seed_key: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export interface AskRunRow {
  id: Uuid;
  workspace_id: Uuid;
  ask_id: Uuid;
  run_no: number;
  trigger_type: AskRunTrigger;
  status: AskRunStatus;
  answer_task_id: Uuid | null;
  /** FR §2.8 の AskAnswer */
  answer: JsonObject | null;
  answer_hash: Hex64 | null;
  answered_at: Date | null;
  first_member_started_at: Date | null;
  started_at: Date;
  finished_at: Date | null;
}

export interface AskMemberRow {
  id: Uuid;
  workspace_id: Uuid;
  ask_id: Uuid;
  agent_id: Uuid;
  job_id: Uuid;
  position: number | null;
  /** 前の段の番号（M-34） */
  depends_on: number[];
  is_aggregator: boolean;
  is_spokesperson: boolean;
  is_new: boolean;
  summary: string;
  created_at: Date;
}

export interface AgentConfigChangeRow {
  id: Uuid;
  workspace_id: Uuid;
  agent_id: Uuid;
  job_id: Uuid | null;
  origin: ChangeOrigin;
  source_message_id: Uuid | null;
  source_task_id: Uuid | null;
  source_ask_id: Uuid | null;
  patch: Json[];
  classification: Classification;
  widened_items: Json[] | null;
  status: ChangeStatus;
  decided_by: Uuid | null;
  snapshot_id: Uuid | null;
  reverts_change_id: Uuid | null;
  created_at: Date;
  decided_at: Date | null;
}

export interface AgentSnapshotRow {
  id: Uuid;
  workspace_id: Uuid;
  agent_id: Uuid;
  config_change_id: Uuid | null;
  source: "in_app" | "gitops";
  status: "valid" | "invalid";
  /** AgentDefinitionV2（ルール rules[] とガード jobs[].guards[] の正本） */
  definition: JsonObject | null;
  effective_policies: EffectivePolicies | null;
  clamped: Json[];
  ceilings_version: string;
  errors: Json[];
  warnings: Json[];
  created_at: Date;
}

export interface TaskRow {
  id: Uuid;
  workspace_id: Uuid;
  requester_id: Uuid;
  agent_id: Uuid;
  agent_snapshot_id: Uuid;
  job_id: Uuid;
  config_change_id: Uuid | null;
  ask_id: Uuid | null;
  ask_run_id: Uuid | null;
  ask_member_id: Uuid | null;
  input_task_ids: Uuid[];
  input_message_ids: Uuid[];
  parent_task_id: Uuid | null;
  kind: TaskKind;
  trigger_type: TriggerType;
  is_dry_run: boolean;
  prompt: string | null;
  output_type: "report";
  report: string | null;
  report_title: string | null;
  report_kind: ReportKind | null;
  report_sources: ReportSource[] | null;
  report_meta: ReportMeta | null;
  tainted: boolean;
  taint_sources: TaintSource[];
  status: TaskStatus;
  halt_reason: HaltReason | null;
  fail_reason: TaskFailReason | null;
  /** completed の dry_run / report / actions_declined、cancelled の policy_narrowed / user */
  status_detail: string | null;
  steps_used: number;
  cost_usd: UsdDecimal;
  denied_count: number;
  repeat_key: Hex64 | null;
  repeat_count: number;
  task_token_hash: Buffer | null;
  task_token_expires_at: Date | null;
  last_heartbeat_at: Date | null;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskEventRow {
  id: number;
  workspace_id: Uuid;
  task_id: Uuid;
  type: TaskEventType;
  payload: JsonObject;
  created_at: Date;
}

export interface ActionIntentRow {
  id: Uuid;
  workspace_id: Uuid;
  task_id: Uuid;
  job_id: Uuid;
  connector_id: Uuid;
  connector_credential_id: Uuid | null;
  action_type: "mcp_call";
  action: string;
  origin: "agent" | "deliver";
  payload: McpIntentPayload;
  tool_hash: ToolHash;
  destination_key: Hex64;
  option_digest: Hex64;
  taint_snapshot: TaintState;
  status: IntentStatus;
  decision: Decision;
  reason_code: string;
  matched_rule: string | null;
  decision_detail: DecisionDetail | null;
  enforced: boolean;
  policy_hash: Hex64;
  intent_hash: Hex64;
  expires_at: Date | null;
  fail_reason: IntentFailReason | null;
  expire_reason: IntentExpireReason | null;
  resolution: IntentResolution | null;
  retry_of_intent_id: Uuid | null;
  presend_attempts: number;
  result: Json | null;
  executed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApprovalRow {
  id: Uuid;
  workspace_id: Uuid;
  task_id: Uuid;
  intent_id: Uuid;
  status: ApprovalStatus;
  risk_level: RiskLevel;
  risk_score: number;
  risk_reasons: RiskReason[];
  approver_ids: Uuid[];
  decided_by: Uuid | null;
  decision_comment: string | null;
  decided_at: Date | null;
  remember: boolean;
  created_rule_id: string | null;
  expires_at: Date;
  expiry_cause: "ttl" | "next_run";
  first_destination: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PolicyDecisionRow {
  id: Uuid;
  workspace_id: Uuid;
  task_id: Uuid;
  intent_id: Uuid | null;
  subject_kind: SubjectKind;
  /** DecideResult.operation（M-15） */
  action_type: string | null;
  subject: JsonObject;
  counters: JsonObject;
  flags: JsonObject;
  taint: TaintState;
  decision: Decision;
  reason_code: string;
  matched_rule: string | null;
  /** 一致した「以後も許可」のルールの id（SG-09。rule_matched だけ。0015 より前の行は NULL） */
  matched_rule_id: string | null;
  detail: DecisionDetail | null;
  enforced: boolean;
  inputs_hash: Hex64;
  kernel_version: string;
  created_at: Date;
}

export interface UsageRecordRow {
  id: Uuid;
  workspace_id: Uuid;
  task_id: Uuid | null;
  agent_id: Uuid | null;
  ask_id: Uuid | null;
  provider: LlmProvider;
  model: string;
  phase: UsagePhase;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: UsdDecimal;
  cost_usd: UsdDecimal;
  latency_ms: number;
  prompt_hash: string;
  created_at: Date;
}

export interface AskMessageRow {
  id: Uuid;
  workspace_id: Uuid;
  ask_id: Uuid;
  ask_run_id: Uuid | null;
  from_member: Uuid;
  to_member: Uuid | null;
  kind: TeamMessageKind;
  body: string;
  in_reply_to: Uuid | null;
  tainted: boolean;
  from_task_id: Uuid;
  rejected_reason: string | null;
  created_at: Date;
}

export interface WorkspaceEventRow {
  id: number;
  workspace_id: Uuid;
  /** AS §2.11 の WorkspaceEvent の type（'check.upsert' など） */
  type: string;
  data: Json;
  created_at: Date;
}

export interface CheckMarkRow {
  workspace_id: Uuid;
  /** '<種類>:<UUID>'（answer / task） */
  item_key: string;
  checked_at: Date;
}

export interface IdempotencyKeyRow {
  workspace_id: Uuid;
  key: Uuid;
  method: string;
  path: string;
  request_hash: Hex64;
  response_status: number;
  response_body: Json;
  created_at: Date;
}

/** ワークスペースの中の業務の表（workspace_id を持つ public の表。ON DELETE CASCADE の試験・分離の検査に使う） */
export const WORKSPACE_TABLES = [
  "memberships",
  "sessions",
  "audit_logs",
  "workspace_policies",
  "connectors",
  "connector_tools",
  "connector_credentials",
  "agents",
  "agent_messages",
  "agent_jobs",
  "asks",
  "ask_runs",
  "ask_members",
  "agent_config_changes",
  "agent_snapshots",
  "tasks",
  "task_events",
  "task_web_urls",
  "action_intents",
  "approvals",
  "policy_decisions",
  "usage_records",
  "ask_messages",
  "agent_questions",
  "ask_pending_replies",
  "sandbox_sessions",
  "sandbox_commands",
  "agent_workspace_snapshots",
  "agent_skills",
  "skill_proposals",
  "agent_evolution_events",
  "pack_installs",
  "workspace_events",
  "check_marks",
  "idempotency_keys",
] as const;
export type WorkspaceTable = (typeof WORKSPACE_TABLES)[number];
