# 08. DB設計：VM と確認の表（v0.6 から引き継ぐ表）
- プロジェクト：Agent-Team-Open ／ 版数：v1.7（2026-10-26） ／ 親：[08 DB設計](README.md)

> **3行で**
> 1. v0.6 の TBL-031〜040 を引き継ぐ。`boxes` は「持ち主に 1 台の VM の 1 回の起動（世代）。実体は 2 つのコンテナ（`box-browser`・`box-shell`）の組」になり、エージェントとタスクの列をなくして、画面の番（`screen_task_id`）を持つ。
> 2. 操作（`browser_actions`）と確認（`browser_checks`）に、オートレビューへの参照と理由を足した。ポリシーに `human_words`・`confirm_words`・メインのターンの上限を足した。
> 3. `browser_profiles`（TBL-036）は使わない。`push_subscriptions`（TBL-037）は作る（Web Push を最初の版に：D-207）。v1.6 で、判定を残す表に規則の版・判定の入力・誰が決めたかを足し、ポリシーに `network`・`review`・`llm` 欄を、規則の版（TBL-057）と毎日の先頭のハッシュ（TBL-058）の表を足した。v1.7 で、家の保管庫の索引（TBL-060）と Home Assistant の機器の写し（TBL-062）を足し、ポリシーに `vault`・`home`・`classify` の欄を足した。

---

### TBL-031：workspace（ワークスペース）
今の1行の表に列を足す。`owner_user_id`（D1 の利用者）は使わなくなり、`owner_login` で持ち主を表す。v0.6 の `max_boxes` は使わない（VM は 1 台）。

<details>
<summary>足す列（13列）</summary>

