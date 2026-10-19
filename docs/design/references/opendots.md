# 参考：OpenDots から取り込むもの
- 版数：2026-10-02 ／ 対象：[CopilotKit/OpenDots](https://github.com/CopilotKit/OpenDots)（MIT、2026-10-02 時点の main）

> **3行で**
> 1. OpenDots は「名前のある AI の同僚（Dot）が、自分のコンピューター・チャット・通話・Slack で働く」セルフホスト用のテンプレート。React 19＋Vite、Hono、Zod と、技術スタックが open-team とほぼ同じ。
> 2. ただし統制は「Dot ごとの権限のオン／オフ」と「保存前の確認カード」だけで、Kernel・Intent・宛先の固定・汚染の追跡に当たるものはない。差別化の軸（決定論的な統制）は変わらない。
> 3. 取り込むのは **Web 取得の安全策**、**フェーズ0の固定トークンの守り方**、**Markdown の画像による持ち出しの対策** の3つ（[11 §8](../11_tech_spec.md#8-セキュリティ設計) に反映済み）。コードは実装のときに `web_fetch` と `app` の土台として持ってくる。

## 🧭 判断してほしいこと
| # | 種類 | 論点 | 選択肢 | おすすめ（理由） |
|---|---|---|---|---|
| 1 | ✅決定（[D-46](../decisions.md#d-46)） | 実行中に権限が **狭まった** とき、走っているタスクを止めるか | A：止める（OpenDots は権限・一時停止を 100ms ごとに見て、変わったら実行を中断する）／ B：今のまま（BR-04：開始時のスナップショットに固定） | **A を `narrow` の変更に限って採る**。広げる変更は BR-04 どおり次のタスクから。狭めたのに走り続けると、ユーザーの「止めたつもり」と食い違う。Kill Switch（BR-17）は既に即時なので、その延長で済む |
| 2 | ✅決定（[D-47](../decisions.md#d-47)） | 設定が足りないときの画面 | A：足りない `.env` の名前を一覧で出す「準備中」の状態（OpenDots の `SetupStatus.missing`）／ B：エラーのまま | **A**。フェーズ0の立ち上げと審査用デプロイの確認が速くなる。値は出さず、名前だけ出す |

## 取り込むもの
| # | OpenDots の該当箇所 | 何をしているか | open-team での行き先 |
|---|---|---|---|
| 1 | `src/browser/security.ts` | URL の検証。http(s)・ポート 80/443・URL の認証情報なし・`localhost`/`.local` 拒否。名前解決した全アドレスのうち1つでも私的・特殊なら拒否（IPv4・IPv6 の一覧つき） | `sandbox-edge` の Web 取得プロキシ（ADR-023）。[11 §入力検証](../11_tech_spec.md#入力検証) に規則を追記 |
| 2 | `src/browser/transport.ts` | 検証で得た IP に `lookup` を差し替えて接続（DNS リバインディング対策）。5MB で切る、`Set-Cookie`・`Location` を捨てる、10秒のタイムアウト | 同上。open-team はリダイレクトを「1回ごとに検証し直して追う」（OpenDots は全部拒否）ので、そこだけ変える |
| 3 | `src/server/app.ts` の `/api/*` ミドルウェア | 固定トークンの定数時間比較、`Origin`・`Sec-Fetch-Site` の確認、JSON 以外の POST を 415、`no-store`・`nosniff`、本文の上限 1MB | フェーズ0の `PHASE0_ACCESS_TOKEN`（D-06）と、フェーズ0-H の入口。[11 §認証・認可](../11_tech_spec.md#認証認可) に追記 |
| 4 | `src/client/ChatTranscript.tsx` の `ReactMarkdown` | `img` を代替テキストに置き換えて描く | SCR-019 の行の本文・報告。LLM が書いた `![](https://…?q=秘密)` を画面が読み込むだけで中身が出ていく経路を塞ぐ。[11 §脅威モデル](../11_tech_spec.md#脅威モデル) に1行追加 |
| 5 | `src/server/dot-agent.ts` | クライアントから来た `system` / `developer` のメッセージを捨ててから LLM に渡す | `api` のチャット（設定プランナー）。画面から送られる会話は `user` / `assistant` だけを受け付ける |

小さな参考（設計の変更はしない）：
- **見本と本物を分ける**：OpenDots は見本の結果に `sample: true` を付け、画面で「架空の見本」と明示する。open-team の `sim-world` の行にも「模擬」を添える（15 の方針どおり）。
- **保存の応答が消えたときの復元**：承認後に応答が届かなくても、同じ `toolCallId` で先に結果を引いてから再送する。open-team は `Idempotency-Key`（09 共通）で同じことを満たしている。

<details>
<summary>取り込まないもの（理由つき）</summary>

| OpenDots の機能 | 取り込まない理由 |
|---|---|
| Dot のコンピューター（OpenBot：ブラウザ操作・シェル・人の割り込み） | ブラウザ自動操作は採らない方針（v0.2）。シェルはサンドボックスの中だけ |
| CopilotKit Intelligence（会話の保存）・AG-UI・CopilotKit Runtime | 外部の有償サービスに会話の正本を置くことになる。open-team は PostgreSQL が状態の唯一の正本（11 §2） |
| TanStack AI の OpenAI 互換アダプター | ハッカソンは Gemini（Gemini Enterprise Agent Platform 経由、ADR-032）。LLM は LLM Proxy の後ろに置くので、アダプターの選び方は Proxy の中の話 |
| SQLite の `Store` とリース式のキュー（`runner.ts`） | graphile-worker（ADR-006）で同じことができる |
| Spaces・ページの編集（Tiptap） | 毎日の画面は SCR-019 の1枚（ADR-034）。文書の編集は目的外 |
| 通話（Realtime 音声）・Slack（Channels SDK） | ハッカソンでは音声を使わない（ADR-032）。Slack はフェーズ2 |
| Automatic Learning（会話から Skill を学ぶ） | Skill の追加は設定変更として提案し、ユーザーが確かめる（D-16）。自動で学ばせない |
| 承認カードの「Approve & save / Decline」 | open-team は ○ と5秒の取り消し（D-43）で既に決めている |

</details>

## 実装のときの持ってき方
- `security.ts` と `transport.ts` は `sandbox-edge` の Web 取得プロキシにほぼそのまま移す。ファイルの先頭に出どころと MIT の著作権表示を残す（`Copyright (c) CopilotKit`、LICENSE の全文はリポジトリの `THIRD_PARTY_NOTICES` に置く）。
- 変える点：リダイレクトを追う（1回ごとに検証と IP の固定、最大5回）、`max_fetches_per_task`（A-77）を数える、取得した本文でタスクを汚染扱いにする（BR-38）。
- フェーズ0-H では `web_fetch` は `sim-world` の模擬の Web に向く（BR-64）ので、公開デプロイでこのコードが外に出ることはない。ローカルのフェーズ0とフェーズ1で使う。
