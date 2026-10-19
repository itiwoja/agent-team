# 08. DB設計：エージェント・仕事・会話・メモリ
- 親：[README.md](README.md) ／ 版数：v0.6（2026-10-01）

> **3行で**
> 1. エージェント（TBL-018）は名前のある担当者で、権限の境界を持つ。定義は変更しないスナップショット（TBL-019）に置き、仕事（TBL-023）・会話（TBL-024）・設定の変更（TBL-025）がぶら下がる（v0.5。[ADR-028](../adr/ADR-028-jobs-as-unit-of-work.md)）。
> 2. 下書き（TBL-021）は v0.5 で廃止し、TBL-024・025 に置き換えた。定義は行として残す（波及は Q-67）。
> 3. 14 の新テーブルにワークスペースの列がない点、slug・`trigger_index`・`watch` の扱いは Q-66。

---

## TBL-018：agents（エージェント）
エージェントと状態。v0.5 で名前のある担当者になり、仕事を複数持つ（14）。フェーズ0。

<details>
<summary>カラム定義（16列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations（→ workspaces。Q-62） | RLS |
| repository_id | uuid | NO | | FK→repositories | リポジトリのないエージェント（13 REQ-045）との矛盾は Q-64 |
| slug | text | NO | | | ファイル名から取ったID（`^[a-z0-9][a-z0-9-]{1,31}$`）。名前だけで作る場合の決め方は Q-66 |
| role | text | YES | | | 推測した役割 `research` / `watch` / `brief` / `assist` / `dev`（v0.5）。権限に影響しない（BR-48） |
| name_source | text | （記述なし） | | | `user` / `suggested`（v0.5。名前を提案から採ったか） |
| appearance | jsonb | （記述なし） | | | アイコン・色（v0.5。v0.3 で定義に追加した `appearance`） |
| status | text | NO | | | `active` / `invalid` / `disabled` / `removed` |
| current_snapshot_id | uuid | YES | | FK→agent_snapshots | 最新の有効なスナップショット |
| disabled_by | uuid | YES | | FK→users | |
| disabled_reason | text | YES | | | |
| disabled_at | timestamptz | YES | | | |
| scorecard | jsonb | NO | '{}' | | 毎時の集計結果（直近30日。`{tasks, prReachRate, approvalRate, avgCostUsd, avgSteps, breakerTrips, clamped, aggregatedAt}`。FR-032） |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- 14 は「`template` を削除（仕事へ移す）」と書くが、本表に `template` 列はない（テンプレートは定義の中）。Q-66。
- インデックス：`(repository_id, slug)` UQ、`(organization_id, status)`
- 制約：`status IN ('active','invalid','disabled','removed')`。`status='disabled'` なら `disabled_by` と `disabled_at` は NOT NULL
- 補足：
  - `removed` になっても行は消さない（過去のタスクと監査ログから参照するため）。同じファイル名で定義が戻った場合は、同じ行を使う。
  - `disabled` の間も UC-020 の読み込みで `current_snapshot_id` は更新するが、`status` は `disabled` のままにする（ファイルが消えた場合だけ `removed`）。再開（API-050）のときに、最新のスナップショットから `active` / `invalid` を決め直す。
  - 既定エージェント（`slug = 'default'`。予約。BR-31）は、リポジトリの連携時に作る（TBL-006 のマイグレーション）。`.agent/agents/default.yaml` がなければ `current_snapshot_id` は組み込みの定義のスナップショット（`source = 'builtin'`）、あればその定義のスナップショット（`source = 'branch'`）を指す。既定エージェントは20個の上限（A-34）に数えない。
  - 上限：v0.5 で「1ワークスペースに20体」（14 A-81。A-34 の「1リポジトリ」を読み替え）。
- 想定レコード数：1,000（リポジトリあたり平均2。上限20＋既定エージェント、A-34。v0.2 時点の見積もり）

## TBL-019：agent_snapshots（エージェントスナップショット）
検証・合成した定義（変更しない）。v0.5 で定義は v2（`jobs`・`grants`）の形式（14）。フェーズ0。

