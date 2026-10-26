# ADR-078：LLM を役割ごとに選ぶ（Claude・OpenAI・OpenAI 互換）
- 状態：承認（v1.6。接続先 `openai_chatgpt` を v1.7 で [ADR-084](ADR-084-sign-in-with-chatgpt.md) に追加。D-357 は v1.7 で [ADR-083](ADR-083-classify-and-local-on-pi.md) に置き換え） ／ 日付：2026-10-26 ／ 決定者：ユーザー（差別化の軸 C、接続先の範囲）・Claude判断（役割と能力の宣言）
- 影響する ID：REQ-110, US-077, UC-066, FR-075・098・107・108, NFR-093, TBL-035・059, API-111・152, SCR-023・029, R-101・104, D-352〜355・357・361〜364。D-315 を置き換える（[ADR-056](ADR-056-llm-provider.md) は取り下げのまま）

## 状況
大手 3 社は自社のモデルに縛られる（Dots は GPT-6 Astra、Muse は Muse Spark）。v1.5 は「Claude だけ・Anthropic の API 直だけ」（D-315）で、こちらも 1 社に縛られていた。他社の LLM を断った理由は「computer use の道具の前提が崩れる」ことだった。ところが今は OpenAI のモデルにも computer use の道具がある。閉域（ADR-074）で動かすには、社内の推論サーバーも使えなければならない。

## 決定
- 役割ごとにモデルを選ぶ：`main`（メイン）・`worker`（振り分け先）・`computer`（画面の操作）・`review`（オートレビュー）・`summary`（要約）。接続先は `anthropic`・`openai`・`openai_compatible`（`base_url` を書く。Ollama・vLLM・LM Studio など）（D-352）
- `llm_models` にモデルの能力（`tools`・`vision`・`computer_use`・文脈の長さ・`prompt_cache`）と単価を宣言する。能力が足りない役割には選べない。単価が空なら動かさない。ローカルは単価 0 と明示する（D-353）
- Claude と OpenAI の computer use の呼び出しは、本体の中で同じ「作動の形」に直してから確かめ・Kernel に渡す。Kernel・box-agent・確かめは接続先を知らない。`openai_compatible` の画面の操作は、スクショと座標を使う本体の汎用の道具（`generic`）で行う。これは「試し」扱いで、持ち主が入れたときだけ選べる（D-354）
- 文脈は、接続先によらず先頭を変えない形に組む（ADR-066）。費用の上限は、宣言した単価で計算する（D-355）
- ローカル LLM の推論サーバーはラズパイに置かない（D-357）
- キーは `.env` の `OPENAI_API_KEY`・`OPENAI_COMPATIBLE_API_KEY`（任意）（D-361）。役割の既定は `main`・`worker`・`computer` が `claude-opus-5-5`、`review`・`summary` が `claude-sonnet-5-5`（D-362）
- 要約を始める長さ ＝ min（6 万, 文脈の長さ × 0.5）、呼び出し前の上限 ＝ min（今の値, 文脈の長さ × 0.9）（D-363）
- context editing と思考ブロックの署名は Anthropic のときだけ。ほかの接続先では、送るときの投影で古い画像を外す（D-364）

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| Claude だけ（今のまま） | 道具の前提が 1 つ | 1 社に縛られる。閉域で使えない | 差別化にならない |
| 主要どこでも（Gemini・Bedrock・Vertex も） | 選択肢が広い | 道具・キャッシュ・料金の違いを全部持つのが重い | 最初の版は 3 つに絞った（ユーザー） |
| Claude＋ローカルだけ | 範囲が小さい | OpenAI の computer use を使いたい人が選べない | ユーザーが 3 つを選んだ |

## 影響
- `llm/` を接続先ごとのクライアントと、作動の形への変換に分ける
- 試験ページで、接続先ごとに確かめた先と実行した先が同じことを確かめる（R-104）
- `.env` に `OPENAI_API_KEY` と `openai_compatible` の `base_url`・キーを足す
- 費用の見積もり（FR-013）は宣言した単価で行う
