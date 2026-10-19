# 09. API設計：ポリシー・安全装置・予算・信頼度提案
- プロジェクト：open-team（仮称） ／ 版数：v0.6（2026-10-01） ／ 入口：[README.md](README.md) ／ 共通仕様：[common.md](common.md)

> **3行で**
> 1. リポジトリのポリシー（`.agent/policy.yaml`）の参照と貼り付け検証（API-008・009）。v0.4 以降、リポジトリのポリシーは開発エージェントにだけ追加でかかる上限。
> 2. Kill Switch の発動・解除（API-020・021）と予算メーター（API-022）。
> 3. 信頼度提案の一覧と受け入れ（API-033・034）。ワークスペースのポリシー（13）の API は未設計（Q-72）。

## 🧭 判断してほしいこと
- [Q-72](README.md#-判断してほしいこと)：ワークスペースのポリシー（アプリ内で編集・版の履歴・緩める変更の承認。13 §概念モデル）の API が未設計。

## 要点
- ポリシー：[API-008](#api-008get-apiv1reposrepoidpolicy)・[API-009](#api-009post-apiv1reposrepoidpolicyvalidate)
- Kill Switch：[API-020](#api-020post-apiv1orgsorgidkill-switch)・[API-021](#api-021post-apiv1orgsorgidkill-switchrelease)
- 予算：[API-022](#api-022get-apiv1orgsorgidbudget)
- 信頼度提案：[API-033](#api-033get-apiv1reposrepoidtrust-proposals)・[API-034](#api-034post-apiv1trust-proposalsproposaliddecision)

---

## 詳細

### API-008：GET /api/v1/repos/{repoId}/policy
- 概要：最新のスナップショットを返す。デフォルトブランチの HEAD と食い違っている場合は、読み込み直してから返す（FR-003）。
- ポリシーのキーは、YAML のキー（snake_case）をそのまま返す（ファイルとの対応をわかりやすくするため）。
- データ元：TBL-005

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "snapshotId": "p1...",
  "status": "valid",
  "source": "file",
  "commitSha": "a1b2c3d4e5...",
  "policyHash": "9f86d0...",
  "policy": {
    "version": 1,
    "autonomy": { "read": "auto", "edit_code": "auto", "run_tests": "auto",
                  "shell_network": "deny", "open_pr": "approve", "merge": "deny" },
    "budget": { "per_task_usd": 2, "per_day_usd": 10, "max_steps": 80, "max_minutes": 45 },
    "breakers": { "same_action_repeat": 5, "files_changed_max": 30,
                  "denied_attempts_max": 3, "step_cost_usd_max": 0.5 },
    "paths": { "deny": [".github/workflows/**", "infra/**", "**/.env*"] },
    "commands": { "allow": ["npm ci", "npm test"] },
    "approvers": ["ren"]
  },
  "routing": { "version": 1, "phases": { "plan": "anthropic/claude-opus-5-5" } },
  "defaultedKeys": ["budget.max_minutes"],
  "ceilings": { "merge": ["deny"], "shell_network": ["deny"], "open_pr": ["approve", "auto", "deny"] },
  "errors": [],
  "warnings": [],
  "createdAt": "2026-09-30T10:00:00Z"
}
```

</details>

### API-009：POST /api/v1/repos/{repoId}/policy/validate
- リクエストボディ：

  | フィールド | 型 | 必須 | 説明 |
  |---|---|---|---|
  | policyYaml | string | ○ | 最大64KB |
  | routingYaml | string | − | 最大64KB |

- レスポンス（200）：API-008 と同じ形から `snapshotId`・`commitSha`・`createdAt` を除いたもの（`status` は `valid` / `invalid`）
- エラー：400 `VALIDATION_ERROR`（64KB を超えた場合）
- 副作用：なし（保存しない）

### API-020：POST /api/v1/orgs/{orgId}/kill-switch
- 権限：maintainer 以上
- リクエストボディ：`reason`（任意、500文字以内）
- レスポンス（200）：`{ "engaged": true, "engagedAt": "2026-09-30T12:10:00Z", "affectedTaskIds": ["t1...", "t2..."] }`
- 冪等性：すでに発動中なら、何もせずに現在の状態を返す（200）。
- 副作用：FR-015（発動）。監査ログ `killswitch.engaged`。全メンバーに通知

### API-021：POST /api/v1/orgs/{orgId}/kill-switch/release
- 権限：owner
- リクエストボディ：`reason`（必須、1〜500文字）
- レスポンス（200）：`{ "engaged": false }`
- エラー：403 `FORBIDDEN`、400 `VALIDATION_ERROR`
- 副作用：監査ログ `killswitch.released`

### API-022：GET /api/v1/orgs/{orgId}/budget
- データ元：TBL-011（集計）、TBL-005（`per_day_usd`）

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "timezone": "Asia/Tokyo",
  "today": { "costUsd": "3.200000" },
  "month": { "costUsd": "41.700000" },
  "repositories": [
    { "id": "r1...", "fullName": "owner/app",
      "todayCostUsd": "3.200000", "perDayUsd": "10.000000", "ratio": 0.32 }
  ]
}
```

</details>

### API-033：GET /api/v1/repos/{repoId}/trust-proposals
- クエリ：`status`（既定は `open`）

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": "tp1...", "actionType": "open_pr", "fromLevel": "approve", "toLevel": "auto",
      "note": "auto の場合、PRは常にドラフトで作成されます",
      "evidence": { "approved": 12, "rejected": 0, "breakerTrips": 0, "windowDays": 30 },
      "status": "open", "createdAt": "2026-09-30T03:00:00Z" }
  ]
}
```

</details>

### API-034：POST /api/v1/trust-proposals/{proposalId}/decision
- リクエストボディ：`decision`（`accept` / `dismiss`）
- レスポンス（200）：`{ "id": "tp1...", "status": "accepted", "taskId": "t9..." }`。`accept` の場合は、ポリシー変更タスク（`kind=policy_change`）の ID を返す。
- エラー：409 `APPROVAL_NOT_PENDING`（提案が open でない）、423 `KILL_SWITCH_ENGAGED`、422 `POLICY_INVALID`
- 副作用：TBL-015 の更新。`accept` の場合は、TBL-006・TBL-008 の作成と承認フロー（FR-011。常に approve）
