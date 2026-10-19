# 08. DB設計：タスク・Intent・承認・記録
- 親：[README.md](README.md) ／ 版数：v0.6（2026-10-01）

> **3行で**
> 1. タスク（TBL-006）を実行の単位とし、外部作用の提案（TBL-008 Intent）・承認（TBL-009）・判定記録（TBL-010）・費用（TBL-011）・監査ログ（TBL-012）をぶら下げる。
> 2. v0.6 で Intent は PR 専用から MCP の書き込みにも広がった：1タスクに複数、`unknown_outcome` を追加、PR 用の列は NULL 可（15）。
> 3. 理由値の保存先・`handoff` の判定値は Q-68、リポジトリのないタスクと NOT NULL 列の矛盾は Q-64。

---

## TBL-006：tasks（タスク）
実行の単位。状態とカウンタを持つ。v0.2 でエージェント・トリガー・試し実行・レポート、v0.4 で汚染、v0.5 で仕事を追加。フェーズ0。

<details>
<summary>カラム定義（44列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations（→ workspaces。Q-62） | |
| repository_id | uuid | NO | | FK→repositories | リポジトリのないタスクとの関係は Q-64 |
| requester_id | uuid | NO | | FK→users | トリガーごとの依頼者（12「トリガーと入口」。スケジュールはエージェント担当者＝定義の `owner`） |
| agent_id | uuid | YES | | FK→agents | 実行するエージェント。試し実行の場合は NULL（v0.2） |
| agent_snapshot_id | uuid | NO | | FK→agent_snapshots | 開始時に固定（BR-22）。試し実行は下書きから作ったスナップショット（v0.2） |
| agent_draft_id | uuid | YES | | FK→agent_drafts | 試し実行の場合（v0.2）。agent_drafts は v0.5 で廃止（Q-67） |
| job_id | uuid | YES | | FK→agent_jobs | どの仕事の実行か（v0.5。14 §データベース）。NULL 可かどうかは 14 に記述なし |
| kind | text | NO | 'issue' | | `issue` / `policy_change`（`issue` は Issue なし・指示文だけのタスクも含む） |
| trigger_type | text | NO | | | `manual` / `github_label` / `github_mention` / `schedule` / `dry_run` / `trust_proposal`（フェーズ2で `slack`）。v0.1 の `trigger` を置き換える（`watch` の扱いは Q-66） |
| is_dry_run | boolean | NO | false | | 試し実行（BR-24）（v0.2） |
| issue_number | integer | YES | | | Issue なしのタスクでは NULL（v0.2 で「kind=issue のとき必須」をやめた） |
| issue_title | text | YES | | | |
| issue_body | text | YES | | | 先頭20,000文字 |
| prompt | text | YES | | | Issue なしのタスクの本文（指示文だけの委任・スケジュールの `prompt`）。2,000文字以内。Issue があるタスクでは NULL（v0.2） |
| instructions | text | YES | | | Issue に対する追加の指示（Web からの委任・メンションのコメント本文）。2,000文字以内 |
| output_type | text | NO | | | `pr` / `report`。テンプレートから決まる（dev-coder は `pr`、reviewer・triager は `report`）（v0.2） |
| report | text | YES | | | レポートの本文（Markdown、最大50,000文字）。`submit_report` で保存（FR-033）。reports（TBL-030）との関係は Q-65 |
| tainted | （未設計） | | | | `web_read` / `mcp_read` の結果を受け取った時点で立てる。解除できない（13 BR-38）。型は Q-65 |
| base_commit_sha | text | NO | | | リポジトリのないタスクとの関係は Q-64 |
| policy_snapshot_id | uuid | NO | | FK→policy_snapshots | タスク開始時に固定。Q-64 |
| status | text | NO | 'queued' | | 04 のタスクのステータス定義。v0.2 で `completed` を追加 |
| halt_reason | text | YES | | | 04 の `halt_reason`。v0.2 で `agent_disabled`（UC-022）を追加 |
| fail_reason | text | YES | | | 04 の `fail_reason`。v0.6 で `action_failed`（Intent に `failed` / `unknown_outcome` を含む）を追加（15） |
| status_detail | text | YES | | | 人が読むための補足（例：作動したBreakerの種類）。`completed` の内訳は `dry_run` / `report` / `actions_declined`（v0.6。15） |
| phase | text | YES | | | `investigate` / `plan` / `implement` / `test` / `review` / `report`（v0.2 で `review`・`report` を追加） |
| steps_used | integer | NO | 0 | | |
| cost_usd | numeric(12,6) | NO | 0 | | 要約を含む、タスクのLLM費用の合計 |
| denied_count | integer | NO | 0 | | |
| repeat_key | text | YES | | | 直前のツール呼び出しのハッシュ |
| repeat_count | integer | NO | 0 | | |
| changed_paths | text[] | NO | '{}' | | edit_code の対象になったパスの集合 |
| sandbox_token_hash | bytea | YES | | | サンドボックストークンの SHA-256 |
| sandbox_token_expires_at | timestamptz | YES | | | 失効させるときは NULL にする |
| sandbox_execution_id | text | YES | | | Cloud Run Jobs の実行ID |
| snapshot_object_path | text | YES | | | tarball の GCS のパス |
| last_heartbeat_at | timestamptz | YES | | | |
| queued_at | timestamptz | NO | now() | | |
| started_at | timestamptz | YES | | | running になった日時 |
| finished_at | timestamptz | YES | | | 終了状態になった日時 |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- タスクの終わり方（v0.6。15）：Intent がない → `completed`（`report`）／すべて `executed`・`verified` → `succeeded`／`rejected`・`expired` を含み `failed`・`unknown_outcome` を含まない → `completed`（`actions_declined`）／`failed`・`unknown_outcome` を1つでも含む → `failed`（`action_failed`。レポートは残る）。`succeeded` の意味は「外部作用がすべて実行された（検証できるものは検証済み）」に広がった。
- インデックス：
  - `(organization_id, status)`、`(organization_id, created_at DESC)`、`requester_id`
  - `(agent_id, created_at DESC)`（スコアカードの集計・エージェント詳細のタスク履歴）、`agent_draft_id`（NULLを除く）
  - `(agent_id, issue_number)` UQ **WHERE status IN ('queued','provisioning','running','awaiting_approval','executing') AND issue_number IS NOT NULL AND NOT is_dry_run**（未完了タスクの重複防止。BR-29 により v0.1 の `(repository_id, issue_number)` から変更。`TASK_ALREADY_ACTIVE`）。対象は Issue のタスクだけ。スケジュールの「前回のタスクが未完了なら起動しない」はインデックスではなく、スケジューラーが `agent_schedules.last_task_id` の状態を見て判定する（TBL-020）
  - `(agent_id, trigger_type, created_at)`（`max_runs_per_day` の集計。試し実行は数えない）
  - `sandbox_token_hash`（UQ、NULLを除く）
