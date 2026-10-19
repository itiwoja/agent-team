-- 0001：利用者・ワークスペース・所属・セッション・入口の試行・監査ログ
-- db-schema.md §3.2 の「1. 利用者とワークスペース」「6. 監査ログ」を cross-check の結論で直したもの。
-- migrate.ts が1ファイルを1トランザクションで流す（ここに BEGIN / COMMIT を書かない）。
-- 方針（DB §2）：RLS なし。users・entry_attempts 以外の全表に workspace_id（FK・ON DELETE CASCADE）。状態は text＋CHECK。

-- 行の変更を拒む（agent_snapshots・workspace_policies・sim.events。08ddl:82-90）
CREATE FUNCTION forbid_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$;

-- ===================================================================
-- 利用者（TBL-001）。ワークスペースをまたぐ唯一の表（workspace_id を持たない）
-- ===================================================================
CREATE TABLE users (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id  bigint      NULL,                       -- 0-H は常に NULL（D-05）
  login           text        NOT NULL CHECK (char_length(login) BETWEEN 1 AND 64),  -- ゲストは 'guest-' ＋ base32 小文字8文字（I-04）
  name            text        NULL,
  locale          text        NOT NULL DEFAULT 'ja' CHECK (locale IN ('ja','en')),
  deleted_at      timestamptz NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_github_user_id_uq UNIQUE (github_user_id),
  CONSTRAINT users_login_uq UNIQUE (login)
);

-- ===================================================================
-- ワークスペース（TBL-002。15:381）
-- ===================================================================
CREATE TABLE workspaces (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    text        NOT NULL DEFAULT 'owner' CHECK (kind IN ('owner','guest')),
  status                  text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  kill_switch_engaged     boolean     NOT NULL DEFAULT false,
  kill_switch_engaged_at  timestamptz NULL,
  kill_switch_engaged_by  uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
  kill_switch_reason      text        NULL CHECK (kill_switch_reason IS NULL OR char_length(kill_switch_reason) <= 500),
  -- 日次予算の区切り。オーナーも含めすべて Asia/Tokyo で作る（M-59、SO I-08）
  timezone                text        NOT NULL DEFAULT 'Asia/Tokyo' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  -- オーナー3・ゲスト2（15:361、BR-08）
  max_concurrent_tasks    integer     NOT NULL DEFAULT 3 CHECK (max_concurrent_tasks >= 1),
  -- 監査ログの最新の連番とハッシュ（採番のたびに行をロック。plat:113）
  audit_seq               bigint      NOT NULL DEFAULT 0 CHECK (audit_seq >= 0),
  audit_last_hash         bytea       NOT NULL DEFAULT decode(repeat('00', 32), 'hex')
                                      CHECK (octet_length(audit_last_hash) = 32),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  delete_requested_at     timestamptz NULL,
  seed_version            text        NULL CHECK (seed_version IS NULL OR char_length(seed_version) BETWEEN 1 AND 40),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_owner_never_deleted_chk CHECK (kind = 'guest' OR delete_requested_at IS NULL),
  CONSTRAINT workspaces_seed_only_guest_chk     CHECK (kind = 'guest' OR seed_version IS NULL)
);
-- オーナーのワークスペースは1つだけ（D-05）
CREATE UNIQUE INDEX workspaces_single_owner_uq ON workspaces (kind) WHERE kind = 'owner';
CREATE INDEX workspaces_guest_last_seen_idx    ON workspaces (last_seen_at) WHERE kind = 'guest';
CREATE INDEX workspaces_guest_delete_req_idx   ON workspaces (delete_requested_at)
  WHERE kind = 'guest' AND delete_requested_at IS NOT NULL;

-- オーナーのワークスペースを消さない・kind を変えない守り（SO I-28。掃除の SQL の書き漏れでもオーナーの監査ログが消えない）
CREATE FUNCTION workspaces_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'owner' THEN
      RAISE EXCEPTION 'owner workspace cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'workspaces.kind is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspaces_guard BEFORE UPDATE OR DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION workspaces_guard();

