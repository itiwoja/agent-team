# 09. API設計：認証・ワークスペース・監査・設定
- プロジェクト：open-team（仮称） ／ 版数：v0.6（2026-10-01） ／ 入口：[README.md](README.md) ／ 共通仕様：[common.md](common.md)

> **3行で**
> 1. GitHub OAuth でのログイン（API-001〜003）、自分の情報（API-004）、ワークスペース（旧称：組織。パスは `/orgs`）の参照と設定（API-005〜007・040）。
> 2. 監査ログの一覧・ハッシュチェーンの検証・エクスポート（API-023〜025）、LLM キー（API-026〜028）、メンバー（API-029・030）、通知の購読（API-031・032）。
> 3. フェーズ0はサインインを省略し、LLM キーは `.env` に置く（13 §フェーズ0）。パスの改名とフェーズ0の認証は Q-78。

## 🧭 判断してほしいこと
- [Q-78](README.md#-判断してほしいこと)：`/orgs/{orgId}` をワークスペースに改名するか、フェーズ0の認証、メンバー API のフェーズ。

## 要点
- ログイン：[API-001](#api-001get-apiv1authgithublogin)〜[API-003](#api-003post-apiv1authlogout)
- 自分・ワークスペース：[API-004](#api-004get-apiv1me)〜[API-007](#api-007get-apiv1orgsorgidrepos)、[API-040](#api-040patch-apiv1orgsorgid)
- 監査ログ：[API-023](#api-023get-apiv1orgsorgidaudit-logs)〜[API-025](#api-025get-apiv1orgsorgidaudit-logsexport)
- 設定：[API-026](#api-026get-apiv1orgsorgidllm-credentials)〜[API-032](#api-032delete-apiv1push-subscriptionssubscriptionid)

---

## 詳細

### API-001：GET /api/v1/auth/github/login
- 概要：`state` を作って署名つき Cookie（`ot_oauth_state`、10分）に保存し、GitHub の認可 URL へ 302 でリダイレクトする。
- クエリ：`returnTo`（任意。同じオリジンのパスだけを受け付ける）
- レスポンス：302（`Location: https://github.com/login/oauth/authorize?client_id=...&state=...`）

### API-002：GET /api/v1/auth/github/callback
- 概要：FR-001 の 2〜5 を実行する。
- クエリ：`code`、`state`、`error`（任意）
- レスポンス：302 → `/`（連携済みの組織がある場合）、`/onboarding`（ない場合）、`/login?error=...`（失敗した場合）
- 副作用：users・sessions・memberships の作成または更新、`Set-Cookie: ot_session`

### API-003：POST /api/v1/auth/logout
- レスポンス（204）：なし。`sessions.revoked_at` を記録し、Cookie を削除する。

### API-004：GET /api/v1/me
- データ元：TBL-001、TBL-016（csrf_token）、TBL-014

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "id": "0b6e...",
  "githubLogin": "aoi",
  "name": "Aoi",
  "avatarUrl": "https://avatars.githubusercontent.com/u/1",
  "locale": "ja",
  "csrfToken": "k3J...",
  "vapidPublicKey": "BEl6...",
  "pushSubscriptions": [
    { "id": "7c1d...", "deviceLabel": "iPhone (Safari)", "createdAt": "2026-09-30T12:00:00Z" }
  ]
}
```

</details>

### API-005：GET /api/v1/orgs
- データ元：TBL-002、TBL-003

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": "a1...", "githubAccountLogin": "owner", "accountType": "User",
      "status": "active", "role": "owner", "killSwitchEngaged": false }
  ]
}
```

</details>

### API-006：GET /api/v1/orgs/{orgId}
- 権限：viewer 以上
- エラー：404 `NOT_FOUND`

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "id": "a1...",
  "githubAccountLogin": "owner",
  "accountType": "Organization",
  "status": "active",
  "role": "maintainer",
  "timezone": "Asia/Tokyo",
  "storeTranscripts": true,
  "maxConcurrentTasks": 3,
  "killSwitch": { "engaged": false, "engagedAt": null, "engagedBy": null, "reason": null }
}
```

</details>

### API-007：GET /api/v1/orgs/{orgId}/repos
- データ元：TBL-004、TBL-005

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": "r1...", "fullName": "owner/app", "defaultBranch": "main", "private": true,
      "status": "active",
      "policy": { "snapshotId": "p1...", "status": "valid", "source": "file", "commitSha": "a1b2c3d..." } }
  ],
  "nextCursor": null
}
```

</details>

### API-040：PATCH /api/v1/orgs/{orgId}
- 権限：owner
- リクエストボディ（すべて任意）：

  | フィールド | 型 | 説明 |
  |---|---|---|
  | timezone | string | IANA のタイムゾーン名 |
  | storeTranscripts | boolean | プロンプトと応答の全文を保存するか |

- レスポンス（200）：API-006 と同じ形
- 副作用：監査ログ `org.settings_changed`

### API-023：GET /api/v1/orgs/{orgId}/audit-logs
- クエリ：`from`、`to`（ISO 8601）、`eventType`（任意、カンマ区切り）、`taskId`（任意）、`cursor`、`limit`
- データ元：TBL-012

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "seq": 10233, "occurredAt": "2026-09-30T12:07:00Z", "eventType": "decision.made",
      "actorType": "system", "actorId": "sandbox-edge", "taskId": "t1...",
      "payload": { "decision": "deny", "reasonCode": "path_denied", "matchedRule": "paths.deny[1]" },
      "hash": "5f2c...", "prevHash": "a91e..." }
  ],
  "nextCursor": "MTAyMzI="
}
```

</details>

### API-024：POST /api/v1/orgs/{orgId}/audit-logs/verify
- リクエストボディ：`fromSeq`（任意）、`toSeq`（任意）。省略した場合は全範囲（最大100万件）
- レスポンス（200）：`{ "ok": true, "checkedCount": 10233, "firstBrokenSeq": null, "checkpointMatched": true }`
- 副作用：`ok=false` の場合は運営チームに通知する（UC-013 E1）

### API-025：GET /api/v1/orgs/{orgId}/audit-logs/export
- 権限：owner
- クエリ：`from`、`to`（最大90日）
- レスポンス（200）：`Content-Type: application/x-ndjson`、`Content-Disposition: attachment; filename="audit-{org}-{from}-{to}.jsonl"`。1行が API-023 の1件と同じ形
- エラー：400 `VALIDATION_ERROR`（期間が90日を超える）

### API-026：GET /api/v1/orgs/{orgId}/llm-credentials
- レスポンス（200）：`{ "items": [ { "provider": "anthropic", "last4": "a1b2", "verifiedAt": "2026-09-30T09:00:00Z" } ] }`

### API-027：PUT /api/v1/orgs/{orgId}/llm-credentials/{provider}
- パスパラメータ：`provider`（`anthropic` / `openai` / `openrouter`）
- リクエストボディ：`apiKey`（必須、1〜512文字）
- レスポンス（200）：`{ "provider": "anthropic", "last4": "a1b2", "verifiedAt": "..." }`
- エラー：422 `LLM_CREDENTIAL_INVALID`、403 `FORBIDDEN`
- 副作用：TBL-013 の保存（上書き）。監査ログ `credential.updated`（キーの値は記録しない）

### API-028：DELETE /api/v1/orgs/{orgId}/llm-credentials/{provider}
- レスポンス（204）
- 副作用：監査ログ `credential.deleted`

### API-029：GET /api/v1/orgs/{orgId}/members
- レスポンス（200）：`{ "items": [ { "userId": "u1...", "githubLogin": "aoi", "avatarUrl": "...", "role": "owner" } ], "nextCursor": null }`

### API-030：PATCH /api/v1/orgs/{orgId}/members/{userId}
- リクエストボディ：`role`（`owner` / `maintainer` / `viewer`）
- レスポンス（200）：API-029 の1件と同じ形
- エラー：403 `FORBIDDEN`、422 `LAST_OWNER`
- 副作用：監査ログ `member.role_changed`

### API-031：POST /api/v1/push-subscriptions
- リクエストボディ：

  | フィールド | 型 | 必須 | 説明 |
  |---|---|---|---|
  | endpoint | string（URL） | ○ | |
  | keys.p256dh | string | ○ | |
  | keys.auth | string | ○ | |

- レスポンス（201）：`{ "id": "7c1d...", "deviceLabel": "iPhone (Safari)" }`
- 備考：同じ `endpoint` がすでにあれば、所有者を更新して 200 を返す。

### API-032：DELETE /api/v1/push-subscriptions/{subscriptionId}
- レスポンス（204）。本人の購読でなければ 404。
