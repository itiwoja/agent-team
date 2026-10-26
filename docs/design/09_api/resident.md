# 09. API設計：常駐の API（v1.0 で足す API）
- プロジェクト：Agent-Team-Open ／ 版数：v1.7（2026-10-26） ／ 親：[09 API設計](README.md)

> **3行で**
> 1. チャットは送る（API-119）・読む（API-120）の 2 つ。送ったメッセージはきっかけになり、返事があるかはメインが決めるので、API-119 は受けたことだけを返す。
> 2. タスクは見る・言い直す（API-122〜124）。きっかけはルーチン・予約・受け口の CRUD と、公開の webhook の口（API-129）。
> 3. 記憶はプロフィールを見て直す（API-130・131・141）。v1.6 で、外に出た通信（API-148）・判定の規則（API-149）・判定の再実行（API-150）・監査ログの検査（API-151）・モデル（API-152）を足した。v1.7 で、家計簿（API-154）・チャットの添付（API-156）・初回設定（API-157）を足した。

---

### API-119：POST /api/v1/messages
- リクエスト：ヘッダー `Idempotency-Key: <UUIDv7>`（画面が作ったメッセージの ID）。ボディ：
<details>
<summary>例</summary>

```json
{ "kind": "text", "text": "木曜 19 時に 4 人で入れる店を 3 つ探して" }
{ "kind": "text", "text": "1 番を予約", "replyTo": "0193...", "choice": 0 }
{ "kind": "text", "text": "このレシートを家計簿に入れて", "attachmentIds": ["0193...", "0193..."] }
```

</details>

- 処理：`chat_messages` に `role = 'owner'` で入れ、同じトランザクションできっかけ（`origin = 'chat'`、`source_key = chat:<messageId>`。D-261）を入れる。ルーターに知らせる（FR-090）。メインのターンが動いている間に届いたものは `queued` のままで、ターンが終わったら次のターンで扱う（D-324）
- レスポンス（202）：`{ "id": "0193...", "createdAt": "..." }`。同じ `Idempotency-Key` の 2 回目は 1 回目の応答を返す
- 選択肢への返事は `kind = text`＋`replyTo`＋`choice`（何番目か）で送り、`chat_messages` には `kind = 'text'`・`reply_to` で入れる（D-274）
- v1.7：`attachmentIds` は API-156 で上げた添付の ID（10 個まで）。そのメッセージに付けて（`chat_attachments.message_id`）、汚染の印つきでメインに渡す。本文が空でも、添付があれば送れる
- エラー：422 `VALIDATION_ERROR`（4,000 字を超えた・`choice` が選択肢にない・`attachmentIds` が 11 個以上・他のメッセージに付いている・24 時間を過ぎている）

### API-120：GET /api/v1/messages
- クエリ：`?before=<messageId>&limit=50`
- レスポンス（200）：
<details>
<summary>例</summary>

```json
{
 "items": [
  { "id": "0193...", "role": "owner", "kind": "text", "body": { "text": "..." }, "createdAt": "..." },
  { "id": "0193...", "role": "main", "kind": "choices", "body": { "text": "どれにしますか", "choices": ["1 番を予約", "2 番", "やめる"] }, "chosen": null, "createdAt": "..." },
  { "id": "0193...", "role": "main", "kind": "file", "body": { "name": "店の比較.html", "url": "/api/v1/files/0193.../店の比較.html", "sizeBytes": 12034 }, "createdAt": "..." }
 ],
 "mainState": "sleeping",
 "nextBefore": "0193..."
}
```

</details>

- `mainState` は `sleeping`・`running`

### API-121：POST /api/v1/presence
- リクエスト：`{ "deviceId": "...", "visible": true }`（`deviceId` は PWA が初回に作って持つ UUID）
- 処理：画面は前に出ている間、30 秒ごとに `visible: true` を送り、隠れたら `visible: false` を送る。本体は端末ごとに最後の心拍を覚え、60 秒以内の心拍があり、その端末の SSE がつながっていれば「見えている」とする（Web Push を送るかの判断：FR-017。心拍だけで、入力中の合図としては使わない）
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

