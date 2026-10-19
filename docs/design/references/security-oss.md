# 参考：セキュリティに使えるライブラリ・OSS
- 版数：2026-10-02 ／ 対象：[11 §8 セキュリティ設計](../11_tech_spec.md#8-セキュリティ設計) の対策を実装するときに使える OSS と管理サービス（各リポジトリ・npm・PyPI で 2026-10-02 に状態を確認）

> **3行で**
> 1. 統制の中心（Kernel・汚染の追跡・ツールのハッシュ固定・intentHash）は、引き続き自前で作る。そのまま置き換えられる OSS は見つからなかった。OSS は「周りの部品」と「テスト」に使う。
> 2. すぐ使えるもの：`web_fetch` は **undici＋ipaddr.js**、本文の抽出は **readability＋linkedom**、画面の Markdown は **react-markdown**（画像は代替テキストにする）、API は **Hono の組み込みミドルウェア**、秘密情報のマスクは **secretlint**、暗号は **Node crypto＋@google-cloud/kms**。
> 3. テストと CI に使うもの：**fast-check**（Kernel の性質のテスト）、**cedar-wasm**（判定の突き合わせ）、**promptfoo**（インジェクションのレッドチーム）、**Snyk Agent Scan**（MCP のツールの検査）、**zizmor・OSV-Scanner・gitleaks・CodeQL**、**3日の待ち期間**（npm ワーム対策）。

## 🧭 判断してほしいこと
| # | 種類 | 論点 | 選択肢 | おすすめ（理由） |
|---|---|---|---|---|
| 1 | ✅決定（[D-48](../decisions.md#d-48)） | Google Cloud Model Armor（プロンプトインジェクションの検知）を、汚染されたタスクの検査に足すか | A：足す（Vertex AI の呼び出しに設定で付けられる）／ B：足さない | **asia-northeast1 で使えるか確かめてから A**。決定論的な統制の代わりではなく「厳しくする方向にだけ使う」追加の層（AI 事前レビューと同じ扱い）。Vertex 連携の対応リージョンの一覧に東京がなく、料金も未確認 |
| 2 | ✅決定（[D-49](../decisions.md#d-49)） | 認証ライブラリ（フェーズ1の GitHub OAuth・パスキー） | A：better-auth＋SimpleWebAuthn ／ B：OAuth を自前で書く | **A（ただし機能を絞る）**。arctic・Lucia は非推奨、Auth.js は保守モードになった。better-auth は 2026-09-29〜30 に critical 1件・high 2件（OAuth Proxy・Magic Link まわり）が出たので、GitHub OAuth 以外のプラグインは入れず、常に最新に保つ |
| 3 | ✅決定（[D-50](../decisions.md#d-50)） | 依存関係の更新の待ち期間 | A：3日待つ（npm は `.npmrc` の `min-release-age=3`、pnpm なら `minimumReleaseAge: 4320`）／ B：待たない | **A**。open-team は npm（15 §サプライチェーン）なので npm の設定で入れる。2025-08〜2026-05 の npm ワーム（Shai-Hulud）は公開から数時間〜数日で見つかっている。正規の provenance つきで出た事例もあり、provenance だけでは足りない |

## 11 §8 の脅威ごとの候補
| 脅威・対策（11 §8） | 使うもの | 判定 | メモ |
|---|---|---|---|
| `web_fetch` の SSRF・DNS リバインディング | **undici**（`Agent({ connect: { lookup } })`）＋ **ipaddr.js**（`range()`） | 採用候補 | 名前解決した IP を検査して、その IP で接続する。リダイレクトは `redirect: 'manual'` にして1回ごとに検証し直す。自前で60行ほど＋テスト。[opendots](opendots.md) の `security.ts`・`transport.ts` と同じ方式。undici は 2026-09 に advisory がまとめて出たので最新版に固定 |
| 同上 | request-filtering-agent | 参考 | 接続時に判定し、IPv6 にも対応。ただし `http.Agent` 用で、Node 組み込みの fetch では使えない。2026-06 にクラッシュの脆弱性（3.2.1 で修正） |
| 同上 | ssrf-req-filter | 不要 | 2024-05 から更新なし |
| 取得した HTML の本文抽出 | **@mozilla/readability**＋**linkedom**、失敗時は **html-to-text** | 採用候補 | jsdom は重いので互換性の問題が出たときだけ |
| Markdown の画像による持ち出し・LLM の出力による XSS | **react-markdown**（＋**rehype-sanitize** を多層防御に） | 採用候補 | 既定で生の HTML を描かない（rehype-raw を入れない）。`components.img` で代替テキストに置き換え、`urlTransform` で http / https / mailto だけにする。リンクに `rel="noopener noreferrer nofollow"`。DOMPurify は生の HTML を扱わないなら不要 |
| フェーズ0の固定トークン・CSRF・ヘッダー | **Hono** の `secure-headers`・`body-limit`・`timingSafeEqual`（`hono/utils/buffer`） | 採用候補 | **注意：Hono の `csrf` はフォーム系の Content-Type のときだけ Origin を確かめる。** JSON API は 11 §8 のとおり Content-Type・Origin・`Sec-Fetch-Site` を自前のミドルウェアで確かめる。Hono も 2026 年に advisory が複数あり、最新版を追う |
| 費用を使い切らせる（フェーズ0-H） | **hono-rate-limiter** | 採用候補 | Cloud Run は複数インスタンスなので、ストアは PostgreSQL か Redis に置く |
| 秘密情報の永続化（BR-32、NFR-057） | **secretlint**（ライブラリとして呼ぶ） | 採用候補 | 保存前のマスクに組み込める。Cloud DLP（`@google-cloud/dlp`）は従量課金で、フェーズ1以降の検討 |
| 鍵の漏えい（ADR-010、D-11） | **Node crypto の AES-256-GCM**＋**@google-cloud/kms** | 採用候補 | IV は毎回96bit の乱数、AAD に行 ID とテーブル名を入れる（別の行への付け替えを防ぐ）。Tink の JS 版は Google が保守をやめた |
| MCP のツールの説明の書き換え（BR-42） | 自前のハッシュ固定を続ける。答え合わせに **mcp-context-protector**（Trail of Bits） | 参考 | 初回に信頼してサーバーの設定を固定する方式（TOFU）。rug pull・line jumping への対策が open-team の設計と同じ方向 |
| 同上（登録前の検査） | **Snyk Agent Scan**（旧 Invariant mcp-scan） | 採用候補（CI・手元） | Python（uvx）。出力の形式が実験的なので本番の判定には組み込まない。カタログに入れる MCP サーバーの事前検査に使う |
| 外部の内容による乗っ取り（ADR-024） | 自前の汚染の追跡を続ける。設計の参考に **CaMeL**（Google DeepMind） | 参考（設計） | 計画する LLM とデータを読む LLM を分け、値ごとに出どころ（capability）を持たせる。open-team のタスク単位の `tainted` を値単位に細かくする方向の参考。コードは研究用で保守されない |
| 同上（追加の検知層） | Google Cloud Model Armor | 条件つき採用（[D-48](../decisions.md#d-48)） | 東京で使えることを確かめてから |

<details>
<summary>テスト・CI・サプライチェーン</summary>

| 用途 | 使うもの | 判定 | メモ |
|---|---|---|---|
| Kernel の性質のテスト（NFR-056、Q-93） | **fast-check** | 採用候補 | 「`compose()` は緩めない」「`tainted` なら `mcp_write` は承認かルール」「`classify()` が `neutral` なら権限の集合は増えない」などをプロパティで書く |
| 判定の突き合わせ（差分テスト） | **@cedar-policy/cedar-wasm** | 採用候補（テスト用） | Kernel は自前のまま（ADR-009）。同じポリシーを Cedar でも書き、ランダムな入力で判定が一致するかを見るテストの基準にする |
| プロンプトインジェクションのレッドチーム | **promptfoo** | 採用候補 | TypeScript で CI に入る。Gemini・MCP を対象にできる。2026-03 に OpenAI が買収を発表（OSS・MIT は維持と明言） |
| 評価シナリオの出典 | AgentDojo、garak、PyRIT | 参考 | どれも Python。AgentDojo の間接インジェクションのシナリオを promptfoo のテストに写す |
| MCP のデバッグ | **MCP Inspector** | 採用候補（開発用） | gateway と MCP サーバーの動作確認 |
| 依存関係の脆弱性 | **OSV-Scanner** | 採用候補 | — |
| GitHub Actions の設定不備 | **zizmor** | 採用候補 | `pull_request_target` の誤用などを拾う。2026-03 の Trivy の侵害はまさにこの穴からだった |
| 静的解析 | **CodeQL** | 採用候補 | 公開リポジトリなら無料。Semgrep CE・Opengrep は CodeQL があれば必須ではない |
| 秘密情報のコミット | **gitleaks** | 採用候補 | CI とコミット前のフック。trufflehog は AGPL |
| npm ワーム対策 | **`min-release-age=3`**（npm 11.10 以降）、lockfile＋`npm ci`、install スクリプトの無効化 | 採用（[D-50](../decisions.md#d-50)） | pnpm に移るなら `minimumReleaseAge: 4320` と `trustPolicy: no-downgrade` |
| 依存関係の更新 | Renovate か Dependabot（どちらか一方） | 採用候補 | 待ち期間を設定する |
| Actions 全般 | action を commit SHA で固定、`permissions` を最小に | 採用候補 | Trivy の事件では action のタグ 76個のうち 75個が書き換えられた |
| コンテナの検査 | Trivy | 参考 | 本体は活発だが 2026-03 に侵害された。使うなら SHA で固定 |

</details>

<details>
<summary>採らないもの（理由つき）</summary>

| 名前 | 採らない理由 |
|---|---|
| ProtectAI LLM Guard、Rebuff | アーカイブ済み |
| NeMo Guardrails、LlamaFirewall、Invariant Guardrails | Python のサイドカーが要り、Kernel と役割が重なる。LlamaFirewall の PyPI 版は 2025-05 で止まっている。Invariant のフローのルールは汚染のルールの書き方の参考にとどめる |
| Llama Prompt Guard 2 | 対象言語に日本語が入っていない |
| OPA | Go のサイドカーが要る。突き合わせには cedar-wasm のほうが軽い |
| Docker MCP Gateway、agentgateway、IBM ContextForge、Microsoft mcp-gateway | gateway は自前（ADR-016・022）。agentgateway（CEL による RBAC）は比較の対象として見るだけ |
| arctic・@oslojs、Lucia、Auth.js | 非推奨か保守モード |
| detect-secrets、ssrf-req-filter、Tink の JS 版 | 更新が止まっている |

</details>

## 確かめられなかったこと
- Model Armor の asia-northeast1 対応・GA かどうか・料金。
- promptfoo の買収が完了したか。
- 保守されている TypeScript ネイティブのインジェクション検知ライブラリ（Rebuff の後継）は見つからなかった。
- Renovate・Dependabot の待ち期間の設定名、Socket の無料枠。
