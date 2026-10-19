# infra：GCP の初期設定とデプロイの流れ（フェーズ0-H）

> **3行で**
> 1. GCP のプロジェクトを作ったら、[`gcp-setup.sh`](gcp-setup.sh) を1回だけ流す（API・Artifact Registry・SA と最小のロール・Workload Identity 連携・Secret Manager・Cloud SQL・Cloud NAT・予算アラート）。何度流しても同じ状態になり、消す操作はしない。
> 2. 最後に出る値を GitHub のリポジトリの変数に入れると、`main` への push で [`deploy.yml`](../.github/workflows/deploy.yml) が CI → イメージ → Cloud Run（`app`。`sim-world` は `DEPLOY_SIM_WORLD=true` にしてから）まで流す。変数が入るまではデプロイを飛ばして CI だけ走る。
> 3. デプロイは「イメージ → マイグレーション（Cloud Run Job）→ 各サービス → スモークテスト」。スモークテストが落ちたら前のリビジョンに自動で戻す（[§4.3](#43-ロールバック)）。DB は毎日自動でバックアップを取る（[§3 の補足](#cloud-sql-の補足)）。
> 4. 鍵ファイルは作らない。GitHub から GCP に入れるのは「このリポジトリの `main` への push」だけ（PR・手動実行・ほかのブランチは通らない）。

出典：`docs/design/15_hackathon.md` §構成・§公開時のセキュリティ、D-50〜52。

## 1. 流し方

前提：プロジェクトの Owner、請求先アカウントの管理者（予算を作るため）。Cloud Shell なら gcloud が入っている。

```bash
PROJECT_ID=<プロジェクト ID> \
GITHUB_REPO=<owner>/<repo> \
BILLING_ACCOUNT=<XXXXXX-XXXXXX-XXXXXX> \
bash infra/gcp-setup.sh
```

| 変数 | 必須 | 既定 | 中身 |
|---|---|---|---|
| `PROJECT_ID` | ○ | — | 作成済みのプロジェクト |
| `REGION` | | `asia-northeast1` | Cloud Run・Artifact Registry・Secret Manager の場所 |
| `GITHUB_REPO` | ○ | — | `owner/repo`。大文字・小文字も GitHub の表示どおり（OIDC のトークンの値と比べる） |
| `BILLING_ACCOUNT` | ○ | — | `gcloud billing accounts list` で見られる ID |
| `AR_REPOSITORY` | | `open-team` | Artifact Registry のリポジトリ名 |
| `GITHUB_REPO_ID` | | — | リポジトリの数値の ID（`gh api repos/<owner>/<repo> --jq .id`）。入れると WIF の条件に足す（名前の付け替えへの備え） |
| `BUDGET_AMOUNT` | | `100USD` | 予算（通貨つき）。30%・100% で通知。請求先の通貨が USD でなければ `15000JPY` のように入れる |
| `SQL_INSTANCE`・`SQL_TIER`・`SQL_ZONE` | | `open-team-db`・`db-f1-micro`・`<REGION>-a` | Cloud SQL の名前・マシン・ゾーン。**インスタンスがなければ作るときだけ効く**（作成済みなら変えない） |
| `ROTATE_MIGRATOR_PASSWORD` | | `0` | `1` で `ot_migrator` のパスワードを決め直し、`database-url-migrator` に新しい版を足す（既定は、有効な版がなければ入れるだけ） |
| `BUDGET_START`・`BUDGET_END` | | `2026-10-01`・`2026-12-31` | 予算の期間（ハッカソンの間を通しで数える） |

終わると、GitHub に入れる値（`gh variable set …` の形も）が出る。

## 2. GitHub に入れるもの（Settings → Secrets and variables → Actions → **Variables**）

秘密ではないので Variables に入れる（Secrets は使わない）。

| 変数 | 例 | 使うところ |
|---|---|---|
| `GCP_PROJECT_ID` | `open-team-hackathon` | 必須。プロジェクト |
| `GCP_REGION` | `asia-northeast1` | 必須。デプロイ先・イメージの置き場 |
| `WIF_PROVIDER` | `projects/123…/locations/global/workloadIdentityPools/github/providers/github-main` | 必須。google-github-actions/auth |
| `DEPLOYER_SA` | `sa-deployer@<project>.iam.gserviceaccount.com` | 必須。デプロイの SA |
| `AR_REPOSITORY` | `open-team` | 任意（既定 `open-team`） |
| `GCP_PROJECT_NUMBER` | `123…` | `sim-world` を出すときに必須（`SIM_WORLD_URL` = `https://sim-world-<番号>.<リージョン>.run.app` を組む） |
| `DEPLOY_SANDBOX` | `true` | 作業場（サンドボックス：コードを書いて動かす担当。D-116）を出すときだけ入れる。先に「9. 作業場」の準備と確かめをする。入れない間、app は `SANDBOX_PROVIDER=none` で動く |
| `DEPLOY_SIM_WORLD` | `true` | `sim-world` を出すときだけ入れる。今の `sim-world` は public では起動しない（ID トークンの検証と Postgres の保存が入るまで）ので、それまでは入れない |

必須の4つがそろうまで、`deploy.yml` のデプロイのジョブは飛ばされる（CI だけ走る）。

## 3. 作られるもの

| 種類 | 名前 | 中身 |
|---|---|---|
| API | Cloud Run・Artifact Registry・IAM・IAM Credentials・STS・Secret Manager・Vertex AI・Resource Manager・Cloud Billing・Billing Budgets・Cloud SQL Admin（`sqladmin`）・Compute Engine | — |
| Artifact Registry | `<REGION>/open-team`（docker） | `app`・`sim-world` のイメージ。タグはコミット SHA、デプロイは digest で指す |
| SA | `sa-app` | `roles/aiplatform.user`（Gemini を呼べるのはこれだけ：D-52）、`roles/cloudsql.client`、app の秘密だけの `secretAccessor` |
| SA | `sa-gateway` | `roles/cloudsql.client`、`database-url-gateway` の `secretAccessor`（Vertex AI・実のコネクタの認証情報はなし） |
| SA | `sa-sim` | `roles/cloudsql.client`、`database-url-sim` の `secretAccessor` |
| SA | `sa-migrator` | `roles/cloudsql.client`、`database-url-migrator` の `secretAccessor`（この秘密を読めるのはこの SA だけ）。マイグレーションの Cloud Run Job `migrate` だけが使う |
| SA | `sa-deployer` | `roles/run.admin`（Job の作成・実行を含む）、`roles/compute.networkUser`（Direct VPC egress 付きのデプロイ）、`open-team` リポジトリだけの `artifactregistry.writer`、3つの実行の SA と `sa-migrator` の `serviceAccountUser`、**`guest-entry-token` だけ**の `secretAccessor`（スモークテストが入口のトークンを読む）、GitHub からの `workloadIdentityUser` |
| WIF | プール `github`・プロバイダー `github-main` | 条件：`attribute.repository == '<owner>/<repo>' && attribute.ref == 'refs/heads/main' && attribute.event_name == 'push'`（＋`repository_id`） |
| Secret Manager | `phase0-access-token`・`guest-entry-token`・`session-cookie-secret` | 最初に乱数（英数字48文字）を入れる。2つのトークンは別の値 |
| Secret Manager | `database-url-migrator` | `ot_migrator` の接続文字列（形式は下の Cloud SQL の補足）。`gcp-setup.sh` が `ot_migrator` のパスワードを乱数で決め直して入れる（画面・ログに出さない） |
| Secret Manager | `database-url-app`・`database-url-maint`・`database-url-gateway`・`database-url-sim` | 接続文字列（下の Cloud SQL の行。`ot_app`・`ot_retention`・`ot_gateway`・`ot_sim` の順）。版がなければ入れ、あれば触らない |
| Cloud SQL | `open-team-db` | PostgreSQL 16・`db-f1-micro`（ENTERPRISE）・HDD 10GB・ゾーン1つ・**自動バックアップ（毎日 19:00 UTC = JST 4:00、7世代）・削除保護**・公開 IP。DB `openteam`、ユーザー `ot_migrator`・`ot_app`・`ot_retention`・`ot_gateway`・`ot_sim` |
| ネットワーク | サブネット `default`、ルーター `open-team-router`、NAT `open-team-nat` | 限定公開の Google アクセスを有効にし、Cloud NAT（自動 IP・全サブネット）を置く。Cloud Run の Direct VPC egress（`all-traffic`）で Cloud SQL の公開 IP に出るのに要る |
| 予算 | `open-team-hackathon` | `100USD`・30%・100% で通知（= $30・$100）。クーポンを引かずに数える。届くのは請求先アカウントの管理者のメール。**通知だけで課金は止まらない** |

使わないもの：既定の Compute Engine の SA、SA の鍵ファイル、LLM の API キー、実のコネクタの認証情報（BR-66）。

Cloud Run の呼び出し元（`run.invoker`）は `deploy.yml` がサービスごとに付ける：`app` は `allUsers`（入口のトークンとセッションで守る）、`sim-world` は `sa-gateway`・`sa-app` だけで Ingress は内部のみ。

### Cloud SQL の補足

- パスワードは乱数（英数字32文字）で決め、画面にもログにも出さない。`ot_app`・`ot_retention`・`ot_gateway`・`ot_sim` は決めた時点で接続文字列を秘密に入れる（形式 `postgres://<ユーザー>:<パスワード>@localhost/openteam?host=/cloudsql/<プロジェクト>:<リージョン>:open-team-db`。Cloud Run が `--set-cloudsql-instances` の unix ソケットで繋ぐ）。
- 秘密に有効な版があれば何もしない（流し直しでパスワードが変わって、動いている Cloud Run が切れるのを防ぐ）。値を作り直したいときは、新しい版を足すか、`gcloud sql users set-password` で変えて秘密も合わせる。
- `ot_migrator` のパスワードは `gcp-setup.sh` が乱数（英数字32文字）で決め直し、接続文字列を秘密 `database-url-migrator` に入れる（形式は上と同じ：`postgres://ot_migrator:<パスワード>@localhost/openteam?host=/cloudsql/<プロジェクト>:<リージョン>:open-team-db`）。パスワード単体はどこにも保存しない（秘密の中の接続文字列だけ）。使うのはマイグレーションの Job だけなので、決め直しても動いているサービスは切れない。決め直したいときは `ROTATE_MIGRATOR_PASSWORD=1` で流し直す（D-102）。ローカルから `ot_migrator` で繋ぐときは、下の手順の前に自分でパスワードを決め直して控える。
- インスタンスは作成済みなら設定を変えない（`db-f1-micro` を変えるときは `SQL_TIER`。新規作成のときだけ効く）。新規作成のときは `--backup-start-time=19:00 --retained-backups-count=7 --deletion-protection` を付ける。
- 自動バックアップは**インスタンス丸ごと**の毎日1回（7世代まで）。`db-f1-micro` は共有コアなので、取っている間は少し重くなりうる（JST 4:00 は審査員が使わない時間）。復元は §4.3 の「DB を戻す」。

### 既存のインスタンスにバックアップを足す（一度だけ・流し直してよい）

2026-10-05 時点の `open-team-db` は自動バックアップなし・削除保護なしで作ってあるので、次を1回流す（同じ値なら何度流しても変わらない。承認を得てから）。

```bash
PROJECT_ID=<プロジェクト ID>

# 1. 今の設定を確かめる（enabled が False・deletionProtectionEnabled が False のはず）
gcloud sql instances describe open-team-db --project="$PROJECT_ID" \
  --format='yaml(settings.backupConfiguration,settings.deletionProtectionEnabled)'

# 2. 自動バックアップ（毎日 19:00 UTC = JST 4:00・7世代）と削除保護を有効にする
gcloud sql instances patch open-team-db --project="$PROJECT_ID" \
  --backup-start-time=19:00 --retained-backups-count=7 --deletion-protection --quiet

# 3. 確かめる（enabled: true・startTime: 19:00・retainedBackups: 7・deletionProtectionEnabled: true。
#    point-in-time recovery は付けない）
gcloud sql instances describe open-team-db --project="$PROJECT_ID" \
  --format='yaml(settings.backupConfiguration,settings.deletionProtectionEnabled,state)'

# 4. すぐ1つ取って、取れることを確かめる（最初の自動バックアップを待たない）
gcloud sql backups create --instance=open-team-db --project="$PROJECT_ID" --description="自動バックアップの有効化の確認"
gcloud sql backups list --instance=open-team-db --project="$PROJECT_ID"
```

- **再起動**：公式の文書（[Cloud SQL の設定の変更で起きること](https://cloud.google.com/sql/docs/postgres/instance-settings)）に、自動バックアップの有効化・バックアップ時刻の変更・削除保護でインスタンスが再起動する・止まるという記載は見つからなかった。再起動・停止が書かれているのは、CPU・メモリの変更（Enterprise は60秒未満の停止）と、**ポイントインタイムリカバリ（PITR）の有効化・無効化**など。この手順は PITR を付けない。ただし「再起動しない」と明記されているわけでもないので、流す前後に `curl https://<app の URL>/api/health` が 200 を返すことを確かめ、審査員が使わない時間に流す。
- 削除保護が付くと `gcloud sql instances delete` は失敗する（消すときは `--no-deletion-protection` を先に）。
- 戻し方（バックアップをやめる・削除保護を外す）：

```bash
gcloud sql instances patch open-team-db --project="$PROJECT_ID" --no-backup --no-deletion-protection --quiet
```

  取れたバックアップは残る（個別に消すなら `gcloud sql backups delete <ID> --instance=open-team-db`）。
- 費用：バックアップの保管は 10GB のインスタンスで月数十円未満（使用量の課金。ハッカソンの間の予算 100USD に比べて無視できる）。
- 各ユーザーの DB 内の権限は `packages/db/migrations/roles.sql` とマイグレーションが付ける（このスクリプトは付けない）。

### ローカルから Cloud SQL に繋ぐ（authorized-networks を一時的に足す）

マイグレーションやデバッグでローカルから公開 IP に繋ぐときだけ、自分の IP を許可する。**終わったら必ず外す**（既定は許可なし。`authorized-networks` の更新は**全部置き換え**なので、ほかの許可があれば消えないよう確かめてから）。

```bash
PROJECT_ID=<プロジェクト ID>
MY_IP="$(curl -s https://api.ipify.org)"

# 1. 今の許可を確かめる（既定は空）
gcloud sql instances describe open-team-db --project="$PROJECT_ID" --format='value(settings.ipConfiguration.authorizedNetworks)'

# 2. 自分の IP だけを一時的に許可する（空でないときは、既存の分もカンマでつなぐ）
gcloud sql instances patch open-team-db --project="$PROJECT_ID" --authorized-networks="$MY_IP/32" --quiet

# 3. 繋ぐ（パスワードは自分で決めた ot_migrator のもの。ここでは SSL を付ける）
psql "host=$(gcloud sql instances describe open-team-db --project="$PROJECT_ID" --format='value(ipAddresses[0].ipAddress)') dbname=openteam user=ot_migrator sslmode=require"

# 4. 終わったら許可を空に戻す
gcloud sql instances patch open-team-db --project="$PROJECT_ID" --clear-authorized-networks --quiet
```

パスワードを使わず公開 IP を開けたくないときは、Cloud SQL Auth Proxy（`cloud-sql-proxy <プロジェクト>:<リージョン>:open-team-db --port 5432`、`roles/cloudsql.client` が要る）で `localhost:5432` に繋ぐ方法もある（authorized-networks は不要）。

## 4. デプロイの流れ（`deploy.yml`）

1. `ci.yml` を呼ぶ（型・テスト・`pnpm lint:deps`・zizmor・gitleaks）。落ちたらデプロイしない（D-52）。
2. WIF で `sa-deployer` になる → **各サービスの今のリビジョンを控える**（ロールバック用）→ Artifact Registry に `docker login`。
3. `sim-world`・`gateway`（`DEPLOY_SIM_WORLD=true` のときだけ）と `app` のイメージを作って push。
4. **マイグレーション**：`app` のイメージ（digest）で Cloud Run Job `migrate` を作り直して流し、終わるまで待つ（[§4.1](#41-マイグレーション)）。失敗したらここで止まる（サービスはまだ何も変わっていない）。
5. `sim-world` → `gateway` → `app` の順に Cloud Run へ（`app`：Ingress 全体・最大10・タイムアウト3600秒、`sim-world`：Ingress 内部・最大3・90秒。どちらも最小0）。環境変数 `DEPLOYMENT_MODE=public`・`COMMIT_SHA`、ラベル `commit-sha` が付く。デプロイのたびにトラフィックは最新のリビジョンに 100%（`revision_traffic: LATEST=100`）。
6. **スモークテスト**（[§4.2](#42-スモークテスト)）。落ちたら**前のリビジョンへトラフィックを戻す**（[§4.3](#43-ロールバック)）。

入口のトークン（オーナー）と審査員のトークン：

```bash
gcloud secrets versions access latest --secret=phase0-access-token --project=<PROJECT_ID>
gcloud secrets versions access latest --secret=guest-entry-token --project=<PROJECT_ID>
```

差し替えるときは新しい版を足して再デプロイ（`gcloud secrets versions add <名前> --data-file=-`）。

### 4.1 マイグレーション

- 実行の仕組み：Cloud Run Job `migrate`。`app` と同じイメージ（`/srv/packages/db` に migrations が入っている）を `node /srv/packages/db/src/migrate.ts` で動かす（Node 22 の型の除去でそのまま動く。ビルドなし）。SA は `sa-migrator`、DB へは `ot_migrator`（秘密 `database-url-migrator`、unix ソケット）、VPC は Direct VPC egress（公開 IP の Cloud SQL に Cloud NAT 経由で出るのは `app` と同じ）。`--max-retries=0`・タイムアウト300秒。
- 実行器は番号の順に1ファイル1トランザクションで流し、流したものは `schema_migrations` に残して2度流さない（アドバイザリロックで同時実行も直列）。流したあとのファイルを書き換えるとチェックサム不一致で止まる（新しい番号のファイルで直す）。最後に `roles.sql`（冪等）を毎回流す。
- ローカルでの確かめ方：`docker build -t app .` のあと `docker run --rm -e DATABASE_URL=… app node /srv/packages/db/src/migrate.ts`（空の Postgres に 0001〜0004 が通り、2回目は何も流れない）。
- ログ：`gcloud run jobs executions list --job=migrate --region=…`、`gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="migrate"' --project=… --limit=30`。接続文字列（パスワード）は出さない（`db.migrated`・`db.migrate_failed` の行だけ）。

**マイグレーションは追加だけにする（決まり）。** マイグレーションはサービスの切り替えより前に流れ、切り替え中もロールバックでも古いリビジョンが動く。そのため、1つのマイグレーションは「古いコードがそのまま動く」変更に限る。

| してよい | してはいけない（複数のデプロイに分ける） |
|---|---|
| 表・列・インデックス・制約の追加（列は NULL 可か DEFAULT 付き） | 列・表の削除、列の名前・型の変更（先に新しい列を足して、コードを移し、次のデプロイ以降で消す） |
| 既存の行へのデータの足し込み | 古いコードが書く値を拒む制約・NOT NULL の追加 |

破るとロールバックしても古いコードが DB に合わず動かない。戻す必要が出たら §4.3 の「DB を戻す」。

### 4.2 スモークテスト

[`.github/scripts/smoke.mjs`](../.github/scripts/smoke.mjs)（Node だけ・依存なし）。`deploy.yml` が `app` のデプロイのあとに流す。

1. `GET /api/health` の `commit` が `GITHUB_SHA` になるまで最大2分待つ（新しいリビジョンにトラフィックが移るまで）。
2. `POST /api/v1/entry`（審査員用のトークン）で入り、`GET /api/v1/session` で `csrfToken`・`firstAskId` を取る。
3. 用意した依頼の担当が2人、リハーサルの結果が試験12件・すり抜け2件。
4. `SMOKE_RETEST=1`（`deploy.yml` は1）：締める提案を上から順に（まだ塞がれていない状況を塞ぐものだけ）適用し、最後の1件で再試験。2分以内に終わって合格証が出る（走行の `certificateId` と `GET …/certificate` が 200）。**用意した依頼の再試験は台本での再現なので Gemini の費用は 0**（D-101）。
5. `POST /api/v1/logout` で後片付け（失敗は警告だけ）。

- 入口のトークンは、そのステップの中で `gcloud secrets versions access` で読んで `::add-mask::` をかけ、同じステップの中だけで使う（GitHub の Secrets には写さない。`sa-deployer` が読めるのは `guest-entry-token` だけ）。
- 毎回ゲストのワークスペースが1つ作られる。ログアウトで削除予約になる前提だが、予約が効かないときは `ot-cleanup-guests`（毎時・7日使われないもの）が消す。ゲストの同時上限（50）に届きそうなら先に掃除する。
- 手元で流す：

```bash
export GUEST_ENTRY_TOKEN="$(gcloud secrets versions access latest --secret=guest-entry-token --project=<PROJECT_ID>)"
export BASE_URL=https://app-<プロジェクト番号>.asia-northeast1.run.app
export GITHUB_SHA="$(curl -s "$BASE_URL/api/health" | node -pe 'JSON.parse(require("fs").readFileSync(0)).commit')"
SMOKE_RETEST=1 node .github/scripts/smoke.mjs
```

### 4.3 ロールバック

**自動**：スモークテストなどがデプロイのあとで落ちると、`deploy.yml` が、このデプロイで新しい版を出せたサービスごとに、デプロイ前に控えたリビジョンへ `gcloud run services update-traffic <サービス> --to-revisions=<控え>=100` で戻す。DB は戻さない（§4.1 のとおり前のリビジョンはそのまま動く）。マイグレーション自体が落ちたときは、サービスは何も変わっていないので戻す対象がない。

**手動**（`<PROJECT_ID>`・`<REGION>` を入れる）：

```bash
# 1. リビジョンを見る（新しい順。今トラフィックが向いているものが分かる）
gcloud run revisions list --service=app --project=<PROJECT_ID> --region=<REGION>
gcloud run services describe app --project=<PROJECT_ID> --region=<REGION> --format='value(status.traffic)'

# 2. 前のリビジョンに 100% 向ける（gateway・sim-world も同様）
gcloud run services update-traffic app --project=<PROJECT_ID> --region=<REGION> --to-revisions=<リビジョン名>=100

# 3. 確かめる
curl -s https://app-<プロジェクト番号>.<REGION>.run.app/api/health   # commit が戻した版のもの

# 4. 直したら、最新のリビジョンに戻す（これをしないと固定が残る：下の注意）
gcloud run services update-traffic app --project=<PROJECT_ID> --region=<REGION> --to-latest
```

- **手でトラフィックを固定すると、そのあとのデプロイは新しいリビジョンに 0% しか向けない**（公式（[Rollouts, rollbacks, and traffic migration](https://cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration)）：前のリビジョンにトラフィックを割り当てたら、以後のデプロイはその割り当てを使い続ける）。このリポジトリの `deploy.yml` は各デプロイに `revision_traffic: LATEST=100`（デプロイ後に `update-traffic --to-revisions LATEST=100`）を付けてあるので、**次のデプロイで自動的に最新へ戻る**。手で固定したあと、次のデプロイを待たずに戻すときは手順 4。
- **正の手順は `git revert` して push**：悪いコミットを `git revert <SHA>`（日本語のメッセージ）→ `main` に push → `deploy.yml` が CI → マイグレーション → デプロイ → スモークテストを通して戻す。手動の `update-traffic` は、push して流れるまでのつなぎ（数分）に使い、あとで `git revert` で履歴を合わせる（コードと本番がずれたままにしない）。
- **DB を戻す**（マイグレーションが前のコードと合わない・データが壊れたとき。**インスタンス丸ごと、バックアップの時点に上書き**する。公式：復元はインスタンスの今のデータをすべて上書きする。そのあとの書き込みは失われる。既存のバックアップは残る）：

```bash
gcloud sql backups list --instance=open-team-db --project=<PROJECT_ID>
# 復元の前に、今の状態を1つ取っておく（戻せるように）
gcloud sql backups create --instance=open-team-db --project=<PROJECT_ID> --description="復元の前"
gcloud sql backups restore <バックアップ ID> --restore-instance=open-team-db --project=<PROJECT_ID>
```

  復元の間は DB が使えない。復元のあと、コードをそのバックアップの時点に合う版に戻す（上の `git revert`）。`schema_migrations` も一緒に戻るので、次のデプロイで必要なマイグレーションが流し直される。ユーザー・パスワードが復元で戻るかは公式の文書に記載がないので、復元後にサービスが DB に繋がるか確かめる（繋がらなければ `gcp-setup.sh` を流し直して `ot_migrator` を決め直し、ほかのロールは `gcloud sql users set-password`）。

## 5. 確かめること（SO §7.12・§7.14）

| 確かめること | 期待 |
|---|---|
| PR のワークフローから WIF の認証（SO-SC-06） | 失敗（条件に合わない） |
| `main` の `workflow_dispatch` から WIF の認証（SO-SC-07） | 失敗（`event_name == 'push'`） |
| `gcloud run services describe app --region=… --format='value(spec.template.spec.serviceAccountName)'`（`sim-world` も） | `sa-app`・`sa-sim`（既定の SA でない） |
| `curl https://sim-world-….run.app/` | 403 / 404（外から届かない） |
| `gcloud sql instances describe open-team-db --format='value(settings.backupConfiguration.enabled,settings.deletionProtectionEnabled)'` | `True True` |
| `gcloud run jobs describe migrate --region=…` | イメージが `app` のもの・SA が `sa-migrator`・`DATABASE_URL` が `database-url-migrator` |
| `gcloud secrets list` | 上の表だけ（実のコネクタ・LLM の鍵がない） |
| 予算 | Cloud コンソールの「予算とアラート」に `open-team-hackathon`（30%・100%） |
| デプロイ版と `main` | `gcloud run services describe app --format='value(metadata.labels.commit-sha)'` が `git rev-parse origin/main` と同じ |

## 6. Cloud Scheduler（app のデプロイのあとに作る。2026-10-05 に作成済み）

`app` の URL が要るので `gcp-setup.sh` には入れず、最初のデプロイのあとに手で作る（API は `gcp-setup.sh` が有効にする）。OIDC は `sa-app`、aud は `APP_INTERNAL_URL`（`app` の固定 URL）。

```bash
URL=https://app-<プロジェクト番号>.asia-northeast1.run.app
for j in "ot-tick|* * * * *|tick|60s" "ot-cleanup-guests|0 * * * *|cleanup-guests|180s"; do
  IFS='|' read -r name cron path dl <<<"$j"
  gcloud scheduler jobs create http "$name" --location=asia-northeast1 --schedule="$cron" --time-zone=Asia/Tokyo \
    --uri="$URL/internal/cron/$path" --http-method=POST \
    --oidc-service-account-email=sa-app@<プロジェクト ID>.iam.gserviceaccount.com --oidc-token-audience="$URL" \
    --attempt-deadline="$dl" --max-retry-attempts=0
done
```

- `ot-tick`（毎分）：承認の期限切れと拾い直し・定期の依頼の起動・止まった生成の失敗化。
- `ot-cleanup-guests`（毎時）：7日使われていないゲストのワークスペースを消す。これが無いと同時 50 件の上限（BR-65）に達して入口が 429 になる。ついでに30日使われていないエージェントを `removed` にする（行は残し、監査ログ `agent.removed` を残す）。
- 確認：`gcloud scheduler jobs run <名前> --location=asia-northeast1` のあと、ログ `cleanup.guests`（件数つき）と Scheduler のログの 200 を見る。

## 7. 次の段階（この設定ではまだ作らない）

- 今の Cloud SQL は設計（SO §4.6：private IP・`db-g1-small` 以上）より小さく、公開 IP で NAT 経由（ハッカソンの間の割り切り）。
- `gateway` のサービス（`sa-gateway`、Ingress 内部、呼べるのは `sa-app` だけ、`ALLOWED_CONNECTOR_URLS`）。順番は `sim-world` → `gateway` → `app`。
- `/internal/selfcheck`（`sa-deployer` に `sa-app` の `serviceAccountTokenCreator`）。
- Vertex AI のクォータ（下げられるか 10/4 に確かめる：SO §4.9）。

## 8. つまずいたとき

- `allUsers` を付けられない：組織のポリシー（ドメイン制限の共有）。個人のプロジェクトで流すか、組織のポリシーで例外にする。
- WIF のプール・プロバイダーを消して作り直せない：消したものは30日残る。`gcloud iam workload-identity-pools undelete github --location=global` で戻す。
- gitleaks が「license key is required」で落ちる：リポジトリが組織のもの。gitleaks.io の無料のキーを `GITLEAKS_LICENSE` に入れ、`ci.yml` の gitleaks の `env` に足す（個人のリポジトリでは要らない）。
- README の CI のバッジ：`main` は `deploy.yml` が CI を呼ぶので、`main` の状態は `deploy.yml` のバッジで見る。

## 9. 作業場（サンドボックス。D-116）

「作る」「見直す」担当（`dev-coder`・`reviewer`）が、ファイルを書いてコマンドで動かす使い捨ての場所。タスクごとに app が Cloud Run Jobs の実行を1つ起こし、
実行役（`apps/sandbox`）が app の `/sandbox/v1` に作業場だけのトークンで来て、判定済みのコマンドを受け取って動かす（LLM は呼べない）。

1. 準備：`PROJECT_ID=<id> PROJECT_NUMBER=<番号> bash infra/sandbox-setup.sh`
   （`sa-sandbox`（ロールなし）・サブネット `sandbox`・Cloud NAT・網の規則 `sandbox-egress`：レジストリと app の 443 だけ）
2. GitHub の変数 `DEPLOY_SANDBOX=true` にして再デプロイ。`sandbox` のイメージとジョブができ、`sa-app` に `roles/run.jobsExecutorWithOverrides` が付き、
   app に `SANDBOX_PROVIDER=cloudrun`・`SANDBOX_JOB`・`SANDBOX_EDGE_URL` が入る
3. デプロイのすぐあとに、網の規則が効いているかを確かめる（作業場から example.com に届かないこと）：
   ```sh
   gcloud run jobs execute sandbox --region=<region> --wait \
     --update-env-vars=SANDBOX_TOKEN=x,SANDBOX_EDGE_URL=https://example.com
   ```
   実行のログに `sandbox.next_failed`（届かない）が出れば効いている。届いて別の応答（404 など）になるなら効いていない：
   すぐ `DEPLOY_SANDBOX` を消して再デプロイし、規則を直してからやり直す（作業場は認証情報を持たないので、網は二重目の守り）
4. 止めるとき：`DEPLOY_SANDBOX` を消して再デプロイ（app が `none` に戻り、作業場の道具を渡さなくなる）

- 作業場のトークンはジョブの実行の上書き（overrides）の環境変数で渡す。実行の詳細を読める人（`run.executions.get`）には見えるが、
  できるのはそのタスクのコマンドの受け取りと結果・控えの送り返しだけ（タスクが終わると閉じる）
- 作ったファイルは tar.gz の控えとして DB（`agent_workspace_snapshots`、10MB まで・担当ごとに10件）に残り、画面からダウンロードできる
- 手元では `SANDBOX_PROVIDER=inprocess`（app と同じプロセス・隔離なし。cloud では使えない）か `docker`（`SANDBOX_DOCKER_IMAGE`・`SANDBOX_EDGE_URL`）

## 緊急時（SO §4.11）

| 起きたこと | 手当て |
|---|---|
| Gemini の費用が急に増える | `sa-app` から `roles/aiplatform.user` を外す（画面・承認・Kill Switch は動く） |
| 入口のトークンが広まった | `guest-entry-token` に新しい版を足して再デプロイ |
| デプロイした版が壊れている | §4.3 のロールバック（自動で戻っていなければ手動の `update-traffic`、そのあと `git revert` して push） |
| DB が壊れた・マイグレーションが合わない | §4.3 の「DB を戻す」（`gcloud sql backups restore`） |
| 公開をやめる | `gcloud run services update app --ingress=internal --region=…` |
