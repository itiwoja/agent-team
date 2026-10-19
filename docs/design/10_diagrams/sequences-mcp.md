# 10. シーケンス図：MCP の呼び出しと書き込みの Intent
- 入口：[README](README.md) ／ 関連：[04](../04_functional_spec/README.md)、[07](../07_architecture.md)、[ADR-022](../adr/ADR-022-mcp-unified-unclassified-is-write.md)、[ADR-031](../adr/ADR-031-mcp-write-no-auto-retry.md)

> **3行で**
> 1. MCP のツールは、読み取り（`read`）ならすぐ呼び、書き込み・未分類なら Intent にする。認証情報は Gateway だけが持つ（フェーズ0）。
> 2. 書き込みの Intent は、エージェントが直接呼ぶ（`assistant`）か、仕事の届け先（`deliver`）からランタイムが作る。エージェントは結果を待たない。
> 3. 送信後に結果が分からなければ `unknown_outcome` にし、自動で再試行しない。タスクの終わり方は Intent の結果から決める。

## MCP 呼び出しの経路（13）

```mermaid
sequenceDiagram
  participant H as Harness（エージェント）
  participant E as sandbox-edge
  participant K as Kernel
  participant G as Gateway
  participant M as MCP サーバー
  H->>E: mcp_call(connector, tool, args)
  E->>K: decide(action = mcp.<c>.<t>, args, taint)
  alt read（mcp_read: auto）
    K-->>E: allow
    E->>G: 呼び出し
    G->>M: tools/call
    M-->>G: 結果
    G-->>E: 結果（サイズ上限・秘密情報のマスク）
    E-->>H: 結果（taint を付ける）
  else write / unclassified
    K-->>E: approve（またはルール一致で allow）
    E-->>H: Intent として受付（引数を固定・intentHash）
    Note over K,G: 承認カード → 承認 → Gateway が固定した引数で実行 → 結果を監査ログに記録
  end
```
見てほしいところ：読み取りの結果を受け取った時点でタスクに `taint` が付く（BR-38、[汚染の状態](states.md#汚染taskstainted)）。書き込み側の詳しい流れは次の図（15）が正。

- 書き込みの Intent では引数をそのまま承認カードに表示し、承認は intentHash（コネクタ・ツール・引数・ツールの説明のハッシュ）に紐づける。
- 実行後の検証は、MCP に読み戻しの標準がないため、ツールごとに `none`（既定）/ `readback`（フェーズ1）を設定する。

## MCP の書き込みの Intent（15）

```mermaid
sequenceDiagram
    autonumber
    participant H as Harness
    participant E as sandbox-edge
    participant K as Kernel
    participant A as api（承認）
    participant G as Gateway
    participant M as MCP サーバー

    alt エージェントが書き込みツールを呼ぶ（assistant）
        H->>E: mcp_call(connector, tool, args)
    else 届け先（タスクの最後）
        Note over E: ランタイムが deliver から Intent を作る
    end
    E->>K: decide(subject, taint, counters)
    K-->>E: allow / approve / deny
    E->>A: action_intents に保存（intentHash）
    E-->>H: { intentId, status }（結果は待たない）
    alt approve
        A-->>A: 承認カード → 承認 or [以後も許可]
    end
    A->>G: 実行ジョブ
    G->>G: ロック・前提の確認（状態・Kill Switch・tool_hash）
    G->>M: tools/call（固定した引数）
    M-->>G: 結果
    G->>A: executed / failed / unknown_outcome
```
見てほしいところ：宛先は定義が決め、LLM は中身だけを書く（BR-58）。Gateway は実行直前に `tool_hash` を確かめ、ツールが変わっていれば実行しない（`expired`（`tool_changed`））。

- `mcp_call` の戻り値は `{ intentId, status: "pending_approval" | "accepted" | "denied" }` だけ。書き込みの結果に依存する手順は作らない（フェーズ0、A-87）。
- エージェントのループが終わった時点で承認待ちの Intent があれば、タスクを `awaiting_approval` にし、サンドボックス（または実行用のプロセス）を終了する。
- `tools/call` のタイムアウトは60秒、保存する応答は64KBまで（A-86）。結果ごとの状態と再試行は [Intent の状態](states.md#intentaction_intentsstatus)。
- `decide()` の評価順（Kill Switch → 予算 → Breaker → 操作の分類 → ツールの状態 → Intent の数 → パス → 自律レベル → ルール）は [04](../04_functional_spec/README.md)。汚染はこの判定の結果を変えない。

## タスクの終わり方（15）

15 §タスクの終わり方の表を図にしたもの。上から順に当てはめる。

```mermaid
flowchart TD
  S([タスクの終わり方を決める]) --> Q1{Intent がある?}
  Q1 -- ない --> R1["completed（report）"]
  Q1 -- ある --> Q2{"failed / unknown_outcome を<br/>1つでも含む?"}
  Q2 -- はい --> R2["failed（action_failed）<br/>レポートは残る"]
  Q2 -- いいえ --> Q3{"rejected / expired を含む?"}
  Q3 -- はい --> R3["completed（actions_declined）"]
  Q3 -- いいえ --> R4["succeeded<br/>（すべて executed / verified）"]
```
見てほしいところ：`succeeded` の意味は「PR の作成と検証が完了」から「外部作用がすべて実行された（検証できるものは検証済み）」に広がった。

- メモリの有効化（BR-26）は `succeeded` と `completed`（`report` / `actions_declined`）で行う。
- 定期実行の仕事では、次の実行が始まった時点で前の実行の `pending_approval` を `expired`（`superseded`）にし、そのタスクを `completed`（`actions_declined`）で終わらせる（BR-60）。
- この終わり方を、タスクの状態遷移図のどの遷移にするかは Q-87。
