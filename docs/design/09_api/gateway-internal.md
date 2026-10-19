# 09. API設計：Gateway の内部 API（`/gw/v1`、参考）
- プロジェクト：open-team（仮称） ／ 版数：v0.6（2026-10-01） ／ 入口：[README.md](README.md) ／ 共通仕様：[common.md](common.md)

> **3行で**
> 1. 外部作用のチョークポイントを明確にするため、`gateway` が提供する操作を定義する。`api` と `worker` からだけ IAM 認証で呼び、公開しない（API-ID は付けない）。
> 2. GitHub の書き込みは Gateway だけが行う（[ADR-002](../adr/ADR-002-gateway-holds-github-key.md)）。MCP の認証情報も Gateway だけが持つ（13）。
> 3. MCP の `tools/list`・`tools/call` を呼ぶ内部操作のパスは未設計（Q-72）。

## 🧭 判断してほしいこと
- [Q-72](README.md#-判断してほしいこと)：MCP の操作（`tools/list` の取得、Intent の実行）を Gateway の内部 API としてどう出すか。15 は「FR-012 の MCP 版」としているが、`/gw/v1/intents/{intentId}/execute` を使うかは明記なし。
- [Q-74](README.md#-判断してほしいこと)：`agent-config-prs` の呼び出し元だった API-048 が廃止（v0.5）。GitOps モード（12 v0.3）での使い方は未設計。

---

## 詳細

### 操作の一覧

| 操作 | 概要 | 呼び出し元 |
|---|---|---|
| `POST /gw/v1/installations/{id}/sync` | インストール・リポジトリの同期 | worker |
| `GET /gw/v1/repos/{repoId}/issues` | Issue の一覧 | api（API-010） |
| `GET /gw/v1/repos/{repoId}/files?path=&ref=` | ファイルの取得（ポリシー、v0.2 でエージェント定義 `.agent/agents/*.yaml` と Skill `.agent/skills/*/SKILL.md`。FR-022） | api, worker |
| `POST /gw/v1/repos/{repoId}/snapshots` | tarball の取得と GCS への保存 | worker |
| `POST /gw/v1/intents/{intentId}/execute` | Intent の実行と検証（FR-012） | worker |
| `POST /gw/v1/agent-config-prs` | エージェント定義の公開 PR の作成（v0.2。FR-027）。詳細は下記 | api（廃止した API-048） |
| `POST /gw/v1/repos/{repoId}/check-runs` | `.agent/**` を変更する PR（open-team が作ったものに限らない）の検証結果を Check Run `open-team/agent-config` として返す（v0.2。FR-022、BR-28、A-43） | worker |
| `GET /gw/v1/repos/{repoId}/permissions/{login}` | GitHub 上のリポジトリへの権限の確認（v0.2。スケジュール起動の owner の確認。BR-25） | worker |

### MCP の Intent の実行（15 §Gateway での実行）
1. `action_intents` を `SELECT … FOR UPDATE` でロックし、状態が `approved`、Kill Switch が未発動、ツールの現在の `toolHash` が Intent のものと同じであることを確かめ、`executing` にする。ツールが変わっていれば `expired`（`tool_changed`）。
2. 認証情報を復号し、`tools/call` を呼ぶ（タイムアウト60秒。A-86）。Intent の `arguments` をそのまま渡す（BR-15 を MCP に広げる）。
3. 結果で状態を決める（表は [approvals.md](approvals.md#api-070post-apiv1intentsintentidresolve)）。応答の本文は 64KB の上限とマスクを通してから保存する。

### `POST /gw/v1/agent-config-prs`（v0.2）
- パスは 12 FR-027 と同じ。
- 処理：`path` がすべて `.agent/` 配下であることを確認する（1つでも外れていれば全体を拒否。BR-28）。ブランチ `open-team/agent-config/<draftId の先頭8文字>` をデフォルトブランチ HEAD から作り、GitHub App を作成者としてコミットし、PR を作る。書き込めるのは `refs/heads/open-team/agent-config/*` のブランチと、その PR だけ（BR-16 の拡張）。
- レスポンス（201）：`{ "prNumber": 57, "prUrl": "https://github.com/owner/app/pull/57", "branch": "open-team/agent-config/d1a2b3c4", "commitSha": "..." }`
- 再公開（UC-019 4a）：同じブランチが残っていて、そのブランチの open な PR がない場合は、ブランチをデフォルトブランチ HEAD からの新しいコミットに更新して PR を作り直す（`open-team/agent-config/*` 以外は更新しない。BR-28。A-65）。
- エラー：400（`.agent/` 配下でないパス）、409（同じブランチに open な PR がすでにある）、502（GitHub API のエラー）
- 監査ログ：`agent_config.pr_opened`（主体は `actorUserId`。エージェントの Intent ではない）

<details>
<summary>リクエストボディの例</summary>

```json
{
  "repositoryId": "r1...",
  "draftId": "d1a2b3c4-...",
  "files": [
    { "path": ".agent/agents/deps-bot.yaml", "content": "version: 1\n..." },
    { "path": ".agent/skills/update-deps/SKILL.md", "content": "---\nname: update-deps\n..." }
  ],
  "title": "open-team: 依存更新係 を追加",
  "body": "（実効ポリシーの要約・前の定義との差分・試し実行の結果へのリンク）",
  "actorUserId": "u1..."
}
```

</details>
