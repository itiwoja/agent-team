# 08. DB設計：常駐の表（v1.0 で足す表）
- プロジェクト：Agent-Team-Open ／ 版数：v1.7（2026-10-26） ／ 親：[08 DB設計](README.md)

> **3行で**
> 1. きっかけ（`wakes`）・メインのターン（`turns`）・チャット（`chat_messages`）が常駐の中心。どのきっかけも `wakes` の 1 行になり、`source_key` の UNIQUE で重複を捨てる。
> 2. ルーチン・予約した確認・受け口（`routines`・`scheduled_wakes`・`webhooks`）は、きっかけを作るためだけの表。記憶は 2 つの層（プロフィールの `memory_facts`・検索の `memory_search`）。
> 3. オートレビュー（`auto_reviews`）・VM の控え（`vm_snapshots`）・文脈の先頭（`context_snapshots`）を足した。v1.6 で、外に出た通信の台帳（`egress_events`・付属の `egress_daily`：TBL-056）とモデルの能力と単価（`llm_models`：TBL-059）を足した。オートレビューは既定で行ができない。v1.7 で、家計簿（`ledger_entries`：TBL-061）とチャットの添付（`chat_attachments`：TBL-063）を足し、モデルの表（`llm_models`）に判断モデルの接続先 `decision` を足した。

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
- v1.7：画像つきのメッセージは、`body` の JSON に `attachmentIds`（`chat_attachments` の ID の配列。10 個まで）を持つ。`kind` は `text` のまま。レシートを送ったときのメインの返事は `choices` か `text` で、`body` に `ledgerEntryId` を持てる（SCR-020：D-375・376）

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
オートレビューを入れたとき（`review.auto.enabled = true`）だけ行ができる。**既定（切）では行ができない**（D-351）。`model` は、`review` の役割に割り当てたモデル名（`llm_models.model`。接続先は `llm_models.provider`。D-352）。
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

### TBL-056：egress_events（外に出た通信の台帳）
本体と VM から外へ出た通信を 1 件 1 行で残す（D-344）。**中身（本文・URL のパス・ヘッダー）は残さない**。宛先はホスト名（とポート）だけ。画面は SCR-027、API は API-148。
記録の経路（D-359）：VM の通信は egress が自分の中に溜め（最大 1 万件）、box-manager が毎分取りに行って本体に渡す。本体の外向き（LLM・カレンダー・GitHub・Push・ntfy）は、本体の中の窓口 `net` が許可リストで絞り、その場で書く。

<details>
<summary>カラム定義（18列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7（VM から渡る行は egress が付けた ID。同じ ID は二度入れない） |
| kind | TEXT | NO | `'request'` | | `request`（通信 1 件）・`gap`（台帳に書けなかった分の件数。D-360） |
| source | TEXT | NO | — | | 送り元：`core`（本体）・`vm_browser`・`vm_shell` |
| host | TEXT | YES | — | | 宛先のホスト名（IP のときは IP）。`gap` のときは NULL |
| port | INTEGER | YES | — | | 宛先のポート |
| purpose | TEXT | YES | — | | `llm`・`tool`・`browser`・`terminal`・`notify`。`gap` のときは NULL |
| decision | TEXT | NO | — | | `allow`・`deny` |
| deny_reason | TEXT | YES | — | | `deny` のとき：`not_in_allowlist`（`closed` で許可リストにない）・`fixed_exclusion`（本体・box-manager・tailnet・ホスト自身・クラウドのメタデータ。D-343）・`internal_host_not_allowed` |
| in_allowlist | INTEGER | YES | — | | 判定のとき、許可リストの中だったか（0/1）。`network.mode = 'closed'` のときだけ入れる（`standard` は NULL）。`decision = 'allow'` かつ `0` の行は、出てはいけない通信（SCR-027 の「外向き 0」の数え方）。許可は必ず `1` になる作りで、`0` が出たら不具合 |
| bytes_out | INTEGER | NO | 0 | | 送ったバイト数 |
| bytes_in | INTEGER | NO | 0 | | 受けたバイト数 |
| llm_role | TEXT | YES | — | | `purpose = 'llm'` のとき：`main`・`worker`・`computer`・`review`・`summary` |
| llm_model | TEXT | YES | — | | `purpose = 'llm'` のとき：モデル名 |
| input_tokens | INTEGER | YES | — | | `llm` のときの入力のトークン数 |
| output_tokens | INTEGER | YES | — | | `llm` のときの出力のトークン数 |
| gap_count | INTEGER | YES | — | | `kind = 'gap'` のとき：書けなかった件数（D-360）。`gap` では必須 |
| task_id | TEXT | YES | — | FK tasks | 分かるとき（メインのターンは NULL） |
| occurred_at | TEXT | NO | NOW | | 通信が起きた時刻（`gap` は欠けた区間の終わり） |

