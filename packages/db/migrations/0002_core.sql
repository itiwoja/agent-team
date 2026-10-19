-- 0002：ポリシー・コネクタ・ツール・エージェント・スナップショット・仕事・設定の変更・依頼・タスク・Intent・承認・判定・費用・
--       ワークスペースのイベント（SSE）・チェック済み・会話・連絡板・冪等性
-- db-schema.md §3.2 の 2・3・5・8 を cross-check の結論（M-07・M-16・M-20・M-25・M-26・M-31〜M-34・M-41・M-47・M-53・M-54・G-05・G-10）で直したもの。
-- ワークスペースの中どうしの参照は (workspace_id, xxx_id) の複合 FK にし、別のワークスペースの行を指せなくする（DB I-41）。
-- 親が独立に消えうる任意の参照だけ ON DELETE SET NULL (列)。それ以外は NO ACTION（RESTRICT は使わない：DB §2）。
-- 後の表（リハーサル・sim）への FK は 0003・0004 で足す。

-- ===================================================================
-- 1. ワークスペースのポリシー（TBL-026。版を行で持つ・追記だけ）
-- ===================================================================
CREATE TABLE workspace_policies (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version       integer     NOT NULL CHECK (version >= 1),
  policy        jsonb       NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  policy_hash   text        NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  -- SET NULL にしない（UPDATE 禁止のトリガーに止められる。DB §3.3 agent_snapshots と同じ理由）
  created_by    uuid        NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_policies_version_uq UNIQUE (workspace_id, version)
);
CREATE TRIGGER workspace_policies_no_update BEFORE UPDATE ON workspace_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- ===================================================================
-- 2. コネクタ・ツール（TBL-027・028。0-H は sim-world のサービスごとのコネクタだけ：BR-64・66）
-- ===================================================================
CREATE TABLE connectors (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug            text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  display_name    text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  kind            text        NOT NULL DEFAULT 'sim' CHECK (kind IN ('sim','mcp_remote')),
  url             text        NOT NULL CHECK (url ~ '^https?://' AND char_length(url) <= 2048),
  auth            jsonb       NOT NULL DEFAULT '{"type":"none"}'
                              CHECK (jsonb_typeof(auth) = 'object' AND auth->>'type' IN ('gcp_id_token','none','api_key','oauth')),
  enabled         boolean     NOT NULL DEFAULT true,
  last_synced_at  timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connectors_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT connectors_ws_slug_uq UNIQUE (workspace_id, slug),
  -- sim-world のコネクタに認証情報を置かない（BR-66、D-11）
  CONSTRAINT connectors_sim_no_secret_chk CHECK (kind <> 'sim' OR auth->>'type' IN ('gcp_id_token','none'))
);

CREATE TABLE connector_tools (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id    uuid        NOT NULL,
  name            text        NOT NULL CHECK (name ~ '^[A-Za-z0-9_.-]{1,64}$'),
  description     text        NOT NULL DEFAULT '',
  input_schema    jsonb       NOT NULL,
  annotations     jsonb       NULL,
  classification  text        NOT NULL DEFAULT 'unclassified' CHECK (classification IN ('read','write','unclassified')),
  status          text        NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','needs_review')),
  -- 引数のパス → 役割。'items[].sku' のような配列の要素の項目も持つ（C-19）
  arg_roles       jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(arg_roles) = 'object'),
  scope           text        NULL CHECK (scope IS NULL OR scope = 'self'),
  verify          text        NOT NULL DEFAULT 'none' CHECK (verify IN ('none','readback')),
  -- tool_hash だけ 'sha256:' の接頭辞つき（M-07）
  tool_hash       text        NOT NULL CHECK (tool_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- needs_review の間だけ、サーバーが新しく返した定義。一覧から消えたツールは needs_review ＋ pending NULL（MT §3.12.4 の5）
  pending         jsonb       NULL CHECK (pending IS NULL OR jsonb_typeof(pending) = 'object'),
  classified_by   text        NULL,
  classified_at   timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_tools_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT connector_tools_connector_fk FOREIGN KEY (workspace_id, connector_id)
    REFERENCES connectors (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT connector_tools_connector_name_uq UNIQUE (connector_id, name),
  CONSTRAINT connector_tools_pending_chk CHECK (pending IS NULL OR status = 'needs_review')
);
CREATE INDEX connector_tools_ws_idx ON connector_tools (workspace_id);

-- ===================================================================
-- 3. エージェント・会話・仕事・依頼（TBL-018・021・023、04ag:242-244・329-332）
-- ===================================================================
CREATE TABLE agents (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- 名前（日本語）から作れないので 'a-' ＋ 乱数8文字（DB I-11）
  slug                 text        NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  name                 text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  name_source          text        NOT NULL DEFAULT 'suggested' CHECK (name_source IN ('user','suggested')),
  role                 text        NULL CHECK (role IS NULL OR role IN ('research','watch','brief','assist','dev')),
  appearance           jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(appearance) = 'object'),
  status               text        NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','active','invalid','disabled','removed')),
  current_snapshot_id  uuid        NULL,
  disabled_by          uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  disabled_reason      text        NULL CHECK (disabled_reason IS NULL OR char_length(disabled_reason) <= 500),
  disabled_at          timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agents_ws_slug_uq UNIQUE (workspace_id, slug),
  CONSTRAINT agents_disabled_chk CHECK (status <> 'disabled' OR disabled_at IS NOT NULL)
);
-- 名前はワークスペースの中で重複できない（removed を除く。FR-034。重なったら末尾に番号を足して作り直す）
CREATE UNIQUE INDEX agents_ws_name_uq ON agents (workspace_id, name) WHERE status <> 'removed';
CREATE INDEX agents_ws_status_idx ON agents (workspace_id, status);

