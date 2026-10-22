// WorkspaceDO の SQLite のスキーマ（docs/cloudflare-design.md「データ」）。packages/db の Postgres（0001〜0024）を写したもの。
// - workspace_id の列はない（DO そのものがワークスペース）。ワークスペースの行は workspace（id = 1 の1行）
// - ID は TEXT（コードで crypto.randomUUID()）。時刻は ISO 8601（UTC・ミリ秒）の TEXT。真偽は 0/1。jsonb・配列は JSON の TEXT
// - 金額は numeric(12,6) をやめてマイクロドルの INTEGER（列の名前も *_micro_usd）
// - REGEXP はないので、形の CHECK は GLOB と長さで近いものにする（細かい形はコードで確かめる）
// - 利用者（users）への参照は D1 の ID を TEXT で持つだけ（外部キーにしない）
// - トリガー（追記だけ・書き換え禁止・汚染は戻さない）は RAISE(ABORT) で同じ守りを置く
// 当てたあとの中身は書き換えない（直すときは新しい番号を足す）

/** created_at などの既定（toISOString と同じ形） */
const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

/** 小文字16進64桁 */
function hex64(col: string): string {
  return `length(${col}) = 64 AND ${col} NOT GLOB '*[^0-9a-f]*'`;
}
/** ^[a-z0-9][a-z0-9-]{min-1,max-1}$ */
function slug(col: string, min: number, max: number): string {
  return `length(${col}) BETWEEN ${min} AND ${max} AND ${col} NOT GLOB '*[^a-z0-9-]*' AND ${col} NOT GLOB '-*'`;
}
/** ^[a-z0-9-]{min,max}$（パック・仕事の ID） */
function kebab(col: string, min: number, max: number): string {
  return `length(${col}) BETWEEN ${min} AND ${max} AND ${col} NOT GLOB '*[^a-z0-9-]*'`;
}
function bool(col: string): string {
  return `${col} IN (0, 1)`;
}
function len(col: string, min: number, max: number): string {
  return `length(${col}) BETWEEN ${min} AND ${max}`;
}
function oneOf(col: string, values: readonly string[]): string {
  return `${col} IN (${values.map((v) => `'${v}'`).join(", ")})`;
}

const WORKSPACE = `
CREATE TABLE workspace (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id            TEXT    NOT NULL,
  owner_user_id           TEXT    NOT NULL,
  status                  TEXT    NOT NULL DEFAULT 'active',
  kill_switch_engaged     INTEGER NOT NULL DEFAULT 0,
  kill_switch_engaged_at  TEXT,
  kill_switch_engaged_by  TEXT,
  kill_switch_reason      TEXT,
  timezone                TEXT    NOT NULL DEFAULT 'Asia/Tokyo',
  max_concurrent_tasks    INTEGER NOT NULL DEFAULT 3,
  audit_seq               INTEGER NOT NULL DEFAULT 0,
  audit_last_hash         BLOB    NOT NULL DEFAULT (zeroblob(32)),
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL,
  CONSTRAINT workspace_status_check CHECK (${oneOf("status", ["active", "suspended"])}),
  CONSTRAINT workspace_kill_switch_check CHECK (${bool("kill_switch_engaged")}),
  CONSTRAINT workspace_kill_switch_reason_check CHECK (kill_switch_reason IS NULL OR length(kill_switch_reason) <= 500),
  CONSTRAINT workspace_timezone_check CHECK (${len("timezone", 1, 64)}),
  CONSTRAINT workspace_max_concurrent_tasks_check CHECK (max_concurrent_tasks >= 1),
  CONSTRAINT workspace_audit_seq_check CHECK (audit_seq >= 0),
  CONSTRAINT workspace_audit_last_hash_check CHECK (length(audit_last_hash) = 32)
);
INSERT INTO workspace (id, workspace_id, owner_user_id, created_at, updated_at)
  SELECT id, workspace_id, owner_user_id, created_at, created_at FROM workspace_meta;
DROP TABLE workspace_meta;
CREATE TRIGGER workspace_no_delete BEFORE DELETE ON workspace BEGIN SELECT RAISE(ABORT, 'workspace cannot be deleted'); END;
CREATE TRIGGER workspace_id_immutable BEFORE UPDATE OF id, workspace_id, owner_user_id ON workspace
  BEGIN SELECT RAISE(ABORT, 'workspace owner is immutable'); END;
`;

const AUDIT = `
CREATE TABLE audit_logs (
  seq          INTEGER PRIMARY KEY,
  occurred_at  TEXT    NOT NULL,
  event_type   TEXT    NOT NULL,
  actor_type   TEXT    NOT NULL,
  actor_id     TEXT,
  task_id      TEXT,
  payload      TEXT    NOT NULL,
  prev_hash    BLOB    NOT NULL,
  hash         BLOB    NOT NULL,
  CONSTRAINT audit_logs_seq_check CHECK (seq >= 1),
  CONSTRAINT audit_logs_event_type_check CHECK (length(event_type) <= 100 AND event_type NOT GLOB '*[^a-z_.]*'),
  CONSTRAINT audit_logs_actor_type_check CHECK (${oneOf("actor_type", ["user", "system", "agent"])}),
  CONSTRAINT audit_logs_actor_id_check CHECK (actor_id IS NULL OR length(actor_id) <= 200),
  CONSTRAINT audit_logs_payload_check CHECK (json_type(payload) = 'object'),
  CONSTRAINT audit_logs_prev_hash_check CHECK (length(prev_hash) = 32),
  CONSTRAINT audit_logs_hash_check CHECK (length(hash) = 32)
);
CREATE INDEX audit_logs_task_idx ON audit_logs (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX audit_logs_time_idx ON audit_logs (occurred_at);
CREATE INDEX audit_logs_type_idx ON audit_logs (event_type, occurred_at);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TABLE idempotency_keys (
  key              TEXT    PRIMARY KEY,
  method           TEXT    NOT NULL,
  path             TEXT    NOT NULL,
  request_hash     TEXT    NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT idempotency_keys_request_hash_check CHECK (${hex64("request_hash")})
);
CREATE INDEX idempotency_keys_time_idx ON idempotency_keys (created_at);

CREATE TABLE workspace_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL,
  data        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT workspace_events_type_check CHECK (length(type) <= 64 AND type NOT GLOB '*[^a-z_.]*')
);
CREATE INDEX workspace_events_time_idx ON workspace_events (created_at);

CREATE TABLE check_marks (
  item_key    TEXT PRIMARY KEY,
  checked_at  TEXT NOT NULL DEFAULT ${NOW},
  CONSTRAINT check_marks_item_key_check CHECK (
    instr(item_key, ':') BETWEEN 2 AND 33
    AND substr(item_key, 1, instr(item_key, ':') - 1) NOT GLOB '*[^a-z_]*'
    AND substr(item_key, instr(item_key, ':') + 1) GLOB '????????-????-????-????-????????????'
    AND substr(item_key, instr(item_key, ':') + 1) NOT GLOB '*[^0-9a-f-]*')
);
CREATE INDEX check_marks_time_idx ON check_marks (checked_at DESC);

CREATE TABLE workspace_policies (
  id           TEXT    PRIMARY KEY,
  version      INTEGER NOT NULL UNIQUE,
  policy       TEXT    NOT NULL,
  policy_hash  TEXT    NOT NULL,
  created_by   TEXT,
  created_at   TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT workspace_policies_version_check CHECK (version >= 1),
  CONSTRAINT workspace_policies_policy_check CHECK (json_type(policy) = 'object'),
  CONSTRAINT workspace_policies_policy_hash_check CHECK (${hex64("policy_hash")})
);
CREATE TRIGGER workspace_policies_no_update BEFORE UPDATE ON workspace_policies BEGIN SELECT RAISE(ABORT, 'workspace_policies is immutable'); END;
`;

