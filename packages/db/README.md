# @open-team/db

PostgreSQL 16 の接続・マイグレーション・行の型・監査ログ・ワークスペースとセッション・ワークスペースをまたぐ処理（`system`）。
仕様は scratchpad の `spec/db-schema.md` を、`spec/cross-check.md` の結論（M-xx・G-xx）で直したもの。

| ファイル | 中身 | 持ち主 |
|---|---|---|
| `migrations/0001〜0004_*.sql` | 表（0001 利用者・ワークスペース・セッション・入口の試行・監査ログ／0002 ポリシー〜依頼・タスク・Intent・承認・判定・費用・SSE・チェック済み／0003 リハーサル／0004 `sim` スキーマ） | db-core |
| `migrations/roles.sql` | DB のロールと GRANT（毎回流す・冪等） | db-core |
| `src/client.ts` | `createDb(url, opts)` → `Db`（`query`・`transaction`・`listen`・`notify`・`close`）、`Tx`・`Queryable`、エラーの見分け | db-core |
| `src/migrate.ts` | 実行器と CLI | db-core |
| `src/types.ts` | 全部の表の行の型と列挙 | db-core |
| `src/audit.ts` | `appendAuditLog`・`verifyAuditChain`・`computeAuditHash` | db-core |
| `src/workspace.ts`・`src/session.ts`・`src/exec-context.ts` | `WsCtx`・オーナーとゲストの作成・セッション・CSRF・実行の文脈 | db-core |
| `src/system/*` | ワークスペースをまたぐ処理（掃除・ゲストの数・入口の試行・全体の費用・毎分の起こしの走査） | db-core |
| `src/testing.ts`（`test-database.ts`・`test-helpers.ts`・`testing-fixtures.ts`） | `@open-team/db/testing`（試験用のデータベースと行を作る道具） | db-core |
| `src/repo/gateway.ts`・`edge.ts`・`app.ts`・`app-*.ts` | 業務の問い合わせ（`@open-team/db/gateway` など） | 各担当 |
| `src/sim/**` | `sim` スキーマの保存（SimStore の Postgres 版。`@open-team/db/sim`） | sim-persistence |

## 1. リポジトリ層の約束（15:368・486・517、DB §4.1）

1. **業務の関数は `(q, ctx: WsCtx, …)` の形**にし、SQL に必ず `workspace_id = $1` を入れる。ID で1件引くときも
   `WHERE id = $2 AND workspace_id = $1`。見つからなければ `null` を返す（API は 404 `NOT_FOUND`。別のワークスペースの ID でも同じ）。
2. `WsCtx` は **セッション（`resolveSession`）・タスクのトークン・Intent の行から DB で引き直したもの** からだけ作る。
   リクエストの本文・ヘッダーの `workspace_id`・`rehearsal_run_id`・`shadow` は読まない（15:486）。行から作るときは `wsCtxOf(row)`。
