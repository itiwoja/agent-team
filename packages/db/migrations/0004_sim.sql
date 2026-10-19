-- 0004：模擬の世界（スキーマ sim。M-40：sim-world-rehearsal.md §3.6 を正とし、apps/sim-world/src/store.ts の記録の形に合わせる）
-- 状態は jsonb 1行＋version の楽観ロック、事象は追記だけ、スナップショット。すべての表に workspace_id（FK・CASCADE。15:384）。
-- sim-world は ot_sim のロールでこのスキーマだけを使う。デモ店舗は rehearsal_run_id が NULL・variant = 'live' の走行（15:369）。

CREATE SCHEMA sim;

-- 状態の写し（本番のタスクの開始時：FR-066・G-07）。試験（rehearsal_cases）が参照している間は消せない（NO ACTION）
-- execution_id への FK は sim.executions を作ったあとに足す（循環するため）
CREATE TABLE sim.snapshots (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  world              text        NOT NULL CHECK (world IN ('shop','brief','repo')),
  -- 写したデモ店舗の走行と、その時の version
  execution_id       uuid        NOT NULL,
  execution_version  integer     NOT NULL CHECK (execution_version >= 1),
  seed               bigint      NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  seed_version       text        NOT NULL CHECK (char_length(seed_version) BETWEEN 1 AND 40),
  state              jsonb       NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  -- 状態の正規形 JSON の SHA-256（SW §4.4.9）
  state_hash         text        NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  -- 本番のタスク（FK は張らない：タスクの保持より長く残すことがある。I-36）
  source_task_id     uuid        NOT NULL,
  taken_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sim_snapshots_ws_id_uq UNIQUE (workspace_id, id)
);
CREATE INDEX sim_snapshots_ws_time_idx ON sim.snapshots (workspace_id, taken_at);

-- 走行（デモ店舗・リハーサルの状況×種類・承認した分岐）。id は呼び出し側が決める（store.ts の SimExecutionRecord）
CREATE TABLE sim.executions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  world                text        NOT NULL CHECK (world IN ('shop','brief','repo')),
  -- NULL＝デモ店舗（15:369）
  rehearsal_run_id     uuid        NULL,
  -- fork の元（承認した分岐）
  parent_execution_id  uuid        NULL,
  -- M-41。デモ店舗は live、承認した分岐は governed_approve
  variant              text        NOT NULL CHECK (variant IN ('live','governed','governed_approve','shadow')),
  seed                 bigint      NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  seed_version         text        NOT NULL CHECK (char_length(seed_version) BETWEEN 1 AND 40),
  -- 走行に置いた状況（SW の Scenario）。デモ店舗は NULL
  scenario             jsonb       NULL CHECK (scenario IS NULL OR jsonb_typeof(scenario) = 'object'),
  -- 初期状態を写したスナップショット（FR-066 の incident）
  snapshot_id          uuid        NULL,
  -- 状況を置いた直後の状態（損害・オラクルの initial。fork は元の値を引き継ぐ）
  initial_state        jsonb       NOT NULL CHECK (jsonb_typeof(initial_state) = 'object'),
  state                jsonb       NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  -- 1 から。更新のたびに +1（楽観ロック）
  version              integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sim_executions_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT sim_executions_rehearsal_run_fk FOREIGN KEY (workspace_id, rehearsal_run_id)
    REFERENCES public.rehearsal_runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT sim_executions_parent_fk FOREIGN KEY (workspace_id, parent_execution_id)
    REFERENCES sim.executions (workspace_id, id) ON DELETE SET NULL (parent_execution_id),
  CONSTRAINT sim_executions_snapshot_fk FOREIGN KEY (workspace_id, snapshot_id)
    REFERENCES sim.snapshots (workspace_id, id) ON DELETE SET NULL (snapshot_id),
  -- デモ店舗だけが live で、リハーサルの走行は必ず走行の ID を持つ（BR-67：本番とリハーサルを混ぜない）
  CONSTRAINT sim_executions_live_chk CHECK ((variant = 'live') = (rehearsal_run_id IS NULL)),
  CONSTRAINT sim_executions_fork_chk CHECK (parent_execution_id IS NULL OR variant <> 'live')
);
-- デモ店舗は (workspace, world) で1つ（`= NULL` で引かない：SO-SIM-06）
CREATE UNIQUE INDEX sim_executions_demo_store_uq ON sim.executions (workspace_id, world) WHERE rehearsal_run_id IS NULL;
CREATE INDEX sim_executions_run_idx ON sim.executions (workspace_id, world, rehearsal_run_id);

