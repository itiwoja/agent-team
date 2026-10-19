#!/usr/bin/env bash
# 作業場（サンドボックス。D-116）の GCP の準備。何度流しても同じ状態になる。流したあと GitHub の変数 DEPLOY_SANDBOX=true にする。
# 使い方：PROJECT_ID=hackathon-v5 PROJECT_NUMBER=123456789012 bash infra/sandbox-setup.sh
#
# 作るもの：
#   1. sa-sandbox（ロールなし。作業場の Cloud Run Jobs の実行の SA。sa-deployer がジョブに付けられる）
#   2. サブネット sandbox（作業場だけが使う。Direct VPC egress は /26 以上が要る）
#   3. Cloud Router と Cloud NAT（サブネット sandbox だけ。外へ出る口）
#   4. 網の規則（グローバルのネットワーク ファイアウォール ポリシー sandbox-egress）：サブネット sandbox から出る通信は、
#      パッケージのレジストリ（npm・PyPI）と app（sandbox-edge）の 443 だけを許し、ほかは止める
#
# 注意（要検証）：4 の FQDN の規則とソースの範囲での絞り込みは、Cloud NGFW の FQDN オブジェクトを使う。デプロイのあと、
# infra/README.md「9. 作業場」の 3（作業場から example.com に届かないこと）で必ず確かめる。届いてしまうなら DEPLOY_SANDBOX を外す
set -euo pipefail
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
PROJECT_ID="${PROJECT_ID:?PROJECT_ID を入れる}"
PROJECT_NUMBER="${PROJECT_NUMBER:?PROJECT_NUMBER を入れる（app の URL の組み立てに使う）}"
REGION="${REGION:-asia-northeast1}"
NETWORK="${NETWORK:-default}"
SANDBOX_RANGE="${SANDBOX_RANGE:-10.250.0.0/24}"
APP_HOST="app-${PROJECT_NUMBER}.${REGION}.run.app"
sa_email() { echo "$1@$PROJECT_ID.iam.gserviceaccount.com"; }

gcloud services enable run.googleapis.com compute.googleapis.com networksecurity.googleapis.com --project="$PROJECT_ID"

# ---- 1. SA（ロールなし）----
if ! gcloud iam service-accounts describe "$(sa_email sa-sandbox)" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create sa-sandbox --project="$PROJECT_ID" --display-name="open-team sa-sandbox（作業場。ロールなし）" >/dev/null
  echo "sa-sandbox：作った"
fi
# デプロイの SA がジョブに付けられる・app の SA がジョブを overrides つきで起こせる（起こす権限はジョブ単位で deploy.yml が付ける）
for sa in sa-deployer sa-app; do
  gcloud iam service-accounts add-iam-policy-binding "$(sa_email sa-sandbox)" --project="$PROJECT_ID" \
    --member="serviceAccount:$(sa_email "$sa")" --role=roles/iam.serviceAccountUser >/dev/null
  echo "$sa ← roles/iam.serviceAccountUser（sa-sandbox）"
done

# ---- 2. サブネット ----
if ! gcloud compute networks subnets describe sandbox --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1; then
  gcloud compute networks subnets create sandbox --project="$PROJECT_ID" --region="$REGION" \
    --network="$NETWORK" --range="$SANDBOX_RANGE" >/dev/null
  echo "サブネット sandbox（$SANDBOX_RANGE）：作った"
fi

# ---- 3. 外へ出る口（サブネット sandbox だけ）----
if ! gcloud compute routers describe sandbox-router --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1; then
  gcloud compute routers create sandbox-router --project="$PROJECT_ID" --region="$REGION" --network="$NETWORK" >/dev/null
  echo "Cloud Router sandbox-router：作った"
fi
if ! gcloud compute routers nats describe sandbox-nat --router=sandbox-router --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1; then
  gcloud compute routers nats create sandbox-nat --router=sandbox-router --project="$PROJECT_ID" --region="$REGION" \
    --nat-custom-subnet-ip-ranges=sandbox --auto-allocate-nat-external-ips >/dev/null
  echo "Cloud NAT sandbox-nat：作った"
fi

# ---- 4. 網の規則（サブネット sandbox から出る通信を絞る）----
if ! gcloud compute network-firewall-policies describe sandbox-egress --global --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute network-firewall-policies create sandbox-egress --global --project="$PROJECT_ID" \
    --description="作業場（サンドボックス）の外への通信：レジストリと app だけ（D-116）" >/dev/null
  gcloud compute network-firewall-policies associations create --firewall-policy=sandbox-egress --global-firewall-policy \
    --network="$NETWORK" --name=sandbox-egress-default --project="$PROJECT_ID" >/dev/null
  echo "ネットワーク ファイアウォール ポリシー sandbox-egress：作って $NETWORK に付けた"
fi
upsert_rule() {
  local priority="$1"
  shift
  if gcloud compute network-firewall-policies rules describe "$priority" --firewall-policy=sandbox-egress --global-firewall-policy --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud compute network-firewall-policies rules update "$priority" --firewall-policy=sandbox-egress --global-firewall-policy --project="$PROJECT_ID" "$@" >/dev/null
  else
    gcloud compute network-firewall-policies rules create "$priority" --firewall-policy=sandbox-egress --global-firewall-policy --project="$PROJECT_ID" "$@" >/dev/null
  fi
}
# 名前の解決（Cloud DNS のメタデータの DNS）は許す
upsert_rule 900 --direction=EGRESS --action=allow --src-ip-ranges="$SANDBOX_RANGE" --dest-ip-ranges=169.254.169.254/32 --layer4-configs=udp:53,tcp:53 \
  --description="作業場：名前の解決"
upsert_rule 1000 --direction=EGRESS --action=allow --src-ip-ranges="$SANDBOX_RANGE" \
  --dest-fqdns="registry.npmjs.org,pypi.org,files.pythonhosted.org,$APP_HOST" --layer4-configs=tcp:443 \
  --description="作業場：パッケージのレジストリと app（sandbox-edge）だけ"
upsert_rule 2000 --direction=EGRESS --action=deny --src-ip-ranges="$SANDBOX_RANGE" --dest-ip-ranges=0.0.0.0/0 --layer4-configs=all \
  --description="作業場：ほかの外への通信は止める"
echo "規則：900（DNS）・1000（レジストリと $APP_HOST の 443）・2000（ほかを止める）"

echo
echo "次：GitHub の変数 DEPLOY_SANDBOX=true にして再デプロイし、すぐ infra/README.md「9. 作業場」の 3 で、作業場から example.com に届かないことを確かめる"
