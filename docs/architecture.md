# 構成

手元の PC で、役割ごとに別のプロセスとして動かします（`pnpm dev`）。DB は Docker の PostgreSQL です。画面から届くのは `app` だけで、書き込みは必ず `gateway` を通ります。

```mermaid
flowchart TB
  U(["ブラウザ（PWA）<br/>localhost:5173"]) -->|"入口のトークン＋セッション"| API

  subgraph LOCAL["ローカル"]
    subgraph APP["app :8080"]
      direction TB
      API["API・画面の配信"] --> RUN["runner：エージェントの実行枠"]
      RUN --> EDGE["edge：LLM Proxy・ツールの窓口<br/>Kernel の判定・費用の上限"]
      TIMER["タイマー<br/>毎分の tick・毎時の掃除"] --> API
    end
    EDGE -->|"タスクのトークンつき"| GW["gateway :8082<br/>書き込みの唯一の出口"]
    GW --> SIM["sim-world :8081<br/>模擬の世界"]
    GW --> GCAL["gcal :8083<br/>カレンダーのアダプター"]
    GW --> GH["github :8084<br/>GitHub のアダプター"]
    API -->|"コンテナを起こす"| SBX["sandbox（Docker）<br/>作業場"]
    SBX -->|"作業場だけのトークン"| EDGE
    API --> SQL[("PostgreSQL 16<br/>docker compose")]
    GW --> SQL
    SIM --> SQL
  end

  EDGE --> GEM[["Gemini API<br/>GEMINI_API_KEY"]]
  EDGE -->|"web_fetch：許可したドメインだけ"| WEB(["公開の Web ページ"])
  GCAL --> GAPI(["Google カレンダー API"])
  GH --> GHAPI(["GitHub API"])
```

`gcal`・`github`・`sandbox` は使うときだけ起動します。

## サービス

| サービス | 役割 |
|---|---|
| `app` | API・セッション・画面の配信・エージェントの実行・安全チェックの進行・Kill Switch。毎分の tick（承認の期限切れ・止まったタスクの拾い直しなど）と毎時のゲストの掃除をプロセスの中のタイマーで動かす |
| `gateway` | 書き込みの唯一の出口。`workspace_id` はリクエストではなくタスクのトークンから引き直す。コネクタの資格情報を使えるのはここだけ |
| `sim-world` | 模擬の世界（仕入れ係の店舗）を MCP で出す。損害額の式もここにある |
| `gcal`・`github` | 実の外部サービスのアダプター。DB も秘密も持たず、gateway が付けたトークンでその1回だけ API を呼ぶ |
| `sandbox` | 作業場。Docker のコンテナで、権限のない利用者としてコマンドを動かす |

## 信頼の境界

- **サービス間は共有トークンで確かめる**。呼ぶ側は `INTERNAL_SHARED_TOKEN` と呼び出し元の名前（`x-ot-caller`）を付け、受ける側は決まった呼び出し元しか通さない。
- **`runner` は外に直接届かない**。DB・Gemini・gateway のクライアントを import しないことを `pnpm lint:deps`（dependency-cruiser）で CI が検査する。LLM とツールには `edge` の関数を通してしか届かない。
- **秘密は DB に平文で置かない**。Google カレンダーの refresh token は暗号化して保存し、使うのは gateway だけ。GitHub は App の秘密鍵を持つ gateway が、そのつどインストールのトークンを作る。
- **ログに秘密を出さない**。`GEMINI_API_KEY` などの秘密の値はログでマスクする。

## CI

[`ci.yml`](../.github/workflows/ci.yml)：`main` への push と PR で、型・テスト・依存の境界・Dockerfile の digest の固定・zizmor・gitleaks を流します。

## パッケージ

| パス | 役割 |
|---|---|
| `apps/web` | 画面（React＋Vite の PWA） |
| `apps/app`・`apps/gateway`・`apps/sim-world`・`apps/gcal`・`apps/github`・`apps/sandbox` | 上のサービス |
| `packages/kernel` | 統制の中心。ポリシーの合成・判定・Intent の正規化（純粋関数だけ） |
| `packages/oracles` | 試験の合否（O-01〜O-08。決定論） |
| `packages/rehearsal` | 安全チェックのロジック（障害カタログ・締める提案・合格証・回帰） |
| `packages/runner` | エージェントの実行枠・プロンプトの組み立て |
| `packages/edge` | runner の唯一の出口（LLM Proxy・ツールの実行・費用の上限） |
| `packages/llm` | Gemini の呼び出しと価格表 |
| `packages/db` | PostgreSQL の接続・マイグレーション・監査ログ |
| `packages/platform` | 環境変数・ログ・サービス間の認証などの共通部分 |
| `packages/sim-core` | 模擬の世界の枠組み（時計・乱数は仮想） |
| `packages/gcal-core`・`packages/github-core` | コネクタのツール定義（アダプター・gateway・app で共有） |
| `packages/sandbox` | 作業場の実行役とのやりとり |
| `packages/gateway-client`・`packages/sim-client` | app から gateway・sim-world を呼ぶクライアント |
| `scripts/measure` | 統制なしのエージェントの引っかかり率の計測 |
