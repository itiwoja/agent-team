# 開発

## 前提

Node 22.18 以上、pnpm 10（`corepack enable`）、Docker。

## ローカルでの起動

```bash
pnpm install --frozen-lockfile
cp .env.example .env     # 下の表を埋める（openssl rand -base64 32 で作る）
docker compose up -d db  # PostgreSQL 16（127.0.0.1:5432）
DATABASE_URL=postgres://postgres:postgres@localhost:5432/open_team pnpm --filter @open-team/db migrate
pnpm dev
```

画面は http://localhost:5173（`/api` は 8080 へ中継）。ローカルでは入口のトークンを自動で入れます。ポートは各 `dev` スクリプトが固定します（app 8080・sim-world 8081・gateway 8082）。個別に起動するときは `pnpm --filter @open-team/<app|sim-world|gateway|gcal|github|web> dev`（gcal 8083・github 8084）。

`.env`（`apps/app`・`apps/gateway` の `dev` が `../../.env` を読む）：

| 変数 | 使うもの | 中身 |
|---|---|---|
| `PHASE0_ACCESS_TOKEN` | app | オーナー用の入口のトークン（32文字以上） |
| `GUEST_ENTRY_TOKEN` | app | ゲスト用の入口のトークン（オーナー用と別の値。任意） |
| `SESSION_COOKIE_SECRET` | app | Cookie の署名の鍵（32文字以上） |
| `COOKIE_SECURE` | app | http のローカルでは `false` |
| `DATABASE_URL` | app・gateway・sim-world | `postgres://postgres:postgres@localhost:5432/open_team` |
| `INTERNAL_SHARED_TOKEN` | app・gateway・sim-world | サービス間の共有トークン。3つとも同じ値 |
| `SIM_WORLD_SHARED_TOKEN` | gateway | `INTERNAL_SHARED_TOKEN` と同じ値 |
| `SIM_WORLD_URL`・`GATEWAY_URL` | app（gateway は `SIM_WORLD_URL`） | `http://localhost:8081`・`http://localhost:8082` |
| `GEMINI_API_KEY` | app | Gemini API のキー（[Google AI Studio](https://aistudio.google.com/apikey) で作る）。無ければ Gemini を呼ぶ機能は使えない |
| `DATABASE_URL_MAINT` | app | 任意。ゲストの掃除（`ot_retention` のロール）に使う DB の接続。あるときだけ毎時の掃除が動く |

- `app` はプロセスの中のタイマーで、毎分の tick（承認の期限切れ・止まったタスクの拾い直しなど）を動かす。
- 環境変数が足りなくても `app` は起動し「準備中」を返す（足りない名前だけログに出る）。`gateway`・`sim-world` は足りないと起動しない。
- 止めるとき：`docker compose down`（DB のデータも消すなら `down -v`）。

## LLMを切り替える

Gemini以外を使う場合は `LLM_PROVIDER`、各社のAPIキー、`LLM_MODEL_AGENT`、`LLM_MODELS_JSON` を設定します。[プロバイダー設定](llm-providers.md) にClaude・OpenAI・OpenAI互換APIの例、能力チェック、料金と検証範囲を記載しています。既存のGemini設定はそのまま使えます。

## テスト

```bash
pnpm typecheck   # 型検査
pnpm test        # 単体テスト（vitest。DB を使う試験は Docker が要る場合がある）
pnpm lint:deps   # 依存の境界（runner から DB・Gemini・gateway に届かない）
```

## 計測

```bash
# 配管の確認（ネットワーク不要。偽のエージェント）
pnpm measure -- --llm scripted --runs 1

# 統制なしの本物の Gemini が悪い日に引っかかる率
GEMINI_API_KEY=<キー> pnpm measure -- --llm gemini --runs 5 --out results

# 統制ありの計測（apps/app で。環境変数はファイルの先頭を参照）
MEASURE_GOVERNED=1 GEMINI_API_KEY=<キー> npx vitest run src/measure-governed/measure.test.ts
```

条件・数え方・費用の上限は [scripts/measure/README.md](../scripts/measure/README.md)、結果は [measurements/](measurements/)。