3. **ワークスペースをまたぐ処理は `src/system/*`**（`system.cleanupGuestWorkspaces` など）。業務の画面の API からは呼ばない。
   repo/*.ts にワークスペースで絞らない問い合わせを書かない（必要なら db-core に頼む）。今あるもの：
   - 入口：`system.hashIp`・`normalizeIp`（IPv6 は /64）・`recordEntryAttempt`・`countEntryAttempts`・`recordWrongToken`・`wrongTokenDelayMs`、`system.countActiveGuestWorkspaces`
   - 掃除：`system.cleanupGuestWorkspaces(maintDb, now, { batch, graceMs, stopWorkspace })`（`ot_retention` の接続で）・`stopWorkspaceForCleanup`・`purgeExpiredRows`・`KILL_SWITCH_CHANNEL`
   - 費用：`system.getPlatformDayCostUsd`（全体の今日。Asia/Tokyo）・`dayRange`・`usdToMicro`・`microToUsd`
   - 毎分の起こし（EP-47）の走査：`system.scanDueAsks`・`scanExpiredApprovals`・`scanStuckExecutingIntents`・`scanQueuedTasks`・`scanQueuedRehearsalRuns`。
     **ロックを取らずに候補を返すだけ**。1件ずつ `wsCtxOf` で文脈を作り、ロックの順（下の7）で取り直して状態を確かめてから処理する
4. タスクのトークンは `hashTaskToken(raw)`（SHA-256）で `tasks.task_token_hash` に入れ、`task_token_expires_at > now` で引き直す（期限ちょうどは無効）。
   引き直した `workspace_id`・`kind`・`rehearsal_run_id`・`shadow`・`sim_execution_id` だけを使う。
5. 読むだけの関数は `q: Queryable`（プールでもトランザクションでもよい）、書いて整合が要る関数は `tx: Tx`
   （型でトランザクションの中だけに限る）。Db と Tx のどちらでも受けたいときは `withTransaction(q, fn)`。
6. **トランザクションの中で外部（Gemini・gateway・sim-world）を呼ばない**（G-14。接続を握ったまま待たない）。
7. **ロックの順はワークスペース → タスク → 承認 → Intent**（M-21・SO §3.14）。ワークスペースは `lockWorkspace(tx, ctx)`
   （`FOR NO KEY UPDATE`）で最初に取り、Kill Switch はそのあとに読む。デッドロック（40P01）は `transaction(fn, { retryOnce: true })` で1回だけやり直せる。
8. 監査ログは **業務の変更と同じトランザクション** で `appendAuditLog(tx, workspaceId, e, now)`。`occurred_at` は `now`（ミリ秒）。
   タスクのイベントは `payload` にも `taskId` を入れる（`task_id` 列はハッシュに入らない）。payload に秘密を入れない。
9. **本番とリハーサルを混ぜない**：`unknownOutcomeKeys`（BR-68）・承認待ちの置き換え（BR-60）・初めての宛先（BR-70）・回帰の試験（BR-80）は
   `execContextOf(task)` と `execContextSql(ec, alias, n)` で「本番どうし（`rehearsal_run_id IS NULL`）」か「同じ sim の走行どうし」に絞る（M-17）。
   リハーサルのタスクで `sim_execution_id` がないときは例外（デモ店舗に落とさない）。リハーサル・影のタスクは承認の行を作らない。
10. `updated_at` はトリガーで更新しない。更新する SQL で `updated_at = $now` を入れる。時刻は引数の `now`（試験で固定できるように。DB の `now()` を既定にしない）。

### 見本（repo/*.ts に足すときの形）

```ts
import type { Queryable, Tx } from "../client.ts";
import type { ActionIntentRow, Uuid } from "../types.ts";
import type { WsCtx } from "../workspace.ts";
import { appendAuditLog } from "../audit.ts";

/** 自分のワークスペースの Intent（なければ null → 404） */
export async function getIntent(q: Queryable, ctx: WsCtx, intentId: Uuid): Promise<ActionIntentRow | null> {
  const r = await q.query<ActionIntentRow>("SELECT * FROM action_intents WHERE id = $2 AND workspace_id = $1", [ctx.workspaceId, intentId]);
  return r.rows[0] ?? null;
}