- `autoReviews` は、オートレビューを入れたとき（`review.auto.enabled = true`）だけ中身が入る。切（既定）のときは空の配列（v1.6：D-351）
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
- 処理：`pending` のときだけ。approve なら `routines` に行を作る（`created_by = 'main'`、提案の `tainted` を引き継ぐ）。メインは起こさない
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
- 処理：FR-096 の 1〜5。順番は「大きさ → 受け口 → 署名（`generic` は時刻も）→ 重複（配達 ID だけ）→ 件数（1 分 60 件を超えたら 429 で何も残さない）→ きっかけ」
- レスポンス：202（受けた・重複）。エラー：404 `HOOK_NOT_FOUND`・401 `HOOK_SIGNATURE_INVALID`・429 `HOOK_RATE_LIMITED`（1 分 60 件を超えた）・413 `PAYLOAD_TOO_LARGE`。エラーの本文は `{ "error": { "code": "..." } }` だけ（中のことを漏らさない）
- 署名が合わないものは記録にも本文を残さない（件数だけ `audit_logs` の `webhook.rejected` に 1 分ごとにまとめる）

### API-130・131・141：記憶
- GET `/api/v1/memory?q=`（プロフィール。`q` があれば検索）：
<details>
<summary>例</summary>

```json
{
 "facts": { "items": [{ "id": "0193...", "text": "告知ページは明るい色、絵文字なし", "rank": 3.2, "source": "main", "updatedAt": "..." }], "count": 42, "chars": 1830, "maxCount": 100, "maxChars": 4000 }
}
```

</details>

- POST `/api/v1/memory/facts`：`{ "text" }`（200 字まで）→ 201。`source = 'owner'`。エラー：409 `MEMORY_FULL`
- PATCH `/api/v1/memory/facts/:factId`：`{ "text" }`。DELETE：`deleted_at` を入れる
- どれも監査ログ `memory.changed` を残し、SSE の `memory.updated` を出す。持ち主が変えた記憶は、次の要約まで先頭（④）を変えず、メインの次の `user` メッセージに「（本体から：持ち主が記憶を直した：…）」の枠で足す（FR-098・D-286）

### API-148：GET /api/v1/egress・/api/v1/egress.csv
外に出た通信の台帳（TBL-056。FR-103・SCR-027）。見るだけ。
- GET `/api/v1/egress?from=&to=&purpose=&decision=&source=&host=&kind=&cursor=&limit=`（`from`・`to` は日付。既定は直近 7 日。`limit` 既定 20・最大 100）
- 200：

<details>
<summary>例</summary>

```json
{
 "mode": "closed",
 "outsideAllowlist": { "count": 0, "checkedAt": "2026-10-26T00:00:00Z", "latestEventIds": [] },
 "totals": { "allow": 134, "deny": 3, "gapCount": 0 },
 "daily": [{ "day": "2026-10-26", "requests": 41, "bytesOut": 120394, "bytesIn": 2034112, "inputTokens": 88120, "outputTokens": 4210 }],
 "byHost": [{ "host": "api.anthropic.com", "requests": 120, "bytesOut": 1800000, "bytesIn": 300000 }],
 "byPurpose": [{ "purpose": "llm", "requests": 120 }],
 "events": { "items": [{ "id": "0193...", "occurredAt": "...", "source": "vm_browser", "host": "evil.test", "port": 443, "purpose": "browser", "decision": "deny", "denyReason": "not_in_allowlist" }], "nextCursor": null },
 "gap": { "count": 0, "since": null }
}
```

</details>

- `daily`・`byHost`・`byPurpose`・`totals` は `egress_daily`（無期限）から数える。`events` は `egress_events`（90 日）。期間が 90 日より前に及ぶときは、`events` を返さず `eventsAvailableFrom` を返す
- `outsideAllowlist` は `mode = 'closed'` のときだけ入る。`decision = 'allow'` かつ `in_allowlist = 0` の件数（0 のはず）。0 でなければ最新の 3 件の ID を `latestEventIds` に入れる
- `gap` は台帳に書けず欠けた件数（`kind = 'gap'`。D-360）。0 でなければ画面は状態欄に出す
- GET `/api/v1/egress.csv`：同じ絞り込みで `events` をそのまま CSV にする（列は `occurred_at,source,host,port,purpose,decision,deny_reason,bytes_out,bytes_in,llm_role,llm_model,input_tokens,output_tokens`）。`Content-Disposition: attachment`。最大 10 万行（超えたら 413 `PAYLOAD_TOO_LARGE`）。セルが `=`・`+`・`-`・`@` で始まるときは先頭に `'` を付ける。`?view=daily` で `egress_daily` を書き出す（期間の制限なし）
- エラー：400 `VALIDATION_ERROR`（日付・目的の値）。持ち主以外は 403 `NOT_OWNER`
- 中身（本文・URL のパス）は台帳にないので、返さない

