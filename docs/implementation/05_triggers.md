# ステップ 5. きっかけと外とのつながり
- プロジェクト：Agent-Team-Open ／ 手順書の版：v1.2（2026-10-26） ／ 設計の版：v1.7 ／ インプット：[FR-094〜096・FR-017・FR-090・FR-091](../design/04_functional_spec/resident.md)、[FR-081・FR-083](../design/04_functional_spec/tools.md)、[常駐の DB（TBL-041・044〜046・054・055）](../design/08_database/resident.md)、[VM の DB（TBL-037）](../design/08_database/vm.md)、[変える表](../design/08_database/README.md)、[API](../design/09_api/README.md)、[UC-049・056・057 と BR-13](../design/03_use_cases.md)、[NFR-064・085・086](../design/05_non_functional.md)、[07 アーキテクチャ](../design/07_architecture.md)、[11 §10・§11](../design/11_tech_spec.md)、v1.6・v1.7：[FR-101](../design/04_functional_spec/resident.md#fr-101閉域モード)・[FR-116 の 6](../design/04_functional_spec/resident.md#fr-116chatgpt-でサインイン)・[ADR-074](../design/adr/ADR-074-closed-network.md)・[ADR-084](../design/adr/ADR-084-sign-in-with-chatgpt.md)（D-342・D-389）

> **3行で**
> 1. 時刻（ルーチン・予約した確認）と外の出来事（GitHub などの webhook）でメインが起き、留守の間の知らせが Web Push でスマホに届き、カレンダーと GitHub の書き込みが確認つきで通って、決まるとメインが `approval_done` で起きる。
> 2. `routines`・`routine_proposals`・`scheduled_wakes`・`webhooks` と毎分のタイマーの足し、:8081 の webhook の口、Tailscale Funnel（8443 番）、Web Push の送り手（`push_outbox`・購読・心拍）、本体の中の gateway（`apps/makase/src/gateway/`）を作る。v1.7：閉域モード（`network.mode = closed`）では Funnel と Web Push を使わず（D-341・342）、自動のきっかけでは ChatGPT の枠を使わない（D-389）。
> 3. 終わる条件：UC-049・056・057 の基本フローが通り、署名・429・重複・再送・`skipped` の単体が緑で、インターネット側から `curl` して 443 番に届かず 8443 番の `/hooks/<hookId>` だけが :8081 にパスのまま届き、試しの通知が 5 秒以内に送られる。`closed` では 8443 番が開かず Web Push の行が送られない。ルーチン・予約・webhook のターンとタスクが `openai_chatgpt` を呼ばない。

## 前提（始める条件）
- 入力（前のステップの成果・git の履歴から読むもの）：
  - ステップ 4（[04_resident.md](04_resident.md)）が終わっている：受付が `wakes.origin` のすべてを受け、メインのターンが `send_to_owner` で `push_outbox` に書き、毎分のタイマーの骨組み（`chat` の待ちを起こす・日次の区分の判定）が動く。区分の判定そのものはステップ 4 のものを使う
  - ステップ 3（[03_core_port.md](03_core_port.md)）が終わっている：`apps/makase` が Compose で起動し、:8080 は Tailscale の身元で守られ、:8081 の Hono アプリは「空で 404 だけ」の形である。`tailscale` コンテナで `https://makase.<tailnet>.ts.net` に入れる。`ENCRYPTION_KEY` が `.env` にあり、`packages/platform` の `sealSecret`・`openSecret` が使える
  - `apps/app`・`apps/worker`・`packages/edge` はステップ 3 の 3.7 で消えている。このステップの「移す元」のうち `apps/app/src/` のもの（`routes/connect.ts`・`connect-github.ts`・`approvals.ts`・`connectors/`・`check/`・`tick.ts`・`schedule.ts`）は、消したコミット（SHA：ステップ 3 の最後にここへ書く）から `git show <sha>:<path>` で読む。`apps/worker/src/` のもの（`db/repo/gateway.ts`・`edge/intents.ts`・`views/connectors/known.ts`）は `apps/makase/src/` の同名に移っている
  - v1.7 の分：`network.mode`・`network.allow_hosts` の設定と窓口 `net`（本体の外向きを許可リストで絞り台帳に書く：FR-103）はステップ 3、役割で呼び分ける `clientFor(role, { budgetClass })` と D-389 の判定の口はステップ 4 の 4.10 にある
  - 新しい表の骨組み（`routines`・`routine_proposals`・`scheduled_wakes`・`webhooks`・`push_subscriptions`・`push_outbox`）と `action_intents`・`approvals`・`policy_decisions` の `turn_id` は、ステップ 3 の版 4・5 で作ってある。このステップの「マイグレーションに足す」は「無い列・索引があれば足す」の意味
- 機械（置き先・実機）：
  - 置き先は段 1（手元の WSL2・amd64）。webhook と Web Push は外の機械と実の端末が要る（下の道具）
  - インターネット側から `curl` できる場所（tailnet に入っていないスマホのモバイル回線、または tailnet に入れていないクラウドの VM）。tailnet の中から叩いても Funnel を通った確かめにならない
  - Web Push を受ける実の端末（Android の Chrome か、iOS を「ホーム画面に追加」した PWA）。画面（PWA の購読の部分）はステップ 6 だが、このステップでは `curl` と最小の試験ページで購読する
- 鍵とアカウント：
  - Tailscale：tailnet で HTTPS を有効にする。ACL に `funnel` の属性を足す権限（5.4）
  - `.env`：`VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`・`VAPID_SUBJECT`・`TS_FUNNEL`・`TZ`（5.1・5.4・5.5）。カレンダー・GitHub を使うなら `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET`・`GITHUB_APP_ID`・`GITHUB_APP_PRIVATE_KEY`

## 作るもの
| 部品 | 置き場 | 移す元（あれば） | 設計の参照 |
|---|---|---|---|
| `routines`・`routine_proposals`・`scheduled_wakes`・`webhooks` の無い列、`push_outbox` の索引 | `apps/makase` のマイグレーション（ステップ 3 の仕組み。表はステップ 3 の版 5 で作成済み） | なし | TBL-044・045・046・054・055 |
| cron の解析・次の時刻・15 分未満の検査 | `apps/makase/src/triggers/schedule.ts` | `apps/app/src/schedule.ts`（毎日の時刻だけの `nextScheduledRun`。形だけ参考） | FR-094、D-221 |
| ルーチンの API とタイマーの手順 | `apps/makase/src/triggers/routines.ts` と、毎分のタイマーへの `routineStep` | `apps/app/src/tick.ts` の `runTick`（手順を順に足す形） | API-125・126・136・142 |
| `propose_routine`・`schedule_wake` の道具 | `apps/makase/src/turn/tools/`（ステップ 4 の道具の置き場） | なし | FR-091 |
| 予約した確認の API とタイマーの手順 | `apps/makase/src/triggers/scheduled-wakes.ts` | なし | FR-095、API-127・139 |
| webhook の口（:8081）と受け口の API | `apps/makase/src/hooks/`（`server.ts`・`verify.ts`・`summary.ts`）と `routes/webhooks.ts` | ステップ 3 の「空の :8081」を育てる | FR-096、API-128・129・140 |
| Funnel の設定と本体との受け渡し | `docker/tailscale/`（起動スクリプト・`serve.json`）と `compose.yaml` | ステップ 3 の `tailscale` コンテナ | ADR-065、D-241・D-305、07 |
| Web Push の送り手・心拍・購読の API | `apps/makase/src/push/`（`sender.ts`・`presence.ts`・`outbox.ts`）と `routes/push.ts` | `packages/platform/src/mask.ts`（秘密を通知の文に入れない検査の参考） | FR-017、API-031・032・121・137、D-267・D-288 |
| gateway（本体の中の部品） | `apps/makase/src/gateway/`（下の対応表） | `apps/gateway`・`apps/gcal`・`apps/github` | ADR-051、FR-081 |
| 閉域モードのときの Funnel・Web Push の止め方、自動のきっかけで ChatGPT を使わない判定 | `docker/tailscale/` の起動スクリプト・`push/outbox.ts`・`intake/router.ts`（ステップ 4） | ステップ 3 の `network.mode`、ステップ 4 の `clientFor` | FR-101・FR-017・FR-096・D-341・342・389 |
| カレンダー・GitHub をつなぐ API と確認の決定 | `apps/makase/src/routes/connect.ts`・`approvals.ts` と `gateway/connect/` | `apps/app/src/routes/connect.ts`・`connect-github.ts`・`connectors/google.ts`・`github.ts`・`classify.ts`・`policy.ts`・`check/decide.ts`・`check/tick-step.ts`・`check/recheck.ts` | API-093〜095・107・019、D-248・D-275 |

gateway の「移す元 → 移す先」（開いて確かめた。`apps/gateway` に `flow.ts` はなく、あるのは `flow.test.ts`＝偽の MCP サーバーとの一周の試験だけ）：
| 移す元 | 移す先 | 扱い |
|---|---|---|
| `apps/gateway/src/execute.ts`（`executeIntent`・`intentIntegrityOk`・`responseOf`） | `gateway/execute.ts` | 移す。PostgreSQL の非同期・ロックの順を、SQLite の同期の 1 トランザクションに書き直す。Intent を `turn_id` でも持てるようにし、終わりを書くのと同じトランザクションで `approval_done` を入れる（5.6） |
| `apps/gateway/src/reads.ts`（`callReadTool`） | `gateway/reads.ts` | 移す。タスクの `X-Task-Token` で引く部分を、「タスク（`task_id`）かメインのターン（`turn_id`）」の文脈を直接受ける形にする |
| `apps/gateway/src/context.ts`（`defaultConnectorAuth`・`githubAppJwt`・再試行の待ち） | `gateway/auth.ts` | 移す。Google の refresh token からの access token、GitHub App の JWT からのインストールのトークン |
| `apps/gateway/src/env.ts`・`origin.ts`・`ids.ts`・`result-text.ts` | `gateway/` の同名 | 移す（`env.ts` は本体の環境変数の読み取りに溶かす。`result-text.ts` の 64KB で切ってマスクはそのまま） |
| `apps/gateway/src/mcp.ts`（MCP のクライアント） | `gateway/call.ts` | MCP の `Client`・トランスポートは消す。「送ったか・どこで失敗したか」を記録する `fetch` の包みだけ残し、結果の分け方（送信前の失敗は再試行・送信後の失敗は `unknown_outcome`）を保つ |
| `apps/gateway/src/sync.ts`・`tool-change.ts` | 消す（おすすめ） | ツールがイメージの中のコードになるので、説明の変化の検出は要らない。`connector_tools` の行は接続のときに manifest から入れる（実装で決める） |
| `apps/gateway/src/provenance.ts` | 消す（おすすめ） | DB のロール分離（ot_app と ot_gateway）が前提の照合で、SQLite・同じプロセスでは成り立たない。守りは ADR-051 の依存の検査と、`execute.ts` の「`approved` のときだけ・`intentHash` を計算し直す」（実装で決める） |
| `apps/gateway/src/app.ts`・`server.ts`・`index.ts`、`packages/gateway-client` | 消す | `/gw/v1/*` の HTTP と共有トークンは、同じプロセスの関数の呼び出しになる |
| `apps/gcal/src/tools.ts`（`callGcalTool`）・`calendar.ts`・`slots.ts` | `gateway/gcal/` | 移す。`callGcalTool` は MCP を介さず呼べる形（`ToolContext` を受け `CallToolResult` を返す）のまま |
| `apps/github/src/tools.ts`（`callGithubTool`）・`github.ts` | `gateway/github/` | 移す（同上） |
| `apps/gcal`・`apps/github` の `app.ts`・`mcp.ts`・`server.ts`・`auth.ts`・`env.ts`・`index.ts` | 消す（おすすめ） | MCP サーバーとしての外側。コンテナを増やさない（D-326） |
| `packages/gcal-core`・`packages/github-core` | そのまま使う | manifest・分類・引数の役割・ヘッダー名（`GCAL_CONNECTOR`・`GITHUB_CONNECTOR`）。`KNOWN_CONNECTORS`（`views/connectors/known.ts`）はステップ 3 で移し済み |
| `apps/app/src/routes/connect.ts`・`connect-github.ts`、`connectors/google.ts`・`github.ts`・`classify.ts`・`policy.ts` | `routes/connect.ts` と `gateway/connect/` | 移す。道は `/api/v1/connect/:kind/start`・`callback`（API-094・095）に合わせ、一覧 API-093・外す API-107 を足す |
| `apps/app/src/routes/approvals.ts`、`check/decide.ts`・`tick-step.ts`・`recheck.ts`・`resolve.ts` | `routes/approvals.ts` と `gateway/approvals.ts` | 移す。API-019 と期限切れの毎分の手順を `turn_id` の Intent に対応させる。`computeApprovalExpiry` の「依頼の次の実行」（asks）は使わない。期限は実装で決めること |
| `apps/worker/src/db/repo/gateway.ts`（SQLite 版の問い合わせ）・`edge/intents.ts`（`recordMcpIntent`） | `apps/makase` の `db/repo/gateway.ts`・`edge/intents.ts` | 既に SQLite・同期。ステップ 3 の版 4 で `task_id`・`job_id` は NULL 可、`turn_id` と「どちらか一方」の CHECK 済み。ここでは `tool_call_id`（UNIQUE）が無ければ足す |
| `apps/worker` のほかの部分 | 触らない | Cloudflare 版にあるのは上の 2 つと `KNOWN_CONNECTORS` と表の定義（`connectors`・`connector_tools`・`connector_credentials`）だけ。**実行（`executeIntent`）・接続の道（`/connect`）・承認の決定・カレンダーと GitHub を呼ぶ処理はない**（`grep` で確かめた）。`apps/worker/src/auth/google.ts` は Google のログインで、Tailscale の身元に変えたので使わない |

## 手順
### 5.1 ルーチンと提案（いちばん分からない cron から）
1. `routines`（TBL-044）・`routine_proposals`（TBL-054）はステップ 3 の版 5 で作成済み。無い列・索引だけ新しい版で足す。`tz` の既定は `TZ`（既定 `Asia/Tokyo`）。20 本の上限は作るときに数える
2. cron のライブラリを入れ（選び方は「実装で決めること」）、`triggers/schedule.ts` に 3 つの関数を作る：`validateSchedule(expr, tz)`（5 欄・タイムゾーンが IANA）、`nextRunAfter(expr, tz, after)`、`scheduleText(expr)`（「平日 8:00」の形）。15 分以上の間隔は、次の 200 回を並べて最小の間隔を見る（`*/10`・`0,10` や、時の欄が広くて分の欄が詰まっているものを断る）。外れたら 422 `SCHEDULE_INVALID`
3. API-125（作る・一覧）・API-126（直す・止める・消す）・API-136（今すぐ動かす）。20 本で 409 `ROUTINE_LIMIT`。`schedule` を変えたら `next_run_at` を計算し直す。持ち主がプロンプトを直したら `tainted = 0`。作る・消すで監査ログ `routine.created` を残す。持ち主が作ったものは `created_by = 'owner'`・`tainted = 0`
4. `propose_routine(name, prompt, schedule, agentId?)` をメインの道具に足す（道具の一覧はターンの途中で変えない：D-238。ステップ 4 の道具の登録に 1 行足す）。`tool_call_id` を UNIQUE に入れ、歩みの `done` と同じトランザクションで `routine_proposals` を `pending`・`expires_at` = 7 日後で作る。提案したターンが汚染していれば `tainted = 1`。同じトランザクションで `push_outbox` に「確認してください：<要約>」（`tag = check:<proposalId>`）を入れる（5.5 の `enqueuePush`。5.5 までは `push_outbox` に購読ごとの行を直接書く仮の関数でよい）。API-087 の確認の一覧に `kind: "routine"` のカードを足す
5. API-142：`pending` のときだけ。`approve` で `routines` に `created_by = 'main'` の行を作り（`tainted` を引き継ぐ）、`routine_proposals` を `approved` にする。メインは起こさない。`reject` は `rejected`。20 本なら 409 `ROUTINE_LIMIT`、決まったものは 409 `CHECK_NOT_PENDING`
6. 毎分のタイマーに `routineStep` を足す。`enabled = 1 and next_run_at <= 今` を探し、1 本ごとに 1 つのトランザクションで次を行う：`wakes` に `origin = 'routine'`・`budget_class = 'auto'`・`target_kind = 'main'`・`source_key = routine:<id>:<next_run_at>`・`tainted = routine.tainted`・`payload`（ルーチンの ID・名前・プロンプト・`agent_id` があれば「○○に渡す」の添え書き）で入れる → `last_run_at = 今` → `next_run_at = nextRunAfter(今)`（**過ぎた分の次ではなく今から数える**。止まっていた間の分は 1 回だけ動く）。同じタイマーで 7 日たった `routine_proposals` を `expired` にする
7. 受付に入るのはステップ 4 の関数をそのまま使う。ルーチンのプロンプトと添え書きが「起こされた理由：ルーチン「…」」の頭書きでターンに渡ることを確かめる
確かめ：`POST /api/v1/routines`（毎分でない時刻）→ `wakes` に 1 行（`routine`・`budget_class = 'auto'`）が入り、メインのターンが始まる。`*/10 * * * *` は 422。15 分おきのルーチンで試験用の時計を 1 時間進めても `wakes` は 1 行だけ。`POST /api/v1/routines/:id/run` で今すぐ動く。`daily_auto_usd` を 0 にすると `wakes` が `dropped`（`budget`）になり、`daily_usd` が残っていても持ち主の `chat` は通る

### 5.2 予約した確認
1. `scheduled_wakes`（TBL-045）はステップ 3 の版 5 で作成済み。無い列・索引だけ新しい版で足す（`tool_call_id` は UNIQUE であること）
2. `schedule_wake(at | afterMinutes, note)` をメインだけの道具に足す（振り分け先には渡さない：FR-092）。検査：5 分後〜30 日後（外れたらエラーを道具の結果に返す）、`note` 500 字まで、作った日に 20 件まで。`tool_call_id` と歩みの `done` を同じトランザクションで書く（D-249）。予約したターンが汚染していれば `tainted = 1`
3. 毎分のタイマーに `scheduledStep` を足す。`status = 'pending' and at <= 今` を探し、1 件ごとに 1 つのトランザクションで `wakes`（`origin = 'scheduled'`・`budget_class = 'auto'`・`source_key = scheduled:<id>`・`tainted` を引き継ぐ・`payload` に覚え書き）を入れて `fired` にする。止まっていた間に過ぎた予約は全部動かす（ルーチンと違って 1 回にまとめない：UC-056 の 1a）
4. API-127（`pending` の一覧）・API-139（`cancelled` にする。`pending` 以外は 409）
確かめ：`afterMinutes: 5` の予約が 5 分後に `wakes`（`scheduled`）になり、頭書きに覚え書きが付いてメインが起きる。4 分後は拒否され、21 件目は拒否される。同じ `tool_call_id` で 2 回呼んでも 1 行。再起動をまたいでも 1 回だけ動く

### 5.3 webhook の口（:8081）
1. `webhooks`（TBL-046）はステップ 3 の版 5 で作成済み。無い列・索引だけ新しい版で足し、`wakes` の `(hook_id, created_at)` の索引があることを確かめる（ステップ 4 で作っていなければ足す）
2. API-128（作る・一覧）：`hookId` は 128 bit の乱数を base32（小文字・`=` なし）で、秘密は `whsec_` ＋ 32 バイトの乱数で作り、`sealSecret` で `secret_enc` に入れる。応答の `secret` は**この 1 回だけ**。URL は `https://makase.<tailnet>.ts.net:8443/hooks/<hookId>`。`funnel` は 5.4 の状態から `on`・`off`。API-140（止める・消す）
3. :8081 の Hono アプリに `POST /hooks/:hookId` だけを置く。ほかのパス・メソッドは 404（`/api/*` も 404：FR-073）。Tailscale の身元のヘッダーは読まない。本文は生のバイトで受ける（署名はバイトに対して計算するため）
4. 順番は API-129 のとおり：**大きさ**（256KB 超は 413 `PAYLOAD_TOO_LARGE`。`Content-Length` と、読みながらの上限の両方）→ **受け口**（ない・`enabled = 0` は 404 `HOOK_NOT_FOUND`。理由を分けない）→ **署名**（`verify.ts`。定数時間の比較。`github` は `X-Hub-Signature-256` の `sha256=<hex>`、`generic` は `X-Makase-Signature-256` で `<X-Makase-Timestamp>.<X-Makase-Delivery>.<本文>` の HMAC-SHA256、時刻が 5 分より古い・新しいものは断る。合わなければ 401 `HOOK_SIGNATURE_INVALID`）→ **重複**（`source_key = webhook:<hookId>:<配達 ID>` が既にあれば 202 を返して捨てる。配達 ID は `github` が `X-GitHub-Delivery`、`generic` が `X-Makase-Delivery`）→ **件数**（`wakes` の `hook_id` が同じで直近 60 秒の行が 60 件以上なら 429 `HOOK_RATE_LIMITED`。何も残さない）→ **きっかけ**
5. 通ったら 1 つのトランザクションで `wakes`（`origin = 'webhook'`・`budget_class = 'auto'`・`tainted = 1`・`hook_id`・`payload`）を入れ、`webhooks.last_delivery_at`・`delivery_count` を更新し、202 を返す（ターンの終わりを待たない）。`payload` はメインに渡す形：受け口の名前と説明（`note`）・出来事の種類（`X-GitHub-Event`）・本文の要約。`github` の要約は `hooks/summary.ts` が決まった欄だけ抜く（リポジトリ・PR の番号と題・CI の結論・URL）。本文の全部は渡さない
6. 401 は本文も記録に残さず、件数だけを 1 分ごとにまとめて監査ログ `webhook.rejected` に書く。エラーの本文は `{ "error": { "code": "..." } }` だけ。受けた経路（パスのみ。本文・ヘッダーは出さない）を 1 行のログに出す（5.4 の確かめに使う）
7. 本体の起動のとき :8081 が front のアドレスだけで待ち受けていること（ステップ 3）を変えない
確かめ：`openssl dgst -sha256 -hmac "$SECRET"` で署名を作り、`curl` で :8081 に直接送る。正しい署名 → 202 で `wakes` が 1 行。同じ配達 ID をもう一度 → 202 で行は増えない。署名を 1 文字変える → 401（行なし）。61 通を 1 分以内に送る → 61 通目が 429（行なし）。300KB → 413。`/api/health` を :8081 に送る → 404。メインが「GitHub の webhook」の頭書き・「外から来た内容」の枠つきで起きる

### 5.4 Tailscale Funnel（8443 番だけを公開する）
1. tailnet の ACL に、`makase` の機械へ `funnel` の属性を許す（`nodeAttrs` の `attr: ["funnel"]`。`TS_AUTHKEY` で入れる機械に付けたタグに対して）。tailnet の HTTPS が有効なことを確かめる。**この手順は任意**で、使わない持ち主は受け口を作らなければ公開されない
2. `tailscale` コンテナの設定を作る。443 番は `serve` だけ（tailnet 内。:8080 へ）、8443 番は **`/` ごと** :8081 へ流し、`funnel` を付ける。パスで切らない（D-305）。Funnel が使えるポートは 443・8443・10000 なので 8443 を使う。持ち方（`serve.json` か起動スクリプトか）は「実装で決めること」
3. `TS_FUNNEL=auto`（既定）は「受け口が 1 つでもあれば公開」、`off` は公開しない。本体が受け口の数を知らせ、`tailscale` コンテナが `funnel` を付け外しする（受け渡しの方法は「実装で決めること」）。受け渡しの共有ボリュームは `makase-funnel-state`。ステップ 3 の Compose に無いので、5.4 で `compose.yaml` に足す（`makase` と `tailscale` の両方にマウントする）。受け口をすべて消したら 8443 番を閉じる
4. 本体の状態（API-111・FR-083）に Funnel の状態（受け口があるか・公開されているか）を足す。API-128 の `funnel` もここから返す。tailnet の設定で許されていないときは `off` と案内を返す
5. 外から確かめる（**tailnet に入っていない場所から**。`<host>` は `makase.<tailnet>.ts.net`）：
   - `curl -m 10 -sv https://<host>/` → つながらない（443 番は公開していない）
   - `curl -m 10 -si https://<host>:8443/` と `https://<host>:8443/api/health`（API-082）→ 404（:8080 の画面と API に届いていない。200 や HTML が返れば失敗）
   - 受け口を作り、`curl -si -X POST https://<host>:8443/hooks/<hookId> -d '{}'`（署名なし）→ 401 `HOOK_SIGNATURE_INVALID`。404 ではなく 401 が返れば、`/hooks/<hookId>` がパスの頭を落とさずに :8081 に届いている。本体のログの受けた経路も `/hooks/<hookId>` になっている
   - 正しい署名で送る → 202 で `wakes` が 1 行
6. 受け口をすべて消したあと、同じ `curl` が 8443 番でもつながらなくなる
確かめ：5 の 4 項目が期待どおり。結果（パスの頭が落ちなかったこと）を 00 の決定事項ログの D-305 の横に書く

### 5.5 Web Push の送り手
1. `web-push` を `apps/makase` に入れ、VAPID の鍵を 1 度だけ作って `.env`（権限 600）に入れる（コマンドは「実装で決めること」）。`VAPID_SUBJECT` は `mailto:`。秘密鍵をログ・通知の文に出さない
2. `push_subscriptions`（TBL-037）と `push_outbox`（TBL-055）はステップ 3 の版 5 で作成済み。無い列・索引だけ新しい版で足す。API-137 `GET /api/v1/push/key` は公開鍵を返す。API-031 `POST /api/v1/push-subscriptions`：`{ endpoint, keys: { p256dh, auth } }` を `endpoint` で upsert し、`label` は User-Agent から作る。`?test=1` は試しの通知を送る。API-032 `DELETE`：購読を消し、その購読の `pending` の行を `failed` にする
3. `push/outbox.ts` に `enqueuePush(tx, { kind, tag, title, body, url, sourceRef })` を作る：その時の購読ごとに 1 行（同じ `notice_id`）を入れる。同じ `tag`・同じ購読の `pending` があれば置き換え、本文に「ほか N 件」を足す。ステップ 4 の `send_to_owner` の `push_outbox` への書き込みをこの関数に差し替える。人の確認（`approvals`・`routine_proposals`）の作成と同じトランザクションから呼ぶ。`browser_checks` の確認を作る場所にも同じ呼びを足す。交代の頼みの通知（`tag = takeover:<id>`）は、ステップ 4 で `push_outbox` に書いている。送るのはここ（書き込みをこの関数に差し替える）。通知の文に秘密（フォームの値・パスワード）を入れない：本文は要約だけ、`send_to_owner` は先頭 80 字、`file` は「ファイル：<名前>」
4. API-121 `POST /api/v1/presence`（`{ deviceId, visible }`）→ 204。本体は端末ごとに最後の心拍の時刻と `visible` を覚え（メモリでよい）、SSE の接続と `deviceId` を結ぶ。「見えている端末」は `visible` で、心拍が 60 秒以内で、その端末の SSE がつながっているもの（D-269）
5. 送り手 `push/sender.ts`：`pending` を古い順に取り、`notice_id` ごとに、見えている端末があれば同じ `notice_id` の行をすべて `skipped` にし、なければ購読ごとに `webPush.sendNotification` で送る。成功なら `sent`（`push_subscriptions.last_success_at`・`fail_count = 0`）。404・410 は購読を消し、その購読の送っていない行を `failed`。ほかの失敗は `attempts` を増やして待ち、3 回で `failed`。`expires_at`（1 時間）を過ぎたら `expired`。終わった行は 7 日で消す
6. 起こし方：行を入れたトランザクションのコミットのあとすぐ（待たずに）、起動時、毎分のタイマー。再起動したら送っていない行から送る。送り手は `web-push` を差し替えられる形にして、単体では偽の送り手を使う
7. 試しの通知で端末に購読する：最小の試験ページ（`apps/makase` が出す 1 ファイルでよい）から `PushManager.subscribe` → API-031 → `?test=1`。iOS は「ホーム画面に追加」してから開く
確かめ：実の端末に `send_to_owner` の通知が届く。画面を前に出して心拍を送っている間は届かず `skipped`（SSE だけ）。画面を隠して 60 秒たつと届く。購読を消した端末の行は `failed`。`push_outbox.created_at` から `sendNotification` の完了までを 10 回ログで見て、すべて 5 秒以内

### 5.6 カレンダー・GitHub の gateway を本体に移し、`approval_done` をつなぐ
#### 5.6.a 依存の検査と `execute`・`reads`・`auth` の移植（偽の fetch での単体）
1. 依存の検査を先に作る：`gateway/` の資格情報（refresh token・GitHub App の鍵）を読めるのは `gateway/` の中だけ。`runner`・`edge`・ターンから `gateway/` の公開の入口（`callRead`・`executeIntent`・接続の API）以外に届かないことを dependency-cruiser で確かめる（ADR-051。ステップ 3 の `lint:deps` に規則を足す）
2. 表を確かめる（08 の「変える表」）：ステップ 3 の版 4 で `action_intents`・`approvals`・`policy_decisions` に `turn_id`（FK `turns`）が足され、`task_id`（`action_intents` は `job_id` も）が NULL 可で、CHECK が「`task_id` と `turn_id` のどちらか一方だけ」になっていること。`action_intents.tool_call_id`（UNIQUE）が無ければここで足す（表を作り直すマイグレーション）
3. `gcal/`・`github/` の `callGcalTool`・`callGithubTool` を移し、`gateway/call.ts` の `fetch` の包みに通す。`gateway/auth.ts` を移し、`connector_credentials` の refresh token を `openSecret` で開く。書き込みの結果は 64KB で切ってマスクする（`result-text.ts`）。**単体の移植**：`apps/gateway/src/execute.test.ts`・`reads.test.ts`・`result-text.test.ts` と `apps/gcal`・`apps/github` の試験を、SQLite の偽の世界に直して一緒に移し、緑にする
4. `execute.ts` を SQLite の同期にして移す。手順は元のまま（Intent を引く → `approved` と `intentHash`・無効なコネクタを確かめる。Kill Switch の確かめは Won't なので外す → `executing` をコミット → 呼び出し → 結果の表 → 終わりを書く）。外の呼び出しはトランザクションの外（G-14）。送信前の失敗だけ最大 3 回（1・4・16 秒）、送信後の失敗は `unknown_outcome` で再試行しない
確かめ：`pnpm lint:deps` が緑で、`runner`・`edge`・ターンから `gateway/` の中を直接読む import を 1 本足すと赤になる。移した `execute.test.ts`・`reads.test.ts`・`result-text.test.ts` と `gcal`・`github` の試験が、偽の `fetch` で緑。

#### 5.6.b ターンへの結びつけと API-019・`approval_done`
5. メインのコネクタの道具をターンに結ぶ：読み取りは `reads.ts` を `turn_id` の文脈で呼び、判定の記録（`policy_decisions`）に `turn_id` を残す（D-275）。書き込みは Kernel の判定（汚染しているターンの書き込みは確認に回る）→ `recordMcpIntent` に `turn_id`・`tool_call_id` を渡す。ルールの `allow` ならその場で実行して結果を返す。確認に回ったら道具の結果に「確認待ち（決まったら知らせる）」を返し、メインはターンを終えて眠ってよい。`tool_call_id` で再起動後に探す（D-287）。同じトランザクションで確認のカードと `push_outbox`（`tag = check:<approvalId>`）を入れる
6. コネクタの道具の詳細は要るときだけ渡す（FR-088・D-193。`docs/design/04_functional_spec/tools.md` の FR-088 を開いて確かめる）：カレンダー・GitHub の道具は名前と 1 行の説明だけ先にメインに渡し、引数の形などの詳細は使うと決めたときに読み込む（Claude の tool search と `defer_loading`）。つないでいないコネクタの道具は名前も出さない。接続先で使えないときは最初から全部渡す。道具の一覧はターンの途中で変えない（D-238）
7. API-019（○ / ×）：`intentHash` が今の Intent と違えば 409。`turn_id` を持つ Intent は、× なら Intent を `rejected`・確認を決めたのと、○ なら実行の結果（`executed`・`failed`・`unknown_outcome`）を書くのと**同じトランザクションで** `wakes`（`approval_done`・`budget_class = 'chat'`・`source_key = approval:<approvalId>`・汚染しない）を入れる（D-248・D-275）。タスクの Intent は今のまま（タスクの状態を決め直す）。毎分のタイマーの期限切れも同じ：`turn_id` の Intent は `expired` にして `approval_done` を入れ、タスクは止めない（`approval_expired` の `halted` はタスクのときだけ）。承認の期限（依頼の次の実行は使わない）と、承認済みなのに実行が始まっていない Intent の拾い直しの間隔は実装で決めること。拾い直しも `turn_id` を扱えるようにする
確かめ：ScriptedLlm のターンで、コネクタの道具が名前と 1 行の説明だけで渡り、使うと決めたときに詳細が読み込まれる。つないでいないコネクタの道具は一覧に出ない。書き込みが確認に回り、○・×・期限切れのそれぞれで `approval_done` が 1 回だけ入る（偽の `fetch`）。

#### 5.6.c 接続 API-093〜095・107
8. 接続（API-093〜095・107）を移す。戻り先の URL は ts.net の名前から作る（`https://makase.<tailnet>.ts.net/api/v1/connect/google/callback` など。作り方は「実装で決めること」）。`state`（10 分・1 回限り）を HttpOnly・Secure・SameSite=Lax の Cookie に結び、Google は PKCE、GitHub はインストールの ID が自分の App のものかを API で確かめる（合わなければ 400 `CONNECT_STATE_INVALID`）。つないだら `connector_tools` に manifest の分類を入れる（`classify.ts`）。GitHub の webhook は App の webhook ではなく、リポジトリの Webhooks に 5.3 の URL と秘密と `application/json` を入れる（5.3 の受け口。GitHub は 429 を自動では送り直さない：配達の画面の「Redeliver」で送り直す。ステップ 8 の導入手順書に書く）
確かめ：偽の Google・偽の GitHub で `connect` の試験が緑（`state` の期限・1 回限り・Cookie・PKCE・インストールの照合）。つないだあと `connector_tools` に分類が入り、外す（API-107）と消える。

#### 5.6.d 結合と実の 1 回
9. 結合の試験（ScriptedLlm と偽の Google・偽の GitHub の `fetch`）：メインが `create_event` → 確認待ち → ターンが `done` で眠る → ○ → 実行 → `approval_done` でメインが起き `send_to_owner`。実の Google カレンダー・実の GitHub のテスト用リポジトリでも 1 回ずつ通す
確かめ（5.6.d）：UC-054 4a の図のとおりに動く。カレンダーに専用のカレンダー（名前 `Makase`）ができて予定が入り、GitHub の PR が作られる。× と期限切れでもメインが起き、書かれていない。実行の途中で本体を再起動しても二重に書かれず、`approval_done` は 1 回だけ入る

### 5.7 旧コードを消す
1. `apps/gateway`・`apps/gcal`・`apps/github`・`packages/gateway-client`・`packages/db` を消す。`packages/gcal-core`・`packages/github-core` は残す
2. `.dependency-cruiser.cjs` の `workspace("db")` と、`.github/depcruise-selftest` のフィクスチャを直す（消した場所への参照を外す）
3. `pnpm install` でロックを作り直し、`pnpm typecheck / test / lint:deps` を通す
確かめ：`git ls-files apps/gateway apps/gcal apps/github packages/gateway-client packages/db` が空。`grep -rn "gateway-client\|@open-team/db"` が残っていない。`pnpm typecheck / test / lint:deps` が緑

### 5.8 閉域モードときっかけ・自動のきっかけと ChatGPT の枠
1. Funnel（D-341）：`network.mode = closed` のときは、`TS_FUNNEL` と受け口の数によらず 8443 番に `funnel` を付けない（5.4 の 3 の「公開してよいか」のファイルを書かない）。API-128 の `funnel` は `off` と理由（閉域モード）を返し、API-111 の Funnel の状態も同じ。`closed` に切り替えた時点で付いていれば外す
2. webhook（FR-096）：`closed` では家（社内）の GitLab・GitHub Enterprise Server から LAN の中で受ける。:8081 を LAN 側にも結ぶ形は、ステップ 3 の入口（Headscale・LAN の直結）に合わせる。署名・重複・件数の検査（5.3）は変えない。GitHub.com からの配達は届かない（Funnel がない）
3. Web Push（D-342・FR-017）：`closed` では `enqueuePush` が行を作らない（購読があっても）。送り手（5.5 の 5）も、`closed` の間は残っている `pending` を送らず `skipped` にする。通知は画面の中（SSE）だけで、家の中の ntfy（`network.allow_hosts` に書いたもの）は任意（作るかは「実装で決めること」）。API-031 の `?test=1` は 409 で理由を返す
4. カレンダー・GitHub の gateway（5.6）の外向きは、ステップ 3 の窓口 `net` を必ず通す（`gateway/call.ts` の `fetch` の包みを `net` の上に置く）。`closed` で許可リストにない先は、実行の前に断られ台帳に残る
5. 自動のきっかけと ChatGPT の枠（D-389）：ルーチン（5.1）・予約（5.2）・webhook（5.3）で始まるターンと、そこから `delegate` したタスクは、`llm.chatgpt_allow_auto = false` のあいだ `openai_chatgpt` を呼ばない。ステップ 4 の `clientFor` の口を使い、割り当てが `openai_chatgpt` のときは呼ばずに、きっかけを `dropped`（`chatgpt_auto_off`）にして `role = 'system'` の知らせを 1 日 1 回出す（日次の上限で `auto` を捨てるのと同じ扱い：4.2 の 5）。`true` にすれば使う
確かめ：(1) `closed` にして受け口を作っても、tailnet の外からの `curl -m 10 -si https://<host>:8443/hooks/<hookId>` がつながらず、API-128 の `funnel` が `off`。(2) `closed` で `send_to_owner` を呼んでも `push_outbox` の行ができず、SSE の `chat.created` は出る。(3) 窓口 `net` の台帳に、カレンダーの呼び出しが目的 `tool` で 1 行ずつ残る。(4) メインを偽の `openai_chatgpt` に割り当て、ルーチンを今すぐ動かす（API-136）と、偽の接続先の呼び出しが 0 件で、きっかけが `dropped`（`chatgpt_auto_off`）と `system` の行。チャットから頼むと呼ばれる。`chatgpt_allow_auto = true` にするとルーチンでも呼ばれる

## 終わる条件
| # | 確かめること | 方法（コマンド・操作） | 設計の参照 |
|---|---|---|---|
| S5-01 | UC-056 基本フロー：毎分のタイマーが `next_run_at` を過ぎたルーチンと `at` を過ぎた予約からきっかけ（`routine`・`scheduled`）を作り、ルーチンの次の時刻を計算し直す | 5.1・5.2 の確かめ。`wakes` の行と `next_run_at` を見る | UC-056、FR-094・095 |
| S5-02 | UC-056 代替 1a：止まっていて過ぎたルーチンは 1 回だけ動き、予約は全部動く | 試験用の時計を 1 時間進めて `wakes` を数える（単体） | UC-056、11 §11 単体、R-78 |
| S5-03 | UC-056 代替 2a：`propose_routine` → 確認のカード・Web Push → ○ でルーチンができ、メインは起きない。× と 7 日で消える | 5.1 の 4・5。`routine_proposals.status` の遷移を見る | UC-056、BR-13、states の `routine_proposals.status` |
| S5-04 | ルーチンの cron の次の時刻（タイムゾーン・月末・夏時間のある `tz`）と 15 分未満の拒否、20 本の上限 | `schedule.test.ts` | 11 §11 単体、D-221 |
| S5-05 | 予約の 5 分〜30 日・1 日 20 件・メインだけが持つ。`scheduled_wakes.status` の遷移（`pending → fired`・`cancelled`） | 単体と 5.2 の確かめ | BR-13、D-222、states の `scheduled_wakes.status` |
| S5-06 | `propose_routine`・`schedule_wake` は `tool_call_id` で 1 回だけ。再起動で `started` のまま残っても二重に作らない | 結合：歩みを `started` で止めて再起動 | D-249 |
| S5-07 | 汚染：汚染したターンの提案・予約から起きたターンは汚染から始まる。webhook は常に汚染 | 単体：`wakes.tainted` | D-245、FR-090 |
| S5-08 | 自動のきっかけの区分：`routine`・`scheduled`・`webhook` が `budget_class = 'auto'` で `wakes` に入り、`daily_auto_usd` に届いていれば `dropped`（`budget`）。持ち主の `chat` は通る | 単体：`daily_auto_usd` を小さくして 3 種を入れる | ADR-069、D-322、FR-013 |
| S5-09 | UC-057 基本フロー：署名を確かめ、配達 ID で重複を捨て、汚染つきで `wakes`（`webhook`）にし、メインが起きる | 5.3 の確かめ | UC-057、FR-096 |
| S5-10 | UC-057 例外 E1〜E3：受け口なし・止めてある → 404、署名違い → 401（何も残さない）、1 分 60 件超 → 429（何も残さない）、256KB 超 → 413 | `hooks.test.ts`（署名は GitHub・汎用の両方。汎用は時刻 5 分の境目） | UC-057、NFR-085、D-261・D-318、11 §11 単体 |
| S5-11 | 受付の重複（`source_key` の UNIQUE）：同じ配達が 2 回来ても 1 回だけ起きる。受け口が違えば同じ配達 ID でもぶつからない | 単体 | 11 §11 単体、D-261 |
| S5-12 | 隔離（Funnel 1）：インターネット側から 443 番に届かない | 5.4 の 5。`curl -m 10 -sv https://<host>/` | 11 §11 隔離、NFR-064、D-241 |
| S5-13 | 隔離（Funnel 2）：Funnel から :8080 の口（`/api/*`・`/`）に届かない | 5.4 の 5。`https://<host>:8443/` と `/api/health` が 404 | 11 §11 隔離、NFR-064・085 |
| S5-14 | 隔離（Funnel 3）：8443 番の `/hooks/<hookId>` がパスのまま :8081 に届く | 5.4 の 5。署名なしで 401、署名つきで 202、ログの経路 | 11 §11 隔離、D-305 |
| S5-15 | 受け口がなければ公開しない（`TS_FUNNEL=auto`）。`off` なら受け口があっても公開しない | 受け口を作る・全部消す・`off` にして 8443 番の `curl` | ADR-065、11 §10 |
| S5-16 | Web Push：`send_to_owner`・人の確認・交代の頼み（ステップ 4 で `push_outbox` に書く。送るのはここ）の 3 種だけを送る。オートレビューで通った操作・進捗は送らない。`tag` が同じものは置き換え | 単体と実の端末 | FR-017、D-229 |
| S5-17 | 送り待ちの再送：送る前に落としても、再起動後に送っていない行から送られる。購読ごとに 3 回まで。1 時間で `expired` | 単体（偽の送り手を失敗させる）と結合（送る前に本体を落とす） | D-267、11 §11 単体 |
| S5-18 | 購読ごとの送り待ちと `skipped`：見えている端末があれば同じ `notice_id` の行がすべて `skipped`。404・410 は購読を消して `failed` | 単体 | D-288、11 §11 単体 |
| S5-19 | NFR-086（送信）：`send_to_owner`・確認から Web Push の送信まで 5 秒以内 | `push_outbox.created_at` から `sendNotification` の完了までのログを 10 回 | NFR-086 |
| S5-20 | NFR-086（端末）：試しの通知を 10 回送り、端末に届くまでを目で測る（目安 30 秒。保証しない） | 設定の「試しに送る」（API-031 の `?test=1`）。結果を NFR-086 の横に書く | NFR-086 |
| S5-21 | UC-049 基本フロー：メインのカレンダー・GitHub の書き込みが Intent になり、Kernel が判定し、確認ののち gateway が書く | 5.6 の 9 | UC-049、FR-081、BR-06・BR-10 |
| S5-22 | `approval_done`：× と期限切れは決めたのと、○ は実行の結果を書くのと同じトランザクションで入り、メインが起きる。タスクの承認は今までどおりタスクを動かす | 結合：トランザクションの途中で落として、片方だけ残らないこと | D-248・D-275、API-019、11 §11 結合 |
| S5-23 | メインのターンの Intent・承認・判定の記録が `turn_id` を持ち、`task_id` との両方持ち・どちらも持たないは CHECK で拒否される。取り消したタスクの承認待ちは `expired`（D-250） | 単体：表の CHECK と D-250 | 08 変える表、D-250 |
| S5-24 | 実行の途中での再起動・二重の ○ で二重に書かれない。結果が分からないときは再試行しない | 結合 | 11 §11 結合、D-287 |
| S5-25 | OAuth：`state` の期限・1 回限り・Cookie の結びつき・PKCE・GitHub のインストールの照合。戻り先は ts.net の URL | 移した `connect` の試験と実の接続 1 回ずつ | FR-081、API-094・095 |
| S5-26 | 依存の検査：資格情報を読めるのは `gateway/` の中だけ | `pnpm lint:deps` | ADR-051、NFR-072 |
| S5-27 | `pnpm typecheck / test / lint:deps` が緑 | 同左 | 11 §11 |
| S5-28 | 旧コードが消えている：`apps/gateway`・`apps/gcal`・`apps/github`・`packages/gateway-client`・`packages/db` | 5.7 の確かめ。`git ls-files` が空 | 07 の移すもの |
| S5-29 | FR-101・D-341：`closed` では受け口があっても Funnel を付けない。tailnet の外から 8443 番につながらない。`closed` に切り替えたら外れる | 5.8 の確かめ (1) | FR-101・FR-096・D-341 |
| S5-30 | D-342：`closed` では Web Push の行を作らず送らない。通知は SSE で出る | 5.8 の確かめ (2)（単体と実の端末） | FR-017・D-342・R-102 |
| S5-31 | gateway の外向きが窓口 `net` を通り台帳に残る。`closed` で許可リストにない先は実行の前に断られる | 5.8 の確かめ (3) | FR-103・FR-101 |
| S5-32 | D-389：`chatgpt_allow_auto = false` で、ルーチン・予約・webhook のターンとそこから振り分けたタスクが `openai_chatgpt` を呼ばない。チャットからは呼ぶ | 5.8 の確かめ (4)（偽の接続先の結合） | FR-116 の 6・FR-107・D-389 |

## 実装で決めること
| 論点 | 設計の言い分 | おすすめ | 決めたら書く先 |
|---|---|---|---|
| cron のライブラリと表現・時間帯 `TZ` | cron の 5 欄・分は 15 分以上（D-221）。`tz` は IANA、既定 `TZ`（11 §10） | 5 欄だけ（秒・`@daily` は断る）。ライブラリは夏時間・月末を扱え `tz` を取れるもの（`croner` か `cron-parser`）を 1 つ選ぶ。15 分以上は次の 200 回の最小の間隔で検査する。`tz` は作るときに IANA で検査して行に持つ（後で `TZ` を変えても動かない） | 00 の決定事項ログに D-xxx、09 の API-125 |
| 今すぐ動かす（API-136）の `source_key` | `routine:<id>:<予定の時刻>`（FR-090） | 予定の時刻に「今の時刻」を使い `routine:<id>:<ミリ秒>` にする。`next_run_at` と `last_run_at` は動かさない | 09 の API-136 |
| GitHub の署名（`X-Hub-Signature-256`）の細部 | 本文の HMAC-SHA256 | `sha256=<小文字の hex>` を、生のバイト列に対して定数時間で比べる。`ping` の出来事は 202 を返し `wakes` は作らない。対応する出来事は `pull_request`・`pull_request_review`・`check_suite`・`workflow_run` から始める | 04 の FR-096、`hooks/summary.ts` の試験 |
| 汎用の署名の形（時刻と配達 ID） | `<X-Makase-Timestamp>.<X-Makase-Delivery>.<本文>` の HMAC-SHA256、時刻は 5 分以内（D-261） | `X-Makase-Signature-256: sha256=<hex>`、`X-Makase-Timestamp` は Unix 秒、`X-Makase-Delivery` は送り手が決める一意の文字列（128 字まで）。送る側の例（`curl` と `openssl`）を導入手順書に載せる | 09 の API-129、導入手順書 |
| `tailscale serve`/`funnel` の設定の持ち方 | `tailscale serve` で 443→:8080、`tailscale funnel --https=8443` で `/` ごと :8081（07） | コンテナの `TS_SERVE_CONFIG` に `serve.json`（`Web` の 443→:8080、8443→:8081、`AllowFunnel` の 8443）を持つ。`${TS_CERT_DOMAIN}` で ts.net の名前を差し込む | 07 のコンテナ表、`docker/tailscale/` |
| `TS_FUNNEL=auto` の「受け口があれば公開」を誰が動かすか | 受け口がなければ公開しない（ADR-065）。仕組みは書いていない | 本体と `tailscale` コンテナで共有する小さなボリューム `makase-funnel-state`（5.4 で `compose.yaml` に足す）に、本体が「公開してよいか」のファイルを書き、`tailscale` の起動スクリプトが見て `funnel` を付け外しし、結果の状態（公開中か・ts.net の名前）を別のファイルに書き返す。本体に Tailscale のソケットは渡さない（権限が増える） | 07 のコンテナ表、FR-083 の Funnel の状態 |
| ts.net の名前（OAuth の戻り先・受け口の URL）の作り方 | 戻り先は ts.net の URL（07）。`.env` に名前の変数はない（11 §10） | `tailscale` コンテナが書き返すファイルの証明書のドメインを本体が読む。取れないときの上書きに `PUBLIC_BASE_URL` を足す | 11 §10 の環境変数の表 |
| Google の OAuth が ts.net の戻り先を受けるか | 戻り先は ts.net の URL | 最初に Google Cloud のコンソールに `https://makase.<tailnet>.ts.net/api/v1/connect/google/callback` を登録できるかを確かめる。通らなければ代わりの戻り先（設計に戻す） | 00 の決定事項ログ、07 の外部連携 |
| `web-push` の版と VAPID の鍵の生成 | 鍵は手順書の作り方で作る（11 §10）。ライブラリは書いていない | `web-push` の最新の安定版を `pnpm add` で固定する。鍵は `npx web-push generate-vapid-keys` で 1 度だけ作り、公開鍵・秘密鍵を `.env`（600）に入れる。作り直すと全購読が無効になるので、再作成の手順に「購読し直す」を書く | 11 §10、導入手順書 |
| 試しの通知（`?test=1`）の送り方 | 設定画面から試しに送る（API-031） | その購読だけへ `push_outbox` を通さずに直接送る。NFR-086 の 5 秒の測りは `send_to_owner` の実際の行で別に取る | 09 の API-031 |
| 送り直しの待ち | 購読ごとに 3 回まで・1 時間で期限切れ（D-267） | 待ちは 5 秒・30 秒・2 分 | 11 §11、09 |
| 心拍と SSE の端末の結びつき | 心拍が 60 秒以内で、その端末の SSE がつながっている（API-121）。`deviceId` と SSE をどう結ぶかは書いていない | SSE を開くとき `?deviceId=` を付けさせ、接続の間だけメモリの表に覚える。本体の再起動で心拍は消え、次の 30 秒の心拍で戻る | 09 の API-121、ステップ 6 の SSE |
| 既存の MCP サーバー（`apps/gcal`・`apps/github`）を残すか消すか | gateway は本体の中の部品（ADR-051）。コンテナは 2 つ（D-326） | 消す。ツールの関数（`callGcalTool`・`callGithubTool`）だけを `gateway/` に移し、MCP は使わない。`connector_tools` は接続のときに manifest から入れ、`sync.ts`・`tool-change.ts` は消す | ADR-051 の影響、07 の移すもの |
| `provenance.ts`（承認の出どころの照合）を残すか | 設計に記述なし（旧 Node 版の `apps/gateway` の決まり） | 消す。SQLite にはロールの分離がなく、同じプロセスなので意味が薄い。`approved` のときだけ実行・`intentHash` の再計算・依存の検査で守る | ADR-051 の影響 |
| 偽の MCP サーバーを使う旧 `flow.test.ts` の扱い | 11 §11 の結合は「偽の box-manager」 | 偽の Google・偽の GitHub の `fetch` を差し込む形に書き直す | 11 §11 |
| 承認の期限と拾い直しの間隔 | 確認には期限がある。値は設計に書いていない | 旧コードの値：期限 24 時間・拾い直し 30 秒 | 09 の API-019、`gateway/approvals.ts` |
| 自動のきっかけの割り当てが `openai_chatgpt` のときの扱い（D-389） | 自動のきっかけは家の中のモデルか API キーで動かす（FR-107 の 9）。一方 API-152 は「自動のきっかけで始まる仕事の役割は `openai_chatgpt` を選べない」とし、役割は 1 つの割り当てしか持たない | 割り当ては断らず（メインを ChatGPT にできないと非エンジニアの既定の道がなくなる）、実行のときにきっかけを `dropped`（`chatgpt_auto_off`）にして知らせる。自動のきっかけ用に別の割り当てを持たせるかは設計に戻す | FR-107 の 9・API-152・D-389 の補足 |
| `closed` の通知を家の中の ntfy で出すか | 任意（FR-017・R-102） | 初版は SSE だけ。ntfy はステップ 9 の閉域の 1 日の試験で要るとわかったら足す | FR-017・R-102 |
| 実機の Web Push の確かめ方 | iOS はホーム画面に追加した PWA だけ（ADR-067） | Android の Chrome と iOS の両方で 1 回ずつ。結果を NFR-086 の横に書く | NFR-086、導入手順書 |

## 設計に戻すこと
- [ADR-065](../design/adr/ADR-065-webhook-funnel.md) の決定の本文に、v1.1 のまとめ・1 時間 600 件・本文のハッシュによる重複が残っている（D-318 で消した）。1 分 60 件で 429・重複は `source_key` だけ、に直す
- Funnel の付け外しの仕組み（本体 → `tailscale`）と ts.net の名前の取り方を決めたら、07 のコンテナ表と 11 §10 の環境変数の表に足す
- API-136 の `source_key`、API-031 の `?test=1` の意味、API-121 の `deviceId` と SSE の結びつきを決めたら、09 の表に 1 行ずつ足す
- Google が ts.net の戻り先を受けなければ、07 の外部連携と FR-081 を直す
- D-389 の割り当てと実行の扱い（上の表）を FR-107 の 9・API-152 の `chatgpt_auto_off` にそろえて書き直す。
- 00 の D-305 の横に、Funnel を通してパスの頭が落ちなかった結果を書く。NFR-086 の横に実測を書く

## 参照
- 設計：[FR-094〜096・FR-017・FR-090・FR-091](../design/04_functional_spec/resident.md)、[FR-081・FR-083](../design/04_functional_spec/tools.md)、[TBL-041・044〜046・054・055](../design/08_database/resident.md)、[TBL-037](../design/08_database/vm.md)、[変える表](../design/08_database/README.md)、[API-121・125〜129・136・139・140・142](../design/09_api/resident.md)、[API-094・095](../design/09_api/vm.md)、[API 一覧（API-019・031・032・093・107・137）](../design/09_api/README.md)
- 図・業務：[UC-057・056・054 4a のシーケンスと状態](../design/10_diagrams/sequences.md)・[states](../design/10_diagrams/states.md)、[UC-049・056・057 と BR-13](../design/03_use_cases.md)、[NFR-064・085・086](../design/05_non_functional.md)、[07 アーキテクチャ](../design/07_architecture.md)、[11 §10・§11](../design/11_tech_spec.md)、[FR-101・FR-116](../design/04_functional_spec/resident.md)、[決定事項ログ（D-203・207・221〜223・229・241・248・261・267・275・287・288・305・318・322）](../design/00_overview.md)
- ADR：[ADR-051](../design/adr/ADR-051-gateway-in-core.md)・[ADR-065](../design/adr/ADR-065-webhook-funnel.md)・[ADR-067](../design/adr/ADR-067-web-push-first.md)・[ADR-069](../design/adr/ADR-069-daily-auto-budget.md)・[ADR-074](../design/adr/ADR-074-closed-network.md)・[ADR-084](../design/adr/ADR-084-sign-in-with-chatgpt.md)
- 移す元のコード：`apps/gateway/src/`（`execute.ts`・`reads.ts`・`context.ts`・`mcp.ts`・`result-text.ts`・`origin.ts`）、`apps/gcal/src/`（`tools.ts`・`calendar.ts`・`slots.ts`）、`apps/github/src/`（`tools.ts`・`github.ts`）、`packages/gcal-core`・`github-core`・`gateway-client`、`apps/app/src/routes/connect.ts`・`connect-github.ts`・`approvals.ts`、`apps/app/src/connectors/`、`apps/app/src/check/`（`decide.ts`・`tick-step.ts`・`recheck.ts`）、`apps/app/src/tick.ts`、`apps/worker/src/db/repo/gateway.ts`・`edge/intents.ts`・`views/connectors/known.ts`、`packages/kernel/src/approvals.ts`（期限の計算の参考）
- 前後のステップ：[03_core_port.md](03_core_port.md)（:8081 と `tailscale`）、[04_resident.md](04_resident.md)（受付・ターン・`push_outbox`）、[06_web.md](06_web.md)（購読と心拍の画面）、[07_terminal_pack_snapshot.md](07_terminal_pack_snapshot.md)（交代の通知はステップ 4 で `push_outbox` に書き、送るのは 5）、[09_release.md](09_release.md)（隔離の試験の通し・導入手順書）
