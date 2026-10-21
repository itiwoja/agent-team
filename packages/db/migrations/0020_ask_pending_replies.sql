-- 0020：順番待ちの返事（依頼のページで、担当が動いている間に送った返事）
-- 動いている実行があって返事をすぐ始められないとき、返事をここに置く。実行が終わったら古い順に1つずつ取り出して、
-- 返事の実行として始める（取り出した印は consumed_at。始めると同じトランザクションで付ける）。プロセスが落ちても消えない。
-- text は受けるときに伏せ字にしたあとの本文（maskUserText）。

CREATE TABLE ask_pending_replies (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ask_id        uuid        NOT NULL,
  text          text        NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),
  requester_id  uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz NULL,
  CONSTRAINT ask_pending_replies_ws_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT ask_pending_replies_ask_fk FOREIGN KEY (workspace_id, ask_id) REFERENCES asks (workspace_id, id) ON DELETE CASCADE
);
-- 未消化を古い順に取り出す
CREATE INDEX ask_pending_replies_open_idx ON ask_pending_replies (ask_id, created_at, id) WHERE consumed_at IS NULL;