### API-149：/api/v1/policy
判定の規則の版・試験・試し当て・保存・書き出し・取り込み（TBL-057。FR-104・105・SCR-028）。規則の本文は `browser`・`terminal`・`network`・`review.auto.enabled` と行き先の表（D-369）。
| メソッド | パス | 中身 |
|---|---|---|
| GET | `/api/v1/policy` | 今の版：`{ version, sha256, body, tests, changedBy, reason, createdAt }` |
| GET | `/api/v1/policy/versions?cursor=&limit=` | 版の一覧（新しい順）。本文は含めない |
| GET | `/api/v1/policy/versions/:version` | 1 つの版（`body`・`tests`・`replaySummary` を含む） |
| GET | `/api/v1/policy/diff?from=&to=` | 二つの版の違い：`{ added: [...], removed: [...] }`（キーの道筋と値） |
| POST | `/api/v1/policy/test` | `{ body, tests? }` を試験にかける（保存しない）。`tests` を省くと今の版の試験を使う。200：`{ passed, failed, results: [{ index, expect, actual, ok }] }` |
| POST | `/api/v1/policy/replay` | `{ body, days?: 30 }`。新しい本文を過去の判定（`verdict_input` のある行）に当てる。200：`{ total, changed, examples: [{ id, before, after }] }`（`before`・`after` は `allow`・`human`・`deny`）。保存しない |
| PUT | `/api/v1/policy` | 保存。`{ body, tests, reason, expectedSha256 }`。試験が全部通ったときだけ、1 つのトランザクションで `policy_versions` の行 → `workspace_policies` の今の欄 → 監査ログ `policy.changed` を書く。200：`{ version, sha256, unchanged }`（中身が今の版と同じなら新しい版を作らず `unchanged: true`） |
| GET | `/api/v1/policy/export` | `policy.json` をダウンロード：`{ schema: 1, version, sha256, body, tests }` |
| POST | `/api/v1/policy/import` | `{ policy, reason, dryRun?: boolean }`。形を確かめ、試験と試し当てを通す。`dryRun` ならその結果だけ返す。そうでなければ PUT と同じ手順で保存（`changed_by = 'import'`。監査ログ `policy.imported`） |
- 効くのは次のタスク・ターンから。動いているものは始まるときの版のまま（FR-104）
- 試験の `input` は作動の入力（正規化した作動・確かめた中身）、`expect` は `allow`・`human`・`deny`。判定の関数は純粋（時刻・乱数・LLM・ネットワークを使わない。時刻は入力に入れる：D-349）なので、試験と試し当ては何度やっても同じ結果になる
- 保存の前に画面は `/policy/replay` の結果（行き先が変わる件数）を見せる。API-096 の PATCH で `browser`・`terminal`・`network`・`review.auto.enabled` を変えたときも、内部で同じ手順（試験 → 版を足す）を通る
- エラー：422 `POLICY_INVALID`（形が違う・知らないキー・`network.allow_hosts` の形）、422 `POLICY_TESTS_FAILED`（`details` に外れた例）、409 `POLICY_CONFLICT`（`expectedSha256` が今の版と違う）、404 `POLICY_VERSION_NOT_FOUND`、413 `PAYLOAD_TOO_LARGE`（取り込みは 1MB まで）

