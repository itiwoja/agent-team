# 09. API設計：VM・確認・設定の API（v0.6 から引き継ぐ API）
- プロジェクト：Agent-Team-Open ／ 版数：v1.4（2026-10-24） ／ 親：[09 API設計](README.md)

> **3行で**
> 1. VM は 1 台なので、画面向けの VM の API は `/api/v1/vm/*` になった（v0.6 の `/boxes/:boxId`）。控え・戻す・作り直す（API-133〜135）を足した。VM の実体は `box-browser`・`box-shell` の 2 つのコンテナの組で、画面向けの API では 1 つの VM として見せる。
> 2. ブラウザの確認の ○ / × は、API の書き込みの承認（API-019）とは別の口（API-110）。実行は1回だけで、中身が同じときだけ。
> 3. パック・設定・つなぎ方は v0.6 の形のまま、v1.0 の欄を足した。内部 API は [下](#内部-apibox-manager)。

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

### API-133〜135：VM の控え・戻す・作り直す
- GET `/api/v1/vm/snapshots`：`{ items: [{ id, kind, sizeBytes, status, createdAt }] }`
- POST `/api/v1/vm/snapshots`：今すぐ取る。VM を止めてから取る（使っているタスクは `waiting_vm`）→ 202 `{ id }`。終わったら SSE の `vm.updated`
- POST `/api/v1/vm/restore`：`{ "snapshotId" }` → 202 `{ haltedTasks: 2 }`。POST `/api/v1/vm/rebuild` → 202。どちらも VM を使っているタスク（終わっていないタスクのうち VM の道具を一度でも使ったものと画面の番を持つもの）を `halted`（`vm_replaced`）で閉じ、その `pending` の確認を `expired`（`vm_replaced`）にする（D-268・D-308）。`vm_op` が `none` でなければ 409 `VM_BUSY`。`vmHomeState` が `broken` でも受ける
- 処理（FR-100）：画面の番を空にし、VM を止め、API-108 でホームを入れ替える（非同期。本体が終わりを確かめる：D-294）。終わったら SSE の `vm.updated`。監査ログ `vm.restored`・`vm.rebuilt`、失敗は `vm.restore_failed`（`vmHomeState` が `broken` になる）
- 今すぐの控え（POST `/api/v1/vm/snapshots`）は、ホストの空きが「ホームの大きさ＋3GB」に足りなければ 507 `DISK_LOW`（D-300）
- エラー：404 `SNAPSHOT_NOT_FOUND`、交代中は 409 `ALREADY_TAKEN_OVER`

### API-087：GET /api/v1/check
- 概要：確認待ちのもの。今の書き込みのカードに、`kind: "browser"`・`kind: "takeover"`・`kind: "routine"`（ルーチンの提案：API-142）を足す。ブラウザのカードには `taskId`・`taskTitle`・オートレビューが止めた理由（`reviewReason`）を入れる
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
  { "kind": "routine", "proposalId": "0193...", "name": "週次の PR のまとめ", "schedule": "0 9 * * 1", "scheduleText": "毎週月曜 9:00", "prompt": "先週の PR を…", "expiresAt": "2026-10-31T10:00:00Z" }
 ]
}
```

</details>

### API-110：POST /api/v1/browser-checks/:checkId/decision
- リクエスト：`{ "decision": "approve" | "reject" }`
- 処理：1つのトランザクションで `pending → executing`（approve）か `pending → rejected`（reject）に変える。0行なら 409 `CHECK_NOT_PENDING`。approve のときは同じトランザクションで実行の直前の確かめ（FR-075 の 3a：タスクが `awaiting_approval`・VM の世代が同じ・画面の番をそのタスクが持ち `screen_epoch` が確認の `screen_epoch` と同じ・`control = agent`・VM の操作の途中でない）をし、外れたら `expired`（`task_cancelled`・`box_restarted`・`screen_lost`・`taken_over`・`vm_replaced`）にして `expired` を返す（D-250・D-307）。approve なら、その外で API-103 に `actionId` と `expect: contentHash` を付けて頼む
- レスポンス（200）：`{ "result": "executed" | "page_changed" | "rejected" | "expired" | "unknown_outcome", "expireReason": null }`。`expired` のときは `expireReason` に理由（D-307）
- `page_changed`（承認のあと中身が変わっていた）のときは、新しい確認は作らない。確認を `expired`（`page_changed`）にし、Claude に新しいスクショと「画面が変わったので実行しなかった」を返して操作を決め直させる（D-159）

### API-094・095：つなぐ
- API-094：期限 10分・1回限りの `state` を作り、HttpOnly・Secure・SameSite=Lax の Cookie にも入れる。Google は PKCE の `code_challenge` を付ける
- API-095：`state`・Cookie・PKCE（Google）、インストールの ID（GitHub）を確かめる。合わなければ 400 `CONNECT_STATE_INVALID`。使った `state` は消す

### API-096：GET・PATCH /api/v1/settings
- PATCH のボディ：`{ "budget": { "daily_usd": 10, "daily_auto_usd": 7 }, "browser": { "confirmDomains": [...], "skipUnresolvedDomains": [...], "humanWords": [...], "confirmWords": [...], "autoReview": { "enabled": true } }, "maxTasks": 3 }`（部分）
- 副作用：ポリシーの新しい版を作る（`workspace_policies`）。効くのは次のタスク・ターンから（動いているものは始まるときのポリシーのまま）

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
| API-108 | POST・GET・DELETE | `/internal/v1/vm/home` | ホーム（`makase-vm-home` と `makase-browser-profile`）を 2 つ一緒に入れ替える（非同期：D-294）。POST `{ action: "restore", snapshotId }` か `{ action: "rebuild" }` → 202（印ファイルを書いてから裏で入れ替える）。VM が止まっているときだけ（動いていれば 409 `BOX_RUNNING`）。GET → `{ action, status: "running" \| "done" \| "failed" \| "none", startedAt, error }`（印ファイルの中身）。DELETE → 打ち切る（止め切ったら `failed` を返す） |
| API-143 | POST・GET・DELETE | `/internal/v1/vm/snapshots`・`/internal/v1/vm/snapshots/:snapshotId` | ホームの控えを取る。2 つのボリュームを 1 つの tar にまとめる（非同期：D-295）。POST `{ snapshotId }` → 202。VM が止まっているときだけ。ホストの空きが「ホームの大きさ＋3GB」未満なら 507 `DISK_LOW`。GET → `{ status: "running" \| "done" \| "failed" \| "unknown", path, sizeBytes }`。DELETE → 打ち切り、書きかけのファイルを消す。控えは控え専用のボリューム（`/snapshots`）に書く（D-309） |
| API-144 | DELETE | `/internal/v1/boxes/:boxId/browser-data` | 世代を止め、`makase-browser-profile` を空にして、次に起こす（画面の番がないときだけ） |
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
 "form": { "method": "post", "fields": [{ "name": "date", "value": "2026-11-03" }, { "name": "card", "valueHash": "sha256:..." }] },
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

</details>

## このドキュメントで決まったこと
- D-151、D-158〜D-160、D-163、D-173、D-176、D-178、D-194、D-202、D-205、D-215、D-237、v1.2：D-294〜D-296、D-298〜D-300、D-306〜D-309（[00 決定事項ログ](../00_overview.md#決定事項ログ)）
- v1.4：D-316（書き出し・取り込みを消す）、D-319（掃除のための起動を消す）、D-322（`budget` は `daily_usd`・`daily_auto_usd`）、D-323（要約の印を消す）、D-326（2 コンテナ）、D-327（本体の再起動は新しい世代）
