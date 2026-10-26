# 08. DB設計：常駐の表（v1.0 で足す表）
- プロジェクト：Agent-Team-Open ／ 版数：v1.5（2026-10-25） ／ 親：[08 DB設計](README.md)

> **3行で**
> 1. きっかけ（`wakes`）・メインのターン（`turns`）・チャット（`chat_messages`）が常駐の中心。どのきっかけも `wakes` の 1 行になり、`source_key` の UNIQUE で重複を捨てる。
> 2. ルーチン・予約した確認・受け口（`routines`・`scheduled_wakes`・`webhooks`）は、きっかけを作るためだけの表。記憶は 2 つの層（プロフィールの `memory_facts`・検索の `memory_search`）。
> 3. オートレビュー（`auto_reviews`）・VM の控え（`vm_snapshots`）・文脈の先頭（`context_snapshots`）を足した。

---

### TBL-041：wakes（きっかけ）
<details>
<summary>カラム定義（15列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| origin | TEXT | NO | — | | `chat`・`routine`・`scheduled`・`webhook`・`task_done`・`approval_done`・`steer` |
| budget_class | TEXT | NO | — | | `chat`・`auto`（FR-013・D-322） |
| retries | INTEGER | NO | 0 | | 失敗したターンから戻した回数（2 まで：FR-091・D-276） |
| source_key | TEXT | NO | — | UNIQUE | 重複の鍵。`<origin>:<…>` の形（`chat:<messageId>`・`webhook:<hookId>:<配達 ID>` など。FR-090・D-261）。重複は `source_key` の UNIQUE だけで捨てる（D-318） |
| target_kind | TEXT | NO | — | | `main`・`task` |
| target_task_id | TEXT | YES | — | FK tasks | `target_kind = 'task'` のとき |
| payload | TEXT | NO | — | | JSON。中身（メッセージの ID・ルーチンの ID・覚え書き・webhook の要約・報告の参照） |
| tainted | INTEGER | NO | 0 | | 汚染の印（D-232） |
| status | TEXT | NO | `'queued'` | | `queued`・`consumed`・`dropped` |
| consumed_turn_id | TEXT | YES | — | FK turns | 渡したターン（`consumed`。記録として残す。タスク宛てなら NULL） |
| consumed_step_key | TEXT | YES | — | | どのターンのどの歩み（`input:<n>`）で渡したかの記録。組み直すときはこの歩みの `result` を使う（D-277） |
| hook_id | TEXT | YES | — | FK webhooks | `webhook` のとき。1 分の件数を数えるために持つ（D-318） |
| drop_reason | TEXT | YES | — | | `budget`・`target_gone`・`retry_exceeded`（件数の超過は 429 で断り、行を残さない：D-318） |
| created_at | TEXT | NO | NOW | | |

</details>

- 索引：`(status, target_kind, created_at)`・`(hook_id, created_at)`（件数）。`consumed`・`dropped` の行は 30 日で消す（監査は `audit_logs`）
- 動いている間に届いたきっかけは `queued` のまま、終了後に次へ渡す。失敗ターンの元のきっかけを戻すのはFR-091の「副作用未発生を証明できる場合」だけ。確定済み/結果不明の副作用があれば `consumed_turn_id`・`consumed_step_key` と `consumed` を保持し再受付しない（IMP-009）