</details>

- 制約：`in_allowlist IN (0,1)`（NULL 可）。`kind = 'gap'` ⇒ `gap_count IS NOT NULL AND gap_count > 0`。`kind = 'request'` ⇒ `host IS NOT NULL AND purpose IS NOT NULL`。`purpose` は上の 5 つのどれか
- 索引：`(occurred_at)`・`(decision, occurred_at)`・`(host, occurred_at)`・`(kind, occurred_at)`
- 台帳に書けないとき（D-360）：`closed` では新しい外向きを断る。`standard` では通し、欠けた件数を `gap` の行で残し（egress の溜まりが満杯のときも同じ）、状態欄（SCR-023）に「台帳の欠け N 件」と出す。監査ログには `egress.gap` を書く。許可リストの外へ出ようとして断ったものは `deny` の行で残す
- 保持：`egress_events` の行は 90 日で消す。日ごとの集計 `egress_daily` は無期限（NFR-089 の確かめは集計で行う）。想定：1 日に数千行まで

#### 付属：egress_daily（日ごとの集計）
`egress_events` に行を足すのと同じトランザクションで、この表を加算する（UPSERT）ので、元の行を消しても集計は残る（D-368）。別の TBL 番号は振らない。

| カラム | 型 | NULL | 説明 |
|---|---|---|---|
| day | TEXT | NO | 日付（`YYYY-MM-DD`、`TZ`）。PK の一部 |
| source | TEXT | NO | `core`・`vm_browser`・`vm_shell`。PK の一部 |
| purpose | TEXT | NO | 5 つの目的。`gap` の行は `''`。PK の一部 |
| host | TEXT | NO | 宛先のホスト。`gap` の行は `''`。PK の一部 |
| decision | TEXT | NO | `allow`・`deny`（`gap` の行は `allow`）。PK の一部 |
| kind | TEXT | NO | `request`・`gap`。PK の一部 |
| requests | INTEGER | NO | 件数（`gap` の行は欠けた件数） |
| outside_allowlist | INTEGER | NO | `closed` のとき、`decision = 'allow'` で `in_allowlist = 0` だった件数（0 のはず） |
| bytes_out | INTEGER | NO | 送った合計 |
| bytes_in | INTEGER | NO | 受けた合計 |
| input_tokens | INTEGER | NO | `llm` の入力のトークンの合計 |
| output_tokens | INTEGER | NO | `llm` の出力のトークンの合計 |

- 索引：主キーのみ（`day` が先頭なので期間の絞り込みに使える）。想定：1 日に数十行
- 保持：無期限

### TBL-059：llm_models（モデルの能力と単価）
使えるモデルの一覧。能力と単価を持ち、役割（`main`・`worker`・`computer`・`review`・`summary`。v1.7：`classify`）への割り当て（`workspace_policies.llm`）を確かめるのに使う（D-352・353）。画面は SCR-029、API は API-152。

