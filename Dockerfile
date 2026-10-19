# Cloud Run の app サービスのイメージ（15 §構成、D-52）。ビルドはしない：Node の型の除去で .ts をそのまま動かす。
# ワークスペースの形（apps/・packages/ と pnpm の node_modules のシンボリックリンク）のまま入れる。
# pnpm deploy は packages/ を node_modules の中に写し、Node は node_modules の中の .ts の型を除かないので使わない（G-12）。
# ビルド：docker build -t app .（リポジトリのルートで）

# ベースイメージは digest で固定する（15 §サプライチェーン、D-50）。2つのステージとも同じもの。
# 更新するとき：docker buildx imagetools inspect node:22-slim の Digest と、その版（node --version）に書き換える
ARG NODE_IMAGE=node:22.23.3-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

# ---- pnpm と依存の取得（lockfile だけで取る。lockfile が変わらなければこの層を使い回す）----
FROM ${NODE_IMAGE} AS fetch
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# package.json の packageManager の版の pnpm を入れる。pnpm-workspace.yaml の設定（3日待ち・install スクリプトなし）が効く
RUN corepack install && pnpm fetch

# ---- 画面（apps/web）を vite で組む（devDependencies が要る）----
FROM fetch AS web
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN pnpm install --offline --frozen-lockfile --filter "@open-team/web..." \
 && pnpm --filter @open-team/web run build

# ---- 本番の依存だけを入れたワークスペース（app と、app が使う packages/*）----
# pnpm fetch の node_modules には devDependencies も入っているので消し、ストアから本番の依存だけを入れ直す。
# 書き込みの権限は持ち主（root）だけにする（実行の node ユーザーがコードを書き換えられないように）
FROM fetch AS prod
COPY apps apps
COPY packages packages
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter "@open-team/app..." \
 && find apps packages -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete \
 && find apps packages -type d -exec chmod 755 {} + \
 && find apps packages -type f -exec chmod 644 {} +

# ---- 実行 ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080 WEB_DIST=/srv/web
WORKDIR /srv
COPY --from=prod /repo/node_modules ./node_modules
COPY --from=prod /repo/packages ./packages
COPY --from=prod /repo/apps/app ./apps/app
COPY --from=web /repo/apps/web/dist ./web
WORKDIR /srv/apps/app
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
