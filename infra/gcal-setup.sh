#!/usr/bin/env bash
# 本物の Google カレンダー（D-113・ADR-040・16 §3）の GCP の準備だけを流す。gcp-setup.sh を流し直さずに足すとき用（何度流しても同じ状態）。
# 使い方：PROJECT_ID=hackathon-v5 bash infra/gcal-setup.sh
# OAuth の同意画面とクライアント（ウェブ アプリケーション）は管理画面でしか作れない。値は google-oauth-client-id・google-oauth-client-secret に手で入れる
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
PROJECT_ID="${PROJECT_ID:?PROJECT_ID を入れる}"
REGION="${REGION:-asia-northeast1}"
sa_email() { echo "$1@$PROJECT_ID.iam.gserviceaccount.com"; }

gcloud services enable calendar-json.googleapis.com --project="$PROJECT_ID"

# アダプターの SA（ロールなし）。デプロイの SA が Cloud Run に付けられるようにする
if ! gcloud iam service-accounts describe "$(sa_email sa-gcal)" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create sa-gcal --project="$PROJECT_ID" --display-name="open-team sa-gcal" >/dev/null
  echo "sa-gcal：作った"
fi
gcloud iam service-accounts add-iam-policy-binding "$(sa_email sa-gcal)" --project="$PROJECT_ID" \
  --member="serviceAccount:$(sa_email sa-deployer)" --role=roles/iam.serviceAccountUser >/dev/null
echo "sa-deployer ← roles/iam.serviceAccountUser（sa-gcal）"

for s in oauth-token-key google-oauth-client-id google-oauth-client-secret; do
  gcloud secrets describe "$s" --project="$PROJECT_ID" >/dev/null 2>&1 ||
    gcloud secrets create "$s" --project="$PROJECT_ID" --replication-policy=user-managed --locations="$REGION" >/dev/null
done
if [[ -z "$(gcloud secrets versions list oauth-token-key --project="$PROJECT_ID" --limit=1 --format='value(name)')" ]]; then
  head -c 32 /dev/urandom | base64 -w0 | gcloud secrets versions add oauth-token-key --project="$PROJECT_ID" --data-file=- >/dev/null
  echo "oauth-token-key：最初の値を入れた"
fi
# 読めるのは app（つなぐ）と gateway（復号と更新）だけ
for s in oauth-token-key google-oauth-client-id google-oauth-client-secret; do
  for sa in sa-app sa-gateway; do
    gcloud secrets add-iam-policy-binding "$s" --project="$PROJECT_ID" \
      --member="serviceAccount:$(sa_email "$sa")" --role=roles/secretmanager.secretAccessor >/dev/null
    echo "$s ← $sa"
  done
done
for s in google-oauth-client-id google-oauth-client-secret; do
  [[ -n "$(gcloud secrets versions list "$s" --project="$PROJECT_ID" --limit=1 --format='value(name)')" ]] ||
    echo "注意：$s に値がまだない（管理画面で作ったクライアントの値を「新しいバージョン」で入れる。入れたら GitHub の変数 DEPLOY_GCAL=true にする）"
done
