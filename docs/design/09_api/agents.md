# 09. API設計：エージェント・会話・仕事
- プロジェクト：open-team（仮称） ／ 版数：v0.6（2026-10-01） ／ 入口：[README.md](README.md) ／ 共通仕様：[common.md](common.md)

> **3行で**
> 1. v0.5 でエージェントは「名前を付けて頼む」で作る（API-060）。会話（API-061・062）でお願いし、広げる設定変更だけを確認カード（API-063）で承認する（[ADR-026](../adr/ADR-026-name-and-ask.md)・[ADR-027](../adr/ADR-027-classify-widening-changes.md)）。
> 2. 仕事（jobs）の一覧・一時停止・移動（API-065・066）、結果への反応（API-067）、元に戻す（API-064）を追加（[ADR-028](../adr/ADR-028-jobs-as-unit-of-work.md)）。
> 3. v0.2 の一覧・詳細・停止・再開・メモリ（API-041・042・049〜052・059）はそのまま使う。応答の形は定義 v1 のまま（Q-75）。

## 🧭 判断してほしいこと
- [Q-74](README.md#-判断してほしいこと)：API-053（Skill の下書き）と API-054（テンプレート一覧）の v0.5 以降の扱い。
- [Q-75](README.md#-判断してほしいこと)：定義 v2（`jobs`・`grants`、`agents.template` の削除、`role`・`appearance`）に合わせた API-041・042・059 の応答。
- [Q-79](README.md#-判断してほしいこと)：API-060 の応答と API-062 の SSE のイベント形式が未設計。

## 要点
- 作成と会話（v0.5）：[API-060〜064](#api-060post-apiv1agents)
- 仕事と反応（v0.5）：[API-065〜067](#api-065get-apiv1agentsagentidjobs--patch-apiv1agentsagentidjobsjobid)
- 一覧・詳細：[API-041](#api-041get-apiv1reposrepoidagents)・[API-042](#api-042get-apiv1agentsagentid)・[API-059](#api-059get-apiv1orgsorgidagents)
- 停止・再開：[API-049](#api-049post-apiv1agentsagentiddisable)・[API-050](#api-050post-apiv1agentsagentidenable)
- メモリ：[API-051](#api-051get-apiv1agentsagentidmemories)・[API-052](#api-052delete-apiv1agentsagentidmemoriesmemoryid)
- Skill・テンプレート：[API-053](#api-053post-apiv1taskstaskidskill-drafts)・[API-054](#api-054get-apiv1agent-templates)

---

## 詳細

### API-060：POST /api/v1/agents
- 概要（v0.5）：`{ name? }` で作成し、挨拶のメッセージを返す。廃止した API-043（下書きの作成）を置き換える（FR-034）。
- 名前を空にすると仮の名前「新しいエージェント」で始まり、最初のお願いから名前を提案して付ける。名前はワークスペースの中で重複できず、重複する場合は末尾に番号を付ける（14 §名前なしで作る）。
- 作成直後は仕事も付与もなく、最初の境界（`web_read: auto`、`notify`・`submit_report`、`memory_write: auto`、予算 `per_task_usd: 0.2`・`per_day_usd: 1`・`max_runs_per_day: 10`。ワークスペースのポリシーより低い場合はそちら）だけを持つ（14 §最初の境界、A-79）。
- 監査ログ：`agent.created`。上限：ワークスペースのエージェントは20体まで（A-81）。

### API-061：GET /api/v1/agents/{agentId}/messages
- 概要（v0.5）：会話の取得（カーソルでページング）。データ元：TBL-024（`agent_messages`）。
- 発言の `kind`：`text` / `question` / `connect` / `confirm` / `approval` / `result` / `change` / `delegate`。`ref_id` はカードが指すもの（設定の変更・Intent・レポートなど）。
- 会話の保存期間は90日。それより古いものは要約を残して消す（A-80）。

### API-062：POST /api/v1/agents/{agentId}/messages
- 概要（v0.5）：お願い・返答の送信。応答は SSE で、エージェントの発言とカードを順に返す（FR-035・FR-038）。
- 処理：設定プランナー（LLM）が定義の差分（JSON Patch）と確認事項 `{ patch, questions[≤1], summary, suggested_name?, delegate_to? }` を作り、Kernel の `classify()` で `narrow` / `neutral` / `widen` に分ける。`narrow`・`neutral` はすぐ反映し、`widen` は確認カード（API-063）を出す（BR-47）。1つのお願いに出す質問は1つまで（BR-49）。
- 設定プランナーの費用は `usage_records` に `agent_id` つき・`task_id` は NULL で記録する（BR-30 と同じ）。
- 設定プランナーは「以後も許可」のルールを提案・追加できない（BR-57）。
- SSE のイベント名と `data` の形は未設計（[Q-79](README.md#-判断してほしいこと)）。

### API-063：POST /api/v1/agents/{agentId}/config-changes/{changeId}/decision
- 概要（v0.5）：`widen` の確認カードの操作。リクエスト `{ "decision": "approve" | "reject" }`。
- 副作用：TBL-025（`agent_config_changes`）の `status` を `applied` / `rejected`、`decided_by` を記録。承認した `widen` は監査ログ `agent.config.widened`（変更前後の差分・きっかけの発言の ID・承認者。BR-55）。承認するまで、その変更を必要とする仕事は開始しない。

### API-064：POST /api/v1/agents/{agentId}/config-changes/{changeId}/revert
- 概要（v0.5）：元に戻す。`narrow` または `neutral` として即時に反映する（BR-53）。
- 副作用：新しいスナップショット、TBL-025 の `status = reverted`、監査ログ `agent.config.reverted`。戻した調整と同じ種類の調整は、その仕事では14日間自動で行わない（BR-54）。

### API-065：GET /api/v1/agents/{agentId}/jobs ／ PATCH /api/v1/agents/{agentId}/jobs/{jobId}
- 概要（v0.5）：仕事の一覧（GET）と、一時停止・再開・削除（PATCH）。1つの ID で2つのエンドポイントを指す（14 §API のとおり）。
- データ元：TBL-023（`agent_jobs`。`kind` は `once` / `recurring` / `watch`、`status` は `waiting_input` / `active` / `paused` / `done`）。仕事の中身（指示・トリガー・届け先）はスナップショットの定義が正。
- 監査ログ：`job.paused` など。上限：1エージェントの仕事は10個まで（A-81）。

### API-066：POST /api/v1/agents/{agentId}/jobs/{jobId}/move
- 概要（v0.5）：`{ "to_agent_id" }` で仕事を別のエージェントに移す（UC-027。[任せる] を押したときだけ）。
- 処理：移した先の境界で `classify()` をやり直し、`widen` があれば確認カードを出す。元のエージェントの付与は、移した仕事だけが使っていたものを外す（`narrow`）。監査ログ `job.moved`。

### API-067：POST /api/v1/reports/{reportId}/feedback
- 概要（v0.5）：結果への 👍 / 👎 と理由（長い・古い・関係ない・間違い）。自己調整（FR-039）の入力になる。
- `reportId` は TBL-030（`reports`）の ID。フィードバックの保存先は未設計（08 Q-65）。

### API-041：GET /api/v1/repos/{repoId}/agents
> **v0.17（2026-10-14、実装）**：パスは `GET /api/v1/agents`（ワークスペース単位。リポジトリの切り替えは D-25 で外した）。応答は `{ items, limit, count }`。
> `items[]` は 担当（`id`・`name`・`nameSource`・`role`・`roleLabel`）、いまの様子（`activity`：`running` / `awaiting_approval` / `disabled` / `idle` と固定の文 `activityText`）、
> 数（`jobCount`・`askCount`・`taskCount`。本番のタスクだけ。リハーサル・影の走行は数えない：BR-67①）、`lastActiveAt`、生まれた依頼 `bornAskId`、
> 関わった依頼 `asks[]`（新しい順に5件。`summary` はその依頼でその担当がすること）、仕事 `jobs[]`（`kindLabel`・`templateLabel` は固定の文）。
> **成長の1行（D-120、10/15 夜）**：`items[]` に `growth`（`reuseCount`＝使い回した依頼の数、`allowedRuleCount`＝以後も許可のルール、`tightenedCount`＝権限を絞った回数、`skillCount`）と、0 でない項目だけを「 · 」でつないだ `growthLine`（例「使い回し 4回 · 以後も許可 2件 · 権限を絞った 1回 · スキル 3件」）を足す。`bornAskId` は `asks[]` の5件からではなく全期間の最古の「新しく作った」依頼から求める。安全チェックの結果は仕事ごとなので数えない。
> **API-075（依頼の画面の取得。仮）**：段（`StageView`）に `isNew: boolean` と `reuseLine: string | null`（「新しく作りました」／「いつもの担当 · 前の依頼 N件でも働きました」）を足す。09 の API 一覧への正式な反映はハッカソンの提出後。
> `removed` は出さない。並びは最後に動いた順 → 作った順の新しい順。契約（zod）は `apps/app/src/agents/contract.ts`、問い合わせは `packages/db/src/repo/agents.ts`。下は v0.2 の設計。

- 権限：viewer 以上
- クエリ：`status`（任意、カンマ区切り。既定は `active,invalid,disabled`。`removed` は指定した場合だけ返す）
- `clamped` は、現在のスナップショットに `clamped` の項目がある（「ポリシーにより制限中」）。既定エージェント（`slug: "default"`）も一覧に含め、`limit`（20）には数えない（BR-31）。`disabled` は停止中の場合に `{ "by": "ren", "reason": "誤検知が多い", "at": "..." }`。`drafts.count` は、このリポジトリの `drafting` / `published` の下書きの数（下書きは v0.5 で廃止）。
- データ元：TBL-018、TBL-019（現在のスナップショット）、TBL-020（`nextRunAt`）、TBL-006（`runsToday`）、TBL-021（`drafts`）
- エラー：404 `NOT_FOUND`

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": "ag1...", "slug": "bug-fixer", "name": "バグ修正係", "template": "dev-coder",
      "status": "active", "owner": "aoi",
      "triggers": [ { "type": "manual" }, { "type": "github_label", "label": "agent:bug-fixer" }, { "type": "github_mention" } ],
      "clamped": false, "nextRunAt": null,
      "runsToday": 3, "maxRunsPerDay": 10,
      "scorecard": { "tasks": 12, "approvalRate": 0.83, "avgCostUsd": "0.740000" },
      "disabled": null },
    { "id": "ag2...", "slug": "deps-bot", "name": "依存更新係", "template": "dev-coder",
      "status": "active", "owner": "aoi",
      "triggers": [ { "type": "schedule", "cron": "0 9 * * 1", "timezone": "Asia/Tokyo" }, { "type": "manual" } ],
      "clamped": true, "nextRunAt": "2026-10-06T00:00:00Z",
      "runsToday": 0, "maxRunsPerDay": 1,
      "scorecard": { "tasks": 4, "approvalRate": 1.0, "avgCostUsd": "0.410000" },
      "disabled": null }
  ],
  "drafts": { "count": 2 },
  "limit": 20
}
```

</details>

### API-042：GET /api/v1/agents/{agentId}
- 権限：viewer 以上
- 定義のキーは YAML のキー（snake_case）をそのまま返す（API-008 と同じ）。`status` が `invalid` の場合、`snapshot` は最新の（無効な）スナップショットを返し、`errors` に検証結果を入れる。
- `schedules` は `[{ "triggerIndex", "cron", "timezone", "prompt", "nextRunAt", "lastRunAt", "lastResult" }]`。`snapshot.source` は `branch` / `builtin`（`.agent/agents/default.yaml` がない既定エージェント。`commitSha` は `null`。BR-31）。`ceilingsVersion` は合成に使った Hard Ceiling の版（NFR-036）。停止中でも `snapshot` は最新の定義を返す（UC-020 3a）。
- データ元：TBL-018、TBL-019、TBL-020、TBL-015（エージェント単位の信頼度提案。FR-032）
- エラー：404 `NOT_FOUND`

<details>
<summary>レスポンス（200）の例（定義 v1）</summary>

```json
{
  "id": "ag1...",
  "repository": { "id": "r1...", "fullName": "owner/app" },
  "slug": "bug-fixer",
  "status": "active",
  "disabled": null,
  "snapshot": {
    "id": "as1...",
    "source": "branch",
    "commitSha": "9e1d2f...",
    "policySnapshotId": "p1...",
    "ceilingsVersion": "2026-10-01",
    "status": "valid",
    "definition": {
      "version": 1, "name": "バグ修正係", "description": "再現手順つきのバグIssueを直してPRを出す",
      "template": "dev-coder", "owner": "aoi", "skills": ["fix-flaky-test"],
      "triggers": [ { "type": "manual" }, { "type": "github_label", "label": "agent:bug-fixer" }, { "type": "github_mention" } ],
      "max_runs_per_day": 10, "approvers": ["ren"], "memory": { "enabled": true, "max_items": 200 }
    },
    "effectivePolicy": {
      "autonomy": { "read": "auto", "edit_code": "auto", "run_tests": "auto", "open_pr": "approve", "memory_write": "auto" },
      "budget": { "per_task_usd": 1, "per_day_usd": 5, "max_steps": 60, "max_minutes": 30 },
      "paths": { "allow": ["src/**", "test/**"], "deny": [".github/workflows/**", "infra/**", "src/billing/**"] },
      "commands": { "allow": ["npm test"] },
      "approvers": ["ren"]
    },
    "effectivePolicyHash": "4e07...",
    "clamped": [],
    "errors": [],
    "warnings": [],
    "summary": ["`src/**` と `test/**` のファイルを変更できます（`src/billing/**` を除く）", "PRを作るには ren の承認が必要です", "1回あたり最大 $1.00、1日 $5.00 まで"],
    "createdAt": "2026-09-30T10:00:00Z"
  },
  "schedules": [],
  "runsToday": 3,
  "scorecard": {
    "windowDays": 30, "tasks": 12, "prReachRate": 0.75, "approvalRate": 0.83,
    "avgCostUsd": "0.740000", "avgSteps": 41, "breakerTrips": 1,
    "breakerTripsByType": { "same_action_repeat": 1 }, "clamped": false,
    "aggregatedAt": "2026-10-01T03:00:00Z"
  },
  "trustProposals": []
}
```

</details>

### API-049：POST /api/v1/agents/{agentId}/disable
- 権限：maintainer 以上（BR-27）
- リクエストボディ：`reason`（必須、1〜500文字）
- レスポンス（200）：`{ "agentId": "ag1...", "status": "disabled", "disabledAt": "2026-10-01T03:10:00Z", "affectedTaskIds": ["t3..."] }`
- 冪等性：すでに停止中なら、何もせずに現在の状態を返す（200）。
- エラー：403 `FORBIDDEN`、404 `NOT_FOUND`、422 `AGENT_NOT_ACTIVE`（`removed`）
- 副作用：TBL-018 の更新（`disabled`）。そのエージェントの未終了のタスクを FR-015 と同じ手順で停止する（p95 ≤ 10秒）。停止したタスクは `halted`（`halt_reason = agent_disabled`。UC-022）。承認待ちの承認と Intent は `expired`。監査ログ `agent.disabled`。エージェント担当者（定義の `owner`）と組織の owner に通知（BR-27）

### API-050：POST /api/v1/agents/{agentId}/enable
- 権限：組織の owner（ロールの owner。エージェント定義の `owner`＝エージェント担当者ではない。BR-27）
- リクエストボディ：`reason`（必須、1〜500文字。API-021 と同じ）
- レスポンス（200）：API-042 と同じ形。`status` は最新のスナップショットから決め直す（`valid` なら `active`、`invalid` なら `invalid`）
- 冪等性：停止中でなければ、何もせずに現在の状態を返す（200）。
- エラー：403 `FORBIDDEN`、404 `NOT_FOUND`、422 `AGENT_NOT_ACTIVE`（`removed`）
- 副作用：TBL-018 の更新、スケジュールの次回時刻の再計算（TBL-020）、監査ログ `agent.enabled`、エージェント担当者と組織の owner に通知。停止したタスクは再開しない。停止中に定義が更新されていた場合は、その最新のスナップショットで再開する（UC-020 3a）

### API-051：GET /api/v1/agents/{agentId}/memories
- 権限：viewer 以上
- クエリ：`status`（既定は `active`。`pending` / `active` / `discarded` / `expired` / `deleted` をカンマ区切り）、`cursor`、`limit`
- `source.ref` は `agent_memories.source_task_ref`（表示用の出どころ）。タスクが保持期限で削除された後は `source.taskId` が `null` になり、`ref` だけが残る（12 FR-031）。
- データ元：TBL-022

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": "m1...", "content": "テストは vitest。jest ではない", "status": "active",
      "source": { "taskId": "8f2a...", "ref": "task 8f2a / Issue #130" },
      "createdAt": "2026-09-28T03:00:00Z", "deletedBy": null }
  ],
  "counts": { "active": 14, "pending": 0, "maxItems": 200 },
  "nextCursor": null
}
```

</details>

### API-052：DELETE /api/v1/agents/{agentId}/memories/{memoryId}
- 権限：maintainer 以上
- レスポンス（204）
- エラー：403 `FORBIDDEN`、404 `NOT_FOUND`（すでに `deleted` の場合も）
- 副作用：TBL-022 の更新（`status=deleted`、`deleted_by`）。次のタスクから使われない（実行中のタスクには反映しない）。監査ログ `agent.memory_deleted`（内容は記録せず、項目の ID と出どころのタスクだけ）

### API-053：POST /api/v1/tasks/{taskId}/skill-drafts
- 権限：maintainer 以上
- リクエストボディ：`name`（任意。Skill の名前 `^[a-z0-9-]{2,40}$`。省略時はアシスタントが提案する）
- 処理（UC-024）：タスクのエージェントの現在の定義を複製した下書き（`source=agent` と同じ）を作り、設計アシスタントがタスクの経過（ツール呼び出しの列と差分の要約）から `SKILL.md` の下書きを作って、`skills` と定義の `skills` に追加する。既定エージェントのタスクの場合は、新規エージェントの下書きにする。
- レスポンス（201）：廃止した API-044 と同じ形（[Q-74](README.md#-判断してほしいこと)）
- エラー：403 `FORBIDDEN`、404 `NOT_FOUND`、409 `TASK_NOT_COMPLETED`（`succeeded` または `completed`（`report`）で終わっていない。`completed`（`dry_run`）を含む、または試し実行）、422 `AGENT_NOT_ACTIVE`（`removed`）、422 `LLM_CREDENTIAL_MISSING`、502 `LLM_UPSTREAM_ERROR`
- 副作用：TBL-021 の INSERT、TBL-011 の INSERT（`agent_draft_id`。この費用は新しい下書きの `assistant_cost_usd` に含め、リポジトリの日次予算にも含める）。`SKILL.md` の下書きは秘密情報をマスクしてから保存する（BR-32）

### API-054：GET /api/v1/agent-templates
- 権限：セッション
- データ元：`packages/harness/templates/`（DB ではない。FR-029）
- 13 で追加したテンプレート（`researcher` / `briefer` / `watcher` / `assistant`）の応答例は未設計（[Q-74](README.md#-判断してほしいこと)）。

<details>
<summary>レスポンス（200）の例（v0.2 のテンプレート）</summary>

```json
{
  "items": [
    { "id": "dev-coder", "name": "開発（PRを作る）",
      "description": "バグ修正、小さな機能追加、依存関係の更新",
      "phases": ["investigate", "plan", "implement", "test", "review", "submit"],
      "tools": ["list_files", "read_file", "search", "write_file", "apply_patch", "delete_file", "run_command", "load_skill", "remember", "submit_intent", "finish"],
      "outputType": "pr",
      "defaultDefinitionYaml": "version: 1\ntemplate: dev-coder\n..." },
    { "id": "reviewer", "name": "レビュー（レポート）", "description": "PRのセルフチェック、脆弱性・技術的負債の調査",
      "phases": ["investigate", "review", "report"], "outputType": "report", "tools": ["..."], "defaultDefinitionYaml": "..." },
    { "id": "triager", "name": "トリアージ（レポート）", "description": "Issue の分類・優先度・担当の提案",
      "phases": ["investigate", "report"], "outputType": "report", "tools": ["..."], "defaultDefinitionYaml": "..." }
  ]
}
```

</details>

### API-059：GET /api/v1/orgs/{orgId}/agents
- 権限：viewer 以上
- 概要：組織のすべてのリポジトリのエージェントを返す（ホーム SCR-002 の「停止中・制限中のエージェント」と、エージェントタブ `/agents` 用）。
- クエリ：`status`（任意、カンマ区切り。既定は `active,invalid,disabled`）、`clamped`（任意、boolean）、`cursor`、`limit`（A-67）
- 各項目は API-041 の項目から `triggers`・`runsToday`・`scorecard` を除き、`repository` を加えたもの。
- データ元：TBL-018、TBL-019、TBL-020、TBL-004
- エラー：404 `NOT_FOUND`

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": "ag3...", "repository": { "id": "r1...", "fullName": "owner/app" },
      "slug": "weekly-review", "name": "週次レビュー", "template": "reviewer",
      "status": "disabled", "owner": "aoi", "clamped": false, "nextRunAt": null,
      "disabled": { "by": "ren", "reason": "誤検知が多い", "at": "2026-09-30T08:00:00Z" } }
  ],
  "counts": { "active": 5, "invalid": 0, "disabled": 1, "clamped": 1 },
  "nextCursor": null
}
```

</details>

## 前提・仮定
- A-67：API-059 の既定の `status` は `active,invalid,disabled` とし、`clamped` での絞り込みと状態ごとの件数（`counts`）を返す。
