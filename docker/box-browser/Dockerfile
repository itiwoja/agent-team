# 手順1.2のローカル検証用。リポジトリのルートでビルドする。
# docker build -f docker/box-browser/Dockerfile -t makase-s1-box-browser .
# 2026-10-26にDocker Hubで確認したmulti-platform index（amd64・arm64対応）。
ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

FROM ${NODE_IMAGE} AS fetch
ENV PNPM_HOME=/pnpm COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch --prod

FROM fetch AS prod
COPY apps/box-agent/package.json apps/box-agent/package.json
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter "@open-team/box-agent..."
COPY apps/box-agent/src apps/box-agent/src
RUN find apps/box-agent/src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete \
 && find apps/box-agent -type d -exec chmod 755 {} + \
 && find apps/box-agent -type f -exec chmod 644 {} +

FROM ${NODE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates chromium fonts-noto-cjk imagemagick openbox \
      python3 util-linux x11-utils x11vnc xdotool xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10000 browser \
 && useradd --uid 10000 --gid 10000 --create-home --shell /usr/sbin/nologin browser \
 && install -d -o browser -g browser -m 0700 /home/browser /home/browser/.config \
 && chmod 1777 /tmp \
 && install -d -o root -g root -m 1777 /tmp/.X11-unix \
 && install -d -o root -g root -m 0755 /opt/box-browser /etc/chromium/policies/managed

COPY --chmod=0755 docker/box-browser/start.sh /opt/box-browser/start.sh
COPY --chmod=0644 docker/box-browser/policies/managed.json /etc/chromium/policies/managed/box-browser.json
COPY --chmod=0644 docker/box-browser/test-page.html /opt/box-browser/test-page.html
COPY --from=prod /repo/node_modules /srv/node_modules
COPY --from=prod /repo/apps/box-agent /srv/apps/box-agent

ENV NODE_ENV=production \
    HOME=/home/browser \
    DISPLAY=:99 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

USER 10000:10000
WORKDIR /home/browser
# 初回の空volumeにはイメージ側の内容・所有者・modeをコピーする。
# /tmpはtmpfsではなく匿名volume。--rmでコンテナと一緒に削除する。
VOLUME ["/home/browser", "/tmp"]
EXPOSE 6080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/box-browser/start.sh"]
