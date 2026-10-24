# 08. DB設計：常駐の表（v1.0 で足す表）
- プロジェクト：Agent-Team-Open ／ 版数：v1.2（2026-10-24） ／ 親：[08 DB設計](README.md)

> **3行で**
> 1. きっかけ（`wakes`）・メインのターン（`turns`）・チャット（`chat_messages`）が常駐の中心。どのきっかけも `wakes` の 1 行になり、`source_key` の UNIQUE で重複を捨てる。
> 2. ルーチン・予約した確認・受け口（`routines`・`scheduled_wakes`・`webhooks`）は、きっかけを作るためだけの表。記憶は 4 つの表（`memory_facts`・`memory_log`・`memory_notes`・`memory_search`）。
> 3. オートレビュー（`auto_reviews`）・VM の控え（`vm_snapshots`）・文脈の先頭（`context_snapshots`）を足した。

---

### TBL-041：wakes（きっかけ）
<details>
<summary>カラム定義（16列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| origin | TEXT | NO | — | | `chat`・`routine`・`scheduled`・`webhook`・`task_done`・`approval_done`・`steer` |
| budget_class | TEXT | NO | — | | `chat`・`auto`（FR-013・D-259） |
| retries | INTEGER | NO | 0 | | 失敗したターンから戻した回数（2 まで：FR-091・D-276） |
| source_key | TEXT | NO | — | UNIQUE | 重複の鍵。`<origin>:<…>` の形（`chat:<messageId>`・`webhook:<hookId>:<配達 ID>` など。FR-090・D-261）。webhook のまとめは `webhook-batch:<hookId>:<分>`（D-284） |
| target_kind | TEXT | NO | — | | `main`・`task` |
| target_task_id | TEXT | YES | — | FK tasks | `target_kind = 'task'` のとき |
| payload | TEXT | NO | — | | JSON。中身（メッセージの ID・ルーチンの ID・覚え書き・webhook の要約・報告の参照） |
| tainted | INTEGER | NO | 0 | | 汚染の印（D-232） |
| status | TEXT | NO | `'queued'` | | `queued`・`attached`・`consumed`・`merged`・`dropped`（D-247・D-284） |
| consumed_turn_id | TEXT | YES | — | FK turns | 結びつけた・渡したターン（`attached`・`consumed`。タスク宛てなら NULL） |
| consumed_step_key | TEXT | YES | — | | 渡した歩み（`input:<n>`）。組み直すときはこの歩みの `result` を使う（D-277） |
| hook_id | TEXT | YES | — | FK webhooks | `webhook` のとき（D-284） |
| body_sha256 | TEXT | YES | — | | `webhook` の本文の sha256（`github` の 24 時間の重複を捨てる。D-261・D-284） |
| drop_reason | TEXT | YES | — | | `budget`・`target_gone`・`retry_exceeded`（件数では捨てない：D-260） |
| created_at | TEXT | NO | NOW | | |

</details>

- 索引：`(status, target_kind, created_at)`・`(hook_id, created_at)`（件数）・`(hook_id, body_sha256)`（重複）。`consumed`・`merged`・`dropped` の行は 30 日で消す（監査は `audit_logs`）
- ターンを閉じると決めるとき、`attached` の行が残っていれば閉じない（FR-091 の 4）。閉じる処理（`done`・`halted`・`failed`）では、残った `attached` の行を同じトランザクションで `queued` に戻す。`failed` のターンで `consumed` にしたメイン宛ての行は、すべて `queued` に戻して `retries` を 1 増やす。3 回目は `dropped`（`retry_exceeded`。D-276）
- `merged`：1 分の上限を超えて、まとめのきっかけに足した配達（終わり。`payload` にまとめの `wakes.id`）。重複と件数のためだけに行を持つ（D-284）

