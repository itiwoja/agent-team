# 09. API設計：タスク
- プロジェクト：open-team（仮称） ／ 版数：v0.6（2026-10-01） ／ 入口：[README.md](README.md) ／ 共通仕様：[common.md](common.md)

> **3行で**
> 1. タスクの作成（委任。API-011）、一覧・詳細（API-012・013）、タイムライン（API-014、SSE は API-015）、キャンセル（API-016）。
> 2. 作成時に `agentId` が必須で、`issueNumber` と `prompt` のどちらか一方を指定する。起動できない理由は 422 / 423 / 429 で返す（判定順あり）。
> 3. 15（v0.6）でタスクの終わり方と 1タスク複数 Intent が変わった。API-013 の `intent` の形はまだ1件前提（Q-76）。

## 🧭 判断してほしいこと
- [Q-74](README.md#-判断してほしいこと)：試し実行（API-047）の廃止後の `isDryRun`・`agentDraftId`・`intent.preview` の扱い。
- [Q-75](README.md#-判断してほしいこと)：定義 v2（仕事 `jobs`）と API-011 の関係（タスクの `job_id`）。
- [Q-76](README.md#-判断してほしいこと)：MCP の Intent（1タスク複数）に合わせた API-013 の `intent` の形。

## 要点
- 作成：[API-011](#api-011post-apiv1tasks)（エラーの判定順つき）。Issue 一覧は [API-010](#api-010get-apiv1reposrepoidissues)。
- 参照：[API-012](#api-012get-apiv1tasks)・[API-013](#api-013get-apiv1taskstaskid)。終わり方の値は [タスクの終わり方（v0.6）](#タスクの終わり方v06)。
- タイムライン：[API-014](#api-014get-apiv1taskstaskidevents)・[API-015](#api-015get-apiv1taskstaskidstream)（[ADR-007](../adr/ADR-007-sse-realtime.md)）。
- キャンセル：[API-016](#api-016post-apiv1taskstaskidcancel)。

---

## 詳細

### API-010：GET /api/v1/repos/{repoId}/issues
- クエリ：`q`（任意。タイトルの検索）、`cursor`、`limit`
- 備考：`gateway` 経由で GitHub から取得し、`activeTaskId` は TBL-006 の未完了タスクと突き合わせる。
- エラー：502 `GITHUB_UPSTREAM_ERROR`

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "number": 128, "title": "Add unit tests for util", "labels": ["good first issue"],
      "author": "sora", "updatedAt": "2026-09-29T08:00:00Z", "activeTaskId": null }
  ],
  "nextCursor": "Y3Vyc29y..."
}
```

</details>

### API-011：POST /api/v1/tasks
- 権限：maintainer 以上、かつ GitHub 上でリポジトリへの書き込み権限がある（BR-07）
- リクエストボディ：

  | フィールド | 型 | 必須 | 説明 |
  |---|---|---|---|
  | repositoryId | uuid | ○ | |
  | agentId | uuid | ○ | 委任先のエージェント（v0.2）。`repositoryId` のリポジトリのエージェントであること |
  | issueNumber | integer | △ | `issueNumber` と `prompt` のどちらか一方が必須（v0.2 で任意に変更） |
  | prompt | string | △ | Issue を指定しない場合の指示文。1〜2,000文字（v0.2） |
  | instructions | string | − | Issue に対する追加の指示。2,000文字以内。`issueNumber` を指定した場合だけ指定できる（`prompt` は Issue なしのタスクの本文で、追加の指示には使わない。12 FR-028） |

- レスポンス（201）：API-013 と同じ形（`triggerType: "manual"`）
- エラー：

  | HTTP | code | 条件 |
  |---|---|---|
  | 400 | `VALIDATION_ERROR` | 入力の形式が正しくない。`issueNumber` と `prompt` の両方がない、または両方ある。`prompt` と `instructions` を同時に指定した。2,000文字を超えた |
  | 403 | `FORBIDDEN` | ロールまたは GitHub 上の権限が足りない |
  | 404 | `NOT_FOUND` | エージェントがない、または別のリポジトリのエージェント |
  | 409 | `TASK_ALREADY_ACTIVE` | 同じエージェントの同じ Issue に未完了のタスクがある（BR-29。`prompt` だけのタスクは判定しない。試し実行は数えない） |
  | 422 | `POLICY_INVALID` / `LLM_CREDENTIAL_MISSING` / `ISSUE_NOT_OPEN` | FR-005 |
  | 422 | `AGENT_NOT_ACTIVE` | エージェントが `invalid` / `removed`（公開 PR が未マージのエージェントはまだ存在しない。試し実行は API-047） |
  | 423 | `KILL_SWITCH_ENGAGED` | |
  | 423 | `AGENT_DISABLED` | エージェントが停止中（BR-27） |
  | 429 | `DAILY_RUN_LIMIT` | エージェントの `max_runs_per_day` に達した（試し実行は数えない。BR-24） |

- エラーの判定順：

  ```mermaid
  flowchart LR
    A[403] --> B[404] --> C[423 KILL_SWITCH] --> D[423 AGENT_DISABLED] --> E[422 AGENT_NOT_ACTIVE] --> F[422 FR-005] --> G[409] --> H[429]
  ```
  組織の同時実行数（BR-08）を超えた場合はエラーにせず `queued` で待つ（試し実行も同時実行数に数える）。
- 副作用：TBL-006 の INSERT（`agent_snapshot_id` に `agents.current_snapshot_id` を固定。BR-22）、実行ジョブの登録、監査ログ `task.created`

### API-012：GET /api/v1/tasks
- クエリ：`orgId`（必須）、`status`（任意、カンマ区切り）、`repositoryId`（任意）、`agentId`（任意。v0.2）、`isDryRun`（任意。既定は `false`。v0.2）、`cursor`、`limit`
- `agentId` を指定すると、そのエージェントのタスクだけを返す（SCR-017 の「最近のタスク」）。試し実行は `agentId` を持たないため、`isDryRun=true` と組み合わせても返らない（下書きの試し実行は廃止した API-044 の `dryRuns`）。
- データ元：TBL-006、TBL-004、TBL-018・TBL-019（エージェント名）

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": "t1...", "repository": { "id": "r1...", "fullName": "owner/app" },
      "agent": { "id": "ag1...", "slug": "bug-fixer", "name": "バグ修正係" },
      "triggerType": "github_label", "isDryRun": false, "outputType": "pr",
      "issueNumber": 130, "issueTitle": "Fix login redirect", "kind": "issue",
      "status": "running", "phase": "implement", "haltReason": null, "failReason": null,
      "stepsUsed": 32, "costUsd": "0.840000", "updatedAt": "2026-09-30T12:07:00Z" }
  ],
  "counts": { "running": 1, "queued": 1, "awaitingApproval": 2 },
  "nextCursor": null
}
```

</details>

### API-013：GET /api/v1/tasks/{taskId}
- データ元：TBL-006、TBL-019（実効ポリシーの上限値）、TBL-008、TBL-009、TBL-021
- エラー：404 `NOT_FOUND`
- `intent` は、Intent がある場合に `{ "id", "status", "prNumber", "prUrl", "draft", "selfReview", "preview" }` を返す（`selfReview`・`preview` は v0.2）。

| 項目 | 内容 |
|---|---|
| `triggerType` | v0.1 の `trigger` を置き換え：`manual` / `github_label` / `github_mention` / `schedule` / `dry_run` / `trust_proposal` |
| 試し実行（`isDryRun: true`） | `agent` は下書きの値（`id` は NULL）、`agentDraftId` に下書きの ID。`intent.status` は `simulated`、`intent.preview` に承認カードと同じ内容（API-018 の `intent`・`risk`・`summary`・`selfReview`。`diff` は1MBまで）。承認の操作はできない（プレビュー画面 `/tasks/:taskId/preview` のデータ元）。試し実行でないタスクの `intent.preview` は `null` |
| `intent.selfReview` | `action_intents.self_review`（dev-coder の自己レビューの結果。参考）：`{ "model", "rounds": [{ "round", "verdict": "pass" \| "changes_requested", "findings": [...] }], "unresolved": [...] }`。自己レビューのないテンプレートや、自己レビューの前に終わったタスクでは `null` |
| `haltReason` | `agent_disabled`（エージェントの停止で止めたタスク。UC-022）を追加 |
| `statusDetail` | `status: "completed"` の内訳。`dry_run` / `report`、v0.6 で `actions_declined` を追加 |
| `report` | `outputType: "report"` のタスクは、完了すると `status: "completed"`、`report: { "title", "body" }`（Markdown） |
| `budget.perTaskUsd` | 実効ポリシーの値（試し実行は `min(per_task_usd, 1.0)`） |

<details>
<summary>レスポンス（200）の例（通常のタスク）</summary>

```json
{
  "id": "t1...",
  "organizationId": "a1...",
  "repository": { "id": "r1...", "fullName": "owner/app" },
  "requester": { "id": "u1...", "githubLogin": "aoi" },
  "agent": { "id": "ag1...", "slug": "bug-fixer", "name": "バグ修正係", "template": "dev-coder" },
  "agentSnapshotId": "as1...",
  "agentDraftId": null,
  "kind": "issue",
  "triggerType": "manual",
  "isDryRun": false,
  "issueNumber": 130,
  "issueTitle": "Fix login redirect",
  "prompt": null,
  "instructions": null,
  "outputType": "pr",
  "report": null,
  "baseCommitSha": "a1b2c3d...",
  "policySnapshotId": "p1...",
  "status": "running",
  "phase": "implement",
  "haltReason": null,
  "failReason": null,
  "statusDetail": null,
  "budget": {
    "costUsd": "0.840000", "perTaskUsd": "2.000000",
    "stepsUsed": 32, "maxSteps": 80,
    "elapsedSec": 720, "maxMinutes": 45,
    "deniedCount": 1, "deniedAttemptsMax": 3,
    "filesChanged": 4, "filesChangedMax": 30
  },
  "intent": null,
  "approvalId": null,
  "queuedAt": "2026-09-30T11:55:00Z",
  "startedAt": "2026-09-30T11:55:40Z",
  "finishedAt": null
}
```

</details>

<details>
<summary>試し実行の `intent` の例</summary>

```json
"intent": {
  "id": "i7...", "status": "simulated", "prNumber": null, "prUrl": null, "draft": false,
  "selfReview": { "model": "anthropic/claude-opus-5-5",
                  "rounds": [{ "round": 1, "verdict": "pass", "findings": [] }], "unresolved": [] },
  "preview": { "intent": { "title": "...", "diffStats": { "files": 2, "additions": 10, "deletions": 3 }, "diff": "..." },
               "risk": { "level": "low", "score": 0, "reasons": [] }, "summary": null, "decision": "approve" }
}
```

</details>

### タスクの終わり方（v0.6）
15 §タスクの終わり方。MCP の書き込み Intent を持つタスクの `status` / `statusDetail` / `failReason`：

| Intent の結果 | タスクの状態 |
|---|---|
| Intent がない | `completed`（`report`） |
| すべて `executed` / `verified` | `succeeded` |
| `rejected` / `expired` を含み、`failed` / `unknown_outcome` を含まない | `completed`（`actions_declined`） |
| `failed` / `unknown_outcome` を1つでも含む | `failed`（`action_failed`）。レポートは残り、閲覧できる |

- `succeeded` の意味は「PR の作成と検証が完了」から「外部作用がすべて実行された（検証できるものは検証済み）」に広がった。
- 承認待ちの Intent が残ったままエージェントのループが終わると、タスクは `awaiting_approval`。定期実行の次の実行が始まると、前の実行の承認待ちは `expired`（`superseded`）になり、そのタスクは `completed`（`actions_declined`）で終わる（BR-60）。

### API-014：GET /api/v1/tasks/{taskId}/events
- クエリ：`afterId`（任意）、`limit`（1〜200、既定は100）
- データ元：TBL-007

| type | payload |
|---|---|
| `phase_started` | `{ phase, model }` |
| `tool_called` | `{ tool, target, decision, reasonCode, matchedRule, resultSummary }` |
| `llm_called` | `{ phase, model, inputTokens, outputTokens, costUsd }` |
| `status_changed` | `{ from, to, haltReason, failReason, statusDetail }` |
| `budget_updated` | API-013 の `budget` と同じ形 |
| `message` | `{ text }`（500文字以内） |
| `finished` | `{ outcome, reason }` |

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": 5012, "type": "tool_called", "createdAt": "2026-09-30T12:06:00Z",
      "payload": { "tool": "write_file", "target": "infra/x.tf",
                   "decision": "deny", "reasonCode": "path_denied", "matchedRule": "paths.deny[1]" } },
    { "id": 5013, "type": "llm_called", "createdAt": "2026-09-30T12:06:10Z",
      "payload": { "phase": "implement", "model": "anthropic/claude-sonnet-5-5",
                   "inputTokens": 12000, "outputTokens": 900, "costUsd": "0.049500" } }
  ],
  "nextCursor": null
}
```

</details>

### API-015：GET /api/v1/tasks/{taskId}/stream
- 概要：`Content-Type: text/event-stream`。イベントの種類と `data` の形は API-014 と同じ。`Last-Event-ID` ヘッダー（またはクエリ `lastEventId`）以降のイベントを送り、その後は新しいイベントを送り続ける。
- 15秒ごとにコメント行（`: heartbeat`）を送る。タスクが終了状態になったら `event: end` を送って切断する。55分経ったらサーバーから切断する（ADR-007）。

<details>
<summary>ストリームの形式</summary>

```
id: 5013
event: llm_called
data: {"phase":"implement","model":"anthropic/claude-sonnet-5-5","inputTokens":12000,"outputTokens":900,"costUsd":"0.049500"}

: heartbeat
```

</details>

### API-016：POST /api/v1/tasks/{taskId}/cancel
- 権限：依頼者本人、または owner
- リクエストボディ：なし
- レスポンス（200）：API-013 と同じ形（`status: "cancelled"`）
- エラー：403 `FORBIDDEN`、409 `TASK_ALREADY_TERMINATED`
- 副作用：FR-015（キャンセル）。監査ログ `task.cancelled`