### API-150：POST /api/v1/verdicts/:id/replay
保存した判定の入力（`verdict_input`）で、同じ結果になるか確かめる（FR-105。D-349）。`:id` は `browser_actions.id`（`browser_checks` の判定は元の `browser_actions` の ID で指す）。
- リクエスト：ボディなし（または `{ "policySha256"?: "..." }`。省くと、その判定が使った版）
- 処理：`policy_versions` のその版の `body` と `verdict_input` を Kernel の判定の関数に渡し、行き先を計算し直す。何も書き換えない（読み取りだけ）
- 200：`{ id, policySha256, original: { verdict, decidedBy, destination }, replay: { destination, tripwires }, same }`。`destination` は `allow`・`human`・`deny`（`verdict` の `allowed` → `allow`、`reviewed`・`checked` → `human`）。`same` が `false` のときは、不具合として監査ログの「検査」に出す
- `policySha256` を別の版にすると、その版ならどうなったかを返す（`same` は元の判定との比較）
- エラー：404 `VERDICT_NOT_FOUND`、409 `VERDICT_NOT_REPLAYABLE`（v1.6 より前の行で `verdict_input` が NULL）、404 `POLICY_VERSION_NOT_FOUND`
- 判定のうち、人が決めた部分（○ / ×）やオートレビュー（`decided_by` が `human`・`llm_review`）は再実行の対象外。再実行するのは Kernel が決めた行き先だけ

### API-151：POST /api/v1/audit/verify・GET /api/v1/audit/anchors
監査ログの鎖（`prev_hash`・`row_hash`）を検査する（FR-106・NFR-091。D-350）。
- POST `/api/v1/audit/verify`：`{ "from"?: "<audit id か 日付>" }`（省くと全行）。先頭から 1 行ずつ `row_hash` と `prev_hash` を計算し直して比べ、`audit_anchors` の `row_hash` とも合わせる。200：
 ```json
 { "ok": true, "checkedRows": 1002345, "anchorsChecked": 120, "durationMs": 41200, "verifiedAt": "2026-10-26T01:00:00Z", "firstBroken": null }
 ```
 外れたときは `ok: false`・`firstBroken: { "auditId": "...", "kind": "row_hash" | "prev_hash" | "missing_row" | "anchor_mismatch" }`（最初に切れた行）。結果は監査ログ `audit.verified`（外れたときは `audit.chain_broken` も）に書き、問題がなければ `audit_anchors.verified_at` を更新する。毎日の 0 時（先頭の記録のあと）にも自動で走る
- 検査は読み取り（SQLite の読み取り）で行い、書き込みを止めない。長いので、同時には 1 本だけ（動いている間は 409 `AUDIT_BUSY`）
- GET `/api/v1/audit/anchors?from=&to=&limit=`：毎日の先頭のハッシュ。200：`{ "items": [{ "day", "lastAuditId", "rowHash", "rowCount", "createdAt", "exportedAt", "verifiedAt" }], "nextCursor" }`。`?format=csv` で CSV
- POST `/api/v1/audit/anchors/export`：`{ "from"?, "to"? }`。同じ内容をファイル（JSON）で返し、`exported_at` を入れる（GET は状態を変えないため、書き出しは POST）
- root を取られたら、外に控えた先頭のハッシュより後しか守れない（R-103）。外に控える手順は運用に書く
- エラー：409 `AUDIT_BUSY`、400 `VALIDATION_ERROR`