<details>
<summary>カラム定義（17列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| provider | TEXT | NO | — | | 接続先：`anthropic`・`openai`・`openai_compatible`・`openai_chatgpt`（v1.7：ChatGPT でサインイン。Responses API。API キー不要：D-385）・`decision`（v1.7：判断モデルの口。Kev の `/v1/systemone` 互換、または OpenAI 互換で選択肢の確率を返すもの：D-379） |
| model | TEXT | NO | — | | モデル名。`(provider, model)` は UNIQUE（`openai_compatible` は `base_url` も含めて UNIQUE） |
| base_url | TEXT | YES | — | | `openai_compatible`・`decision` のとき必須（Ollama・vLLM・LM Studio、判断モデルの推論サーバーなど）。それ以外は NULL。`closed` のときは `network.allow_hosts` にあるものだけ使える。キーは `.env` の `OPENAI_COMPATIBLE_API_KEY`（任意。D-361）で、DB には置かない |
| cap_tools | INTEGER | NO | 0 | | 道具の呼び出し（0/1）。`main`・`worker` に要る |
| cap_vision | INTEGER | NO | 0 | | 画像の入力（0/1）。`review` と、写真・レシートを読む役割に要る |
| cap_computer_use | TEXT | NO | `'none'` | | 画面の操作の形：`claude`・`openai`・`generic`（スクショ＋座標の本体の道具。試し扱い）・`none`。`computer` に要る（`none` 以外。`generic` は `llm.experimental_generic_computer = true` のときだけ：D-354） |
| cap_decision | INTEGER | NO | 0 | | 判断の型つき出力（選択・点数・はい/いいえを返せる：0/1）。v1.7：`classify` に要る。`provider = 'decision'` は必ず 1（D-379） |
| context_tokens | INTEGER | NO | — | | 文脈の長さ。要約と上限のしきい値はこれに合わせる（D-363） |
| prompt_cache | INTEGER | NO | 0 | | プロンプトキャッシュを使えるか（0/1。D-355） |
| price_input_micro_usd | INTEGER | YES | — | | 入力の単価（100 万トークンあたり、マイクロドル）。ローカルは **0 を明示**する。NULL は未設定 |
| price_output_micro_usd | INTEGER | YES | — | | 出力の単価 |
| price_cache_read_micro_usd | INTEGER | YES | — | | キャッシュ読みの単価 |
| price_cache_write_micro_usd | INTEGER | YES | — | | キャッシュ書き（5 分）の単価 |
| price_cache_write_1h_micro_usd | INTEGER | YES | — | | キャッシュ書き（1 時間）の単価。`anthropic` 以外は NULL |
| origin | TEXT | NO | `'owner'` | | `seed`（最初から入っているもの）・`owner`（持ち主が足した） |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：`provider IN ('openai_compatible','decision')` ⇔ `base_url IS NOT NULL`。`provider = 'decision'` ⇒ `cap_decision = 1` かつ `cap_tools = 0`（判断モデルは道具を呼ばない）。`cap_computer_use IN ('claude','openai','generic','none')`。`context_tokens > 0`。`cap_tools`・`cap_vision`・`cap_decision`・`prompt_cache` は 0/1。`cap_computer_use = 'claude'` は `provider = 'anthropic'`、`'openai'` は `provider = 'openai'` のときだけ（`openai_chatgpt` は `'none'`）
- v1.7：`provider = 'openai_chatgpt'` の行は、サインインしたあとにトークンでモデルの一覧を取って写す（固定しない：D-385）。`base_url` は NULL、`cap_tools = 1`、`cap_vision = 0`・`cap_computer_use = 'none'`（確かめてから足す：D-390。`computer` には選べない）、`prompt_cache = 0`。単価は **0 を明示**する（費用 0 円。呼び出し回数とトークンは `usage_records` と台帳に残す：D-388）。トークンはこの表に置かない（`workspace.chatgpt_auth`：TBL-031）。サインインが切れたら `usable = false`
- 単価が空（`price_input_micro_usd` か `price_output_micro_usd` が NULL）のモデルは、役割に割り当てられず、動かさない（費用の上限を宣言した単価で計算するため：D-353・355）。`usage_records` の費用はこの単価で計算する
- 最初の行（`origin = 'seed'`）：`anthropic` の `claude-opus-5-5`（`main`・`worker`・`computer` の既定）と `claude-sonnet-5-5`（`review`・`summary` の既定）（D-362）。単価は版と一緒に入れる。OpenAI・互換は既定がなく、持ち主が足す
- v1.7：役割 `classify` は `cap_decision = 1` のモデルだけ割り当てられる。単価は 0 を明示する（家の中のモデルのとき）。ラズパイのローカルの生成モデル（4B 級・量子化）は `cap_tools = 0` で登録し、`cap_computer_use = 'none'` にするので、`main`・`worker`・`computer` には割り当てられず、`summary` と短い文章の役割だけ選べる（D-380）。候補は Von・Laya（mmBERT は多言語）・Rizzo Flow。日本語の精度・速さ・ライセンスを実機で確かめてから既定にする（R-109）。最初の行（`seed`）には判断モデルを入れない
- 割り当ての保存は、役割ごとに能力を照合してから、同じトランザクションで `workspace_policies.llm` を書く。能力が足りなければ保存できない
- 保持：無期限。想定：10 行以下