<details>
<summary>カラム定義（19列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| agent_id | uuid | YES | | FK→agents | 下書きから作った場合は NULL |
| agent_draft_id | uuid | YES | | FK→agent_drafts | 試し実行の場合（下書きの廃止は Q-67） |
| config_change_id | uuid | （記述なし） | | FK→agent_config_changes | この版を作った設定の変更（v0.5） |
| source | text | NO | | | `branch`（デフォルトブランチ）/ `draft` / `builtin`（組み込みの既定エージェント。BR-31）。アプリ内での変更の値は Q-66 |
| commit_sha | text | YES | | | `branch` の場合 |
| policy_snapshot_id | uuid | NO | | FK→policy_snapshots | 合成に使ったポリシー（Q-64） |
| status | text | NO | | | `valid` / `invalid` |
| definition | jsonb | YES | | | 正規化した定義。v0.5 で v2（エージェント＋全仕事、`grants`・`rules`）。v1 は `jobs` が1つの v2 として読む |
| skills | jsonb | NO | '[]' | | `[{name, description, content, sha256}]` |
| effective_policy | jsonb | YES | | | 合成結果（`compose(ceilings, workspacePolicy, repoPolicy?, agentDef)` の `effective`。13 で引数を追加。FR-023） |
| effective_policy_hash | text | YES | | | `effective_policy` の SHA-256（16進）。intentHash の `policyHash` に使う |
| clamped | jsonb | NO | '[]' | | `[{path, defined, effective}]` |
| ceilings_version | text | NO | | | 合成に使った Hard Ceiling の版。compose() の再現は同じ版で行う（NFR-036） |
| errors | jsonb | NO | '[]' | | `[{file, line, path, code, message}]`（`AGENT_SCHEMA_INVALID`・`AGENT_TRIGGER_CONFLICT` など。FR-022） |
| warnings | jsonb | NO | '[]' | | 同上（`AGENT_CLAMPED`） |
| raw_definition | text | YES | | | 元のYAML（最大64KB） |
| created_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(agent_id, created_at DESC)`、`agent_draft_id`（NULLを除く）、`(agent_id, commit_sha, policy_snapshot_id, ceilings_version)` UQ **WHERE source = 'branch'**（同じ組み合わせは1件。再読み込み時は既存の行を使う）、`(agent_id, policy_snapshot_id, ceilings_version)` UQ **WHERE source = 'builtin'**
- 制約：
  - 変更しない（UPDATE を禁止するトリガー）。
  - `status='valid'` なら `effective_policy` と `effective_policy_hash` は NOT NULL。
  - `source='branch'` なら `agent_id` と `commit_sha` は NOT NULL、`source='draft'` なら `agent_draft_id` は NOT NULL、`source='builtin'` なら `agent_id` は NOT NULL で `commit_sha` は NULL。
- 補足：
  - ポリシーの変更だけの場合（UC-020 2a）も、合成をやり直した新しい行を作る。Hard Ceiling の版が上がった場合も同じ。v0.5 以降はすべての設定の変更が新しい行になる（14 BR-53）。
  - `builtin` は、組み込みの定義（コードに持つ）を `definition` に正規化して保存する（`raw_definition` は NULL）。
  - 「以後も許可」のルールは `definition.rules` に置き、別テーブルは作らない。一覧は現在のスナップショットから読む（15）。
- 想定レコード数：月に約3,000件（v0.2 時点の見積もり）

## TBL-020：agent_schedules（スケジュール）
スケジュールトリガーの展開。v0.5 でスケジュールは仕事ごと（14）。フェーズ0。

<details>
<summary>カラム定義（12列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| agent_id | uuid | NO | | FK→agents | |
| job_id | uuid | （記述なし） | | FK→agent_jobs | v0.5 で追加 |
| trigger_index | int | NO | | | 定義の `triggers` の何番目か（v2 との関係は Q-66） |
| cron | text | NO | | | |
| timezone | text | NO | | | IANA 名 |
| prompt | text | NO | | | |
| next_run_at | timestamptz | NO | | | |
| last_run_at | timestamptz | YES | | | |
| last_result | text | YES | | | `created` / `skipped:<理由>`（`previous_run_active`・`daily_run_limit`・`agent_not_active` など） |
| last_task_id | uuid | YES | | FK→tasks（ON DELETE SET NULL） | 最後に作ったタスク。重複判定（BR-29）に使う |

</details>

- インデックス：`(next_run_at)`。UQ `(agent_id, trigger_index)`
- 補足：
  - スナップショットが変わるたびに、そのエージェントの行を作り直す。同じ `trigger_index` の `cron`・`timezone`・`prompt` が変わらない場合は `last_task_id` を引き継ぐ（A-57）。
  - 起動時に `last_task_id` のタスクが未完了（`queued`〜`executing`）なら、タスクを作らず `trigger.skipped`（`previous_run_active`）を記録し、`next_run_at` だけ進める（BR-29）。エージェントが `active` でなくなったら行を削除する（`disabled` の間は残し、起動時に `trigger.skipped` を記録）。
  - worker は `next_run_at <= now()` の行を `FOR UPDATE SKIP LOCKED` で取り出す。最短間隔（1時間、BR-25）は定義の検証で確認する。
  - フェーズ0で PC が止まっていて実行できなかったスケジュールは後から実行せず、アクティビティに「未実行」として残す（13 A-75）。
- 想定レコード数：500

## TBL-021：agent_drafts（下書き）— 廃止（v0.5、→ TBL-024・TBL-025）
会話・下書きの定義・公開の状態を持っていた。v0.5 で作り方が「名前を付けて頼む」になり廃止した（14 §データベース。[ADR-026](../adr/ADR-026-name-and-ask.md)）。参照している列（TBL-006・011・019）の扱いは Q-67。v0.2 の定義は記録として残す。

<details>
<summary>v0.2 のカラム定義（15列）と制約</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| repository_id | uuid | NO | | FK→repositories | |
| agent_id | uuid | YES | | FK→agents | 既存エージェントの編集の場合 |
| slug | text | NO | | | 公開時のファイル名 |
| created_by | uuid | NO | | FK→users | |
| status | text | NO | 'drafting' | | `drafting` / `published` / `merged` / `discarded` |
| definition_yaml | text | NO | | | 下書きの YAML（コメントを含む。最大64KB） |
| skills | jsonb | NO | '[]' | | 新規・変更した Skill のファイル（`[{name, content}]`。各16KB） |
| conversation_object_path | text | YES | | | 会話の全文（暗号化してオブジェクトストレージに保存。30日） |
| assistant_cost_usd | numeric(10,4) | NO | 0 | | BR-30 の上限の判定に使う |
| last_validation | jsonb | NO | '{}' | | `{errors, warnings, effective, summary}` |
| pr_number | int | YES | | | 公開中のPR |
| last_pr_number | int | YES | | | マージされずにクローズされた直前のPR（`drafting` に戻したときに `pr_number` から移す） |
| created_at / updated_at | timestamptz | NO | now() | | |

- インデックス：`(repository_id, status, updated_at DESC)`、`agent_id`（NULLを除く）、`(repository_id, pr_number)`（NULLを除く）、`(status, updated_at)`
- 制約：`status IN ('drafting','published','merged','discarded')`。`published`・`merged` なら `pr_number` は NOT NULL、`drafting` なら NULL。`assistant_cost_usd <= 0.5` はアプリケーションで判定する（CHECK制約にはしない）
- 補足：`merged` は公開PRのマージを UC-020 で検出したときに設定。マージされずにクローズされたら `drafting` に戻し `pr_number` を `last_pr_number` に移す（UC-019 4a）。90日更新のない `drafting` は `discarded`。API-058 で破棄できるのは `drafting` だけ（A-60）。
- 想定レコード数：月に約500件

</details>

## TBL-022：agent_memories（メモリ）
エージェントのメモリの項目（[ADR-014](../adr/ADR-014-server-side-memory.md)）。フェーズ1（13 §フェーズ計画）。

<details>
<summary>カラム定義（9列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| agent_id | uuid | NO | | FK→agents | |
| source_task_id | uuid | YES | | FK→tasks（ON DELETE SET NULL） | 書き込んだタスク。タスクの保持期間（90日）を過ぎて削除されると NULL |
| source_task_ref | text | NO | | | 表示用の出どころ（例「task 8f2a / Issue #123」）。書き込み時に作り、タスクの削除後も残す |
| content | text | NO | | | 最大500文字（マスク済み） |
| status | text | NO | 'pending' | | `pending` / `active` / `discarded` / `expired` / `deleted` |
| deleted_by | uuid | YES | | FK→users | |
| created_at / updated_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(agent_id, status, created_at DESC)`、`source_task_id`（NULLを除く）
- 制約：`status IN ('pending','active','discarded','expired','deleted')`、`char_length(content) <= 500`。`status='deleted'` なら `deleted_by` は NOT NULL
- 補足：
  - タスクが `succeeded` または `completed`（`report` / `actions_declined`。v0.6 で追加、15）で終わると `pending` を `active` にし、それ以外では `discarded` にする（BR-26）。
  - `active` が200件を超えたら古い順に `expired`（FR-031）。
  - 試し実行の書き込みは行を作らずに捨てる（API-055 の応答は `status: "discarded"`。BR-24・BR-26）。`memory.enabled: false` のエージェントには `remember` を渡さない（呼ばれたら deny）。
  - `pending` の行は書き込んだタスクが終わるまで必ず存在するので、`source_task_id` が NULL になるのは `pending` 以外の行だけである。