const CONNECTORS = `
CREATE TABLE connectors (
  id              TEXT    PRIMARY KEY,
  slug            TEXT    NOT NULL UNIQUE,
  display_name    TEXT    NOT NULL,
  kind            TEXT    NOT NULL DEFAULT 'mcp_remote',
  url             TEXT    NOT NULL,
  auth            TEXT    NOT NULL DEFAULT '{"type":"none"}',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_synced_at  TEXT,
  created_at      TEXT    NOT NULL DEFAULT ${NOW},
  updated_at      TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT connectors_slug_check CHECK (${slug("slug", 2, 32)}),
  CONSTRAINT connectors_display_name_check CHECK (${len("display_name", 1, 60)}),
  CONSTRAINT connectors_kind_check CHECK (kind = 'mcp_remote'),
  CONSTRAINT connectors_url_check CHECK ((url GLOB 'http://*' OR url GLOB 'https://*') AND length(url) <= 2048),
  CONSTRAINT connectors_auth_check CHECK (json_type(auth) = 'object' AND ${oneOf("json_extract(auth, '$.type')", ["gcp_id_token", "none", "api_key", "oauth"])}),
  CONSTRAINT connectors_enabled_check CHECK (${bool("enabled")})
);

CREATE TABLE connector_tools (
  id              TEXT    PRIMARY KEY,
  connector_id    TEXT    NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  input_schema    TEXT    NOT NULL,
  annotations     TEXT,
  classification  TEXT    NOT NULL DEFAULT 'unclassified',
  status          TEXT    NOT NULL DEFAULT 'ok',
  arg_roles       TEXT    NOT NULL DEFAULT '{}',
  scope           TEXT,
  verify          TEXT    NOT NULL DEFAULT 'none',
  tool_hash       TEXT    NOT NULL,
  pending         TEXT,
  classified_by   TEXT,
  classified_at   TEXT,
  created_at      TEXT    NOT NULL DEFAULT ${NOW},
  updated_at      TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT connector_tools_connector_name_uq UNIQUE (connector_id, name),
  CONSTRAINT connector_tools_name_check CHECK (${len("name", 1, 64)} AND name NOT GLOB '*[^A-Za-z0-9_.-]*'),
  CONSTRAINT connector_tools_classification_check CHECK (${oneOf("classification", ["read", "write", "unclassified"])}),
  CONSTRAINT connector_tools_status_check CHECK (${oneOf("status", ["ok", "needs_review"])}),
  CONSTRAINT connector_tools_arg_roles_check CHECK (json_type(arg_roles) = 'object'),
  CONSTRAINT connector_tools_scope_check CHECK (scope IS NULL OR scope = 'self'),
  CONSTRAINT connector_tools_verify_check CHECK (${oneOf("verify", ["none", "readback"])}),
  CONSTRAINT connector_tools_tool_hash_check CHECK (tool_hash GLOB 'sha256:*' AND ${hex64("substr(tool_hash, 8)")}),
  CONSTRAINT connector_tools_pending_check CHECK (pending IS NULL OR json_type(pending) = 'object'),
  CONSTRAINT connector_tools_pending_chk CHECK (pending IS NULL OR status = 'needs_review')
);

CREATE TABLE connector_credentials (
  id                     TEXT    PRIMARY KEY,
  connector_id           TEXT    NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
  provider               TEXT    NOT NULL,
  subject                TEXT    NOT NULL,
  email                  TEXT,
  scopes                 TEXT    NOT NULL,
  refresh_token_enc      TEXT,
  calendar_id            TEXT,
  time_zone              TEXT,
  installation_id        INTEGER,
  account_login          TEXT,
  allow_protected_write  INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT    NOT NULL DEFAULT ${NOW},
  revoked_at             TEXT,
  CONSTRAINT connector_credentials_provider_check CHECK (${oneOf("provider", ["google", "github"])}),
  CONSTRAINT connector_credentials_scopes_check CHECK (json_type(scopes) = 'array'),
  CONSTRAINT connector_credentials_refresh_token_enc_check CHECK (refresh_token_enc IS NULL OR refresh_token_enc GLOB 'v1.*'),
  CONSTRAINT connector_credentials_installation_id_check CHECK (installation_id IS NULL OR installation_id > 0),
  CONSTRAINT connector_credentials_account_login_check CHECK (account_login IS NULL OR (${len("account_login", 1, 39)} AND account_login NOT GLOB '*[^A-Za-z0-9-]*')),
  CONSTRAINT connector_credentials_allow_protected_write_check CHECK (${bool("allow_protected_write")}),
  CONSTRAINT connector_credentials_provider_fields_chk CHECK (
    (provider = 'google' AND email IS NOT NULL AND refresh_token_enc IS NOT NULL AND calendar_id IS NOT NULL AND time_zone IS NOT NULL
      AND installation_id IS NULL AND account_login IS NULL AND allow_protected_write = 0)
    OR (provider = 'github' AND installation_id IS NOT NULL AND account_login IS NOT NULL
      AND refresh_token_enc IS NULL AND calendar_id IS NULL AND time_zone IS NULL))
);
CREATE UNIQUE INDEX connector_credentials_active_uq ON connector_credentials (connector_id) WHERE revoked_at IS NULL;
`;

