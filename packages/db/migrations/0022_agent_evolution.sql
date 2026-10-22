-- チームが使うほど育つ（スキルの学習と整理）
-- 1. agent_skills：出どころ（pack / learned）・承認した人と時刻・承認したときの中身の SHA-256・もとにした案・最後に使われた時刻・外した時刻
--    learned は人が承認してから使える（承認後に名前・説明・本文が書き換わったら信頼しない：approved_digest と今の中身を edge が比べる）。
--    removed_at が入ったスキルは担当から見えない（整理で外した。戻すと NULL に戻す）
-- 2. skill_proposals：繰り返しの作業からできたスキルの案。skipped は「繰り返しの手順はない」と答えた印（次の判定の起点）
-- 3. agent_evolution_events：整理の記録。知らせと「戻す」の元。items は [{ type: 'skill'|'rule', id, label, restoredAt }]
-- 4. agent_config_changes.origin に 'prune'（使われないルールを外した設定変更）
-- ロールの権限は roles.sql の「全表に付ける」で足りる（ot_app は読み書き、ot_gateway は読むだけ）。表の RLS はほかの表と同じく使わない

ALTER TABLE agent_config_changes DROP CONSTRAINT agent_config_changes_origin_check;
ALTER TABLE agent_config_changes ADD CONSTRAINT agent_config_changes_origin_check CHECK (origin IN ('user_request','feedback','failure','engagement','manual',
  'revert','move','approval_rule','ask','rehearsal_tighten','prune'));

CREATE TABLE skill_proposals (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id         uuid        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('proposed','approved','rejected','skipped')),
  name             text        NULL CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 60),
  description      text        NULL CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 200),
  body             text        NULL CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 20000),
  reason           text        NULL CHECK (reason IS NULL OR char_length(reason) <= 200),
  source_task_ids  uuid[]      NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_by       uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at       timestamptz NULL,
  skill_id         uuid        NULL,
  CONSTRAINT skill_proposals_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT skill_proposals_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT skill_proposals_skill_fk FOREIGN KEY (workspace_id, skill_id) REFERENCES agent_skills (workspace_id, id) ON DELETE SET NULL (skill_id),
  CONSTRAINT skill_proposals_content_chk CHECK (status = 'skipped' OR (name IS NOT NULL AND description IS NOT NULL AND body IS NOT NULL)),
  CONSTRAINT skill_proposals_decided_chk CHECK ((status IN ('approved','rejected')) = (decided_at IS NOT NULL))
);
CREATE INDEX skill_proposals_agent_time_idx ON skill_proposals (workspace_id, agent_id, created_at DESC);
CREATE INDEX skill_proposals_proposed_idx ON skill_proposals (workspace_id, agent_id) WHERE status = 'proposed';

ALTER TABLE agent_skills
  ADD COLUMN origin          text        NOT NULL DEFAULT 'pack' CHECK (origin IN ('pack','learned')),
  ADD COLUMN approved_by     uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN approved_at     timestamptz NULL,
  ADD COLUMN approved_digest text        NULL CHECK (approved_digest IS NULL OR approved_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN proposal_id     uuid        NULL,
  ADD COLUMN last_used_at    timestamptz NULL,
  ADD COLUMN removed_at      timestamptz NULL,
  ADD CONSTRAINT agent_skills_proposal_fk FOREIGN KEY (workspace_id, proposal_id) REFERENCES skill_proposals (workspace_id, id) ON DELETE SET NULL (proposal_id),
  ADD CONSTRAINT agent_skills_learned_chk CHECK (origin <> 'learned' OR (approved_digest IS NOT NULL AND approved_at IS NOT NULL));

CREATE TABLE agent_evolution_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id          uuid        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN ('pruned')),
  items             jsonb       NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  config_change_id  uuid        NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_evolution_events_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT agent_evolution_events_agent_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_evolution_events_change_fk FOREIGN KEY (workspace_id, config_change_id) REFERENCES agent_config_changes (workspace_id, id)
);
CREATE INDEX agent_evolution_events_agent_time_idx ON agent_evolution_events (workspace_id, agent_id, created_at DESC);
