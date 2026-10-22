-- 0001：利用者・所属・セッション（D1。ワークスペースをまたぐ小さな表だけ。ワークスペースの中身は WorkspaceDO：docs/cloudflare-design.md）
-- 時刻は ISO 8601 の TEXT（UTC）

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  name        TEXT NULL,
  created_at  TEXT NOT NULL
);

-- 利用者 → ワークスペース（WorkspaceDO の名前）。今は1人1つで owner だけ
CREATE TABLE memberships (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
CREATE UNIQUE INDEX memberships_one_per_user ON memberships (user_id);

-- Cookie の値は保存しない（SHA-256 だけ）。csrf_token は画面が X-CSRF-Token で返す値
CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL,
  csrf_token    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
