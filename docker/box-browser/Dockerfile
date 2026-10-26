# 手順1.1の単独検証用。リポジトリのルートでビルドする。
# docker build -f docker/box-browser/Dockerfile -t makase-s1-box-browser .
# 2026-10-26にDocker Hubで確認したmulti-platform index（amd64・arm64対応）。
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates chromium fonts-noto-cjk openbox \
      python3 util-linux websockify x11-utils x11vnc xdotool xvfb \
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

ENV HOME=/home/browser \
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
