-- SG-09（ルールの出どころの記録）：判定の記録に、一致した「以後も許可」のルールの id を残す。
-- matched_rule は 'rules.items[2]' のような添字のパスで、定義の変更（ルールの追加・取り消し）でずれるので、id でも指せるようにする。
-- 入るのは decide の手順11でルールに一致した判定（rule_matched・certificate_missing）だけ。ほかは NULL。
-- ルールの id は担当の定義の中で一意（ワークスペース全体では一意と限らない）ので、問い合わせは担当（tasks.agent_id）で絞る。
-- 記録は監査のため、リハーサル（試し実行・影の走行）の判定にも残す。
-- 「最後に使った時刻」（フェーズ1の失効に使う）は本番のタスクだけで数える（再リハーサルが本番で使われないルールを生かし続けないように）。
-- 本番の条件は apps/app の planRemember の live と同じ（is_dry_run でない・rehearsal_run_id がない・shadow でない）。例：
--   SELECT d.matched_rule_id, max(d.created_at) AS last_matched_at
--     FROM policy_decisions d JOIN tasks t ON t.workspace_id = d.workspace_id AND t.id = d.task_id
--    WHERE d.workspace_id = $1 AND t.agent_id = $2 AND d.matched_rule_id IS NOT NULL AND d.reason_code = 'rule_matched' AND d.enforced
--      AND t.is_dry_run = false AND t.rehearsal_run_id IS NULL AND NOT t.shadow
--    GROUP BY d.matched_rule_id;
ALTER TABLE policy_decisions
  ADD COLUMN matched_rule_id text NULL CHECK (matched_rule_id IS NULL OR char_length(matched_rule_id) BETWEEN 1 AND 128);

CREATE INDEX policy_decisions_rule_time_idx ON policy_decisions (workspace_id, matched_rule_id, created_at) WHERE matched_rule_id IS NOT NULL;