-- ===================================================================
-- 所属（TBL-003）。ゲストは自分のワークスペースの owner（SO I-05）
-- ===================================================================
CREATE TABLE memberships (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text        NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','maintainer','viewer')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_ws_user_uq UNIQUE (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- ===================================================================
-- セッション（TBL-016。15:383 で 0-H に前倒し）
-- Cookie の値（32バイトの乱数）は保存せず SHA-256 だけ。期限は最後のアクセスから7日（C-02）
-- ===================================================================
CREATE TABLE sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL,
  token_hash    bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  csrf_token    text        NOT NULL CHECK (char_length(csrf_token) >= 32),
  user_agent    text        NULL CHECK (user_agent IS NULL OR char_length(user_agent) <= 512),
  -- 生の IP は持たない。入口の試行と同じ HMAC（M-55。小文字16進64桁）
  ip_hash       text        NULL CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz NULL,
  CONSTRAINT sessions_token_hash_uq UNIQUE (token_hash),
  -- メンバーでないワークスペースのセッションを作れない（DB T-11）
  CONSTRAINT sessions_membership_fk FOREIGN KEY (workspace_id, user_id)
    REFERENCES memberships (workspace_id, user_id) ON DELETE CASCADE,
  CONSTRAINT sessions_expiry_chk CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx      ON sessions (user_id);
CREATE INDEX sessions_workspace_idx ON sessions (workspace_id);
CREATE INDEX sessions_expires_idx   ON sessions (expires_at);

-- ===================================================================
-- 入口の試行（BR-65 の「同じ IP から1時間に5件」・失敗が続く IP の待ち時間。DB §3.3【案】）
-- IP は HMAC にして保存する（M-55）。ワークスペースが消えても数え続けるので SET NULL（24時間で掃除が消す）
-- ===================================================================
CREATE TABLE entry_attempts (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash       text        NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
  outcome       text        NOT NULL CHECK (outcome IN ('owner','guest_created','guest_reset','wrong_token','capacity','ip_limit')),
  workspace_id  uuid        NULL REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entry_attempts_ip_time_idx ON entry_attempts (ip_hash, outcome, created_at);
CREATE INDEX entry_attempts_time_idx    ON entry_attempts (created_at);

-- ===================================================================
-- 監査ログ（TBL-012。ワークスペースごとのハッシュチェーン。FR-016、BR-18）
-- occurred_at はアプリがミリ秒で渡す（DB の now() を使わない：ハッシュの再計算を合わせるため）
-- task_id には FK を張らない（08ti:274）。タスクのイベントは payload にも taskId を入れる
-- ===================================================================
CREATE TABLE audit_logs (
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq           bigint      NOT NULL CHECK (seq >= 1),
  occurred_at   timestamptz NOT NULL,
  event_type    text        NOT NULL CHECK (event_type ~ '^[a-z_]+(\.[a-z_]+)*$' AND char_length(event_type) <= 100),
  actor_type    text        NOT NULL CHECK (actor_type IN ('user','system','agent')),
  actor_id      text        NULL CHECK (actor_id IS NULL OR char_length(actor_id) <= 200),
  task_id       uuid        NULL,
  payload       jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  prev_hash     bytea       NOT NULL CHECK (octet_length(prev_hash) = 32),
  hash          bytea       NOT NULL CHECK (octet_length(hash) = 32),
  CONSTRAINT audit_logs_pk PRIMARY KEY (workspace_id, seq),
  CONSTRAINT audit_logs_ms_chk CHECK (occurred_at = date_trunc('milliseconds', occurred_at))
);
CREATE INDEX audit_logs_ws_time_idx ON audit_logs (workspace_id, occurred_at);
CREATE INDEX audit_logs_ws_task_idx ON audit_logs (workspace_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX audit_logs_ws_type_idx ON audit_logs (workspace_id, event_type, occurred_at);

-- 更新はいつも禁止。削除はゲストの掃除のトランザクションで、GUC ot.audit_purge_workspace に入れたワークスペースの行だけ許す（M-56）。
-- ワークスペースからの ON DELETE CASCADE は表の所有者の権限で走るので、ロール名の例外では守れない（DB C-29）
CREATE FUNCTION audit_logs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  IF current_setting('ot.audit_purge_workspace', true) IS DISTINCT FROM OLD.workspace_id::text THEN
    RAISE EXCEPTION 'audit_logs is append-only (delete is allowed only in guest cleanup)';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER audit_logs_guard BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_guard();
-- TRUNCATE も拒む（行のトリガーは TRUNCATE で動かないため）
CREATE FUNCTION audit_logs_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$;
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_no_truncate();
