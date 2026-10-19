# Cloud Run の gcal サービスのイメージ（16 §3.2・§5 増分2、15 §構成）。形は apps/sim-world/Dockerfile と同じ：
# ビルドはせず、ワークスペースの形（apps/gcal・packages/ と pnpm のシンボリックリンク）のまま入れる（G-12）。
# ビルド：docker build -f apps/gcal/Dockerfile -t gcal .（リポジトリのルートで。コンテキストはルート）
# 起動するファイルは apps/gcal/src/server.ts（PORT を読む）

# ベースイメージは digest で固定する（15 §サプライチェーン、D-50）。sim-world と同じ値にそろえる
ARG NODE_IMAGE=node:22.23.3-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# ---- pnpm と依存の取得（本番の依存だけ）----
FROM ${NODE_IMAGE} AS fetch
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch --prod

# ---- 本番の依存だけを入れたワークスペース（gcal と、gcal が使う packages/*）----
FROM fetch AS prod
COPY apps/gcal apps/gcal
COPY packages packages
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter "@open-team/gcal..." \
 && find apps packages -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete \
 && find apps packages -type d -exec chmod 755 {} + \
 && find apps packages -type f -exec chmod 644 {} +

# ---- 実行 ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080
WORKDIR /srv
COPY --from=prod /repo/node_modules ./node_modules
COPY --from=prod /repo/packages ./packages
COPY --from=prod /repo/apps/gcal ./apps/gcal
WORKDIR /srv/apps/gcal
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
