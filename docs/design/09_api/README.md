# 09. API設計
- プロジェクト：Agent-Team-Open ／ 版数：v1.4（2026-10-24） ／ インプット：[04_functional_spec](../04_functional_spec/README.md)、[06_ux_design](../06_ux_design.md)、`apps/worker/src/routes`

> **3行で**
> 1. 画面向けの API は `/api/v1`（:8080・tailnet だけ）。依頼の API（API-072〜077・084）はやめ、チャット・タスク・きっかけ・記憶・VM・通知の API を足した。詳細は [resident.md](resident.md)（新しい API）と [vm.md](vm.md)（引き継ぐ API）。
> 2. webhook の口は別の待ち受け（:8081）に `POST /hooks/:hookId`（API-129）だけ。Funnel で 8443 番だけを公開してそこに流し、身元ではなく署名で確かめる。画面と API の 443 番は公開しない（D-241）。
> 3. 本体と box-manager の間は内部 API（API-101〜109・113・117・118・143・144）。VM は 1 台（`box-browser`・`box-shell` の 2 つのコンテナの組）で、パスの `:boxId` は VM の世代。

## 🧭 判断してほしいこと
なし

## 全体図
```mermaid
flowchart LR
 WEB["apps/web"] -->|"/api/v1/*<br/>Tailscale-User-Login<br/>X-Makase-Request"| TS["tailscale"]
 GH(["GitHub"]) -->|"/hooks/:hookId<br/>X-Hub-Signature-256"| TS
 TS -->|":8080"| CORE["本体"]
 TS -->|"8443 → :8081 Funnel"| CORE
 CORE -->|"/internal/v1/*<br/>Bearer BOX_MANAGER_TOKEN"| BM["box-manager"]
 BM -->|"世代ごとのトークン"| BOX["box-browser（box-agent・VNC）<br/>box-shell（shell-agent）"]
```
見てほしいところ：画面からは 443 → :8080（tailnet だけ）、webhook は 8443 → :8081（Funnel）にだけ届く。VM の画面も本体が box-manager に中継する。

