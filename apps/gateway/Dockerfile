# Cloud Run の gateway サービスのイメージ（15 §構成・§模擬の世界、D-52）。形はルートの Dockerfile（app）と同じ：
# ビルドはせず、ワークスペースの形（apps/gateway・packages/ と pnpm のシンボリックリンク）のまま入れる（G-12）。
# ビルド：docker build -f apps/gateway/Dockerfile -t gateway .（リポジトリのルートで。コンテキストはルート）
# 起動するファイルは apps/gateway/src/server.ts（app の src/server.ts と同じ決まり。PORT を読む）

# ベースイメージは digest で固定する（15 §サプライチェーン、D-50）。ルートの Dockerfile と同じ値にそろえる
ARG NODE_IMAGE=node:22.23.3-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# ---- pnpm と依存の取得（本番の依存だけ）----
FROM ${NODE_IMAGE} AS fetch
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch --prod

# ---- 本番の依存だけを入れたワークスペース（gateway と、gateway が使う packages/*）----
FROM fetch AS prod
COPY apps/gateway apps/gateway
COPY packages packages
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter "@open-team/gateway..." \
 && find apps packages -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete \
 && find apps packages -type d -exec chmod 755 {} + \
 && find apps packages -type f -exec chmod 644 {} +

# ---- 実行 ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080
WORKDIR /srv
COPY --from=prod /repo/node_modules ./node_modules
COPY --from=prod /repo/packages ./packages
COPY --from=prod /repo/apps/gateway ./apps/gateway
WORKDIR /srv/apps/gateway
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
