-- 0003：リハーサル（走行・試験・状況・合格証・自分の言葉の悪い日の入力）
-- db-schema.md §3.2 の 4・7 を cross-check の結論（M-26〜M-29・M-41・M-42・M-46・M-49・M-50・M-51・M-54・G-03・G-10）で直したもの。
-- 対象は「仕事（job_id）か依頼（ask_id）のちょうど片方」：順番の編成は依頼全体、ほかは担当の仕事ごと（C-23）。
-- 合格証は書き込みを持つ仕事ごと（順番は ask_id つき。M-49）。sim への FK は 0004 で足す。

-- ===================================================================
-- 1. 走行（rehearsal_runs）
-- ===================================================================
CREATE TABLE rehearsal_runs (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id                uuid          NULL,
  ask_id                uuid          NULL,
  -- 始まり方（M-46：DB の列挙を正。自動では始めない：UI:1620）
  trigger               text          NOT NULL CHECK (trigger IN ('initial','manual','retest','recertify','user_case','seed','model_compare')),
  reason                text          NULL CHECK (reason IS NULL OR reason IN ('widen','tool_hash','model','case_added')),
  requested_by          uuid          NULL REFERENCES users(id) ON DELETE SET NULL,
  parent_run_id         uuid          NULL,
  config_change_id      uuid          NULL,
  -- 「押そうとしているルール」（15:119）。SW の形 [{ action, match, free }]（M-50）。開始時に id・tool_hash を付けて実効ポリシーに入れる
  candidate_rules       jsonb         NULL CHECK (candidate_rules IS NULL OR jsonb_typeof(candidate_rules) = 'array'),
  -- 走行の実効ポリシー（候補のルールを足したもの）：仕事の slug → { policy, hash }（G-03）
  effective_policies    jsonb         NULL CHECK (effective_policies IS NULL OR jsonb_typeof(effective_policies) = 'object'),
  -- 開始時の policyHash（ひとりの走行）と、使うツールの tool_hash [{ action, toolHash }]（M-49・M-50）
  policy_hash           text          NULL CHECK (policy_hash IS NULL OR policy_hash ~ '^[0-9a-f]{64}$'),
  tool_hashes           jsonb         NULL CHECK (tool_hashes IS NULL OR jsonb_typeof(tool_hashes) = 'array'),
  -- 走行を始めた時点の試験の集合のハッシュ（合格証を出すときに今の集合と比べる：DB §4.7）
  case_set_hash         text          NULL CHECK (case_set_hash IS NULL OR case_set_hash ~ '^[0-9a-f]{64}$'),
  status                text          NOT NULL DEFAULT 'queued'
                                      CHECK (status IN ('queued','generating','running','done','failed','cancelled')),
  -- uint32 のシード（M-45）
  seed                  bigint        NOT NULL CHECK (seed >= 0),
  model_id              text          NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
  generator_model_id    text          NULL,
  adapt_round           smallint      NOT NULL DEFAULT 0 CHECK (adapt_round BETWEEN 0 AND 3),
  comparison_group_id   uuid          NULL,
  summary               jsonb         NULL CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object'),
  damage_jpy            bigint        NULL CHECK (damage_jpy IS NULL OR damage_jpy >= 0),
  shadow_damage_jpy     bigint        NULL CHECK (shadow_damage_jpy IS NULL OR shadow_damage_jpy >= 0),
  -- 走行全体は状況ごとの max(0, 影 − 本番) の合計（15:160。生成列にしない）
  prevented_damage_jpy  bigint        NULL CHECK (prevented_damage_jpy IS NULL OR prevented_damage_jpy >= 0),
  cost_usd              numeric(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  budget_usd            numeric(12,6) NOT NULL DEFAULT 0.5 CHECK (budget_usd > 0),
  certificate_id        uuid          NULL,
  is_seed               boolean       NOT NULL DEFAULT false,
  error                 text          NULL,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  started_at            timestamptz   NULL,
  finished_at           timestamptz   NULL,
  CONSTRAINT rehearsal_runs_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT rehearsal_runs_job_fk FOREIGN KEY (workspace_id, job_id) REFERENCES agent_jobs (workspace_id, id),
  CONSTRAINT rehearsal_runs_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id),
  CONSTRAINT rehearsal_runs_parent_fk FOREIGN KEY (workspace_id, parent_run_id) REFERENCES rehearsal_runs (workspace_id, id),
  CONSTRAINT rehearsal_runs_config_change_fk FOREIGN KEY (workspace_id, config_change_id)
    REFERENCES agent_config_changes (workspace_id, id),
  CONSTRAINT rehearsal_runs_subject_chk CHECK (num_nonnulls(job_id, ask_id) = 1),
  CONSTRAINT rehearsal_runs_retest_chk  CHECK (trigger <> 'retest' OR parent_run_id IS NOT NULL),
  CONSTRAINT rehearsal_runs_reason_chk  CHECK ((trigger = 'recertify') = (reason IS NOT NULL))
);
CREATE INDEX rehearsal_runs_ask_time_idx ON rehearsal_runs (ask_id, created_at DESC) WHERE ask_id IS NOT NULL;
CREATE INDEX rehearsal_runs_job_time_idx ON rehearsal_runs (job_id, created_at DESC) WHERE job_id IS NOT NULL;
CREATE INDEX rehearsal_runs_ws_time_idx  ON rehearsal_runs (workspace_id, created_at DESC);
-- 同じ対象で動いている走行は1つ（当たったら 409 REHEARSAL_ALREADY_RUNNING：M-51）
CREATE UNIQUE INDEX rehearsal_runs_one_active_uq ON rehearsal_runs ((COALESCE(ask_id, job_id)))
  WHERE status IN ('queued','generating','running');

