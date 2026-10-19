-- エージェントとして動かす（10/14）：
-- 1. 報告のメタ（tasks.report_meta）：窓口が出す「次の手の提案」（nextActions）と、見張りの「前回から変化があったか」（changed）。
--    本文（report）とは分けて持つ（回答の本文のハッシュ・受け渡しの本文を変えない）
-- 2. エージェントから利用者への質問（agent_questions）：動いている担当が ask_user で選択肢つきの質問を出し、
--    決まった時間だけ答えを待つ。答え・時間切れは行の status で持つ。本番の依頼のタスクだけ（リハーサルは作らない）

ALTER TABLE tasks ADD COLUMN report_meta jsonb NULL CHECK (report_meta IS NULL OR jsonb_typeof(report_meta) = 'object');

CREATE TABLE agent_questions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ask_id           uuid        NOT NULL,
  ask_run_id       uuid        NULL,
  task_id          uuid        NOT NULL,
  agent_id         uuid        NOT NULL,
  agent_name       text        NOT NULL CHECK (char_length(agent_name) BETWEEN 1 AND 60),
  question         text        NOT NULL CHECK (char_length(question) BETWEEN 1 AND 300),
  choices          jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) <= 4),
  allow_free_text  boolean     NOT NULL DEFAULT true,
  status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','expired')),
  answer           text        NULL CHECK (answer IS NULL OR char_length(answer) BETWEEN 1 AND 500),
  answered_by      uuid        NULL,
  answered_at      timestamptz NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_questions_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agent_questions_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_questions_ask_run_fk FOREIGN KEY (workspace_id, ask_run_id) REFERENCES ask_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_questions_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_questions_answer_chk CHECK ((status = 'answered') = (answer IS NOT NULL))
);
CREATE INDEX agent_questions_ask_time_idx ON agent_questions (ask_id, created_at);
CREATE INDEX agent_questions_task_idx ON agent_questions (task_id);
