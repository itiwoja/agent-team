-- ゲスト（審査員用）のワークスペースをやめる。ワークスペースはオーナーの1つだけになる
-- 1. ゲストのワークスペースを消す（子の表は ON DELETE CASCADE。監査ログは GUC ot.audit_purge_workspace に入れた
--    ワークスペースの行だけ消せるので、1件ずつ GUC を入れてから消す）
-- 2. ゲストのワークスペースにだけ属していた利用者を消す（所属がなくなり、ほかの行からも参照されていないもの）
-- 3. workspaces.kind を 'owner' だけにし、ゲストのための CHECK・索引を外す（delete_requested_at・seed_version の列は残す）
-- 4. 監査ログの守りのメッセージから「ゲストの掃除」を外す
-- 過去の履歴の値（entry_attempts.outcome の 'guest_created'・'guest_reset'・'capacity'・'ip_limit'）は CHECK に残す

-- ---- 1. ゲストのワークスペース ----
CREATE TEMP TABLE guest_members ON COMMIT DROP AS
SELECT DISTINCT m.user_id FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE w.kind = 'guest';

DO $$
DECLARE
  ws uuid;
BEGIN
  FOR ws IN SELECT id FROM workspaces WHERE kind = 'guest' ORDER BY id LOOP
    -- このワークスペースの監査ログの削除だけをトリガーに通させる（トランザクションの中だけ有効）
    PERFORM set_config('ot.audit_purge_workspace', ws::text, true);
    DELETE FROM workspaces WHERE id = ws;
  END LOOP;
  PERFORM set_config('ot.audit_purge_workspace', '', true);
END
$$;

-- ---- 2. 所属のなくなった利用者（ON DELETE CASCADE・SET NULL でない参照が残るものは消さない） ----
DELETE FROM users u
 WHERE u.id IN (SELECT user_id FROM guest_members)
   AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM workspace_policies p WHERE p.created_by = u.id)
   AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.created_by = u.id)
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.requester_id = u.id);

-- ---- 3. ワークスペースの種類 ----
DROP INDEX workspaces_guest_last_seen_idx;
DROP INDEX workspaces_guest_delete_req_idx;
ALTER TABLE workspaces
  DROP CONSTRAINT workspaces_owner_never_deleted_chk,
  DROP CONSTRAINT workspaces_seed_only_guest_chk,
  DROP CONSTRAINT workspaces_kind_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_kind_check CHECK (kind = 'owner'),
  -- 削除予約・シードの版はゲストのためだけだった（列は残すが使わない）
  ADD CONSTRAINT workspaces_no_delete_request_chk CHECK (delete_requested_at IS NULL),
  ADD CONSTRAINT workspaces_no_seed_version_chk CHECK (seed_version IS NULL);

-- ---- 4. 監査ログの守り（動きは同じ。削除は GUC ot.audit_purge_workspace に入れたワークスペースの行だけ） ----
CREATE OR REPLACE FUNCTION audit_logs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  IF current_setting('ot.audit_purge_workspace', true) IS DISTINCT FROM OLD.workspace_id::text THEN
    RAISE EXCEPTION 'audit_logs is append-only';
  END IF;
  RETURN OLD;
END;
$$;
