# 10. 成長機構の図
- 版数：v1.8（2026-10-26） ／ インプット：[機能仕様](../04_functional_spec/learning.md)、[DB](../08_database/learning.md)、[API](../09_api/learning.md)

> **3行で**
> 1. 採用前の検証と採用後の実行を分離する。
> 2. 未知条件だけAIへ戻し、結果不明の副作用は再送しない。
> 3. DBの関係は専用ER図を参照する。

## 🧭 判断してほしいこと
なし。

## 全体図
```mermaid
stateDiagram-v2
 [*] --> candidate
 candidate --> validating
 validating --> shadowing
 shadowing --> active
 candidate --> rejected
 validating --> rejected
 shadowing --> rejected
 active --> superseded
 active --> invalidated
 candidate --> disabled
 validating --> disabled
 shadowing --> disabled
 active --> disabled
```
見てほしいところ：終端版をそのまま再有効化する遷移はない。

## 要点
- [ER図](../08_database/learning.md#全体図)はDB定義と共通。
- [採用](#uc-073074記録と採用)はvalidatorが決定。
- [局所推論](#uc-075局所推論)と[停止](#uc-076停止)で再開境界を示す。

## 詳細
### UC-073・074：記録と採用
```mermaid
sequenceDiagram
 participant O as 持ち主
 participant M as 本体
 participant C as 候補生成LLM
 participant V as Validator
 participant D as SQLite
 O->>M: 日程調整を依頼
 M->>D: 型付き実行履歴を保存
 M->>C: 適格履歴から候補生成
 C-->>M: IR候補
 M->>D: candidateを保存
 V->>D: 静的・再生・反例検証結果
 M->>V: 後続依頼5件の共有観測と期待結果
 V->>D: シャドー検証結果
 V->>D: 依存再確認＋active切替＋監査を同時確定
```
検証には外部書込の経路を渡さない。

### UC-075：局所推論
```mermaid
sequenceDiagram
 participant M as 本体
 participant E as IR Executor
 participant A as 穴の推論
 participant K as Kernelと既存承認
 participant G as Calendar Connector
 M->>E: 型付き入力と固定版
 E->>G: freshな空き時間取得
 G-->>E: 観測
 alt ガードmiss
 E->>A: 契約と必要な根拠だけ
 A-->>E: 型付き回答と根拠
 E->>E: 契約を検査してcheckpoint保存
 end
 E->>K: 正規化したIntent
 K-->>E: 既存規則に基づく承認結果
 K->>G: Intent実行preflightで空き時間再取得
 alt 条件成立
 E->>E: effectKeyと送信予定を永続化
 E->>K: 永続化したeffectKeyで実行要求
 K->>G: 同じIntentの操作送信
 alt 結果不明
 E->>E: unknown_outcomeで停止・再送禁止
 else 結果確定
 E->>E: 完了checkpoint保存
 end
 else 条件が変化
 E->>E: Intent破棄・再計算・再承認
 end
```
権限拒否や通信障害はガードmissの分岐へ入らない。

### UC-076：停止
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant A as 認証済API
 participant D as SQLite
 participant E as IR Executor
 O->>A: POST /api/v1/learning/programs/:programId/disable
 A->>A: 身元・Origin・CSRF・冪等キーを確認
 A->>D: CASでdisabled＋監査を保存
 A-->>O: 200 状態
 E->>D: 次ノード前に状態確認
 D-->>E: disabled
 E->>E: 停止。送信済み結果だけ照合
```
身元確認は既存のTailscaleまたはLANパスキーの規約を継承する。

## このドキュメントで決まったこと
[D-397・398・401](../00_learning.md#決定事項ログ)。