/** 書く関数は Tx を受け、監査ログを同じトランザクションで足す */
export async function expireIntent(tx: Tx, ctx: WsCtx, intentId: Uuid, now: Date): Promise<boolean> {
  const r = await tx.query(
    `UPDATE action_intents SET status = 'expired', expire_reason = 'approval_timeout', updated_at = $3
      WHERE id = $2 AND workspace_id = $1 AND status = 'pending_approval'`,
    [ctx.workspaceId, intentId, now],
  );
  if (r.rowCount === 0) return false;
  await appendAuditLog(tx, ctx.workspaceId, { eventType: "approval.expired", actorType: "system", actorId: "app", payload: { intentId } }, now);
  return true;
}
```

## 2. 値の変換（client.ts）

| PostgreSQL | JS | 注意 |
|---|---|---|
| `timestamptz` | `Date` | 引数も `Date` を渡す |
| `numeric(12,6)`（USD） | 文字列 `'0.120000'` | 足し算・比べるのは整数のマイクロドル：`system.usdToMicro`・`system.microToUsd`（T-117） |
| `int8`（`count(*)`・`audit_seq`・円・シード） | `number` | 2^53 を超えたら例外 |
| `bytea` | `Buffer` | |
| `jsonb` | 値 | **引数には JS の値をそのまま渡す**（`JSON.stringify` した文字列を渡すと jsonb の文字列になる） |
| 配列（`uuid[]`・`text[]`・`smallint[]`） | 配列 | 引数は `$1::uuid[]` のように型を書く |

- `query` は1回に1つの文だけ（複数の文は拒む）。名前つきの準備済みの文を使う（`prepare: true`）。
- 制約の違反は `isUniqueViolation(e, "agents_ws_name_uq")`・`isCheckViolation`・`isForeignKeyViolation`・`pgErrorInfo(e)` で見分ける
  （例：エージェントの名前が重なったら末尾に番号を足して作り直す FR-034、走行が動いていたら 409 `REHEARSAL_ALREADY_RUNNING`）。
- トランザクションの中で SQL のエラーを `catch` して続けない（PostgreSQL のトランザクションは壊れている）。続けたいときは `tx.savepoint(fn)` か `ON CONFLICT`。

## 3. 表の要点（cross-check で設計書から変えたところ）

- 全部の表に `workspace_id`（`workspaces` への FK・ON DELETE CASCADE）。例外は `users`（全体）と `entry_attempts`（ワークスペースが消えても IP で数えるので SET NULL）。
- **ワークスペースの中どうしの参照は `(workspace_id, xxx_id)` の複合 FK**（DB I-41）。別のワークスペースの行を指す行は DB が拒む。
  親が独立に消えうる任意の参照だけ `ON DELETE SET NULL (列)`。
- ハッシュ：`tool_hash` だけ `sha256:` つき、ほか（`policy_hash`・`intent_hash`・`destination_key`・`option_digest`・`inputs_hash`・`case_set_hash`・`certificate_hash`）は小文字16進64桁（M-07）。
- `tasks`：`trigger_type` に `ask`、`fail_reason` は `sandbox_lost`（M-32）。`sim_execution_id`・`execution_variant`（本番は NULL か `live`、リハーサルは `governed`／`governed_approve`／`shadow`。`shadow` ⇔ `shadow`。M-41）、`report_sources`（M-31）。`tainted` は一度 true にしたら戻せない（BR-38、トリガー）。
- `action_intents`：`option_digest`（G-05）・`decision_detail`、`expire_reason` に `policy_changed`（M-20）。
- `policy_decisions`：`detail`、`tool_call` の判定にも `intent_id` を入れられる（M-16）。
- `ask_runs`：`mode`（`live`／`rehearsal`）・`rehearsal_run_id`・`rehearsal_scenario_id`・`answer`・`first_member_started_at`、`trigger_type` に `initial`（M-33・M-47）。本番の `run_no` は依頼ごとに一意。
- `ask_members.depends_on` は段の番号 `smallint[]`（M-34）。
- 「チェック済み」は `check_marks(workspace_id, item_key '<種類>:<UUID>')`（M-54。`ask_runs`・`rehearsal_runs` に `checked_at` は持たない）。SSE は `workspace_events`（M-53。24時間で掃除）。
- `connector_tools`：一覧から消えたツールは `needs_review` ＋ `pending` NULL（MT §3.12.4）。
- リハーサル：`rehearsal_cases.stopped_writes`・`first_shadow_damage_jpy`、incident は障害 ID が空でよい（M-26・M-28）、`incident_kind` は `user_reject`（M-27）、`removed_reason` に `regenerated`（M-29）。
  `rehearsal_runs.effective_policies`・`policy_hash`・`tool_hashes`・`candidate_rules`（SW の形。G-03・M-50）。`rehearsal_scenarios.abort_reason`・`stopped_by_decision`・承認した分岐の損害・3つの走行の ID（M-42・M-46）。
  合格証の `tool_hashes` は `[{ action, toolHash }]`、`revoke_reason` に `superseded`（M-49）。有効な合格証は仕事ごとに1つ。
- `sim` スキーマ（M-40。apps/sim-world/src/store.ts の記録の形）：`sim.executions`（状態は jsonb・`version`・`variant`・`parent_execution_id`・`initial_state`・`scenario`・`snapshot_id`。デモ店舗は `(workspace_id, world)` に1つ）、
  `sim.events`（`(execution_id, seq)`、`event` に sim-core の `SimEvent` をそのまま。追記だけ）、`sim.snapshots`（試験が参照している間は消せない）。
- 守り：`audit_logs` は UPDATE・TRUNCATE 禁止、DELETE は GUC `ot.audit_purge_workspace` がそのワークスペースのときだけ（M-56）。`agent_snapshots`・`workspace_policies`・`sim.events` は UPDATE 禁止。
  オーナーのワークスペースは DELETE 禁止・`kind` は変えられない（SO I-28）。

## 4. ロール（SO §4.6・roles.sql）

| ロール | 使うサービス | 権限の要点 |
|---|---|---|
| （表の所有者） | マイグレーション（CI。本番は `ot_migrator`） | 表を作る。ON DELETE CASCADE・FK の確認はこの権限で走る |
| `ot_app` | app | 業務の表の読み書き。`audit_logs` は INSERT・SELECT だけ、`workspaces`・`users` の DELETE なし、`sim` なし |
| `ot_gateway` | gateway | 読み取り、`action_intents`・`approvals`・`tasks`・`connectors`・`connector_tools` の UPDATE、`audit_logs`・`policy_decisions`・`task_events`・`workspace_events`・`connector_tools` の INSERT、`workspaces` は `audit_seq`・`audit_last_hash` の列だけ。DELETE なし・`sessions` は見えない |
| `ot_sim` | sim-world | `sim` スキーマだけ（`sim.events` は UPDATE なし） |
| `ot_retention` | app の掃除だけ（`DATABASE_URL_MAINT`。DB §2・SO の `ot_maint` と同じ役目） | `workspaces`・`users`・`sessions`・`entry_attempts`・`idempotency_keys`・`workspace_events` の DELETE と、止めるための UPDATE |

- ロールは NOLOGIN で作る（流す利用者に CREATEROLE があるときだけ）。ログインは `ALTER ROLE ot_app LOGIN PASSWORD '…'` か、
  ログイン用の利用者に `GRANT ot_app TO <利用者>`。
- `OT_DB_SKIP_ROLES=1` で roles.sql を飛ばす。

## 5. マイグレーション

```sh
DATABASE_URL=postgres://… pnpm --filter @open-team/db migrate   # ルートの .env があれば読む
```

- `migrations/NNNN_名前.sql` を番号の順に、1ファイル1トランザクションで流す（ファイルに BEGIN／COMMIT を書かない）。流したものは `public.schema_migrations` に残り、2度流さない。
- 同時に流しても1回だけ（アドバイザリロック）。**流したあとのファイルは書き換えない**（チェックサムが違うと `MigrationChecksumError`）。直すときは新しい番号のファイルを足す。
- 最後に `roles.sql` を毎回流す（新しい表にも GRANT が付く）。

## 6. 試験（`@open-team/db/testing`）

```ts
import { useTestDb, fxWorkspace, fxAgent, fxTask } from "@open-team/db/testing";

