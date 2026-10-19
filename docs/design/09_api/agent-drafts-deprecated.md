# 09. API設計：エージェントの下書き（廃止 v0.5）
- プロジェクト：open-team（仮称） ／ 版数：v0.6（2026-10-01） ／ 入口：[README.md](README.md) ／ 共通仕様：[common.md](common.md)

> **3行で**
> 1. v0.2 の「会話で下書き → Canvas → 試し実行 → PR で公開」の API（API-043〜048・057・058）は、v0.5 で **廃止** した（14 §API）。ID は欠番にせず残す。
> 2. 作り方は「名前を付けて頼む」（[agents.md](agents.md) の API-060〜064）に置き換わった。置換先が明記されているのは API-043（→ API-060）と API-045（→ API-062、設計アシスタント → 設定プランナー）だけ。
> 3. 下の詳細は、廃止前の仕様の記録（GitOps モードや手での編集を設計し直すときの参照用）。置換先のない機能は Q-74。

## 🧭 判断してほしいこと
- [Q-74](README.md#-判断してほしいこと)：手での定義編集（API-046）・試し実行（API-047）・公開（API-048）の置換先が未設計。

## 廃止した API と置換先

| ID | メソッド・パス | 廃止前の概要 | 置換先 |
|---|---|---|---|
| API-043 | POST `/api/v1/repos/{repoId}/agent-drafts` | 下書きの作成（空・テンプレート・既存エージェントから） | API-060 |
| API-044 | GET `/api/v1/agent-drafts/{draftId}` | 下書きの取得 | 明記なし（会話は API-061） |
| API-045 | POST `/api/v1/agent-drafts/{draftId}/messages` | 設計アシスタントへの送信（SSE） | API-062（FR-035 が FR-024 を置き換え） |
| API-046 | PUT `/api/v1/agent-drafts/{draftId}` | 下書きの更新と検証 | 明記なし（Q-74） |
| API-047 | POST `/api/v1/agent-drafts/{draftId}/dry-runs` | 試し実行の開始 | 明記なし（Q-74） |
| API-048 | POST `/api/v1/agent-drafts/{draftId}/publish` | 公開（PR の作成） | 明記なし（Q-74） |
| API-057 | GET `/api/v1/repos/{repoId}/agent-drafts` | 下書きの一覧 | 明記なし |
| API-058 | DELETE `/api/v1/agent-drafts/{draftId}` | 下書きの破棄 | 明記なし |

---

## 詳細（廃止前の仕様）

### API-043：POST /api/v1/repos/{repoId}/agent-drafts
廃止（v0.5、→ API-060）。権限 maintainer 以上。

<details>
<summary>廃止前の仕様</summary>

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| source | `empty` \| `template` \| `agent` | ○ | `empty`：会話で作る。`template`：テンプレートの既定値から。`agent`：既存エージェントの編集（現在の定義を複製） |
| template | `dev-coder` \| `reviewer` \| `triager` | △ | `source=template` のとき必須 |
| agentId | uuid | △ | `source=agent` のとき必須 |
| slug | string | − | 新規の場合のファイル名（`^[a-z0-9][a-z0-9-]{1,31}$`）。省略時は仮の ID（`agent-xxxx`）を付け、API-046 で変更できる。`source=agent` では指定できない |

- レスポンス（201）：API-044 と同じ形（`status: "drafting"`）
- エラー：400 `VALIDATION_ERROR`、403 `FORBIDDEN`、404 `NOT_FOUND`（リポジトリ・エージェントがない）、409 `AGENT_SLUG_TAKEN`（新規なのに同じ ID のエージェントがある）、422 `POLICY_INVALID`（合成できない）
- 副作用：TBL-021 の INSERT。作成直後に検証（API-046 と同じ）を行い、`last_validation` に保存する。エージェント数の上限（20）は検証の `errors[]` に `AGENT_LIMIT_EXCEEDED` として出す（作成は止めない）。

</details>

### API-044：GET /api/v1/agent-drafts/{draftId}
廃止（v0.5）。権限 maintainer 以上。

<details>
<summary>廃止前の仕様</summary>

```json
{
  "id": "d1...",
  "repository": { "id": "r1...", "fullName": "owner/app" },
  "agentId": null,
  "slug": "deps-bot",
  "status": "drafting",
  "createdBy": { "id": "u1...", "githubLogin": "aoi" },
  "definitionYaml": "version: 1\nname: 依存更新係\n...",
  "skills": [],
  "baseDefinitionYaml": null,
  "validation": {
    "errors": [],
    "warnings": [],
    "effective": { "autonomy": { "open_pr": "approve" }, "budget": { "per_task_usd": 1 } },
    "locked": [{ "path": "autonomy.shell_network", "by": "ceiling" }, { "path": "autonomy.open_pr", "by": "policy", "limit": "approve" }],
    "clamped": [],
    "summary": ["`package*.json` と lockfile だけを変更できます", "PRを作るには ren の承認が必要です"],
    "policySnapshotId": "p1..."
  },
  "assistant": { "costUsd": "0.040000", "limitUsd": "0.500000", "messages": [
    { "role": "user", "text": "依存関係の更新PRを毎週月曜に出す係がほしい", "createdAt": "..." },
    { "role": "assistant", "text": "dev-coder で作りました。...", "changedPaths": ["triggers", "paths.allow"], "createdAt": "..." }
  ] },
  "dryRuns": [ { "taskId": "t7...", "status": "completed", "costUsd": "0.420000", "createdAt": "..." } ],
  "pr": null,
  "lastPrNumber": null,
  "updatedAt": "2026-10-01T03:00:00Z"
}
```

- `baseDefinitionYaml` は、既存エージェントの編集の場合の現在の定義（Canvas の差分表示用）。`assistant.messages` は会話の全文の保存期限（30日）を過ぎると空になる。`pr` は公開後に `{ "number", "url", "branch" }`。`lastPrNumber` は、公開 PR がマージされずにクローズされて `drafting` に戻った場合の直前の PR 番号（UC-019 4a）。`validation` の `locked`・`clamped` は API-046 と同じ。
- データ元：TBL-021、TBL-019（`baseDefinitionYaml`）、TBL-006（`dryRuns`）。エラー：404 `NOT_FOUND`

</details>

### API-045：POST /api/v1/agent-drafts/{draftId}/messages
廃止（v0.5、→ API-062）。権限 maintainer 以上。

<details>
<summary>廃止前の仕様</summary>

- リクエストボディ：`message`（必須、1〜4,000文字）
- レスポンス（200）：`Content-Type: text/event-stream`。設計アシスタント（FR-024）の応答を流す。

| event | data |
|---|---|
| `explanation` | `{ text }`（説明の差分。複数回） |
| `patch_applied` | `{ changedPaths, definitionYaml, validation, updatedAt }`（検証と合成を通って下書きに反映した。BR-30） |
| `patch_rejected` | `{ reason, errors[] }`（スキーマ違反、または合成の違反。1回だけ作り直させても通らなかった場合。UC-017 E1） |
| `cost` | `{ costUsd, limitUsd }` |
| `error` | `{ code, message }`（`LLM_UPSTREAM_ERROR` など。送ったあと `end`） |
| `end` | `{}` |

```
event: explanation
data: {"text":"dev-coder で作りました。"}

event: patch_applied
data: {"changedPaths":["triggers","paths.allow"],"definitionYaml":"...","validation":{"errors":[],"warnings":[],"summary":["..."]},"updatedAt":"2026-10-01T03:00:05Z"}

event: cost
data: {"costUsd":"0.040000","limitUsd":"0.500000"}

event: end
data: {}
```

- エラー（ストリームを開始する前）：400 `VALIDATION_ERROR`、409 `AGENT_DRAFT_NOT_EDITABLE`（`drafting` でない）、409 `ASSISTANT_BUSY`（同じ下書きで応答中。同じ下書きへの送信は直列）、422 `ASSISTANT_BUDGET_EXCEEDED`（`assistant_cost_usd` に今回の呼び出しの見積額を足すと $0.5 を超える。FR-024・UC-017 E2。手での編集 API-046 は引き続きできる）、422 `LLM_CREDENTIAL_MISSING`
- 副作用：worker の設計アシスタントのジョブ（sandbox-edge の内部関数、`phase=design`）、TBL-021 の更新（`definition_yaml`・`last_validation`・`assistant_cost_usd`・会話の全文。会話は秘密情報をマスクしてから保存する。BR-32）、TBL-011 の INSERT（`agent_draft_id` つき、`task_id` は NULL。リポジトリの日次予算に含める。BR-30・A-35）
- 制限：メッセージは1件4,000文字まで。応答中（`end` を送るまで）の同じ下書きへの送信は 409。アシスタントは公開・試し実行・権限の付与を行えない。応答の `patch` は必ず検証と合成を通してから反映する。

</details>

### API-046：PUT /api/v1/agent-drafts/{draftId}
廃止（v0.5、置換先の明記なし）。権限 maintainer 以上。

<details>
<summary>廃止前の仕様</summary>

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| definitionYaml | string | ○ | 最大64KB（フォームからの編集も、クライアント側で YAML に反映して送る） |
| skills | array | − | `[{ "name": "...", "content": "..." }]`。新規・変更した Skill（最大20、各16KB） |
| slug | string | − | 新規エージェントの下書きの場合だけ変更できる |
| expectedUpdatedAt | string | − | 読み込んだときの `updatedAt`。一致しない場合は 409（設計アシスタントの反映との競合を防ぐ） |

```json
{
  "draftId": "…",
  "errors": [
    { "code": "AGENT_EXCEEDS_POLICY", "file": ".agent/agents/bug-fixer.yaml", "line": 12,
      "path": "autonomy.open_pr", "defined": "auto", "limit": "approve", "by": "policy",
      "message": "リポジトリのポリシーで制限されています（open_pr: approve）" }
  ],
  "warnings": [],
  "effective": { "autonomy": { "open_pr": "approve" }, "budget": { "per_task_usd": 1 } },
  "locked": [{ "path": "autonomy.shell_network", "by": "ceiling" }, { "path": "autonomy.open_pr", "by": "policy", "limit": "approve" }],
  "clamped": [],
  "summary": ["`src/**` と `test/**` のファイルを変更できます（`src/billing/**` を除く）", "PRを作るには ren の承認が必要です"],
  "updatedAt": "2026-10-01T03:00:12Z"
}
```

- 検証エラーがあっても下書きは保存する（200 を返し、`errors` に入れる。エラーがなければ `errors: []`）。
- `locked`：Hard Ceiling またはポリシーにより、これ以上緩められない項目（Canvas の鍵アイコン。SCR-016）。`{ "path", "by": "ceiling" | "policy", "limit" }`（`by=ceiling` で選べる値が1つだけの場合は `limit` を省略できる）。`path` は定義のキーの正式名（Canvas の略記 `network` = `autonomy.shell_network` などは表示上のもの）。
- `clamped`：既存エージェントの編集で、公開済みの定義が現在のポリシーで切り詰められている項目 `[{ "path", "defined", "effective" }]`（`agent_snapshots.clamped` と同じ形）。新規の下書きでは常に `[]`。下書きの値がポリシーより緩い場合は clamp ではなく `errors`（`AGENT_EXCEEDS_POLICY`）。
- 検証：FR-022 の検証と、デフォルトブランチ HEAD のポリシーとの合成（FR-023）。`summary` は固定の文テンプレートで生成する（LLM を使わない）。
- エラー：400 `VALIDATION_ERROR`（サイズ超過、`slug` の形式）、409 `AGENT_DRAFT_NOT_EDITABLE`、409 `AGENT_DRAFT_CONFLICT`（`expectedUpdatedAt` が一致しない）、409 `AGENT_SLUG_TAKEN`
- 副作用：TBL-021 の更新（`definition_yaml`・`skills`・`last_validation`）

</details>

### API-047：POST /api/v1/agent-drafts/{draftId}/dry-runs
廃止（v0.5、置換先の明記なし）。権限 maintainer 以上、かつ GitHub 上の書き込み権限（BR-07）。

<details>
<summary>廃止前の仕様</summary>

- リクエストボディ：`issueNumber`（△）と `prompt`（△、1〜2,000文字）のどちらか一方が必須
- レスポンス（201）：API-013 と同じ形（`isDryRun: true`、`triggerType: "dry_run"`、`agentDraftId`）
- 処理（FR-026・UC-018）：下書きの定義とデフォルトブランチ HEAD のポリシーから、`source=draft` のスナップショットを作り、予算を `min(per_task_usd, 1.0)` にしてタスクを作る。以降は通常のタスクと同じ経路で実行する。
- エラー：400 `VALIDATION_ERROR`、403 `FORBIDDEN`、409 `AGENT_DRAFT_NOT_EDITABLE`（`merged` / `discarded`。`drafting` と `published` では試し実行できる）、422 `AGENT_DRAFT_INVALID`、422 `POLICY_INVALID` / `LLM_CREDENTIAL_MISSING` / `ISSUE_NOT_OPEN`、423 `KILL_SWITCH_ENGAGED`
- 副作用：TBL-019（`source=draft`）・TBL-006（`is_dry_run=true`）の INSERT、実行ジョブの登録、監査ログ `task.created`（`dryRun: true`）。費用はリポジトリの日次予算に含める（BR-24）。組織の同時実行数（BR-08）にも数える。BR-29 の重複判定と `max_runs_per_day` には数えない。

</details>

### API-048：POST /api/v1/agent-drafts/{draftId}/publish
廃止（v0.5、置換先の明記なし）。権限 maintainer 以上、かつ GitHub 上の書き込み権限。

<details>
<summary>廃止前の仕様</summary>

- リクエストボディ：`expectedUpdatedAt`（任意。確認シートを表示したときの `updatedAt`）
- 処理：デフォルトブランチの最新のポリシーで再検証 → Gateway で PR を作成（`POST /gw/v1/agent-config-prs`。`.agent/` 配下のファイルだけ。BR-28）→ `published`。
- レスポンス（200）：`{ "draftId": "d1...", "status": "published", "pr": { "number": 57, "url": "https://github.com/owner/app/pull/57", "branch": "open-team/agent-config/d1a2b3c4" }, "files": [".agent/agents/deps-bot.yaml"] }`
- エラー：403 `FORBIDDEN`、409 `AGENT_DRAFT_ALREADY_PUBLISHED`（`published` / `merged`）、409 `AGENT_DRAFT_NOT_EDITABLE`（`discarded`）、409 `AGENT_DRAFT_CONFLICT`、422 `AGENT_DRAFT_INVALID`（再検証でエラー。`details` に `errors[]`。UC-019 E1：公開の間にポリシーが変わった場合を含む）、502 `GITHUB_UPSTREAM_ERROR`
- 副作用：TBL-021 の更新（`status=published`、`pr_number`）、監査ログ `agent_config.pr_opened`（主体は操作したユーザー。FR-027）
- 再公開：公開 PR がマージされずにクローズされて `drafting` に戻った下書き（`lastPrNumber` あり）は、もう一度公開できる。ブランチ名は同じ `open-team/agent-config/<draftId の先頭8文字>`（A-65）。
- 備考：ユーザーの操作による書き込みで、エージェントの Intent ではない。Kill Switch の発動中も公開できる（エージェントは起動しないため）。エージェントが有効になるのは、PR がデフォルトブランチにマージされ、API-035 の `push` で定義を読み込んだとき（UC-020）。

</details>

### API-057：GET /api/v1/repos/{repoId}/agent-drafts
廃止（v0.5）。権限 maintainer 以上。

<details>
<summary>廃止前の仕様</summary>

- クエリ：`status`（任意、カンマ区切り。既定は `drafting,published`）、`agentId`（任意。既存エージェントの編集の下書きだけ）、`cursor`、`limit`
- 項目：`{ id, slug, name, agentId, status, createdBy, pr: { number, url }, lastPrNumber, validation: { errorCount, warningCount }, assistantCostUsd, updatedAt }`。`name` は下書きの YAML の `name`（パースできない場合は `null`）。並び順は `updatedAt` の新しい順。
- データ元：TBL-021。エラー：403 `FORBIDDEN`、404 `NOT_FOUND`

</details>

### API-058：DELETE /api/v1/agent-drafts/{draftId}
廃止（v0.5）。権限：下書きの作成者、または組織の owner。

<details>
<summary>廃止前の仕様</summary>

- レスポンス（204）
- エラー：403 `FORBIDDEN`（作成者でも組織の owner でもない）、404 `NOT_FOUND`、409 `AGENT_DRAFT_NOT_EDITABLE`（`drafting` でない。`published` は公開 PR を GitHub 上で閉じると `drafting` に戻る。`merged` / `discarded` は破棄できない。すでに `discarded` の場合も 409 で、クライアントは一覧から消してよい）
- 副作用：TBL-021 の更新（`status=discarded`）。行と会話の全文は保持期間（08）に従って削除する。試し実行のタスクはそのまま残る
- 仮定：A-64（破棄できるのは `drafting` だけ）。

</details>

## 前提・仮定（廃止 API 関連）
- A-64：API-058 で破棄できるのは `drafting` の下書きだけとする（`published` は公開 PR のクローズで `drafting` に戻ってから）。
- A-65：再公開では同じブランチ名を使い、open な PR がなければ Gateway がブランチを新しいコミットに更新する。
- 解決済み（v0.2）：下書きを破棄する API → API-058。公開 PR がマージされずにクローズされた場合 → 下書きを `drafting` に戻し、`pr_number` を `last_pr_number` に移す（UC-019 4a。API-035 の `pull_request.closed`）。