- 想定レコード数：最大20万件（200件 × 1,000）。書き込みは月に約1万件

## TBL-023：agent_jobs（仕事）
1つのお願いから作る実行の単位（v0.5。14）。フェーズ0。中身（指示・トリガー・届け先）はスナップショットの定義が正で、このテーブルは一覧と状態のためのもの。

<details>
<summary>カラム定義（9列。14 のとおり）</summary>

| カラム | 型 | NULL | 説明 |
|---|---|---|---|
| id | uuid | NO | PK |
| agent_id | uuid | NO | FK → agents |
| slug | text | NO | エージェントの中で一意（`^[a-z0-9-]{2,40}$`） |
| kind | text | NO | `once` / `recurring` / `watch` |
| template | text | NO | テンプレート名 |
| status | text | NO | `waiting_input` / `active` / `paused` / `done` |
| source_message_id | uuid | YES | きっかけのお願い（FK → agent_messages） |
| created_at / updated_at | timestamptz | NO | |

</details>

- 上限：1エージェントの仕事は10個まで（A-81）。
- 質問への答えが返ってこない仕事は `waiting_input` のまま止める（14）。

## TBL-024：agent_messages（会話）
エージェントのチャット。お願い・カード・結果の要約・変更の記録がすべてここに流れる（v0.5。14）。フェーズ0。

