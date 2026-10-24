# 09. API設計：常駐の API（v1.0 で足す API）
- プロジェクト：Agent-Team-Open ／ 版数：v1.3（2026-10-24） ／ 親：[09 API設計](README.md)

> **3行で**
> 1. チャットは送る（API-119）・読む（API-120）の 2 つ。送ったメッセージはきっかけになり、返事があるかはメインが決めるので、API-119 は受けたことだけを返す。
> 2. タスクは見る・言い直す（API-122〜124）。きっかけはルーチン・予約・受け口の CRUD と、公開の webhook の口（API-129）。
> 3. 記憶はプロフィールとログを見て直す（API-130〜132・141）。

---

### API-119：POST /api/v1/messages
- リクエスト：ヘッダー `Idempotency-Key: <UUIDv7>`（画面が作ったメッセージの ID）。ボディ：
<details>
<summary>例</summary>

```json
{ "kind": "text", "text": "木曜 19 時に 4 人で入れる店を 3 つ探して" }
{ "kind": "text", "text": "1 番を予約", "replyTo": "0193...", "choice": 0 }
```

</details>

- 処理：`chat_messages` に `role = 'owner'` で入れ、同じトランザクションできっかけ（`origin = 'chat'`、`source_key = chat:<messageId>`。D-261）を入れる。ルーターに知らせる（FR-090）
- レスポンス（202）：`{ "id": "0193...", "createdAt": "..." }`。同じ `Idempotency-Key` の 2 回目は 1 回目の応答を返す
- 選択肢への返事は `kind = text`＋`replyTo`＋`choice`（何番目か）で送り、`chat_messages` には `kind = 'text'`・`reply_to` で入れる（D-274）
- エラー：422 `VALIDATION_ERROR`（4,000 字を超えた・`choice` が選択肢にない）

### API-120：GET /api/v1/messages
- クエリ：`?before=<messageId>&limit=50`
- レスポンス（200）：
<details>
<summary>例</summary>

```json
{
 "items": [
  { "id": "0193...", "role": "owner", "kind": "text", "body": { "text": "..." }, "reactions": ["♥"], "createdAt": "..." },
  { "id": "0193...", "role": "main", "kind": "choices", "body": { "text": "どれにしますか", "choices": ["1 番を予約", "2 番", "やめる"] }, "chosen": null, "createdAt": "..." },
  { "id": "0193...", "role": "main", "kind": "file", "body": { "name": "店の比較.html", "url": "/api/v1/files/0193.../店の比較.html", "sizeBytes": 12034 }, "createdAt": "..." }
 ],
 "mainState": "sleeping",
 "summaryTainted": false,
 "nextBefore": "0193..."
}
```

</details>

- `reaction` の行は単独では返さず、先のメッセージの `reactions` に入れる。`mainState` は `sleeping`・`running`。`summaryTainted` はメインの今の先頭（`context_snapshots`）が `tainted = 1` で `untainted_at` が空のとき `true`。画面は「外の印あり」を出し、押すと SCR-025 の要約の欄へ行く（D-311）。確認のカード（API-087・019 の応答の `summaryTainted`）も同じ規則で、そのターンの先頭が今の先頭のままのときだけ `true`

### API-121：POST /api/v1/presence
- リクエスト：`{ "deviceId": "...", "visible": true, "typing": true }`（`deviceId` は PWA が初回に作って持つ UUID。ほかは任意）
- 処理（D-269）：画面は前に出ている間、30 秒ごとに `visible: true` を送り、隠れたら `visible: false` を送る。本体は端末ごとに最後の心拍を覚え、60 秒以内の心拍があり、その端末の SSE がつながっていれば「見えている」とする（Web Push を送るかの判断：FR-017）。`typing` はメインが眠っていれば先温め（FR-098。5 分に 1 回まで、Should）
- レスポンス：204

### API-122：GET /api/v1/tasks
- クエリ：`?status=active|done&cursor=&limit=`
- レスポンス（200）：`{ "items": [{ "id", "title", "agent": { "id", "name" }, "status", "statusDetail", "origin", "createdAt", "finishedAt", "costMicroUsd" }], "nextCursor": "..." }`。`active` は終わっていないもの（`finished_at IS NULL`。`succeeded`・`completed`・`rejected`・`failed`・`cancelled`・`halted` 以外）、`done` はその逆

### API-123：GET /api/v1/tasks/:taskId
- レスポンス（200）：
<details>
<summary>例</summary>

```json
{
 "id": "0193...", "title": "店探し", "status": "running", "statusDetail": "waiting_screen",
 "agent": { "id": "0193...", "name": "店探し係" },
 "brief": "木曜 19 時・4 人・新宿。空きを確かめ、3 つに絞る。予約はしない",
 "delegateReason": "飲食店の予約サイトを扱えるため",
 "origin": "delegate", "turnId": "0193...", "tainted": true,
 "steps": [{ "key": "llm:3", "summary": "空きのページを開いた", "at": "..." }],
 "browser": { "hasScreen": false, "actions": 42, "maxActions": 300, "lastShotUrl": "/api/v1/shots/..." },
 "terminal": [{ "tool": "run_command", "args": { "command": "npm test" }, "ok": true, "output": "...", "at": "..." }],
 "autoReviews": [{ "actionId": "0193...", "verdict": "pass", "reason": "検索の確定。外に出ない", "costMicroUsd": 1200 }],
 "report": null, "artifacts": [], "costMicroUsd": 412000
}
```

</details>

