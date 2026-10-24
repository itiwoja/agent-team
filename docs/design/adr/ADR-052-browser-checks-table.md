# ADR-052：ブラウザの確認は action_intents に乗せず、別の表 browser_checks にする
- 状態：承認（2026-10-24 にユーザーが承認：D-172） ／ 日付：2026-10-24 ／ 決定者：Claude判断（提案）→ ユーザー
- 影響する ID：FR-077, TBL-039, API-087, API-110

## 状況
v0.1 では、こわい操作の確認を `action_intents` に `browser_action` として足す設計だった。今の `action_intents` は MCP の書き込み用で、`connector_id`（NOT NULL・外部キー）・`tool_hash`・`destination_key`・`option_digest`・`intent_hash` などが必須。`approvals` も `risk_level`・`approver_ids` などが必須で、ブラウザの操作には当てはまる値がない。

## 決定
ブラウザの確認は新しい表 `browser_checks` に置く。承認は中身のハッシュ（操作の引数・タブとフレーム・操作の先・フォームの値・VM の世代）に結びつけ、`pending → executing` の条件つきの更新で1回だけ実行する。○ / × の口も別（API-110）にし、確認の一覧（API-087）でだけ両方を並べる。

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| `action_intents` に乗せ、ブラウザ用の疑似コネクタを作る | 確認の流れが1本 | 意味のない値で必須の列を埋める。ハッシュの意味が変わる | 今の守り（Intent のハッシュ・ポリシーの照合）を弱める |
| `action_intents` の列を種類ごとに任意にする | 表が1つ | 今の制約と repo を大きく変える | 移す量が増える |

## 影響
- 確認の一覧の repo（`db/repo/check.ts`）は、2つの表を合わせて返す
- 監査ログは `browser.checked` で残す