const T = useTestDb(); // 試験（it）ごとに新しいデータベース（マイグレーション済み）と Db。終わったら消す

it("…", async () => {
  const { db, url } = T();
  const ws = await fxWorkspace(db);          // 利用者・ワークスペース・所属（owner）
  const agent = await fxAgent(db, ws);       // エージェント・スナップショット・仕事
  const { taskId } = await fxTask(db, ws, agent);
});
```

- `TEST_DATABASE_URL`（データベースを作れる利用者の URL）があればそのサーバーを使う。なければ docker で `postgres:16`（compose.yaml と同じ digest）の
  コンテナ `ot-db-test` を起動して使い回す（プロセス・パッケージをまたいで共有。データは tmpfs）。止めるときは `pnpm --filter @open-team/db test:db:stop`。
- マイグレーション済みの型紙のデータベースから写すので、1件 15ms ほど。最初の1回はコンテナの起動で数秒〜数十秒（`useTestDb` が beforeAll で待つ。自分で使うなら `warmUpTestDatabase` を長めの時間で）。
- そのほか：`openTestDb()`（Db つき）・`createTestDatabase({ migrate: false })`（空）・`openRoleDb(url, "ot_gateway")`（そのロールの権限でつなぐ。権限の試験用）、
  行を作る道具 `fxWorkspace`・`fxConnector`・`fxAgent`・`fxAsk`・`fxAskRun`・`fxAskMember`・`fxTask`・`fxIntent`・`fxApproval`・`fxRehearsalRun`・`fxRehearsalCase`・`fxRehearsalScenario`・`fxSimExecution`・`fxSimSnapshot`・`fxUsage`。
- `@open-team/db/testing` は vitest を import する（試験からだけ使う）。
