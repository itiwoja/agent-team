# 07. システムアーキテクチャ：コンポーネント構成と責務
- 親ドキュメント：[07_architecture.md](../07_architecture.md)（要約・図・判断してほしいことは親を見る）

> **3行で**
> 1. デプロイ単位は `web`・`api`・`worker`・`gateway`・`sandbox-edge`・`agent-runner` の6つ。外部作用を実行するのは `gateway` だけ。
> 2. 判定・合成・分類（Kernel）などの共通部品は `packages/` の10個のパッケージにまとめ、各サービスで同じ実装を使う。
> 3. v0.4〜v0.6 の追加（MCP クライアント・Web 取得プロキシ・設定プランナー・届け先）は各行に版つきで書いた。

## デプロイ単位（apps/）

| コンポーネント | 実行環境 | 公開範囲 | 責務 | 主な FR |
|---|---|---|---|---|
| `web` | Firebase Hosting | 公開 | SPA、Service Worker（Push 受信・アプリの外枠のキャッシュ）。SCR-014〜017（エージェント一覧・会話での作成・Harness Canvas・エージェント詳細）、SCR-003・005 の改訂。Canvas は open-agent の Canvas（React）を取り込む。v0.5：SCR-018（エージェントのチャット）を追加、SCR-015 は廃止、SCR-016 は詳細設定へ（一覧は [06](../06_ux_design/README.md)） | 画面全般（FR-025） |
| `api` | Cloud Run（最小1インスタンス） | 公開（LB 経由） | `/api/v1/*`（REST・SSE）、`/webhooks/github`、セッション、認可、タスク作成、承認（v0.6：[以後も許可] の `remember`）、Kill Switch、監査ログの閲覧。API-041〜054・057〜059（エージェント・下書き・試し実行・公開・停止・メモリ・下書きの一覧と破棄・組織全体のエージェント一覧）、API-011〜013 の変更（うち API-043〜048・057・058 は v0.5 で廃止。一覧は [09](../09_api/README.md)）。Webhook：`issue_comment`（メンション起動）・`push`（定義の読み込みジョブ）・`pull_request.opened` / `synchronize`（`.agent/**` の PR の検証ジョブ）・`pull_request.closed`（公開 PR が閉じたら下書きを `drafting` に戻す）。v0.5：エージェントのチャットと設定プランナー、`classify()` | FR-001〜006, 011, 013, 015〜028, 031, 032 |
| `worker` | Cloud Run（最小1インスタンス、CPU 常時割り当て） | 非公開 | ジョブキューの処理（Webhook の処理・サンドボックスの起動と停止・Push 送信・要約生成・Gateway の呼び出し）、定期処理（04「通知・バッチ処理」）。定義の読み込み、`.agent/**` の PR の検証（結果は `gateway` で Check Run）、スケジューラー（1分ごと）、設計アシスタントのジョブ（費用は usage_records に `agent_draft_id` つきで記録。v0.5 で設定プランナーに置換）、スコアカードの集計（毎時）、triager の開始前に Open の Issue 一覧を `gateway` 経由で取得 | FR-002, 007, 011, 013, 017, 021, 022, 024, 028, 032 |
| `gateway` | Cloud Run | 内部のみ（IAM 認証。`api` と `worker` からだけ。v0.4 の `sandbox-edge` からの MCP 呼び出しとの関係は [07 Q-48](../07_architecture.md#-判断してほしいこと)） | GitHub App のトークン発行、GitHub の読み取り（Issue・ファイル・tarball・`.agent/` の定義と Skill・owner の書き込み権限）、Intent の実行と検証。`POST /gw/v1/agent-config-prs`（エージェント定義の公開 PR。`.agent/` 配下に限定。BR-28）、`.agent/**` を変更する PR への Check Run `open-team/agent-config` の作成。v0.4：MCP クライアント（`tools/list` でツール情報を保存、`tools/call`）と MCP の認証情報の保持。v0.6：MCP の書き込みの Intent の実行（ロック・`tool_hash` の確認・自動再試行なし） | FR-002, 003, 005, 007, 012, 022, 027, 028 |
| `sandbox-edge` | Cloud Run | `sandbox-vpc` からだけ（内部 LB） | `/internal/v1/*`：タスクのコンテキスト、LLM Proxy、進捗の受け取り、Intent の受け付け（差分の検証を含む）。API-055（メモリ）・056（レポート）、`phase` の追加（`review`・`report`・`design`）、`memory_write` の判定（`memory.enabled: false` なら deny）、試し実行での Intent の `simulated` 化とメモリの書き込みの破棄（行を作らない）。v0.4：Web 取得プロキシ（`web_search`・`web_fetch`）、`mcp_call` の判定。v0.6：届け先（`deliver`）から Intent を作る | FR-007〜010, 013, 014, 018, 024, 026, 029, 031, 033 |
| `agent-runner` | Cloud Run Jobs（タスクごとに1実行） | 外に公開しない | Harness の実行（フェーズ制御・ツール実行）。テンプレートに固定され、利用者はコードもイメージも差し替えられない（ADR-013） | FR-008, 029〜031, 033 |

## 共有パッケージ（packages/）

| パッケージ | 由来 | 責務 |
|---|---|---|
| `kernel` | itiwoman-automation（FlowEngine・許可リスト・承認待ち）を拡張 | 判定エンジン（FR-004）、Breaker の条件（FR-014）、状態遷移の表、intentHash の計算。`compose()`（FR-023）、`memory_write` の追加。`decide()` の最小限の拡張（`paths.allow` → `path_not_allowed`、`agent_day_usd` と `budget.per_day_usd` の比較。ADR-012）。v0.4：汚染（taint）の記録。v0.5：`classify()`（ADR-027） |
| `policy-schema` | 新規 | policy.yaml と routing.yaml の JSON Schema、Hard Ceiling、既定値、正規化。エージェント定義（`.agent/agents/<id>.yaml`）と SKILL.md の frontmatter の JSON Schema、その Hard Ceiling。Hard Ceiling の版（`ceilings_version`。スナップショットに記録し、compose() の再現に使う。NFR-036）。routing の `review` / `report` / `design` |
| `router` | open-agent のモデル Router | フェーズからモデルを選ぶ、価格表による費用の見積もり。`review`・`report`・`design`（未指定なら `plan` のモデル）、エージェント定義の `routing` による上書き |
| `harness` | open-agent の Harness と PermissionMap | エージェントのループ、ツールカタログ、Proxy の判定への従い方。テンプレート（`templates/`）、`load_skill`・`remember`・`submit_report`、dev-coder の自己レビューのループ |
| `llm-adapters` | open-agent（OpenRouter などの連携） | プロバイダーごとの呼び出しと、共通形式への正規化 |
| `db` | 新規 | スキーマ・マイグレーション・リポジトリ層（RLS のための `SET app.org_id`）。TBL-018〜022 と tasks の変更（以降のテーブルは [08](../08_database/README.md)） |
| `audit` | itiwoman のイベント記録と open-agent の Evidence を統合 | ハッシュチェーンへの追記、検証、チェックポイント |
| `diff` | 新規 | unified diff のパース、ベース tree への適用、tree SHA の計算（`gateway` と `sandbox-edge` で同じ実装） |
| `github` | itiwoman の FakeGitHub を本物に置き換え | GitHub API のクライアント（テスト用の Fake も同じインターフェース） |
| `sandbox-provider` | 新規 | `SandboxProvider` インターフェース（`start` / `stop` / `status`）と Cloud Run Jobs の実装 |

