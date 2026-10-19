-- 0009：障害 F-15〜F-17（Google カレンダーの障害：誤った招待・二重の予定・埋まっている時間との重なり、時刻の取り違え、作っていない予定の削除）
-- 0005 と同じく、0003 の fault_ids の CHECK（rehearsal_cases・rehearsal_scenarios）と、rehearsal_user_inputs.nearest_fault_id の CHECK を張り替える。
-- 制約名は 0003 の列の CHECK（名前をつけていない）が Postgres に付けた名前：<表>_<列>_check。
-- 既存の行は F-15〜F-17 を含まないので、張り替えても既存の行は通る。

ALTER TABLE rehearsal_cases DROP CONSTRAINT rehearsal_cases_fault_ids_check;
ALTER TABLE rehearsal_cases ADD CONSTRAINT rehearsal_cases_fault_ids_check CHECK (fault_ids <@ ARRAY[
  'F-01','F-02','F-03','F-04','F-05','F-06','F-07','F-08','F-09','F-10','F-11','F-12','F-13','F-14','F-15','F-16','F-17']::text[]);

ALTER TABLE rehearsal_scenarios DROP CONSTRAINT rehearsal_scenarios_fault_ids_check;
ALTER TABLE rehearsal_scenarios ADD CONSTRAINT rehearsal_scenarios_fault_ids_check CHECK (fault_ids <@ ARRAY[
  'F-01','F-02','F-03','F-04','F-05','F-06','F-07','F-08','F-09','F-10','F-11','F-12','F-13','F-14','F-15','F-16','F-17']::text[]);

ALTER TABLE rehearsal_user_inputs DROP CONSTRAINT rehearsal_user_inputs_nearest_fault_id_check;
ALTER TABLE rehearsal_user_inputs ADD CONSTRAINT rehearsal_user_inputs_nearest_fault_id_check
  CHECK (nearest_fault_id IS NULL OR nearest_fault_id ~ '^F-(0[1-9]|1[0-7])$');