-- 会話（Should。agent_jobs・agent_config_changes の参照先なので表は作る：DB §1）
CREATE TABLE agent_messages (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      uuid        NOT NULL,
  ask_id        uuid        NULL,
  author        text        NOT NULL CHECK (author IN ('user','agent','system')),
  kind          text        NOT NULL CHECK (kind IN ('text','question','connect','confirm','approval','result','change','delegate')),
  body          text        NULL CHECK (body IS NULL OR char_length(body) <= 4000),
  ref_id        uuid        NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_messages_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agent_messages_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id)
);
CREATE INDEX agent_messages_agent_time_idx ON agent_messages (agent_id, created_at DESC);

CREATE TABLE agent_jobs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id           uuid        NOT NULL,
  slug               text        NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  kind               text        NOT NULL CHECK (kind IN ('once','recurring','watch')),
  -- assistant は 0-H でも使う（仕入れ係が数量を決めて発注する。C-31）
  template           text        NOT NULL CHECK (template IN ('researcher','briefer','watcher','assistant')),
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('waiting_input','active','paused','done')),
  source_message_id  uuid        NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_jobs_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agent_jobs_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id),
  CONSTRAINT agent_jobs_source_message_fk FOREIGN KEY (workspace_id, source_message_id)
    REFERENCES agent_messages (workspace_id, id) ON DELETE SET NULL (source_message_id),
  CONSTRAINT agent_jobs_agent_slug_uq UNIQUE (agent_id, slug)
);
CREATE INDEX agent_jobs_ws_status_idx ON agent_jobs (workspace_id, status);

CREATE TABLE asks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by        uuid        NOT NULL REFERENCES users(id),
  -- 秘密情報をマスクして保存。上限 2,000文字（DB I-12）
  text              text        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  mention_agent_id  uuid        NULL,
  shape             text        NULL CHECK (shape IS NULL OR shape IN ('single','parallel','aggregate','chain')),
  status            text        NOT NULL DEFAULT 'generating'
                                CHECK (status IN ('generating','running','waiting_input','done','failed','cancelled')),
  -- 定期のときだけ（編成にトリガーは1つ。04ag:231）。{ type: 'schedule', cron, timezone }
  trigger           jsonb       NULL,
  -- 承認の期限の「次の実行」もこれで決める（M-25）
  next_run_at       timestamptz NULL,
  formation         jsonb       NULL,
  planner_attempts  smallint    NOT NULL DEFAULT 0 CHECK (planner_attempts BETWEEN 0 AND 3),
  question          jsonb       NULL CHECK (question IS NULL OR jsonb_typeof(question) = 'object'),
  question_answer   text        NULL CHECK (question_answer IS NULL OR char_length(question_answer) <= 2000),
  failure_reason    text        NULL CHECK (failure_reason IS NULL OR failure_reason IN
                                  ('formation_invalid','timeout','budget_exceeded','kill_switch','agent_limit','planner_error')),
  seed_key          text        NULL CHECK (seed_key IS NULL OR char_length(seed_key) BETWEEN 1 AND 64),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz NULL,
  CONSTRAINT asks_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT asks_mention_agent_fk FOREIGN KEY (workspace_id, mention_agent_id)
    REFERENCES agents (workspace_id, id) ON DELETE SET NULL (mention_agent_id),
  CONSTRAINT asks_shape_after_generating_chk CHECK (status IN ('generating','failed','cancelled') OR shape IS NOT NULL),
  CONSTRAINT asks_failure_reason_chk CHECK (failure_reason IS NULL OR status = 'failed'),
  CONSTRAINT asks_generation_failed_chk CHECK (NOT (status = 'failed' AND shape IS NULL) OR failure_reason IS NOT NULL),
  CONSTRAINT asks_trigger_chk CHECK (trigger IS NULL OR jsonb_typeof(trigger) = 'object'),
  CONSTRAINT asks_next_run_needs_trigger_chk CHECK (next_run_at IS NULL OR trigger IS NOT NULL)
);
CREATE INDEX asks_ws_time_idx   ON asks (workspace_id, created_at DESC);
CREATE INDEX asks_ws_status_idx ON asks (workspace_id, status);
CREATE INDEX asks_due_idx       ON asks (next_run_at) WHERE next_run_at IS NOT NULL;
CREATE UNIQUE INDEX asks_seed_key_uq ON asks (workspace_id, seed_key) WHERE seed_key IS NOT NULL;

ALTER TABLE agent_messages ADD CONSTRAINT agent_messages_ask_fk
  FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id) ON DELETE SET NULL (ask_id);