### API-152：/api/v1/llm/models・/api/v1/llm/roles
役割ごとのモデルとモデルの一覧（TBL-059・`workspace_policies.llm`。FR-107・108・SCR-029）。
| メソッド | パス | 中身 |
|---|---|---|
| GET | `/api/v1/llm/models` | モデルの一覧：`{ items: [{ id, provider, model, baseUrl, caps: { tools, vision, computerUse, contextTokens, promptCache }, price: { inputMicroUsd, outputMicroUsd, cacheReadMicroUsd, cacheWriteMicroUsd, cacheWrite1hMicroUsd }, origin, usable }] }`。`usable` は単価が入っているか |
| POST | `/api/v1/llm/models` | 足す。`{ provider, model, baseUrl?, caps, price }`。ローカルは単価に 0 を明示する |
| PATCH | `/api/v1/llm/models/:id` | 能力・単価を直す。割り当て済みの役割が能力を満たさなくなる直しは 422 |
| DELETE | `/api/v1/llm/models/:id` | 消す。役割に割り当て済みなら 409 `LLM_MODEL_IN_USE` |
| GET | `/api/v1/llm/roles` | 役割ごとの割り当てと候補：`{ roles: { main: { provider, model, status }, worker, computer, review, summary, classify }, experimentalGenericComputer, candidates: { main: [{ modelId, selectable, reason }] } }`。`reason` は選べない理由（`tools_required`・`vision_required`・`computer_use_required`・`price_missing`・`generic_not_enabled`・`host_not_allowed`） |
| PUT | `/api/v1/llm/roles` | 割り当てる。`{ roles: { main?: { provider, model }, ... }, experimentalGenericComputer?: boolean }`（部分）。能力と単価を照合してから、同じトランザクションで `workspace_policies.llm` を書き、監査ログ `llm.role_changed` を残す |
- v1.7（D-385）：`provider` に `openai_chatgpt` を足す。モデルは固定せず、サインインしたあとにトークンで一覧を取って写す。`caps.tools` だけ `true`、`vision`・`computerUse` は確かめるまで `false`（D-390。`computer` には選べない）。`price` は 0 を明示（費用 0 円：D-388）。`POST /api/v1/llm/models` では足せず、足すのはサインイン（API-157）か下の再取得だけ。
  - POST `/api/v1/llm/models/refresh`：`{ provider: "openai_chatgpt" }`。トークンでモデルの一覧を取り直して `llm_models` に写す（消えたモデルが割り当て済みなら 409 `LLM_MODEL_IN_USE` ではなく、その役割を `status: "unavailable"` にして知らせる）。応答 `{ ok, count, models: [...] }`。サインインしていなければ 401 `CHATGPT_DISCONNECTED`
  - DELETE `/api/v1/llm/providers/openai_chatgpt`：接続を切る（暗号化したトークンを消し、`llm_models` の該当行を `usable = false` にし、割り当て済みの役割は `status: "unavailable"`）。監査ログ `llm.chatgpt_disconnected`。利用者の側でも `chatgpt.com/settings/usage` から切れる（切られても通知は来ない）
  - `reason` に `chatgpt_not_connected`・`chatgpt_not_eligible`・`chatgpt_auto_off` を足す。`chatgpt_allow_auto = false` の間、自動のきっかけで始まる仕事の役割（`review`・`summary` を含む）は `openai_chatgpt` を選べない（D-389）
- v1.7：`provider` に `decision`、能力に `decision`（`caps.decision`）を足した。役割 `classify`（仕分け）は `caps.decision = true` のモデルだけ割り当てられる（なければ 422 `LLM_CAPABILITY_MISSING`、`missing: "decision"`）。`reason` に `decision_required` を足す。ローカルの小さい生成モデルは道具の呼び出しも画面の操作もないので `main`・`worker`・`computer` は選べず、`summary` などだけ選べる（D-380）
- 照合（D-353）：`main`・`worker` は `cap_tools`、`review` は `cap_vision`、`computer` は `cap_computer_use` が `none` 以外。`generic` は `experimentalGenericComputer = true` のときだけ。単価が空のモデルは割り当てられない
- `openai_compatible` の `baseUrl` は、`network.mode = 'closed'` のとき `network.allow_hosts` の中にあるものだけ（なければ 422 `LLM_HOST_NOT_ALLOWED`）
- キーはこの API では扱わない。`.env` の `ANTHROPIC_API_KEY`・`OPENAI_API_KEY`・`OPENAI_COMPATIBLE_API_KEY`（任意。D-361）を本体が読む。キットでは、初回設定の画面から貼ったキー（API-157）を本体が暗号化して置き、`.env` の値があればそちらを優先する（D-384）。`openai_chatgpt` はキーを使わず、サインインのトークンを `workspace.chatgpt_auth`（TBL-031、暗号化）に置く（D-386）。応答にキー・トークンは出さない
- 既定（D-362）：`main`・`worker`・`computer` は `anthropic` の `claude-opus-5-5`、`review`・`summary` は `claude-sonnet-5-5`。OpenAI・互換には既定がない
- 割り当てを変えても、効くのは次のターン・タスクから。要約を始める長さと呼び出し前の上限は、モデルの文脈の長さに合わせて計算し直す（D-363）
- エラー（v1.7）：403 `CHATGPT_NOT_ELIGIBLE`（対象外。選べない理由を出す）、429 `CHATGPT_LIMIT_EXCEEDED`（枠の上限。止めて知らせ、ほかの支払いに自動で切り替えない：D-388）、401 `CHATGPT_DISCONNECTED`（切れた：もう一度サインイン）、409 `CHATGPT_AUTO_NOT_ALLOWED`。429・途中の `response.failed` を受けたときは、監査ログ `llm.chatgpt_limit` を残し、`usage_records` は費用 0 で回数とトークンを残す
- エラー：422 `LLM_CAPABILITY_MISSING`（`details` に `role`・`missing`）、422 `LLM_PRICE_MISSING`、422 `LLM_HOST_NOT_ALLOWED`、422 `LLM_GENERIC_NOT_ENABLED`、404 `LLM_MODEL_NOT_FOUND`、409 `LLM_MODEL_IN_USE`

