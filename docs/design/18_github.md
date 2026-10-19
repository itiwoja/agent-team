# 18 GitHub（本人のリポジトリで開発を任せる）

2026-10-15 起草。決定は [D-119](decisions.md#d-119)。この文書が実装の正本。形は [16 Google カレンダー](16_google_calendar.md) と同じ（本人がつなぐ OAuth のコネクタ・状態を持たないアダプター・gateway だけが資格情報を使う）。

## 1. 目的

エンジニアパック・開発系の担当に、**本人の GitHub のリポジトリを読ませ、新しいブランチに変更を積み、PR を出す**ところまで任せる。

- 例：「GitHub の owner/app の README の誤字を直して PR を出して」→ 担当（`assistant`、github の付与つき）が読む → `makase/…` のブランチに `push_commit`（○）→ `create_pull_request`（○）→ `get_ci_status` で CI を見て報告。
- `main`（既定のブランチ）は既定で守る。利用者がメニューで許したときだけ直接書ける（それでも書き込みは毎回 ○）。

## 2. 守り

1. **GitHub App**：利用者が GitHub の画面でインストールし、任せるリポジトリを選ぶ（GitHub 側で範囲が決まる）。権限は Contents（Read & write）・Pull requests（Read & write）・Issues（Read）・Checks（Read）・Commit statuses（Read）・Metadata（Read）。
2. **鍵は gateway だけ**（ADR-002）：App の秘密鍵で JWT（RS256、9分）を作り、インストールのトークン（1時間）を発行する。トークンはメモリに `expires_at − 60秒` までキャッシュし、DB には置かない。
3. **DB に秘密なし**：`connector_credentials`（provider = github）は `installation_id`・`account_login`・`subject`（GitHub の利用者 ID）・`allow_protected_write` だけ（migration `0019`）。
4. **本人の確認**：つなぐときの戻りの `code` で利用者のトークンを得て、`GET /user`・`GET /user/installations` で「そのインストールを本人が使える」ことを確かめる。URL の `installation_id` は、本人が使えるものの中にあるときだけ使う。利用者のトークンは確かめたら取り消す（保存しない）。
5. **保護したブランチ**：既定のブランチ・`main`・`master` への `push_commit` は、`allow_protected_write` が true のときだけアダプターが通す。値は実行のときに gateway が行から読む（切り替えたらすぐ効く）。承認の画面は `main`・`master` への書き込みを一文で目立たせる。再接続では false に戻る。
6. **書き込みは全部 ○**：`push_commit`・`create_pull_request` は write（`mcp_write: approve`）。強制の push・ブランチの削除・マージ・リリースはツールに無い（01 §Won't の「PR 以外の書き込み」は、PR のための作業ブランチへのコミットだけ足す）。
7. **二重にしない**：`push_commit` はコミットの本文の末尾に `Makase-Intent: <intentId>` を入れ、再送で先頭が同じ印なら成功として返す。ref の更新は早送りだけ。`create_pull_request` は同じ head・base の開いた PR があればそれを返す。
8. **Intent の pin**：Intent を作ったあとに再接続したら実行しない（`credential_changed` → `auth_required`）。アンインストール（404）・一時停止（403）も `auth_required`。
9. **影・リハーサル**：模擬の GitHub はないので、境界の規則3・4 で拒否される。ゲストは本人の GitHub を通す（`isOwnConnector`）。
10. **汚染**：GitHub から読んだ内容は `mcp_read` で汚染する。汚染のあとは作業場のコマンドを動かせない（SG-07）ので、確かめは PR の CI（`get_ci_status`）で行う。

## 3. 約束

### 3.1 `@open-team/github-core`

`GITHUB_SLUG = "github"`、`GITHUB_MCP_PATH = "/mcp/github"`、`GITHUB_HEADER = { token: "x-ot-github-token", allowProtectedWrite: "x-ot-github-allow-protected-write", idempotencyKey: "x-ot-idempotency-key" }`、`isProtectedBranch`・`isValidBranchName`・`intentTrailerOf`。

| ツール | 分類 | 入力 | argRoles |
|---|---|---|---|
| `list_repos` | read | なし | — |
| `list_files` | read | `repo`、`ref?`、`path?` | — |
| `read_file` | read | `repo`、`path`、`ref?`（テキストだけ・10万字まで） | — |
| `list_issues` | read | `repo`、`state?`、`label?`（PR は除く・本文2000字まで） | — |
| `get_ci_status` | read | `repo`、`ref` | — |
| `push_commit` | write | `repo`、`branch`、`base?`、`message`、`files[]{path, content}`（50件・1件20万字）、`delete_paths[]` | repo・branch・delete_paths = destination、message・files = content、base = option |
| `create_pull_request` | write | `repo`、`head`、`base?`、`title`、`body?`、`draft?` | repo・base = destination、title・body = content、head・draft = option |

### 3.2 アダプター `apps/github`

`POST /mcp/github`（MCP Streamable HTTP、状態なし）。呼べるのは sa-gateway だけ（cloud は ID トークン aud = `GITHUB_URL`、local は `GITHUB_SHARED_TOKEN`）。`tools/call` はトークンの頭が要る（無ければ 401。`push_commit` は冪等キーも）。GitHub の 401 → 401、429・5xx・レート制限の 403 → 同じ状態コード、それ以外の 4xx はツールのエラー。

### 3.3 DB（migration `0019_github_credentials.sql`）

provider の CHECK を `google`・`github` に広げ、provider ごとに必須の列を分ける。`ot_app` は `installation_id`・`account_login`・`allow_protected_write` を読み、`allow_protected_write` だけ更新できる。

### 3.5 gateway

env：`GITHUB_URL`（任意）。あれば `GITHUB_APP_ID`・`GITHUB_APP_PRIVATE_KEY`（PEM。`\n` で書いたものも可）、local は `GITHUB_SHARED_TOKEN`、`GITHUB_API_BASE`（既定 `https://api.github.com`）。cloud の `ALLOWED_CONNECTOR_URLS` に `GITHUB_URL` の origin を許す。

### 3.6 app

env：`GITHUB_APP_CLIENT_ID`・`GITHUB_APP_CLIENT_SECRET`・`GITHUB_APP_SLUG`・`GITHUB_URL`・`APP_BASE_URL`（どれか無ければ「つなぐ」を出さない。`GITHUB_WEB_BASE`・`GITHUB_API_BASE` は差し替え用）。

- `GET /api/v1/connect/github/start?mode=install|authorize`、`GET /api/v1/connect/github/callback`、`DELETE /api/v1/connect/github`、`PUT /api/v1/connect/github/protected-write {allow}`（監査 `connector.github.protected_write_changed`）。
- 失敗は `/?connect_error=github_denied|github_not_installed|github_failed|github_state|github_unavailable`、成功は `/?connected=github`。
- workspace view に `github: { available, connected, login, allowProtectedWrite, settingsUrl }`。依頼の文の判定（`needsConnection`）に `github`。

### 3.7 画面

メニューに「GitHub をつなぐ」／つないだアカウント・「main への直接の書き込みを許可」（オンにするときは確かめる）・「任せるリポジトリを GitHub で選ぶ」・「GitHub を切断」。確認の行に GitHub のカード（リポジトリ・ブランチ・書く／消すファイル・main への直接の書き込みの一文）。

## 4. 編成

設定プランナーは、github がつながっているときだけリポジトリの依頼に github を使う。付与を持つ担当がいれば使い回し、いなければ新しい担当（直す担当は `assistant`、読むだけは `researcher`）を作る。パックの担当（`dev-coder`・`reviewer`）は作業場の中だけなので、権限は広げない。直す担当の指示には、`makase/` のブランチに積んで PR を出すこと・既定のブランチに直接積まないこと・PR のあとで CI を確かめることを書く。

## 5. 準備（本番）

1. GitHub の Settings → Developer settings → GitHub Apps → New GitHub App。Callback URL と Setup URL は `<APP_BASE_URL>/api/v1/connect/github/callback`、「Request user authorization (OAuth) during installation」をオン、Webhook はオフ。権限は §2-1。
2. 秘密鍵（.pem）を作り、`PROJECT_ID=… bash infra/github-setup.sh` のあと、`github-app-private-key` と `github-app-client-secret` に値を入れる。
3. リポジトリの変数に `GH_APP_ID`・`GH_APP_CLIENT_ID`・`GH_APP_SLUG` と `DEPLOY_GITHUB=true`。

ローカルは `.env.example` の GitHub の行を埋め、`pnpm --filter @open-team/github dev` でアダプターを起動する。

## 6. まだやらないこと

模擬の GitHub（リハーサル）、Webhook（イシューのラベルで動かす）、作業場へのリポジトリの持ち込み（tarball。10MB の控えの上限の見直しが要る）、汚染のあとに作業場でテストを動かすこと。