-- 編成の1回の実行（DB【案】、C-26）。定期の依頼は実行ごとに回答を1つ（04ag:272）
-- M-33：answer・first_member_started_at・trigger_type の initial。M-47：リハーサルの実行は mode = 'rehearsal' と走行・状況を持つ
-- 「チェック済み」は check_marks に置く（M-54）ので checked_at 列は持たない
CREATE TABLE ask_runs (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ask_id                   uuid        NOT NULL,
  run_no                   integer     NOT NULL CHECK (run_no >= 1),
  mode                     text        NOT NULL DEFAULT 'live' CHECK (mode IN ('live','rehearsal')),
  rehearsal_run_id         uuid        NULL,
  rehearsal_scenario_id    uuid        NULL,
  trigger_type             text        NOT NULL CHECK (trigger_type IN ('initial','manual','schedule','resume')),
  status                   text        NOT NULL DEFAULT 'running' CHECK (status IN ('running','waiting_input','done','failed','cancelled')),
  answer_task_id           uuid        NULL,
  answer                   jsonb       NULL,
  answer_hash              text        NULL CHECK (answer_hash IS NULL OR answer_hash ~ '^[0-9a-f]{64}$'),
  answered_at              timestamptz NULL,
  first_member_started_at  timestamptz NULL,
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz NULL,
  CONSTRAINT ask_runs_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT ask_runs_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ask_runs_answer_chk CHECK (answer_task_id IS NULL OR answered_at IS NOT NULL),
  CONSTRAINT ask_runs_answer_body_chk CHECK (answer IS NULL OR answered_at IS NOT NULL),
  CONSTRAINT ask_runs_mode_chk CHECK ((mode = 'rehearsal') = (rehearsal_run_id IS NOT NULL)),
  CONSTRAINT ask_runs_scenario_chk CHECK ((rehearsal_run_id IS NULL) = (rehearsal_scenario_id IS NULL))
);
-- 回数は本番の実行だけで数える（リハーサルの実行で番号が飛ばないように）
CREATE UNIQUE INDEX ask_runs_live_no_uq ON ask_runs (ask_id, run_no) WHERE mode = 'live';
CREATE INDEX ask_runs_ws_answered_idx ON ask_runs (workspace_id, answered_at DESC) WHERE answered_at IS NOT NULL;
CREATE INDEX ask_runs_ask_idx ON ask_runs (ask_id, started_at DESC);

CREATE TABLE ask_members (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ask_id           uuid        NOT NULL,
  agent_id         uuid        NOT NULL,
  job_id           uuid        NOT NULL,
  -- 順番の段（1始まり）。並列・まとめの担当と、まとめ役は NULL でもよい
  position         smallint    NULL CHECK (position IS NULL OR position BETWEEN 1 AND 6),
  -- 前の段の番号（M-34：ask_members.id ではなく段の番号）
  depends_on       smallint[]  NOT NULL DEFAULT '{}' CHECK (depends_on <@ '{1,2,3,4,5,6}'::smallint[]),
  is_aggregator    boolean     NOT NULL DEFAULT false,
  is_spokesperson  boolean     NOT NULL DEFAULT false,
  is_new           boolean     NOT NULL,
  summary          text        NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ask_members_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT ask_members_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ask_members_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id),
  CONSTRAINT ask_members_job_fk FOREIGN KEY (workspace_id, job_id) REFERENCES agent_jobs (workspace_id, id),
  CONSTRAINT ask_members_agent_uq UNIQUE (ask_id, agent_id),
  -- 依頼のたびに担当に仕事を足すので、仕事と担当は1対1（04ag:191）
  CONSTRAINT ask_members_job_uq UNIQUE (job_id)
);
-- 窓口・まとめ役は依頼に高々1つ（「ちょうど1つ」は validateFormation が守る）
CREATE UNIQUE INDEX ask_members_spokesperson_uq ON ask_members (ask_id) WHERE is_spokesperson;
CREATE UNIQUE INDEX ask_members_aggregator_uq   ON ask_members (ask_id) WHERE is_aggregator;
CREATE UNIQUE INDEX ask_members_position_uq     ON ask_members (ask_id, position) WHERE position IS NOT NULL;

-- 設定の変更（TBL-025）。締める提案（rehearsal_tighten）は narrow だけ
CREATE TABLE agent_config_changes (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id           uuid        NOT NULL,
  job_id             uuid        NULL,
  origin             text        NOT NULL CHECK (origin IN ('user_request','feedback','failure','engagement','manual',
                                   'revert','move','approval_rule','ask','rehearsal_tighten')),
  source_message_id  uuid        NULL,
  source_task_id     uuid        NULL,
  source_ask_id      uuid        NULL,
  rehearsal_run_id   uuid        NULL,
  patch              jsonb       NOT NULL CHECK (jsonb_typeof(patch) = 'array'),
  classification     text        NOT NULL CHECK (classification IN ('narrow','neutral','widen')),
  widened_items      jsonb       NULL,
  status             text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','rejected','reverted')),
  decided_by         uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  snapshot_id        uuid        NULL,
  reverts_change_id  uuid        NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz NULL,
  CONSTRAINT agent_config_changes_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agent_config_changes_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id),
  CONSTRAINT agent_config_changes_job_fk FOREIGN KEY (workspace_id, job_id) REFERENCES agent_jobs (workspace_id, id),
  CONSTRAINT agent_config_changes_source_message_fk FOREIGN KEY (workspace_id, source_message_id)
    REFERENCES agent_messages (workspace_id, id) ON DELETE SET NULL (source_message_id),
  CONSTRAINT agent_config_changes_source_ask_fk FOREIGN KEY (workspace_id, source_ask_id)
    REFERENCES asks (workspace_id, id) ON DELETE SET NULL (source_ask_id),
  CONSTRAINT agent_config_changes_reverts_fk FOREIGN KEY (workspace_id, reverts_change_id)
    REFERENCES agent_config_changes (workspace_id, id),
  CONSTRAINT agent_config_changes_applied_chk CHECK (status NOT IN ('applied','reverted') OR snapshot_id IS NOT NULL),
  CONSTRAINT agent_config_changes_widen_chk CHECK (classification <> 'widen' OR widened_items IS NOT NULL),
  CONSTRAINT agent_config_changes_decided_chk CHECK (status = 'proposed' OR decided_at IS NOT NULL),
  CONSTRAINT agent_config_changes_tighten_chk CHECK (origin <> 'rehearsal_tighten' OR (classification = 'narrow' AND rehearsal_run_id IS NOT NULL))
);
CREATE INDEX agent_config_changes_agent_time_idx ON agent_config_changes (agent_id, created_at DESC);
CREATE INDEX agent_config_changes_proposed_idx ON agent_config_changes (workspace_id) WHERE status = 'proposed';

