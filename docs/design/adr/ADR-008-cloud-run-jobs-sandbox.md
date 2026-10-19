# ADR-008：サンドボックスの基盤は Cloud Run Jobs を使い、`SandboxProvider` で抽象化する
- 状態：承認（ベータ前に要検証） ／ 日付：2026-10-01 ／ 決定者：—（元の記述なし）
- 影響する ID：NFR-009, NFR-014, NFR-015, NFR-020, NFR-049

## 状況
候補は Cloud Run Jobs、E2B、Fly Machines（concept.md の未決事項）。

## 決定
MVP は Cloud Run Jobs を使い、権限ゼロのサービスアカウント、専用の VPC、Secure Web Proxy を組み合わせる。`SandboxProvider`（`start` / `stop` / `status`）で抽象化する。

## 理由
- Control Plane と同じ GCP の中で、IAM・VPC・ログを一緒に管理できる。
- 起動時間（NFR-009 の 60秒）を満たす見込みがある。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| E2B / Fly Machines / 自前の Firecracker | — | — | Control Plane と同じ GCP の中で IAM・VPC・ログを一緒に管理するため（上記の理由）。起動の速さが必要になれば差し替え候補 |

## 影響
- 起動が数十秒かかる。速くする必要が出たら `SandboxProvider` の実装を E2B などに差し替える。
- **ベータの前に起動時間と隔離の強さを検証する**（[07 Q-49](../07_architecture.md#-判断してほしいこと)）。
- フェーズ0はローカルの Docker で動かす（[ADR-025](ADR-025-phase0-single-user-local.md)）。
