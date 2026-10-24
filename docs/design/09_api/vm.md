# 09. API設計：VM・確認・設定の API（v0.6 から引き継ぐ API）
- プロジェクト：Agent-Team-Open ／ 版数：v1.1（2026-10-24） ／ 親：[09 API設計](README.md)

> **3行で**
> 1. VM は 1 台なので、画面向けの VM の API は `/api/v1/vm/*` になった（v0.6 の `/boxes/:boxId`）。控え・戻す・作り直す（API-133〜135）を足した。
> 2. ブラウザの確認の ○ / × は、API の書き込みの承認（API-019）とは別の口（API-110）。実行は1回だけで、中身が同じときだけ。
> 3. パック・設定・引っ越し・つなぎ方は v0.6 の形のまま、v1.0 の欄を足した。内部 API は [下](#内部-apibox-manager)。

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
 "homeBytes": 1834000000, "profileBytes": 210000000,
 "lastSnapshot": { "id": "0193...", "createdAt": "2026-10-24T04:00:00+09:00" }
}
```

</details>

- 眠っているときは `status: "stopped"` と最後のスクショ

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
- POST `/api/v1/vm/restore`：`{ "snapshotId" }` → 202 `{ haltedTasks: 2 }`。POST `/api/v1/vm/rebuild` → 202。どちらも VM を使っているタスクを `halted`（`vm_replaced`）で閉じる（D-268）。`vm_op` が `none` でなければ 409 `VM_BUSY`
- 処理（FR-100）：画面の番を空にし、VM を止め、API-108 でホームを入れ替える。監査ログ `vm.restored`・`vm.rebuilt`
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
- 処理：1つのトランザクションで `pending → executing`（approve）か `pending → rejected`（reject）に変える。0行なら 409 `CHECK_NOT_PENDING`。approve のときは同じトランザクションで、タスクが `awaiting_approval`・VM の世代が同じ・画面の番をそのタスクが持っている・`screen_epoch` が同じことを確かめ、違えば `expired`（`task_cancelled`・`box_restarted`・`screen_lost`）にして `rejected` を返す（D-250）。approve なら、その外で API-103 に `actionId` と `expect: contentHash` を付けて頼む
- レスポンス（200）：`{ "result": "executed" | "page_changed" | "rejected" | "unknown_outcome" }`
- `page_changed`（承認のあと中身が変わっていた）のときは、新しい確認は作らない。確認を `expired`（`page_changed`）にし、Claude に新しいスクショと「画面が変わったので実行しなかった」を返して操作を決め直させる（D-159）

### API-094・095：つなぐ
- API-094：期限 10分・1回限りの `state` を作り、HttpOnly・Secure・SameSite=Lax の Cookie にも入れる。Google は PKCE の `code_challenge` を付ける
- API-095：`state`・Cookie・PKCE（Google）、インストールの ID（GitHub）を確かめる。合わなければ 400 `CONNECT_STATE_INVALID`。使った `state` は消す

### API-096：GET・PATCH /api/v1/settings
- PATCH のボディ：`{ "budget": {...}, "browser": { "confirmDomains": [...], "skipUnresolvedDomains": [...], "humanWords": [...], "confirmWords": [...], "autoReview": { "enabled": true } }, "maxTasks": 3 }`（部分）
- 副作用：ポリシーの新しい版を作る（`workspace_policies`）。効くのは次のタスク・ターンから（動いているものは始まるときのポリシーのまま）

### API-097・098：書き出し・取り込み
- 書き出しの形：`{ "formatVersion": 2, "exportedAt": "...", "agents": [...], "skills": [...], "policy": { "budget": {...}, "browser": {...}, "terminal": {...} }, "memoryFacts": [...], "routines": [...] }`（D-239。`formatVersion` 1 も取り込める）
- 取り込みの応答：`{ "imported": ["..."], "skipped": [{ "name": "...", "reason": "same_name" }] }`

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
認証は `Authorization: Bearer <BOX_MANAGER_TOKEN>`。box-manager は ctl ネットワークでだけ待ち受け、box ネットワークでは待ち受けない。パスの `:boxId` は VM の世代（`boxes.id`）で、今の世代と違えば 409 `STALE_CONTROL`。

| ID | メソッド | パス | 概要 |
|---|---|---|---|
| API-101 | POST | `/internal/v1/boxes` | 起こす。`{ boxId }` だけを受ける（イメージ・上限・ネットワーク・ホームのボリュームは固定）。戻し・作り直しの印ファイルがあれば 409 `VM_BUSY` |
| API-102 | DELETE | `/internal/v1/boxes/:boxId` | 止める（ホームのボリュームは残す） |
| API-103 | POST | `/internal/v1/boxes/:boxId/actions` | 操作を1つ、確かめてから実行する |
| API-104 | POST | `/internal/v1/boxes/:boxId/inspect` | 確かめだけ（確認カードを作るとき） |
| API-105 | GET | `/internal/v1/boxes/:boxId/screenshot` | PNG（1280×800） |
| API-106 | GET（WebSocket） | `/internal/v1/boxes/:boxId/vnc` | VNC の中継 |
| API-108 | POST | `/internal/v1/vm/home` | ホームを入れ替える。`{ action: "restore", snapshotId }` か `{ action: "rebuild" }`。VM が止まっているときだけ（動いていれば 409 `BOX_RUNNING`） |
| API-143 | POST | `/internal/v1/vm/snapshots` | ホームの控えを取る。`{ snapshotId }` → `{ path, sizeBytes }`。VM が止まっているときだけ |
| API-144 | DELETE | `/internal/v1/boxes/:boxId/browser-data` | Chromium を止めてプロフィールのフォルダを消し、起こし直す（画面の番がないときだけ） |
| API-109 | GET | `/internal/v1/boxes` | 動いている VM の世代（本体の起動のときの突き合わせ。2 つ以上あれば全部止める） |
| API-117 | POST | `/internal/v1/boxes/:boxId/commands` | VM でコマンドを1つ実行する。`{ actionId, controlEpoch, tool, args, timeoutSec }` → `{ ok, exitCode, output, truncated }`。VM の中のコマンドは判定しない（D-178）。`output` は 64KB まで。`actionId` が実行済みなら前の結果を返す。古い `controlEpoch` は 409 `STALE_CONTROL`、時間切れは `COMMAND_TIMEOUT`、同時に 2 本動いていれば 409 `COMMANDS_FULL`（本体が待って出し直す）。利用者 `agent` で実行する（D-216） |
| API-118 | PUT・GET | `/internal/v1/boxes/:boxId/files` | tar でファイルを入れる（PUT）・取り出す（GET）。`path` クエリで場所を指す。リポジトリの出し入れに使う |
| API-113 | PATCH | `/internal/v1/boxes/:boxId/control` | 操作する人と `control_epoch` を VM に伝える。`{ control: "agent"｜"handing_over"｜"human", controlEpoch }`。box-agent はこれ以降、違う `controlEpoch` の操作を 409 `STALE_CONTROL` で断る（D-160） |

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
 "target": { "tag": "button", "type": "submit", "autocomplete": null, "role": "button", "name": "予約を確定する", "clickable": true, "inForm": true, "formSubmitName": "予約を確定する", "rect": [760, 588, 104, 32] },
 "form": { "fields": [{ "name": "date", "value": "2026-11-03" }, { "name": "card", "valueHash": "sha256:..." }] },
 "contentHash": "sha256:...",
 "resolved": true
}
```

`clickable` は要素に `cursor: pointer` か click のリスナーがあるとき true。`div` に処理を付けただけの擬似ボタンも T-3 の対象にするため、`clickable` の要素の見えている名前も決まった言葉と照合する（D-173）。

`resolved: false` のときは要素が分からなかった（canvas・ほかの出どころの iframe・JS のダイアログ）。判定は T-6 に当たる。

</details>

## このドキュメントで決まったこと
- D-151、D-158〜D-160、D-163、D-173、D-176、D-178、D-194、D-202、D-205、D-215、D-216、D-237、D-239（[00 決定事項ログ](../00_overview.md#決定事項ログ)）
