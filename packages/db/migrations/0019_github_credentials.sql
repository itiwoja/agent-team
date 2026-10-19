-- 0019：GitHub の資格情報（GitHub App のインストール。design 18 §3.3、D-119）
-- GitHub はインストールのトークンを gateway が GitHub App の鍵でそのつど作る（ADR-002）。DB には秘密を置かず、
-- どのインストールか（installation_id）・誰がつないだか（subject = GitHub の利用者 ID、account_login）・
-- 保護したブランチ（既定のブランチ・main・master）への書き込みを利用者が許したか（allow_protected_write）だけを置く。
-- Google の行（refresh token の暗号文・カレンダー・時間帯）の決まりは変えない（provider ごとの CHECK で必須を分ける）。
-- 番号は欠番（0014・0017）を埋めずに次の番号を使う（17_security_governance.md）。

ALTER TABLE connector_credentials DROP CONSTRAINT connector_credentials_provider_check;
ALTER TABLE connector_credentials ADD CONSTRAINT connector_credentials_provider_check CHECK (provider IN ('google', 'github'));

ALTER TABLE connector_credentials
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN refresh_token_enc DROP NOT NULL,
  ALTER COLUMN calendar_id DROP NOT NULL,
  ALTER COLUMN time_zone DROP NOT NULL,
  ADD COLUMN installation_id bigint NULL CHECK (installation_id IS NULL OR installation_id > 0),
  ADD COLUMN account_login text NULL CHECK (account_login IS NULL OR account_login ~ '^[A-Za-z0-9-]{1,39}$'),
  -- 保護したブランチへの書き込み（既定は許さない。利用者が画面で切り替える。切り替えは監査ログに残す）
  ADD COLUMN allow_protected_write boolean NOT NULL DEFAULT false;

ALTER TABLE connector_credentials ADD CONSTRAINT connector_credentials_provider_fields_chk CHECK (
  (provider = 'google' AND email IS NOT NULL AND refresh_token_enc IS NOT NULL AND calendar_id IS NOT NULL AND time_zone IS NOT NULL
     AND installation_id IS NULL AND account_login IS NULL AND allow_protected_write = false)
  OR
  (provider = 'github' AND installation_id IS NOT NULL AND account_login IS NOT NULL
     AND refresh_token_enc IS NULL AND calendar_id IS NULL AND time_zone IS NULL)
);

-- ot_app：新しい列を読み、許可の切り替え（allow_protected_write）だけ書ける。暗号文の列は読めないまま（roles.sql と同じ）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ot_app') THEN
    GRANT SELECT (installation_id, account_login, allow_protected_write) ON public.connector_credentials TO ot_app;
    GRANT UPDATE (allow_protected_write) ON public.connector_credentials TO ot_app;
  END IF;
END
$$;
