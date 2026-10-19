#!/usr/bin/env bash
# GCP の初期設定。プロジェクトを作ったあとに1回だけ流す（何度流しても同じ状態に寄せる。消す操作はしない）
# 15 §構成・§公開時のセキュリティ、D-50〜52、SO §4.1〜4.3・§4.7・§4.9
#
# 使い方（Cloud Shell か、gcloud にプロジェクトの Owner でログインした端末で）：
#   PROJECT_ID=my-project GITHUB_REPO=owner/open-team BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX bash infra/gcp-setup.sh
# 最後に、GitHub のリポジトリの変数（deploy.yml が読む）に入れる値を出す。詳しくは infra/README.md
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1 # 確認を出さずに進める（流し直しても同じ状態になる操作だけを使う）

# ---- 変数（環境変数で渡す）--------------------------------------------------
PROJECT_ID="${PROJECT_ID:-}"                # GCP のプロジェクト ID（作成済み）
REGION="${REGION:-asia-northeast1}"         # Cloud Run・Artifact Registry・Secret Manager の場所
GITHUB_REPO="${GITHUB_REPO:-}"              # owner/repo（大文字・小文字も GitHub の表示どおり）。WIF はこのリポジトリの main への push だけを通す
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"      # 請求先アカウント ID（XXXXXX-XXXXXX-XXXXXX）。予算アラートを作る
# ---- 任意 --------------------------------------------------------------------
AR_REPOSITORY="${AR_REPOSITORY:-open-team}" # Artifact Registry のリポジトリ名（deploy.yml の既定と同じ）
GITHUB_REPO_ID="${GITHUB_REPO_ID:-}"        # リポジトリの数値の ID。入れると WIF の条件に足す（リポジトリ名の付け替えへの備え。SO §9 I-25）
BUDGET_START="${BUDGET_START:-2026-10-01}"  # 予算の期間（ハッカソンの間を通しで数える）
BUDGET_END="${BUDGET_END:-2026-12-31}"
# 予算の額（通貨つき）。30% と 100% で通知する → 既定の 100USD なら $30・$100。
# 請求先アカウントの通貨が USD でなければ、その通貨で $100 相当を入れる（例 BUDGET_AMOUNT=15000JPY）。通貨が違うと作成が失敗する
BUDGET_AMOUNT="${BUDGET_AMOUNT:-100USD}"
SQL_INSTANCE="${SQL_INSTANCE:-open-team-db}" # Cloud SQL のインスタンス名（deploy.yml の CLOUDSQL_INSTANCE と同じ）
SQL_TIER="${SQL_TIER:-db-f1-micro}"          # 新規作成のときだけ効く（作成済みなら変えない）
SQL_ZONE="${SQL_ZONE:-${REGION}-a}"          # 新規作成のときだけ効く
# 1 にすると ot_migrator のパスワードを決め直して秘密 database-url-migrator に新しい版を足す（既定は、有効な版がなければ入れるだけ）
ROTATE_MIGRATOR_PASSWORD="${ROTATE_MIGRATOR_PASSWORD:-0}"

# ---- 固定の名前（deploy.yml・SO §4.2・§4.3 と同じ）----------------------------
# sa-gcal は本物の Google カレンダーのアダプター（D-113）。ロールを何も付けない
RUNTIME_SAS=(sa-app sa-gateway sa-sim sa-gcal)
DEPLOYER="sa-deployer"
# マイグレーション用の Cloud Run Job（deploy.yml の migrate）だけが使う SA（D-102）。DB のロールは ot_migrator
MIGRATOR="sa-migrator"
WIF_POOL_ID="github"
WIF_PROVIDER_ID="github-main"
BUDGET_NAME="open-team-hackathon"
# 乱数で最初の値を入れる秘密（入口のトークン2つと Cookie の秘密。32文字以上：SO §2.2）
RANDOM_SECRETS=(phase0-access-token guest-entry-token session-cookie-secret)
# 器だけ作る秘密（値は Cloud SQL を作る次の段階で入れる）
EMPTY_SECRETS=(database-url-app database-url-maint database-url-gateway database-url-sim google-oauth-client-id google-oauth-client-secret)
# Google の OAuth のクライアント（D-113）は管理画面でしか作れない。値は手で「新しいバージョン」として入れる（infra/README.md）
# refresh token の暗号の鍵（base64 の32バイト。16 §3.4）
OAUTH_KEY_SECRET=oauth-token-key
# 値は ot_migrator のパスワードを決め直すときにこのスクリプトが入れる（下の「マイグレーション用の接続文字列」）
MIGRATOR_SECRET="database-url-migrator"