<details>
<summary>カラム定義（7列。14 のとおり）</summary>

| カラム | 型 | NULL | 説明 |
|---|---|---|---|
| id | uuid | NO | PK |
| agent_id | uuid | NO | FK → agents |
| author | text | NO | `user` / `agent` / `system` |
| kind | text | NO | `text` / `question` / `connect` / `confirm` / `approval` / `result` / `change` / `delegate` |
| body | text | YES | 本文（秘密情報をマスクしてから保存。BR-32） |
| ref_id | uuid | YES | カードが指すもの（config change・Intent・report など） |
| created_at | timestamptz | NO | |

</details>

- 保存期間は90日（A-80）。それより古い会話は要約を残して消す（要約の保存先は Q-69）。
- 会話に貼られた外部の文章は、ユーザーの発言として記録する（14）。

## TBL-025：agent_config_changes（設定の変更）
エージェントが自分の定義に加えたい差分と、その分類・状態（v0.5。14、[ADR-027](../adr/ADR-027-classify-widening-changes.md)）。フェーズ0。

<details>
<summary>カラム定義（13列。14 のとおり）</summary>

| カラム | 型 | NULL | 説明 |
|---|---|---|---|
| id | uuid | NO | PK |
| agent_id | uuid | NO | FK → agents |
| origin | text | NO | `user_request` / `feedback` / `failure` / `engagement` / `manual` / `revert` / `move` |
| source_message_id | uuid | YES | きっかけの発言 |
| source_task_id | uuid | YES | きっかけのタスク（`tainted` の判定に使う。BR-51） |
| patch | jsonb | NO | 定義の差分（JSON Patch） |
| classification | text | NO | `narrow` / `neutral` / `widen` |
| widened_items | jsonb | YES | `widen` の項目 |
| status | text | NO | `proposed` / `applied` / `rejected` / `reverted` |
| decided_by | uuid | YES | 承認・却下したユーザー |
| snapshot_id | uuid | YES | 反映後のスナップショット |
| created_at / decided_at | timestamptz | | |

</details>

- 15 の [以後も許可] は監査ログに `agent.config.widened`（`origin = approval_rule`）を残すが、本表の `origin` の値に `approval_rule` はない（ルールは承認カードから作り、本表を通るかは 15 に記述なし）。Q-68。