- 制約（DDL は [ddl-and-retention.md](ddl-and-retention.md)）：
  - `status`・`kind`・`trigger_type`・`output_type`・`phase` のCHECK制約
  - 入力の存在：`kind = 'policy_change' OR issue_number IS NOT NULL OR prompt IS NOT NULL`
  - 入力の使い分け：`issue_number IS NULL OR prompt IS NULL`。`char_length(prompt) <= 2000`、`char_length(instructions) <= 2000`
  - `halt_reason` の CHECK 制約（04 の値 ＋ `agent_disabled`）
  - 試し実行：`is_dry_run = (trigger_type = 'dry_run')`、`NOT is_dry_run OR (agent_draft_id IS NOT NULL AND agent_id IS NULL)`、`is_dry_run OR agent_id IS NOT NULL`
  - レポート：`report IS NULL OR output_type = 'report'`
- 想定レコード数：月に2,000件（試し実行を含めて月に約2,500件）

<details>
<summary>マイグレーション（v0.1 → v0.2）</summary>

1. リポジトリごとに「既定エージェント」（`agents.slug = 'default'`。リポジトリのポリシーだけで動く dev-coder、トリガーは手動と `open-team` ラベル。BR-31）を作り、現在のポリシースナップショットから `agent_snapshots`（`source = 'builtin'`、`ceilings_version` は移行時の版）を作る。
2. 既存のタスクの `agent_id`・`agent_snapshot_id` を既定エージェントとそのスナップショットで埋める。`trigger` を `trigger_type` に移す（`web` → `manual`、`label` → `github_label`、`trust_proposal` → `trust_proposal`）。`is_dry_run = false`、`output_type = 'pr'`。
3. `agent_snapshot_id` を NOT NULL にし、`trigger` を削除する。重複防止のインデックスを作り直す。
4. 以後、ポリシー変更タスク（`kind = 'policy_change'`）と、エージェントを指定しない既存の入口（既定の `open-team` ラベル）は既定エージェントで実行する。

</details>