const AGENTS = `
CREATE TABLE agents (
  id                   TEXT    PRIMARY KEY,
  slug                 TEXT    NOT NULL UNIQUE,
  name                 TEXT    NOT NULL,
  name_source          TEXT    NOT NULL DEFAULT 'suggested',
  role                 TEXT,
  appearance           TEXT    NOT NULL DEFAULT '{}',
  status               TEXT    NOT NULL DEFAULT 'idle',
  current_snapshot_id  TEXT    REFERENCES agent_snapshots (id) DEFERRABLE INITIALLY DEFERRED,
  disabled_by          TEXT,
  disabled_reason      TEXT,
  disabled_at          TEXT,
  created_at           TEXT    NOT NULL DEFAULT ${NOW},
  updated_at           TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT agents_slug_check CHECK (${slug("slug", 2, 32)}),
  CONSTRAINT agents_name_check CHECK (${len("name", 1, 40)}),
  CONSTRAINT agents_name_source_check CHECK (${oneOf("name_source", ["user", "suggested"])}),
  CONSTRAINT agents_role_check CHECK (role IS NULL OR ${oneOf("role", ["research", "watch", "brief", "assist", "dev"])}),
  CONSTRAINT agents_appearance_check CHECK (json_type(appearance) = 'object'),
  CONSTRAINT agents_status_check CHECK (${oneOf("status", ["idle", "active", "invalid", "disabled", "removed"])}),
  CONSTRAINT agents_disabled_reason_check CHECK (disabled_reason IS NULL OR length(disabled_reason) <= 500),
  CONSTRAINT agents_disabled_chk CHECK (status <> 'disabled' OR disabled_at IS NOT NULL)
);
CREATE UNIQUE INDEX agents_name_uq ON agents (name) WHERE status <> 'removed';
CREATE INDEX agents_status_idx ON agents (status);

CREATE TABLE agent_messages (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  ask_id      TEXT REFERENCES asks (id) ON DELETE SET NULL,
  author      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT,
  ref_id      TEXT,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  CONSTRAINT agent_messages_author_check CHECK (${oneOf("author", ["user", "agent", "system"])}),
  CONSTRAINT agent_messages_kind_check CHECK (${oneOf("kind", ["text", "question", "connect", "confirm", "approval", "result", "change", "delegate"])}),
  CONSTRAINT agent_messages_body_check CHECK (body IS NULL OR length(body) <= 4000)
);
CREATE INDEX agent_messages_agent_time_idx ON agent_messages (agent_id, created_at DESC);

CREATE TABLE agent_jobs (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents (id),
  slug               TEXT NOT NULL,
  kind               TEXT NOT NULL,
  template           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  source_message_id  TEXT REFERENCES agent_messages (id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT ${NOW},
  updated_at         TEXT NOT NULL DEFAULT ${NOW},
  CONSTRAINT agent_jobs_agent_slug_uq UNIQUE (agent_id, slug),
  CONSTRAINT agent_jobs_slug_check CHECK (${kebab("slug", 2, 40)}),
  CONSTRAINT agent_jobs_kind_check CHECK (${oneOf("kind", ["once", "recurring", "watch"])}),
  CONSTRAINT agent_jobs_template_check CHECK (${oneOf("template", ["researcher", "briefer", "watcher", "assistant", "dev-coder", "reviewer"])}),
  CONSTRAINT agent_jobs_status_check CHECK (${oneOf("status", ["waiting_input", "active", "paused", "done"])})
);
CREATE INDEX agent_jobs_status_idx ON agent_jobs (status);

CREATE TABLE agent_config_changes (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agents (id),
  job_id             TEXT REFERENCES agent_jobs (id),
  origin             TEXT NOT NULL,
  source_message_id  TEXT REFERENCES agent_messages (id) ON DELETE SET NULL,
  source_task_id     TEXT REFERENCES tasks (id) ON DELETE SET NULL,
  source_ask_id      TEXT REFERENCES asks (id) ON DELETE SET NULL,
  patch              TEXT NOT NULL,
  classification     TEXT NOT NULL,
  widened_items      TEXT,
  status             TEXT NOT NULL DEFAULT 'proposed',
  decided_by         TEXT,
  snapshot_id        TEXT REFERENCES agent_snapshots (id),
  reverts_change_id  TEXT REFERENCES agent_config_changes (id),
  created_at         TEXT NOT NULL DEFAULT ${NOW},
  decided_at         TEXT,
  CONSTRAINT agent_config_changes_origin_check CHECK (${oneOf("origin", [
    "user_request", "feedback", "failure", "engagement", "manual", "revert", "move", "approval_rule", "ask", "rehearsal_tighten", "prune",
  ])}),
  CONSTRAINT agent_config_changes_patch_check CHECK (json_type(patch) = 'array'),
  CONSTRAINT agent_config_changes_classification_check CHECK (${oneOf("classification", ["narrow", "neutral", "widen"])}),
  CONSTRAINT agent_config_changes_status_check CHECK (${oneOf("status", ["proposed", "applied", "rejected", "reverted"])}),
  CONSTRAINT agent_config_changes_widen_chk CHECK (classification <> 'widen' OR widened_items IS NOT NULL),
  CONSTRAINT agent_config_changes_applied_chk CHECK (status NOT IN ('applied', 'reverted') OR snapshot_id IS NOT NULL),
  CONSTRAINT agent_config_changes_decided_chk CHECK (status = 'proposed' OR decided_at IS NOT NULL)
);
CREATE INDEX agent_config_changes_agent_time_idx ON agent_config_changes (agent_id, created_at DESC);
CREATE INDEX agent_config_changes_proposed_idx ON agent_config_changes (agent_id) WHERE status = 'proposed';

CREATE TABLE agent_snapshots (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents (id),
  config_change_id    TEXT REFERENCES agent_config_changes (id),
  source              TEXT NOT NULL DEFAULT 'in_app',
  status              TEXT NOT NULL,
  definition          TEXT,
  effective_policies  TEXT,
  clamped             TEXT NOT NULL DEFAULT '[]',
  ceilings_version    TEXT NOT NULL,
  errors              TEXT NOT NULL DEFAULT '[]',
  warnings            TEXT NOT NULL DEFAULT '[]',
  created_at          TEXT NOT NULL DEFAULT ${NOW},
  CONSTRAINT agent_snapshots_source_check CHECK (${oneOf("source", ["in_app", "gitops"])}),
  CONSTRAINT agent_snapshots_status_check CHECK (${oneOf("status", ["valid", "invalid"])}),
  CONSTRAINT agent_snapshots_definition_check CHECK (definition IS NULL OR json_type(definition) = 'object'),
  CONSTRAINT agent_snapshots_effective_policies_check CHECK (effective_policies IS NULL OR json_type(effective_policies) = 'object'),
  CONSTRAINT agent_snapshots_clamped_check CHECK (json_type(clamped) = 'array'),
  CONSTRAINT agent_snapshots_errors_check CHECK (json_type(errors) = 'array'),
  CONSTRAINT agent_snapshots_warnings_check CHECK (json_type(warnings) = 'array'),
  CONSTRAINT agent_snapshots_valid_chk CHECK (status <> 'valid' OR (definition IS NOT NULL AND effective_policies IS NOT NULL))
);
CREATE INDEX agent_snapshots_agent_time_idx ON agent_snapshots (agent_id, created_at DESC);
CREATE TRIGGER agent_snapshots_no_update BEFORE UPDATE ON agent_snapshots BEGIN SELECT RAISE(ABORT, 'agent_snapshots is immutable'); END;
`;

