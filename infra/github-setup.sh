#!/usr/bin/env bash
# 本人の GitHub のリポジトリ（D-119・18 §5）の GCP の準備だけを流す。gcp-setup.sh を流し直さずに足すとき用（何度流しても同じ状態）。
# 使い方：PROJECT_ID=hackathon-v5 bash infra/github-setup.sh
# GitHub App は GitHub の画面でしか作れない（18 §5 の手順）。秘密鍵と Client secret は github-app-private-key・github-app-client-secret に手で入れる
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
PROJECT_ID="${PROJECT_ID:?PROJECT_ID を入れる}"
REGION="${REGION:-asia-northeast1}"
sa_email() { echo "$1@$PROJECT_ID.iam.gserviceaccount.com"; }

# アダプターの SA（ロールなし）。デプロイの SA が Cloud Run に付けられるようにする
if ! gcloud iam service-accounts describe "$(sa_email sa-github)" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create sa-github --project="$PROJECT_ID" --display-name="open-team sa-github" >/dev/null
  echo "sa-github：作った"
fi
gcloud iam service-accounts add-iam-policy-binding "$(sa_email sa-github)" --project="$PROJECT_ID" \
  --member="serviceAccount:$(sa_email sa-deployer)" --role=roles/iam.serviceAccountUser >/dev/null
echo "sa-deployer ← roles/iam.serviceAccountUser（sa-github）"

for s in github-app-private-key github-app-client-secret; do
  gcloud secrets describe "$s" --project="$PROJECT_ID" >/dev/null 2>&1 ||
    gcloud secrets create "$s" --project="$PROJECT_ID" --replication-policy=user-managed --locations="$REGION" >/dev/null
done
# App の秘密鍵は gateway だけ（インストールのトークンを作る：ADR-002）。Client secret は app だけ（本人の確認の code の交換）
gcloud secrets add-iam-policy-binding github-app-private-key --project="$PROJECT_ID" \
  --member="serviceAccount:$(sa_email sa-gateway)" --role=roles/secretmanager.secretAccessor >/dev/null
echo "github-app-private-key ← sa-gateway"
gcloud secrets add-iam-policy-binding github-app-client-secret --project="$PROJECT_ID" \
  --member="serviceAccount:$(sa_email sa-app)" --role=roles/secretmanager.secretAccessor >/dev/null
echo "github-app-client-secret ← sa-app"
for s in github-app-private-key github-app-client-secret; do
  [[ -n "$(gcloud secrets versions list "$s" --project="$PROJECT_ID" --limit=1 --format='value(name)')" ]] ||
    echo "注意：$s に値がまだない（GitHub App の画面で作った値を「新しいバージョン」で入れる。入れたら GitHub の変数 GH_APP_ID・GH_APP_CLIENT_ID・GH_APP_SLUG と DEPLOY_GITHUB=true を入れる）"
done