## TBL-007：task_events（タスクイベント）
タイムライン（UX 用）。SSE の `id` に使う。フェーズ0から（[D-05](../decisions.md#d-05)）。

<details>
<summary>カラム定義（6列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | bigint | NO | identity | PK | SSEの `id`（`Last-Event-ID`）として使う |
| organization_id | uuid | NO | | FK→organizations | |
| task_id | uuid | NO | | FK→tasks | |
| type | text | NO | | | `phase_started` / `tool_called` / `llm_called` / `status_changed` / `budget_updated` / `message` / `finished` |
| payload | jsonb | NO | | | 種類ごとの内容（09 API-014 を参照） |
| created_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(task_id, id)`
- 想定レコード数：月に約20万件（タスクあたり約100件）

## TBL-008：action_intents（作用の意図）
外部作用の提案と、その実行・検証の結果。v0.6 で MCP の書き込み（`mcp_call`）に広げた（15。[ADR-029](../adr/ADR-029-mcp-arg-roles-destination-fixed.md)・[ADR-031](../adr/ADR-031-mcp-write-no-auto-retry.md)）。フェーズ0。

<details>
<summary>カラム定義（35列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| task_id | uuid | NO | | FK→tasks | v0.6 で UQ を外した（1タスクに複数。既定5件、Hard Ceiling 20件。A-85） |
| job_id | uuid | YES | | FK→agent_jobs | どの仕事から出たか（v0.6）。NULL 可かどうかは 15 に記述なし |
| action_type | text | NO | 'open_pr' | | `open_pr` / `mcp_call`（v0.6） |
| origin | text | （記述なし） | | | `agent`（エージェントが `mcp_call` で呼んだ）/ `deliver`（ランタイムが届け先から作った）（v0.6）。記録用で判定には使わない |
| payload | jsonb | （記述なし） | | | `{ connectorId, tool, arguments, toolHash }`（v0.6。MCP の場合） |
| status | text | NO | 'proposed' | | 04 の Intent のステータス定義。v0.2 で `simulated`、v0.6 で `unknown_outcome` を追加 |
| decision | text | NO | | | `allow` / `deny` / `approve` / `halt`（`simulated` の場合も Kernel の判定結果を記録する）。`handoff` は Q-68 |
| title | text | YES（v0.6） | | | PRのタイトル |
| body | text | YES（v0.6） | | | PRの本文（エージェントが書いた部分） |
| diff | text | YES（v0.6） | | | unified diff（最大5MB） |
| diff_stats | jsonb | YES（v0.6） | | | `{files, additions, deletions}` |
| changed_paths | text[] | YES（v0.6） | | | 変更パス（リネームは両方） |
| test_report | jsonb | YES | | | `{commands[], passed, summary}`（自己申告） |
| self_review | jsonb | YES | | | dev-coder の自己レビューの結果（参考。REQ-028）。`{model, rounds: [{round, verdict: "pass" \| "changes_requested", findings: [...]}], unresolved: [...]}`。自己レビューのないテンプレートでは NULL（v0.2） |
| base_commit_sha | text | YES（v0.6） | | | |
| expected_tree_sha | text | YES（v0.6） | | | サーバーで計算した tree SHA |
| draft | boolean | NO | false | | auto の場合は true |
| policy_hash | text | NO | | | |
| intent_hash | text | NO | | | FR-010 の計算式。MCP は `SHA-256(正規形JSON{actionType, connectorId, tool, arguments, toolHash, effectivePolicyHash})`（15） |
| expires_at | timestamptz | （記述なし） | | | 承認の期限（v0.6）。定期実行の仕事では `min(作成から24時間, 同じ仕事の次の実行の予定時刻)` |
| result | jsonb | YES | | | MCP の応答（上限64KB、マスク済み）（v0.6） |
| branch_name | text | YES | | | `open-team/task-{taskId}` |
| pr_number | integer | YES | | | |
| pr_url | text | YES | | | |
| pr_head_sha | text | YES | | | |
| fail_reason | text | YES | | | MCP の失敗理由（`tool_error` / `unreachable` / `auth_required`）をここに入れるかは Q-68 |
| executed_at | timestamptz | YES | | | |
| verified_at | timestamptz | YES | | | |
| pr_merged_at | timestamptz | YES | | | Webhook で記録（FR-021 の参考情報） |
| pr_closed_at | timestamptz | YES | | | |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- 状態の値（04 と一致させる）：`proposed` / `simulated` / `denied` / `pending_approval` / `approved` / `rejected` / `expired` / `executing` / `executed` / `verified` / `failed` / `unknown_outcome`。
  - `executed`：検証が `none` のツールでは終了。`readback`（フェーズ1）のときだけ `verified` / `failed` へ進む（15）。
  - `unknown_outcome`（v0.6）：送信後に応答が返らなかった。ユーザーの確認で `executed` / `failed` へ（API-070）。
  - `expired` の理由に `superseded`（次の実行に置き換え）と `tool_changed`（ツールが `needs_review` になった）を追加（15）。保存先の列は Q-68。
- 制約（v0.6。15）：PR 専用の列（`title`・`body`・`diff`・`diff_stats`・`changed_paths`・`base_commit_sha`・`expected_tree_sha`）は、`action_type = 'open_pr'` のときだけ NOT NULL を CHECK で課す。
- インデックス：`(organization_id, status)`、`(organization_id, pr_number)`、`task_id`（v0.6 で UQ ではなくなった）
- 補足：
  - `simulated` の Intent には approvals を作らず、Gateway にも渡さない。承認カードのプレビュー（API-013 の `intent.preview`）は、この行とリスク評価から都度組み立てる。
  - `self_review` は承認カード（API-018）とタスク詳細（API-013）で「AIによる自己レビュー（参考）」として返す。リスク評価（BR-13）とは別に扱う。
  - 「以後も許可」のルールは別テーブルを作らず、エージェント定義（スナップショット）の `rules` に置く（15）。
- 想定レコード数：月に約1,000件（`simulated` を含めて月に約1,300件。v0.2 時点の見積もり）

## TBL-009：approvals（承認）
承認依頼とその決定。承認は intentHash に紐づく（[ADR-005](../adr/ADR-005-approval-bound-to-intent-hash.md)）。フェーズ0。

<details>
<summary>カラム定義（19列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| task_id | uuid | NO | | FK→tasks | |
| intent_id | uuid | NO | | FK→action_intents、UQ | |
| status | text | NO | 'pending' | | `pending` / `approved` / `rejected` / `expired` |
| risk_level | text | NO | | | `low` / `medium` / `high`（MCP の書き込みの加点は 15 §承認カード） |
| risk_score | integer | NO | | | |
| risk_reasons | jsonb | NO | | | `[{code, points, detail}]` |
| summary | text | YES | | | AIによる要約（生成できなかった場合は NULL） |
| summary_model | text | YES | | | |
| approver_ids | uuid[] | NO | | | 作成時に計算した承認できるユーザー（BR-14） |
| decided_by | uuid | YES | | FK→users | |
| decision_comment | text | YES | | | 1,000文字以内 |
| decided_at | timestamptz | YES | | | |
| remember | boolean | （記述なし） | | | [以後も許可] で決定したか（v0.6） |
| created_rule_id | （記述なし） | YES | | | [以後も許可] で作ったルールの ID（v0.6）。ルールは定義の `rules[].id`（例 `r-7f3a`）にある |
| expires_at | timestamptz | NO | | | 作成から24時間後（A-05）。定期実行の仕事では `min(24時間, 次の実行の予定時刻)`（v0.6。BR-60） |
| created_at | timestamptz | NO | now() | | |
| updated_at | timestamptz | NO | now() | | |

</details>

- インデックス：`intent_id`（UQ）、`(status, expires_at)`（期限切れの処理用）、`approver_ids`（GIN）
- 想定レコード数：月に約1,000件

## TBL-010：policy_decisions（判定記録）
判定エンジンの入力と出力（再現性のため）。フェーズ0。

<details>
<summary>カラム定義（15列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| task_id | uuid | NO | | FK→tasks | |
| intent_id | uuid | YES | | FK→action_intents | subject_kind=intent の場合 |
| subject_kind | text | NO | | | `tool_call` / `llm_call` / `intent` |
| action_type | text | YES | | | llm_call の場合は NULL |
| subject | jsonb | NO | | | 判定の対象（ツール名・引数のハッシュ・パス・見積額など）。v0.6 で `subject.tool`・`subject.origin` が加わる（15 §decide() の拡張） |
| counters | jsonb | NO | | | 判定時のカウンタ（v0.6 で `intentsCount`） |
| flags | jsonb | NO | | | 判定時のフラグ |
| decision | text | NO | | | `allow` / `deny` / `approve` / `halt`（`handoff` は Q-68） |
| reason_code | text | NO | | | 例：`path_denied`、`budget_exceeded`。v0.6 で `not_granted`・`tool_needs_review`・`connector_disabled`・`intent_limit` |
| matched_rule | text | YES | | | 例：`paths.deny[1]`、`rules[i]` |
| matched_rule_id | text | YES | | | 一致した「以後も許可」のルールの id（`rule_matched`・`certificate_missing` だけ。1〜128 文字。0015、SG-09）。添字の `matched_rule` は定義の変更でずれるので id でも指す。「最後に使った時刻」は本番のタスク（試し実行・リハーサル・影を除く）だけで数える |
| inputs_hash | text | NO | | | 入力の正規形JSONの SHA-256 |
| kernel_version | text | NO | | | 判定エンジンのバージョン（再現のため） |
| created_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(task_id, created_at)`、`intent_id`、`(workspace_id, matched_rule_id, created_at) WHERE matched_rule_id IS NOT NULL`
- 想定レコード数：月に約30万件

## TBL-011：usage_records（利用記録）
LLM 呼び出しごとのトークン数と費用。フェーズ0（予算の判定に使う）。

<details>
<summary>カラム定義（16列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| repository_id | uuid | NO | | FK→repositories | Q-64 |
| task_id | uuid | YES | | FK→tasks | 設計アシスタントの呼び出しでは NULL（v0.2） |
| agent_draft_id | uuid | YES | | FK→agent_drafts | 設計アシスタントの呼び出し（`phase = 'design'`）の場合（v0.2）。設定プランナーへの置き換えは Q-67 |
| provider | text | NO | | | `anthropic` / `openai` / `openrouter` |
| model | text | NO | | | |
| phase | text | NO | | | `investigate` / `plan` / `implement` / `test` / `summarize` / `review` / `report` / `design` |
| input_tokens | integer | NO | | | |
| output_tokens | integer | NO | | | |
| estimated_cost_usd | numeric(12,6) | NO | | | 事前見積もり（BR-10） |
| cost_usd | numeric(12,6) | NO | | | 実費（価格表で計算） |
| latency_ms | integer | NO | | | |
| prompt_hash | text | NO | | | |
| transcript_object_path | text | YES | | | 全文を保存した場合の GCS のパス |
| created_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(organization_id, created_at)`、`(repository_id, created_at)`、`task_id`、`agent_draft_id`（NULLを除く）
- 制約：`(task_id IS NOT NULL) <> (agent_draft_id IS NOT NULL)`（どちらか一方だけ）。設計アシスタントの費用もリポジトリの日次予算に含めるため（A-35）、`repository_id` で集計できるようにする
- 想定レコード数：月に約16万件（設計アシスタントを含めて月に約17万件）

## TBL-012：audit_logs（監査ログ）
ハッシュチェーンつきの追記専用ログ。フェーズ0から省略しない（13 §フェーズ0）。

<details>
<summary>カラム定義（10列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| organization_id | uuid | NO | | PK1, FK→organizations | |
| seq | bigint | NO | | PK2 | ワークスペース内の連番（1から） |
| occurred_at | timestamptz | NO | now() | | |
| event_type | text | NO | | | 04 FR-016 のイベント一覧（v0.5 で `agent.created` などを追加。14 §統制との関係） |
| actor_type | text | NO | | | `user` / `system` / `agent` / `github` |
| actor_id | text | YES | | | ユーザーID、サービス名など |
| task_id | uuid | YES | | | 絞り込み用（外部キーは張らない。タスクを削除しても残すため） |
| payload | jsonb | NO | | | イベントの内容（秘密情報は含めない） |
| prev_hash | bytea | NO | | | |
| hash | bytea | NO | | | FR-016 の計算式 |

</details>

- インデックス：PK `(organization_id, seq)`、`(organization_id, occurred_at)`、`(organization_id, task_id)`、`(organization_id, event_type, occurred_at)`
- 制約：UPDATE・DELETE を禁止するトリガー
- 想定レコード数：月に約30万件（NFR-017）。パーティション分割の時期は Q-60

## TBL-015：trust_proposals（信頼度提案）
自律レベル引き上げの提案（リポジトリ単位）。フェーズ1。

<details>
<summary>カラム定義（12列）</summary>

| カラム | 型 | NULL | デフォルト | キー | 説明 |
|---|---|---|---|---|---|
| id | uuid | NO | gen_random_uuid() | PK | |
| organization_id | uuid | NO | | FK→organizations | |
| repository_id | uuid | NO | | FK→repositories | |
| action_type | text | NO | | | MVPでは `open_pr` |
| from_level | text | NO | | | `approve` |
| to_level | text | NO | | | `auto` |
| evidence | jsonb | NO | | | `{approved, rejected, breakerTrips, windowDays}` |
| status | text | NO | 'open' | | `open` / `accepted` / `dismissed` |
| decided_by | uuid | YES | | FK→users | |
| decided_at | timestamptz | YES | | | |
| task_id | uuid | YES | | FK→tasks | 受け入れた場合に作るポリシー変更タスク |
| created_at | timestamptz | NO | now() | | |

</details>

- インデックス：`(repository_id, action_type, status)`
