-- パックの作業場（D-116）から出された依頼：どのパックの作業場から出したかを残す（asks.pack_id）
-- 生成（設定プランナーの呼び出し）は依頼の行を作ったあとに裏で進むので、「パックの担当を優先して使い回す」ヒントを行に残して読み直す。
-- 入るのは、受け付けた時点でそのワークスペースに入っているパック（pack_installs.pack_id）の id だけ（apps/app の acceptAsk が確かめる）。
-- pack_installs への外部キーは張らない（パックの記録は id の文字列で、依頼の記録はパックの記録より長く残る）。形は pack_installs.pack_id と同じ。
-- 番号は欠番（0014・0017）を埋めずに次の番号を使う（17_security_governance.md）。
ALTER TABLE asks
  ADD COLUMN pack_id text NULL CHECK (pack_id IS NULL OR pack_id ~ '^[a-z0-9-]{2,40}$');
