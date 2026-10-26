# ADR-074：閉域で動かせるようにし、社内システムへの到達と外に出た通信の台帳を持つ
- 状態：承認（v1.6） ／ 日付：2026-10-26 ／ 決定者：ユーザー（差別化の軸 A）・Claude判断（形）
- 影響する ID：REQ-106・107・108, US-073〜075, UC-062〜064, FR-101〜103, NFR-064・066・089, TBL-035・056, API-148, SCR-027, R-102・106, D-340〜344・356・358〜360・365〜367

## 状況
OpenAI の Dots・xAI の Grok Bot・Meta の Muse は、どれもエージェントを提供元のクラウドで動かす。そのため社内のシステム・ファイルサーバー・閉じたネットワークの業務画面には届かない。データとログインした状態（Cookie）も提供元に置かれる。自分の機械に置けることは、この 3 つが作りの上で真似できない点になる。ところが v1.5 の作りは、Tailscale の SaaS・Funnel・Web Push・Anthropic の API を前提にしていて「外に出ない」とは言えなかった。VM は家の LAN に例外なく届かないので、社内システムも扱えなかった。

## 決定
- 閉域モード `network.mode`：`standard`（既定。今のまま）か `closed` を選ぶ。`closed` では、本体と VM の外向きは `network.allow_hosts` に書いた先だけに限る。LLM の接続先も、書かなければ届かない（D-340）
- 入口は Tailscale（既定）・Headscale・社内 LAN の直結（社内 CA の TLS）から選ぶ。`closed` では Tailscale の SaaS も Funnel も使わない。webhook は、社内の GitLab・GitHub Enterprise Server から LAN の中で受ける（D-341）
- 通知：`closed` では Web Push を切る。代わりに画面の中の通知（SSE）と、任意で社内の ntfy に送る（D-342）
- 内部ホストの許可 `network.internal_hosts`：既定は空。`browser` と `terminal` で別に書く。本体・box-manager・tailnet・ホスト自身・クラウドのメタデータは、書いても断る。作動はホストごとに `confirm`（既定、人に聞く）か `auto` を選ぶ（D-343）
- 外に出た通信の台帳 `egress_events`：本体の外向きと egress を全部記録する。残すのは宛先・目的・バイト数・許可/拒否・LLM のトークン数で、中身は残さない（D-344）
- `closed` で全部の役割を社内の `openai_compatible` にすると、外に出る通信が 0 になり、台帳で確かめられる（D-356）
- 持ち主の確かめ：Tailscale・Headscale は今のまま身元のヘッダー。社内 LAN の直結では本体のパスキー（WebAuthn）でログインする。最初の登録は `makase owner-enroll` が出す 1 回限りの URL（D-358）
- egress の記録は egress が溜め、box-manager が毎分取りに行って本体に渡す。本体の外向きは本体の中の窓口 `net` が絞って書く（D-359）。台帳に書けないとき、`closed` は新しい外向きを断り、`standard` は通して欠けを残す（D-360）
- 内部ホストの `confirm`／`auto` はブラウザの作動だけに効く。ターミナルは egress の許可だけ（D-365）。`closed` では `terminal.allow_hosts` も閉域の許可リストの中だけ（D-366）
- 社内の GHES・GitLab のコネクタは次の版。初版はターミナルの `git` で扱う（D-367）

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| 今のまま（Tailscale・Web Push 前提・LAN に届かない） | 作りが単純 | 社内では使えない。大手との違いが「自分で置ける」だけになる | 差別化にならない |
| 閉域専用の別の版を作る | 個人向けを汚さない | 2 つの版を保つのが重い | 設定の切り替えで足りる |
| LAN を全部開ける | 設定が楽 | ページの仕掛けから社内に届く（R-106） | 既定は空・明示の許可にする |

## 影響
- `workspace_policies` に `network` 欄を足す。本体の外向き（LLM・カレンダー・GitHub・Push）も、egress と同じ許可リストと台帳を通す
- 画面 SCR-027 を足す。`closed` のときは「許可リストの外への外向き 0」を大きく出す
- 手順書に、閉域での置き方（Headscale・社内 CA・ntfy・推論サーバー）を足す（11 運用契約）