- `steps` は `task_steps` と `task_events` から作る（パックの手順書ごとに区切る：R-86）

### API-124：POST /api/v1/tasks/:taskId/steer
- リクエスト：`{ "text": "やっぱり 20 時でもいい" }`（2,000 字まで）。`Idempotency-Key` を受ける
- 処理：きっかけ `steer`（`target_kind = 'task'`、`source_key = steer:<Idempotency-Key>`。D-261）を入れる。タスクの次の歩みの頭に入る（FR-089）
- レスポンス：202。エラー：409 `TASK_NOT_ACTIVE`

### API-125・126：ルーチン
- POST `/api/v1/routines`：`{ "name", "prompt", "schedule": "0 8 * * 1-5", "tz": "Asia/Tokyo", "agentId": null }` → 201 `{ id, nextRunAt, scheduleText }`。エラー：409 `ROUTINE_LIMIT`、422 `SCHEDULE_INVALID`
- PATCH `/api/v1/routines/:routineId`：同じ欄の一部と `enabled`。`schedule` を変えたら `nextRunAt` を計算し直す
- DELETE：行を消す（監査ログに残す）
- GET の一覧：`{ items: [{ id, name, schedule, scheduleText, nextRunAt, lastRunAt, enabled, agent, createdBy }] }`

### API-142：POST /api/v1/routine-proposals/:proposalId/decision
- リクエスト：`{ "decision": "approve" | "reject" }`
- 処理：`pending` のときだけ。approve なら `routines` に行を作る（`created_by = 'main'`、提案の `tainted` を引き継ぐ）。メインは起こさず、`memory_log` に 1 行書く（次のターンで分かる。D-274）
- エラー：409 `CHECK_NOT_PENDING`、409 `ROUTINE_LIMIT`

### API-128：GET・POST /api/v1/webhooks
- POST：`{ "kind": "github" | "generic", "name", "note" }` → 201：
<details>
<summary>例</summary>

```json
{ "id": "k3q7...", "url": "https://makase.example.ts.net:8443/hooks/k3q7...", "secret": "whsec_...", "funnel": "on" }
```

</details>

- `secret` はこの応答でだけ返す（あとから見る方法はない。忘れたら作り直す）。`funnel` は `on`・`off`（tailnet で許されていない）。`off` のときも受け口は作るが、画面に案内を出す
- GET：`{ items: [{ id, kind, name, note, enabled, lastDeliveryAt, deliveryCount }] }`（秘密は返さない）

### API-129：POST /hooks/:hookId
- 待ち受け：:8081 だけ。外からは Funnel の 8443 番だけが届く（FR-073・ADR-065・D-241）。Tailscale の身元は見ない
- 処理：FR-096 の 1〜5。順番は「大きさ → 受け口 → 署名（`generic` は時刻も）→ 重複 → 件数（1 分の上限を超えたらまとめに足す）→ きっかけ」
- レスポンス：202（受けた・重複・まとめに足した）。エラー：404 `HOOK_NOT_FOUND`・401 `HOOK_SIGNATURE_INVALID`・429 `HOOK_RATE_LIMITED`（1 時間 600 件を超えた）・413 `PAYLOAD_TOO_LARGE`。エラーの本文は `{ "error": { "code": "..." } }` だけ（中のことを漏らさない）
- 署名が合わないものは記録にも本文を残さない（件数だけ `audit_logs` の `webhook.rejected` に 1 分ごとにまとめる）

### API-130〜132・141・147：記憶
- GET `/api/v1/memory?q=&tab=facts|log&cursor=`：
<details>
<summary>例</summary>

```json
{
 "facts": { "items": [{ "id": "0193...", "text": "告知ページは明るい色、絵文字なし", "rank": 3.2, "source": "main", "updatedAt": "..." }], "count": 42, "chars": 1830, "maxCount": 100, "maxChars": 4000 },
 "summary": { "snapshotId": "0193...", "text": "…", "createdAt": "...", "tainted": true, "taintSources": ["webhook"], "untaintedAt": null },
 "log": { "items": [{ "id": "0193...", "day": "2026-10-23", "text": "店探しのタスクで 3 件見つけた", "source": "system", "ref": "0193..." }], "nextCursor": "..." }
}
```

</details>

- POST `/api/v1/memory/facts`：`{ "text" }`（200 字まで）→ 201。`source = 'owner'`。エラー：409 `MEMORY_FULL`
- PATCH `/api/v1/memory/facts/:factId`：`{ "text" }`。DELETE：`deleted_at` を入れる
- DELETE `/api/v1/memory/log/:logId`：行と検索の行を消す
- POST `/api/v1/memory/summary/:snapshotId/untaint`（API-147）：今の先頭の印を消す（D-310）。→ 200 `{ "untaintedAt" }`。エラー：409 `TURN_RUNNING`（メインのターンが動いている）・409 `SNAPSHOT_NOT_CURRENT`（今の先頭でない）・409 `NOT_TAINTED`。監査ログ `memory.untainted`
- どれも監査ログ `memory.changed` を残し、SSE の `memory.updated` を出す。持ち主が変えた記憶は、次の要約まで先頭（④）を変えず、メインの次の `user` メッセージに「（本体から：持ち主が記憶を直した：…）」の枠で足す（FR-098・D-286）

## このドキュメントで決まったこと
- D-196、D-212、D-220〜D-225、D-233、D-234、D-261、D-286、D-310、D-311（[00 決定事項ログ](../00_overview.md#決定事項ログ)）