### API-154：/api/v1/ledger（家計簿）
家計簿の一覧・直す・月の集計・CSV（TBL-061。FR-112・SCR-031）。レシートの読み取りと登録はチャットから（API-156 → 画像を読める役割 → `classify`）で、この API は見る・直す・書き出す。
| メソッド | パス | 中身 |
|---|---|---|
| GET | `/api/v1/ledger/entries` | 一覧。`?month=2026-10&category=&needsCheck=1&q=&cursor=&limit=`（`limit` 既定 50・最大 200）。応答 `{ items: [{ id, entryDate, store, items, amountYen, category, categorySource, paymentMethod, receiptThumbUrl, lowConfidence, confidence: { amount, date, category }, reviewStatus, matchedEvent, memo }], nextCursor }` |
| GET | `/api/v1/ledger/summary` | 月の集計。`?month=2026-10`。応答 `{ month, totalYen, count, needsCheckCount, byCategory: [{ category, totalYen, count }], byDay: [{ day, totalYen }], previousMonthTotalYen }` |
| PATCH | `/api/v1/ledger/entries/:id` | 1 行を直す。`{ entryDate?, store?, amountYen?, category?, paymentMethod?, memo?, items? }`（部分）。`review_status = 'corrected'`・`category_source = 'owner'` にし、監査ログ `ledger.corrected`（直す前後の値）を残す |
| POST | `/api/v1/ledger/entries/:id/confirm` | 読み取りのとおりで確かめた（`needs_check` → `confirmed`）。確認のカード（SCR-019）の [ これでよい ] |
| DELETE | `/api/v1/ledger/entries/:id` | 1 行を消す（同じレシートをもう一度送ると入れ直せる）。元の画像は保管庫に残る。監査ログ `ledger.corrected`（`deleted: true`） |
| GET | `/api/v1/ledger.csv` | CSV。`?month=` または `?from=&to=`。列：`entry_date,store,category,amount_yen,payment_method,memo`。`Content-Disposition: attachment`。UTF-8（BOM つき。Excel で開ける）。セルが `=`・`+`・`-`・`@` で始まるときは先頭に `'` を付ける。最大 10 万行 |
- 費目の候補：`GET /api/v1/ledger/categories`（食費・日用品・交通・医療・衣類・趣味・光熱費・その他・未分類。持ち主が足せる：`POST`）
- 家計簿は家の中の SQLite にだけ置く。この API は外へ送らない（CSV は持ち主の端末へのダウンロードだけ）
- レシートの元の画像は `receiptThumbUrl`（縮小版）と、API-153 の `content` で見る
- エラー：404 `LEDGER_ENTRY_NOT_FOUND`、422 `VALIDATION_ERROR`（金額が負・日付の形）、413 `PAYLOAD_TOO_LARGE`（CSV が 10 万行を超えた）