const ASKS = `
CREATE TABLE asks (
  id                TEXT    PRIMARY KEY,
  created_by        TEXT    NOT NULL,
  text              TEXT    NOT NULL,
  mention_agent_id  TEXT    REFERENCES agents (id) ON DELETE SET NULL,
  shape             TEXT,
  status            TEXT    NOT NULL DEFAULT 'generating',
  "trigger"         TEXT,
  next_run_at       TEXT,
  formation         TEXT,
  planner_attempts  INTEGER NOT NULL DEFAULT 0,
  question          TEXT,
  question_answer   TEXT,
  failure_reason    TEXT,
  seed_key          TEXT    UNIQUE,
  pack_id           TEXT,
  created_at        TEXT    NOT NULL DEFAULT ${NOW},
  updated_at        TEXT    NOT NULL DEFAULT ${NOW},
  finished_at       TEXT,
  CONSTRAINT asks_text_check CHECK (${len("text", 1, 2000)}),
  CONSTRAINT asks_shape_check CHECK (shape IS NULL OR ${oneOf("shape", ["single", "parallel", "aggregate", "chain"])}),
  CONSTRAINT asks_status_check CHECK (${oneOf("status", ["generating", "running", "waiting_input", "done", "failed", "cancelled"])}),
  CONSTRAINT asks_trigger_chk CHECK ("trigger" IS NULL OR json_type("trigger") = 'object'),
  CONSTRAINT asks_planner_attempts_check CHECK (planner_attempts BETWEEN 0 AND 3),
  CONSTRAINT asks_question_check CHECK (question IS NULL OR json_type(question) = 'object'),
  CONSTRAINT asks_question_answer_check CHECK (question_answer IS NULL OR length(question_answer) <= 2000),
  CONSTRAINT asks_failure_reason_check CHECK (failure_reason IS NULL OR ${oneOf("failure_reason", [
    "formation_invalid", "timeout", "budget_exceeded", "kill_switch", "agent_limit", "planner_error",
  ])}),
  CONSTRAINT asks_seed_key_check CHECK (seed_key IS NULL OR ${len("seed_key", 1, 64)}),
  CONSTRAINT asks_pack_id_check CHECK (pack_id IS NULL OR ${kebab("pack_id", 2, 40)}),
  CONSTRAINT asks_failure_reason_chk CHECK (failure_reason IS NULL OR status = 'failed'),
  CONSTRAINT asks_generation_failed_chk CHECK (NOT (status = 'failed' AND shape IS NULL) OR failure_reason IS NOT NULL),
  CONSTRAINT asks_next_run_needs_trigger_chk CHECK (next_run_at IS NULL OR "trigger" IS NOT NULL),
  CONSTRAINT asks_shape_after_generating_chk CHECK (status IN ('generating', 'failed', 'cancelled') OR shape IS NOT NULL)
);
CREATE INDEX asks_due_idx ON asks (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE INDEX asks_status_idx ON asks (status);
CREATE INDEX asks_time_idx ON asks (created_at DESC);

CREATE TABLE ask_runs (
  id                       TEXT    PRIMARY KEY,
  ask_id                   TEXT    NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  run_no                   INTEGER NOT NULL,
  trigger_type             TEXT    NOT NULL,
  status                   TEXT    NOT NULL DEFAULT 'running',
  answer_task_id           TEXT    REFERENCES tasks (id) ON DELETE SET NULL,
  answer                   TEXT,
  answer_hash              TEXT,
  answered_at              TEXT,
  first_member_started_at  TEXT,
  started_at               TEXT    NOT NULL DEFAULT ${NOW},
  finished_at              TEXT,
  last_scanned_at          TEXT,
  CONSTRAINT ask_runs_no_uq UNIQUE (ask_id, run_no),
  CONSTRAINT ask_runs_run_no_check CHECK (run_no >= 1),
  CONSTRAINT ask_runs_trigger_type_check CHECK (${oneOf("trigger_type", ["initial", "manual", "schedule", "resume"])}),
  CONSTRAINT ask_runs_status_check CHECK (${oneOf("status", ["running", "waiting_input", "done", "failed", "cancelled"])}),
  CONSTRAINT ask_runs_answer_hash_check CHECK (answer_hash IS NULL OR (${hex64("answer_hash")})),
  CONSTRAINT ask_runs_answer_chk CHECK (answer_task_id IS NULL OR answered_at IS NOT NULL),
  CONSTRAINT ask_runs_answer_body_chk CHECK (answer IS NULL OR answered_at IS NOT NULL)
);
CREATE INDEX ask_runs_ask_idx ON ask_runs (ask_id, started_at DESC);
CREATE INDEX ask_runs_answered_idx ON ask_runs (answered_at DESC) WHERE answered_at IS NOT NULL;

CREATE TABLE ask_members (
  id               TEXT    PRIMARY KEY,
  ask_id           TEXT    NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  agent_id         TEXT    NOT NULL REFERENCES agents (id),
  job_id           TEXT    NOT NULL UNIQUE REFERENCES agent_jobs (id),
  position         INTEGER,
  depends_on       TEXT    NOT NULL DEFAULT '[]',
  is_aggregator    INTEGER NOT NULL DEFAULT 0,
  is_spokesperson  INTEGER NOT NULL DEFAULT 0,
  is_new           INTEGER NOT NULL,
  summary          TEXT    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT ask_members_agent_uq UNIQUE (ask_id, agent_id),
  CONSTRAINT ask_members_position_check CHECK (position IS NULL OR position BETWEEN 1 AND 6),
  CONSTRAINT ask_members_depends_on_check CHECK (json_type(depends_on) = 'array' AND json_array_length(depends_on) <= 6),
  CONSTRAINT ask_members_flags_check CHECK (${bool("is_aggregator")} AND ${bool("is_spokesperson")} AND ${bool("is_new")}),
  CONSTRAINT ask_members_summary_check CHECK (${len("summary", 1, 200)})
);
CREATE UNIQUE INDEX ask_members_aggregator_uq ON ask_members (ask_id) WHERE is_aggregator = 1;
CREATE UNIQUE INDEX ask_members_spokesperson_uq ON ask_members (ask_id) WHERE is_spokesperson = 1;
CREATE UNIQUE INDEX ask_members_position_uq ON ask_members (ask_id, position) WHERE position IS NOT NULL;

CREATE TABLE ask_messages (
  id               TEXT    PRIMARY KEY,
  ask_id           TEXT    NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  ask_run_id       TEXT    REFERENCES ask_runs (id) ON DELETE CASCADE,
  from_member      TEXT    NOT NULL REFERENCES ask_members (id) ON DELETE CASCADE,
  to_member        TEXT    REFERENCES ask_members (id) ON DELETE CASCADE,
  kind             TEXT    NOT NULL,
  body             TEXT    NOT NULL,
  in_reply_to      TEXT    REFERENCES ask_messages (id) ON DELETE SET NULL,
  tainted          INTEGER NOT NULL,
  from_task_id     TEXT    NOT NULL REFERENCES tasks (id),
  rejected_reason  TEXT,
  created_at       TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT ask_messages_kind_check CHECK (${oneOf("kind", ["share", "question", "reply", "revise"])}),
  CONSTRAINT ask_messages_body_check CHECK (${len("body", 1, 2000)}),
  CONSTRAINT ask_messages_tainted_check CHECK (${bool("tainted")}),
  CONSTRAINT ask_messages_reply_chk CHECK (kind <> 'reply' OR in_reply_to IS NOT NULL)
);
CREATE INDEX ask_messages_ask_time_idx ON ask_messages (ask_id, created_at);

CREATE TABLE ask_pending_replies (
  id            TEXT PRIMARY KEY,
  ask_id        TEXT NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  requester_id  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  consumed_at   TEXT,
  CONSTRAINT ask_pending_replies_text_check CHECK (${len("text", 1, 2000)})
);
CREATE INDEX ask_pending_replies_open_idx ON ask_pending_replies (ask_id, created_at, id) WHERE consumed_at IS NULL;
`;