ALTER TABLE sim.snapshots ADD CONSTRAINT sim_snapshots_execution_fk
  FOREIGN KEY (workspace_id, execution_id) REFERENCES sim.executions (workspace_id, id);

-- 事象（追記だけ。O-01 の数え方・損害・タイムラインの元）。event は sim-core の SimEvent そのもの
-- （intentId: null と「ない」を区別して往復させるため列に分けない）。seq は走行の中の通し番号（fork は元の番号のまま写す）
CREATE TABLE sim.events (
  execution_id  uuid        NOT NULL,
  seq           integer     NOT NULL CHECK (seq >= 1),
  workspace_id  uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  event         jsonb       NOT NULL CHECK (jsonb_typeof(event) = 'object'
                              AND event->'seq' = to_jsonb(seq)
                              AND event->>'kind' IN ('tool_call','clock','delivery','payment','sales','fault')),
  -- 検索用（event から作る。書き込めない）
  kind          text        GENERATED ALWAYS AS (event->>'kind') STORED,
  intent_id     text        GENERATED ALWAYS AS (event->>'intentId') STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sim_events_pk PRIMARY KEY (execution_id, seq),
  CONSTRAINT sim_events_execution_fk FOREIGN KEY (workspace_id, execution_id)
    REFERENCES sim.executions (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX sim_events_intent_idx ON sim.events (workspace_id, intent_id) WHERE intent_id IS NOT NULL;
CREATE TRIGGER sim_events_no_update BEFORE UPDATE ON sim.events
  FOR EACH ROW EXECUTE FUNCTION public.forbid_update();

-- ===================================================================
-- public の表から sim への参照（スキーマをまたぐ複合 FK）
-- ===================================================================
ALTER TABLE public.tasks ADD CONSTRAINT tasks_sim_execution_fk
  FOREIGN KEY (workspace_id, sim_execution_id) REFERENCES sim.executions (workspace_id, id) ON DELETE SET NULL (sim_execution_id);
ALTER TABLE public.tasks ADD CONSTRAINT tasks_sim_snapshot_fk
  FOREIGN KEY (workspace_id, sim_snapshot_id) REFERENCES sim.snapshots (workspace_id, id) ON DELETE SET NULL (sim_snapshot_id);
-- 試験が使っているスナップショットは消せない（DB T-16）
ALTER TABLE public.rehearsal_cases ADD CONSTRAINT rehearsal_cases_sim_snapshot_fk
  FOREIGN KEY (workspace_id, sim_snapshot_id) REFERENCES sim.snapshots (workspace_id, id);
ALTER TABLE public.rehearsal_scenarios ADD CONSTRAINT rehearsal_scenarios_governed_execution_fk
  FOREIGN KEY (workspace_id, governed_execution_id) REFERENCES sim.executions (workspace_id, id) ON DELETE SET NULL (governed_execution_id);
ALTER TABLE public.rehearsal_scenarios ADD CONSTRAINT rehearsal_scenarios_approve_execution_fk
  FOREIGN KEY (workspace_id, approve_execution_id) REFERENCES sim.executions (workspace_id, id) ON DELETE SET NULL (approve_execution_id);
ALTER TABLE public.rehearsal_scenarios ADD CONSTRAINT rehearsal_scenarios_shadow_execution_fk
  FOREIGN KEY (workspace_id, shadow_execution_id) REFERENCES sim.executions (workspace_id, id) ON DELETE SET NULL (shadow_execution_id);