### API-156：POST /api/v1/chat/attachments
チャットに写真を添付する（TBL-063。FR-114・SCR-020）。スマホから 1 回 10 枚まで、1 枚 20MB まで（JPEG・PNG・HEIC）。
- リクエスト：`multipart/form-data`、`files`（繰り返し）。ヘッダー `Idempotency-Key`
- 処理：1 枚ずつ、形式と大きさを確かめる → HEIC は JPEG に変える → 長辺 1568px に縮める（元より小さければそのまま）→ 元の画像を保管庫の `写真` に置く（`vault_files` に索引。保管庫がつながっていなければ `/data/attachments/` に一時置きして、つながったら移す）→ `chat_attachments` に行を入れる（`message_id` は NULL。汚染の印は常に 1：BR-06）。メッセージを送る（API-119 の `attachmentIds`）まで LLM には何も渡さない
- レスポンス（201）：`{ "items": [{ "id": "0193...", "thumbUrl": "/api/v1/chat/attachments/0193.../thumb", "width": 1568, "height": 1176, "sizeBytes": 3482011 }] }`。1 枚でも外れたら、その枚だけ `error` を持つ形で返す（ほかの枚は上がる。207 ではなく 201 のまま `items[].error`）
- GET `/api/v1/chat/attachments/:id/thumb`：縮めた版（`Content-Disposition` なし・`nosniff`）。元の画像は API-153 の `content`
- メッセージに付かないまま 24 時間たった添付は、実体ごと消す
- 画像の中の文字は命令として扱わない（BR-06）。写真を LLM に渡した通信は `egress_events`（`purpose = 'llm'`）に残る（R-108）。ローカルで画像を読むモデルがあれば、そちらを使える
- エラー：422 `ATTACHMENT_TOO_MANY`（11 枚以上）、415 `ATTACHMENT_UNSUPPORTED`（JPEG・PNG・HEIC 以外）、413 `PAYLOAD_TOO_LARGE`（1 枚が 20MB を超えた）、422 `ATTACHMENT_UNREADABLE`（壊れた画像）、404 `ATTACHMENT_NOT_FOUND`