const TASKS = `
CREATE TABLE tasks (
  id                     TEXT    PRIMARY KEY,
  requester_id           TEXT    NOT NULL,
  agent_id               TEXT    NOT NULL REFERENCES agents (id),
  agent_snapshot_id      TEXT    NOT NULL REFERENCES agent_snapshots (id),
  job_id                 TEXT    NOT NULL REFERENCES agent_jobs (id),
  config_change_id       TEXT    REFERENCES agent_config_changes (id),
  ask_id                 TEXT    REFERENCES asks (id),
  ask_run_id             TEXT    REFERENCES ask_runs (id),
  ask_member_id          TEXT    REFERENCES ask_members (id),
  input_task_ids         TEXT    NOT NULL DEFAULT '[]',
  input_message_ids      TEXT    NOT NULL DEFAULT '[]',
  parent_task_id         TEXT    REFERENCES tasks (id),
  kind                   TEXT    NOT NULL DEFAULT 'normal',
  trigger_type           TEXT    NOT NULL,
  is_dry_run             INTEGER NOT NULL DEFAULT 0,
  prompt                 TEXT,
  output_type            TEXT    NOT NULL DEFAULT 'report',
  report                 TEXT,
  report_title           TEXT,
  report_kind            TEXT,
  report_sources         TEXT,
  report_meta            TEXT,
  tainted                INTEGER NOT NULL DEFAULT 0,
  taint_sources          TEXT    NOT NULL DEFAULT '[]',
  status                 TEXT    NOT NULL DEFAULT 'queued',
  halt_reason            TEXT,
  fail_reason            TEXT,
  status_detail          TEXT,
  steps_used             INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd         INTEGER NOT NULL DEFAULT 0,
  denied_count           INTEGER NOT NULL DEFAULT 0,
  repeat_key             TEXT,
  repeat_count           INTEGER NOT NULL DEFAULT 0,
  task_token_hash        BLOB    UNIQUE,
  task_token_expires_at  TEXT,
  last_heartbeat_at      TEXT,
  queued_at              TEXT    NOT NULL DEFAULT ${NOW},
  started_at             TEXT,
  finished_at            TEXT,
  created_at             TEXT    NOT NULL DEFAULT ${NOW},
  updated_at             TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT tasks_input_ids_check CHECK (json_type(input_task_ids) = 'array' AND json_type(input_message_ids) = 'array'),
  CONSTRAINT tasks_kind_check CHECK (${oneOf("kind", ["normal", "followup", "revise"])}),
  CONSTRAINT tasks_trigger_type_check CHECK (${oneOf("trigger_type", ["manual", "schedule", "dry_run", "ask"])}),
  CONSTRAINT tasks_dry_run_trigger_chk CHECK (is_dry_run = (trigger_type = 'dry_run')),
  CONSTRAINT tasks_prompt_check CHECK (prompt IS NULL OR length(prompt) <= 2000),
  CONSTRAINT tasks_output_type_check CHECK (output_type = 'report'),
  CONSTRAINT tasks_report_check CHECK (report IS NULL OR length(report) <= 50000),
  CONSTRAINT tasks_report_title_check CHECK (report_title IS NULL OR length(report_title) <= 256),
  CONSTRAINT tasks_report_kind_check CHECK (report_kind IS NULL OR ${oneOf("report_kind", ["normal", "answer"])}),
  CONSTRAINT tasks_report_kind_chk CHECK ((report IS NULL) = (report_kind IS NULL)),
  CONSTRAINT tasks_report_sources_chk CHECK (report_sources IS NULL OR (report IS NOT NULL AND json_type(report_sources) = 'array')),
  CONSTRAINT tasks_report_meta_check CHECK (report_meta IS NULL OR json_type(report_meta) = 'object'),
  CONSTRAINT tasks_tainted_check CHECK (${bool("tainted")} AND ${bool("is_dry_run")}),
  CONSTRAINT tasks_taint_sources_check CHECK (json_type(taint_sources) = 'array'),
  CONSTRAINT tasks_taint_chk CHECK (tainted = 1 OR taint_sources = '[]'),
  CONSTRAINT tasks_status_check CHECK (${oneOf("status", [
    "queued", "provisioning", "running", "awaiting_approval", "executing", "succeeded", "completed", "rejected", "failed", "cancelled", "halted",
  ])}),
  CONSTRAINT tasks_halt_reason_check CHECK (halt_reason IS NULL OR ${oneOf("halt_reason", [
    "budget_exceeded", "breaker_tripped", "timeout", "kill_switch", "policy_violation", "approval_expired", "agent_disabled",
  ])}),
  CONSTRAINT tasks_fail_reason_check CHECK (fail_reason IS NULL OR ${oneOf("fail_reason", [
    "sandbox_lost", "llm_unavailable", "precondition_failed", "agent_no_change", "agent_unable", "action_failed",
  ])}),
  CONSTRAINT tasks_halt_reason_chk CHECK ((status = 'halted') = (halt_reason IS NOT NULL)),
  CONSTRAINT tasks_fail_reason_chk CHECK ((status = 'failed') = (fail_reason IS NOT NULL)),
  CONSTRAINT tasks_finished_chk CHECK ((status IN ('succeeded', 'completed', 'rejected', 'failed', 'cancelled', 'halted')) = (finished_at IS NOT NULL)),
  CONSTRAINT tasks_status_detail_check CHECK (status_detail IS NULL OR (${len("status_detail", 1, 40)} AND status_detail NOT GLOB '*[^a-z_]*')),
  CONSTRAINT tasks_counts_check CHECK (steps_used >= 0 AND cost_micro_usd >= 0 AND denied_count >= 0 AND repeat_count >= 0),
  CONSTRAINT tasks_repeat_key_check CHECK (repeat_key IS NULL OR (${hex64("repeat_key")})),
  CONSTRAINT tasks_task_token_hash_check CHECK (task_token_hash IS NULL OR length(task_token_hash) = 32),
  CONSTRAINT tasks_followup_parent_chk CHECK (kind = 'normal' OR parent_task_id IS NOT NULL),
  CONSTRAINT tasks_ask_run_chk CHECK (ask_run_id IS NULL OR ask_id IS NOT NULL),
  CONSTRAINT tasks_ask_member_chk CHECK (ask_member_id IS NULL OR ask_id IS NOT NULL)
);
CREATE INDEX tasks_agent_time_idx ON tasks (agent_id, created_at DESC);
CREATE INDEX tasks_ask_run_idx ON tasks (ask_run_id) WHERE ask_run_id IS NOT NULL;
CREATE INDEX tasks_job_status_idx ON tasks (job_id, status);
CREATE INDEX tasks_job_time_idx ON tasks (job_id, created_at DESC);
CREATE INDEX tasks_status_idx ON tasks (status);
CREATE INDEX tasks_time_idx ON tasks (created_at DESC);
CREATE TRIGGER tasks_taint_monotonic BEFORE UPDATE OF tainted ON tasks WHEN OLD.tainted = 1 AND NEW.tainted = 0
  BEGIN SELECT RAISE(ABORT, 'tasks.tainted cannot go back to false'); END;

CREATE TABLE task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  type        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT task_events_type_check CHECK (${oneOf("type", ["phase_started", "tool_called", "llm_called", "status_changed", "budget_updated", "message", "finished"])}),
  CONSTRAINT task_events_payload_check CHECK (json_type(payload) = 'object')
);
CREATE INDEX task_events_task_idx ON task_events (task_id, id);

CREATE TABLE task_web_urls (
  task_id     TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  url_hash    BLOB NOT NULL,
  created_at  TEXT NOT NULL DEFAULT ${NOW},
  CONSTRAINT task_web_urls_pk PRIMARY KEY (task_id, url_hash),
  CONSTRAINT task_web_urls_url_hash_check CHECK (length(url_hash) = 32)
);

CREATE TABLE agent_questions (
  id               TEXT    PRIMARY KEY,
  ask_id           TEXT    NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  ask_run_id       TEXT    REFERENCES ask_runs (id) ON DELETE CASCADE,
  task_id          TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  agent_id         TEXT    NOT NULL,
  agent_name       TEXT    NOT NULL,
  question         TEXT    NOT NULL,
  choices          TEXT    NOT NULL DEFAULT '[]',
  allow_free_text  INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL DEFAULT 'open',
  answer           TEXT,
  answered_by      TEXT,
  answered_at      TEXT,
  created_at       TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT agent_questions_agent_name_check CHECK (${len("agent_name", 1, 60)}),
  CONSTRAINT agent_questions_question_check CHECK (${len("question", 1, 300)}),
  CONSTRAINT agent_questions_choices_check CHECK (json_type(choices) = 'array' AND json_array_length(choices) <= 4),
  CONSTRAINT agent_questions_allow_free_text_check CHECK (${bool("allow_free_text")}),
  CONSTRAINT agent_questions_status_check CHECK (${oneOf("status", ["open", "answered", "expired"])}),
  CONSTRAINT agent_questions_answer_check CHECK (answer IS NULL OR ${len("answer", 1, 500)}),
  CONSTRAINT agent_questions_answer_chk CHECK ((status = 'answered') = (answer IS NOT NULL))
);
CREATE INDEX agent_questions_ask_time_idx ON agent_questions (ask_id, created_at);
CREATE INDEX agent_questions_task_idx ON agent_questions (task_id);
`;

