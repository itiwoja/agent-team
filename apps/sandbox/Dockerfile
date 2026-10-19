# 作業場（サンドボックス）の実行役のイメージ（docker の作業場。D-116）。形はルートの Dockerfile と同じ（ビルドせず .ts をそのまま動かす：G-12）。
# ビルド：docker build -f apps/sandbox/Dockerfile -t sandbox .（リポジトリのルートで）
# 中身：Node.js（実行役と、作業場の node・npm）と Python 3（pip）。認証情報は入れない。
# 実行役は root で動き、コマンドは権限のない利用者 sandbox（uid 10001）で動かす。通信の制限は docker の網の側

# ベースイメージは digest で固定する（15 §サプライチェーン、D-50）。ルートの Dockerfile と同じ値にそろえる
ARG NODE_IMAGE=node:22.23.3-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM ${NODE_IMAGE} AS fetch
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch --prod

FROM fetch AS prod
COPY apps/sandbox apps/sandbox
COPY packages packages
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter "@open-team/sandbox-runner..." \
 && find apps packages -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete \
 && find apps packages -type d -exec chmod 755 {} + \
 && find apps packages -type f -exec chmod 644 {} +

FROM ${NODE_IMAGE}
# 作業場で使う道具（Python と pip・証明書・git・よく使うコマンド）
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates git curl jq \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 sandbox \
 && useradd -u 10001 -g 10001 -M -d /workspace -s /bin/sh sandbox \
 && mkdir -p /workspace \
 && chown sandbox:sandbox /workspace
ENV NODE_ENV=production SANDBOX_ROOT=/workspace SANDBOX_RUN_AS_UID=10001 SANDBOX_RUN_AS_GID=10001
WORKDIR /srv
COPY --from=prod /repo/node_modules ./node_modules
COPY --from=prod /repo/packages ./packages
COPY --from=prod /repo/apps/sandbox ./apps/sandbox
WORKDIR /srv/apps/sandbox
CMD ["node", "src/main.ts"]
