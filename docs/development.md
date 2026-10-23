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

画面は http://localhost:5173（`/api` は Node 版の app の 8080 へ中継）。ローカルでは入口のトークンを自動で入れます。ポートは各 `dev` スクリプトが固定します（app 8080・gateway 8082）。

- `pnpm dev` は vite が先に立ち上がり、app が受け付けるまで（`/mnt/c` の上では数十秒）かかる。その間の `/api` は vite が app の起動を待ってから中継するので、画面を早く開いても入れる（待つのは最大 120 秒）。
- `pnpm dev` は Cloudflare 版の Worker（`apps/worker`、8787）も起動するが、画面はまだつながない（下の「Cloudflare の版」）。gcal・github は `GCAL_SHARED_TOKEN`・`GITHUB_SHARED_TOKEN` がないと起動を断るが、画面には要らない。個別に起動するときは `pnpm --filter @open-team/<app|gateway|gcal|github|web> dev`（gcal 8083・github 8084）。

`.env`（`apps/app`・`apps/gateway` の `dev` が `../../.env` を読む）：

| 変数 | 使うもの | 中身 |
|---|---|---|
| `PHASE0_ACCESS_TOKEN` | app | オーナー用の入口のトークン（32文字以上） |
| `SESSION_COOKIE_SECRET` | app | Cookie の署名の鍵（32文字以上） |
| `COOKIE_SECURE` | app | http のローカルでは `false` |
| `DATABASE_URL` | app・gateway | `postgres://postgres:postgres@localhost:5432/open_team` |
| `INTERNAL_SHARED_TOKEN` | app・gateway | サービス間の共有トークン。両方とも同じ値 |
| `GATEWAY_URL` | app | `http://localhost:8082` |
| `GEMINI_API_KEY` | app | Gemini API のキー（[Google AI Studio](https://aistudio.google.com/apikey) で作る）。無ければ Gemini を呼ぶ機能は使えない |
| `DATABASE_URL_MAINT` | app | 任意。掃除（`ot_retention` のロール。24時間より古い入口の試行・冪等性のキー・SSE の事象を消す）に使う DB の接続。あるときだけ毎時の掃除が動く |

- `app` はプロセスの中のタイマーで、毎分の tick（承認の期限切れ・止まったタスクの拾い直しなど）を動かす。
- 環境変数が足りなくても `app` は起動し「準備中」を返す（足りない名前だけログに出る）。`gateway` は足りないと起動しない。
- 止めるとき：`docker compose down`（DB のデータも消すなら `down -v`）。

## LLMを切り替える

Gemini以外を使う場合は `LLM_PROVIDER`、各社のAPIキー、`LLM_MODEL_AGENT`、`LLM_MODELS_JSON` を設定します。[プロバイダー設定](llm-providers.md) に Gemini・Claude・OpenAI 互換の各社（`custom` で任意の接続先も可）の例、能力チェック、料金と検証範囲を記載しています。既存のGemini設定はそのまま使えます。

## テスト

```bash
pnpm typecheck   # 型検査
pnpm test        # 単体テスト（vitest。DB を使う試験は Docker が要る場合がある）
pnpm lint:deps   # 依存の境界（runner から DB・Gemini・gateway に届かない）
```

## Cloudflare の版（移行中）

[cloudflare-design.md](cloudflare-design.md) の段階で、`apps/worker` に Workers の版を作っています。

```bash
pnpm --filter @open-team/worker dev     # wrangler dev（http://localhost:8787）
pnpm --filter @open-team/worker test    # workerd の中で試験（@cloudflare/vitest-plugin）
pnpm --filter @open-team/worker types   # wrangler.jsonc を変えたら型を作り直す
```

ローカルでログインするとき：`apps/worker/.dev.vars.example` を `.dev.vars` にコピーして Google の OAuth クライアントの値と許可するメールアドレスを入れ、
D1 にテーブルを作る（`pnpm --filter @open-team/worker exec wrangler d1 migrations apply makase --local`）。

画面（`apps/web`）はまだ Worker に載せ替えていない。Worker の API は `/api/session`・`/api/auth/google/*` と `/api/v1/` の担当・依頼の一部だけで、画面が使う `GET /api/v1/session`・`POST /api/v1/entry/local`（トークンなしの入口）はない。vite の中継先を 8787 に変えると入れないので、載せ替えまでは 8080 のままにする。