const INTENTS = `
CREATE TABLE action_intents (
  id                       TEXT    PRIMARY KEY,
  task_id                  TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  job_id                   TEXT    NOT NULL REFERENCES agent_jobs (id),
  connector_id             TEXT    NOT NULL REFERENCES connectors (id),
  connector_credential_id  TEXT,
  action_type              TEXT    NOT NULL DEFAULT 'mcp_call',
  action                   TEXT    NOT NULL,
  origin                   TEXT    NOT NULL,
  payload                  TEXT    NOT NULL,
  tool_hash                TEXT    NOT NULL,
  destination_key          TEXT    NOT NULL,
  option_digest            TEXT    NOT NULL,
  taint_snapshot           TEXT    NOT NULL DEFAULT '{"sources":[],"tainted":false}',
  status                   TEXT    NOT NULL DEFAULT 'proposed',
  decision                 TEXT    NOT NULL,
  reason_code              TEXT    NOT NULL,
  matched_rule             TEXT,
  decision_detail          TEXT,
  enforced                 INTEGER NOT NULL DEFAULT 1,
  policy_hash              TEXT    NOT NULL,
  intent_hash              TEXT    NOT NULL,
  expires_at               TEXT,
  fail_reason              TEXT,
  expire_reason            TEXT,
  resolution               TEXT,
  retry_of_intent_id       TEXT    REFERENCES action_intents (id),
  presend_attempts         INTEGER NOT NULL DEFAULT 0,
  result                   TEXT,
  executed_at              TEXT,
  created_at               TEXT    NOT NULL DEFAULT ${NOW},
  updated_at               TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT action_intents_action_type_check CHECK (action_type = 'mcp_call'),
  CONSTRAINT action_intents_action_check CHECK (action GLOB 'mcp.?*.?*' AND length(action) <= 101),
  CONSTRAINT action_intents_origin_check CHECK (${oneOf("origin", ["agent", "deliver"])}),
  CONSTRAINT action_intents_payload_check CHECK (json_type(payload) = 'object'),
  CONSTRAINT action_intents_tool_hash_check CHECK (tool_hash GLOB 'sha256:*' AND ${hex64("substr(tool_hash, 8)")}),
  CONSTRAINT action_intents_destination_key_check CHECK (${hex64("destination_key")}),
  CONSTRAINT action_intents_option_digest_check CHECK (${hex64("option_digest")}),
  CONSTRAINT action_intents_policy_hash_check CHECK (${hex64("policy_hash")}),
  CONSTRAINT action_intents_intent_hash_check CHECK (${hex64("intent_hash")}),
  CONSTRAINT action_intents_taint_snapshot_check CHECK (json_type(taint_snapshot) = 'object'),
  CONSTRAINT action_intents_status_check CHECK (${oneOf("status", [
    "proposed", "simulated", "denied", "pending_approval", "approved", "rejected", "expired", "executing", "executed", "verified", "failed", "unknown_outcome",
  ])}),
  CONSTRAINT action_intents_decision_check CHECK (${oneOf("decision", ["allow", "deny", "approve", "handoff", "halt"])}),
  CONSTRAINT action_intents_decision_detail_check CHECK (decision_detail IS NULL OR json_type(decision_detail) = 'object'),
  CONSTRAINT action_intents_enforced_check CHECK (${bool("enforced")}),
  CONSTRAINT action_intents_fail_reason_check CHECK (fail_reason IS NULL OR ${oneOf("fail_reason", [
    "tool_error", "unreachable", "auth_required", "precondition_failed", "confirmed_not_delivered",
  ])}),
  CONSTRAINT action_intents_expire_reason_check CHECK (expire_reason IS NULL OR ${oneOf("expire_reason", [
    "approval_timeout", "superseded", "tool_changed", "task_cancelled", "kill_switch", "task_ended", "rehearsal_end", "policy_changed",
  ])}),
  CONSTRAINT action_intents_resolution_check CHECK (resolution IS NULL OR ${oneOf("resolution", ["confirmed_delivered", "confirmed_not_delivered", "retried"])}),
  CONSTRAINT action_intents_presend_attempts_check CHECK (presend_attempts BETWEEN 0 AND 3),
  CONSTRAINT action_intents_fail_reason_chk CHECK ((status = 'failed') = (fail_reason IS NOT NULL)),
  CONSTRAINT action_intents_expire_reason_chk CHECK ((status = 'expired') = (expire_reason IS NOT NULL)),
  CONSTRAINT action_intents_pending_expiry_chk CHECK (status <> 'pending_approval' OR expires_at IS NOT NULL),
  CONSTRAINT action_intents_executed_chk CHECK (status NOT IN ('executed', 'verified') OR executed_at IS NOT NULL OR resolution IS 'confirmed_delivered')
);
CREATE INDEX action_intents_executing_idx ON action_intents (updated_at) WHERE status = 'executing';
CREATE INDEX action_intents_job_dest_idx ON action_intents (job_id, destination_key);
CREATE INDEX action_intents_pending_idx ON action_intents (expires_at) WHERE status = 'pending_approval';
CREATE INDEX action_intents_task_idx ON action_intents (task_id);
CREATE INDEX action_intents_status_idx ON action_intents (status);

CREATE TABLE approvals (
  id                 TEXT    PRIMARY KEY,
  task_id            TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  intent_id          TEXT    NOT NULL UNIQUE REFERENCES action_intents (id) ON DELETE CASCADE,
  status             TEXT    NOT NULL DEFAULT 'pending',
  risk_level         TEXT    NOT NULL,
  risk_score         INTEGER NOT NULL,
  risk_reasons       TEXT    NOT NULL DEFAULT '[]',
  approver_ids       TEXT    NOT NULL,
  decided_by         TEXT,
  decision_comment   TEXT,
  decided_at         TEXT,
  remember           INTEGER NOT NULL DEFAULT 0,
  created_rule_id    TEXT,
  expires_at         TEXT    NOT NULL,
  expiry_cause       TEXT    NOT NULL DEFAULT 'ttl',
  first_destination  INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT ${NOW},
  updated_at         TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT approvals_status_check CHECK (${oneOf("status", ["pending", "approved", "rejected", "expired"])}),
  CONSTRAINT approvals_risk_level_check CHECK (${oneOf("risk_level", ["low", "medium", "high"])}),
  CONSTRAINT approvals_risk_reasons_check CHECK (json_type(risk_reasons) = 'array'),
  CONSTRAINT approvals_approver_ids_check CHECK (json_type(approver_ids) = 'array' AND json_array_length(approver_ids) >= 1),
  CONSTRAINT approvals_decision_comment_check CHECK (decision_comment IS NULL OR length(decision_comment) <= 1000),
  CONSTRAINT approvals_flags_check CHECK (${bool("remember")} AND ${bool("first_destination")}),
  CONSTRAINT approvals_created_rule_id_check CHECK (created_rule_id IS NULL OR (created_rule_id GLOB 'r-*' AND ${len("created_rule_id", 6, 34)} AND substr(created_rule_id, 3) NOT GLOB '*[^0-9a-z]*')),
  CONSTRAINT approvals_expiry_cause_check CHECK (${oneOf("expiry_cause", ["ttl", "next_run"])}),
  CONSTRAINT approvals_decided_chk CHECK (status IN ('pending', 'expired') OR decided_at IS NOT NULL),
  CONSTRAINT approvals_remember_chk CHECK (remember = 0 OR (status = 'approved' AND created_rule_id IS NOT NULL))
);
CREATE INDEX approvals_pending_idx ON approvals (expires_at) WHERE status = 'pending';
CREATE INDEX approvals_status_idx ON approvals (status);

CREATE TABLE policy_decisions (
  id               TEXT    PRIMARY KEY,
  task_id          TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  intent_id        TEXT    REFERENCES action_intents (id) ON DELETE CASCADE,
  subject_kind     TEXT    NOT NULL,
  action_type      TEXT,
  subject          TEXT    NOT NULL,
  counters         TEXT    NOT NULL,
  flags            TEXT    NOT NULL,
  taint            TEXT    NOT NULL DEFAULT '{"sources":[],"tainted":false}',
  decision         TEXT    NOT NULL,
  reason_code      TEXT    NOT NULL,
  matched_rule     TEXT,
  matched_rule_id  TEXT,
  detail           TEXT,
  enforced         INTEGER NOT NULL DEFAULT 1,
  inputs_hash      TEXT    NOT NULL,
  kernel_version   TEXT    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT policy_decisions_subject_kind_check CHECK (${oneOf("subject_kind", ["tool_call", "llm_call", "intent"])}),
  CONSTRAINT policy_decisions_json_check CHECK (json_type(subject) = 'object' AND json_type(counters) = 'object' AND json_type(flags) = 'object' AND json_type(taint) = 'object'),
  CONSTRAINT policy_decisions_decision_check CHECK (${oneOf("decision", ["allow", "deny", "approve", "handoff", "halt"])}),
  CONSTRAINT policy_decisions_matched_rule_id_check CHECK (matched_rule_id IS NULL OR ${len("matched_rule_id", 1, 128)}),
  CONSTRAINT policy_decisions_detail_check CHECK (detail IS NULL OR json_type(detail) = 'object'),
  CONSTRAINT policy_decisions_enforced_check CHECK (${bool("enforced")}),
  CONSTRAINT policy_decisions_inputs_hash_check CHECK (${hex64("inputs_hash")}),
  CONSTRAINT policy_decisions_intent_kind_chk CHECK (subject_kind <> 'intent' OR intent_id IS NOT NULL)
);
CREATE INDEX policy_decisions_intent_idx ON policy_decisions (intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX policy_decisions_rule_time_idx ON policy_decisions (matched_rule_id, created_at) WHERE matched_rule_id IS NOT NULL;
CREATE INDEX policy_decisions_task_time_idx ON policy_decisions (task_id, created_at);

CREATE TABLE usage_records (
  id                        TEXT    PRIMARY KEY,
  task_id                   TEXT    REFERENCES tasks (id),
  agent_id                  TEXT    REFERENCES agents (id),
  ask_id                    TEXT    REFERENCES asks (id),
  provider                  TEXT    NOT NULL,
  model                     TEXT    NOT NULL,
  phase                     TEXT    NOT NULL,
  input_tokens              INTEGER NOT NULL,
  output_tokens             INTEGER NOT NULL,
  estimated_cost_micro_usd  INTEGER NOT NULL,
  cost_micro_usd            INTEGER NOT NULL,
  latency_ms                INTEGER NOT NULL,
  prompt_hash               TEXT    NOT NULL,
  created_at                TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT usage_records_provider_check CHECK (${oneOf("provider", ["google", "anthropic", "deepseek", "openrouter", "openai"])}),
  CONSTRAINT usage_records_model_check CHECK (${len("model", 1, 128)}),
  CONSTRAINT usage_records_phase_check CHECK (${oneOf("phase", [
    "plan", "investigate", "implement", "test", "summarize", "review", "report", "planner", "rehearsal_generate", "rehearsal_interpret", "rehearsal_tighten",
  ])}),
  CONSTRAINT usage_records_counts_check CHECK (input_tokens >= 0 AND output_tokens >= 0 AND estimated_cost_micro_usd >= 0 AND cost_micro_usd >= 0 AND latency_ms >= 0),
  CONSTRAINT usage_records_owner_chk CHECK (task_id IS NOT NULL OR agent_id IS NOT NULL OR ask_id IS NOT NULL)
);
CREATE INDEX usage_records_task_idx ON usage_records (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX usage_records_time_idx ON usage_records (created_at);
`;

