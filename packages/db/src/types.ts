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
export const WORKSPACE_KINDS = ["owner", "guest"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const WORKSPACE_STATUSES = ["active", "suspended"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
export const MEMBER_ROLES = ["owner", "maintainer", "viewer"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const ENTRY_OUTCOMES = ["owner", "guest_created", "guest_reset", "wrong_token", "capacity", "ip_limit"] as const;
export type EntryOutcome = (typeof ENTRY_OUTCOMES)[number];
export const ACTOR_TYPES = ["user", "system", "agent"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const CONNECTOR_KINDS = ["sim", "mcp_remote"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];
export type ConnectorAuth =
  | { type: "gcp_id_token"; audience: string }
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
  "rehearsal_tighten",
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
export const ASK_RUN_MODES = ["live", "rehearsal"] as const;
export type AskRunMode = (typeof ASK_RUN_MODES)[number];
/** M-33：initial を足した */
export const ASK_RUN_TRIGGERS = ["initial", "manual", "schedule", "resume"] as const;
export type AskRunTrigger = (typeof ASK_RUN_TRIGGERS)[number];
export const ASK_RUN_STATUSES = ["running", "waiting_input", "done", "failed", "cancelled"] as const;
export type AskRunStatus = (typeof ASK_RUN_STATUSES)[number];
export const TEAM_MESSAGE_KINDS = ["share", "question", "reply", "revise"] as const;
export type TeamMessageKind = (typeof TEAM_MESSAGE_KINDS)[number];

export const TASK_KINDS = ["normal", "followup", "revise"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
/** M-32：依頼から動くタスクは 'ask'、リハーサル・試し実行は 'dry_run' */
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
/** M-41。本番のタスクは NULL か live */
export const EXECUTION_VARIANTS = ["live", "governed", "governed_approve", "shadow"] as const;
export type ExecutionVariant = (typeof EXECUTION_VARIANTS)[number];

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
export const LLM_PROVIDERS = ["google", "anthropic", "openai", "openrouter"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
/** runner・FR の LlmPhase（M-32）＋設定プランナー・リハーサルの生成・解釈・締める提案 */
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

export const FAULT_IDS = ["F-01", "F-02", "F-03", "F-04", "F-05", "F-06", "F-07", "F-08", "F-09", "F-10", "F-11", "F-12", "F-13", "F-14", "F-15", "F-16", "F-17"] as const;
export type FaultId = (typeof FAULT_IDS)[number];
export const RUN_TRIGGERS = ["initial", "manual", "retest", "recertify", "user_case", "seed", "model_compare"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];
export const RUN_STATUSES = ["queued", "generating", "running", "done", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const SCENARIO_STATUSES = ["queued", "running", "judging", "done", "cancelled", "error"] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];
export const SCENARIO_ABORT_REASONS = ["budget", "kill_switch", "timeout", "user"] as const;
export type ScenarioAbortReason = (typeof SCENARIO_ABORT_REASONS)[number];
export const STOPPED_BY = ["kernel", "agent", "none"] as const;
export type StoppedBy = (typeof STOPPED_BY)[number];
export const CASE_SOURCES = ["generated", "user", "incident"] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];
/** M-27：user_reject */
export const INCIDENT_KINDS = ["kernel_approve", "kernel_deny", "user_reject", "kill_switch"] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
/** M-29：regenerated を足した */
export const CASE_REMOVED_REASONS = ["user", "merged", "regenerated"] as const;
export type CaseRemovedReason = (typeof CASE_REMOVED_REASONS)[number];
export const REVOKE_REASONS = ["widen", "tool_hash", "model", "case_added", "superseded"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];
export const USER_INPUT_STATUSES = ["interpreting", "matched", "running", "done", "no_match", "cancelled", "failed"] as const;
export type UserInputStatus = (typeof USER_INPUT_STATUSES)[number];
/** M-39 */
export const SIM_WORLDS = ["shop", "brief", "repo"] as const;
export type SimWorld = (typeof SIM_WORLDS)[number];

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

/** rehearsal_cases.stopped_writes の1件（IA §2.9。O-08 の入力） */
export interface StoppedWrite {
  intentId: Uuid;
  sourceTaskId: Uuid;
  jobId: Uuid;
  action: string;
  destinationKey: Hex64;
  optionDigest: Hex64;
  /** 元の引数（マスク済み） */
  argumentsSnapshot: JsonObject;
  stoppedBy: IncidentKind;
  reasonCode: string;
  occurredAt: string;
}

/** rehearsal_runs.candidate_rules の1件（SW §3.6 の CandidateRule。M-50） */
export interface CandidateRule {
  action: string;
  match: Record<string, Json>;
  free: string[];
}
/** rehearsal_runs.tool_hashes・rehearsal_certificates.tool_hashes の1件（M-49。action で並べる） */
export interface ToolHashEntry {
  action: string;
  toolHash: ToolHash;
}
/** rehearsal_runs.stage_fingerprints の1件（依頼の走行の開始時の、担当の仕事ごとの指紋。0007） */
export interface StageFingerprint {
  jobId: Uuid;
  policyHash: Hex64;
  toolHashes: ToolHashEntry[];
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
  delete_requested_at: Date | null;
  seed_version: string | null;
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
  mode: AskRunMode;
  rehearsal_run_id: Uuid | null;
  rehearsal_scenario_id: Uuid | null;
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
  rehearsal_run_id: Uuid | null;
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
  rehearsal_run_id: Uuid | null;
  rehearsal_scenario_id: Uuid | null;
  shadow: boolean;
  sim_execution_id: Uuid | null;
  execution_variant: ExecutionVariant | null;
  sim_snapshot_id: Uuid | null;
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
  /** 一致した「以後も許可」のルールの id（SG-09。rule_matched・certificate_missing だけ。0015 より前の行は NULL） */
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
  rehearsal_run_id: Uuid | null;
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
  /** '<種類>:<UUID>'（answer / rehearsal / incident_added / task） */
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

export interface RehearsalRunRow {
  id: Uuid;
  workspace_id: Uuid;
  job_id: Uuid | null;
  ask_id: Uuid | null;
  trigger: RunTrigger;
  reason: Exclude<RevokeReason, "superseded"> | null;
  requested_by: Uuid | null;
  parent_run_id: Uuid | null;
  config_change_id: Uuid | null;
  candidate_rules: CandidateRule[] | null;
  effective_policies: EffectivePolicies | null;
  policy_hash: Hex64 | null;
  tool_hashes: ToolHashEntry[] | null;
  /** 依頼の走行だけ：担当ごとの開始時の指紋（0007）。仕事の走行と指紋のない行は null */
  stage_fingerprints: StageFingerprint[] | null;
  case_set_hash: Hex64 | null;
  status: RunStatus;
  seed: number;
  model_id: string;
  generator_model_id: string | null;
  adapt_round: number;
  comparison_group_id: Uuid | null;
  /** 集計（形はリハーサルの担当：SW §3.7 の RehearsalCounts など） */
  summary: JsonObject | null;
  damage_jpy: Jpy | null;
  shadow_damage_jpy: Jpy | null;
  prevented_damage_jpy: Jpy | null;
  cost_usd: UsdDecimal;
  budget_usd: UsdDecimal;
  certificate_id: Uuid | null;
  is_seed: boolean;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface RehearsalCaseRow {
  id: Uuid;
  workspace_id: Uuid;
  job_id: Uuid | null;
  ask_id: Uuid | null;
  source: CaseSource;
  fault_ids: FaultId[];
  /** SW の Scenario（M-45） */
  scenario: JsonObject;
  seed: number;
  sim_snapshot_id: Uuid | null;
  user_text: string | null;
  source_task_id: Uuid | null;
  reason_code: string | null;
  incident_kind: IncidentKind | null;
  stopped_writes: StoppedWrite[] | null;
  first_shadow_damage_jpy: Jpy | null;
  origin_run_id: Uuid | null;
  created_by: Uuid | null;
  removed_at: Date | null;
  removed_by: Uuid | null;
  removed_reason: CaseRemovedReason | null;
  created_at: Date;
}

export interface RehearsalScenarioRow {
  id: Uuid;
  workspace_id: Uuid;
  rehearsal_run_id: Uuid;
  case_id: Uuid;
  ordinal: number;
  fault_ids: FaultId[];
  scenario: JsonObject;
  seed: number;
  status: ScenarioStatus;
  abort_reason: ScenarioAbortReason | null;
  verdict: "pass" | "fail" | null;
  stopped_by: StoppedBy | null;
  stopped_by_decision: "approve" | "deny" | "halt" | null;
  stopped_by_reason_code: string | null;
  stopped_by_rule: string | null;
  oracle_results: Json | null;
  branch_results: Json | null;
  damage_jpy: Jpy | null;
  shadow_damage_jpy: Jpy | null;
  approve_branch_damage_jpy: Jpy | null;
  /** SW の DamageBreakdown */
  damage_breakdown: JsonObject | null;
  shadow_damage_breakdown: JsonObject | null;
  approve_branch_damage_breakdown: JsonObject | null;
  /** 生成列 max(0, 影 − 本番) */
  prevented_damage_jpy: Jpy | null;
  leak_count: number | null;
  shadow_leak_count: number | null;
  interpretation: string | null;
  cost_usd: UsdDecimal;
  governed_execution_id: Uuid | null;
  approve_execution_id: Uuid | null;
  shadow_execution_id: Uuid | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface RehearsalCertificateRow {
  id: Uuid;
  workspace_id: Uuid;
  job_id: Uuid;
  ask_id: Uuid | null;
  rehearsal_run_id: Uuid;
  policy_hash: Hex64;
  tool_hashes: ToolHashEntry[];
  model_id: string;
  case_set_hash: Hex64;
  case_count: number;
  summary: JsonObject;
  cost_usd: UsdDecimal;
  certificate_hash: Hex64;
  /** audit_logs (workspace_id, seq) を指す */
  audit_seq: number;
  issued_at: Date;
  revoked_at: Date | null;
  revoke_reason: RevokeReason | null;
}

export interface RehearsalUserInputRow {
  id: Uuid;
  workspace_id: Uuid;
  job_id: Uuid | null;
  ask_id: Uuid | null;
  text: string;
  status: UserInputStatus;
  interpretation: JsonObject | null;
  nearest_fault_id: FaultId | null;
  case_id: Uuid | null;
  rehearsal_run_id: Uuid | null;
  scenario_id: Uuid | null;
  created_by: Uuid;
  created_at: Date;
}

// ---- sim スキーマ（M-40。store.ts の記録と同じ項目） ----
export interface SimExecutionRow {
  id: Uuid;
  workspace_id: Uuid;
  world: SimWorld;
  rehearsal_run_id: Uuid | null;
  parent_execution_id: Uuid | null;
  variant: ExecutionVariant;
  seed: number;
  seed_version: string;
  scenario: JsonObject | null;
  snapshot_id: Uuid | null;
  initial_state: JsonObject;
  state: JsonObject;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface SimEventRow {
  execution_id: Uuid;
  seq: number;
  workspace_id: Uuid;
  /** sim-core の SimEvent そのもの */
  event: JsonObject;
  /** 生成列（event->>'kind'・event->>'intentId'） */
  kind: string;
  intent_id: string | null;
  created_at: Date;
}

export interface SimSnapshotRow {
  id: Uuid;
  workspace_id: Uuid;
  world: SimWorld;
  execution_id: Uuid;
  execution_version: number;
  seed: number;
  seed_version: string;
  state: JsonObject;
  state_hash: Hex64;
  source_task_id: Uuid;
  taken_at: Date;
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
  "sandbox_sessions",
  "sandbox_commands",
  "agent_workspace_snapshots",
  "agent_skills",
  "pack_installs",
  "workspace_events",
  "check_marks",
  "idempotency_keys",
  "rehearsal_runs",
  "rehearsal_cases",
  "rehearsal_scenarios",
  "rehearsal_certificates",
  "rehearsal_user_inputs",
  "sim.executions",
  "sim.events",
  "sim.snapshots",
] as const;
export type WorkspaceTable = (typeof WORKSPACE_TABLES)[number];