-- ===================================================================
-- 2. 試験（rehearsal_cases。15:220）
-- ===================================================================
CREATE TABLE rehearsal_cases (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id                   uuid        NULL,
  ask_id                   uuid        NULL,
  source                   text        NOT NULL CHECK (source IN ('generated','user','incident')),
  -- 障害カタログの部分集合。incident は障害 ID がなくてもよい（M-28：Kill Switch・汚染なしの承認）
  fault_ids                text[]      NOT NULL CHECK (fault_ids <@ ARRAY[
                                         'F-01','F-02','F-03','F-04','F-05','F-06','F-07','F-08','F-09','F-10','F-11','F-12','F-13']::text[]),
  -- SW の Scenario（M-45）
  scenario                 jsonb       NOT NULL CHECK (jsonb_typeof(scenario) = 'object'),
  seed                     bigint      NOT NULL CHECK (seed >= 0),
  sim_snapshot_id          uuid        NULL,
  user_text                text        NULL CHECK (user_text IS NULL OR char_length(user_text) BETWEEN 1 AND 500),
  source_task_id           uuid        NULL,
  reason_code              text        NULL,
  -- 止まり方（M-27：user_reject）
  incident_kind            text        NULL CHECK (incident_kind IS NULL OR incident_kind IN ('kernel_approve','kernel_deny','user_reject','kill_switch')),
  -- O-08 の入力：元のタスクで止まった・却下された書き込み（M-26。IA §2.9 の StoppedWrite[]）
  stopped_writes           jsonb       NULL CHECK (stopped_writes IS NULL OR jsonb_typeof(stopped_writes) = 'array'),
  -- 最初の影の走行の損害（再試験・再リハーサルでは影を走らせないため保持。G-10）
  first_shadow_damage_jpy  bigint      NULL CHECK (first_shadow_damage_jpy IS NULL OR first_shadow_damage_jpy >= 0),
  origin_run_id            uuid        NULL,
  created_by               uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  removed_at               timestamptz NULL,
  removed_by               uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  -- regenerated は作り直しで外したもの（M-29）
  removed_reason           text        NULL CHECK (removed_reason IS NULL OR removed_reason IN ('user','merged','regenerated')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rehearsal_cases_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT rehearsal_cases_job_fk FOREIGN KEY (workspace_id, job_id) REFERENCES agent_jobs (workspace_id, id),
  CONSTRAINT rehearsal_cases_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id),
  CONSTRAINT rehearsal_cases_origin_run_fk FOREIGN KEY (workspace_id, origin_run_id)
    REFERENCES rehearsal_runs (workspace_id, id) ON DELETE SET NULL (origin_run_id),
  CONSTRAINT rehearsal_cases_source_task_fk FOREIGN KEY (workspace_id, source_task_id)
    REFERENCES tasks (workspace_id, id) ON DELETE SET NULL (source_task_id),
  CONSTRAINT rehearsal_cases_subject_chk  CHECK (num_nonnulls(job_id, ask_id) = 1),
  CONSTRAINT rehearsal_cases_fault_ids_chk CHECK (source = 'incident' OR cardinality(fault_ids) >= 1),
  CONSTRAINT rehearsal_cases_incident_chk CHECK (source <> 'incident'
    OR (sim_snapshot_id IS NOT NULL AND reason_code IS NOT NULL AND incident_kind IS NOT NULL)),
  CONSTRAINT rehearsal_cases_not_incident_chk CHECK (source = 'incident'
    OR (sim_snapshot_id IS NULL AND source_task_id IS NULL AND incident_kind IS NULL AND stopped_writes IS NULL)),
  CONSTRAINT rehearsal_cases_user_chk     CHECK ((source = 'user') = (user_text IS NOT NULL)),
  CONSTRAINT rehearsal_cases_removed_chk  CHECK ((removed_at IS NULL) = (removed_reason IS NULL))
);
CREATE INDEX rehearsal_cases_job_active_idx ON rehearsal_cases (job_id, source, created_at)
  WHERE removed_at IS NULL AND job_id IS NOT NULL;
