# 09. API設計：承認・「以後も許可」のルール・Intent の解決
- プロジェクト：open-team（仮称） ／ 版数：v0.6（2026-10-01） ／ 入口：[README.md](README.md) ／ 共通仕様：[common.md](common.md)

> **3行で**
> 1. 承認の一覧・詳細（API-017・018）と決定（API-019）。承認は intentHash に紐づき、表示した内容と違えば 409 `INTENT_CHANGED`（[ADR-005](../adr/ADR-005-approval-bound-to-intent-hash.md)）。
> 2. v0.6 で API-019 に `remember`（[以後も許可]）を追加し、ルールの一覧・取り消し（API-068・069）を足した。ルールは宛先の引数をすべて実際の値で固定する（[ADR-029](../adr/ADR-029-mcp-arg-roles-destination-fixed.md)）。
> 3. MCP の書き込みは自動で再試行せず、結果が分からない Intent（`unknown_outcome`）は API-070 でユーザーが確定する（[ADR-031](../adr/ADR-031-mcp-write-no-auto-retry.md)）。

## 🧭 判断してほしいこと
- [Q-76](README.md#-判断してほしいこと)：MCP の書き込みの承認カード（15 §承認カード）に合わせた API-017・018 の応答の形が未設計。

## 要点
- 一覧・詳細：[API-017](#api-017get-apiv1approvals)・[API-018](#api-018get-apiv1approvalsapprovalid)
- 決定：[API-019](#api-019post-apiv1approvalsapprovaliddecision)（[以後も許可を出す条件](#以後も許可を出す条件)）
- ルール：[API-068](#api-068get-apiv1agentsagentidrules)・[API-069](#api-069delete-apiv1agentsagentidrulesruleid)（[ルールの形](#ルールの形)）
- Intent の解決：[API-070](#api-070post-apiv1intentsintentidresolve)

---

## 詳細

### API-017：GET /api/v1/approvals
- クエリ：`orgId`（必須）、`status`（既定は `pending`）、`mine`（既定は true。自分が承認者のものだけ）、`cursor`、`limit`
- データ元：TBL-009、TBL-008、TBL-006

<details>
<summary>レスポンス（200）の例</summary>

```json
{
  "items": [
    { "id": "ap1...", "taskId": "t1...", "repository": { "fullName": "owner/app" },
      "issueNumber": 123, "prTitle": "Fix login redirect loop",
      "riskLevel": "medium", "diffStats": { "files": 7, "additions": 120, "deletions": 30 },
      "costUsd": "1.120000", "status": "pending", "expiresAt": "2026-10-01T09:00:00Z" }
  ],
  "nextCursor": null
}
```

</details>

### API-018：GET /api/v1/approvals/{approvalId}
- データ元：TBL-009、TBL-008（`self_review` を含む）、TBL-006、TBL-005、TBL-010（`matchedRule`）
- `intent.selfReview`（v0.2）は「AI による自己レビュー（参考）」として表示する。リスク評価（`risk`。ルールベース、BR-13）とは別のもので、承認の判断を自動化しない。自己レビューのないタスクでは `null`。
- v0.2 では `policy.snapshotId` は実効ポリシーの元になったポリシースナップショット、`policyHash` は実効ポリシーのハッシュ（`agent_snapshots.effective_policy_hash`）。
- 備考：`diff` は1MBを超える場合は省略し（`diffTruncated: true`）、ファイルごとの差分はクエリ `file={path}` で取得する（A-32）。
- MCP の書き込み（`action_type = mcp_call`）の承認カードに出す区画（宛先＝`destination` 引数、中身＝`content`、その他＝`option`、汚染の情報源、ツールの説明）とリスク評価の加点は 15 §承認カードで決まっている。応答の形は未設計（[Q-76](README.md#-判断してほしいこと)。画面は [06](../06_ux_design/README.md)）。

<details>
<summary>レスポンス（200）の例（open_pr）</summary>

```json
{
  "id": "ap1...",
  "status": "pending",
  "expiresAt": "2026-10-01T09:00:00Z",
  "canDecide": true,
  "approvers": [{ "id": "u2...", "githubLogin": "ren" }],
  "task": { "id": "t1...", "repository": { "fullName": "owner/app" }, "issueNumber": 123,
            "requester": { "githubLogin": "sora" }, "stepsUsed": 61, "costUsd": "1.120000" },
  "intent": {
    "id": "i1...",
    "actionType": "open_pr",
    "title": "Fix login redirect loop",
    "body": "...",
    "baseBranch": "main",
    "headBranch": "open-team/task-t1...",
    "draft": false,
    "baseCommitSha": "a1b2c3d...",
    "expectedTreeSha": "4b825d...",
    "intentHash": "e3b0c44298fc...",
    "diffStats": { "files": 7, "additions": 120, "deletions": 30 },
    "changedPaths": ["src/auth.ts", "package.json"],
    "diff": "diff --git a/src/auth.ts b/src/auth.ts\n...",
    "testReport": { "commands": ["npm test"], "passed": true, "summary": "42 passed", "selfReported": true },
    "selfReview": { "model": "anthropic/claude-opus-5-5",
                    "rounds": [{ "round": 1, "verdict": "changes_requested", "findings": ["リダイレクト先の検証にテストがない"] },
                               { "round": 2, "verdict": "pass", "findings": [] }],
                    "unresolved": [] }
  },
  "risk": {
    "level": "medium",
    "score": 3,
    "reasons": [
      { "code": "dependency_manifest_changed", "points": 2, "detail": "package.json" },
      { "code": "no_test_changes", "points": 1, "detail": null }
    ]
  },
  "summary": { "text": "ログイン後のリダイレクト先の検証を...", "model": "anthropic/claude-haiku-4-5-20251001", "aiGenerated": true },
  "policy": { "snapshotId": "p1...", "policyHash": "9f86d0...", "matchedRule": "autonomy.open_pr", "decision": "approve" },
  "decidedBy": null,
  "decidedAt": null,
  "decisionComment": null
}
```

</details>

### API-019：POST /api/v1/approvals/{approvalId}/decision
- 権限：承認者（BR-14）
- リクエストボディ：

  | フィールド | 型 | 必須 | 説明 |
  |---|---|---|---|
  | decision | `approve` \| `reject` | ○ | |
  | intentHash | string | ○ | 画面に表示した API-018 の `intent.intentHash` |
  | comment | string | − | 1,000文字以内 |
  | remember | boolean | − | v0.6。`true` は [以後も許可]：その Intent を承認し、同時にルールを追加する |

- レスポンス（200）：API-018 と同じ形（`status` は `approved` / `rejected`）。`remember = true` の場合は、作ったルールも返す（v0.6）。
- エラー：

  | HTTP | code | 条件 |
  |---|---|---|
  | 403 | `FORBIDDEN` | 承認者でない |
  | 409 | `APPROVAL_NOT_PENDING` | 決定済み・期限切れ |
  | 409 | `INTENT_CHANGED` | intentHash が一致しない |
  | 422 | `RULE_NOT_ALLOWED` | `remember = true` だが、[以後も許可を出す条件](#以後も許可を出す条件)を満たさない（v0.6） |
  | 423 | `KILL_SWITCH_ENGAGED` | |

- 副作用：TBL-009、TBL-008、TBL-006 の更新。approve の場合は Gateway の実行ジョブを登録する。監査ログ `approval.decided`。
- `remember = true` の副作用（v0.6）：ルールを定義（スナップショット）の `rules` に追加し、`approvals.remember`・`created_rule_id` を記録する。`match` は Intent の `destination` 引数すべてと `option` 引数すべての値。分類は `widen` だが、ユーザーの直接の操作なので確認カードは重ねて出さない（BR-47 ①）。監査ログ `approval.decided` と `agent.config.widened`（`origin = approval_rule`）。

### 以後も許可を出す条件
15 §「以後も許可」のルール。どれか1つでも外れたら [以後も許可] は出さず（[承認] [やめる] だけ）、API-019 は `RULE_NOT_ALLOWED` を返す。

1. ツールの分類が `write`（`unclassified` には出さない。先に分類してもらう）。
2. ツールに `destination` 引数が1つ以上ある、または `scope: self` が明示されている。
3. 実効ポリシーで、その操作の自律レベルが `approve` で、ワークスペースのポリシーの `rules.enabled` が `true`。
4. Hard Ceiling で `handoff` だけを許す操作（BR-36：支払い・送金・パスワードの変更）でない。
5. 試し実行でない。

### ルールの形
ルールは定義（スナップショット）の `rules` に置き、別のテーブルは作らない。一覧は現在のスナップショットから読む（15 §データベース）。

<details>
<summary>ルールの YAML（15）</summary>

```yaml
rules:
  - id: r-7f3a
    action: mcp.slack.post_message
    match:                        # destination の引数は全部、完全一致
      channel: "D04ABCDEF"
    labels:                       # 表示用（判定には使わない）
      channel: "自分宛ての DM"
    tool_hash: "sha256:…"         # ルールを作ったときのツールの説明・スキーマ・arg_roles のハッシュ
    added_by: me
    added_at: 2026-10-02T07:01:12+09:00
    source_intent_id: "…"
```

</details>

| ルールが効かない条件（無効の理由） | 内容 |
|---|---|
| 網羅していない | `match` のキーに、ツールのすべての `destination` 引数が含まれていない（ツールに `destination` が後から増えた場合を含む） |
| ツールが変わった | `tool_hash` が現在のツールと違う。再確認のときに引き継ぐかを選ぶ（既定は引き継がない） |
| ワークスペースで無効 | ワークスペースのポリシーの `rules.enabled` が `false` |

- 一致の判定：`match` の各キーについて、正規化（文字列の前後の空白を除く、配列は集合として比べる、数値・真偽値はそのまま）したうえで完全一致。glob・正規表現・別名（`"@me"` など）は使えない。
- 上限：ワークスペースのポリシー `rules.max_per_agent`（例：20）。

### API-068：GET /api/v1/agents/{agentId}/rules
- 概要：ルールの一覧。各ルールの `labels`・有効かどうか・無効の理由（上の表）を返す（v0.6）。
- 応答の詳細な形は 15 に記載なし（項目は上の YAML と有効・無効の理由）。

### API-069：DELETE /api/v1/agents/{agentId}/rules/{ruleId}
- 概要：ルールの取り消し（v0.6）。`narrow` の設定変更として即時に反映し、記録する。
- 副作用：新しいスナップショット、監査ログ `agent.config.changed`。

### API-070：POST /api/v1/intents/{intentId}/resolve
- 概要：`unknown_outcome`（送信後に応答が返らなかった）の Intent を解決する（v0.6。BR-59）。
- リクエストボディ：`{ "outcome": "executed" | "failed" | "retry" }`

| outcome | カードの操作 | 結果 |
|---|---|---|
| `executed` | [実行済みとして閉じる] | Intent を `executed` |
| `failed` | [失敗として閉じる] | Intent を `failed` |
| `retry` | [もう一度実行] | 同じ引数で新しい Intent を作り、二重になるおそれがあることをカードに書いたうえで承認を求める（ルールがあっても `auto` にしない） |

<details>
<summary>参考：Gateway での MCP 書き込みの結果と状態（15 §Gateway での実行）</summary>

| 結果 | 状態 | 再試行 |
|---|---|---|
| 正常な応答（`isError` なし） | `executed` | — |
| `isError: true` の応答 | `failed`（`tool_error`、応答の本文を保存） | しない |
| 送信前の失敗（名前解決・接続拒否・TLS） | `approved` のまま | 最大3回、指数バックオフ。尽きたら `failed`（`unreachable`） |
| 認証エラー（401・403、トークンの更新に失敗） | `failed`（`auth_required`） | しない。チャットに [つなぎ直して再実行] を出す |
| 送信後のタイムアウト・接続断・5xx | `unknown_outcome` | **しない**（二重送信を避ける） |

</details>

## 前提・仮定
- A-63：自己レビューの結果は、ハーネスが API-039 の `selfReview` で Intent と一緒に送る（intentHash には含めない）。
- 承認の期限：定期実行の仕事から出た Intent は `min(作成から24時間, 同じ仕事の次の実行の予定時刻)`（15。それ以外は従来どおり24時間、A-05）。
