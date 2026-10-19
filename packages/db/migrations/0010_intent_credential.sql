-- OAuth を使う MCP Intent の実行先資格情報を記録する。
-- credential 行は再接続時に差し替わるため、作成時の ID を固定して gateway で照合する。
ALTER TABLE action_intents ADD COLUMN connector_credential_id uuid;

-- edge は有効な資格情報の ID だけを参照する（秘密列は読まない）。gateway は Intent と資格情報を読む。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_app') THEN
    GRANT SELECT (id, workspace_id, connector_id, revoked_at) ON public.connector_credentials TO ot_app;
  END IF;
END
$$;