-- スナップショット（TBL-019。UPDATE 禁止。ルール rules[] とガード jobs[].guards[] の正本は definition：C-21）
-- effective_policies は「仕事の slug → { policy, hash }」（D-19）。この表から出る FK に ON DELETE SET NULL を付けない
CREATE TABLE agent_snapshots (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id            uuid        NOT NULL,
  config_change_id    uuid        NULL,
  source              text        NOT NULL DEFAULT 'in_app' CHECK (source IN ('in_app','gitops')),
  status              text        NOT NULL CHECK (status IN ('valid','invalid')),
  definition          jsonb       NULL CHECK (definition IS NULL OR jsonb_typeof(definition) = 'object'),
  effective_policies  jsonb       NULL CHECK (effective_policies IS NULL OR jsonb_typeof(effective_policies) = 'object'),
  clamped             jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(clamped) = 'array'),
  ceilings_version    text        NOT NULL,
  errors              jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors) = 'array'),
  warnings            jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings) = 'array'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_snapshots_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agent_snapshots_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id),
  CONSTRAINT agent_snapshots_config_change_fk FOREIGN KEY (workspace_id, config_change_id)
    REFERENCES agent_config_changes (workspace_id, id),
  CONSTRAINT agent_snapshots_valid_chk CHECK (status <> 'valid' OR (definition IS NOT NULL AND effective_policies IS NOT NULL))
);
CREATE INDEX agent_snapshots_agent_time_idx ON agent_snapshots (agent_id, created_at DESC);
CREATE TRIGGER agent_snapshots_no_update BEFORE UPDATE ON agent_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_update();

