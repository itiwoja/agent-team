-- 模擬の世界（sim-world）とリハーサル（安全チェック・影の走行・合格証・締める提案）をやめる
-- 1. リハーサルのタスク・実行と、模擬の世界のコネクタを使ったタスク（デモ店舗）を消す
-- 2. rehearsal_* の表と sim スキーマを消す
-- 3. tasks・ask_runs・agent_config_changes・usage_records のリハーサル・sim の列を消す
-- 4. connectors.kind から 'sim' をなくす
-- 過去の履歴の値（origin の 'rehearsal_tighten'、phase の 'rehearsal_*'、expire_reason の 'rehearsal_end'）は CHECK に残す

-- ---- 1. 消すタスク（リハーサルのタスクと、sim のコネクタに書いたタスク。その続きのタスクも） ----
CREATE TEMP TABLE drop_tasks ON COMMIT DROP AS
WITH RECURSIVE t AS (
  SELECT id FROM tasks
   WHERE rehearsal_run_id IS NOT NULL
      OR id IN (SELECT i.task_id FROM action_intents i JOIN connectors c ON c.id = i.connector_id WHERE c.kind = 'sim')
  UNION
  SELECT c.id FROM tasks c JOIN t ON c.parent_task_id = t.id
)
SELECT id FROM t;

DELETE FROM usage_records WHERE rehearsal_run_id IS NOT NULL OR task_id IN (SELECT id FROM drop_tasks);
-- 消すタスクのメッセージと、それへの返事（の連なり）。返事だけ残すと in_reply_to が NULL になり ask_messages_reply_chk に当たる
DELETE FROM ask_messages WHERE id IN (
  WITH RECURSIVE m AS (
    SELECT id, workspace_id FROM ask_messages WHERE from_task_id IN (SELECT id FROM drop_tasks)
    UNION
    SELECT r.id, r.workspace_id FROM ask_messages r JOIN m ON r.workspace_id = m.workspace_id AND r.in_reply_to = m.id
  )
  SELECT id FROM m
);
DELETE FROM tasks WHERE id IN (SELECT id FROM drop_tasks);
DELETE FROM ask_runs WHERE mode = 'rehearsal';
DELETE FROM connectors WHERE kind = 'sim';
DELETE FROM check_marks WHERE item_key LIKE 'rehearsal:%' OR item_key LIKE 'incident_added:%';

-- ---- 2. 表とスキーマ ----
DROP SCHEMA sim CASCADE;
DROP TABLE rehearsal_user_inputs, rehearsal_certificates, rehearsal_scenarios, rehearsal_cases, rehearsal_runs CASCADE;

-- ---- 3. 列 ----
ALTER TABLE tasks
  DROP COLUMN rehearsal_run_id,
  DROP COLUMN rehearsal_scenario_id,
  DROP COLUMN shadow,
  DROP COLUMN sim_execution_id,
  DROP COLUMN execution_variant,
  DROP COLUMN sim_snapshot_id;
CREATE INDEX tasks_job_status_idx ON tasks (job_id, status);

DROP INDEX ask_runs_live_no_uq;
ALTER TABLE ask_runs
  DROP COLUMN mode,
  DROP COLUMN rehearsal_run_id,
  DROP COLUMN rehearsal_scenario_id;
CREATE UNIQUE INDEX ask_runs_no_uq ON ask_runs (ask_id, run_no);

ALTER TABLE agent_config_changes DROP COLUMN rehearsal_run_id;

ALTER TABLE usage_records DROP COLUMN rehearsal_run_id;
ALTER TABLE usage_records ADD CONSTRAINT usage_records_owner_chk CHECK (num_nonnulls(task_id, agent_id, ask_id) >= 1);

-- ---- 4. コネクタの種類 ----
ALTER TABLE connectors DROP CONSTRAINT connectors_sim_no_secret_chk;
ALTER TABLE connectors DROP CONSTRAINT connectors_kind_check;
ALTER TABLE connectors ALTER COLUMN kind SET DEFAULT 'mcp_remote';
ALTER TABLE connectors ADD CONSTRAINT connectors_kind_check CHECK (kind = 'mcp_remote');
