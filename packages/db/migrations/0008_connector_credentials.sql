-- 0008：コネクタの資格情報（Google カレンダーの refresh token の暗号文。design 16 §3.3、ADR-040）
-- refresh token は platform の sealSecret（AES-256-GCM）で暗号化して置く。AAD は "<workspace_id>:<connector_id>"（別の行に写しても開けない）。
-- 復号は gateway だけ。ot_app は書くだけで refresh_token_enc は読めない（権限は roles.sql）。
-- 1コネクタに有効な行は1つ（再接続のときは前の行を revoked_at で止めてから入れる）。ワークスペース・コネクタが消えれば行も消える（CASCADE）。

CREATE TABLE connector_credentials (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id      uuid        NOT NULL,
  provider          text        NOT NULL CHECK (provider = 'google'),
  -- ID トークンの sub（Google のアカウントの固定の ID）と email（画面に出す）
  subject           text        NOT NULL,
  email             text        NOT NULL,
  scopes            text[]      NOT NULL,
  -- "v1.<iv>.<ct>"（platform の sealSecret）
  refresh_token_enc text        NOT NULL CHECK (refresh_token_enc ~ '^v1\.'),
  -- Makase が作ったカレンダーの ID（calendar.app.created の範囲）と、利用者の時間帯（IANA）
  calendar_id       text        NOT NULL,
  time_zone         text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz NULL,
  CONSTRAINT connector_credentials_connector_fk FOREIGN KEY (workspace_id, connector_id)
    REFERENCES connectors (workspace_id, id) ON DELETE CASCADE
);
-- 有効な行は1コネクタに1つだけ（revoked_at IS NULL の行だけの一意）
CREATE UNIQUE INDEX connector_credentials_active_uq ON connector_credentials (connector_id) WHERE revoked_at IS NULL;