### TBL-042：turns（メインのターン）
<details>
<summary>カラム定義（12列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| status | TEXT | NO | `'running'` | | `running`・`done`・`halted`・`failed` |
| budget_class | TEXT | NO | — | | `chat`・`auto`（まとめたきっかけに `chat` 系があれば `chat`。動いている間に `chat`・`approval_done` を結びつけたら `chat` に上げる：D-279） |
| origins | TEXT | NO | `'[]'` | | JSON の配列。まとめたきっかけの `origin` |
| tainted | INTEGER | NO | 0 | | 汚染したか（汚染したきっかけ・道具の結果・メモを読んだ、使う先頭（`context_snapshots.tainted`）が汚染していて印が消されていない（D-310）、または前の要約のあとの履歴に汚染した内容がある：D-245・D-278・D-285） |
| context_snapshot_id | TEXT | NO | — | FK context_snapshots | 始めたときの先頭（途中の要約で替わったら、歩み `summary:<n>` の `result` に新しい先頭：D-280） |
| steps | INTEGER | NO | 0 | | 歩んだ数 |
| cost_micro_usd | INTEGER | NO | 0 | | |
| halt_reason | TEXT | YES | — | | `budget_exceeded`（1 ターンの $1）・`daily_budget_exceeded`・`steps_exceeded`・`timeout`（D-289） |
| closing_at | TEXT | YES | — | | 閉じると決めた時刻（記憶の更新の前）。入っていればルーターは結びつけない（FR-091 の 4。D-280） |
| started_at | TEXT | NO | NOW | | |
| finished_at | TEXT | YES | — | | |

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
| kind | TEXT | NO | `'text'` | | `text`・`file`・`choices`・`reaction`。選択肢への持ち主の返事は `text`＋`reply_to`（D-274） |
| body | TEXT | NO | — | | JSON。`text`・ファイルの名前とパスと大きさ・問いと選択肢・リアクションの絵文字 |
| reply_to | TEXT | YES | — | FK chat_messages | 選択肢への返事・リアクションの先 |
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

### TBL-048：memory_log（ログ）
<details>
<summary>カラム定義（6列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| day | TEXT | NO | — | | `YYYY-MM-DD`（`TZ`） |
| text | TEXT | NO | — | | 1 行の出来事。200 字まで |
| source | TEXT | NO | — | | `system`（本体）・`main`（記憶の更新）・`owner` |
| ref | TEXT | YES | — | | 関係する ID（タスク・ルーチン） |
| created_at | TEXT | NO | NOW | | |

</details>

### TBL-049：memory_notes（メモ）
| カラム | 型 | NULL | 説明 |
|---|---|---|---|
| id | TEXT | NO | PK |
| agent_id | TEXT | NO | FK agents（メインを含む） |
| tool_call_id | TEXT | YES | UNIQUE。`write_note` の `tool_use` の ID |
| text | TEXT | NO | 500 字まで |
| tainted | INTEGER | NO | 書いたターン・タスクが汚染していたか（D-285） |
| expires_at | TEXT | NO | 書いてから 60 分 |
| created_at | TEXT | NO | |

- 1 人 20 行まで。期限を過ぎた行はタイマーが消す（検索の行も）
- 振り分け先のメモはタスクの文脈の⑤に入れ、汚染したメモがあればタスクは汚染から始める。メインのメモは文脈（⑥）に入れず、`search_memory` でだけ読む（D-285）

### TBL-050：memory_search（記憶の検索）
- FTS5 の仮想表（`tokenize = 'trigram'`。D-225）。列は `kind`（`chat`・`log`・`report`・`note`）・`ref`（元の行の ID）・`day`・`text`・`agent_id`（メモの持ち主。UNINDEXED）・`tainted`（UNINDEXED。D-285）
- 本体が `chat_messages`（`text` だけ）・`memory_log`・`tasks.report`・`memory_notes` を書くときに同じトランザクションで入れる。元の行が消えたら消す
- `search_memory(query, kind?, since?)` は `bm25` の順で上位 10 件を返す。メモは呼んだエージェントのものだけ返す。汚染した報告・メモから入った行は、結果に「外の内容」の印を付け、返したら呼んだターン・タスクは汚染する（D-285）

### TBL-051：auto_reviews（オートレビュー）
<details>
<summary>カラム定義（10列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| task_id | TEXT | NO | — | FK tasks | |
| action_id | TEXT | NO | — | UNIQUE | `browser_actions.id` |
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
<summary>カラム定義（11列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| owner_kind | TEXT | NO | — | | `main`・`task` |
| owner_id | TEXT | YES | — | | タスクの ID（メインは NULL） |
| parts_hash | TEXT | NO | — | | JSON。①〜⑤の部分ごとの sha256（FR-098） |
| memory_copy | TEXT | NO | — | | ④の記憶の写し（プロフィール・ログ 30 件） |
| summary | TEXT | YES | — | | ⑤の要約（メインだけ） |
| history_from | TEXT | YES | — | | 履歴（⑥）に入れる最初のチャット・歩みの位置 |
| tokens | INTEGER | NO | 0 | | ①〜⑤の大きさ |
| tainted | INTEGER | NO | 0 | | 要約に渡した⑤・⑥に汚染した内容があったか（前の要約の汚染も引き継ぐ。D-278） |
| untainted_at | TEXT | YES | — | | 持ち主が印を消した時刻（API-147）。入っていれば汚染していない扱い（D-310） |
| created_at | TEXT | NO | NOW | | |

</details>

- メインの今の先頭は、`owner_kind = 'main'` の最新の行。古い行は、参照する `turns` が残っている間は消さない（D-262）。`tainted = 1` の先頭を使うターンは汚染から始める（D-278）

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
