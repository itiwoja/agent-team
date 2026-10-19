-- 0006：動いている依頼の実行を拾い直す順（tick の走査。DB §4.1 の2）。tick が拾った時刻を残し、古く拾ったものから回す。
-- 開始の古い順に固定すると、先頭の進まない実行が毎回の件数を使い切って新しい実行が止まる（拾い直しが詰まる）。既存の行は NULL（最初に拾われる）。

ALTER TABLE ask_runs ADD COLUMN last_scanned_at timestamptz NULL;

CREATE INDEX ask_runs_live_scan_idx ON ask_runs (last_scanned_at NULLS FIRST, started_at) WHERE mode = 'live' AND status = 'running';