### TBL-042：turns（メインのターン）
<details>
<summary>カラム定義（11列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| status | TEXT | NO | `'running'` | | `running`・`done`・`halted`・`failed` |
| budget_class | TEXT | NO | — | | `chat`・`auto`。始めるときに決めて変えない。まとめたきっかけに `chat`・`approval_done`・`steer`（持ち主から）が 1 つでもあれば `chat`、それ以外は `auto`（D-322） |
| origins | TEXT | NO | `'[]'` | | JSON の配列。まとめたきっかけの `origin` |
| tainted | INTEGER | NO | 0 | | 汚染したか（汚染したきっかけを受けた、外の内容を含む道具の結果を読んだ、検索で汚染した報告が返った：D-245） |
| context_snapshot_id | TEXT | NO | — | FK context_snapshots | 始めたときの先頭（履歴が 6 万トークンを超えていれば、ターンの行を作る前に要約して新しい先頭を作る：D-323） |
| steps | INTEGER | NO | 0 | | 歩んだ数 |
| cost_micro_usd | INTEGER | NO | 0 | | |
| halt_reason | TEXT | YES | — | | `budget_exceeded`（1 ターンの $1）・`daily_budget_exceeded`・`steps_exceeded`・`timeout`・`context_exceeded`（呼び出しの前の入力が 20 万トークンを超えた。次のターンの開始で要約する：D-323） |
| started_at | TEXT | NO | NOW | | |
| finished_at | TEXT | YES | — | | |

`turns` には `failure_notice_id TEXT NULL UNIQUE REFERENCES chat_messages(id)` も持つ。副作用後の失敗確定・system通知・outboxを同一トランザクションで作り、このIDを埋める。通知はrole=system/turn_id=対象ターン、pushのsource_refはそのmessage ID。再起動しても再作成しない。副作用判定は当該ターンの歩みと `tool_call_id` の対象を照合し、不明なら停止側に倒す。

</details>

- 制約：`running` の行は 1 つだけ（部分 UNIQUE）

### TBL-043：chat_messages（チャット）
<details>
<summary>カラム定義（11列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7。持ち主のメッセージは画面が作る（`Idempotency-Key` と同じ） |
| tool_call_id | TEXT | YES | — | UNIQUE | `main` のとき、`send_to_owner` の `tool_use` の ID（D-249） |
| role | TEXT | NO | — | | `owner`・`main`・`system` |
| kind | TEXT | NO | `'text'` | | `text`・`file`・`choices`。選択肢への持ち主の返事は `text`＋`reply_to`（D-274） |
| body | TEXT | NO | — | | JSON。`text`・ファイルの名前とパスと大きさ・問いと選択肢 |
| reply_to | TEXT | YES | — | FK chat_messages | 選択肢への返事の先 |
| turn_id | TEXT | YES | — | FK turns | `main` のとき書いたターン |
| notify | INTEGER | NO | 0 | | Web Push を送る対象か（`send_to_owner` の `notify`）。送ったかは `push_outbox` の行で見る（D-288） |
| status | TEXT | NO | `'sent'` | | `sent`・`delivered`（持ち主のメッセージをターンに渡した） |
| created_at | TEXT | NO | NOW | | |
| delivered_at | TEXT | YES | — | | |

</details>

- 索引：`(created_at)`。消さない（記憶の検索にも入れる）

