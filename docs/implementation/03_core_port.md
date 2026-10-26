# ステップ 3. 本体の土台
- プロジェクト：Agent-Team-Open ／ 手順書の版：v1.1（2026-10-25） ／ 設計の版：v1.5 ／ インプット：[07 アーキテクチャ](../design/07_architecture.md)、[08 DB設計](../design/08_database/README.md)、[09 API設計](../design/09_api/README.md)、[04 tools](../design/04_functional_spec/tools.md)、[05 非機能](../design/05_non_functional.md)、[11 技術仕様書](../design/11_tech_spec.md)、[ADR-042](../design/adr/ADR-042-node-sqlite.md)・[046](../design/adr/ADR-046-tailscale-identity.md)・[049](../design/adr/ADR-049-docker-compose.md)

> **3行で**
> 1. Cloudflare 版の `apps/worker` を Node 24＋Hono＋`better-sqlite3` の `apps/makase`（本体）に移し、Compose 一式（tailscale・makase・box-manager・docker-socket-proxy・egress・VM）で起動して、Tailscale の身元で入り、ホストと VM の状態が見えるところまで進める。依頼（asks）・Workflows・D1・Google ログインは外す。
> 2. 作るのは `apps/makase`（`WsDb` の作り直し・マイグレーションとバックアップ・`db/repo`・`edge`・`llm`・`agents` の移植・持ち主の確かめ・SSE・監査ログ・状態・設定の API）、08 の変える表と新しい表の骨組み、ルートの `compose.yaml`・`compose.dev.yaml`、本体 ↔ box-manager のつなぎ。常駐の仕組み（`wakes`・`turns`・ターン・タスクの実行）はステップ 4。
> 3. 終わる条件：`docker compose up -d` で 60 秒以内に `/api/health` が ok、Tailscale 経由の `/api/v1/session` が持ち主を返し LAN の直アクセスは届かず、`pnpm typecheck / test / lint:deps` が緑。

## 前提（始める条件）
- **入力**：ステップ 1・2 が終わっている（[01](01_vm_vertical.md)・[02](02_risky_actions.md)）。ステップ 1 の成果を使う：`apps/box-manager`（API-101〜103・105・106・109）・`apps/egress`・`docker/box-browser`・`docker/box-shell` のイメージ・暫定の `compose.vm.yaml`・`packages/llm/src/claude.ts`（`ClaudeClient` はここへ移し済み。本体はここから使う：D-315）。ステップ 2 の成果を使う：`packages/kernel/src/browser.ts`（`BrowserPolicy` ほか）・`packages/browser-guard`（`better-sqlite3` の小さな DB に `browser_actions`・`browser_checks`・`auto_reviews` と最小の `boxes`・仮の `tasks`）。触らない：常駐の仕組み（ステップ 4）、ルーチン・webhook・Web Push の送り手・カレンダー/GitHub の gateway（ステップ 5）、画面（ステップ 6。今の `apps/web` は新しい API に合わない画面があってよく、`index.html` が配られれば足りる）、控え・戻す・作り直す・ブラウザのデータを消す（ステップ 7）。
- **機械**：置き先は段 1（手元の WSL2、amd64。WSL のディストリの中の Docker Engine と Compose v2）。Node 24、pnpm 10（`corepack enable`）、Docker Engine 24 以上。
- **鍵とアカウント**：Tailscale のアカウント（`TS_AUTHKEY`。tailnet の HTTPS を有効にしておく）、`ANTHROPIC_API_KEY`、`OWNER_LOGIN`（自分の Tailscale のログイン名）、`BOX_MANAGER_TOKEN`・`ENCRYPTION_KEY`（`openssl rand -base64 32`）。

## 作るもの
「移す元」は実際に開いて確かめた名前。`apps/worker/src/<dir>` を `apps/makase/src/<dir>` に移すのが基本で、違うところだけ書く。