const SKILLS_SANDBOX = `
CREATE TABLE skill_proposals (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  status           TEXT NOT NULL,
  name             TEXT,
  description      TEXT,
  body             TEXT,
  reason           TEXT,
  source_task_ids  TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT ${NOW},
  decided_by       TEXT,
  decided_at       TEXT,
  skill_id         TEXT REFERENCES agent_skills (id) ON DELETE SET NULL,
  CONSTRAINT skill_proposals_status_check CHECK (${oneOf("status", ["proposed", "approved", "rejected", "skipped"])}),
  CONSTRAINT skill_proposals_name_check CHECK (name IS NULL OR ${len("name", 1, 60)}),
  CONSTRAINT skill_proposals_description_check CHECK (description IS NULL OR ${len("description", 1, 200)}),
  CONSTRAINT skill_proposals_body_check CHECK (body IS NULL OR ${len("body", 1, 20000)}),
  CONSTRAINT skill_proposals_reason_check CHECK (reason IS NULL OR length(reason) <= 200),
  CONSTRAINT skill_proposals_source_task_ids_check CHECK (json_type(source_task_ids) = 'array'),
  CONSTRAINT skill_proposals_content_chk CHECK (status = 'skipped' OR (name IS NOT NULL AND description IS NOT NULL AND body IS NOT NULL)),
  CONSTRAINT skill_proposals_decided_chk CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL))
);
CREATE INDEX skill_proposals_agent_time_idx ON skill_proposals (agent_id, created_at DESC);
CREATE INDEX skill_proposals_proposed_idx ON skill_proposals (agent_id) WHERE status = 'proposed';

CREATE TABLE agent_skills (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  body             TEXT NOT NULL,
  pack_id          TEXT,
  origin           TEXT NOT NULL DEFAULT 'pack',
  approved_by      TEXT,
  approved_at      TEXT,
  approved_digest  TEXT,
  proposal_id      TEXT REFERENCES skill_proposals (id) ON DELETE SET NULL,
  last_used_at     TEXT,
  removed_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT ${NOW},
  CONSTRAINT agent_skills_name_uq UNIQUE (agent_id, name),
  CONSTRAINT agent_skills_name_check CHECK (${len("name", 1, 60)}),
  CONSTRAINT agent_skills_description_check CHECK (${len("description", 1, 200)}),
  CONSTRAINT agent_skills_body_check CHECK (${len("body", 1, 20000)}),
  CONSTRAINT agent_skills_pack_id_check CHECK (pack_id IS NULL OR ${kebab("pack_id", 2, 40)}),
  CONSTRAINT agent_skills_origin_check CHECK (${oneOf("origin", ["pack", "learned"])}),
  CONSTRAINT agent_skills_approved_digest_check CHECK (approved_digest IS NULL OR (${hex64("approved_digest")})),
  CONSTRAINT agent_skills_learned_chk CHECK (origin <> 'learned' OR (approved_digest IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE agent_evolution_events (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  items             TEXT NOT NULL,
  config_change_id  TEXT REFERENCES agent_config_changes (id),
  created_at        TEXT NOT NULL DEFAULT ${NOW},
  CONSTRAINT agent_evolution_events_kind_check CHECK (kind = 'pruned'),
  CONSTRAINT agent_evolution_events_items_check CHECK (json_type(items) = 'array')
);
CREATE INDEX agent_evolution_events_agent_time_idx ON agent_evolution_events (agent_id, created_at DESC);

CREATE TABLE pack_installs (
  id            TEXT    PRIMARY KEY,
  pack_id       TEXT    NOT NULL UNIQUE,
  pack_version  INTEGER NOT NULL,
  installed_by  TEXT,
  agent_ids     TEXT    NOT NULL DEFAULT '[]',
  created_at    TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT pack_installs_pack_id_check CHECK (${kebab("pack_id", 2, 40)}),
  CONSTRAINT pack_installs_pack_version_check CHECK (pack_version >= 1),
  CONSTRAINT pack_installs_agent_ids_check CHECK (json_type(agent_ids) = 'array')
);

CREATE TABLE sandbox_sessions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  token_hash    BLOB NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'starting',
  provider      TEXT NOT NULL,
  provider_ref  TEXT,
  close_reason  TEXT,
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  last_seen_at  TEXT,
  closed_at     TEXT,
  CONSTRAINT sandbox_sessions_token_hash_check CHECK (length(token_hash) = 32),
  CONSTRAINT sandbox_sessions_status_check CHECK (${oneOf("status", ["starting", "running", "closed"])}),
  CONSTRAINT sandbox_sessions_provider_check CHECK (${len("provider", 1, 40)}),
  CONSTRAINT sandbox_sessions_provider_ref_check CHECK (provider_ref IS NULL OR length(provider_ref) <= 500),
  CONSTRAINT sandbox_sessions_close_reason_check CHECK (close_reason IS NULL OR (${len("close_reason", 1, 40)} AND close_reason NOT GLOB '*[^a-z_]*')),
  CONSTRAINT sandbox_sessions_closed_chk CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX sandbox_sessions_task_open_uq ON sandbox_sessions (task_id) WHERE status <> 'closed';

CREATE TABLE sandbox_commands (
  id           TEXT    PRIMARY KEY,
  session_id   TEXT    NOT NULL REFERENCES sandbox_sessions (id) ON DELETE CASCADE,
  task_id      TEXT    NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  tool         TEXT    NOT NULL,
  args         TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'queued',
  ok           INTEGER,
  output       TEXT,
  exit_code    INTEGER,
  created_at   TEXT    NOT NULL DEFAULT ${NOW},
  started_at   TEXT,
  finished_at  TEXT,
  CONSTRAINT sandbox_commands_tool_check CHECK (${oneOf("tool", ["list_files", "read_file", "search", "write_file", "delete_file", "run_command"])}),
  CONSTRAINT sandbox_commands_args_check CHECK (json_type(args) = 'object'),
  CONSTRAINT sandbox_commands_status_check CHECK (${oneOf("status", ["queued", "running", "done", "expired"])}),
  CONSTRAINT sandbox_commands_ok_check CHECK (ok IS NULL OR ${bool("ok")}),
  CONSTRAINT sandbox_commands_output_check CHECK (output IS NULL OR length(output) <= 200000),
  CONSTRAINT sandbox_commands_done_chk CHECK ((status = 'done') = (ok IS NOT NULL))
);
CREATE INDEX sandbox_commands_session_idx ON sandbox_commands (session_id, created_at);

CREATE TABLE agent_workspace_snapshots (
  id             TEXT    PRIMARY KEY,
  agent_id       TEXT    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  task_id        TEXT    REFERENCES tasks (id) ON DELETE CASCADE,
  source         TEXT    NOT NULL,
  archive        BLOB    NOT NULL,
  files          INTEGER NOT NULL,
  bytes          INTEGER NOT NULL,
  tainted        INTEGER NOT NULL DEFAULT 0,
  taint_sources  TEXT    NOT NULL DEFAULT '[]',
  created_at     TEXT    NOT NULL DEFAULT ${NOW},
  CONSTRAINT agent_workspace_snapshots_source_check CHECK (${oneOf("source", ["task", "pack", "reset"])}),
  CONSTRAINT agent_workspace_snapshots_archive_check CHECK (length(archive) BETWEEN 1 AND 10485760),
  CONSTRAINT agent_workspace_snapshots_counts_check CHECK (files >= 0 AND bytes >= 0),
  CONSTRAINT agent_workspace_snapshots_tainted_check CHECK (${bool("tainted")}),
  CONSTRAINT agent_workspace_snapshots_taint_sources_check CHECK (json_type(taint_sources) = 'array'),
  CONSTRAINT agent_workspace_snapshots_taint_chk CHECK (tainted = 1 OR taint_sources = '[]'),
  CONSTRAINT agent_workspace_snapshots_pack_clean_chk CHECK (source = 'task' OR tainted = 0),
  CONSTRAINT agent_workspace_snapshots_task_chk CHECK ((source = 'task') = (task_id IS NOT NULL))
);
CREATE INDEX agent_workspace_snapshots_agent_idx ON agent_workspace_snapshots (agent_id, created_at DESC);
CREATE INDEX agent_workspace_snapshots_task_idx ON agent_workspace_snapshots (task_id, created_at DESC) WHERE task_id IS NOT NULL;
CREATE TRIGGER agent_workspace_snapshots_immutable BEFORE UPDATE ON agent_workspace_snapshots
  BEGIN SELECT RAISE(ABORT, 'agent_workspace_snapshots cannot be updated'); END;
`;

/** 番号の順に当てる。当てたあとの中身は書き換えない（直すときは新しい番号を足す） */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "init",
    sql: `CREATE TABLE workspace_meta (
            id              INTEGER PRIMARY KEY CHECK (id = 1),
            workspace_id    TEXT    NOT NULL,
            owner_user_id   TEXT    NOT NULL,
            created_at      TEXT    NOT NULL
          )`,
  },
  {
    version: 2,
    name: "workspace_tables",
    sql: [WORKSPACE, AUDIT, CONNECTORS, AGENTS, ASKS, TASKS, INTENTS, SKILLS_SANDBOX].join("\n"),
  },
];
