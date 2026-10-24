# Makase（agent-team）

**一言頼むと、AI エージェントのチームが生まれて仕事を片付ける。書き込みは必ずあなたが確認する。**

ライセンス：AGPL-3.0（[LICENSE](LICENSE)）。自分のサーバーで動かすのは自由です。改変してサービスとして提供する場合はソースの公開が必要です。

Makase は、依頼文から Gemini がエージェントの担当（チーム）を作り、手分けして仕事を進めるシステムです。エージェントが「書き込み」（予定を入れる・発注する・PR を出すなど）をするときは、AI ではなく決まったルールで動くプログラム（Kernel）が「通す・人に聞く・止める」を判定します。使うほど育つ点も特徴で、繰り返しの仕事はスキルの案として届き、使われなくなったスキルやルールは自動で外して、戻せるようにしています。

## たとえば

> 「この勉強会のページを読んで、日程をカレンダーに入れて」

1. 入口に一言書く
2. 「ページを読む係」と「カレンダー係」が生まれ、順番に動く
3. 「10/20（火）19:00〜21:00　〇〇勉強会」という予定のカードが届く
4. ○ を押すと、Google カレンダーの Makase 専用のカレンダーに予定が入る（5秒以内なら取り消せる）

似た依頼をもう一度頼むと、ふつうは新しく作らずに同じ担当（「いつもの担当」）が引き受けます。

## しくみ

```mermaid
flowchart LR
  U(["ユーザー"]) --> APP["app<br/>画面・API・エージェントの実行"]
  APP -->|"推論・担当の生成"| G[["Gemini"]]
  APP -->|"書き込みを許すか"| K["Kernel<br/>決定論のルール"]
  APP -->|"書き込みはここだけ"| GW["gateway"]
  GW --> EXT["Google カレンダー<br/>GitHub"]
  APP --- DB[("PostgreSQL<br/>状態・監査ログ")]
```

| 守り | 内容 |
|---|---|
| 書く前に聞く | 書き込みは Kernel が判定し、既定では人の ○ を待つ。Gemini は判定に関わらない |
| 出口を1つにする | 書き込みは `gateway` だけが行う。エージェントの実行部分（`runner`）は DB・Gemini・gateway に直接届かない（CI で検査） |
| 権限を最小にする | カレンダーは専用カレンダーと空き時間だけ。GitHub は `main` を既定で保護 |
| 育ち方も人が決める | 繰り返しから作ったスキルは、○ を押すまで使われない。信頼は承認した中身と一致するものだけ |

詳しくは [docs/](docs/) を見てください。

| 文書 | 内容 |
|---|---|
| [docs/overview.md](docs/overview.md) | 何ができるか・用語 |
| [docs/architecture.md](docs/architecture.md) | サービス構成・信頼の境界 |
| [docs/safety.md](docs/safety.md) | 統制（Kernel）の仕組み |
| [docs/development.md](docs/development.md) | ローカルでの起動・テスト |
| [docs/ui-design.md](docs/ui-design.md) | 画面の設計（言葉・並び・たたみ方の決まり） |

## 技術

LLMはGemini（既定）、Claude、OpenAI、DeepSeek、OpenRouter、xAI、Groq、Mistral など主要な提供元に加え、OpenAI互換のAPIなら接続先を指定して（`custom`）どのAPIキーでも使えます。担当編成・受け渡し・承認Kernelは共通です。必要なモデル能力と料金を明示し、未対応モデルや料金不明のままでは実行しません。設定方法と対応範囲は [LLMプロバイダーの設定](docs/llm-providers.md) を参照してください。実モデルごとの品質・API動作の確認は必要です。

TypeScript（pnpm のモノレポ）・Hono・React＋Vite（PWA）・PostgreSQL 16（Docker）・MCP・Gemini API。手元の PC だけで動き、クラウドの環境は要りません。

## すぐ試す

```bash
pnpm install --frozen-lockfile
cp .env.example .env      # 値の埋め方は docs/development.md（Gemini を使うなら GEMINI_API_KEY）
docker compose up -d db
DATABASE_URL=postgres://postgres:postgres@localhost:5432/open_team pnpm --filter @open-team/db migrate
pnpm dev                  # http://localhost:5173
```

パッケージ名（`@open-team/*`）は、開発時の名前のままです。