-- 同じトランザクションでエージェントとスナップショットを作るため DEFERRABLE（DB §3.2）
ALTER TABLE agents ADD CONSTRAINT agents_current_snapshot_fk
  FOREIGN KEY (workspace_id, current_snapshot_id) REFERENCES agent_snapshots (workspace_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE agent_config_changes ADD CONSTRAINT agent_config_changes_snapshot_fk
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES agent_snapshots (workspace_id, id);

-- ===================================================================
-- 4. タスク（TBL-006）
-- 本番とリハーサルを混ぜない：rehearsal_run_id・rehearsal_scenario_id・shadow・sim_execution_id・execution_variant は
-- リハーサルの実行だけが入れる（BR-67①、D-62）。リハーサル・sim への FK は 0003・0004 で足す
-- ===================================================================
CREATE TABLE tasks (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_id           uuid          NOT NULL REFERENCES users(id),
  agent_id               uuid          NOT NULL,
  agent_snapshot_id      uuid          NOT NULL,
  job_id                 uuid          NOT NULL,
  config_change_id       uuid          NULL,
  ask_id                 uuid          NULL,
  ask_run_id             uuid          NULL,
  ask_member_id          uuid          NULL,
  input_task_ids         uuid[]        NOT NULL DEFAULT '{}',
  input_message_ids      uuid[]        NOT NULL DEFAULT '{}',
  parent_task_id         uuid          NULL,
  kind                   text          NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','followup','revise')),
  -- 依頼から動くタスクは 'ask'、リハーサル・試し実行は 'dry_run'（M-32）
  trigger_type           text          NOT NULL CHECK (trigger_type IN ('manual','schedule','dry_run','ask')),
  is_dry_run             boolean       NOT NULL DEFAULT false,
  rehearsal_run_id       uuid          NULL,
  rehearsal_scenario_id  uuid          NULL,
  shadow                 boolean       NOT NULL DEFAULT false,
  -- M-41：リハーサルのタスクが動く sim の走行と種類。本番は NULL か 'live'（デモ店舗は (workspace_id, world) で引く）
  sim_execution_id       uuid          NULL,
  execution_variant      text          NULL CHECK (execution_variant IS NULL OR execution_variant IN ('live','governed','governed_approve','shadow')),
  -- 本番のタスクの開始時のデモ店舗のスナップショット（FR-066・G-07）
  sim_snapshot_id        uuid          NULL,
  prompt                 text          NULL CHECK (prompt IS NULL OR char_length(prompt) <= 2000),
  output_type            text          NOT NULL DEFAULT 'report' CHECK (output_type IN ('report')),
  report                 text          NULL CHECK (report IS NULL OR char_length(report) <= 50000),
  report_title           text          NULL CHECK (report_title IS NULL OR char_length(report_title) <= 256),
  report_kind            text          NULL CHECK (report_kind IS NULL OR report_kind IN ('normal','answer')),
  -- 出典（BR-45、M-31。runner の ReportSource[]）
  report_sources         jsonb         NULL,
  tainted                boolean       NOT NULL DEFAULT false,
  taint_sources          jsonb         NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(taint_sources) = 'array'),
  status                 text          NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','provisioning','running',
                                         'awaiting_approval','executing','succeeded','completed','rejected','failed','cancelled','halted')),
  halt_reason            text          NULL CHECK (halt_reason IS NULL OR halt_reason IN ('budget_exceeded','breaker_tripped',
                                         'timeout','kill_switch','policy_violation','approval_expired','agent_disabled')),
  -- sandbox_lost は status.md:53 の値（M-32）
  fail_reason            text          NULL CHECK (fail_reason IS NULL OR fail_reason IN ('sandbox_lost','llm_unavailable',
                                         'precondition_failed','agent_no_change','agent_unable','action_failed')),
  -- completed の内訳（dry_run / report / actions_declined）と cancelled の policy_narrowed（D-46）・user
  status_detail          text          NULL CHECK (status_detail IS NULL OR status_detail ~ '^[a-z_]{1,40}$'),
  steps_used             integer       NOT NULL DEFAULT 0 CHECK (steps_used >= 0),
  cost_usd               numeric(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  denied_count           integer       NOT NULL DEFAULT 0 CHECK (denied_count >= 0),
  repeat_key             text          NULL CHECK (repeat_key IS NULL OR repeat_key ~ '^[0-9a-f]{64}$'),
  repeat_count           integer       NOT NULL DEFAULT 0 CHECK (repeat_count >= 0),
  -- タスク単位の Bearer トークンの SHA-256（gateway・edge はこれでタスクとワークスペースを引き直す：15:486）
  task_token_hash        bytea         NULL CHECK (task_token_hash IS NULL OR octet_length(task_token_hash) = 32),
  task_token_expires_at  timestamptz   NULL,
  last_heartbeat_at      timestamptz   NULL,
  queued_at              timestamptz   NOT NULL DEFAULT now(),
  started_at             timestamptz   NULL,
  finished_at            timestamptz   NULL,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT tasks_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT tasks_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id),
  CONSTRAINT tasks_agent_snapshot_fk FOREIGN KEY (workspace_id, agent_snapshot_id) REFERENCES agent_snapshots (workspace_id, id),
  CONSTRAINT tasks_job_fk FOREIGN KEY (workspace_id, job_id) REFERENCES agent_jobs (workspace_id, id),
  CONSTRAINT tasks_config_change_fk FOREIGN KEY (workspace_id, config_change_id) REFERENCES agent_config_changes (workspace_id, id),
  CONSTRAINT tasks_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id),
  CONSTRAINT tasks_ask_run_fk FOREIGN KEY (workspace_id, ask_run_id) REFERENCES ask_runs (workspace_id, id),
  CONSTRAINT tasks_ask_member_fk FOREIGN KEY (workspace_id, ask_member_id) REFERENCES ask_members (workspace_id, id),
  CONSTRAINT tasks_parent_fk FOREIGN KEY (workspace_id, parent_task_id) REFERENCES tasks (workspace_id, id),
  CONSTRAINT tasks_shadow_only_rehearsal_chk   CHECK (NOT shadow OR rehearsal_run_id IS NOT NULL),
  CONSTRAINT tasks_rehearsal_is_dry_run_chk    CHECK (rehearsal_run_id IS NULL OR is_dry_run),
  CONSTRAINT tasks_dry_run_trigger_chk         CHECK (is_dry_run = (trigger_type = 'dry_run')),
  CONSTRAINT tasks_rehearsal_scenario_chk      CHECK ((rehearsal_run_id IS NULL) = (rehearsal_scenario_id IS NULL)),
  -- 本番のタスクは live（か NULL）、リハーサルのタスクは governed / governed_approve / shadow（M-41）
  CONSTRAINT tasks_execution_variant_chk       CHECK ((rehearsal_run_id IS NULL) = (execution_variant IS NULL OR execution_variant = 'live')),
  CONSTRAINT tasks_shadow_variant_chk          CHECK (shadow = (execution_variant IS NOT DISTINCT FROM 'shadow')),
  CONSTRAINT tasks_followup_parent_chk         CHECK (kind = 'normal' OR parent_task_id IS NOT NULL),
  CONSTRAINT tasks_ask_run_chk                 CHECK (ask_run_id IS NULL OR ask_id IS NOT NULL),
  CONSTRAINT tasks_ask_member_chk              CHECK (ask_member_id IS NULL OR ask_id IS NOT NULL),
  CONSTRAINT tasks_live_snapshot_chk           CHECK (sim_snapshot_id IS NULL OR rehearsal_run_id IS NULL),
  CONSTRAINT tasks_report_kind_chk             CHECK ((report IS NULL) = (report_kind IS NULL)),
  CONSTRAINT tasks_report_sources_chk          CHECK (report_sources IS NULL OR (report IS NOT NULL AND jsonb_typeof(report_sources) = 'array')),
  CONSTRAINT tasks_halt_reason_chk             CHECK ((status = 'halted') = (halt_reason IS NOT NULL)),
  CONSTRAINT tasks_fail_reason_chk             CHECK ((status = 'failed') = (fail_reason IS NOT NULL)),
  CONSTRAINT tasks_finished_chk                CHECK ((status IN ('succeeded','completed','rejected','failed','cancelled','halted')) = (finished_at IS NOT NULL)),
  CONSTRAINT tasks_taint_chk                   CHECK (tainted OR taint_sources = '[]'::jsonb)
);
CREATE UNIQUE INDEX tasks_task_token_hash_uq ON tasks (task_token_hash) WHERE task_token_hash IS NOT NULL;
CREATE INDEX tasks_ws_status_idx    ON tasks (workspace_id, status);
CREATE INDEX tasks_ws_time_idx      ON tasks (workspace_id, created_at DESC);
CREATE INDEX tasks_agent_time_idx   ON tasks (agent_id, created_at DESC);
CREATE INDEX tasks_job_time_idx     ON tasks (job_id, created_at DESC);
CREATE INDEX tasks_ask_run_idx      ON tasks (ask_run_id) WHERE ask_run_id IS NOT NULL;
CREATE INDEX tasks_rehearsal_idx    ON tasks (rehearsal_run_id) WHERE rehearsal_run_id IS NOT NULL;
CREATE INDEX tasks_scenario_idx     ON tasks (rehearsal_scenario_id, shadow) WHERE rehearsal_scenario_id IS NOT NULL;
CREATE INDEX tasks_sim_execution_idx ON tasks (sim_execution_id) WHERE sim_execution_id IS NOT NULL;
CREATE INDEX tasks_ws_active_idx    ON tasks (workspace_id) WHERE status IN ('provisioning','running');
CREATE INDEX tasks_job_live_idx     ON tasks (job_id, status) WHERE rehearsal_run_id IS NULL;