### TBL-044：routines（ルーチン）
<details>
<summary>カラム定義（12列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| name | TEXT | NO | — | | 40 字まで |
| prompt | TEXT | NO | — | | 2,000 字まで |
| schedule | TEXT | NO | — | | cron の 5 欄。15 分以上の間隔（D-221） |
| tz | TEXT | NO | — | | IANA の名前 |
| agent_id | TEXT | YES | — | FK agents | 振り分けたいエージェント（任意） |
| enabled | INTEGER | NO | 1 | | |
| next_run_at | TEXT | NO | — | | |
| last_run_at | TEXT | YES | — | | |
| created_by | TEXT | NO | — | | `owner`・`main`（提案を持ち主が承認） |
| tainted | INTEGER | NO | 0 | | 汚染した提案から作った（持ち主がプロンプトを直すと 0。D-245） |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：20 行まで（作るときに数える）。メインの提案は承認されるまで `routine_proposals`（[TBL-054](#tbl-054routine_proposalsルーチンの提案)）に置く

### TBL-054：routine_proposals（ルーチンの提案）
| カラム | 型 | NULL | 説明 |
|---|---|---|---|
| id | TEXT | NO | PK。確認カードの ID（API-142） |
| name・prompt・schedule・tz・agent_id | — | — | `routines` と同じ |
| turn_id | TEXT | NO | FK turns。提案したターン |
| tool_call_id | TEXT | NO | UNIQUE。`propose_routine` の `tool_use` の ID |
| tainted | INTEGER | NO | 提案したターンが汚染していたか（できたルーチンに引き継ぐ） |
| status | TEXT | NO | `pending`・`approved`・`rejected`・`expired` |
| expires_at | TEXT | NO | 作ってから 7 日 |
| created_at | TEXT | NO | |

- 承認（API-142）で `routines` に `created_by = 'main'` の行を作り、`approved` にする

### TBL-045：scheduled_wakes（予約した確認）
<details>
<summary>カラム定義（8列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| at | TEXT | NO | — | | 起きる時刻（5 分後〜30 日後） |
| note | TEXT | NO | — | | 500 字まで |
| turn_id | TEXT | NO | — | FK turns | 予約したターン |
| tool_call_id | TEXT | NO | — | UNIQUE | `schedule_wake` の `tool_use` の ID（D-249） |
| tainted | INTEGER | NO | 0 | | 予約したターンが汚染していたか |
| status | TEXT | NO | `'pending'` | | `pending`・`fired`・`cancelled` |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：1 日（作った日）に 20 行まで（D-222）

### TBL-046：webhooks（受け口）
<details>
<summary>カラム定義（9列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | `hookId`。128 bit を base32 で（URL に使う） |
| kind | TEXT | NO | — | | `github`・`generic` |
| name | TEXT | NO | — | | 40 字まで |
| note | TEXT | NO | `''` | | メインに添える説明（500 字まで） |
| secret_enc | TEXT | NO | — | | 署名の秘密（`ENCRYPTION_KEY` で暗号化） |
| enabled | INTEGER | NO | 1 | | |
| last_delivery_at | TEXT | YES | — | | |
| delivery_count | INTEGER | NO | 0 | | |
| created_at | TEXT | NO | NOW | | |

</details>

### TBL-047：memory_facts（プロフィール）
<details>
<summary>カラム定義（8列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| text | TEXT | NO | — | | 1 つの事実。200 字まで |
| rank | REAL | NO | 0 | | 順位。使われると上がり、日がたつと下がる |
| source | TEXT | NO | — | | `main`・`owner` |
| source_turn_id | TEXT | YES | — | FK turns | |
| updated_at | TEXT | NO | NOW | | |
| deleted_at | TEXT | YES | — | | 消したとき（行は残す） |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：`deleted_at IS NULL` の行は 100 個・合計 4,000 字まで（書くときに数える：D-224）

### TBL-050：memory_search（記憶の検索）
- FTS5 の仮想表（`tokenize = 'trigram'`。D-225）。索引するのはチャット（持ち主のメッセージと `send_to_owner` の文）とタスクの報告。列は `kind`（`chat`・`report`）・`ref`（元の行の ID）・`day`・`text`・`tainted`（UNINDEXED）
- 本体が `chat_messages`（`text` だけ）・`tasks.report` を書くときに同じトランザクションで入れる。元の行が消えたら消す
- `search_memory(query, kind?, since?)` は `bm25` の順で上位 10 件を返す。汚染した報告から入った行は、結果に「外の内容」の印を付け、返したら呼んだターン・タスクは汚染する（D-325）

### TBL-051：auto_reviews（オートレビュー）
<details>
<summary>カラム定義（10列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| task_id | TEXT | NO | — | FK tasks | |
| action_id | TEXT | NO | — | UNIQUE, FK browser_actions | `browser_actions.id` |
| verdict | TEXT | YES | — | | `pass`・`stop`・`error`。答えを待つ間は NULL |
| reason | TEXT | YES | — | | 200 字まで |
| model | TEXT | NO | — | | 使ったモデル |
| cost_micro_usd | INTEGER | NO | 0 | | |
| check_id | TEXT | YES | — | FK browser_checks | 人に回したとき |
| created_at | TEXT | NO | NOW | | |
| decided_at | TEXT | YES | — | | |

</details>

### TBL-052：vm_snapshots（VM の控え）
| カラム | 型 | NULL | 説明 |
|---|---|---|---|
| id | TEXT | NO | PK |
| kind | TEXT | NO | `daily`・`manual` |
| path | TEXT | NO | box-manager の控え専用のボリュームの中のパス `/snapshots/<id>.tar.zst`（本体のデータのボリュームには置かない：D-309） |
| size_bytes | INTEGER | YES | `ready` のとき必須。`creating`・`failed` は NULL でよい（D-295） |
| status | TEXT | NO | `creating`・`ready`・`failed`・`deleted` |
| created_at | TEXT | NO | |

- `ready` の行は 3 つまで（D-215）。超えたら古いものから `deleted` にしてファイルを消す
- 制約：`status = 'ready'` ⇒ `size_bytes IS NOT NULL`。`creating` の行は 1 つまで。本体の再開で `vm_op` が `snapshotting` でないのに残った `creating` は `failed` にする（FR-084・D-295）

### TBL-053：context_snapshots（文脈の先頭）
<details>
<summary>カラム定義（9列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| owner_kind | TEXT | NO | — | | `main`・`task` |
| owner_id | TEXT | YES | — | | タスクの ID（メインは NULL） |
| parts_hash | TEXT | NO | — | | JSON。①〜⑤の部分ごとの sha256（FR-098） |
| fixed_parts_json | TEXT | NO | — | | ①〜⑤の実際に送る固定本文JSON（system・tools・指示・スキル/振分先一覧・記憶・要約、タスクはbrief）。不変。各部分の保存バイトからparts_hashを算出し、再開時検証。memory_copy/summaryはこの本文の投影 |
| memory_copy | TEXT | NO | — | | ④の記憶の写し（プロフィール） |
| summary | TEXT | YES | — | | ⑤の要約（メインだけ） |
| history_from | TEXT | YES | — | | 履歴（⑥）に入れる最初のチャット・歩みの位置 |
| tokens | INTEGER | NO | 0 | | ①〜⑤の大きさ |
| created_at | TEXT | NO | NOW | | |

</details>

- メインの今の先頭は、`owner_kind = 'main'` の最新の行。古い行は、参照する `turns` が残っている間は消さない（D-262）。要約は汚染の印を引き継がない（D-323）

### TBL-055：push_outbox（Web Push の送り待ち）
| カラム | 型 | NULL | 説明 |
|---|---|---|---|
| id | TEXT | NO | PK |
| notice_id | TEXT | NO | 1 つの通知の ID（購読ごとの行で同じ） |
| subscription_id | TEXT | NO | FK push_subscriptions。送る端末（D-288） |
| tag | TEXT | NO | `chat`・`check:<id>`・`takeover:<id>`（同じ tag・同じ購読の `pending` は置き換える） |
| body | TEXT | NO | JSON。題・本文・開く画面の URL（秘密を入れない） |
| source_ref | TEXT | NO | 元の行（`chat_messages`・`browser_checks`・`approvals`・`routine_proposals`・`takeovers`）の ID |
| status | TEXT | NO | `pending`・`sent`・`failed`・`expired`・`skipped`（見えている端末があって送らなかった。D-288） |
| attempts | INTEGER | NO | この購読に送った回数（3 まで） |
| expires_at | TEXT | NO | 作ってから 1 時間 |
| created_at | TEXT | NO | |

- 元の行と同じトランザクションで、その時の購読ごとに 1 行ずつ入れる（D-267・D-288）。送り手は `pending` を古い順に送る。送る時に見えている端末があれば、同じ `notice_id` の行をすべて `skipped` にする。購読を消したら、その購読の `pending` の行は `failed`。終わった行は 7 日で消す