| 部品 | 置き場 | 移す元（あれば） | 設計の参照 |
|---|---|---|---|
| 本体の入口（起動・待ち受け・停止・環境変数・ログ） | `apps/makase/src/main.ts`・`app.ts`・`env.ts`・`log.ts`・`package.json`・`Dockerfile` | `apps/app/src/server.ts`（`serve`・`startPeriodic`・SIGTERM の閉じ方）、`app.ts`（ミドルウェアの順・静的配信）、`env.ts`（`EnvReader`）、`http.ts`（`securityHeaders`・`noStore`・`API_BODY_LIMIT_BYTES`）。`apps/worker/src/index.ts` の `createApp` | [11 §10](../design/11_tech_spec.md#10-環境設定)、NFR-079 |
| SQLite 接続 `WsDb` | `apps/makase/src/db/sqlite.ts` | `apps/worker/src/db/sqlite.ts`（`all`・`one`・`run`・`count`・`newId`・`isUniqueViolation`・`isCheckViolation`・`isForeignKeyViolation`・`isTriggerAbort`）。`wsDbOf`・`SqlStorage` を `better-sqlite3` に置き換える | [08 方針](../design/08_database/README.md#方針)、ADR-042 |
| スキーマ・マイグレーション・バックアップ | `db/schema.ts`・`db/migrate.ts`（新規）・`db/backup.ts`（新規） | `db/schema.ts`（`MIGRATIONS` の版 1〜3、`NOW`・`oneOf` など）、`workspace-do.ts` の `migrate()` | NFR-070・077、FR-083 |
| 表の読み書き | `db/repo/*`・`db/types.ts`・`db/codecs.ts`・`db/workspace.ts`・`db/audit.ts`・`db/tokens.ts` | 同名。`repo/` は `agents`・`app`・`check`・`costs`・`credentials`・`edge`・`gateway`・`web-urls`・`cleanup`・`scans`・`system-agents`・`sandbox` だけ移す。`asks.ts`・`evolution.ts` は移さない（消す側）。そこにある `appendAgentSnapshot`・`findLiveAgentByIdOrName` は `db/repo/agents.ts` へ、`touchSkillUsed` は `db/repo/agents.ts`（`agent_skills` を扱う側）へ移す | FR-016 |
| edge（移す） | `edge/` | `apps/worker/src/edge/` の `events`・`halt`・`inputs`・`limits`・`llm-call`・`rate-limit`・`schema-check`・`skill-trust`・`tokens`・`util`・`validate`（そのまま） | [07 レベル3](../design/07_architecture.md#レベル3本体のコンポーネント図) edge |
| edge（移して直す） | `edge/` | 同名の `context`・`intents`・`policy-summary`・`proxy`・`runtime`・`spend`・`task-edge`・`tools`・`web-seen`（asks への依存・`per_day_usd`・`max_concurrent_tasks`・`DEFAULT_AGENT_MODEL` などを直す。`web-seen` は下の `packages/edge` のものと比べて 1 本にする） | 3.3 |
| edge（消す） | なし | `edge/fault.ts`（値返しをやめる）・`edge/sandbox-command.ts`（旧 Sandbox 向け。移さない） | 3.3 |
| `web_search`・`web_fetch` の中身 | `edge/web.ts`・`edge/web-page.ts`・`edge/web-seen.ts` | `packages/edge/src/web.ts`・`web-page.ts`・`web-seen.ts` と試験（`web.test.ts`・`web-page.test.ts`・`web-seen.test.ts`・`web-tainted.test.ts`）。`packages/edge` を消す前に移す。`web_fetch` の egress と同じアドレスの判定とリダイレクト先の再判定（D-164）はここで作る。道具として渡すのはステップ 4 | FR-080、D-164 |
| LLM の口 | `llm.ts`（`llmOf`・`setLlmForTest`） | `apps/worker/src/llm.ts`。クライアントは `packages/llm/src/claude.ts`（ステップ 1 で移し済み）。`Env` を `process.env` の読み取りに変える | ADR-056（取り下げ）、D-315 |
| つながりの一覧の元 | `views/connectors/known.ts` | 同名（`KNOWN_CONNECTORS`。ステップ 5 の gateway が使う） | FR-081 |
| エージェント | `agents/create.ts`・`agents/remove.ts`・`views/agents/` | 同名。`create.ts` が使う `policyLinesOf`（`asks/generate.ts`）・`normalizeGrants`・`PlannerConnector`（`asks/planner.ts`）は `agents/` の中へ切り出す | FR-072 |
| 画面向けの API（`/api/v1`） | `routes/router.ts`・`routes/agents.ts`、新規 `routes/session.ts`・`host.ts`・`vm.ts`・`counts.ts`・`events.ts`・`audit.ts`・`settings.ts`・`files.ts` | `routes/router.ts`（`apiRouter`・`readJsonBody`・`idParam`）・`routes/agents.ts`。`apps/app/src/routes/audit.ts`（一覧とカーソル）・`stream.ts` | [09](../design/09_api/README.md)（API-023・041・080・081・082・083・085・088・096・099・100・111・112） |
| 持ち主の確かめ（FR-073） | `auth/owner.ts`（新規） | `auth/routes.ts` の `sameText`（定数時間の比較）だけ。ほかの `auth/` は消す | FR-073、ADR-046 |
| SSE と事象の合図 | `events/hub.ts`（新規）・`routes/events.ts` | `apps/app/src/sse.ts`（`formatSseEvent`・`parseLastEventId`・`workspaceStream`）、`db/repo/app.ts` の `appendWorkspaceEvent`・`listWorkspaceEventsAfter`・`latestWorkspaceEventId`・`workspaceEventExists` | FR-018、API-085 |
| タイマーの枠 | `timer.ts`（新規） | `apps/app/src/server.ts` の `startPeriodic`、`db/repo/cleanup.ts` | [07 timer](../design/07_architecture.md#レベル3本体のコンポーネント図) |
| box-manager のクライアント | `box/client.ts`（新規） | なし（API-101・102・109 を `BOX_MANAGER_TOKEN` つきで呼ぶ） | [09 vm 内部 API](../design/09_api/vm.md) |
| :8081 の口（webhook 用。中身は空） | `hooks-port.ts`（新規） | なし | ADR-065、D-305 |
| こわい操作の表と関数 | `guard/` | `packages/browser-guard`（ステップ 2）を取り込む（確定）。`WsDb` を受ける形にし、DDL は版 5 に寄せ、パッケージは消す | 3.4 |
| box-manager の変更 | `apps/box-manager` | ステップ 1 の API-109 の応答に `images: { browser, shell }` を足す（FR-083・UC-042 のイメージの有無） | [09 vm 内部 API](../design/09_api/vm.md)、FR-083 |
| Compose 一式・Tailscale の設定 | `compose.yaml`・`compose.dev.yaml`・`docker/tailscale/serve.json`・`.env.example` | ルートの `compose.yaml`（db だけ）・`compose.vm.yaml`（ステップ 1。3.6 で `compose.yaml` に取り込んだあと消す）・`.env.example`（旧 Node 版の値）・`apps/sandbox/Dockerfile`（digest 固定の作りを真似る） | ADR-049、[07 コンテナ図](../design/07_architecture.md#レベル2コンテナ図) |
| 試験 | `apps/makase/test/` と `src/**.test.ts` | `apps/worker/test/`（8,137 行。`inWorkspace` が workerd の DO の中で動かしていたものを、メモリ上の `better-sqlite3` に替える） | [11 §11](../design/11_tech_spec.md#11-テスト方針) |

- **消すもの（`apps/worker/src` のうち移さない）**：`asks/`・`workflows/`・`auth/`（`sameText` 以外）・`views/asks/`・`routes/asks.ts`・`workspace-do.ts`（中身は上の部品に分ける）・`db/repo/asks.ts`（`appendAgentSnapshot`・`findLiveAgentByIdOrName` は `db/repo/agents.ts` へ出す）・`db/repo/evolution.ts`（`touchSkillUsed` だけ `db/repo/agents.ts` へ出す）・`edge/fault.ts`・`edge/sandbox-command.ts`・`write.ts`（例外に戻す場合）・`schedule.ts`（asks の定期用。ステップ 5 のルーチンが必要なら `kernel` の `parseCronSchedule` から作る）・`wrangler.jsonc`・`worker-configuration.d.ts`・`.dev.vars.example`・`migrations/0001_users_sessions.sql`（D1）・`vitest.config.ts`（workerd 用）。
- **`packages/*` でそのまま使う**：`kernel`・`runner`・`llm`・`platform`（`ServiceName` に `makase` を、エラーコードに `NOT_OWNER`・`CSRF_REJECTED`・`MAIN_AGENT` を、`SECRET_ENV_NAMES` に `BOX_MANAGER_TOKEN`・`ENCRYPTION_KEY`・`TS_AUTHKEY` を足す）・`gcal-core`・`github-core`・`sandbox`。
- **消す（ステップ 3 の最後。3.7 の手順 1）**：`apps/app`・`apps/worker`・`packages/edge`・`packages/browser-guard`（3.4 で取り込み済み）・`compose.vm.yaml`（3.6 で取り込み済み）。
- **消す（ステップ 5 の最後。5.7）**：`packages/db`・`apps/gateway`・`apps/gcal`・`apps/github`・`packages/gateway-client`。`apps/gateway` が `packages/db` を使っている間は `packages/db` を消せない（「実装で決めること」）。

## 手順
### 3.1 `apps/makase` の骨組み（起動・`.env`・ログ・`/api/health`）
いちばん小さく、あとの区切りの足場になる。
1. `pnpm-workspace.yaml` の `onlyBuiltDependencies` に `better-sqlite3` を足す（arm64 の prebuilt があること、公開から 3 日以上たった版であることを見る）。`workerd` は手順 3.7 で外す。
2. `apps/makase/package.json`（名前 `@open-team/makase`、`type: module`）。scripts は `dev`（`node --watch --env-file-if-exists=../../.env src/main.ts`）・`start`（`node src/main.ts`。ビルドせず `.ts` を動かす。今の `apps/app` と同じ）・`typecheck`・`test`。依存は `apps/worker/package.json` の `hono`・`zod`・`@open-team/*` に `@hono/node-server`・`better-sqlite3` を足し、`wrangler`・`@cloudflare/vitest-plugin` は持ち込まない。`tsconfig.json` は `apps/app/tsconfig.json` を写す。
3. `env.ts`：`EnvReader` で [11 §10](../design/11_tech_spec.md#10-環境設定) の表を読む。必須が足りなければ、**名前だけ**を JSON の行で出して終了コード 1 で止まる（UC-042 E2。`apps/app` の「準備中」を返す作りは使わない）。`ENCRYPTION_KEY`・`BOX_MANAGER_TOKEN` は 32 文字以上を確かめる。表にない値（`DATA_DIR` 既定 `/data`、`LISTEN_ADDR`、`BOX_MANAGER_URL` 既定 `http://box-manager:7000`、`WEB_DIST`、`COMMIT_SHA`）は読み方だけ決めておく（「設計に戻すこと」）。
4. `log.ts`：`createLogger({ service: "makase" })` で JSON の行を標準出力に。`requestContext` でアクセスログと `X-Request-Id`。秘密は `knownSecretsFromEnv` でマスクする（NFR-079）。
5. `app.ts`：`securityHeaders`→`requestContext`→`errorHandler`→`notFoundHandler`→`/api`（`noStore`・本文 64KB の上限）の順。`GET /api/health` は確かめなしで `{ "ok": true, "version": … }` だけを返す（API-082）。
6. `main.ts`：起動の順を 1 か所に書く（下の 3.5 の手順 1）。`serve({ fetch, port: 8080, hostname: LISTEN_ADDR })`。SIGTERM・SIGINT で `server.close()`・タイマー停止・DB を閉じる。
確かめ：`pnpm --filter @open-team/makase dev` で起動し、`curl localhost:8080/api/health` が ok。`ENCRYPTION_KEY` を消して起動すると、名前だけが出て止まる（値はログに出ない）。

### 3.2 `WsDb` を `better-sqlite3` で作り直す・表をそのまま作る・マイグレーションとバックアップ
1. `db/sqlite.ts`：`WsDb` は `{ conn: Database, transaction(fn) }` にする（`SqlStorage` の `exec(...).toArray()` をなくす）。`all` は `prepare().all()`、`one` は先頭 1 行、`run` は `info.changes` を返す（`SELECT changes()` は要らない）。引数の変換は今の `encode` を写し、`Uint8Array`・`ArrayBuffer` は `Buffer` にして渡す。`transaction` は `conn.transaction(fn)()` で、入れ子は savepoint になる（今の `transactionSync` と同じ）。
2. 接続の設定は [08 方針](../design/08_database/README.md#方針)のとおり、`journal_mode=WAL`・`synchronous=FULL`・`foreign_keys=ON`・`busy_timeout=5000`。ファイルは `$DATA_DIR/makase.db`。
3. 制約違反の見分け：`better-sqlite3` はメッセージに `: SQLITE_…` が付かず、種類は `e.code`（`SQLITE_CONSTRAINT_UNIQUE`・`SQLITE_CONSTRAINT_CHECK`・`SQLITE_CONSTRAINT_FOREIGNKEY`・`SQLITE_CONSTRAINT_TRIGGER`）に出る。`isTriggerAbort` は今 `message` に `SQLITE_CONSTRAINT_TRIGGER` を探すので、`e.code` で見るよう直す。`isUniqueViolation(e, "agents.name")` などの対象の取り出しはメッセージの形（`UNIQUE constraint failed: agents.name`）で確かめる。`apps/worker/test/db/constraints.test.ts` を移して通す。
4. `db/schema.ts` は**そのまま**移し、`MIGRATIONS` の版 1〜3 を変えない（当てたあとの中身は書き換えない）。`db/migrate.ts`：`schema_migrations` を読み、足りない版を 1 つずつ流す。流す前に、すでに版が 1 つ以上入っている DB（初回でない）なら `db/backup.ts` でバックアップを取る（NFR-077）。表を作り直す版は `PRAGMA foreign_keys=OFF` を**トランザクションの外**で設定してから流し、終わったら `PRAGMA foreign_key_check` が空であることを確かめて `ON` に戻す（`foreign_keys` はトランザクションの中では変わらない）。
5. `db/backup.ts`：`VACUUM INTO '$DATA_DIR/backups/makase-<日時>.db'`（トランザクションの外）→ コピー先で `PRAGMA integrity_check` が `ok` → 7 世代を超えた古いものを消す（NFR-070）。同じ関数を毎日のタイマー（3.5）からも呼ぶ。
6. 試験の土台：`apps/worker/test/db/fixtures.ts` の `inWorkspace` を、`new Database(":memory:")`＋`migrate` で作った `WsDb` を渡す形に替える。再起動・バックアップの試験だけ一時ファイルを使う。
7. FTS5 の確かめだけ先に：`CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')` と日本語 2 文字以上の `MATCH` が通る試験を 1 本置く（記憶の検索：ステップ 4 の前提）。
確かめ：移した `db/` の試験（`audit`・`constraints`・`app`・`edge`・`check` など）が `better-sqlite3` の上で緑。空の DB に版 1〜3 を流すと `schema.ts` の全表・トリガーができる。バックアップを取ると別ファイルができ、`sqlite3` で開ける。

### 3.3 `db/repo`・`edge`・`llm`・`agents` を移す・値返しを例外に戻す
1. `db/repo/*`・`edge/`・`agents/`・`views/agents/`・`llm.ts` を `apps/makase/src` に移し、import の先と型（`Env`・`DurableObjectStub`）だけ直す。`Env` は `process.env` を読んだ設定の型に替える。`crypto.randomUUID` はそのまま使える。
2. 値返しを例外に戻す（決め方は「実装で決めること」）：`runIdempotent` は `AppError` を投げ、成功は `{ status, body, replayed? }` を返す。`edge/fault.ts`（`captureEdge`・`unwrapEdge`・`EdgeOutcome`）は消し、edge の関数は `EdgeError` をそのまま投げる（ステップ 4 の実行役が `EdgePort` として直接呼ぶ）。`write.ts`（`WriteResult`・`captureAppError`・`unwrapWrite`）も消し、`routes/router.ts` の `reply` は `c.json(body, status)` だけにする。
3. `agents/create.ts` の「DO で上限と材料 → LLM → DO で保存」の 3 段は、LLM をトランザクションの中で呼ばない決まり（G-14）のために残す。`DurableObjectStub<WorkspaceDO>` を受けていた引数は、`WsDb` を受ける関数に替える。
4. asks への依存を切り離す（消すのは 3.4）：`agents/create.ts` の `policyLinesOf`・`normalizeGrants`、`edge/task-edge.ts` の `emitAskEvent`・`stageStateOf`、`edge/context.ts` の編成（`ask_members`）、`edge/tools.ts` の窓口の判定（`kind = answer`）、`edge/intents.ts` の `getAskRow`、`views/agents/view.ts` の `listAgentAsks`・`bornAskId`・`evolution`、`agents/remove.ts` の定期の依頼を止める処理を、`task.ask_id === null` の道だけが残る形に直す。窓口の `answer` の報告と `nextActions` は使わない（`report_kind` は `normal`）。
5. `llm.ts`：`ANTHROPIC_API_KEY` がなければ呼ぶ前に断るクライアント（今の `unavailableLlm`）を残す。モデルは `CLAUDE_MODEL` の代わりに既定の `claude-opus-5-5` とオートレビュー用の `CLAUDE_REVIEW_MODEL`（既定 `claude-sonnet-5-5`）。クライアントを作る場所は 1 か所（D-315）。`edge/runtime.ts` が `packages/llm` の `DEFAULT_AGENT_MODEL`（今は Gemini の名前）に頼らないよう、`llmOf` で必ずモデルを渡す。
6. `web_search`・`web_fetch`（FR-080）：`packages/edge/src/web.ts`・`web-page.ts`・`web-seen.ts` を試験ごと `apps/makase/src/edge/` に移す。`packages/edge` を消す前（3.7）に移す。`web_fetch` の egress と同じアドレスの判定とリダイレクト先の再判定（D-164）はここで作る（`apps/egress` の規則と同じ表にそろえる。共有のしかたは「実装で決めること」）。`apps/worker/src/edge/web-seen.ts` と同名なので 1 本にする。道具として渡すのはステップ 4。
確かめ：`apps/worker/test/` の `edge/`・`agents/`・`llm/`・`db/` の試験と、`packages/edge` の `web` 系の試験が `apps/makase/test/` に移って緑（asks・workflows・views/asks・auth の試験は移さない）。`grep -rn "cloudflare:\|DurableObject\|WriteResult\|EdgeOutcome" apps/makase/src` が空。

### 3.4 依頼を外す・`tasks` に列を足す・新しい表の骨組み（版 4・5）
1. `asks/`・`workflows/`・`auth/`・`views/asks/`・`routes/asks.ts`・D1 の `users`・`memberships`・`sessions` を移さない（作らない）。`apps/makase` に `asks` の文字が残るのは `schema.ts` の版 2 と型の定義だけにする（`grep -rn "asks" apps/makase/src` で確かめる）。
2. **版 4（変える表）**：[08 変える表](../design/08_database/README.md#変える表)を 1 つの版にする。SQLite は CHECK を ALTER できないので、`usage_records` を直した版 3（`USAGE_OWNER_RELAX`）と同じく「新しい表を作る→写す→元を落とす→名前を替える→索引とトリガーを作り直す」で行う。対象：
 - `tasks`：`job_id` を NULL 可、`trigger_type` の CHECK に `delegate` を足す（今は `manual`・`schedule`・`dry_run`・`ask`。`tasks_dry_run_trigger_chk` はそのまま）、`halt_reason` の CHECK に `vm_replaced`、列 `turn_id`（FK `turns`）・`tool_call_id`（UNIQUE）・`title`・`brief`・`delegate_reason`・`budget_class`・`paused_ms` を足す。`status` の値・`report` の 50,000 字・`tasks_report_kind_chk` は変えず、トリガー `tasks_taint_monotonic` を作り直す（D-254・D-283）。
 - `usage_records`（`phase` の CHECK に `turn`・`task`・`review`・`memory`・`summary`、列 `turn_id`・`budget_class`・`cache_*_tokens`・`cache_expected`）、`action_intents`・`approvals`・`policy_decisions`（`task_id` を NULL 可＋`turn_id`＋「どちらか一方」の CHECK）、`task_events`（種類の CHECK）、`sandbox_commands`（`session_id` を `box_id` に）、`workspace`（`owner_login`・`max_tasks`・`snapshot_hour`・`vm_op`・`vm_op_started_at`・`vm_home_state`）。`agents` は `ADD COLUMN`（`kind`・`description`・`created_by`・`instruction_addendum`）と、`kind = 'main'` の部分 UNIQUE の索引。
 - 流す前に `PRAGMA foreign_keys=OFF`、あとに `foreign_key_check`（3.2 手順 4）。
3. **版 5（新しい表の骨組み）**：[resident](../design/08_database/resident.md) の TBL-041〜047・050〜055（`wakes`・`turns`・`chat_messages`・`routines`・`routine_proposals`・`scheduled_wakes`・`webhooks`・`memory_facts`・`memory_search`・`auto_reviews`・`vm_snapshots`・`context_snapshots`・`push_outbox`）と、[vm](../design/08_database/vm.md) の `boxes`・`browser_actions`・`takeovers`・`push_subscriptions`・`task_steps`・`browser_checks`。列と制約は 08 のとおり。ステップ 2 が作った `browser_actions`・`browser_checks`・`auto_reviews` の DDL はここへ 1 本にまとめる（二重に作らない）。新しい表の ID は UUIDv7（`newId()` を時刻順の UUID を返す関数に替える）。`workspace_policies` の既定の 1 行（版 1）は 3.5 の起動で入れる。
4. 骨組みなので、表は空のまま。中身を使う処理（受付・ターン・歩みの記録）は書かない。
5. 試験：D-254・D-283 の行が保存できること（`job_id` なし・`trigger_type = 'delegate'`・`requester_id` にメインの ID・`agent_snapshot_id`・`report_kind = 'normal'`）、`action_intents` の「`task_id` と `turn_id` のどちらか一方」の CHECK、止まっていない `boxes` が 2 つ入らないこと、`audit_logs` の追記だけのトリガーが版 4 のあとも生きていること。
6. `packages/browser-guard` を `apps/makase/src/guard/` に取り込む：`better-sqlite3` の小さな DB を持つ部分を、`WsDb` を受ける形に直す。表の DDL（`browser_actions`・`browser_checks`・`auto_reviews`・最小の `boxes`・仮の `tasks`）は持たず、手順 3 の版 5（と版 4 の `tasks`）を正にする。試験の土台は 3.2 手順 6 の `WsDb` に替える。移したら `packages/browser-guard` を消し、参照している `package.json` の依存と `pnpm-workspace.yaml` を直す。
確かめ：空の DB に版 1〜5 を流して `foreign_key_check` が空。古い版（版 3 まで）の DB に版 4・5 を流しても同じ結果になる（バックアップが先に取られる）。3.3 までの試験が版 5 の上で緑のまま。`guard/` の試験が `WsDb` の上で緑。`ls packages/browser-guard` が見つからない。

### 3.5 持ち主の確かめ・起動の確かめ・状態・SSE・監査ログ・エージェント・設定
#### 3.5.a 起動の順と FR-073・API-083
1. **起動の順**（`main.ts`）：(1) 環境変数 (2) 64bit（`process.arch` が `x64`・`arm64`）とメモリ（UC-042 E1）。足りなければ理由を JSON の行で出して止まる (3) DB を開く→バックアップ→マイグレーション (4) `workspace` がなければ作り（`owner_login` に `OWNER_LOGIN`、監査ログ `workspace.created`、`workspace_policies` の版 1）、あれば `owner_login` を比べ、違えば止まる（`OWNER_LOGIN_REPLACE=1` のときだけ上書き：D-170） (5) メインのエージェントがなければ作る (6) box-manager に届くか・VM のイメージがあるかを確かめる（届かなくても起動する。API-111 に出す） (7) :8080 と :8081 で待ち受け (8) タイマー開始。
2. **FR-073**（`auth/owner.ts`）：`/api/v1/*` の全部に、`Tailscale-User-Login` を `OWNER_LOGIN` と大文字小文字を区別せず比べる（なし・違いは 403 `NOT_OWNER`）。GET 以外は `Origin` が自分の URL（`Host` ヘッダーから作る）かつ `X-Makase-Request: 1`（外れは 403 `CSRF_REJECTED`）。`/api/health` だけ除く。`:8081` は別の `Hono` で、すべて 404 を返す空の受け口にする（`POST /hooks/:hookId` の中身はステップ 5）。身元のヘッダーは読まない。
3. **API-083**：`GET /api/v1/session` で持ち主のログイン名と表示名（`Tailscale-User-Name`、なければログイン名）。
確かめ：必須の値を 1 つ消すと名前だけ出て止まる。`curl` に `Tailscale-User-Login`・`Origin`・`X-Makase-Request` を付けて API-083 が返る。ヘッダーなしは 403 `NOT_OWNER`、POST で `X-Makase-Request` なしは 403 `CSRF_REJECTED`。`:8081` に `/api/v1/session` を送ると 404。

#### 3.5.b 状態 API-111・VM の API-088・099
4. **FR-083・API-111**：版・DB（スキーマの版・最後のバックアップ）・box-manager（届くか）・VM（動いているか・世代・画面の番・ホームの大きさ・`vm_op`・`vm.browserSandbox`）・空きディスク・空きメモリ・動いているターンとタスクの数・今日の費用・キャッシュの当たり率・`llm: { model, reviewModel }`・Funnel の状態。box-manager の測りが API-109 にまだ無ければ `homeBytes`・`hostFreeBytes` は `null`（測るのは box-manager だけ：D-309）。ステップ 4・5 で入る値（ターン・キャッシュ・Funnel）は 0 / `null` を返す形だけ作る。
5. **API-088・099**：`GET /api/v1/vm`（`boxes`・`workspace.vm_op`・box-manager の API-109 から作る。眠っていれば `status: "stopped"`）、`POST /api/v1/vm/stop`（`vm_op = stopping`→API-102→`boxes` を `stopped`（`stop_reason = 'owner'`）→監査ログ `box.stopped`→SSE `vm.updated`）。起こす側（API-101）は本体からの呼び出しの口だけ作り、タスクのために起こすのはステップ 4。
確かめ：`curl` で API-111・088 が返る。`docker compose stop box-manager` でも API-111 は 200 で「届かない」を返す。`POST /api/v1/vm/stop` で `boxes` が `stopped`（`stop_reason = 'owner'`）になり、監査ログに `box.stopped` が残る。

#### 3.5.c SSE・監査ログ API-023
6. **API-085（SSE）**：`events/hub.ts` は、一番外側のトランザクションがコミットしたあとに「事象が増えた」を知らせる。`GET /api/v1/events` は `apps/app/src/sse.ts` の形（`id:`＝`workspace_events.id`、`data:` は `{ "type": …, "taskId": … }` のように種類と対象の ID だけ、15 秒の `: heartbeat`、残っていなければ `event: reset`）。再接続は `Last-Event-ID` ヘッダーと `?lastEventId=` クエリの両方を受ける（ヘッダーがあればそちらを優先する）。`?deviceId=` を受けて接続ごとに覚える（心拍 API-121 との結びはステップ 5）。`workspace_events` は 1 日で消す（毎時の掃除）。種類と出す側は次の表（09 の表を写す。出す側のステップが自分の処理から `hub` に渡す）。

| 種類 | 出す側 | 出す場面 |
|---|---|---|
| `chat.created` | ステップ 4 | チャットのメッセージが増えたとき |
| `turn.updated` | ステップ 4 | ターンの状態が変わったとき |
| `task.updated` | ステップ 4 | タスクの状態が変わったとき |
| `vm.updated` | ステップ 3 | `POST /api/v1/vm/stop`・起こす側の呼び出しで VM の状態が変わったとき。タスクのための起動・交代の分はステップ 4 が足す |
| `check.created` | ステップ 4 | 確認（ブラウザの確認・交代など）が増えたとき |
| `check.updated` | ステップ 4 | 確認の状態が変わったとき |
| `memory.updated` | ステップ 4 | 記憶が書き換わったとき |
| `trigger.updated` | ステップ 5 | ルーチン・webhook などのきっかけが変わったとき |
| `reset` | ステップ 3 | `Last-Event-ID` の続きが残っていないとき（`hub` 自身が出す） |
7. **API-023**：`GET /api/v1/audit-logs`（`?cursor=`・`?limit=`・種類・期間・`taskId` で絞る。`nextCursor`）。`db/repo/app.ts` の `listAuditLogs` と `apps/app/src/routes/audit.ts` の `auditLogItem`・カーソルを使う。`verifyAuditChain`（`db/audit.ts`）は毎日のバックアップの前に全件を確かめ、外れたら CRITICAL のログ（置き場は「実装で決めること」）。
確かめ：`curl -N …/api/v1/events` に、別の端末から `POST /api/v1/vm/stop` した合図（`id:` つき）が届き、`Last-Event-ID` ヘッダーでも `?lastEventId=` でも続きが取れる。残っていない番号で `event: reset`。API-023 が種類・期間・カーソルで絞れる。

#### 3.5.d エージェント・設定・件数・ファイル API-041・080・081・096・100・112
8. **API-041・080・081**：`routes/agents.ts` を移す。一覧はメインを先頭に `kind`・`description`・`createdBy` を足し、asks の欄・成長の欄は返さない。`DELETE` は動いているタスクがあれば 409 `AGENT_BUSY`、メインは 409 `MAIN_AGENT`。`POST` は `Idempotency-Key` を受け、LLM は `llmOf`。
9. **API-096**：`GET・PATCH /api/v1/settings`（`budget.daily_usd`・`daily_auto_usd`・`browser`・`terminal` 欄・`maxTasks`）。PATCH は `workspace_policies` の新しい版を作り（直前の版を書き換えない）、`workspace.max_tasks`（1〜5）を更新し、監査ログに残す。**API-100**：確認待ちと動いているタスクの件数。**API-112**：`/api/v1/shots/:file`（7 日を過ぎたら 404）・`/api/v1/files/:taskId/:name`（`Content-Disposition: attachment`・`nosniff`・`Content-Security-Policy: sandbox; …`・`?preview=1`）。パスに `..` や区切りを含む名前は断る。
確かめ：API-041・096・100・112 が返る。`PATCH /settings` で `workspace_policies` に新しい版ができる。`../` を含む名前の `files` は断られる。

#### 3.5.e タイマーの枠
10. **タイマー**（`timer.ts`）：毎時＝掃除（24 時間より古い `idempotency_keys`・`workspace_events`）、毎日＝バックアップ（`snapshot_hour` とは別。`TZ` の決まった時刻）。毎分の枠は空の配列を置き、ステップ 4 以降が足す。前の実行が終わっていなければ飛ばす（`startPeriodic`）。この `timer.ts` はステップ 4 で `timer/` に昇格し、ここの毎時・毎日の仕事も登録口（`registerTimerJob`）に載せ替える。
確かめ：時計を差し替えた単体試験で毎時の掃除（24 時間より古い `idempotency_keys`・`workspace_events` が消える）と毎日のバックアップが 1 回ずつ走る。前の実行が終わっていなければ飛ぶ。

### 3.6 Compose 一式・`tailscale serve`・本体 ↔ box-manager・:8081
この節の動的VMは[運用契約](../design/11_operations.md)を満たす。managerは導入/世代labelを付ける。Compose外の2イメージはリリース対応表の `BOX_BROWSER_IMAGE`・`BOX_SHELL_IMAGE` を明示取得し、停止/移行時はlabelでVMを回収して非使用確認後だけコピーする（IMP-010・011）。
1. `apps/makase/Dockerfile`：`apps/sandbox/Dockerfile` の作り（`pnpm fetch --prod`→本番の依存だけ→ビルドせず `.ts` を動かす）を写し、ベースは Node 24 の digest 固定。`apps/web` を `vite build` した出力をイメージの `WEB_DIST` に置く。`better-sqlite3` は prebuilt が入ることを確かめる（入らない環境ではビルド道具の段を足す）。テストファイルはイメージに入れない。
2. `compose.yaml`（ルートの db だけのものを置き換える）：サービスは `tailscale`・`makase`・`box-manager`・`docker-socket-proxy`・`egress`。`box-browser`・`box-shell` は書かない（box-manager が起こす）。ステップ 1 の `compose.vm.yaml` のネットワーク（`box` は `internal: true`、`ctl`・`sock`・`egress-out`）とボリューム（`makase-browser-profile`・`makase-vm-home`）を取り込んだあと `compose.vm.yaml` を消し、`front`・`core-out`・`ts-out` と、ボリューム `makase-data`（`/data`）・`makase-ts-state`・（ステップ 7 用に）`makase-vm-snapshots` を足す。`box` ネットワークには `driver_opts` の `com.docker.network.bridge.gateway_mode_ipv4: isolated` を既定で書く（07「ホストへの入り（既定）」。古い Docker でエラーになるかは「実装で決めること」）。つなぎ方は [07 のコンテナの表](../design/07_architecture.md#レベル2コンテナ図)どおり（`makase`＝front・ctl・core-out、`tailscale`＝front・ts-out、`box-manager`＝ctl・sock・box、`egress`＝box・egress-out）。`ports:` は書かない（NFR-064）。`restart: unless-stopped`、ログは 1 つ 10MB×3（NFR-079）、`makase` に `/api/health` の `healthcheck`、`box-manager` は `makase` が起きてから届くよう `depends_on`＋再試行。`image:` は digest 固定（CI の `check-image-digests.mjs` が見る）。
3. 待ち受け：`front` に固定のサブネットを決め、`makase` に固定のアドレスを付けて `LISTEN_ADDR` に渡し、:8080 はそのアドレスにだけ結ぶ（ctl・core-out のアドレスでは待ち受けない：R-80）。:8081 も front のアドレスで待ち受け、`/hooks/` 以外は 404。
4. `docker/tailscale/serve.json`：443 番で `http://makase:8080` に中継する（`/` ごと）。`tailscale` サービスに `TS_AUTHKEY`・`TS_HOSTNAME`（既定 `makase`）・`TS_STATE_DIR`（`makase-ts-state`）・`TS_SERVE_CONFIG` を渡す。Funnel の 8443 番はステップ 5。
5. 本体 ↔ box-manager：`box/client.ts` が `Authorization: Bearer $BOX_MANAGER_TOKEN` で API-101・102・109 を呼ぶ。共有トークンが違えば box-manager は 401 を返す（試験する）。ホストの空き・ホームの大きさは API-109 の値を読むだけにする。`apps/box-manager` の API-109 の応答に `images: { browser, shell }` を足し（Docker のイメージの読み取りだけ）、本体は起動の順の (6) と API-111 でこれを読む。
6. `compose.dev.yaml`：本体だけを `pnpm dev` に差し替える上書き（形は「実装で決めること」）。`.env.example` を 11 §10 の表で作り直す（旧 Node 版の `PHASE0_ACCESS_TOKEN`・`DATABASE_URL`・`GEMINI_API_KEY`・`LLM_*` は消す）。`.env` の権限は 600 と書く（NFR-072）。
確かめ：`docker compose config` が通り、`docker compose up -d` で 5 つが起きる。`docker compose ps` の `PORTS` が空。`docker network inspect` で `box` に `com.docker.network.bridge.gateway_mode_ipv4` が `isolated` で付いている（効くかの試験はステップ 8）。`compose.vm.yaml` が残っていない。`tailscale` のログに serve の設定が入る。ホストから `docker compose exec makase …` で DB が `/data/makase.db` にできる。

### 3.7 旧コードを消す・`pnpm typecheck` / `test` / `lint:deps` を通す
1. `apps/app`・`apps/worker`・`packages/edge`・`packages/browser-guard`・`compose.vm.yaml` を消す（`packages/browser-guard` は 3.4、`compose.vm.yaml` は 3.6 で取り込み済み。残っていれば消す）。`packages/edge` は `web` 系を 3.3 で移したあとに消す。`packages/db`・`apps/gateway`・`apps/gcal`・`apps/github`・`packages/gateway-client` はここでは消さない（ステップ 5 の最後）。消す前に、ステップ 5 が移す元にする `apps/app/src/routes/connect.ts`・`connect-github.ts`・`approvals.ts`・`connectors/`・`check/`・`tick.ts`・`schedule.ts` が git の履歴から読めるよう、消したコミットの SHA を [04](04_resident.md)・[05](05_triggers.md)・[07](07_terminal_pack_snapshot.md) の「前提」に書き足す（`git show <sha>:<path>` で読む）。`apps/worker/src/db/repo/gateway.ts`・`edge/intents.ts`・`views/connectors/known.ts` は 3.3 で `apps/makase` に移っていることを確かめる。`pnpm-workspace.yaml` の `onlyBuiltDependencies` から `workerd` を外し、`.gitignore` の `.wrangler/` と `docs/development.md` の「Cloudflare の版」「Gemini の `.env`」の節を、新しい起動手順（`docker compose up -d`・`compose.dev.yaml`）に書き換える内容として書き換え対象として控える（書き換えは「設計に戻すこと」）。`pnpm install` でロックファイルを作り直す（`--frozen-lockfile` の CI が通ること）。
2. `.dependency-cruiser.cjs`：`DB_CLIENTS` に `better-sqlite3` を、`LLM_CLIENTS` に `@anthropic-ai/sdk` を足す（`runner` から DB・LLM に届かない規則を、新しい部品の名前でも守る）。`NETWORK_PACKAGES` にも足す。`workspace("db")` は `.github/depcruise-selftest` のフィクスチャが使うので、フィクスチャごと直すまで外さない。`not-to-unresolvable` の `cloudflare:*` の除外は外す。ADR-051 の約束（資格情報に届くのは gateway だけ）のため、`edge/`・`routes/`・`views/` から `db/repo/credentials.ts` と `platform` の `secret-box` に届かない規則を足す（gateway の中身はステップ 5）。`TEST_FILES` の `^apps/[^/]+/test/` は `apps/makase/test/` に合うので残す。
3. CI：`.github/workflows/ci.yml` の Node を 24 にそろえる。`node .github/depcruise-selftest/run.mjs` と `node .github/scripts/check-image-digests.mjs` も通す。
4. `pnpm typecheck`・`pnpm test`・`pnpm lint:deps` を通す。
5. ルートの `README.md` に「いまの起動手順」（`.env` の必須 5 項目・`docker compose up -d`・tailnet の URL）を暫定で 10 行だけ書く。仕上げはステップ 8。
確かめ：3 つが緑。`grep -rn "wrangler\|cloudflare:\|@cloudflare" apps packages --include=*.ts --include=*.json` が空（`pnpm-lock.yaml` を除く）。`git ls-files apps/app apps/worker packages/edge packages/browser-guard compose.vm.yaml` が空。`README.md` の「いまの起動手順」のとおりに起動できる。

## 終わる条件
| ID | 確かめること | 方法（コマンド・操作） | 設計の参照 |
|---|---|---|---|
| S3-01 | UC-042 の基本フロー：空のボリュームで `docker compose up -d` するだけで、DB が最新になり（前にバックアップ）、メインが作られ、VM のイメージの有無を確かめ、tailnet に入って画面の URL が開く | `.env` を埋めて起動→起動の記録（JSON の行）にマイグレーションの版・メインの作成・box-manager への到達が出る→`https://makase.<tailnet>.ts.net/` で `index.html`、`/api/health` が ok | UC-042、FR-083 |
| S3-02 | UC-042 の E1・E2：必須の値が 1 つ足りない・メモリが足りないと、理由（名前・数字）だけを出して止まる | `.env` から `ENCRYPTION_KEY` を消す。閾値の確かめは `os.totalmem` を差し替える単体試験 | UC-042 E1・E2 |
| S3-03 | NFR-071：本体の起動から 60 秒以内に待ち受けと再開の準備が終わる。確定した行を失わない | 監査ログとイベントを数千行入れた DB で `docker kill makase`→Compose の再起動から `/api/health` ok までを測る。コミット直後に `kill -9` して行が残る | NFR-071、ADR-042 |
| S3-04 | NFR-070・077：版を足したイメージで起動するとバックアップが先に取られ、`VACUUM INTO` の結果が開け、8 世代目で古いものが消える | 版 6 の試験用マイグレーションを足して起動→`/data/backups`。毎日のタイマーを時計の差し替えで 8 回 | NFR-070・077 |
| S3-05 | UC-043 の基本フロー：tailnet の端末のブラウザで URL を開くと持ち主として入れる | `curl https://makase.<tailnet>.ts.net/api/v1/session` が `OWNER_LOGIN` と表示名を返す | UC-043、FR-073 |
| S3-06 | UC-043 の E1・NFR-065：ログイン名が違う・付いていないと 403 `NOT_OWNER`。GET 以外で `Origin` か `X-Makase-Request` が違うと 403 `CSRF_REJECTED`。`/api/health` だけ確かめなし | 単体（偽のヘッダー）と、`OWNER_LOGIN` を別の値にして起動した本体への実機の確かめ | FR-073、NFR-065 |
| S3-07 | NFR-064・R-80：ホストの LAN の別の機械から :8080・:8081 に届かない。ctl・core-out 側のコンテナ（box-manager）から `makase:8080` に届かない。:8081 に `/api/*` を送ると 404 | LAN の別の機械から `curl http://<ホストの LAN のアドレス>:8080`。`docker compose exec box-manager` から `makase:8080`。`docker compose ps` に公開ポートがない | NFR-064、[11 §11 隔離](../design/11_tech_spec.md#11-テスト方針) |
| S3-08 | FR-083・API-111・API-088・API-099：box-manager が止まっていても 200 で「届かない」を返す。VM を API-101 で起こすと `running`、API-099 で止めると `stopped`（`stop_reason = 'owner'`）。共有トークンが違うと box-manager が拒む | `docker compose stop box-manager` で API-111。起こす・止めるの前後で API-088 と SSE の `vm.updated` | FR-083、FR-074、[09 vm](../design/09_api/vm.md) |
| S3-09 | FR-018・API-085：変化の合図が `id:` つきで届き、`Last-Event-ID` で続き、残っていなければ `event: reset` | `curl -N` と別の端末からの `POST /api/v1/vm/stop`。24 時間より古い事象を消した後の再接続 | FR-018、[09 API-085](../design/09_api/README.md#api-085sse-は合図d-196) |
| S3-10 | FR-016・UC-051・API-023：ハッシュの鎖が正しく、`audit_logs` の更新・削除はトリガーで止まり、ファイルを書き換えると検証が外れる。一覧が種類・期間・カーソルで絞れる | `db/audit` の試験（版 4 のあとも）と、バックアップのコピーを書き換えて `verifyAuditChain` | FR-016、UC-051、NFR-078 |
| S3-11 | UC-045・API-041・080・081：一覧はメインが先頭、文から 1 人作れる（ScriptedLlm）、動いているタスクがあれば 409 `AGENT_BUSY`、メインは 409 `MAIN_AGENT`、同じ `Idempotency-Key` は同じ結果 | 移した `agents` の試験＋実機で `curl` | UC-045、FR-072 |
| S3-12 | API-096・FR-013：`daily_usd`・`daily_auto_usd` を変えると新しい版のポリシーができ、効くのは次から。範囲外は 400 | `PATCH /settings` の前後で `workspace_policies` を見る | FR-013、TBL-035 |
| S3-13 | API-100・112：件数が返る。スクショは 7 日を過ぎると 404。成果物は `attachment`・`nosniff`・CSP つき。`../` を含む名前は断る | 試験用のファイルを `/data` に置く単体試験 | API-112、D-243 |
| S3-14 | 依頼と Cloudflare が残っていない：`/api/v1/asks` は 404、`asks`・`workflows`・`auth`・D1・`cloudflare:` の import がコードにない（表と型の定義を除く） | `grep` と `curl` | 07 移すもの・変えるもの |
| S3-15 | 08 の変える表が保存できる（D-254・D-283）。移した edge・db の試験（上限の予約と精算、Intent、承認、`web-seen` ほか）が `better-sqlite3` の上で緑 | `pnpm --filter @open-team/makase test` | [11 §11 単体](../design/11_tech_spec.md#11-テスト方針) |
| S3-16 | `pnpm typecheck`・`pnpm test`・`pnpm lint:deps` が緑。`depcruise-selftest` と `check-image-digests` も通る | ルートで実行 | 11 §11、`.dependency-cruiser.cjs` の規則 |
| S3-17 | `packages/browser-guard` と `compose.vm.yaml` が消え、`guard/` の試験が `WsDb` の上で緑。`apps/app`・`apps/worker`・`packages/edge` も消えている | `git ls-files apps/app apps/worker packages/edge packages/browser-guard compose.vm.yaml` が空。`pnpm --filter @open-team/makase test` | 07 移すもの・変えるもの |
| S3-18 | `box` ネットワークに `isolated` が Compose に書かれている（効くかの試験はステップ 8） | `docker compose config` と `docker network inspect` で `com.docker.network.bridge.gateway_mode_ipv4` が `isolated` | 07 ホストへの入り（既定） |
| S3-19 | `web_fetch` の判定の単体：egress と同じアドレス（loopback・プライベート・リンクローカルなど）を断り、リダイレクト先も再判定する | `edge/web.ts` の単体試験（偽の DNS と偽の 302） | FR-080、D-164 |

## 実装で決めること
| 論点 | 設計の言い分 | おすすめ | 決めたら書く先 |
|---|---|---|---|
| RPC の値返し（`WriteResult`・`EdgeOutcome`）を例外に戻すか | 07・11 §9：同じプロセスなので普通の例外に戻してよい（戻すかは移すときに決める） | 戻す。`write.ts`・`edge/fault.ts` を消す。`runIdempotent` は `AppError` を投げ、ステップ 4 の実行役は `EdgeError` を直接受ける | 00 に D-xxx、07 移すもの・変えるものの 2 行目 |
| `apps/web` のビルドの配り方 | 07：本体が `apps/web` のビルドを配る | イメージのビルドで `vite build`→`WEB_DIST` に置き、`serveStatic`＋ SPA の戻し（`/assets/` は 1 年の immutable、ほかは no-cache。`apps/app/src/app.ts` の形）を :8080 だけに置く。:8081 には置かない | 00 に D-xxx、11 §10 |
| 開発時に本体だけ `pnpm dev` に差し替える上書きの形 | 07：本体だけ `pnpm dev` に差し替える上書きファイルを用意する | `compose.dev.yaml` で `makase` を外し（`profiles`）、ホストの `pnpm dev` を `front` のゲートウェイのアドレスで待たせ、tailscale の中継先をそのアドレスに替える。box-manager は `127.0.0.1:7000` に出し `BOX_MANAGER_URL` を替える。internal の `front` でホストがそのアドレスを持てるか先に確かめ、だめなら `makase` のコンテナに `node --watch` とソースのマウントを上書きする形にする。`/mnt/c` の上では変更を拾わないので WSL の Linux 側にクローンする | 07 デプロイ構成、`docs/development.md`、11 §10（`BOX_MANAGER_URL`） |
| `tasks.job_id` の NULL 可と `trigger_type` の値（D-254）、ほかの CHECK の作り直し | 08：`job_id` は NULL 可、`trigger_type` に `delegate`、`halt_reason` に `vm_replaced`。今の `schema.ts` に合わせる | 版 4 で表ごと作り直す（今の `trigger_type` は `manual`・`schedule`・`dry_run`・`ask`、`job_id` は NOT NULL）。既存の値は変えず `delegate` だけ足す。`PRAGMA foreign_keys=OFF` のもとで行い、`foreign_key_check` で確かめる | 00 の D-254 の横に実測、08 変える表 |
| 新しい表を版 5 で一度に作るか | 08：骨組みは先に置く（中身はステップ 4 以降） | 一度に作る。`tasks`・`usage_records`・`action_intents` などが `turns`・`boxes` を参照し、順に足すと作り直しが増えるため。ステップ 2 の表の DDL はここへ寄せる | 08 の表の「区分」 |
| `box` ネットワークの `isolated`（`gateway_mode_ipv4`）が古い Docker でエラーになるか | 07：既定で `isolated` を書く | 前提の Docker Engine 24 以上で `docker compose up` が通るか実測する。通らない版は前提の下限を上げる（Compose では外さない） | 07 ホストへの入り、前提の Docker の版 |
| `web_fetch` の判定を egress と共有するか | FR-080・D-164：egress と同じアドレスの判定とリダイレクト先の再判定 | `apps/egress` の規則の表を `packages/platform` などに出して両方から読む。出せなければ写して、同じ試験の表を両方に置く。`packages/edge` と `apps/worker` の `web-seen.ts` は新しいほうを残して 1 本にする | 00 に D-xxx |
| `?deviceId=` の覚え方 | 09 API-085：`?deviceId=` を受けて心拍（API-121）と結ぶ | `hub` が接続ごとにメモリ上で持ち、切れたら消す。表には書かない（結んで使うのはステップ 5） | 09 API-085 |
| asks 系の表と `tasks.ask_id` などの列をいつ落とすか | 08：使わない。落とすのは次のマイグレーション | このステップでは残す（空のまま）。`tasks.ask_*`・`usage_records.ask_id`・`agent_questions` が参照していて、落とすと表をさらに作り直すことになる。落とす整理は別の版に分ける | 08 使わなくなるもの |
| edge の asks 分岐（編成・窓口・`ask_user`・`team_post`）をこのステップで外すか | 07：asks はチャット・ターン・タスクに置き換わる（作るのはステップ 4） | 外す。`task.ask_id === null` の道だけ残し、`submit_report` の `answer` と `nextActions` は使わない。`report`・`delegate`・`send_to_owner` はステップ 4 | 04 resident の移植元の表 |
| `workspace.max_concurrent_tasks`（今の列）と 08 の `max_tasks`（CHECK 1〜5） | 08：`max_tasks` を足す（今の列と別に書いてある） | 版 4 で `workspace` を作り直して `max_tasks` 1 本にし、`edge/spend.ts` と `WorkspaceRow` の名前を置き換える | 08 TBL-031 |
| ワークスペースの初期化：`owner_user_id`・`TZ`・メインのエージェント | 08：`owner_user_id` は使わない（列は NOT NULL＋書き換え禁止のトリガー）。UC-042：メインがなければ作る | `owner_user_id` には `OWNER_LOGIN` の小文字を入れて列を残し、`owner_login` を足す。`workspace.timezone` に `TZ` を書く。メインは行と最初のスナップショットだけ作り（指示は短い仮の文）、本当の指示はステップ 4 で新しいスナップショットにする | 08 TBL-031、00 に D-xxx |
| ポリシーの `budget` のキー | 08 TBL-035：`daily_usd`・`daily_auto_usd`・`per_turn_usd` など。今の Kernel は `per_day_usd`、`per_task_usd` 0.5・`max_minutes` 15 | `packages/kernel/src/policy.ts` の `budget` を 08 の JSON に作り直す（`edge/proxy.ts`・`policy-summary.ts` の `per_day_usd` を置き換える）。ステップ 2 の `BrowserPolicy` もここで `policy.ts` に合流 | 08 TBL-035、00 に D-xxx |
| 必須の設定の閾値と時期 | 11 §10：VAPID は「はい」。UC-042 E1：メモリが足りない | メモリは総量 3.5GiB 未満で止める（4GB のホスト：NFR-062）。`VAPID_*` はステップ 5 まで未設定を警告にとどめ、5 で必須にする | 11 §10、UC-042 |
| 待ち受けアドレスの決め方 | 07：:8080 は front ネットワークでのアドレスに結びつける | `front` に固定のサブネットを決め、`makase` に固定アドレスを付けて `LISTEN_ADDR` で渡す | 07 コンテナの表、11 §10 |
| `tailscale` コンテナの `serve` 設定の持ち方 | 07：`tailscale serve`（443→:8080）と `funnel --https=8443` | `TS_SERVE_CONFIG` に JSON のファイル（`docker/tailscale/serve.json`）を渡す。ホスト名は `${TS_CERT_DOMAIN}` で埋める。ステップ 5 で 8443 番を足すときに、受け口の有無（`TS_FUNNEL=auto`）でファイルを切り替える方法を決める | 07 tailscale の行、00 に D-xxx |
| SSE の起こし方 | 09：合図は通し番号つき（`workspace_events`） | 一番外側のトランザクションのコミット後にプロセス内で通知し、15 秒ごとの見回りでも読む（取りこぼしは次で追いつく） | 09 API-085 |
| VM のイメージの有無をどう確かめるか | FR-083・UC-042：VM のイメージがあるかを確かめる。API-101〜109 に該当する口がない | API-109 の応答に `images: { browser, shell }` を足す（box-manager は Docker のイメージの読み取りだけ通せる） | 09 vm の API-109、FR-083 |
| 監査ログの鎖の検証をいつ走らせるか | UC-051：鎖を確かめられる。09 に検証の API がない | 毎日のバックアップの前に全件を確かめ、外れたら `audit.verify_failed` を CRITICAL でログに出す。API は足さない（足すなら 09 に行を足す） | 09 API-023、FR-016 |
| `packages/db` と `apps/gateway` を消す時期 | README の I-1：ステップ 3 の最後に `packages/db` を消す。`apps/gateway` は `packages/db` に依存し、ステップ 5 の gateway の移す元 | `packages/db`・`apps/gateway`・`packages/gateway-client`・`apps/gcal`・`apps/github` はステップ 5 の終わりまで残し、そこで一緒に消す。3 では `apps/app`・`apps/worker`・`packages/edge`・`packages/browser-guard`・`compose.vm.yaml` だけ消す | README の I-1、05 |

## 設計に戻すこと
- 11 §10 に、表にない環境変数（`DATA_DIR`・`LISTEN_ADDR`・`BOX_MANAGER_URL`・`WEB_DIST`・`COMMIT_SHA`）を足す。09 に API-083・API-111 の応答の例を足す。API-109 に `images` を足すなら 09 vm の表と FR-083 を直す。
- ID を UUIDv7 にした（08）のに、コードの `newId()` は乱数の UUID だった。直したことを 08 の「決めごと」の行に書く。
- `workspace.max_concurrent_tasks` を `max_tasks` に替えたこと、`budget` のキーを `daily_usd` にしたことを 08 TBL-031・035 に反映する。
- `docs/development.md` を書き換える（起動は `docker compose up -d`・`compose.dev.yaml`、`.env` の表、テスト、Cloudflare の節を消す）。`.env.example` を作り直す。
- 決めたことを 00 の決定事項ログに D-xxx で足す。NFR-071 の 60 秒は実測を 05 の横に書く。

## 参照
- 設計：[07](../design/07_architecture.md)（コンテナ図・レベル3・移すもの・認証）、[08 方針・変える表](../design/08_database/README.md)・[resident](../design/08_database/resident.md)・[vm](../design/08_database/vm.md)、[09](../design/09_api/README.md)・[vm 内部 API](../design/09_api/vm.md)、[04 tools](../design/04_functional_spec/tools.md)（FR-013・016・018・072・073・083）、[03](../design/03_use_cases.md)（UC-042・043・045・051）、[05](../design/05_non_functional.md)（NFR-064・065・070・071・072・075・077・079）、[11](../design/11_tech_spec.md)（§9・§10・§11）
- ADR：[041](../design/adr/ADR-041-linux-host.md)・[042](../design/adr/ADR-042-node-sqlite.md)・[046](../design/adr/ADR-046-tailscale-identity.md)・[049](../design/adr/ADR-049-docker-compose.md)・[051](../design/adr/ADR-051-gateway-in-core.md)・[056](../design/adr/ADR-056-llm-provider.md)（取り下げ）
- 移す元のコード：`apps/worker/src/`（`index.ts`・`workspace-do.ts`・`db/schema.ts`・`db/sqlite.ts`・`db/audit.ts`・`db/repo/`・`edge/`・`llm.ts`・`agents/`・`routes/`・`views/agents/`）、`apps/worker/wrangler.jsonc`、`apps/app/src/`（`server.ts`・`app.ts`・`env.ts`・`http.ts`・`sse.ts`・`routes/audit.ts`・`routes/stream.ts`）、`packages/platform/src/`（`env.ts`・`log.ts`・`mask.ts`・`errors.ts`・`secret-box.ts`）、`.dependency-cruiser.cjs`、`pnpm-workspace.yaml`、`docs/development.md`
- 前後のステップ：[01](01_vm_vertical.md)・[02](02_risky_actions.md)・[README](README.md)
