-- 実装できるエージェントとパック（10/14・D-116）
-- 1. 作業場（サンドボックス）：タスクごとに使い捨ての実行役（executor）が、edge が積んだコマンドを取りに来て実行し、結果を返す。
--    判定は edge（Kernel の decide）で済ませ、作業場は許されたコマンドだけを受け取る（ADR-003 の非協調的な強制をさらに固くした形）。
--    sandbox_sessions：作業場1つ（タスクに1つ）。token_hash は作業場のトークンの SHA-256（タスクのトークンとは別。作業場は LLM を呼べない）
--    sandbox_commands：edge が積んだコマンド（作業場が順に取り、結果を書く）
-- 2. 作業場のファイルの控え（agent_workspace_snapshots）：担当ごとの最新の控えが、次の作業場の最初の中身になる（ADR-020 の簡易版）。
--    タスクの成果のダウンロードにも使う。tar.gz（10MB まで）
-- 3. スキル（agent_skills）：担当が load_skill で読む手順書（Markdown）。パックで入る
-- 4. 入れたパック（pack_installs）：同じパックを2度入れない・入れた担当を辿る

-- 実装の担当（dev-coder・reviewer）の仕事を置けるようにする（0002 の CHECK は汎用の4つだけ）
ALTER TABLE agent_jobs DROP CONSTRAINT agent_jobs_template_check;
ALTER TABLE agent_jobs ADD CONSTRAINT agent_jobs_template_check CHECK (template IN ('researcher','briefer','watcher','assistant','dev-coder','reviewer'));

CREATE TABLE sandbox_sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id       uuid        NOT NULL,
  agent_id      uuid        NOT NULL,
  token_hash    bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  status        text        NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','running','closed')),
  provider      text        NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  provider_ref  text        NULL CHECK (provider_ref IS NULL OR char_length(provider_ref) <= 500),
  close_reason  text        NULL CHECK (close_reason IS NULL OR close_reason ~ '^[a-z_]{1,40}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NULL,
  closed_at     timestamptz NULL,
  CONSTRAINT sandbox_sessions_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT sandbox_sessions_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sandbox_sessions_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sandbox_sessions_closed_chk CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
-- タスクに開いている作業場は1つだけ
CREATE UNIQUE INDEX sandbox_sessions_task_open_uq ON sandbox_sessions (task_id) WHERE status <> 'closed';
CREATE UNIQUE INDEX sandbox_sessions_token_uq ON sandbox_sessions (token_hash);

CREATE TABLE sandbox_commands (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id    uuid        NOT NULL,
  task_id       uuid        NOT NULL,
  tool          text        NOT NULL CHECK (tool IN ('list_files','read_file','search','write_file','delete_file','run_command')),
  args          jsonb       NOT NULL CHECK (jsonb_typeof(args) = 'object'),
  status        text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','expired')),
  ok            boolean     NULL,
  output        text        NULL CHECK (output IS NULL OR char_length(output) <= 200000),
  exit_code     integer     NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz NULL,
  finished_at   timestamptz NULL,
  CONSTRAINT sandbox_commands_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT sandbox_commands_session_fk FOREIGN KEY (workspace_id, session_id) REFERENCES sandbox_sessions (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sandbox_commands_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sandbox_commands_done_chk CHECK ((status = 'done') = (ok IS NOT NULL))
);
CREATE INDEX sandbox_commands_session_idx ON sandbox_commands (session_id, created_at);

CREATE TABLE agent_workspace_snapshots (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      uuid        NOT NULL,
  task_id       uuid        NULL,
  source        text        NOT NULL CHECK (source IN ('task','pack')),
  archive       bytea       NOT NULL CHECK (octet_length(archive) BETWEEN 1 AND 10485760),
  files         integer     NOT NULL CHECK (files >= 0),
  bytes         bigint      NOT NULL CHECK (bytes >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_workspace_snapshots_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agent_workspace_snapshots_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_workspace_snapshots_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_workspace_snapshots_task_chk CHECK ((source = 'task') = (task_id IS NOT NULL))
);
CREATE INDEX agent_workspace_snapshots_agent_idx ON agent_workspace_snapshots (agent_id, created_at DESC);
CREATE INDEX agent_workspace_snapshots_task_idx ON agent_workspace_snapshots (task_id, created_at DESC) WHERE task_id IS NOT NULL;

CREATE TABLE agent_skills (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id      uuid        NOT NULL,
  name          text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  description   text        NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  body          text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  pack_id       text        NULL CHECK (pack_id IS NULL OR pack_id ~ '^[a-z0-9-]{2,40}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_skills_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agent_skills_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_skills_name_uq UNIQUE (agent_id, name)
);

CREATE TABLE pack_installs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pack_id       text        NOT NULL CHECK (pack_id ~ '^[a-z0-9-]{2,40}$'),
  pack_version  integer     NOT NULL CHECK (pack_version >= 1),
  installed_by  uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  agent_ids     uuid[]      NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pack_installs_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT pack_installs_pack_uq UNIQUE (workspace_id, pack_id)
);