-- 一度汚染したタスクは汚染なしに戻さない（BR-38）
CREATE FUNCTION tasks_taint_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tainted AND NOT NEW.tainted THEN
    RAISE EXCEPTION 'tasks.tainted cannot go back to false';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tasks_taint_monotonic BEFORE UPDATE OF tainted ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_taint_monotonic();

ALTER TABLE ask_runs ADD CONSTRAINT ask_runs_answer_task_fk
  FOREIGN KEY (workspace_id, answer_task_id) REFERENCES tasks (workspace_id, id) ON DELETE SET NULL (answer_task_id);
ALTER TABLE agent_config_changes ADD CONSTRAINT agent_config_changes_source_task_fk
  FOREIGN KEY (workspace_id, source_task_id) REFERENCES tasks (workspace_id, id) ON DELETE SET NULL (source_task_id);

CREATE TABLE task_events (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id       uuid        NOT NULL,
  type          text        NOT NULL CHECK (type IN ('phase_started','tool_called','llm_called','status_changed','budget_updated','message','finished')),
  payload       jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_events_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX task_events_task_idx ON task_events (task_id, id);

-- ===================================================================
-- 5. Intent・承認・判定（TBL-008〜010）
-- ===================================================================
CREATE TABLE action_intents (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id             uuid        NOT NULL,
  -- BR-68 は仕事単位なので NOT NULL
  job_id              uuid        NOT NULL,
  connector_id        uuid        NOT NULL,
  action_type         text        NOT NULL DEFAULT 'mcp_call' CHECK (action_type IN ('mcp_call')),
  action              text        NOT NULL CHECK (action ~ '^mcp\.[a-z0-9][a-z0-9-]{1,31}\.[A-Za-z0-9_.-]{1,64}$'),
  origin              text        NOT NULL CHECK (origin IN ('agent','deliver')),
  payload             jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  tool_hash           text        NOT NULL CHECK (tool_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- destinationKey・optionDigest は接頭辞なしの小文字64桁（M-07・G-05）
  destination_key     text        NOT NULL CHECK (destination_key ~ '^[0-9a-f]{64}$'),
  option_digest       text        NOT NULL CHECK (option_digest ~ '^[0-9a-f]{64}$'),
  taint_snapshot      jsonb       NOT NULL DEFAULT '{"tainted":false,"sources":[]}' CHECK (jsonb_typeof(taint_snapshot) = 'object'),
  status              text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','simulated','denied',
                                    'pending_approval','approved','rejected','expired','executing','executed','verified',
                                    'failed','unknown_outcome')),
  decision            text        NOT NULL CHECK (decision IN ('allow','deny','approve','handoff','halt')),
  reason_code         text        NOT NULL,
  matched_rule        text        NULL,
  -- 判定の detail（承認カードの「いつもの上限（20個）を超えています：200個」の材料。G-10、AS:420）
  decision_detail     jsonb       NULL CHECK (decision_detail IS NULL OR jsonb_typeof(decision_detail) = 'object'),
  -- 影の走行は false（BR-67③）
  enforced            boolean     NOT NULL DEFAULT true,
  policy_hash         text        NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  intent_hash         text        NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  expires_at          timestamptz NULL,
  fail_reason         text        NULL CHECK (fail_reason IS NULL OR fail_reason IN ('tool_error','unreachable','auth_required',
                                    'precondition_failed','confirmed_not_delivered')),
  -- policy_changed は M-20（実行の前の再判定で deny）
  expire_reason       text        NULL CHECK (expire_reason IS NULL OR expire_reason IN ('approval_timeout','superseded',
                                    'tool_changed','task_cancelled','kill_switch','task_ended','rehearsal_end','policy_changed')),
  resolution          text        NULL CHECK (resolution IS NULL OR resolution IN ('confirmed_delivered','confirmed_not_delivered','retried')),
  retry_of_intent_id  uuid        NULL,
  -- 送信前の失敗の再試行（D-18。最大3回）
  presend_attempts    smallint    NOT NULL DEFAULT 0 CHECK (presend_attempts BETWEEN 0 AND 3),
  result              jsonb       NULL,
  executed_at         timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_intents_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT action_intents_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT action_intents_job_fk FOREIGN KEY (workspace_id, job_id) REFERENCES agent_jobs (workspace_id, id),
  CONSTRAINT action_intents_connector_fk FOREIGN KEY (workspace_id, connector_id) REFERENCES connectors (workspace_id, id),
  CONSTRAINT action_intents_retry_of_fk FOREIGN KEY (workspace_id, retry_of_intent_id) REFERENCES action_intents (workspace_id, id),
  CONSTRAINT action_intents_pending_expiry_chk CHECK (status <> 'pending_approval' OR expires_at IS NOT NULL),
  CONSTRAINT action_intents_fail_reason_chk    CHECK ((status = 'failed') = (fail_reason IS NOT NULL)),
  CONSTRAINT action_intents_expire_reason_chk  CHECK ((status = 'expired') = (expire_reason IS NOT NULL)),
  CONSTRAINT action_intents_executed_chk       CHECK (status NOT IN ('executed','verified') OR executed_at IS NOT NULL
                                                       OR resolution IS NOT DISTINCT FROM 'confirmed_delivered')
);
CREATE INDEX action_intents_ws_status_idx ON action_intents (workspace_id, status);
CREATE INDEX action_intents_task_idx      ON action_intents (task_id);
-- counters.unknownOutcomeKeys（BR-68、D-61）
CREATE INDEX action_intents_unknown_idx   ON action_intents (job_id, destination_key) WHERE status = 'unknown_outcome';
CREATE INDEX action_intents_job_dest_idx  ON action_intents (job_id, destination_key);
CREATE INDEX action_intents_pending_idx   ON action_intents (expires_at) WHERE status = 'pending_approval';
CREATE INDEX action_intents_executing_idx ON action_intents (updated_at) WHERE status = 'executing';