### TBL-061：ledger_entries（家計簿の 1 行）
チャットで送ったレシートの写真から作る家計簿の 1 行（D-375）。家の中の SQLite にだけ置く。画面は SCR-031、API は API-154。流れ：レシートの写真を送る → 画像を読める役割（既定はクラウド）が店・日付・品目・金額・支払い方法を読む → 費目は `classify`（自信が低ければ LLM）→ この表に入れる → カレンダーの同じ日の予定と照らす → 月ごとの画面と CSV。

<details>
<summary>カラム定義（22列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| entry_date | TEXT | NO | — | | 買った日（`YYYY-MM-DD`）。読み取れなければ送った日を入れて `confidence_date` を低くする |
| store | TEXT | YES | — | | 店の名前 |
| items | TEXT | NO | `'[]'` | | JSON の配列。品目：`{ "name", "qty", "amount_yen" }`。100 品目まで |
| amount_yen | INTEGER | NO | — | | 合計の金額（円。税込）。家計簿は円で持つ（API の費用の `*_micro_usd` とは別） |
| category | TEXT | NO | `'未分類'` | | 費目（食費・日用品・交通・医療・衣類・趣味・光熱費・その他・未分類。持ち主が足せる） |
| category_source | TEXT | NO | `'llm'` | | 費目を決めた元：`classify`（判断モデル）・`llm`（自信が下限より低くて上の役割に回した）・`owner`（直した） |
| payment_method | TEXT | YES | — | | 現金・クレジット・電子マネー・QR など。読み取れなければ NULL |
| receipt_path | TEXT | YES | — | | 保管庫の `レシート` の中のパス（`vault_files.path`）。元の画像 |
| attachment_id | TEXT | YES | — | FK chat_attachments | 送ったチャットの添付 |
| source_message_id | TEXT | YES | — | FK chat_messages | 送ったチャットのメッセージ |
| confidence_amount | REAL | YES | — | | 金額の読み取りの自信（0〜1） |
| confidence_date | REAL | YES | — | | 日付の読み取りの自信（0〜1） |
| confidence_category | REAL | YES | — | | 費目の自信（0〜1）。判断モデルの出力 |
| low_confidence | INTEGER | NO | 0 | | 自信が低いか（0/1）。`confidence_amount` か `confidence_date` が下限（`classify.min_confidence`）より低いと 1。画面で印を付け、確認のカードを出す（SCR-019・031） |
| review_status | TEXT | NO | `'confirmed'` | | `confirmed`（そのまま）・`needs_check`（確認待ち）・`corrected`（持ち主が直した） |
| matched_event | TEXT | YES | — | | JSON。同じ日のカレンダーの予定：`{ "title", "start" }`。「家族で外食」などをメモに付ける。つながっていなければ NULL |
| memo | TEXT | YES | — | | メモ（予定との照らし合わせの結果・持ち主のメモ。200 字まで） |
| tainted | INTEGER | NO | 1 | | 外から来た画像の読み取り結果か（0/1。レシートの文字は命令として扱わない：BR-06）。持ち主が直した行は 0 |
| created_at | TEXT | NO | NOW | | |
| updated_at | TEXT | NO | NOW | | |
| corrected_at | TEXT | YES | — | | 持ち主が直した時刻（`audit_logs` の `ledger.corrected` と対） |

</details>

