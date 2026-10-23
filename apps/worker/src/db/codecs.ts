// 表ごとの列の読み方（schema.ts の列の中身）。SQLite から戻る値（TEXT・INTEGER・BLOB）を行の型（types.ts）の値に戻す。
// 書いていない列はそのまま（TEXT は文字列、INTEGER は数）。JOIN や集計の列は問い合わせの側で足す（{ ...CODECS.tasks, running: "bool" }）

import type { Codec } from "./sqlite.ts";

const at = "date" as const;
const json = "json" as const;
const bool = "bool" as const;
const blob = "blob" as const;

export const CODECS = {
  workspace: {
    audit_last_hash: blob,
    created_at: at,
    updated_at: at,
  },
  audit_logs: { occurred_at: at, payload: json, prev_hash: blob, hash: blob },
  idempotency_keys: { response_body: json, created_at: at },
  workspace_events: { data: json, created_at: at },
  check_marks: { checked_at: at },
  workspace_policies: { policy: json, created_at: at },

  connectors: { auth: json, enabled: bool, last_synced_at: at, created_at: at, updated_at: at },
  connector_tools: {
    input_schema: json,
    annotations: json,
    arg_roles: json,
    pending: json,
    classified_at: at,
    created_at: at,
    updated_at: at,
  },
  connector_credentials: { scopes: json, allow_protected_write: bool, created_at: at, revoked_at: at },

  agents: { appearance: json, disabled_at: at, created_at: at, updated_at: at },
  agent_messages: { created_at: at },
  agent_jobs: { created_at: at, updated_at: at },
  agent_config_changes: { patch: json, widened_items: json, created_at: at, decided_at: at },
  agent_snapshots: { definition: json, effective_policies: json, clamped: json, errors: json, warnings: json, created_at: at },

  asks: {
    trigger: json,
    next_run_at: at,
    formation: json,
    question: json,
    created_at: at,
    updated_at: at,
    finished_at: at,
  },
  ask_runs: {
    answer: json,
    answered_at: at,
    first_member_started_at: at,
    started_at: at,
    finished_at: at,
    last_scanned_at: at,
  },
  ask_members: { depends_on: json, is_aggregator: bool, is_spokesperson: bool, is_new: bool, created_at: at },
  ask_messages: { tainted: bool, created_at: at },
  ask_pending_replies: { created_at: at, consumed_at: at },

  tasks: {
    input_task_ids: json,
    input_message_ids: json,
    is_dry_run: bool,
    report_sources: json,
    report_meta: json,
    tainted: bool,
    taint_sources: json,
    task_token_hash: blob,
    task_token_expires_at: at,
    last_heartbeat_at: at,
    queued_at: at,
    started_at: at,
    finished_at: at,
    created_at: at,
    updated_at: at,
  },
  task_events: { payload: json, created_at: at },
  task_web_urls: { url_hash: blob, created_at: at },
  agent_questions: { choices: json, allow_free_text: bool, answered_at: at, created_at: at },

  action_intents: {
    payload: json,
    taint_snapshot: json,
    decision_detail: json,
    enforced: bool,
    expires_at: at,
    result: json,
    executed_at: at,
    created_at: at,
    updated_at: at,
  },
  approvals: {
    risk_reasons: json,
    approver_ids: json,
    decided_at: at,
    remember: bool,
    expires_at: at,
    first_destination: bool,
    created_at: at,
    updated_at: at,
  },
  policy_decisions: { subject: json, counters: json, flags: json, taint: json, detail: json, enforced: bool, created_at: at },
  usage_records: { created_at: at },

  skill_proposals: { source_task_ids: json, created_at: at, decided_at: at },
  agent_skills: { approved_at: at, last_used_at: at, removed_at: at, created_at: at },
  agent_evolution_events: { items: json, created_at: at },
  pack_installs: { agent_ids: json, created_at: at },
  sandbox_sessions: { token_hash: blob, created_at: at, last_seen_at: at, closed_at: at },
  sandbox_commands: { args: json, ok: bool, created_at: at, started_at: at, finished_at: at },
  agent_workspace_snapshots: { archive: blob, tainted: bool, taint_sources: json, created_at: at },
} as const satisfies Record<string, Codec>;

export type TableName = keyof typeof CODECS;
