-- DB のロールと権限（security-ops-deploy.md §4.6、db-schema.md §2・I-31。15:477「DB のユーザーを分ける」）
-- 番号つきのマイグレーションのあとに毎回流す（冪等）。環境変数 OT_DB_SKIP_ROLES=1 で飛ばせる。
-- ロールは NOLOGIN で作る。ログインはインフラが `ALTER ROLE ot_app LOGIN PASSWORD ...` か、ログイン用の利用者に
-- `GRANT ot_app TO <利用者>` で付ける。流す利用者にロールを作る権限（CREATEROLE）がなければ作らず、あるロールにだけ GRANT する。
--   ot_app        app。業務の表の読み書き。audit_logs は INSERT・SELECT だけ、workspaces・users の DELETE なし
--                 connector_credentials は書くだけ（refresh_token_enc は読めない。更新は revoked_at と allow_protected_write だけ）
--   ot_gateway    gateway。読み取り＋Intent・承認・タスク・ツールの更新、監査ログ・判定の INSERT。DELETE なし
--   ot_retention  ゲストの掃除（DB §2・SO §4.6 の ot_maint と同じ役目。名前は 08ddl:111）。workspaces・users などの DELETE
-- 表の所有者はマイグレーションを流す利用者（本番は ot_migrator）。ON DELETE CASCADE と FK の確認は所有者の権限で走る。

DO $$
DECLARE
  r text;
  can_create boolean;
BEGIN
  SELECT rolsuper OR rolcreaterole INTO can_create FROM pg_roles WHERE rolname = current_user;
  FOREACH r IN ARRAY ARRAY['ot_app', 'ot_gateway', 'ot_retention'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      IF coalesce(can_create, false) THEN
        BEGIN
          EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        EXCEPTION WHEN duplicate_object OR unique_violation THEN
          NULL; -- 別のデータベースのマイグレーションが同時に作った（ロールはクラスタ全体で1つ）
        END;
      ELSE
        RAISE NOTICE 'ロール % を作る権限がないので飛ばす', r;
      END IF;
    END IF;
  END LOOP;
END
$$;

-- ---- ot_app ----
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_app') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO ot_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ot_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ot_app;
  REVOKE ALL ON public.schema_migrations FROM ot_app;
  -- 監査ログは追記だけ（BR-18。トリガーでも守る）
  REVOKE UPDATE, DELETE ON public.audit_logs FROM ot_app;
  -- ワークスペース・利用者を消すのは掃除（ot_retention）だけ（DB I-31）
  REVOKE DELETE ON public.workspaces, public.users FROM ot_app;
  -- 変更しない表（トリガーでも守る）
  REVOKE UPDATE, DELETE ON public.agent_snapshots, public.workspace_policies FROM ot_app;
  -- 入口の試行は足して数えるだけ（消すのは掃除）
  REVOKE UPDATE, DELETE ON public.entry_attempts FROM ot_app;
  -- Google カレンダーの資格情報（design 16 §3.3）。上の ALL TABLES の後で付け直す（冪等）。
  -- 暗号文（refresh_token_enc）は読めない。復号は gateway（ot_gateway は SELECT のまま）。更新は revoked_at と allow_protected_write だけ
  -- 表の権限は REVOKE ALL にしない（ACL の項目が消えて付け直すと並びが変わり、2度目の流しで権限の写しがずれる）
  REVOKE SELECT, UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public.connector_credentials FROM ot_app;
  GRANT INSERT, DELETE ON public.connector_credentials TO ot_app;
  -- GitHub の保護したブランチへの書き込みの許可（allow_protected_write）は利用者が切り替える（0019、18 §3.3）
  GRANT UPDATE (revoked_at, allow_protected_write) ON public.connector_credentials TO ot_app;
  GRANT SELECT (id, workspace_id, connector_id, provider, subject, email, scopes, calendar_id, time_zone, created_at, revoked_at,
                installation_id, account_login, allow_protected_write)
    ON public.connector_credentials TO ot_app;
END
$$;

-- ---- ot_gateway ----
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_gateway') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO ot_gateway;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO ot_gateway;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ot_gateway;
  REVOKE ALL ON public.schema_migrations, public.sessions, public.entry_attempts, public.idempotency_keys FROM ot_gateway;
  -- 監査ログ・判定・タスクの事象・SSE の事象・ツールの登録（MT §3.12.4）
  GRANT INSERT ON public.audit_logs, public.policy_decisions, public.task_events, public.workspace_events,
    public.connector_tools TO ot_gateway;
  -- Intent の実行・失効（IA §3.12〜3.17）、タスクの状態の決め直し、ツールの変化の検出（行のロックにも UPDATE の権限が要る）
  GRANT UPDATE ON public.action_intents, public.approvals, public.tasks, public.connectors, public.connector_tools TO ot_gateway;
  -- 監査ログの採番だけ（列ごとの権限。SO §4.6）
  GRANT UPDATE (audit_seq, audit_last_hash) ON public.workspaces TO ot_gateway;
END
$$;

-- ---- ot_retention ----
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_retention') THEN
    RETURN;
  END IF;
  GRANT USAGE ON SCHEMA public TO ot_retention;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ot_retention;
  GRANT SELECT ON public.workspaces, public.memberships, public.users, public.sessions, public.tasks, public.action_intents,
    public.approvals, public.audit_logs, public.entry_attempts, public.idempotency_keys, public.workspace_events TO ot_retention;
  -- 掃除（DB §4.4）。子の表はワークスペースからの ON DELETE CASCADE（所有者の権限）で消える
  GRANT DELETE ON public.workspaces, public.users, public.sessions, public.entry_attempts, public.idempotency_keys,
    public.workspace_events TO ot_retention;
  -- 止めてから消す（Kill Switch と同じ停止。SO §3.16 の2）
  GRANT UPDATE ON public.workspaces, public.tasks, public.approvals, public.action_intents, public.sessions TO ot_retention;
  GRANT INSERT ON public.audit_logs, public.task_events, public.workspace_events TO ot_retention;
END
$$;