-- 承認。リハーサル・影のタスクは承認の行を作らない（DB §4.6）
CREATE TABLE approvals (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id            uuid        NOT NULL,
  intent_id          uuid        NOT NULL,
  status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  risk_level         text        NOT NULL CHECK (risk_level IN ('low','medium','high')),
  risk_score         integer     NOT NULL,
  risk_reasons       jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(risk_reasons) = 'array'),
  approver_ids       uuid[]      NOT NULL CHECK (cardinality(approver_ids) >= 1),
  decided_by         uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  decision_comment   text        NULL CHECK (decision_comment IS NULL OR char_length(decision_comment) <= 1000),
  decided_at         timestamptz NULL,
  remember           boolean     NOT NULL DEFAULT false,
  created_rule_id    text        NULL CHECK (created_rule_id IS NULL OR created_rule_id ~ '^r-[0-9a-z]{4,32}$'),
  expires_at         timestamptz NOT NULL,
  -- 期限が A-05 の24時間か、依頼の次の実行（M-25）か
  expiry_cause       text        NOT NULL DEFAULT 'ttl' CHECK (expiry_cause IN ('ttl','next_run')),
  -- BR-70 の「初めての宛先」を作成時に固定
  first_destination  boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT approvals_intent_fk FOREIGN KEY (workspace_id, intent_id) REFERENCES action_intents (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT approvals_intent_uq UNIQUE (intent_id),
  CONSTRAINT approvals_decided_chk CHECK (status IN ('pending','expired') OR decided_at IS NOT NULL),
  CONSTRAINT approvals_remember_chk CHECK (NOT remember OR (status = 'approved' AND created_rule_id IS NOT NULL))
);
CREATE INDEX approvals_pending_idx   ON approvals (status, expires_at) WHERE status = 'pending';
CREATE INDEX approvals_ws_status_idx ON approvals (workspace_id, status);

-- 判定の記録（NFR-036 の「入力をすべて保存」：taint・flags.certificateValid・detail）
CREATE TABLE policy_decisions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id         uuid        NOT NULL,
  intent_id       uuid        NULL,
  subject_kind    text        NOT NULL CHECK (subject_kind IN ('tool_call','llm_call','intent')),
  -- DecideResult.operation（M-15）
  action_type     text        NULL,
  subject         jsonb       NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
  counters        jsonb       NOT NULL CHECK (jsonb_typeof(counters) = 'object'),
  flags           jsonb       NOT NULL CHECK (jsonb_typeof(flags) = 'object'),
  taint           jsonb       NOT NULL DEFAULT '{"tainted":false,"sources":[]}' CHECK (jsonb_typeof(taint) = 'object'),
  decision        text        NOT NULL CHECK (decision IN ('allow','deny','approve','handoff','halt')),
  reason_code     text        NOT NULL,
  matched_rule    text        NULL,
  detail          jsonb       NULL CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
  enforced        boolean     NOT NULL DEFAULT true,
  inputs_hash     text        NOT NULL CHECK (inputs_hash ~ '^[0-9a-f]{64}$'),
  kernel_version  text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_decisions_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT policy_decisions_intent_fk FOREIGN KEY (workspace_id, intent_id) REFERENCES action_intents (workspace_id, id) ON DELETE CASCADE,
  -- M-16：tool_call の判定で Intent を作ることがある（M-14）ので、intent 以外にも intent_id を入れられる
  CONSTRAINT policy_decisions_intent_kind_chk CHECK (subject_kind <> 'intent' OR intent_id IS NOT NULL)
);
CREATE INDEX policy_decisions_task_time_idx ON policy_decisions (task_id, created_at);
CREATE INDEX policy_decisions_intent_idx ON policy_decisions (intent_id) WHERE intent_id IS NOT NULL;