- 制約：`amount_yen >= 0`。`review_status IN ('confirmed','needs_check','corrected')`。`low_confidence IN (0,1)`。`confidence_*` は 0〜1。`low_confidence = 1` ⇒ `review_status` は `needs_check` か `corrected`。同じレシートの二重登録を防ぐ UNIQUE `(attachment_id)`（同じ写真を 2 度送ったら、前の行を見せて確かめる）
- 索引：`(entry_date)`・`(category, entry_date)`・`(review_status)`・`(store, entry_date)`
- 直す（API-154）：金額・日付・費目・店・メモを直せる。直したら `review_status = 'corrected'`・`corrected_at`・`category_source = 'owner'` にし、`audit_logs` に `ledger.corrected`（直した前後の値）を残す。レシートの画像と読み取った元の値は残す（いつでも見比べられる）
- 月の合計・費目ごとは、この表から数える（別の集計表は持たない）。CSV の書き出しは API-154（列：`entry_date,store,category,amount_yen,payment_method,memo`。セルの先頭が `=`・`+`・`-`・`@` のときは `'` を付ける）
- 保持：無期限（持ち主が消すまで）。元の画像は保管庫の `レシート` にあり、ゴミ箱に入れたら 30 日で消える（行は残る）。想定：1 か月に 50〜100 行

### TBL-063：chat_attachments（チャットの添付）
チャットに添付した画像（D-376）。スマホから 1 回 10 枚まで・1 枚 20MB まで（JPEG・PNG・HEIC）。本体が長辺 1568px に縮め、元の画像は保管庫に置き、メッセージに参照を残す。画面は SCR-020、API は API-156。

<details>
<summary>カラム定義（14列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7（API-156 で付ける） |
| message_id | TEXT | YES | — | FK chat_messages | 付いたメッセージ。アップロードしただけで、まだ送っていない間は NULL |
| position | INTEGER | NO | 0 | | 1 回の中での順番（0〜9） |
| vault_path | TEXT | YES | — | | 元の画像の保管庫のパス（既定は `写真`。レシートと分かれば `レシート`）。保管庫がつながっていないときは NULL で、`local_original_path` に置く |
| local_original_path | TEXT | YES | — | | 保管庫がつながっていないときの一時の置き場（本体の `/data/attachments/`）。つながったら保管庫に移して NULL に戻す |
| thumb_path | TEXT | NO | — | | 縮めた版（長辺 1568px・JPEG）のパス（本体の `/data/attachments/`）。LLM にはこれを渡す |
| mime | TEXT | NO | — | | 元の種類：`image/jpeg`・`image/png`・`image/heic` |
| size_bytes | INTEGER | NO | — | | 元の大きさ（20MB まで） |
| width | INTEGER | NO | — | | 縮めた版の幅 |
| height | INTEGER | NO | — | | 縮めた版の高さ |
| sha256 | TEXT | NO | — | | 元の画像の SHA-256 |
| tainted | INTEGER | NO | 1 | | 汚染の印（0/1）。添付は外から来たものなので常に 1（BR-06）。画像の中の文字を命令として扱わない |
| sent_to_llm | INTEGER | NO | 0 | | 縮めた版を LLM に渡したか（0/1）。渡したときの通信は `egress_events`（`purpose = 'llm'`）に残る（R-108） |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：`position BETWEEN 0 AND 9`。`vault_path IS NOT NULL OR local_original_path IS NOT NULL`。`tainted = 1`（CHECK）。同じ `message_id` に 10 行まで。`size_bytes <= 20971520`
- 索引：`(message_id, position)`・`(sha256)`。メッセージに付かないまま 24 時間たった行（`message_id IS NULL`）は、実体ごと消す
- 保持：縮めた版と行はメッセージと同じ（チャットは消さない）。元の画像は保管庫にあるので、ゴミ箱に入れたら 30 日で消える（縮めた版は残る）。想定：1 日に数枚〜数十枚

## このドキュメントで決まったこと
- v1.7：D-385〜390（`openai_chatgpt`：TBL-059。トークンは TBL-031 の列）
- v1.7：D-375（家計簿：TBL-061）、D-376（添付：TBL-063）、D-379・380（`decision`・`cap_decision`・ローカルの生成モデル：TBL-059）、D-373（元の画像は保管庫）