### API-157：/api/v1/setup（初回設定）
キットの初回設定（FR-109・SCR-033）。①電源と LAN（または Wi-Fi をスマホから設定）→②スマホに Tailscale を入れ、キットの QR で招待を受ける→③画面の QR からパスキーを登録→④ChatGPT でサインイン、または API キーを貼る→⑤最初のお願い。入口は Tailscale なので、②のあとはスマホから `https://makase.<tailnet>.ts.net` で届く（D-372）。
| メソッド | パス | 中身 |
|---|---|---|
| GET | `/api/v1/setup/status` | 手順の進み具合：`{ done: false, steps: [{ id: "network"｜"tailscale"｜"passkey"｜"llm"（v1.7：ChatGPT でサインインか API キー。どちらか済めばよい。`detail.via`：`chatgpt`｜`apikey`｜`local`）｜"first_request", done, doneAt, detail }], kit: { ... } }`。`kit` は API-111 と同じ形（保管庫・HA・ローカルのモデルの状態） |
| POST | `/api/v1/setup/enroll-qr` | パスキーの登録用の QR：`{ url, qrSvg, expiresAt }`。D-358 の `owner-enroll`（1 回限り・15 分）を QR にしたもの。パスキーが 0 件のときだけ作れる。QR の URL を開くと、パスキーの登録（API-083 の `enroll`）に進む |
| POST | `/api/v1/setup/chatgpt/start` | ChatGPT でサインインを始める（デバイスコード。v1.7：D-386）。`{ method?: "device"｜"loopback" }`（既定 `device`。手元の PC からなら `loopback`：`127.0.0.1` で戻りを待つ）。`client_id=dynamic_agent_client` で認可の口を呼び、応答 `{ ok: true, flowId, userCode: "ABCD-EFGH", verificationUrl, qrSvg, expiresAt, intervalSec }`。スマホのブラウザで `verificationUrl` を開き、コードを入れて承認する。スコープは `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`・`resource=https://api.openai.com/v1`。`closed` で `auth.openai.com` が許可リストにないときは 422 `LLM_HOST_NOT_ALLOWED`。秘密の鍵も API キーも要らない |
| GET | `/api/v1/setup/chatgpt/status` | 状態の確認：`?flowId=`。応答 `{ state: "pending"｜"approved"｜"denied"｜"expired"｜"sharing_not_approved"｜"not_eligible", accountLabel?, models?: [...] }`。待ち（`pending`）・済み（`approved`：トークンを暗号化して `workspace.chatgpt_auth` に置き、モデルの一覧を取って `llm_models` に写す。監査ログ `llm.chatgpt_connected`）・承認されなかった（`denied`）・期限切れ（`expired`：もう一度 start）。`sharing_not_approved` はサインインできたがトークンの共有を承認していない（枠を使えない：D-386）。`not_eligible` は 403 の対象外。画面は数秒おきに見る（`intervalSec` を守る） |
| DELETE | `/api/v1/setup/chatgpt` | サインインを取り消す（API-152 の切断と同じ） |
| POST | `/api/v1/setup/api-key` | API キーを貼る：`{ provider: "anthropic"｜"openai", key }`。本体が 1 回だけ試しに呼んで確かめ、通ったら暗号化して置く（`.env` には書かない。VM には置かない）。応答 `{ ok: true, provider, last4: "ab12" }`（キーは返さない）。外れたら 422 `API_KEY_INVALID`（`details.reason`：`unauthorized`・`quota`・`unreachable`）。監査ログ `setup.api_key_set` |
| POST | `/api/v1/setup/check` | つながったかの確認：LLM（試しの 1 往復。1 円未満）・保管庫・HA・ローカルのモデルを順に確かめる。`{ llm: { ok, role… }, vault: { ok, freeBytes }, home: { ok }, localModels: { decision: { ok }, generation: { ok } } }`。外れたものに、画面向けのやさしい直し方（`hint`）を添える |
| GET | `/api/v1/setup/first-requests` | 最初のお願いの例：`[{ id, text, needs: ["vault"｜"home"｜"ledger"｜null] }]`。つながっていないものは `available: false` |
| POST | `/api/v1/setup/complete` | 初回設定を終える。全部の手順が済んでいるときだけ受け、監査ログ `setup.completed` を残す（新しい列は持たず、`steps` の全完了とこの記録で「終わった」を表す）。2 回目以降は何もしない |
- 認証：①〜③は、Tailscale の身元か、パスキーが 0 件のときの `owner-enroll` の鍵が要る。パスキーが 1 件でもできたあとは、持ち主（API-083）だけ。最初のパスキーを登録するまでの間は、キットに同梱の紙の QR（招待用）を持っている人しか始められない。登録したあとは、パスキーがない端末からは何も変えられない
- ChatGPT でサインインしたなら API キーの手順は飛ばせる（`steps` の `llm` が済む）。どちらもしなければ家の中のモデルだけで動かせる（できることは減る：D-387）。ChatGPT のトークンも API で読み戻せない。サインインした仕事が使うのは持ち主のチャットとそこから振り分けた仕事だけ（自動のきっかけは `llm.chatgpt_allow_auto`：D-389）
- 貼ったキーは API で読み戻せない。変えるときは同じ口でもう一度貼る
- NFR-094 の測り方：`setup/status` の最初の `steps[].doneAt` から `first_request` まで（所要を記録して、実測に使う）
- エラー：422 `API_KEY_INVALID`、404 `CHATGPT_FLOW_NOT_FOUND`（`flowId` がない・使い終わった）、403 `CHATGPT_NOT_ELIGIBLE`、403 `CHATGPT_SHARING_NOT_APPROVED`、403 `SETUP_NOT_ALLOWED`（パスキーがあるのに鍵だけで来た）、403 `ENROLL_TOKEN_INVALID`（既存）、409 `SETUP_INCOMPLETE`（手順が残っているのに `complete`）

## このドキュメントで決まったこと
- D-196、D-221〜D-223、D-225、D-234、D-261、D-286（[00 決定事項ログ](../00_overview.md#決定事項ログ)）
- v1.4：D-317（API-121 は心拍だけ）、D-318（webhook は 1 分 60 件で 429）、D-320（リアクションを消す）、D-324（差し込みをやめる）、D-325（記憶は 2 層）
- v1.6：D-344（台帳）、D-347〜D-351（規則の版・試験・再実行・鎖・オートレビューは既定で切）、D-352・D-353・D-355・D-361〜D-364（モデル）、D-359・D-360（記録の経路・欠け）、D-368・D-369
- v1.7：D-385〜390（ChatGPT でサインイン：API-152・157）
- v1.7：D-374・376（添付：API-156）、D-375（家計簿：API-154）、D-372・384（初回設定・API キー：API-157）、D-379・380（`classify`・`decision`：API-152）