## 要点
- 認証は Tailscale の身元。GET 以外は `Origin` と `X-Makase-Request: 1` が要る（[共通仕様](#共通仕様)）
- 送る：`POST /messages`（API-119）。画面が ID を作り、`Idempotency-Key` に入れる。読む：`GET /messages`（API-120）
- タスク：一覧・中身・言い直し・取り消し（API-122〜124・016）
- きっかけ：ルーチン（API-125・126・136・142）・予約（API-127・139）・受け口（API-128・140）
- 記憶（API-130・131・141）・VM（API-088〜091・099・133〜135・138）・通知（API-031・032・137）
- SSE（API-085）は合図だけ。中身は REST で取りに行く

---

## 詳細

### 共通仕様
- ベース URL：`https://makase.<tailnet>.ts.net/api/v1`（`/api/health` だけ版なし）。webhook は `https://makase.<tailnet>.ts.net:8443/hooks/:hookId`（Funnel・8443 番 → :8081）
- 認証：FR-073。ヘッダー `Tailscale-User-Login` は `tailscale serve` が付ける。本体の画面向けの口は front ネットワークだけで待ち受ける
- CSRF：GET 以外は `Origin` が自分の URL、かつ `X-Makase-Request: 1`。GET で状態を変えるのは API-094（`state` を作る）と API-095（つなぐときの戻り先）の2つだけで、`state` と Cookie で守る（FR-081）
- 冪等：POST の作成系は `Idempotency-Key` を受ける（今のまま）。API-119 では `Idempotency-Key` がメッセージの ID（UUIDv7）になる
- 形式：JSON、キーは camelCase、時刻は ISO 8601
- ページング：新しい一覧（API-023・122・127）は `?cursor=` と `?limit=`（既定 20、最大 100）。応答に `nextCursor`。チャット（API-120）は `?before=<messageId>` と `?limit=`（既定 50）。今の一覧（API-041）は今の形（`limit` 最大 50・cursor なし）のまま
- エラーの形：
 ```json
 { "error": { "code": "BOX_RUNNING", "message": "VM が動いている間は消せません", "details": {} } }
 ```

<details>
<summary>エラーコード（足すもの。今のコードはそのまま）</summary>

| code | HTTP | 意味 |
|---|---|---|
| `NOT_OWNER` | 403 | 持ち主のログイン名でない |
| `CSRF_REJECTED` | 403 | Origin・専用ヘッダーが違う |
| `CONNECT_STATE_INVALID` | 400 | つなぐときの `state`・Cookie・PKCE が合わない |
| `BOX_NOT_FOUND` | 404 | VM がない |
| `BOX_NOT_RUNNING` | 409 | VM が止まっている |
| `BOX_RUNNING` | 409 | VM が動いている（ホームを入れ替えられない） |
| `SCREEN_IN_USE` | 409 | 画面の番が使われている（ブラウザのデータを消せない） |
| `MAIN_AGENT` | 409 | メインは消せない |
| `TASK_NOT_ACTIVE` | 409 | 終わったタスクに言い直そうとした |
| `ROUTINE_LIMIT` | 409 | ルーチンが 20 本ある |
| `SCHEDULE_INVALID` | 422 | cron の形が違う・15 分より短い間隔 |
| `MEMORY_FULL` | 409 | プロフィールが 100 個・4,000 字を超える |
| `SNAPSHOT_NOT_FOUND` | 404 | 控えがない |
| `HOOK_NOT_FOUND` | 404 | 受け口がない・止めてある |
| `HOOK_SIGNATURE_INVALID` | 401 | 署名が合わない（本文は残さない） |
| `HOOK_RATE_LIMITED` | 429 | 1 受け口で 1 分 60 件を超えた（何も残さない：D-318） |
| `PAYLOAD_TOO_LARGE` | 413 | webhook の本文が 256KB を超えた・ファイルが 20MB を超えた |
| `PUSH_INVALID` | 422 | 購読の形が違う |
| `NOT_TAKEN_OVER` | 409 | 人が操作する状態でないのに操作の形でつなごうとした・返そうとした |
| `ALREADY_TAKEN_OVER` | 409 | もう交代中か、渡す準備中 |
| `CONTROL_IN_USE` | 409 | 操作の形の画面がもう1つつながっている |
| `CHECK_NOT_PENDING` | 409 | 確認がもう決まっている（二重の ○） |
| `PACK_NOT_FOUND` | 404 | パックがない |
| `PACK_INVALID` | 422 | パックのファイルの形が違う |
| `PACK_ALREADY_INSTALLED` | 409 | 同じ版がもう入っている |
| `COMMANDS_FULL` | 409 | （内部）ターミナルが同時に 2 本動いている |
| `VM_BUSY` | 409 | VM の操作（控え・戻す・作り直す）の途中 |
| `DISK_LOW` | 507 | ホストの空きディスクが足りない（3GB 未満。D-265） |
| `STALE_CONTROL` | 409 | （内部）VM の世代が古い操作・コマンド、`control_epoch` が古い画面の操作（コマンドは `control_epoch` を見ない：D-296） |
| `CONTENT_CHANGED` | 409 | （内部）承認した中身と今の画面が違う |
| `COMMAND_TIMEOUT` | 504 | （内部）コマンドが `timeoutSec` を超えた。本体は Claude に `ok = false` と打ち切りを返す（FR-086） |

</details>


### エンドポイント一覧
| ID | メソッド | パス | 概要 | 関連FR/SCR | 詳細 |
|---|---|---|---|---|---|
| API-082 | GET | `/api/health` | `ok` と版だけ（確かめなし） | FR-083 | — |
| API-111 | GET | `/api/v1/host` | ホストの状態（版・DB・box-manager・VM・空きメモリ・空きディスク・`llm: { model, reviewModel }`・`vm.browserSandbox: true\|false`（false は「ブラウザのサンドボックスなし」：D-326）・今日の費用・キャッシュの当たり率・Funnel の状態） | FR-083, FR-098 / SCR-023 | — |
| API-083 | GET | `/api/v1/session` | 持ち主のログイン名・表示名 | FR-073 / 全画面 | — |
| API-085 | GET | `/api/v1/events` | SSE（変化の合図。通し番号つき：D-196） | FR-018 / 全画面 | [下](#api-085sse-は合図d-196) |
| API-100 | GET | `/api/v1/counts` | 確認待ち・動いているタスクの件数 | FR-018 / SCR-020 | — |
| API-119 | POST | `/api/v1/messages` | メインに送る | FR-090 / SCR-020 | [resident](resident.md#api-119post-apiv1messages) |
| API-120 | GET | `/api/v1/messages` | チャットを読む。`mainState` 付き | FR-093 / SCR-020 | [resident](resident.md#api-120get-apiv1messages) |
| API-121 | POST | `/api/v1/presence` | 画面が見えているかの心拍（前に出ている間は 30 秒ごと） | FR-017 / SCR-020 | [resident](resident.md#api-121post-apiv1presence) |
| API-122 | GET | `/api/v1/tasks` | タスクの一覧（`?status=active\|done`） | FR-092 / SCR-020 | [resident](resident.md#api-122get-apiv1tasks) |
| API-123 | GET | `/api/v1/tasks/:taskId` | タスクの中身（`brief`・歩み・ブラウザ・ターミナル・オートレビュー・報告） | FR-092 / SCR-021 | [resident](resident.md#api-123get-apiv1taskstaskid) |
| API-124 | POST | `/api/v1/tasks/:taskId/steer` | タスクに言い直す | FR-089 / SCR-021 | [resident](resident.md#api-124post-apiv1taskstaskidsteer) |
| API-016 | POST | `/api/v1/tasks/:taskId/cancel` | タスクを取り消す（画面の番を返す） | FR-092 / SCR-021 | — |
| API-041 | GET | `/api/v1/agents` | エージェントの一覧（メインを先頭に。`kind`・`description`・`createdBy` を足す） | FR-072 / SCR-014 | — |
| API-080 | POST | `/api/v1/agents` | したいことから1人作る | FR-072 / SCR-014 | — |
| API-081 | DELETE | `/api/v1/agents/:agentId` | 論理削除（メインは 409 `MAIN_AGENT`） | FR-072 / SCR-014 | — |
| API-087 | GET | `/api/v1/check` | 確認の一覧（API の書き込み・ブラウザ・交代の頼み・ルーチンの提案） | FR-077, FR-078, FR-081, FR-094 / SCR-019 | [vm](vm.md#api-087get-apiv1check) |
| API-019 | POST | `/api/v1/approvals/:approvalId/decision` | API の書き込みの ○ / ×。`turn_id` を持つ Intent は、× なら決めたのと、○ なら実行の結果を書くのと同じトランザクションで `approval_done` を入れる（D-248・D-275） | FR-081 / SCR-019 | — |
| API-110 | POST | `/api/v1/browser-checks/:checkId/decision` | ブラウザの確認の ○ / × | FR-077 / SCR-019 | [vm](vm.md#api-110post-apiv1browser-checkscheckiddecision) |
| API-142 | POST | `/api/v1/routine-proposals/:proposalId/decision` | ルーチンの提案の ○ / × | FR-094 / SCR-019 | [resident](resident.md#api-142post-apiv1routine-proposalsproposaliddecision) |
| API-088 | GET | `/api/v1/vm` | VM の状態・世代・画面の番・操作する人・交代の頼み・最新のスクショ・ホームの大きさ | FR-074, FR-078 / SCR-022, 023 | [vm](vm.md#api-088get-apiv1vm) |
| API-089 | GET（WebSocket） | `/api/v1/vm/screen?mode=view\|control` | 画面（VNC）。`control` は人が操作する状態のときだけ・1本だけ | FR-078 / SCR-022 | [vm](vm.md#api-089websocket-apiv1vmscreen) |
| API-090 | POST | `/api/v1/vm/takeover` | 代わる | FR-078 / SCR-022 | [vm](vm.md#api-090post-apiv1vmtakeover) |
| API-091 | POST | `/api/v1/vm/handback` | 返す | FR-078 / SCR-022 | [vm](vm.md#api-091post-apiv1vmhandback) |
| API-099 | POST | `/api/v1/vm/stop` | VM を止める（使っているタスクは VM 待ち） | FR-074 / SCR-022 | — |
| API-133 | GET・POST | `/api/v1/vm/snapshots` | 控えの一覧・今すぐ取る | FR-100 / SCR-023 | [vm](vm.md#api-133135vm-の控え戻す作り直す) |
| API-134 | POST | `/api/v1/vm/restore` | 控えに戻す `{ snapshotId }` | FR-100 / SCR-023 | [vm](vm.md#api-133135vm-の控え戻す作り直す) |
| API-135 | POST | `/api/v1/vm/rebuild` | 空から作り直す | FR-100 / SCR-023 | [vm](vm.md#api-133135vm-の控え戻す作り直す) |
| API-138 | DELETE | `/api/v1/vm/browser-data` | ブラウザのデータを消す | FR-079 / SCR-023 | — |
| API-145 | GET・POST | — | 使わない（v1.4：D-319） | — | — |
| API-146 | POST | — | 使わない（v1.4：D-319） | — | — |
| API-112 | GET | `/api/v1/shots/:file`・`/api/v1/files/:taskId/:name` | スクショの画像（7日を過ぎたら 404）・タスクの成果物。成果物は `Content-Disposition: attachment`・`X-Content-Type-Options: nosniff`・`Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'` で返す。`?preview=1` は `inline` で同じ CSP（スクリプトは動かず、本体と別の出どころ扱い。D-243） | FR-075, FR-093 / SCR-019〜022 | — |
| API-125 | GET・POST | `/api/v1/routines` | ルーチンの一覧・作る | FR-094 / SCR-026 | [resident](resident.md#api-125126ルーチン) |
| API-126 | PATCH・DELETE | `/api/v1/routines/:routineId` | 直す・止める・消す | FR-094 / SCR-026 | [resident](resident.md#api-125126ルーチン) |
| API-136 | POST | `/api/v1/routines/:routineId/run` | 今すぐ動かす | FR-094 / SCR-026 | — |
| API-127 | GET | `/api/v1/scheduled-wakes` | 予約した確認の一覧（`pending`） | FR-095 / SCR-026 | — |
| API-139 | DELETE | `/api/v1/scheduled-wakes/:wakeId` | 予約を消す | FR-095 / SCR-026 | — |
| API-128 | GET・POST | `/api/v1/webhooks` | 受け口の一覧・作る（秘密は作ったときだけ返す） | FR-096 / SCR-026 | [resident](resident.md#api-128getpost-apiv1webhooks) |
| API-140 | PATCH・DELETE | `/api/v1/webhooks/:hookId` | 止める・消す | FR-096 / SCR-026 | — |
| API-129 | POST | `:8443/hooks/:hookId`（Funnel → :8081） | webhook を受ける（署名で確かめる） | FR-096 | [resident](resident.md#api-129post-hookshookid) |
| API-130 | GET | `/api/v1/memory` | プロフィール（`?q=` で検索） | FR-097 / SCR-025 | [resident](resident.md#api-130131141記憶) |
| API-141 | POST | `/api/v1/memory/facts` | 事実を足す | FR-097 / SCR-025 | [resident](resident.md#api-130131141記憶) |
| API-131 | PATCH・DELETE | `/api/v1/memory/facts/:factId` | 事実を直す・消す | FR-097 / SCR-025 | [resident](resident.md#api-130131141記憶) |
| API-132 | DELETE | `/api/v1/memory/log/:logId` | 使わない（v1.4：D-325） | — | — |
| API-147 | POST | — | 使わない（v1.4：D-323） | — | — |
| API-137 | GET | `/api/v1/push/key` | VAPID の公開鍵 | FR-017 / SCR-023 | — |
| API-031 | POST | `/api/v1/push-subscriptions` | 通知の購読（`{ endpoint, keys: { p256dh, auth } }`。`?test=1` で試しに送る） | FR-017 / SCR-023 | — |
| API-032 | DELETE | `/api/v1/push-subscriptions/:subscriptionId` | 購読の削除 | FR-017 / SCR-023 | — |
| API-023 | GET | `/api/v1/audit-logs` | 監査ログ（旧 Node 版から移す。種類で絞れる） | FR-016 / SCR-010 | — |
| API-093 | GET | `/api/v1/connectors` | つながりの一覧 | FR-081 / SCR-023 | — |
| API-094 | GET | `/api/v1/connect/:kind/start` | つなぎ始める | FR-081 / SCR-023 | [vm](vm.md#api-094095つなぐ) |
| API-095 | GET | `/api/v1/connect/:kind/callback` | 戻り先 | FR-081 | [vm](vm.md#api-094095つなぐ) |
| API-107 | DELETE | `/api/v1/connect/:kind` | つながりを外す | FR-081 / SCR-023 | — |
| API-096 | GET・PATCH | `/api/v1/settings` | `budget`（`daily_usd`・`daily_auto_usd`）・`browser`・`terminal` 欄・裏のタスクの同時数 | FR-013, FR-076, FR-099 / SCR-023 | [vm](vm.md#api-096getpatch-apiv1settings) |
| API-097 | GET | `/api/v1/export` | 使わない（v1.4：D-316） | — | — |
| API-098 | POST | `/api/v1/import` | 使わない（v1.4：D-316） | — | — |
| API-114 | GET | `/api/v1/packs` | パックの一覧 | FR-085 / SCR-024 | [vm](vm.md#api-114get-apiv1packs) |
| API-115 | POST | `/api/v1/packs/:packId/install` | パックを入れる・更新する | FR-085 / SCR-024 | [vm](vm.md#api-115post-apiv1packspackidinstall) |
| API-116 | DELETE | `/api/v1/packs/:packId` | パックを外す | FR-085 / SCR-024 | [vm](vm.md#api-116delete-apiv1packspackid) |

使わなくなった API（D-235・ADR-060）：API-072・073・075・076・077・084（依頼）、API-086（VM の一覧。1 台なので API-088 に）、API-092（エージェントのプロフィール。API-138 に）。画面は `/api/v1/workspaces/w1/stream` から API-085 に差し替える。

### API-085：SSE は合図（D-196）
- 1 つの事象は `id:`（`workspace_events.id`。通し番号）と `data:`（`{ "type": "task.updated", "taskId": "..." }` のように種類と対象の ID だけ。種類は `chat.created`・`turn.updated`・`task.updated`・`vm.updated`・`check.created`・`check.updated`・`memory.updated`・`trigger.updated`）。中身（状態・スクショ・メッセージ）は載せない
- 画面は合図を受けたら、対象を REST（API-120・122・123・088・087 など）で取りに行く。合図を落としても、次の合図か読み直しで追いつく
- 番号が 1 つ飛んだら、その時点で開いている画面の対象をすべて読み直す。つなぎ直すときは `Last-Event-ID` を送り、本体は残っている事象から続きを流す。残っていなければ `event: reset` を送り、画面はすべて読み直す
- `workspace_events` は 1 日で消す（今の掃除のまま）
- 画面が見えているかの合図：画面は `visibilitychange` で API-121 に `{ visible: true|false }` を送る。見えている端末が 1 つでもあれば Web Push を送らない（FR-017）


## このドキュメントで決まったこと
- D-148、D-151、D-156、D-158〜D-160、D-163、D-173、D-176、D-178、D-194、D-196、D-207、D-208、D-221〜D-223、D-229、D-234、D-235、D-275（[00 決定事項ログ](../00_overview.md#決定事項ログ)）
- v1.4：D-315（接続先は Anthropic 直だけ。`llm` は `model` だけ）、D-316（書き出し・取り込みを消す）、D-317（API-121 は心拍だけ）、D-318（webhook は 1 分 60 件で 429）、D-319（掃除のための起動を消す）、D-320（リアクションを消す）、D-322（`budget` は `daily_usd`・`daily_auto_usd`）、D-323（要約の印を消す操作を消す）、D-324（差し込みをやめる）、D-325（記憶は 2 層）、D-326（2 コンテナ）、D-327（本体の再起動は新しい世代）
