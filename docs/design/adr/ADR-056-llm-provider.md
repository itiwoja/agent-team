# ADR-056：LLM の接続先に Bedrock・Vertex 経由の Claude を足す（Should）
- 状態：承認 ／ 日付：2026-10-24 ／ 決定者：ユーザー（足す）、Claude判断（道具の切り替えの線引き）
- 影響する ID：REQ-095, US-062, UC-042, FR-087, FR-075, FR-080, FR-013, SCR-023, API-111, 07 技術選定・外部連携, 11 §10

## 状況
LLM は Claude だけ（2026-10-23 の決定）で、接続先は Anthropic の API 直だけだった。企業導入（ADR-055）では、AWS や Google Cloud の契約の中で Claude を使いたい会社が多い。モデルは同じ Claude なので、接続先を増やすだけで済む。

## 決定
- `.env` の `LLM_PROVIDER` で接続先を選ぶ：`anthropic`（既定）・`bedrock`・`vertex`。モデルは同じ Claude。他社の LLM は入れない（Won't のまま）
- SDK は接続先ごとの公式クライアント：`@anthropic-ai/sdk`・`@anthropic-ai/bedrock-sdk`（`AnthropicBedrockMantle`）・`@anthropic-ai/vertex-sdk`（`AnthropicVertex`）。会話の形（Messages API）は共通で、`llm/claude.ts` はクライアントの作り方だけを接続先で分ける
- モデル名は接続先ごとの形：Anthropic 直と Vertex は `claude-opus-5-5`、Bedrock は `anthropic.claude-opus-5-5`
- 接続先で使えない道具は本体が宣言から外す：Bedrock では Claude の Web 検索ツール（`web_search`）が使えないので出さない（`web_fetch` は本体の実装なので使える）。Vertex の Web 検索は基本版（`web_search_20250305`）。コンピューターユースの道具は、Anthropic 直・Vertex は `computer_toolset_20260801`、Bedrock は `computer_20251124`
- 費用の見積もり（FR-013）は Anthropic 直の単価で行い、Bedrock・Vertex の請求はそれぞれの事業者の単価になることを設定画面と手順書に書く

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| Anthropic 直のみ（今のまま） | 設計を変えない | 企業導入で最初に止まる | 企業導入の道を残す（ADR-055） |
| Bedrock・Vertex 経由を Should で足す（採用） | モデルは同じ Claude。クライアントの作り方だけが違う | 接続先で使えない道具が違う。単価が違う | 差分が小さく、企業導入の要件に直接効く |
| 他社の LLM も使える | 選択肢が広い | computer use の道具の前提が崩れる。2026-10-23 の決定を覆す | 設計の影響が大きすぎる |

## 影響
- `.env` に `LLM_PROVIDER`・`AWS_REGION`（＋AWS の資格情報）・`CLOUD_ML_REGION`・`ANTHROPIC_VERTEX_PROJECT_ID`（＋GCP の ADC）を足す（11 §10）。`LLM_PROVIDER` ごとに必須の値が違い、足りなければ起動時に止まる（UC-042 E2）
- API-111 の応答に `llm.provider`・`llm.model` を足し、SCR-023 の「ホスト」欄に出す
- 単体試験に「接続先ごとの道具の宣言の切り替え」を足す（11 §11）
- Anthropic 直だけにある機能（サーバー側のフォールバック `fallbacks` など）は使わない前提を保つ