| カラム | 型 | NULL | デフォルト | 説明 |
|---|---|---|---|---|
| owner_login | TEXT | NO | — | Tailscale のログイン名。起動のとき `OWNER_LOGIN` と比べ、違えば止まる。`.env` に `OWNER_LOGIN_REPLACE=1` があるときだけ上書きして起動する（D-170） |
| max_tasks | INTEGER | NO | 3 | 裏のタスクの同時数。CHECK 1〜5（D-217） |
| snapshot_hour | INTEGER | NO | 4 | VM の控えを取る時刻（0〜23、`TZ`） |
| vm_op | TEXT | NO | `'none'` | `none`・`starting`・`stopping`・`snapshotting`・`restoring`・`rebuilding`・`clearing_browser`。`none` 以外は起こさない。遷移は [10 states](../10_diagrams/states.md#workspacevm_op) |
| vm_op_id | TEXT | YES | — | 復元・作り直し・消去のUUID。開始から結果のACK完了まで保持 |
| vm_op_payload | TEXT | YES | — | 不変のJSON（action・snapshotId・消去時boxId）。再送時に再構成しない |
| vm_op_ack_pending | INTEGER | NO | 0 | 0/1。結果・監査確定時1、ACK完了時0。1なら起動時はPOSTせずACK再送 |
| vm_op_started_at | TEXT | YES | — | `vm_op` を `none` 以外にした時刻。`none` のとき NULL。上限（`starting`・`stopping` 2 分、`snapshotting`・`restoring`・`rebuilding` 30 分）を超えたら打ち切る（D-294） |
| vm_home_state | TEXT | NO | `'ok'` | VM のホーム（2 つのボリューム）の状態：`ok`・`broken`（戻し・作り直しに失敗した。戻す・作り直すだけ受ける：D-294） |
| owner_passkeys | TEXT | NO | `'[]'` | JSON の配列。持ち主のパスキー（WebAuthn）。家の LAN の直結の入口でログインに使う（D-358）。v1.7：スマホの画面の QR から最初の 1 つを登録できる（D-372）。1 件は `{ credential_id, public_key, sign_count, transports, label, created_at }`。5 件まで。Tailscale・Headscale の入口では使わない（`Tailscale-User-Login` と `OWNER_LOGIN` を比べる） |
| owner_enroll | TEXT | YES | — | JSON `{ token_sha256, expires_at }`。`docker compose exec makase makase owner-enroll` が出す 1 回限りの URL の鍵のハッシュ（15 分で切れ、使うと NULL に戻る）。最初のパスキーはここから登録する。パスキーが 0 件のときだけ作れる（2 つ目からは、ログイン済みの画面から足す） |
| session_epoch | INTEGER | NO | 0 | セッション Cookie（HttpOnly・Secure・SameSite=Strict、12 時間）に署名して入れる番号。上げると、出したセッションがすべて切れる。セッションの行は持たない（表を増やさないため） |
| chatgpt_auth | TEXT | YES | — | v1.7：ChatGPT でサインインしたときのトークン一式を `ENCRYPTION_KEY` で暗号化した JSON：`{ access_token, refresh_token, expires_at, app_id（oaiapp_ で始まる ID）, account_label（アカウントの表示名）, connected_at }`。サインインしていなければ NULL。カレンダーの refresh token などと同じ暗号化の仕組みで、**新しい TBL は作らない**（D-386）。画面・API・ログ・監査には出さない（表示名だけ API-111・152 に出る）。VM には置かない。`invalid_grant`・401 で切れたら NULL にし、`llm.chatgpt_disconnected` を残す。取り直したリフレッシュのトークンは使うたびに入れ替わるので、同じトランザクションで書き戻す |

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
<summary>カラム定義（19列）</summary>

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
| verdict | TEXT | NO | — | | 判定：`allowed`・`reviewed`（オートレビューに回った。入れたときだけ）・`checked`（人の確認に回った） |
| policy_sha256 | TEXT | YES | — | | 判定に使った規則の版のハッシュ（`policy_versions.sha256`）。v1.6 より前の行は NULL（D-347） |
| verdict_input | TEXT | YES | — | | JSON。判定の入力（正規化した作動・確かめた中身・規則の版）。同じ入力と版でもう一度判定すると同じ結果になる（API-150。D-349）。秘密は `***`。v1.6 より前の行は NULL |
| decided_by | TEXT | YES | — | | 誰が決めたか：`kernel`（`allowed`）・`human`（人の確認の ○ / ×）・`llm_review`（オートレビューが通した）。決まるまでは NULL（D-351） |
| auto_review_id | TEXT | YES | — | FK auto_reviews | オートレビューに回ったとき（人に回り直しても残る） |
| check_id | TEXT | YES | — | FK browser_checks | 確認に回ったとき |
| outcome | TEXT | NO | `'pending'` | | 結果：`pending`・`executed`・`not_executed`・`unknown`・`failed` |
| screenshot_path | TEXT | YES | — | | 操作のあとのスクショ。7日で消して NULL に |
| created_at | TEXT | NO | NOW | | |
| finished_at | TEXT | YES | — | | |

</details>

- 制約：`check_id IS NOT NULL` ⇒ `verdict IN ('reviewed','checked')`、`verdict = 'checked'` ⇒ `check_id IS NOT NULL`、`verdict = 'reviewed'` ⇒ `auto_review_id IS NOT NULL`（オートレビューが止めて人に回ったときは `reviewed` のまま `check_id` も入る。D-274）
- 制約（v1.6）：`verdict_input IS NOT NULL` ⇒ `policy_sha256 IS NOT NULL`。`decided_by = 'llm_review'` ⇒ `auto_review_id IS NOT NULL`（オートレビューを入れていないときは `llm_review` の行はできない）
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
今の版つきの JSON（Kernel の `policy.ts` の形）を使う。上限は今の `budget` のキーのまま値を変え、`max_browser_actions` を足す。こわい操作の決まりは `browser` 欄に、ターミナルの決まりは `terminal` 欄に足す。Kernel の型（`policy.ts` の `budget` と、新しい `browser`）も合わせて足す。v1.6 で、外向きの決まりの `network` 欄、オートレビューの `review` 欄、役割ごとのモデルの `llm` 欄を足した。判定の規則の本文になるのは `browser`・`terminal`・`network`・`review.auto.enabled` で、今の値はこの表に置いたまま、保存のたびに同じトランザクションで [TBL-057](#tbl-057policy_versions判定の規則の版) に版を足す（D-347・369）。

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
  "approval_minutes": 30,
  "keep_screenshots": 3
 },
 "network": {
  "mode": "standard",
  "allow_hosts": [],
  "internal_hosts": {
   "browser": [{ "host": "10.20.0.0/24", "on_use": "confirm" }],
   "terminal": []
  }
 },
 "review": { "auto": { "enabled": false, "timeout_sec": 20 } },
 "vault": { "trash_days": 30, "versions_days": 30, "backup": { "enabled": false, "target": null } },
 "home": {
  "human_device_classes": ["lock", "climate", "water_heater", "valve", "alarm_control_panel", "cover"],
  "automation_confirm": "always"
 },
 "classify": { "min_confidence": 0.8 },
 "llm": {
  "roles": {
   "main": { "provider": "anthropic", "model": "claude-…" },
   "worker": { "provider": "anthropic", "model": "claude-…" },
   "computer": { "provider": "anthropic", "model": "claude-…" },
   "review": { "provider": "anthropic", "model": "claude-…" },
   "summary": { "provider": "anthropic", "model": "claude-…" },
   "classify": { "provider": "decision", "model": "…" }
  },
  "experimental_generic_computer": false
 }
}
```

</details>

- `max_steps`（タスクの歩み）と `max_browser_actions`（VM の操作）は別に数える。`per_turn_usd`・`max_turn_steps`・`max_turn_minutes` はメインの 1 ターン。`daily_usd` はすべての LLM の費用の合計の 1 日の上限、`daily_auto_usd` は `routine`・`scheduled`・`webhook` で始まったターンと、そこから生まれたタスク・オートレビュー・要約の合計の上限（D-322）。`human_words` と `confirm_words` は D-227、オートレビューの設定は `review.auto` に移した（FR-099。v1.6：D-351）。**既定は `enabled = false`**（切）で、判定は Kernel と人だけになる。`enabled = false` のときは、行き先がオートレビューのものも人に回す。入れたときの動きは今のまま（通すだけ。止めたら人へ。外に出す・支払う・消す・秘密は必ず人）。1タスクの時間の上限は、外側の 60 分の打ち切りより前に切れるよう `max_minutes = 55`（今の M-59 の決まり）
- 効くのは次のタスクから。タスクは始まるときのポリシーを固定して使う（今の `edge/inputs.ts` の形）
- `max_steps`・`max_minutes` の初期値は設計書の値で確定（D-175。今の既定の 40 歩・15 分とは違う）。1タスクの時間は確認待ち・交代待ちを除いて数える（`tasks.paused_ms`：D-174）。`terminal` 欄はターミナルの決まり（D-178）：`allow_hosts` は VM のコマンドの通信の許可リスト、`max_commands` は1タスクのコマンド数、`command_timeout_sec` は1コマンドの時間の上限。`keep_screenshots` は LLM との会話に残すスクショの枚数（D-161）
- `network`（D-340・343）：`mode` は `standard`（既定）・`closed`。`closed` では、本体と VM の外向きは `allow_hosts` に書いた先だけ（LLM の接続先も明示して書く）。書いていない先へは本体の外向きも egress も断り、`egress_events`（TBL-056）に拒否で残す。`closed` のとき、`terminal.allow_hosts` は `allow_hosts` の中にあるものだけが効く。`internal_hosts` は内部ホストの許可（CIDR かホスト名。既定は空）で、`browser` と `terminal` で別に書き、ホストごとに `on_use` を `confirm`（既定。人に確認）か `auto` にする。本体・box-manager・tailnet・ホスト自身・クラウドのメタデータ（169.254.169.254 など）は書いても断る（固定の除外）
- `llm`（D-352・353）：役割（`main`・`worker`・`computer`・`review`・`summary`。v1.7：`classify` を足す）ごとに接続先（`anthropic`・`openai`・`openai_compatible`。v1.7：`decision` を足す）とモデル名。モデルの能力と単価は [TBL-059](resident.md#tbl-059llm_modelsモデルの能力と単価)。能力が足りない割り当ては保存できない。v1.7：接続先に `openai_chatgpt` を足す（D-385）。`chatgpt_allow_auto`（既定 `false`、規則の版に入れない）が `false` の間は、ルーチン・webhook・予約した確認で始まったターン・タスク・オートレビュー・要約は `openai_chatgpt` を使わず、家の中のモデルか API キーの割り当てで動く（持ち主のチャットとそこから振り分けた仕事にだけ使う：D-389）。`experimental_generic_computer` が `true` のときだけ、`openai_compatible` の画面の操作（`generic`）を選べる（D-354）

- v1.7 の欄（D-373・378・379）。**`vault`、`home`、`classify` は規則の版に入れない**ものと入れるものが分かれる：`home.human_device_classes` と `home.automation_confirm` は行き先に効くので、`browser`・`terminal`・`network` と同じく規則の版に入れる（D-369 の延長）。`vault`・`classify.min_confidence` は入れない
 - `vault`：`trash_days`（ゴミ箱に置く日数。既定 30。短くはできない：下限 30）・`versions_days`（上書き前の版を残す日数。既定 30）・`backup`（保管庫の控え。`enabled`・`target`＝別のディスクか NAS。毎週。任意：NFR-095）。ゴミ箱を空にするのは必ず人で、この欄では自動にできない
 - `home`：`human_device_classes` は必ず人の確認に回す機器の区分（BR-15）。既定は鍵（`lock`）・空調と暖房（`climate`・`water_heater`）・ガスと水のバルブ（`valve`）・警報（`alarm_control_panel`）・シャッターやガレージ（`cover`）。**この 6 つは外せない**（足すことはできる。例：`switch`、`fan`）。コンセントなど個々の機器の「こわい」の印は `home_devices.human_flag`（TBL-062）。`automation_confirm`：自動化を作る・変える・消すときの確認。`always`（既定）・`non_human_only`（こわい機器に触らない自動化だけ通す。こわい機器に触るものは常に人）
 - `classify`：`min_confidence`（仕分けの自信の下限。既定 0.8、0.5〜0.99）。これより低ければ上の役割（LLM）に回す（D-379）。判断モデルは、間違えても困らない仕分けにだけ使い、Kernel の判定・こわい操作・機器の区分には使わない（BR-16）
 - `llm.roles.classify` の接続先は `decision`（Kev の `/v1/systemone` 互換、または OpenAI 互換で選択肢の確率を返すもの。TBL-059）。ローカルの生成モデル（4B 級）は `summary` と短い文章の役割だけ選べる。8GB のラズパイでは VM が起きている間は止める（本体がメモリを見て排他にする：D-380）

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
| result | TEXT | YES | — | | JSON。`done` のとき必須。秘密検査を通過したLLM応答のみcontent原本（思考・署名・tool_use ID含む）を保存。秘密入力を含む応答は本文を破棄し `secret_rejected` の理由コードだけ、会話を終了（FR-075）。画像は安全にマスク済みのパスだけ（再構成時に同じバイトを読む） |
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
<summary>カラム定義（20列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| task_id | TEXT | NO | — | FK tasks | |
| box_id | TEXT | NO | — | FK boxes | VM の世代 |
| screen_epoch | INTEGER | NO | — | | 確認を作ったときの `boxes.screen_epoch` を写す。○ の実行の直前に今の値と比べる（D-299） |
| action_id | TEXT | NO | — | UNIQUE, FK browser_actions | 実行する操作の ID |
| status | TEXT | NO | `'pending'` | | `pending`・`executing`・`executed`・`rejected`・`expired`・`unknown_outcome` |
| summary | TEXT | NO | — | | カードの要約（200字まで） |
| action | TEXT | NO | — | | JSON。操作の引数（秘密は `***`） |
| content | TEXT | NO | — | | JSON。タブ・フレーム・ページURL・操作の先・フォームの値の要約・`effectiveAction`（実効送信先絶対URL）。秘密を含むURLは保存せず交代（API-103） |
| content_hash | TEXT | NO | — | | `action`・`content`・`box_id` からの sha256 |
| tripwires | TEXT | NO | `'[]'` | | 当たった合図（`declared`・`T-1`〜`T-7`） |
| review_reason | TEXT | YES | — | | オートレビューが止めて人に回したときの理由（200字まで。オートレビューを入れたときだけ入る） |
| screenshot_path | TEXT | YES | — | | 押す場所の印つきのスクショ |
| policy_sha256 | TEXT | NO | — | | 判定に使った規則の版のハッシュ（`policy_versions.sha256`）。v1.5 の `policy_hash` を置き換える（D-347） |
| verdict_input | TEXT | YES | — | | JSON。判定の入力（`browser_actions.verdict_input` と同じ。D-349） |
| decided_by | TEXT | YES | — | | 決めた人：○ / × のとき `human`。期限切れなど人が決めなかったものは NULL |
| expires_at | TEXT | NO | — | | 作ってから 30分 |
| expire_reason | TEXT | YES | — | | `approval_timeout`・`page_changed`・`taken_over`・`box_restarted`・`task_cancelled`・`screen_lost`・`vm_replaced`（控えに戻した・作り直した：D-308） |
| decided_at | TEXT | YES | — | | |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：`status = 'expired'` ⇔ `expire_reason IS NOT NULL`。`pending` からの変更は条件つきの UPDATE（`WHERE status = 'pending'`）だけ
- 中身が変わったとき（`page_changed`）は新しい確認を作らず、Claude に決め直させる（D-159）。同じ操作に2つ目の確認はできない（`action_id` の UNIQUE）
- `foreign_keys=ON` とCHECKを維持する。同一トランザクションで操作を `verdict = allowed`・`check_id = auto_review_id = NULL` の仮行として挿入 → 確認/レビュー行を挿入 → `verdict` と対応する参照IDを同時更新する。仮行はcommit前の内部状態で、実行・通知・他接続への公開は禁止。途中失敗は全体rollback。レビューから人へは `reviewed` を保ち、確認行作成・操作とレビューの `check_id` 更新を一括commitする（IMP-007）
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

### TBL-057：policy_versions（判定の規則の版）
判定の規則（`workspace_policies` の `browser`・`terminal`・`network` 欄と `review.auto.enabled`、v1.7：`home.human_device_classes`・`home.automation_confirm`、T-1〜T-7 の行き先の表）を正規化した JSON にして、変えるたびに 1 行足す（D-347）。画面は SCR-028、API は API-149。`review.auto.enabled` は行き先に効くので入れる。`budget`・`llm`・`vault`・`classify`（と `review.auto.timeout_sec`）は入れない（D-369）。

<details>
<summary>カラム定義（11列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| version | INTEGER | NO | — | UNIQUE | 版の通し番号（1 から。画面の「v12」） |
| sha256 | TEXT | NO | — | UNIQUE | `body` の SHA-256（小文字の 16 進）。判定の記録の `policy_sha256` はこれを写す |
| body | TEXT | NO | — | | 正規化した JSON（キーを並べ替え、余白なし）。`browser`・`terminal`・`network`・`review.auto.enabled`・`home.human_device_classes`・`home.automation_confirm` と行き先の表 |
| tests | TEXT | NO | `'[]'` | | JSON の配列。試験の例：`{ "input": 作動の入力, "expect": "allow"｜"human"｜"deny" }`（D-348） |
| parent_sha256 | TEXT | YES | — | | 変える前の版の `sha256`（最初の版は NULL）。差分の元 |
| changed_by | TEXT | NO | — | | `owner`（画面）・`import`（`policy.json` の取り込み）・`system`（最初の版・移行） |
| reason | TEXT | NO | — | | 変えた理由（200 字まで） |
| tests_passed | INTEGER | NO | — | | 保存のとき通った試験の数（全部通らないと保存できないので、`tests` の数と同じ） |
| replay_summary | TEXT | YES | — | | JSON。保存のときの試し当ての結果（過去 30 日。行き先が変わる件数と例） |
| created_at | TEXT | NO | NOW | | |

</details>

- 制約：追記だけ（UPDATE・DELETE をトリガーで断る）。`sha256` が同じ版を二度作らない（同じ中身で保存したら新しい版を作らず、今の版のまま）。`tests_passed = json_array_length(tests)`
- 保存は 1 つのトランザクションで、`policy_versions` の行 → `workspace_policies` の今の欄 → 監査ログ `policy.changed` を書く。今の欄は今の版の `body` と同じ中身（`workspace_policies` は「今の版」の写しで、判定の元は `policy_versions`）
- 判定のたびに、使った版の `sha256` を `browser_actions.policy_sha256`（など）に残す。再実行（API-150）はこの行の `body` で判定し直す（D-349）
- 保持：無期限。想定：1 日に数行以下

### TBL-058：audit_anchors（毎日の監査ログの先頭のハッシュ）
毎日 0 時（`TZ`）に、その時点の監査ログの末尾のハッシュを 1 行残す（D-350）。画面（SCR-010）に出し、書き出せる。外に控えておけば、あとから鎖を確かめられる。

<details>
<summary>カラム定義（7列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| day | TEXT | NO | — | PK | 日付（`YYYY-MM-DD`、`TZ`）。その日の 0 時の時点 |
| last_audit_id | TEXT | NO | — | | その時点で最後の `audit_logs.id` |
| row_hash | TEXT | NO | — | | その行の `audit_logs.row_hash`（これが「先頭のハッシュ」） |
| row_count | INTEGER | NO | — | | その行までの `audit_logs` の行数 |
| created_at | TEXT | NO | NOW | | |
| exported_at | TEXT | YES | — | | 持ち主が書き出した時刻（API-151） |
| verified_at | TEXT | YES | — | | この行までの鎖を最後に検査して問題がなかった時刻 |

</details>

- 制約：追記だけ（`exported_at`・`verified_at` の更新だけ許す）。0 時に本体が止まっていたら、起動のときに抜けた日を足す（その日の 0 時以後の最初の行までを、遅れて控えたと印を付けずに足す。控えた時刻は `created_at`）
- ホストの root を取られた場合は「外に控えた先頭のハッシュより後」しか守れない（R-103）。外に控える手順を運用に書く
- 保持：無期限。想定：1 日に 1 行

### TBL-060：vault_files（保管庫の索引）
家の保管庫（`makase-vault`。USB の SSD、または家の NAS を SMB でつないだもの：D-373）にあるファイルの索引。実体は保管庫に置き、ここには探すための情報だけを持つ。画面は SCR-030、API は API-153。決まったフォルダは `写真`・`書類`・`レシート`・`書き出し`・`ゴミ箱`。VM には保管庫をつながない（ADR-061 のまま）。

<details>
<summary>カラム定義（22列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| path | TEXT | NO | — | UNIQUE | 保管庫の中の今のパス（例：`写真/2026/10/IMG_0001.jpg`）。`..` を含まない相対パス。ゴミ箱に入れたら `ゴミ箱/…` に変わる |
| folder | TEXT | NO | — | | 一番上のフォルダ：`photos`（写真）・`documents`（書類）・`receipts`（レシート）・`exports`（書き出し）・`trash`（ゴミ箱） |
| name | TEXT | NO | — | | ファイル名 |
| mime | TEXT | NO | — | | 種類（`image/jpeg` など） |
| size_bytes | INTEGER | NO | — | | 大きさ |
| sha256 | TEXT | NO | — | | 中身の SHA-256。同じ値の行は重複の候補（D-374） |
| taken_at | TEXT | YES | — | | 撮影日（EXIF）。なければ NULL（並べ替えは `created_at`） |
| place | TEXT | YES | — | | 場所（EXIF の緯度経度を丸めた `35.68,139.76` と、分かれば地名）。画面で「場所で見る」に使う。顔の情報は持たない（D-374） |
| tags | TEXT | NO | `'[]'` | | JSON の配列。中身での分類（「料理」「子ども」「書類の写真」）。画像を読める役割が付けたもの。付けた件数と費用は先に見積もって持ち主に見せる（D-374） |
| tag_source | TEXT | YES | — | | `owner`・`llm`・`classify`。タグを付けた元 |
| thumb_path | TEXT | YES | — | | 縮小版のパス（本体の `/data/thumbs/` の中。保管庫には置かない）。長辺 512px |
| duplicate_of | TEXT | YES | — | FK vault_files | 同じ `sha256` の最初の行（重複の印）。消すかどうかは人が決める |
| trashed_at | TEXT | YES | — | | ゴミ箱に入れた時刻。ゴミ箱の外では NULL |
| trashed_from | TEXT | YES | — | | ゴミ箱に入れる前のパス（戻すのに使う） |
| purge_at | TEXT | YES | — | | 自動で消える時刻（`trashed_at` の 30 日後）。ゴミ箱の外では NULL |
| versions | TEXT | NO | `'[]'` | | JSON の配列。上書きの前の版：`{ "path": ".versions/…", "sha256", "saved_at", "purge_at" }`。30 日で消す（D-373） |
| created_by | TEXT | NO | — | | `owner`（画面・チャットの添付）・`main`・`task`・`import`（保管庫に直接置かれたものを索引したとき） |
| source_attachment_id | TEXT | YES | — | FK chat_attachments | チャットの添付から来たとき |
| tainted | INTEGER | NO | 0 | | 外から来たものか（0/1。チャットの添付は 1：BR-06）。読むときに汚染の印が付く |
| indexed_at | TEXT | NO | NOW | | 索引した時刻 |
| updated_at | TEXT | NO | NOW | | |

</details>

- 制約：`folder IN ('photos','documents','receipts','exports','trash')`。`trashed_at IS NULL` ⇔ `purge_at IS NULL` ⇔ `folder <> 'trash'`。`path` は保管庫の根の中（`..`・絶対パス・シンボリックリンクを断る：Kernel が判定）。`purge_at = trashed_at + 30 日`（`workspace_policies.vault.trash_days`）
- 索引：`(folder, taken_at)`・`(folder, created_at)`・`(sha256)`・`(purge_at)`（自動で消す掃除用）・`(trashed_at)`
- 道具との関係（D-373）：`vault_list`・`vault_read` は索引を引く。`vault_write` は上書きのとき前の版を `.versions` に移して `versions` に足す。`vault_move` は `path` を直す。`vault_trash` は `ゴミ箱` へ移して `trashed_at` などを入れる。**消す＝ゴミ箱へ移す**。ゴミ箱を空にする・30 日より前に消すのは必ず人（API-153。道具にはない）。どれも Kernel が判定し、`audit_logs` に `vault.trashed`・`vault.restored`・`vault.emptied`・`vault.overwritten` を残す
- 索引と実体がずれたとき（保管庫の外から直接ファイルを足した・消した）：起動と毎日の掃除で保管庫を走査して直す。保管庫がつながっていないときは索引だけ見せ、書き込みは断る（`VAULT_NOT_MOUNTED`）
- 保持：索引の行は無期限。ゴミ箱の行と実体は 30 日（`purge_at` を過ぎたら実体を消し、行も消す）。前の版は 30 日。想定：数万行（写真 5 万枚まで）

### TBL-062：home_devices（HA の機器の写し）
Home Assistant（HA）の機器（entity）の写し（D-377）。機器の一覧と「こわい」の印、最後の状態を持つ。本体のコネクタが HA の API を長期トークンで呼んで同期する（トークンは本体に暗号化して置き、VM には置かない）。HA は内部ホストとして自動で登録される（`network.internal_hosts`）。画面は SCR-032、API は API-155。

<details>
<summary>カラム定義（17列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | TEXT | NO | — | PK | UUIDv7 |
| entity_id | TEXT | NO | — | UNIQUE | HA の `entity_id`（例：`lock.front_door`、`light.living`、`automation.morning`） |
| domain | TEXT | NO | — | | HA の domain（`lock`・`light`・`switch`・`climate`・`automation` など） |
| device_class | TEXT | NO | — | | 機器の区分（BR-15）：`human`（`lock`・`climate`・`water_heater`・`valve`・`alarm_control_panel`・`cover`・`workspace_policies.home.human_device_classes` に足した区分）・`normal`（それ以外）。**Kernel の規則で決める**（規則の版に入る：D-369）。判断モデルや LLM では決めない（BR-16） |
| name | TEXT | NO | — | | 表示名（HA の `friendly_name`） |
| area | TEXT | YES | — | | 部屋（HA の area） |
| human_flag | INTEGER | NO | 0 | | 持ち主が「こわい」に印を付けたか（0/1）。たとえば家電のコンセント（`switch`）。1 なら `device_class` が `normal` でも必ず人の確認（D-378） |
| human_flag_by | TEXT | YES | — | | `owner`。印を付けた・外した記録の元（外した時刻は `audit_logs` の `home.flag_changed`） |
| last_state | TEXT | YES | — | | 最後に読んだ状態（`on`・`off`・`locked`・`22.5` など） |
| last_attributes | TEXT | YES | — | | JSON。最後の属性（明るさ・設定温度など。8KB まで。長いものは切る） |
| last_changed_at | TEXT | YES | — | | 機器の状態が変わった時刻（HA の値） |
| synced_at | TEXT | NO | NOW | | 本体が最後に HA から写した時刻 |
| automation_targets | TEXT | YES | — | | `domain = 'automation'` のとき、JSON の配列：その自動化が触る機器の `entity_id`。こわい機器に触る自動化を見分けるのに使う |
| touches_human | INTEGER | NO | 0 | | `domain = 'automation'` のとき、`automation_targets` に `human` か印つきの機器があるか（0/1）。Kernel の規則で数える |
| automation_enabled | INTEGER | YES | — | | `domain = 'automation'` のとき、動いているか（0/1） |
| created_by | TEXT | YES | — | | 自動化のとき：`owner`・`main`（エージェントが作った）・`ha`（HA の側にもとからあった） |
| removed_at | TEXT | YES | — | | HA から消えた時刻（行は残す。印の履歴を失わないため） |

</details>

- 制約：`human_flag IN (0,1)`。`device_class IN ('human','normal')`。`domain <> 'automation'` ⇒ `automation_targets IS NULL`。`device_class = 'human'` の行は `human_flag` を外せない（外す操作は 422 `HOME_CLASS_FIXED`）
- 索引：`(domain)`・`(device_class, human_flag)`・`(area)`・`(removed_at)`
- 動かす・自動化を作る/変える/消す（HA の道具）の判定（D-378）：`device_class = 'human'` か `human_flag = 1` の機器を動かす、またはそれらに触る自動化を作る・変えるのは必ず人。それ以外の機器を動かすのは通す。自動化を作る・変える・消すのは、既定で人の確認（`automation_confirm = 'non_human_only'` ならこわくないものだけ通す）。どれも `audit_logs` に `home.called`・`home.automation_changed` を残す
- 同期：本体が HA の WebSocket（なければ REST）で状態の変化を受けて、`last_state` を更新する。つながらなくなったら最後の値を残して、画面に「HA につながっていません」と出す。HA から消えた機器は `removed_at` を入れる
- 保持：無期限（持ち主が HA を外すまで）。`last_state` は上書き。状態の履歴は持たない（HA 側にある）。想定：数十〜数百行

## このドキュメントで決まったこと
- v1.6：D-347・369（規則の版：TBL-057）、D-349（判定の入力を残す）、D-350（鎖と先頭のハッシュ：TBL-058）、D-351（`review.auto` は既定で切）、D-340・343（`network` 欄）、D-352（`llm` 欄）（[00 決定事項ログ](../00_overview.md#決定事項ログ)）
- v1.7：D-373（保管庫：TBL-060）、D-377・378（HA の機器の写し・機器の区分：TBL-062）、D-379（`classify` の欄）、D-380（ローカルの生成モデルの排他）、D-372（QR からのパスキー登録）