CREATE INDEX rehearsal_cases_ask_active_idx ON rehearsal_cases (ask_id, source, created_at)
  WHERE removed_at IS NULL AND ask_id IS NOT NULL;
CREATE INDEX rehearsal_cases_source_task_idx ON rehearsal_cases (source_task_id) WHERE source_task_id IS NOT NULL;

-- ===================================================================
-- 3. 状況（rehearsal_scenarios。走行の中の1件の結果。15:222 の損害の列）
-- ===================================================================
CREATE TABLE rehearsal_scenarios (
  id                                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                      uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rehearsal_run_id                  uuid          NOT NULL,
  case_id                           uuid          NOT NULL,
  ordinal                           smallint      NOT NULL CHECK (ordinal >= 1),
  fault_ids                         text[]        NOT NULL CHECK (fault_ids <@ ARRAY[
                                                    'F-01','F-02','F-03','F-04','F-05','F-06','F-07','F-08','F-09','F-10','F-11','F-12','F-13']::text[]),
  scenario                          jsonb         NOT NULL CHECK (jsonb_typeof(scenario) = 'object'),
  seed                              bigint        NOT NULL CHECK (seed >= 0),
  -- 状態と合否・止めた理由を分ける（M-46）
  status                            text          NOT NULL DEFAULT 'queued'
                                                  CHECK (status IN ('queued','running','judging','done','cancelled','error')),
  abort_reason                      text          NULL CHECK (abort_reason IS NULL OR abort_reason IN ('budget','kill_switch','timeout','user')),
  verdict                           text          NULL CHECK (verdict IS NULL OR verdict IN ('pass','fail')),
  -- 誰が止めたか（15:122。SW の StoppedBy の by・decision・reasonCode・matchedRule を列に分けたもの）
  stopped_by                        text          NULL CHECK (stopped_by IS NULL OR stopped_by IN ('kernel','agent','none')),
  stopped_by_decision               text          NULL CHECK (stopped_by_decision IS NULL OR stopped_by_decision IN ('approve','deny','halt')),
  stopped_by_reason_code            text          NULL,
  stopped_by_rule                   text          NULL,
  oracle_results                    jsonb         NULL,
  -- 承認待ちを「却下した場合」「承認した場合」に分けたオラクルの結果（15:121）
  branch_results                    jsonb         NULL,
  damage_jpy                        bigint        NULL CHECK (damage_jpy IS NULL OR damage_jpy >= 0),
  shadow_damage_jpy                 bigint        NULL CHECK (shadow_damage_jpy IS NULL OR shadow_damage_jpy >= 0),
  -- 承認した分岐の損害（M-42。参考）
  approve_branch_damage_jpy         bigint        NULL CHECK (approve_branch_damage_jpy IS NULL OR approve_branch_damage_jpy >= 0),
  -- SW の DamageBreakdown（式ごとの値と元の値。M-46）
  damage_breakdown                  jsonb         NULL,
  shadow_damage_breakdown           jsonb         NULL,
  approve_branch_damage_breakdown   jsonb         NULL,
  -- 防いだ損害 max(0, 影 − 本番)。影を走らせない状況は NULL（BR-79）
  prevented_damage_jpy              bigint        GENERATED ALWAYS AS (
                                      CASE WHEN damage_jpy IS NULL OR shadow_damage_jpy IS NULL THEN NULL
                                           ELSE GREATEST(shadow_damage_jpy - damage_jpy, 0) END) STORED,
  -- 秘密の流出は金額にせず件数（O-06。15:159）
  leak_count                        integer       NULL CHECK (leak_count IS NULL OR leak_count >= 0),
  shadow_leak_count                 integer       NULL CHECK (shadow_leak_count IS NULL OR shadow_leak_count >= 0),
  interpretation                    text          NULL CHECK (interpretation IS NULL OR char_length(interpretation) <= 300),
  cost_usd                          numeric(12,6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  -- 状況×走行の sim の走行（G-10。FK は 0004）
  governed_execution_id             uuid          NULL,
  approve_execution_id              uuid          NULL,
  shadow_execution_id               uuid          NULL,
  error                             text          NULL,
  created_at                        timestamptz   NOT NULL DEFAULT now(),
  started_at                        timestamptz   NULL,
  finished_at                       timestamptz   NULL,
  CONSTRAINT rehearsal_scenarios_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT rehearsal_scenarios_run_fk FOREIGN KEY (workspace_id, rehearsal_run_id)
    REFERENCES rehearsal_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT rehearsal_scenarios_case_fk FOREIGN KEY (workspace_id, case_id) REFERENCES rehearsal_cases (workspace_id, id),
  CONSTRAINT rehearsal_scenarios_ordinal_uq UNIQUE (rehearsal_run_id, ordinal),
  CONSTRAINT rehearsal_scenarios_verdict_chk CHECK ((status = 'done') = (verdict IS NOT NULL)),
  CONSTRAINT rehearsal_scenarios_abort_chk CHECK (abort_reason IS NULL OR status IN ('cancelled','error')),
  CONSTRAINT rehearsal_scenarios_stopped_by_chk CHECK ((stopped_by IS NOT DISTINCT FROM 'kernel') = (stopped_by_decision IS NOT NULL))
);
CREATE INDEX rehearsal_scenarios_case_idx ON rehearsal_scenarios (case_id);

-- ===================================================================
-- 4. 合格証（rehearsal_certificates。15:221、BR-81）
-- audit_log_id は audit_logs の主キー (workspace_id, seq) への複合 FK にする（C-24）
-- ===================================================================
CREATE TABLE rehearsal_certificates (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id            uuid          NOT NULL,
  ask_id            uuid          NULL,
  rehearsal_run_id  uuid          NOT NULL,
  policy_hash       text          NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  -- その仕事に付与した全ツールの [{ action, toolHash }]（M-49）
  tool_hashes       jsonb         NOT NULL CHECK (jsonb_typeof(tool_hashes) = 'array'),
  model_id          text          NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
  case_set_hash     text          NOT NULL CHECK (case_set_hash ~ '^[0-9a-f]{64}$'),
  case_count        integer       NOT NULL CHECK (case_count >= 1),
  summary           jsonb         NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  cost_usd          numeric(12,6) NOT NULL CHECK (cost_usd >= 0),
  certificate_hash  text          NOT NULL CHECK (certificate_hash ~ '^[0-9a-f]{64}$'),
  audit_seq         bigint        NOT NULL,
  issued_at         timestamptz   NOT NULL DEFAULT now(),
  revoked_at        timestamptz   NULL,
  -- superseded は再試験で新しい合格証が出た（C-25・M-49。画面では「切れた」と出さない）
  revoke_reason     text          NULL CHECK (revoke_reason IS NULL OR revoke_reason IN ('widen','tool_hash','model','case_added','superseded')),
  CONSTRAINT rehearsal_certificates_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT rehearsal_certificates_job_fk FOREIGN KEY (workspace_id, job_id) REFERENCES agent_jobs (workspace_id, id),
  CONSTRAINT rehearsal_certificates_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id),
  CONSTRAINT rehearsal_certificates_run_fk FOREIGN KEY (workspace_id, rehearsal_run_id) REFERENCES rehearsal_runs (workspace_id, id),
  CONSTRAINT rehearsal_certificates_audit_fk FOREIGN KEY (workspace_id, audit_seq) REFERENCES audit_logs (workspace_id, seq),
  CONSTRAINT rehearsal_certificates_revoke_chk CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- 有効な合格証は仕事ごとに1つ（DB T-06）
CREATE UNIQUE INDEX rehearsal_certificates_active_uq ON rehearsal_certificates (job_id) WHERE revoked_at IS NULL;
CREATE INDEX rehearsal_certificates_ask_idx ON rehearsal_certificates (ask_id) WHERE ask_id IS NOT NULL;
CREATE INDEX rehearsal_certificates_run_idx ON rehearsal_certificates (rehearsal_run_id);

ALTER TABLE rehearsal_runs ADD CONSTRAINT rehearsal_runs_certificate_fk
  FOREIGN KEY (workspace_id, certificate_id) REFERENCES rehearsal_certificates (workspace_id, id);

-- ===================================================================
-- 5. 自分の言葉の悪い日（FR-065）の入力。1日5件は Gemini を呼んだ回数＝この表の行で数える（M-51）
-- ===================================================================
CREATE TABLE rehearsal_user_inputs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id            uuid        NULL,
  ask_id            uuid        NULL,
  text              text        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  status            text        NOT NULL DEFAULT 'interpreting' CHECK (status IN ('interpreting','matched','running',
                                  'done','no_match','cancelled','failed')),
  interpretation    jsonb       NULL CHECK (interpretation IS NULL OR jsonb_typeof(interpretation) = 'object'),
  nearest_fault_id  text        NULL CHECK (nearest_fault_id IS NULL OR nearest_fault_id ~ '^F-(0[1-9]|1[0-3])$'),
  case_id           uuid        NULL,
  rehearsal_run_id  uuid        NULL,
  scenario_id       uuid        NULL,
  created_by        uuid        NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rehearsal_user_inputs_job_fk FOREIGN KEY (workspace_id, job_id) REFERENCES agent_jobs (workspace_id, id),
  CONSTRAINT rehearsal_user_inputs_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id),
  CONSTRAINT rehearsal_user_inputs_case_fk FOREIGN KEY (workspace_id, case_id) REFERENCES rehearsal_cases (workspace_id, id),
  CONSTRAINT rehearsal_user_inputs_run_fk FOREIGN KEY (workspace_id, rehearsal_run_id) REFERENCES rehearsal_runs (workspace_id, id),
  CONSTRAINT rehearsal_user_inputs_scenario_fk FOREIGN KEY (workspace_id, scenario_id) REFERENCES rehearsal_scenarios (workspace_id, id),
  CONSTRAINT rehearsal_user_inputs_subject_chk CHECK (num_nonnulls(job_id, ask_id) = 1),
  CONSTRAINT rehearsal_user_inputs_case_chk CHECK (status NOT IN ('running','done') OR case_id IS NOT NULL)
);
CREATE INDEX rehearsal_user_inputs_ws_time_idx ON rehearsal_user_inputs (workspace_id, created_at);