-- ===================================================================
-- 6. 費用（TBL-011）。持ち主は task・agent・ask・rehearsal_run のどれか1つ以上（C-17）
-- ===================================================================
CREATE TABLE usage_records (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id             uuid          NULL,
  agent_id            uuid          NULL,
  ask_id              uuid          NULL,
  rehearsal_run_id    uuid          NULL,
  provider            text          NOT NULL CHECK (provider IN ('google','anthropic','openai','openrouter')),
  model               text          NOT NULL CHECK (char_length(model) BETWEEN 1 AND 128),
  -- runner・FR の LlmPhase（M-32）＋設定プランナー・リハーサルの生成・解釈・締める提案
  phase               text          NOT NULL CHECK (phase IN ('plan','investigate','implement','test','summarize','review','report',
                                      'planner','rehearsal_generate','rehearsal_interpret','rehearsal_tighten')),
  input_tokens        integer       NOT NULL CHECK (input_tokens >= 0),
  output_tokens       integer       NOT NULL CHECK (output_tokens >= 0),
  estimated_cost_usd  numeric(12,6) NOT NULL CHECK (estimated_cost_usd >= 0),
  cost_usd            numeric(12,6) NOT NULL CHECK (cost_usd >= 0),
  latency_ms          integer       NOT NULL CHECK (latency_ms >= 0),
  prompt_hash         text          NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT usage_records_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  CONSTRAINT usage_records_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id),
  CONSTRAINT usage_records_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id),
  CONSTRAINT usage_records_owner_chk CHECK (num_nonnulls(task_id, agent_id, ask_id, rehearsal_run_id) >= 1)
);
CREATE INDEX usage_records_ws_time_idx ON usage_records (workspace_id, created_at);
-- 全体の1日 $10（BR-62）を数える
CREATE INDEX usage_records_time_idx    ON usage_records (created_at);
CREATE INDEX usage_records_task_idx    ON usage_records (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX usage_records_run_idx     ON usage_records (rehearsal_run_id) WHERE rehearsal_run_id IS NOT NULL;

-- ===================================================================
-- 7. 連絡板（Should。BR-75〜77）
-- ===================================================================
CREATE TABLE ask_messages (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ask_id           uuid        NOT NULL,
  ask_run_id       uuid        NULL,
  from_member      uuid        NOT NULL,
  to_member        uuid        NULL,
  kind             text        NOT NULL CHECK (kind IN ('share','question','reply','revise')),
  body             text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  in_reply_to      uuid        NULL,
  tainted          boolean     NOT NULL,
  from_task_id     uuid        NOT NULL,
  rejected_reason  text        NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ask_messages_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT ask_messages_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ask_messages_ask_run_fk FOREIGN KEY (workspace_id, ask_run_id) REFERENCES ask_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ask_messages_from_member_fk FOREIGN KEY (workspace_id, from_member) REFERENCES ask_members (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ask_messages_to_member_fk FOREIGN KEY (workspace_id, to_member) REFERENCES ask_members (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ask_messages_in_reply_to_fk FOREIGN KEY (workspace_id, in_reply_to)
    REFERENCES ask_messages (workspace_id, id) ON DELETE SET NULL (in_reply_to),
  CONSTRAINT ask_messages_from_task_fk FOREIGN KEY (workspace_id, from_task_id) REFERENCES tasks (workspace_id, id),
  CONSTRAINT ask_messages_reply_chk CHECK (kind <> 'reply' OR in_reply_to IS NOT NULL)
);
CREATE INDEX ask_messages_ask_time_idx ON ask_messages (ask_id, created_at);

-- ===================================================================
-- 8. ワークスペースのイベント（SSE。M-53、AS 8-4）と「チェック済み」（M-54、AS 8-5）
-- ===================================================================
-- SSE の1本（EP-45）。NOTIFY には id だけを載せ、本体はこの行から読む。24時間で掃除が消す
CREATE TABLE workspace_events (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type          text        NOT NULL CHECK (type ~ '^[a-z_]+(\.[a-z_]+)*$' AND char_length(type) <= 64),
  data          jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_events_ws_id_idx ON workspace_events (workspace_id, id);
CREATE INDEX workspace_events_time_idx  ON workspace_events (created_at);

-- 報告の行のチェック済み。行のキーは '<種類>:<UUID>'（answer / rehearsal / incident_added / task）
CREATE TABLE check_marks (
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  item_key      text        NOT NULL CHECK (item_key ~ '^[a-z_]{1,32}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  checked_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_marks_pk PRIMARY KEY (workspace_id, item_key)
);
CREATE INDEX check_marks_ws_time_idx ON check_marks (workspace_id, checked_at DESC);

-- ===================================================================
-- 9. 冪等性（API-019・020 の Idempotency-Key。Should）。24時間で掃除が消す
-- ===================================================================
CREATE TABLE idempotency_keys (
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key              uuid        NOT NULL,
  method           text        NOT NULL,
  path             text        NOT NULL,
  request_hash     text        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status  integer     NOT NULL,
  response_body    jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_pk PRIMARY KEY (workspace_id, key)
);
CREATE INDEX idempotency_keys_time_idx ON idempotency_keys (created_at);
