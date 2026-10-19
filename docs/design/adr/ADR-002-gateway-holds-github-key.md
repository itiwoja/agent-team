# ADR-002：GitHub App の秘密鍵を `gateway` だけに置き、GitHub の読み取りも `gateway` を経由する
- 状態：承認（v0.2 で追記あり） ／ 日付：2026-10-01 ／ 決定者：—（元の記述なし）
- 影響する ID：NFR-021, FR-012, FR-022, FR-027

## 状況
読み取り（Issue・ポリシー・tarball）にもインストールトークンが必要になる。

## 決定
秘密鍵は `gateway` だけが読める。`api` と `worker` は、読み取りも `gateway` の内部 API を通す。書き込みは Intent の実行だけに限る。

**追記（v0.2）**：Intent の実行のほかに、ユーザーの操作によるエージェント定義の PR（`POST /gw/v1/agent-config-prs`。`.agent/` 配下のみ。BR-28）と、`.agent/**` を変更する PR への Check Run `open-team/agent-config` の作成を `gateway` の書き込みに加える（FR-022、FR-027）。

## 理由
外部作用のチョークポイントを1つにし、鍵が漏れる範囲を最小にする。

## 代替案
—（元の記述なし）

## 影響
- 内部の呼び出しが1回増える（数 ms〜数十 ms）。`gateway` の可用性が、タスクの作成と開始に影響する。
- 関連（v0.4）：MCP コネクタの認証情報も `gateway` だけが持つ（[ADR-022](ADR-022-mcp-unified-unclassified-is-write.md)、[07 §外部連携](../07_architecture.md#外部連携)）。
