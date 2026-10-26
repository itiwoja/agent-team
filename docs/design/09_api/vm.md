# 09. API設計：VM・確認・設定の API（v0.6 から引き継ぐ API）
- プロジェクト：Agent-Team-Open ／ 版数：v1.7（2026-10-26） ／ 親：[09 API設計](README.md)

> **3行で**
> 1. VM は 1 台なので、画面向けの VM の API は `/api/v1/vm/*` になった（v0.6 の `/boxes/:boxId`）。控え・戻す・作り直す（API-133〜135）を足した。VM の実体は `box-browser`・`box-shell` の 2 つのコンテナの組で、画面向けの API では 1 つの VM として見せる。
> 2. ブラウザの確認の ○ / × は、API の書き込みの承認（API-019）とは別の口（API-110）。実行は1回だけで、中身が同じときだけ。
> 3. パック・設定・つなぎ方は v0.6 の形のまま、v1.0 の欄を足した。内部 API は [下](#内部-apibox-manager)。v1.6 で、設定（API-096）に `network`・`review`・`llm` の欄を足し、持ち主の確かめ（API-083）に、社内 LAN の直結のパスキーのログインを足した（新しい API 番号は振らない）。v1.7 で、保管庫（API-153）と Home Assistant（API-155）を足し、確認（API-087）に家電・保管庫・家計簿のカードを、設定（API-096）に `vault`・`home`・`classify` の欄を足した。

---

### API-088：GET /api/v1/vm
- レスポンス（200）：
<details>
<summary>例</summary>

```json
{
 "status": "running", "boxId": "0193...", "control": "agent",
 "screenTask": { "id": "0193...", "title": "店探し" }, "waitingScreen": 1,
 "takeoverRequest": null, "lastShotUrl": "/api/v1/shots/0193....png",
 "lastActionSummary": "日付を選んでいます", "vmOp": "none",
 "vmHomeState": "ok",
 "homeBytes": 1834000000, "homeLimitBytes": 4294967296,
 "lastSnapshot": { "id": "0193...", "createdAt": "2026-10-24T04:00:00+09:00" }
}
```

</details>

- 眠っているときは `status: "stopped"` と最後のスクショ
- `vmHomeState`：`ok`・`broken`（戻す・作り直すだけ）（D-294）。`homeBytes` が `homeLimitBytes` を超えている間は、タスクのために VM を起こさず、画面は大きさと 3 つの操作（ブラウザのデータを消す・控えに戻す・作り直す）を出す（D-319）。`homeBytes` は `makase-vm-home` と `makase-browser-profile` の合計

### API-089：WebSocket /api/v1/vm/screen
- 開始のとき `Origin` を確かめる。`mode=view` は VM が動いていればいつでも（眠っていれば 409 `BOX_NOT_RUNNING` で閉じ、画面は最後のスクショを出す）。`mode=control` は `boxes.control = 'human'` のときだけで、同時に1本だけ（違えば 409 `NOT_TAKEN_OVER`・`CONTROL_IN_USE` で閉じる）
- 中身は RFB（VNC）をそのまま流す。本体は box-manager（API-106）に中継し、`view` のときは入力のメッセージを捨てる
- `control` が `human` でなくなったら、本体が `control` の接続を閉じる

### API-090：POST /api/v1/vm/takeover
- 処理：`control` を `handing_over` にし、`control_epoch` を1増やす → API-113 で `handing_over` と新しい epoch を VM に伝える（D-160） → 画面の番を持つタスクがあれば、その動いている Claude の呼び出しを中止する → その `llm:<n>` の歩みを `done`（結果 `aborted`）で閉じ、予約した費用を精算する（実際の請求額が取れなければ見積もりのまま確定。`started` のまま残さない：D-163） → その VM の世代の `pending` の確認を `expired`（`taken_over`）にする → box-agent の動いている操作が終わるのを待つ → `control = human`、`takeovers` を `active`（頼みがあればそれを、なければ新しく）、画面の番を持つタスクの `status_detail = 'taken_over'` にして 200（番を持つタスクがなければ、交代は VM だけに結びつく）
- エラー：409 `ALREADY_TAKEN_OVER`・`BOX_NOT_RUNNING`

### API-091：POST /api/v1/vm/handback
- リクエスト：`{ "note": "ログインしました" }`（任意、200字まで。Claude に渡す）
- 処理：`control` の接続を閉じ、`control = agent`・`control_epoch` を1増やし、API-113 で `agent` と新しい epoch を VM に伝える（D-160）。交代を `ended`、スクショを撮って残す。画面の番を持つタスクがあれば続ける
- エラー：409 `NOT_TAKEN_OVER`
- 撮影不能（FR-075）は画像なしで交代終了を記録し、タスクは `waiting_takeover` として人に安全な画面への対応を要求する。秘密を含むnoteは保存/LLM送信せず拒否する。

### API-133〜135：VM の控え・戻す・作り直す
- GET `/api/v1/vm/snapshots`：`{ items: [{ id, kind, sizeBytes, status, createdAt }] }`
- POST `/api/v1/vm/snapshots`：今すぐ取る。VM を止めてから取る（使っているタスクは `waiting_vm`）→ 202 `{ id }`。終わったら SSE の `vm.updated`
- POST `/api/v1/vm/restore`：`{ "snapshotId" }` → 202 `{ haltedTasks: 2 }`。POST `/api/v1/vm/rebuild` → 202。どちらも VM を使っているタスク（終わっていないタスクのうち VM の道具を一度でも使ったものと画面の番を持つもの）を `halted`（`vm_replaced`）で閉じ、その `pending` の確認を `expired`（`vm_replaced`）にする（D-268・D-308）。`vm_op` が `none` でなければ 409 `VM_BUSY`。`vmHomeState` が `broken` でも受ける
- 処理（FR-100）：画面の番を空にし、VM を止め、API-108 でホームを入れ替える（非同期。本体が終わりを確かめる：D-294）。終わったら SSE の `vm.updated`。監査ログ `vm.restored`・`vm.rebuilt`、失敗は `vm.restore_failed`（`vmHomeState` が `broken` になる）
- API-138：DELETE `/api/v1/vm/browser-data` → 202。FR-079の条件付きclearing_browser取得後API-144へ渡す。競合は409 VM_BUSY/SCREEN_IN_USE/ALREADY_TAKEN_OVER、brokenは409 VM_BUSY。完了は結果確定/ACK後にSSE vm.updated。API-144は停止済みの最終世代にも使え、まだ世代がないときは予約ID `unstarted` を消去に限り許す（起動しない）。
- 今すぐの控え（POST `/api/v1/vm/snapshots`）は、ホストの空きが「ホームの大きさ＋3GB」に足りなければ 507 `DISK_LOW`（D-300）
- エラー：404 `SNAPSHOT_NOT_FOUND`、交代中は 409 `ALREADY_TAKEN_OVER`

### API-087：GET /api/v1/check
- 概要：確認待ちのもの。今の書き込みのカードに、`kind: "browser"`・`kind: "takeover"`・`kind: "routine"`（ルーチンの提案：API-142）を足す。v1.7：`kind: "home"`（家電）・`kind: "vault"`（保管庫）・`kind: "ledger"`（家計簿の読み取りの確認）を足す（下）。ブラウザのカードには `taskId`・`taskTitle`・オートレビューが止めた理由（`reviewReason`）を入れる
- browserカードには `effectiveAction`（TBL-039.contentから取得、安全な完全絶対URLまたは非送信のnull）を追加。T-1はbrowserカードでなくtakeoverカード（IMP-002・004）。
- レスポンス（200）：
<details>
<summary>例</summary>

```json
{
 "items": [
  {
   "kind": "browser",
   "checkId": "0193...",
   "taskId": "0193...",
   "taskTitle": "店探し",
   "summary": "購入ボタンを押します",
   "domain": "example.jp",
   "target": { "role": "button", "name": "予約を確定する" },
   "point": { "x": 812, "y": 604 },
   "screenshotUrl": "/api/v1/shots/0193....png",
   "reasons": ["T-3"],
   "declared": false,
   "reviewReason": null,
   "expiresAt": "2026-10-23T10:30:00Z"
  },
  { "kind": "takeover", "boxId": "0193...", "taskId": "0193...", "reason": "ログインしてください", "requestedAt": "2026-10-23T10:00:00Z" },
  { "kind": "home", "approvalId": "0193...", "taskTitle": "朝の支度", "summary": "玄関の鍵を開けます", "entityId": "lock.front_door", "name": "玄関の鍵", "deviceClass": "human", "action": "unlock", "reasons": ["BR-15"], "expiresAt": "2026-10-26T10:30:00Z" },
  { "kind": "vault", "approvalId": "0193...", "taskTitle": "写真の整理", "summary": "写真 120 枚をゴミ箱に移します（30 日は戻せます）", "count": 120, "sample": ["写真/2026/10/IMG_0001.jpg"], "reasons": ["bulk_trash"], "expiresAt": "2026-10-26T10:30:00Z" },
  { "kind": "vault", "approvalId": "0193...", "taskTitle": "写真の分類", "summary": "写真 300 枚をクラウドの LLM に送って分類します", "count": 300, "estimate": { "usd": 0.9, "yenApprox": 140 }, "reasons": ["cloud_vision_estimate"], "expiresAt": "2026-10-26T10:30:00Z" },
  { "kind": "ledger", "entryId": "0193...", "summary": "レシートの金額を確かめてください", "store": "○○スーパー", "entryDate": "2026-10-25", "amountYen": 3280, "lowConfidence": ["amount"], "receiptThumbUrl": "/api/v1/chat/attachments/0193.../thumb", "expiresAt": "2026-11-02T10:00:00Z" },
  { "kind": "routine", "proposalId": "0193...", "name": "週次の PR のまとめ", "schedule": "0 9 * * 1", "scheduleText": "毎週月曜 9:00", "prompt": "先週の PR を…", "expiresAt": "2026-10-31T10:00:00Z" }
 ]
}
```

</details>

- v1.7 のカード（D-373・375・378）：
 | `kind` | いつ出るか | ○ / × | 備考 |
 |---|---|---|---|
 | `home` | 区分が `human` か「こわい」の印つきの機器を動かす、またはそれらに触る自動化を作る・変える（BR-15）。自動化を作る・変える・消すのも、既定で出る（`home.automation_confirm`） | API-019 | `reasons` は `BR-15`（こわい機器）・`automation_confirm`（自動化の確認）。区分は Kernel の規則で決める。判断モデル・LLM では決めない（BR-16） |
 | `vault` | 一度に 20 枚以上をゴミ箱へ移す・保管庫の外へ出す、画像の中身での分類をクラウドに送る（件数と費用の見積もり：D-374） | API-019 | 上限（`budget`）の中でしか行わない。送った枚数は台帳に残る。ゴミ箱を空にするのはカードでなく人が画面で行う（API-153） |
 | `ledger` | レシートの金額・日付の読み取りの自信が下限より低い（`low_confidence = 1`） | 直して決める：API-154 の `PATCH`・`POST /ledger/entries/:id/confirm` | 7 日で消える（そのままの値で `needs_check` が残る） |
 家電と保管庫のカードの ○ を押したあと、状況が変わっていたら「状況が変わったので実行しませんでした」と出して消える（D-307 と同じ）。

### API-110：POST /api/v1/browser-checks/:checkId/decision
- リクエスト：`{ "decision": "approve" | "reject" }`
- 処理：1つのトランザクションで `pending → executing`（approve）か `pending → rejected`（reject）に変える。0行なら 409 `CHECK_NOT_PENDING`。approve のときは同じトランザクションで実行の直前の確かめ（FR-075 の 3a：タスクが `awaiting_approval`・VM の世代が同じ・画面の番をそのタスクが持ち `screen_epoch` が確認の `screen_epoch` と同じ・`control = agent`・VM の操作の途中でない）をし、外れたら `expired`（`task_cancelled`・`box_restarted`・`screen_lost`・`taken_over`・`vm_replaced`）にして `expired` を返す（D-250・D-307）。approve なら、その外で API-103 に `actionId` と `expect: contentHash` を付けて頼む
- レスポンス（200）：`{ "result": "executed" | "page_changed" | "rejected" | "expired" | "unknown_outcome", "expireReason": null }`。`expired` のときは `expireReason` に理由（D-307）
- `page_changed`（承認のあと中身が変わっていた）のときは、新しい確認は作らない。確認を `expired`（`page_changed`）にし、Claude に新しいスクショと「画面が変わったので実行しなかった」を返して操作を決め直させる（D-159）

### API-094・095：つなぐ
- API-094：期限 10分・1回限りの `state` を作り、HttpOnly・Secure・SameSite=Lax の Cookie にも入れる。Google は PKCE の `code_challenge` を付ける
- API-095：`state`・Cookie・PKCE（Google）、インストールの ID（GitHub）を確かめる。合わなければ 400 `CONNECT_STATE_INVALID`。使った `state` は消す

### API-083：GET /api/v1/session（持ち主の確かめ。v1.6 の拡張：D-358）
入口によって、持ち主の確かめ方が違う。新しい API 番号は振らず、API-083 の下に足す。
| 入口 | 確かめ方 |
|---|---|
| Tailscale・Headscale | 今のまま。`tailscale serve` が付ける `Tailscale-User-Login` を `OWNER_LOGIN` と比べる（Headscale でも `tailscale serve` が同じヘッダーを付ける）。違えば 403 `NOT_OWNER` |
| 家の LAN の直結（家で作った CA の TLS。企業の社内 LAN なら社内 CA） | 本体のパスキー（WebAuthn）でログインする。成功すると、HttpOnly・Secure・SameSite=Strict のセッション Cookie（12 時間）を付ける。Cookie の署名には `workspace.session_epoch` を入れ、上げると全部切れる |
- GET `/api/v1/session`：200 `{ "login": "...", "displayName": "...", "auth": "tailscale" | "passkey" }`。LAN 直結でセッションがなければ 401 `LOGIN_REQUIRED`（画面はパスキーのログイン画面を出す）
- POST `/api/v1/session/passkey/options`：ログインの `challenge` と `allowCredentials` を返す（`challenge` は本体のメモリに 5 分だけ置く）
- POST `/api/v1/session/passkey/verify`：`{ assertion }` を `workspace.owner_passkeys` の公開鍵で確かめ、`sign_count` を更新して Cookie を付ける（200）。合わなければ 401 `PASSKEY_INVALID`。失敗は 1 分に 5 回まで（超えたら 429）
- POST `/api/v1/session/passkey/enroll/options`・`/enroll/verify`：パスキーの登録。最初の 1 つは、`docker compose exec makase makase owner-enroll` が出す 1 回限りの URL（15 分。`workspace.owner_enroll`）の鍵がボディにあるときだけ受ける（鍵が違えば 403 `ENROLL_TOKEN_INVALID`）。2 つ目からは、ログイン済みの画面から足す（5 件まで）
- DELETE `/api/v1/session`：ログアウト（Cookie を消す）
- CSRF は共通仕様のまま（Origin と `X-Makase-Request: 1`）。`closed` では Tailscale の SaaS を使わないので、LAN 直結か Headscale で入る（D-341）
- 監査ログに `session.login`・`session.enrolled`（失敗は `session.login_failed`）を残す

### API-096：GET・PATCH /api/v1/settings
- PATCH のボディ：
 ```json
 {
  "budget": { "daily_usd": 10, "daily_auto_usd": 7 },
  "browser": { "confirmDomains": [], "skipUnresolvedDomains": [], "humanWords": [], "confirmWords": [] },
  "network": { "mode": "closed", "allow_hosts": ["llm.corp.example"], "internal_hosts": { "browser": [{ "host": "10.20.0.0/24", "on_use": "confirm" }], "terminal": [] } },
  "review": { "auto": { "enabled": false } },
  "llm": { "roles": { "main": { "provider": "anthropic", "model": "claude-opus-5-5" }, "classify": { "provider": "decision", "model": "…" } }, "experimental_generic_computer": false },
  "vault": { "trash_days": 30, "versions_days": 30, "backup": { "enabled": true, "target": "smb://nas.local/backup" } },
  "home": { "human_device_classes": ["lock", "climate", "water_heater", "valve", "alarm_control_panel", "cover", "switch"], "automation_confirm": "always" },
  "classify": { "min_confidence": 0.8 },
  "maxTasks": 3
 }
 ```
 （どの欄も部分でよい）。v1.6：`browser.autoReview` は `review.auto.enabled` に移した（既定は `false`：D-351）。`network` は D-340・343、`llm` は D-352。v1.7：`vault`（D-373）・`home`（D-378）・`classify`（D-379）の欄を足した（どれも部分でよい）。`vault.trash_days`・`vault.versions_days` は 30 より短くできない（422 `VALIDATION_ERROR`）。`home.human_device_classes` は既定の 6 つ（`lock`・`climate`・`water_heater`・`valve`・`alarm_control_panel`・`cover`）を外せない（足すだけ。外そうとしたら 422 `HOME_CLASS_FIXED`）。`classify.min_confidence` は 0.5〜0.99
- GET の応答は、同じ形の今の値。`network` に固定の除外（本体・box-manager・tailnet・ホスト自身・クラウドのメタデータ）の一覧を `fixedExclusions` として添える
- 副作用：ポリシーの新しい版を作る（`workspace_policies`）。効くのは次のタスク・ターンから（動いているものは始まるときのポリシーのまま）。`browser`・`terminal`・`network`・`review.auto.enabled` を変えたときは、[API-149](resident.md#api-149apiv1policy) と同じ手順（試験 → 版を足す）を通り、試験が外れたら 422 `POLICY_TESTS_FAILED`。`home.human_device_classes`・`home.automation_confirm` も規則の版に入り、同じ手順を通る（TBL-057）。`budget`・`llm`・`vault`・`classify`・`maxTasks` は版を足さない（D-369）。v1.7：`llm.chatgpt_allow_auto`（既定 false：ChatGPT の枠を自動のきっかけで使ってよいか。D-389）も `llm` 欄の一部で、版を足さない。`llm` の割り当ては [API-152](resident.md#api-152apiv1llmmodelsapiv1llmroles) と同じ照合を通る（422 `LLM_CAPABILITY_MISSING` など）
- `network.mode` を `closed` にするとき、今の `llm` の接続先が `allow_hosts` に入っていなければ 422 `LLM_HOST_NOT_ALLOWED`（入れ忘れで本体が LLM に届かなくなるのを防ぐ）。`closed` では `terminal.allow_hosts` は `allow_hosts` と `internal_hosts.terminal` に入っている先だけが効く（D-366）
- 監査ログに `network.mode_changed`（`mode` を変えたとき）・`policy.changed`（規則の欄）・`llm.role_changed` を残す。`llm.roles.classify` の割り当ては `cap_decision` を照合する（なければ 422 `LLM_CAPABILITY_MISSING`）。v1.7：スマホの画面では、`network.mode = 'closed'` を「家の中だけで動かす」と呼ぶ

### API-153：/api/v1/vault（保管庫）
家の保管庫（`makase-vault`）のファイルを見る・縮小版・ゴミ箱・戻す・空にする（TBL-060。FR-110・111・SCR-030）。エージェントが道具（`vault_list`・`vault_read`・`vault_write`・`vault_move`・`vault_trash`）で扱うのとは別に、持ち主が画面から扱う口。**消すのはゴミ箱へ移すだけ**（30 日で自動で消える）。空にする・30 日より前に消すのは、この API の持ち主の操作だけ。
| メソッド | パス | 中身 |
|---|---|---|
| GET | `/api/v1/vault/status` | 保管庫の状態：`{ connected, kind: "usb"｜"smb", totalBytes, freeBytes, indexedCount, trashCount, trashBytes, nextPurgeAt, backup: { enabled, lastAt } }`。つながっていなければ `connected: false` |
| GET | `/api/v1/vault/files` | 一覧。`?folder=photos｜documents｜receipts｜exports｜trash&sort=taken｜created｜name&order=desc&from=&to=&place=&tag=&duplicates=1&q=&cursor=&limit=`（`from`・`to` は日付。既定は `sort=taken`・`limit` 20・最大 100）。応答 `{ items: [{ id, path, folder, name, mime, sizeBytes, takenAt, place, tags, thumbUrl, duplicateOf, trashedAt, purgeAt, versions: [{ savedAt, purgeAt }] }], nextCursor }` |
| GET | `/api/v1/vault/files/:id` | 1 件の中身のメタデータ |
| GET | `/api/v1/vault/files/:id/content` | 元のファイル。`Content-Disposition: attachment`・`X-Content-Type-Options: nosniff`・`Content-Security-Policy: sandbox`。`?preview=1` は画像・PDF だけ `inline` |
| GET | `/api/v1/vault/files/:id/thumb` | 縮小版（長辺 512px・JPEG）。なければ作って返す |
| POST | `/api/v1/vault/files/:id/trash` | ゴミ箱へ移す。複数は `POST /api/v1/vault/trash/batch`（`{ ids: [...] }`、200 件まで）。応答に `purgeAt`。監査ログ `vault.trashed` |
| POST | `/api/v1/vault/files/:id/restore` | ゴミ箱から元の場所へ戻す。元の場所に同名があれば `名前 (1)` にする。前の版の戻しは `{ "version": "<savedAt>" }`。監査ログ `vault.restored` |
| DELETE | `/api/v1/vault/trash` | **ゴミ箱を空にする**。ボディ `{ "confirm": "empty", "count": 42 }`。`count` は画面に見せた件数で、今の件数と違えば 409 `VAULT_TRASH_CHANGED`（見せた件数と違うものは消さない）。`confirm` がなければ 422 `VAULT_CONFIRM_REQUIRED`。監査ログ `vault.emptied`（件数・合計の大きさ） |
| DELETE | `/api/v1/vault/trash/:id` | ゴミ箱の 1 件を 30 日より前に消す。同じく `{ "confirm": "delete" }` が要る |
- 空にする・30 日より前に消すのは、エージェントの道具からは呼べない（Kernel が断る）。画面は「元に戻せません。42 件を空にしますか？」と件数を見せて、[ やめる ] と [ 空にする ] を出す（SCR-030）
- 保管庫がつながっていないとき：一覧と縮小版は索引から返す（実体を読むものは 503 `VAULT_NOT_MOUNTED`）。書き込み・ゴミ箱・空にするは 503 `VAULT_NOT_MOUNTED`
- パスは API で受けない（`id` だけ）。`..` や保管庫の外を指す入力はそもそも通らない
- エラー：404 `VAULT_FILE_NOT_FOUND`、503 `VAULT_NOT_MOUNTED`、409 `VAULT_TRASH_CHANGED`、422 `VAULT_CONFIRM_REQUIRED`、持ち主以外は 403 `NOT_OWNER`

### API-155：/api/v1/home（Home Assistant）
HA につなぐ・機器の一覧・「こわい」の印（TBL-062。FR-113・SCR-032）。機器を動かす・自動化を作る/変える/消すのは、エージェントの道具で行い（判定は Kernel と BR-15）、この API にはない。
| メソッド | パス | 中身 |
|---|---|---|
| GET | `/api/v1/home/status` | `{ connected, baseUrl, haVersion, deviceCount, humanCount, lastSyncedAt, lastError }`。つながっていなければ `connected: false` |
| PUT | `/api/v1/home/connection` | つなぐ。`{ baseUrl, token }`（HA の長期トークン）。本体が HA を 1 回呼んで確かめてから、トークンを暗号化して置き（VM には置かない）、`baseUrl` のホストを内部ホストに自動で登録する（`on_use` は `confirm`）。確かめに外れたら 422 `HA_TOKEN_INVALID`、届かなければ 502 `HA_UNREACHABLE`。応答にトークンは出さない |
| DELETE | `/api/v1/home/connection` | 外す（トークンを消す。`home_devices` の行は残し、`removed_at` を入れる） |
| POST | `/api/v1/home/sync` | 今すぐ HA から写し直す |
| GET | `/api/v1/home/devices` | 機器の一覧。`?area=&domain=&class=human｜normal&flagged=1&q=&cursor=&limit=`。応答 `{ items: [{ entityId, name, area, domain, deviceClass, humanFlag, lastState, lastChangedAt }], nextCursor }` |
| PATCH | `/api/v1/home/devices/:entityId` | 「こわい」の印を付ける・外す：`{ "humanFlag": true }`。`device_class = 'human'` の機器の印は外せない（422 `HOME_CLASS_FIXED`）。監査ログ `home.flag_changed` |
| GET | `/api/v1/home/automations` | 自動化の一覧：`{ items: [{ entityId, name, enabled, createdBy, targets: [{ entityId, name, deviceClass, humanFlag }], touchesHuman, lastTriggeredAt }] }`。`touchesHuman` は印つきの機器に触るもの（画面で赤い印を付ける） |
- 機器の区分（`deviceClass`）は Kernel の規則で決まる（規則の版に入る）。判断モデルや LLM では決めない（BR-16）。「こわい」の印は区分より強くはならない（外せないものは外せない）
- 同期は本体が自動で行う（状態の変化を受ける）。`sync` は画面の [ 読み直す ] 用
- エラー：404 `HOME_DEVICE_NOT_FOUND`、503 `HOME_NOT_CONNECTED`、422 `HA_TOKEN_INVALID`、502 `HA_UNREACHABLE`、422 `HOME_CLASS_FIXED`

### API-114：GET /api/v1/packs
- 概要：置き場（イメージの `/opt/makase/packs/*.json` と、データのボリュームの `/data/packs/*.json`）にあるパックと、入っているパック（`pack_installs`）の一覧
- レスポンス（200）：
<details>
<summary>例</summary>

```json
{
 "installed": [
  { "id": "web-research", "version": 2, "name": "調べもの", "purpose": "Web で調べてまとめる", "agentCount": 3, "installedVersion": 2 }
 ],
 "available": [
  { "id": "code-fix", "version": 1, "name": "コードの修正", "purpose": "リポジトリを VM で動かして直す", "agentCount": 2, "installedVersion": null }
 ]
}
```

</details>

- 置き場の版が `installedVersion` より新しければ、`installed` の中でも更新できる印として `version` が大きく出る

### API-115：POST /api/v1/packs/:packId/install
- 処理：`pack_installs` に記録 → `agents[]` からエージェントを作る → `skills[]` を `agent_skills`（`origin = pack`）に入れる → `browser` の追加分をポリシーに足す
- 更新：同じ `id` が入っていて版が上がっていれば、パックのエージェントの設定を作り直す（持ち主が手で変えた設定は失われる）
- レスポンス（200）：`{ "agentIds": ["0193..."], "updated": true | false }`
- エラー：404 `PACK_NOT_FOUND`、422 `PACK_INVALID`、同じ版がもう入っていれば 409 `PACK_ALREADY_INSTALLED`

### API-116：DELETE /api/v1/packs/:packId
- 処理：パックのエージェントを論理削除する（VM のログインは消さない）。`agent_skills` と `pack_installs` の行を消し、ポリシーに足した `browser` の分を戻す
- エラー：パックのエージェントが動いていれば 409 `AGENT_BUSY`、404 `PACK_NOT_FOUND`

### 内部 API（box-manager）
認証は `Authorization: Bearer <BOX_MANAGER_TOKEN>`。box-manager は ctl ネットワークでだけ待ち受け、box ネットワークでは待ち受けない。パスの `:boxId` は VM の世代（`boxes.id`）で、今の世代と違えば 409 `STALE_CONTROL`。VM の世代は `box-browser` と `box-shell` の 2 つのコンテナの組で、box-manager が一緒に起こし、一緒に止める。画面の操作・スクショ・VNC・ブラウザのデータは `box-browser` の box-agent、コマンドの実行とファイルの出し入れは `box-shell` の shell-agent が受ける。

| ID | メソッド | パス | 概要 |
|---|---|---|---|
| API-101 | POST | `/internal/v1/boxes` | 起こす。2 つのコンテナを一緒に起こす。`{ boxId }` だけを受ける（イメージ・上限・ネットワーク・ボリュームは固定）。戻し・作り直しの印ファイルがある（`failed` を含む）・控えを書いている間は 409 `VM_BUSY`（D-294・D-295）。ホストの空きが 3GB 未満なら 507 `DISK_LOW` |
| API-102 | DELETE | `/internal/v1/boxes/:boxId` | 2 つのコンテナを止める（ボリュームは残す） |
| API-103 | POST | `/internal/v1/boxes/:boxId/actions` | `box-browser` の box-agent に、操作を1つ、確かめてから実行させる |
| API-104 | POST | `/internal/v1/boxes/:boxId/inspect` | `box-browser` で確かめだけ（確認カードを作るとき） |
| API-105 | GET | `/internal/v1/boxes/:boxId/screenshot` | `box-browser` の PNG（1280×800） |
| API-106 | GET（WebSocket） | `/internal/v1/boxes/:boxId/vnc` | `box-browser` の VNC の中継 |
| API-108 | POST・GET・DELETE・PATCH | `/internal/v1/vm/home` | POST `{ operationId, action: "restore" \| "rebuild", snapshotId? }` → 202。停止済みのみ（409 `BOX_RUNNING`）。GET `?operationId=` → `{ operationId, action, status: "running" \| "done" \| "failed" \| "none", startedAt, error }`。DELETE `{ operationId }` は停止確認後failed、PATCH `{ operationId, acknowledge: true }` は結果のACK（204、再送可）。同一ID・引数のPOSTは既存結果、引数違いは409 `OPERATION_CONFLICT`。結果の保持・DB確定・ACK順は FR-100 |
| API-143 | POST・GET・DELETE | `/internal/v1/vm/snapshots`・`/internal/v1/vm/snapshots/:snapshotId` | ホームの控えを取る。2 つのボリュームを 1 つの tar にまとめる（非同期：D-295）。POST `{ snapshotId }` → 202。VM が止まっているときだけ。ホストの空きが「ホームの大きさ＋3GB」未満なら 507 `DISK_LOW`。GET → `{ status: "running" \| "done" \| "failed" \| "unknown", path, sizeBytes }`。DELETE → 打ち切り、書きかけのファイルを消す。控えは控え専用のボリューム（`/snapshots`）に書く（D-309） |
| API-144 | DELETE・GET・PATCH | `/internal/v1/boxes/:boxId/browser-data` | DELETE `{ operationId }` → 202。停止後プロフィール消去。GET `?operationId=` とPATCH ACKはAPI-108と同じ結果保持契約。DELETE `?cancel=true` は打ち切り。起動・控え・復元・消去の共通排他で競合は409 `VM_BUSY`。本体は先に `clearing_browser` を取得（FR-079） |
| API-109 | GET | `/internal/v1/boxes` | 動いている VM の世代（本体の起動のとき、止まっていない世代があれば止めさせる：D-327）と、box-manager が毎分測った値（`homeBytes`・`hostFreeBytes`・`measuredAt`）、box-manager が自分で止めた世代と理由（`disk_quota`・`disk_low`）。本体のタイマーが毎分読む（測るのは box-manager だけ：D-309） |
| API-117 | POST | `/internal/v1/boxes/:boxId/commands` | `box-shell` の shell-agent で、コマンドを1つ実行する。`{ actionId, tool, args, timeoutSec }` → `{ ok, exitCode, output, truncated }`。確かめるのは世代（パスの `boxId`）と `actionId` だけで、`controlEpoch`・画面の番は受けない（交代中も動く：D-258・D-296）。VM の中のコマンドは判定しない（D-178）。`output` は 64KB まで。`actionId` が実行済みなら前の結果を返す。世代が違えば 409 `STALE_CONTROL`、時間切れは `COMMAND_TIMEOUT`、同時に 2 本動いていれば 409 `COMMANDS_FULL`（本体が待って出し直す）。利用者 `agent` で実行する |
| API-118 | PUT・GET | `/internal/v1/boxes/:boxId/files` | `box-shell` の shell-agent で、tar でファイルを入れる（PUT）・取り出す（GET）。`path` クエリで場所を指す（`/home/agent` の下だけ）。リポジトリの出し入れと成果物の写し（D-244）に使う。tar は shell-agent が利用者 `agent` で作る・広げ、シンボリックリンクはたどらない。本体は広げるときにリンク・装置ファイル・絶対パス・`..` を捨てる（D-306） |
| API-113 | PATCH | `/internal/v1/boxes/:boxId/control` | 操作する人と `control_epoch` を `box-browser` の box-agent に伝える。`{ control: "agent"｜"handing_over"｜"human", controlEpoch }`。box-agent はこれ以降、違う `controlEpoch` の画面の操作（API-103）を 409 `STALE_CONTROL` で断る（D-160）。コマンド（API-117）には効かない |

<details>
<summary>API-103 のリクエストと応答の例</summary>

```json
{
 "actionId": "0193...",
 "controlEpoch": 4,
 "action": { "kind": "left_click", "x": 812, "y": 604 },
 "expect": null
}
```

- box-agent は、同じ VM の中では操作を1つずつ実行する。`controlEpoch` が今の値と違えば 409 `STALE_CONTROL`。`actionId` が実行済みなら、前の結果をそのまま返す（2回目は実行しない）
- `screenEpoch` は送らない。画面の番と `screen_epoch` は、本体が頼む前に確かめる（実行の直前の確かめ：FR-075 の 3a。D-299）
- `open_url` は `http`・`https` だけ受ける（`javascript:`・`file:`・`chrome:` などは 400 `VALIDATION_ERROR` で断る：D-158）
- `read_page` は見るだけ。応答の `page` に、見えているボタン・リンク・入力欄・見出しの一覧（`role`・`name`・`center`・入力欄なら `value`）を最大 200 個入れる。秘密の欄の `value` は入れない（D-194）
- `expect` があれば、確かめた中身のハッシュと比べ、違えば実行せずに 409 `CONTENT_CHANGED`
- 応答：`{ "executed": true, "inspect": {...}, "screenshot": "<path>" }`。`inspect` は判定の材料（下）。判定が要る操作は、本体が先に `dryRun: true` で確かめだけを頼み、判定のあとに実行を頼む（そのときは `expect` に確かめたハッシュを入れる）

</details>

<details>
<summary>inspect の結果の例</summary>

```json
{
 "url": "https://example.jp/reserve/confirm",
 "domain": "example.jp",
 "tab": "T1", "frame": "main",
 "target": { "tag": "button", "type": "submit", "autocomplete": null, "role": "button", "name": "予約を確定する", "clickable": true, "editable": false, "inForm": true, "formSubmitName": "予約を確定する", "submitsForm": true, "formMethod": "post", "rect": [760, 588, 104, 32] },
  "form": { "method": "post", "effectiveAction": "https://example.jp/reserve", "fields": [{ "name": "date", "value": "2026-11-03" }, { "name": "card", "valueHash": "sha256:..." }] },
 "contentHash": "sha256:...",
 "resolved": true,
 "unresolvedKind": null
}
```

`clickable` は要素に `cursor: pointer` か click のリスナーがあるとき true。`div` に処理を付けただけの擬似ボタンも T-3 の対象にするため、`clickable` の要素の見えている名前も決まった言葉と照合する（D-173）。

`resolved: false` のときは要素が分からなかった。`unresolvedKind` に種類（`canvas`・`cross_origin_iframe`・`dialog`・`outside`）を入れる。判定は T-6 に当たり、行き先はどれも人（D-297・D-298）。

- `editable`：先が `textarea`・`contenteditable`・文字の入る `input` のとき true（T-4 の行き先に使う）
- `submitsForm`：先が標準のフォームの送信になるか（`type=submit` のボタン・`input[type=submit|image]`・フォームの中の Enter による暗黙の送信）。`formMethod` は送信ボタンの `formmethod`、なければ `form.method`（`get`・`post`・`dialog`、分からなければ null）。`submitsForm` が true で `formMethod` が `get`・`dialog` でなければ T-7（D-298）
- JS で `form.submit()`・`fetch` を呼ぶ要素は、DOM からは分からないので `submitsForm` に入らない（T-7 で拾えない：R-76）
- `effectiveAction` は送信ボタンの `formaction`、なければ `form.action` をブラウザの基準URLで絶対URLに解決したもの（暗黙の送信も実際のsubmitterを反映）。送信なしはnull、送信先不明は実行せず交代。秘密を含むURLや秘密の不在を確認できないURLは返却・保存・ハッシュ化せず交代する。安全と確認したURLはクエリを含む完全な値を確認カードに表示し、`contentHash = sha256(canonicalJson({ action, content, box_id }))` のcontentに含め、実行直前に再取得して比較する。action/formactionだけ変わっても409 `CONTENT_CHANGED`。JS送信の既知の限界とは別の保証（IMP-004）
- 全画像応答（API-103・105・交代終了）はFR-075の撮影前マスクを必須とする。内部の撮影検査は `{ complete, regions: [{ frame, rect }] }`（出力画像の画素座標）を取得し、`complete = false` なら409 `SECRET_REGIONS_UNVERIFIED`、画像・パスなし。秘密入力実行は409 `SECRET_INPUT_REQUIRES_TAKEOVER`。人が安全な画面に直すまで再撮影・AI続行をしない（IMP-002・003）
- 操作の結果GET/ACKは現世代の生存に依存せず操作IDで照合する。ACK済みIDのPOST/消去DELETEを新規受付しない（墓標を保持、409 OPERATION_CONFLICT）。API-101は復元/消去の未ACK結果・running・broken印・控え中をすべてVM_BUSYで断る。

</details>

## このドキュメントで決まったこと
- D-151、D-158〜D-160、D-163、D-173、D-176、D-178、D-194、D-202、D-205、D-215、D-237、v1.2：D-294〜D-296、D-298〜D-300、D-306〜D-309（[00 決定事項ログ](../00_overview.md#決定事項ログ)）
- v1.4：D-316（書き出し・取り込みを消す）、D-319（掃除のための起動を消す）、D-322（`budget` は `daily_usd`・`daily_auto_usd`）、D-323（要約の印を消す）、D-326（2 コンテナ）、D-327（本体の再起動は新しい世代）
- v1.6：D-340・343（`network`）、D-351（`review.auto`）、D-352（`llm`）、D-358（パスキーのログイン）、D-366・369
- v1.7：D-373（保管庫：API-153）、D-374（分類の見積もり）、D-377・378（HA・機器の区分：API-155）、D-379（`classify` の欄）