-- ===================================================================
-- 6. 先に作った表からリハーサルへの参照
-- ===================================================================
ALTER TABLE tasks ADD CONSTRAINT tasks_rehearsal_run_fk
  FOREIGN KEY (workspace_id, rehearsal_run_id) REFERENCES rehearsal_runs (workspace_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_rehearsal_scenario_fk
  FOREIGN KEY (workspace_id, rehearsal_scenario_id) REFERENCES rehearsal_scenarios (workspace_id, id);
ALTER TABLE usage_records ADD CONSTRAINT usage_records_rehearsal_run_fk
  FOREIGN KEY (workspace_id, rehearsal_run_id) REFERENCES rehearsal_runs (workspace_id, id);
ALTER TABLE agent_config_changes ADD CONSTRAINT agent_config_changes_rehearsal_run_fk
  FOREIGN KEY (workspace_id, rehearsal_run_id) REFERENCES rehearsal_runs (workspace_id, id);
ALTER TABLE ask_runs ADD CONSTRAINT ask_runs_rehearsal_run_fk
  FOREIGN KEY (workspace_id, rehearsal_run_id) REFERENCES rehearsal_runs (workspace_id, id);
ALTER TABLE ask_runs ADD CONSTRAINT ask_runs_rehearsal_scenario_fk
  FOREIGN KEY (workspace_id, rehearsal_scenario_id) REFERENCES rehearsal_scenarios (workspace_id, id);
