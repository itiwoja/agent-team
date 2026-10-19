# ADR-001：判定エンジンを純粋関数にし、状態は DB だけに持つ
- 状態：承認 ／ 日付：2026-10-01 ／ 決定者：—（元の記述なし）
- 影響する ID：FR-004, NFR-007, NFR-036

## 状況
判定は、LLM 呼び出し（`sandbox-edge`）、Intent（`sandbox-edge`）、承認・実行（`api`・`gateway`）の複数の場所で必要になる。

## 決定
`packages/kernel` の `decide(policy, subject, counters, flags)` を純粋関数として実装する。呼び出す側は DB のトランザクションの中でカウンタとフラグを読み、判定し、結果と状態の変更を同じトランザクションでコミットする。

## 理由
- 判定の再現性（NFR-036）とテストのしやすさ。
- サービスが増えても、判定の実装が1つにまとまる。

## 代替案
—（元の記述なし。判定器の実装方式の比較は [ADR-009](ADR-009-own-policy-evaluator.md)）

## 影響
- カウンタの更新は、タスクの行をロックして行う（1タスクの中は直列。LLM 呼び出しは本来直列なので問題ない）。
- 後から同じ形の純粋関数として `compose()`（[ADR-012](ADR-012-stricter-wins-composition.md)）と `classify()`（[ADR-027](ADR-027-classify-widening-changes.md)）が加わった。
- 配置は [07 §レベル3](../07_architecture.md#レベル3コンポーネント図)。
