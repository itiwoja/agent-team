-- 汚染後の Web の出口（SG-04・D-30）：タスクが見た URL の集合
-- 汚染されたあとの web_fetch は、そのタスクの web_search の結果のリンクと、web_fetch で取ったページの中のリンクだけを辿れる。
-- edge が正規化した URL（フラグメントを落とす・ホストを小文字に）の SHA-256 だけを持つ（URL の本文は持たない）。
-- 集合はタスクごとに上限まで（edge の SEEN_URLS_MAX_PER_TASK。超えた分は足さない）。
-- tasks の列にしないのは、tasks は SELECT * で頻繁に引かれ、最大 2000 件のハッシュを毎回運ぶことになるため。
-- policy_decisions.counters にしないのは、counters は Kernel の decide の入力の写し（inputsHash に入る）で、
-- 判定のたびに同じ集合を写すうえ、Kernel の入力を変えることになるため（この制限は decide ではなく edge の Web の出口で効かせる。BR-39・D-58）。

CREATE TABLE task_web_urls (
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id       uuid        NOT NULL,
  url_hash      bytea       NOT NULL CHECK (octet_length(url_hash) = 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_web_urls_pk PRIMARY KEY (task_id, url_hash),
  CONSTRAINT task_web_urls_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) ON DELETE CASCADE
);