log() { printf '\n== %s\n' "$*"; }
die() { printf 'エラー：%s\n' "$*" >&2; exit 1; }

# SA を作った直後は IAM に見えるまで少しかかるので、IAM の操作は数回やり直す
retry() {
  local n
  for n in 1 2 3 4 5 6; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep $((n * 5))
  done
  "$@" >/dev/null # 最後の1回は失敗の理由を見せる
}

# ---- 前提の確認 ----------------------------------------------------------------
command -v gcloud >/dev/null || die "gcloud がない（Cloud Shell で流すのが早い）"
[[ -n "$PROJECT_ID" ]] || die "PROJECT_ID を入れる"
[[ "$GITHUB_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "GITHUB_REPO は owner/repo の形で入れる"
[[ -n "$BILLING_ACCOUNT" ]] || die "BILLING_ACCOUNT を入れる（gcloud billing accounts list で見られる）"
[[ -z "$GITHUB_REPO_ID" || "$GITHUB_REPO_ID" =~ ^[0-9]+$ ]] || die "GITHUB_REPO_ID は数字だけ"
ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n1)"
[[ -n "$ACCOUNT" ]] || die "gcloud auth login でログインする"
echo "アカウント：$ACCOUNT／プロジェクト：$PROJECT_ID／リージョン：$REGION／リポジトリ：$GITHUB_REPO"

# ---- 1. 請求先アカウントのひも付け（Cloud Run などの API は請求先がないと有効にできない）------------
log "請求先アカウント"
# 請求の API は利用者の認証で呼ぶと割り当てのプロジェクトが要る（--billing-project）。先にこの API だけ有効にする
gcloud services enable cloudbilling.googleapis.com --project="$PROJECT_ID"
BILLING_INFO="$(gcloud billing projects describe "$PROJECT_ID" --billing-project="$PROJECT_ID" \
  --format='value(billingAccountName)')" || die "プロジェクトの請求先を読めない（権限を確かめる）"
if [[ -z "$BILLING_INFO" ]]; then
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" >/dev/null
  echo "ひも付けた：$BILLING_ACCOUNT"
elif [[ "$BILLING_INFO" != "billingAccounts/$BILLING_ACCOUNT" ]]; then
  # ひも付けは変えない。予算は実際の請求先に作る（違う請求先に作ると、このプロジェクトの費用が数えられない）
  BILLING_ACCOUNT="${BILLING_INFO#billingAccounts/}"
  echo "注意：すでに別の請求先（$BILLING_ACCOUNT）にひも付いている。変えずに、予算はこの請求先に作る"
else
  echo "ひも付け済み"
fi

# ---- 2. API --------------------------------------------------------------------
log "API を有効にする"
gcloud services enable --project="$PROJECT_ID" \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  secretmanager.googleapis.com \
  aiplatform.googleapis.com \
  cloudresourcemanager.googleapis.com \
  billingbudgets.googleapis.com \
  cloudscheduler.googleapis.com \
  sqladmin.googleapis.com
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
echo "プロジェクト番号：$PROJECT_NUMBER"

# ---- 3. Artifact Registry ------------------------------------------------------
log "Artifact Registry（$REGION/$AR_REPOSITORY）"
if gcloud artifacts repositories describe "$AR_REPOSITORY" --project="$PROJECT_ID" --location="$REGION" >/dev/null 2>&1; then
  echo "作成済み"
else
  gcloud artifacts repositories create "$AR_REPOSITORY" --project="$PROJECT_ID" --location="$REGION" \
    --repository-format=docker --description="open-team のイメージ（deploy.yml が push）" >/dev/null
  echo "作った"
fi

# ---- 4. サービスアカウント（既定の Compute Engine の SA は使わない：15:490）----------
log "サービスアカウント"
sa_email() { echo "$1@$PROJECT_ID.iam.gserviceaccount.com"; }
for sa in "${RUNTIME_SAS[@]}" "$DEPLOYER" "$MIGRATOR"; do
  if gcloud iam service-accounts describe "$(sa_email "$sa")" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "$sa：作成済み"
  else
    gcloud iam service-accounts create "$sa" --project="$PROJECT_ID" --display-name="open-team $sa" >/dev/null
    echo "$sa：作った"
  fi
done

project_role() { # SA ロール
  retry gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$(sa_email "$1")" --role="$2" --condition=None --quiet
  echo "$1 ← $2（プロジェクト）"
}

# ---- 5. 実行の SA のロール（最小。SO §4.2）--------------------------------------
log "実行の SA のロール"
# Gemini（Vertex AI）を呼べるのは sa-app だけ（D-52、ADR-032）
project_role sa-app roles/aiplatform.user
# Cloud SQL への接続（DB は次の段階で作る。接続できるのは DB のロールで分ける：SO §4.6）
project_role sa-app roles/cloudsql.client
project_role sa-gateway roles/cloudsql.client
project_role sa-sim roles/cloudsql.client
# マイグレーションの Job が Cloud SQL に繋ぐため（DB の中の権限は ot_migrator のロールで決まる）
project_role "$MIGRATOR" roles/cloudsql.client
# Cloud Run の呼び出し（run.invoker）はサービスごとに deploy.yml が付ける（sim-world は sa-gateway・sa-app だけ）

# ---- 5b. Cloud SQL（なければ作る。あれば設定を変えない）------------------------------------
log "Cloud SQL（$SQL_INSTANCE）"
if gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "作成済み（設定は変えない）"
  if [[ "$(gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" --format='value(settings.backupConfiguration.enabled)')" != "True" ]]; then
    echo "注意：自動バックアップが無効。infra/README.md の「既存のインスタンスにバックアップを足す」を一度だけ流す"
  fi
else
  # 自動バックアップ（毎日 19:00 UTC = JST 4:00、7世代）と削除保護を最初から付ける。公開 IP・HDD・ゾーン1つ（ハッカソンの間の割り切り：README §3）。
  # ネットワーク（サブネット・Cloud NAT：README §3）とデータベース・ユーザー（openteam・ot_*）は、このスクリプトでは作らない（ot_migrator だけ、下の 6b で作る・決め直す）
  gcloud sql instances create "$SQL_INSTANCE" --project="$PROJECT_ID" --region="$REGION" --zone="$SQL_ZONE" \
    --database-version=POSTGRES_16 --edition=ENTERPRISE --tier="$SQL_TIER" \
    --storage-type=HDD --storage-size=10GB \
    --backup-start-time=19:00 --retained-backups-count=7 --deletion-protection >/dev/null
  echo "作った（バックアップ 19:00 UTC・7世代、削除保護あり）"
fi

# ---- 6. Secret Manager（器と、読める SA を秘密ごとに。SO §4.3）---------------------
log "Secret Manager"
ensure_secret() {
  if gcloud secrets describe "$1" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "$1：作成済み"
  else
    gcloud secrets create "$1" --project="$PROJECT_ID" \
      --replication-policy=user-managed --locations="$REGION" >/dev/null
    echo "$1：作った"
  fi
}
secret_reader() { # 秘密 SA
  retry gcloud secrets add-iam-policy-binding "$1" --project="$PROJECT_ID" \
    --member="serviceAccount:$(sa_email "$2")" --role=roles/secretmanager.secretAccessor
}
for s in "${RANDOM_SECRETS[@]}" "${EMPTY_SECRETS[@]}" "$MIGRATOR_SECRET"; do ensure_secret "$s"; done
for s in "${RANDOM_SECRETS[@]}"; do
  # 有効な版がなければ乱数（英数字48文字）を入れる。2つのトークンは必ず違う値になる
  if [[ -z "$(gcloud secrets versions list "$s" --project="$PROJECT_ID" --filter='state=ENABLED' --limit=1 --format='value(name)')" ]]; then
    # head -c で読み切ってから変換する（tr | head だと pipefail 下で tr が SIGPIPE になり、スクリプトが止まる）
    head -c 256 /dev/urandom | base64 -w0 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-48 | tr -d '\n' |
      gcloud secrets versions add "$s" --project="$PROJECT_ID" --data-file=- >/dev/null
    echo "$s：最初の値を入れた"
  fi
done
ensure_secret "$OAUTH_KEY_SECRET"
if [[ -z "$(gcloud secrets versions list "$OAUTH_KEY_SECRET" --project="$PROJECT_ID" --limit=1 --format='value(name)')" ]]; then
  head -c 32 /dev/urandom | base64 -w0 | gcloud secrets versions add "$OAUTH_KEY_SECRET" --project="$PROJECT_ID" --data-file=- >/dev/null
  echo "$OAUTH_KEY_SECRET：最初の値を入れた"
fi
for s in phase0-access-token guest-entry-token session-cookie-secret database-url-app database-url-maint; do
  secret_reader "$s" sa-app
done
# Google の OAuth（D-113）：app（つなぐ）と gateway（refresh token の復号と更新）だけが読む
for s in google-oauth-client-id google-oauth-client-secret "$OAUTH_KEY_SECRET"; do
  secret_reader "$s" sa-app
  secret_reader "$s" sa-gateway
done
secret_reader database-url-gateway sa-gateway
secret_reader database-url-sim sa-sim
# マイグレーションの接続文字列を読めるのは sa-migrator だけ（ほかの SA・sa-deployer には付けない）
secret_reader "$MIGRATOR_SECRET" "$MIGRATOR"
echo "読める SA：app の秘密 → sa-app、database-url-gateway → sa-gateway、database-url-sim → sa-sim、$MIGRATOR_SECRET → $MIGRATOR だけ"

# ---- 6b. マイグレーション用の接続文字列（ot_migrator のパスワードを決め直して秘密に入れる。D-102）----
log "マイグレーション用の接続文字列（$MIGRATOR_SECRET）"
if [[ "$ROTATE_MIGRATOR_PASSWORD" != "1" && -n "$(gcloud secrets versions list "$MIGRATOR_SECRET" --project="$PROJECT_ID" --filter='state=ENABLED' --limit=1 --format='value(name)')" ]]; then
  echo "有効な版がある（決め直すなら ROTATE_MIGRATOR_PASSWORD=1）"
elif ! gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  die "Cloud SQL（$SQL_INSTANCE）がない。作ってから流し直す"
else
  # パスワードは変数の中だけ（画面・ログ・ファイルに出さない。英数字32文字なので URL のエスケープは要らない）。
  # ot_migrator を使うのは migrate の Job だけなので、決め直しても動いているサービスは切れない
  MIGRATOR_PW="$(head -c 256 /dev/urandom | base64 -w0 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-32 | tr -d '\n')"
  [[ ${#MIGRATOR_PW} -eq 32 ]] || die "パスワードを作れなかった"
  if gcloud sql users list --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --format='value(name)' | grep -qx ot_migrator; then
    gcloud sql users set-password ot_migrator --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --password="$MIGRATOR_PW" >/dev/null
  else
    gcloud sql users create ot_migrator --instance="$SQL_INSTANCE" --project="$PROJECT_ID" --password="$MIGRATOR_PW" >/dev/null
  fi
  # 形式は database-url-* と同じ（unix ソケット。Cloud Run が --set-cloudsql-instances で繋ぐ）
  printf '%s' "postgres://ot_migrator:${MIGRATOR_PW}@localhost/openteam?host=/cloudsql/${PROJECT_ID}:${REGION}:${SQL_INSTANCE}" |
    gcloud secrets versions add "$MIGRATOR_SECRET" --project="$PROJECT_ID" --data-file=- >/dev/null
  unset MIGRATOR_PW
  echo "ot_migrator のパスワードを決め直し、$MIGRATOR_SECRET に新しい版を入れた（値は保存しない）"
fi

# ---- 7. デプロイ用の SA（sa-deployer。SO §4.2）-----------------------------------
log "デプロイ用の SA のロール"
# デプロイと、app の allUsers・sim-world の呼び出し元の設定
project_role "$DEPLOYER" roles/run.admin
# イメージの push はこのリポジトリだけ
retry gcloud artifacts repositories add-iam-policy-binding "$AR_REPOSITORY" --project="$PROJECT_ID" --location="$REGION" \
  --member="serviceAccount:$(sa_email "$DEPLOYER")" --role=roles/artifactregistry.writer
echo "$DEPLOYER ← roles/artifactregistry.writer（$AR_REPOSITORY だけ）"
# 実行の SA を Cloud Run に付けてよい（actAs）。SA ごとに付ける（Job の sa-migrator も）
for sa in "${RUNTIME_SAS[@]}" "$MIGRATOR"; do
  retry gcloud iam service-accounts add-iam-policy-binding "$(sa_email "$sa")" --project="$PROJECT_ID" \
    --member="serviceAccount:$(sa_email "$DEPLOYER")" --role=roles/iam.serviceAccountUser
  echo "$DEPLOYER ← roles/iam.serviceAccountUser（$sa）"
done

# デプロイ後のスモークテストが審査員用の入口のトークンを読む（この秘密だけ。GitHub の Secrets には写さない）
secret_reader guest-entry-token "$DEPLOYER"
echo "$DEPLOYER ← roles/secretmanager.secretAccessor（guest-entry-token だけ）"

# ---- 8. Workload Identity 連携（このリポジトリの main への push だけ：15:510、SO §4.7）----
log "Workload Identity 連携"
if gcloud iam workload-identity-pools describe "$WIF_POOL_ID" --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  echo "プール $WIF_POOL_ID：作成済み"
else
  gcloud iam workload-identity-pools create "$WIF_POOL_ID" --project="$PROJECT_ID" --location=global \
    --display-name="GitHub Actions" >/dev/null
  echo "プール $WIF_POOL_ID：作った"
fi
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name"
# PR・workflow_dispatch・schedule・ほかのブランチ・ほかのリポジトリからはトークンを取れない
CONDITION="attribute.repository == '$GITHUB_REPO' && attribute.ref == 'refs/heads/main' && attribute.event_name == 'push'"
if [[ -n "$GITHUB_REPO_ID" ]]; then CONDITION="$CONDITION && attribute.repository_id == '$GITHUB_REPO_ID'"; fi
if gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER_ID" --project="$PROJECT_ID" --location=global \
  --workload-identity-pool="$WIF_POOL_ID" >/dev/null 2>&1; then
  # 流し直したときも条件をこの値にそろえる
  gcloud iam workload-identity-pools providers update-oidc "$WIF_PROVIDER_ID" --project="$PROJECT_ID" --location=global \
    --workload-identity-pool="$WIF_POOL_ID" --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
  echo "プロバイダー $WIF_PROVIDER_ID：条件を更新した"
else
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER_ID" --project="$PROJECT_ID" --location=global \
    --workload-identity-pool="$WIF_POOL_ID" --display-name="GitHub main push" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" >/dev/null
  echo "プロバイダー $WIF_PROVIDER_ID：作った"
fi
echo "条件：$CONDITION"
# sa-deployer になれるのは、このリポジトリから来た（かつ上の条件を通った）トークンだけ
retry gcloud iam service-accounts add-iam-policy-binding "$(sa_email "$DEPLOYER")" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$WIF_POOL_ID/attribute.repository/$GITHUB_REPO"
echo "$DEPLOYER ← roles/iam.workloadIdentityUser（$GITHUB_REPO）"

# ---- 9. 予算アラート（2段目。SO §4.9）---------------------------------------------
log "予算アラート"
# 予算の API は利用者の認証で呼ぶと割り当てのプロジェクトが要る（--billing-project）
if gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" \
  --format='value(displayName)' | grep -qx "$BUDGET_NAME"; then
  echo "$BUDGET_NAME：作成済み（額を変えるなら Cloud コンソールで）"
else
  # クーポンの分を引かずに数える（引くとクーポンを使い切るまで通知が来ない）。通知は請求先アカウントの管理者のメールに届く
  gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" --billing-project="$PROJECT_ID" \
    --display-name="$BUDGET_NAME" --budget-amount="$BUDGET_AMOUNT" --filter-projects="projects/$PROJECT_ID" \
    --credit-types-treatment=exclude-all-credits \
    --threshold-rule=percent=0.3 --threshold-rule=percent=1.0 \
    --start-date="$BUDGET_START" --end-date="$BUDGET_END" >/dev/null ||
    die "予算を作れない。請求先アカウントの通貨が USD でなければ BUDGET_AMOUNT=15000JPY のように通貨つきで入れて流し直す（請求先アカウントの管理者の権限も要る）"
  echo "$BUDGET_NAME：作った（$BUDGET_AMOUNT、30%・100% で通知、$BUDGET_START〜$BUDGET_END）"
fi

# ---- 10. GitHub に入れる値 ---------------------------------------------------------
WIF_PROVIDER="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$WIF_POOL_ID/providers/$WIF_PROVIDER_ID"
log "終わり。GitHub のリポジトリの変数（Settings → Secrets and variables → Actions → Variables）に入れる"
cat <<EOF
  GCP_PROJECT_ID      $PROJECT_ID
  GCP_PROJECT_NUMBER  $PROJECT_NUMBER
  GCP_REGION          $REGION
  WIF_PROVIDER        $WIF_PROVIDER
  DEPLOYER_SA         $(sa_email "$DEPLOYER")
  AR_REPOSITORY       $AR_REPOSITORY

gh を使うなら：
  gh variable set GCP_PROJECT_ID --repo "$GITHUB_REPO" --body "$PROJECT_ID"
  gh variable set GCP_PROJECT_NUMBER --repo "$GITHUB_REPO" --body "$PROJECT_NUMBER"
  gh variable set GCP_REGION --repo "$GITHUB_REPO" --body "$REGION"
  gh variable set WIF_PROVIDER --repo "$GITHUB_REPO" --body "$WIF_PROVIDER"
  gh variable set DEPLOYER_SA --repo "$GITHUB_REPO" --body "$(sa_email "$DEPLOYER")"
  gh variable set AR_REPOSITORY --repo "$GITHUB_REPO" --body "$AR_REPOSITORY"

入口のトークン（オーナー）の見方：
  gcloud secrets versions access latest --secret=phase0-access-token --project="$PROJECT_ID"
EOF
