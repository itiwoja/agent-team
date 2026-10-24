# 08. DB設計：VM と確認の表（v0.6 から引き継ぐ表）
- プロジェクト：Agent-Team-Open ／ 版数：v1.4（2026-10-24） ／ 親：[08 DB設計](README.md)

> **3行で**
> 1. v0.6 の TBL-031〜040 を引き継ぐ。`boxes` は「持ち主に 1 台の VM の 1 回の起動（世代）。実体は 2 つのコンテナ（`box-browser`・`box-shell`）の組」になり、エージェントとタスクの列をなくして、画面の番（`screen_task_id`）を持つ。
> 2. 操作（`browser_actions`）と確認（`browser_checks`）に、オートレビューへの参照と理由を足した。ポリシーに `human_words`・`confirm_words`・メインのターンの上限を足した。
> 3. `browser_profiles`（TBL-036）は使わない。`push_subscriptions`（TBL-037）は作る（Web Push を最初の版に：D-207）。

---

### TBL-031：workspace（ワークスペース）
今の1行の表に列を足す。`owner_user_id`（D1 の利用者）は使わなくなり、`owner_login` で持ち主を表す。v0.6 の `max_boxes` は使わない（VM は 1 台）。

<details>
<summary>足す列（6列）</summary>

| カラム | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| owner_login | TEXT | NO | — | Tailscale のログイン名。起動のとき `OWNER_LOGIN` と比べ、違えば止まる。`.env` に `OWNER_LOGIN_REPLACE=1` があるときだけ上書きして起動する（D-170） |
| max_tasks | INTEGER | NO | 3 | 裏のタスクの同時数。CHECK 1〜5（D-217） |
| snapshot_hour | INTEGER | NO | 4 | VM の控えを取る時刻（0〜23、`TZ`） |
| vm_op | TEXT | NO | `'none'` | VM の操作：`none`・`starting`・`stopping`・`snapshotting`・`restoring`・`rebuilding`（D-251）。`none` 以外の間は起こさない。遷移は [10 states](../10_diagrams/states.md#workspacevm_op) |
| vm_op_started_at | TEXT | YES | — | `vm_op` を `none` 以外にした時刻。`none` のとき NULL。上限（`starting`・`stopping` 2 分、`snapshotting`・`restoring`・`rebuilding` 30 分）を超えたら打ち切る（D-294） |
| vm_home_state | TEXT | NO | `'ok'` | VM のホーム（2 つのボリューム）の状態：`ok`・`broken`（戻し・作り直しに失敗した。戻す・作り直すだけ受ける：D-294） |

</details>

### TBL-032：boxes（VM の世代）
2 つのコンテナ（`box-browser`・`box-shell`）の組の 1 世代。持ち主に 1 台。2 つは一緒に起こし、一緒に止める（ADR-068）。主なカラム：`id`, `status`, `control`, `screen_task_id`

<details>
<summary>カラム定義（15列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7。VM の世代 |
| status | TEXT | NO | `'starting'` | | `starting`・`running`・`stopping`・`stopped`・`failed` |
| control | TEXT | NO | `'agent'` | | `agent`・`handing_over`・`human` |
| control_epoch | INTEGER | NO | 0 | | `control` を変えるたびに1増やす。box-agent は古い番号の画面の操作を断る |
| screen_epoch | INTEGER | NO | 0 | | 画面の番を取るたびに1増やす（取るときの 1 か所だけ。D-258・D-299）。比べるのは本体だけで、box-agent には渡さない。コマンドはどちらの番号も確かめない（D-296） |
| screen_task_id | TEXT | YES | — | FK tasks | 画面の番を持つタスク（D-205） |
| screen_since | TEXT | YES | — | | 番を取った時刻 |
| browser_container_id | TEXT | YES | — | | `box-browser` のコンテナの ID（box-manager が起こしたとき） |
| shell_container_id | TEXT | YES | — | | `box-shell` のコンテナの ID。どちらかが落ちたら世代ごと `failed` |
| stop_reason | TEXT | YES | — | | `idle`・`owner`・`restore`・`rebuild`・`snapshot`・`disk_quota`・`disk_low`（ホストの空きが 3GB を切った：D-300）・`start_timeout`・`crashed`・`host_restart` |
| started_at | TEXT | NO | NOW | | |
| last_activity_at | TEXT | NO | NOW | | 最後の操作・コマンド（人・エージェント） |
| stopped_at | TEXT | YES | — | | |
| home_bytes | INTEGER | YES | — | | box-manager が最後に測った 2 つのボリューム（ブラウザのプロフィールとホーム）の合計の大きさ（動いている間は毎分 API-109 から写す：D-309） |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：`status IN ('stopped','failed')` ⇔ `stopped_at IS NOT NULL`。止まっていない世代は 1 つだけ（部分 UNIQUE：`CREATE UNIQUE INDEX ... ON boxes((1)) WHERE status NOT IN ('stopped','failed')`）
- 画面の番：取るのは `UPDATE boxes SET screen_task_id = ?, screen_since = NOW, screen_epoch = screen_epoch + 1 WHERE id = ? AND screen_task_id IS NULL`。0 行なら待つ
- 想定：1日に数行〜数十行（眠って起きるたび）

### TBL-033：browser_actions（操作の記録）
エージェントの1操作。主なカラム：`box_id`, `seq`, `kind`, `verdict`, `outcome`

<details>
<summary>カラム定義（16列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7。box-agent に渡す操作 ID も兼ねる |
| box_id | TEXT | NO | — | FK boxes | |
| task_id | TEXT | NO | — | FK tasks | 画面の番を持っていたタスク |
| seq | INTEGER | NO | — | | VM の中の通し番号。UNIQUE(box_id, seq) |
| kind | TEXT | NO | — | | computer use の操作名（`left_click`・`type`・`key`・`scroll` など）か `open_url` |
| args | TEXT | NO | `'{}'` | | JSON。座標・キー・文字（秘密の欄なら `***`） |
| page_url | TEXT | YES | — | | 操作のときのページ（クエリは外す） |
| target | TEXT | YES | — | | JSON。タブ・フレーム・要素の種類・`type`・`autocomplete`・見えている名前・枠。分からなければ NULL |
| tripwires | TEXT | NO | `'[]'` | | JSON の配列。当たった合図（`declared`・`T-1`〜`T-7`） |
| verdict | TEXT | NO | — | | 判定：`allowed`・`reviewed`（オートレビューに回った）・`checked`（人の確認に回った） |
| auto_review_id | TEXT | YES | — | FK auto_reviews | オートレビューに回ったとき（人に回り直しても残る） |
| check_id | TEXT | YES | — | FK browser_checks | 確認に回ったとき |
| outcome | TEXT | NO | `'pending'` | | 結果：`pending`・`executed`・`not_executed`・`unknown`・`failed` |
| screenshot_path | TEXT | YES | — | | 操作のあとのスクショ。7日で消して NULL に |
| created_at | TEXT | NO | NOW | | |
| finished_at | TEXT | YES | — | | |

</details>

- 制約：`check_id IS NOT NULL` ⇒ `verdict IN ('reviewed','checked')`、`verdict = 'checked'` ⇒ `check_id IS NOT NULL`、`verdict = 'reviewed'` ⇒ `auto_review_id IS NOT NULL`（オートレビューが止めて人に回ったときは `reviewed` のまま `check_id` も入る。D-274）
- 想定：1タスクで最大 300 行

### TBL-034：takeovers（交代）
<details>
<summary>カラム定義（9列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | |
| box_id | TEXT | NO | — | FK boxes | |
| task_id | TEXT | YES | — | FK tasks | 画面の番を持っていたタスク。持たないときに代わったら NULL |
| status | TEXT | NO | — | | `requested`・`active`・`ended`・`expired` |
| reason | TEXT | YES | — | | エージェントが頼んだときの理由（200字まで） |
| requested_at | TEXT | YES | — | | 頼まれた時刻（持ち主が自分から代わったときは NULL） |
| started_at | TEXT | YES | — | | |
| ended_at | TEXT | YES | — | | |
| end_screenshot_path | TEXT | YES | — | | 返したときのスクショ |

</details>

- 制約：動いている交代（`requested`・`active`）は VM の世代ごとに1つ
- `requested` は 30 分、`active` は操作なし 15 分で `expired`（D-167）。VM は止めない（D-237）

### TBL-035：workspace_policies（ポリシー）
今の版つきの JSON（Kernel の `policy.ts` の形）を使う。上限は今の `budget` のキーのまま値を変え、`max_browser_actions` を足す。こわい操作の決まりは `browser` 欄に、ターミナルの決まりは `terminal` 欄に足す。Kernel の型（`policy.ts` の `budget` と、新しい `browser`）も合わせて足す。

<details>
<summary>JSON の欄（変えるところ）</summary>

```json
{
 "budget": { "per_task_usd": 3, "daily_usd": 10, "daily_auto_usd": 7, "max_steps": 200, "max_minutes": 55, "max_browser_actions": 300,
  "per_turn_usd": 1, "max_turn_steps": 40, "max_turn_minutes": 10 },
 "terminal": { "allow_hosts": ["github.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"], "max_commands": 200, "command_timeout_sec": 120 },
 "browser": {
  "confirm_domains": [],
  "skip_unresolved_domains": [],
  "human_words": ["購入", "注文", "支払", "決済", "送信", "投稿", "削除", "退会", "解約", "申し込", "公開", "確定", "保存", "Buy", "Purchase", "Pay", "Checkout", "Place order", "Send", "Post", "Delete", "Publish", "Submit", "Confirm", "Save"],
  "confirm_words": ["次へ", "続ける", "検索", "Next", "Continue", "Search"],
  "auto_review": { "enabled": true, "timeout_sec": 20 },
  "approval_minutes": 30,
  "keep_screenshots": 3
 }
}
```

</details>

- `max_steps`（タスクの歩み）と `max_browser_actions`（VM の操作）は別に数える。`per_turn_usd`・`max_turn_steps`・`max_turn_minutes` はメインの 1 ターン。`daily_usd` はすべての LLM の費用の合計の 1 日の上限、`daily_auto_usd` は `routine`・`scheduled`・`webhook` で始まったターンと、そこから生まれたタスク・オートレビュー・要約の合計の上限（D-322）。`human_words` と `confirm_words` は D-227、`auto_review` は FR-099（`enabled = false` なら行き先がオートレビューのものも人に回す）。1タスクの時間の上限は、外側の 60 分の打ち切りより前に切れるよう `max_minutes = 55`（今の M-59 の決まり）
- 効くのは次のタスクから。タスクは始まるときのポリシーを固定して使う（今の `edge/inputs.ts` の形）
- `max_steps`・`max_minutes` の初期値は設計書の値で確定（D-175。今の既定の 40 歩・15 分とは違う）。1タスクの時間は確認待ち・交代待ちを除いて数える（`tasks.paused_ms`：D-174）。`terminal` 欄はターミナルの決まり（D-178）：`allow_hosts` は VM のコマンドの通信の許可リスト、`max_commands` は1タスクのコマンド数、`command_timeout_sec` は1コマンドの時間の上限。`keep_screenshots` は Claude との会話に残すスクショの枚数（D-161）

### TBL-036：browser_profiles（プロフィール）
使わない（v1.0）。Chrome のプロフィールは専用のボリューム `makase-browser-profile` に 1 つ（ADR-060・ADR-068）。

### TBL-037：push_subscriptions（通知の購読）
Web Push の宛先。端末ごとに 1 行（FR-017・ADR-067）。

<details>
<summary>カラム定義（8列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| endpoint | TEXT | NO | — | UNIQUE | Push のサービスの URL |
| p256dh | TEXT | NO | — | | 端末の公開鍵 |
| auth | TEXT | NO | — | | 認証の秘密 |
| label | TEXT | YES | — | | 「iPhone の Safari」など（User-Agent から作る） |
| last_success_at | TEXT | YES | — | | |
| fail_count | INTEGER | NO | 0 | | 続けて失敗した回数。404・410 なら行を消す |
| created_at | TEXT | NO | NOW | | |

</details>

### TBL-038：task_steps（歩みの記録）
<details>
<summary>カラム定義（9列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| owner_kind | TEXT | NO | — | PK | `task`・`turn`（メインのターン）。v0.6 の `ask` は使わない |
| owner_id | TEXT | NO | — | PK | タスクかターンの ID |
| step_key | TEXT | NO | — | PK | 歩みの名前（`llm:<n>`・`tool:<callId>`・`box:<actionId>`・`review:<actionId>`・`input:<n>`（ターンに足した文。`result` に描いた文をそのまま：D-277）・`memory:<n>`（記憶の更新）。`<n>` はその持ち主の中の歩みの番号。要約はターンの外の仕事なので書かない：D-323） |
| status | TEXT | NO | — | | `started`・`done`（`done` の結果に `aborted`（交代で中止）がある） |
| result | TEXT | YES | — | | JSON。`done` のとき必須。LLM の歩みは返った assistant の content をそのまま（思考のブロック・署名・`tool_use` の ID を含む。D-256）。画像は入れず、スクショのパスだけ（組み直すときに同じバイトになるよう、パスから元の画像を読む） |
| repeatable | INTEGER | NO | 1 | | 0 なら、`started` のまま残っても繰り返さない（VM の操作・書き込み） |
| reserved_micro_usd | INTEGER | NO | 0 | | LLM の歩みの見積もりの費用。`started` の間は日次の残りから引いて数える |
| started_at | TEXT | NO | NOW | | |
| finished_at | TEXT | YES | — | | |

</details>

- 日次の上限の確かめは「使った額（`usage_records`）＋ `started` の歩みの予約の合計」で行い、予約は `started` の行を入れるのと同じトランザクションで入れる
- 終わったタスクの歩みは 7日で消す。ターンの歩みは、要約に取り込まれて（新しい `context_snapshots` ができて）から 7 日で消す（D-262）（監査に要るものは `audit_logs` と `browser_actions` にある）
- 交代で中止した `llm:<n>` は `done`（結果 `aborted`）で閉じ、予約を精算する（D-163）。`started` を残さない

### TBL-039：browser_checks（ブラウザの確認）
こわい操作の ○ / ×。主なカラム：`box_id`, `status`, `content_hash`

<details>
<summary>カラム定義（18列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| task_id | TEXT | NO | — | FK tasks | |
| box_id | TEXT | NO | — | FK boxes | VM の世代 |
| screen_epoch | INTEGER | NO | — | | 確認を作ったときの `boxes.screen_epoch` を写す。○ の実行の直前に今の値と比べる（D-299） |
| action_id | TEXT | NO | — | UNIQUE | 実行する操作の ID（`browser_actions.id`） |
| status | TEXT | NO | `'pending'` | | `pending`・`executing`・`executed`・`rejected`・`expired`・`unknown_outcome` |
| summary | TEXT | NO | — | | カードの要約（200字まで） |
| action | TEXT | NO | — | | JSON。操作の引数（秘密は `***`） |
| content | TEXT | NO | — | | JSON。タブ・フレーム・ページの URL・操作の先・フォームの値の要約（秘密の欄はハッシュ） |
| content_hash | TEXT | NO | — | | `action`・`content`・`box_id` からの sha256 |
| tripwires | TEXT | NO | `'[]'` | | 当たった合図（`declared`・`T-1`〜`T-7`） |
| review_reason | TEXT | YES | — | | オートレビューが止めて人に回したときの理由（200字まで） |
| screenshot_path | TEXT | YES | — | | 押す場所の印つきのスクショ |
| policy_hash | TEXT | NO | — | | 判定に使ったポリシー |
| expires_at | TEXT | NO | — | | 作ってから 30分 |
| expire_reason | TEXT | YES | — | | `approval_timeout`・`page_changed`・`taken_over`・`box_restarted`・`task_cancelled`・`screen_lost`・`vm_replaced`（控えに戻した・作り直した：D-308） |
| decided_at | TEXT | YES | — | | |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：`status = 'expired'` ⇔ `expire_reason IS NOT NULL`。`pending` からの変更は条件つきの UPDATE（`WHERE status = 'pending'`）だけ
- 中身が変わったとき（`page_changed`）は新しい確認を作らず、Claude に決め直させる（D-159）。同じ操作に2つ目の確認はできない（`action_id` の UNIQUE）
- `browser_actions.check_id` と `browser_checks.action_id` は相互参照なので、`foreign_keys=ON` では操作の行（`check_id` NULL）→ 確認の行 → 操作の行の `check_id` を UPDATE の順で入れる
- 監査ログに `browser.checked`（作った・決めた・結果）を残す

### TBL-040：sandbox_commands（ターミナルの記録）
VM の中のコマンド1つ（実行は `box-shell`）。今の表の `session_id`（`sandbox_sessions`）を `box_id`（`boxes`）に変える。`sandbox_sessions` は使わない。主なカラム：`box_id`, `task_id`, `tool`, `status`, `output`

<details>
<summary>カラム定義（12列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7。API-117 の `actionId` も兼ねる |
| box_id | TEXT | NO | — | FK boxes | VM の世代（今の `session_id` を変える） |
| task_id | TEXT | NO | — | FK tasks | |
| tool | TEXT | NO | — | | `run_command`・`list_files`・`read_file`・`search`・`write_file`・`delete_file` |
| args | TEXT | NO | — | | JSON のオブジェクト（`cwd`・`command`・`timeoutSec` など） |
| status | TEXT | NO | `'queued'` | | `queued`・`running`・`done`・`expired` |
| ok | INTEGER | YES | — | | 0 / 1。`done` のとき必須 |
| output | TEXT | YES | — | | コマンドの出力。64KB まで（超えた分は切る）。外の内容として汚染扱い（BR-06） |
| exit_code | INTEGER | YES | — | | |
| created_at | TEXT | NO | NOW | | |
| started_at | TEXT | YES | — | | |
| finished_at | TEXT | YES | — | | |

</details>

- 制約：`status = 'done'` ⇔ `ok IS NOT NULL`。`length(output) <= 65536`（今の 200000 から変える）。索引は `(box_id, created_at)`
- `running` のまま VM が落ちた・時間を超えたコマンドは `expired`。再開のときはやり直さず、Claude に「前のコマンドが実行されたか分からない」と伝える（FR-084）
- 想定：1タスクで最大 200 行（`terminal.max_commands`：NFR-080）

