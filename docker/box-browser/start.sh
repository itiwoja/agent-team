#!/bin/bash
# 手順1.1だけの起動役。Dockerの--initと併用し、root・任意引数では起動しない。
set -Eeuo pipefail
set +m
umask 077

log() {
  printf '[box-browser] %s\n' "$*" >&2
}

fail() {
  log "$*"
  exit 1
}

[[ $# -eq 0 ]] || fail '起動引数は受け付けません。設定はイメージ内で固定しています。'
[[ $(id -u) == 10000 && $(id -g) == 10000 ]] || fail 'browser（uid/gid 10000）で起動してください。rootでは起動しません。'

export HOME=/home/browser DISPLAY=:99
export XDG_RUNTIME_DIR=/tmp/runtime-browser
export XDG_CONFIG_HOME=/home/browser/.config
export XDG_CACHE_HOME=/tmp/xdg-cache

[[ -w "$HOME" && $(stat -c %u "$HOME") == 10000 ]] || fail '/home/browserはuid 10000所有の書込み可能なvolumeが必要です。volume-nocopyは使わないでください。'
[[ -w /tmp && $(stat -c %a /tmp) == 1777 ]] || fail '/tmpはmode 1777の書込み可能な匿名volumeが必要です。'
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" /tmp/chromium-cache
chmod 0700 "$XDG_RUNTIME_DIR"

declare -a child_pids=()
declare -A child_names=()

cleanup() {
  local status=$? pid index remaining deadline
  trap - EXIT
  trap '' TERM INT HUP
  set +e
  # setsidで分けたプロセスグループを逆順に止め、Chromiumの孫も対象にする。
  for ((index=${#child_pids[@]}-1; index>=0; index--)); do
    pid=${child_pids[index]}
    # setsidがまだ実行前なら、グループでなく直接の子へ送る。
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done
  deadline=$((SECONDS + 5))
  while ((SECONDS < deadline)); do
    remaining=0
    for pid in "${child_pids[@]}"; do
      if kill -0 -- "-$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then remaining=1; fi
    done
    ((remaining)) || break
    sleep 0.1
  done
  for pid in "${child_pids[@]}"; do
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  done
  for pid in "${child_pids[@]}"; do
    wait "$pid" 2>/dev/null
  done
  exit "$status"
}

trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

start_child() {
  local name=$1 pid
  shift
  # ジョブ制御は無効なので、setsidはforkせずにexecし、$!がグループIDになる。
  setsid "$@" &
  pid=$!
  child_pids+=("$pid")
  child_names[$pid]=$name
  log "$name を起動しました（pid=$pid）。"
}

check_children() {
  local pid status
  for pid in "${child_pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      if wait "$pid"; then status=0; else status=$?; fi
      fail "${child_names[$pid]} が起動途中で終了しました（status=$status）。全体を停止します。"
    fi
  done
}

wait_ready() {
  local name=$1 seconds=$2 deadline
  shift 2
  deadline=$((SECONDS + seconds))
  while ((SECONDS < deadline)); do
    check_children
    if "$@" >/dev/null 2>&1; then
      check_children
      log "$name の準備ができました。"
      return 0
    fi
    sleep 0.1
  done
  fail "$name が${seconds}秒以内に準備できませんでした。sandboxを無効化せず停止します。"
}

x_ready() {
  timeout --kill-after=1s 1s xdpyinfo -display "$DISPLAY"
}

wm_ready() {
  timeout --kill-after=1s 1s xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id # 0x[1-9a-fA-F]'
}

chromium_ready() {
  timeout --kill-after=1s 1s xdotool search --onlyvisible --class '[Cc]hromium'
}

vnc_ready() {
  timeout --kill-after=1s 2s python3 -c '
import socket
with socket.create_connection(("127.0.0.1", 5900), timeout=0.5) as sock:
    assert sock.recv(12).startswith(b"RFB ")
'
}

websocket_ready() {
  timeout --kill-after=1s 2s python3 -c '
import socket
with socket.create_connection(("127.0.0.1", 6080), timeout=0.5):
    pass
'
}

# 同じプロフィールを同時に複数コンテナへマウントしないこと。
rm -f -- "$HOME/SingletonLock" "$HOME/SingletonSocket" "$HOME/SingletonCookie"

start_child Xvfb Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -noreset
wait_ready Xvfb 10 x_ready

# openbox-sessionは使わず、autostartや追加のデスクトップサービスを起動しない。
start_child Openbox openbox --sm-disable
wait_ready Openbox 10 wm_ready

# Debianのラッパーが読む追加フラグを避け、実体を固定の引数で起動する。
# --no-sandbox、--disable-setuid-sandbox、CDPの口は追加しない。
# WebRTCの設定は非プロキシUDPの禁止であり、API全体の無効化ではない（README参照）。
start_child Chromium /usr/lib/chromium/chromium \
  --ozone-platform=x11 \
  --user-data-dir=/home/browser \
  --kiosk \
  --window-size=1280,800 \
  --window-position=0,0 \
  --force-device-scale-factor=1 \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-component-update \
  --disable-sync \
  --disable-extensions \
  --disable-quic \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  --deny-permission-prompts \
  --disk-cache-dir=/tmp/chromium-cache \
  --disk-cache-size=536870912 \
  --lang=ja \
  file:///opt/box-browser/test-page.html
wait_ready Chromium 30 chromium_ready

# 手順1.1だけの無認証VNC。5900はコンテナ内のloopback限定。
start_child x11vnc x11vnc -display "$DISPLAY" -rfbport 5900 \
  -localhost -noipv6 -forever -shared -nopw -noxdamage -nolookup
wait_ready x11vnc 10 vnc_ready

# noVNCのHTML/JSは入れず、WebSocketの中継だけを起こす。
start_child websockify websockify 0.0.0.0:6080 127.0.0.1:5900
wait_ready websockify 10 websocket_ready

log '準備完了。WebSocketは6080、初期画面はローカル試験ページです。sandboxの実際の状態は別途検証してください。'
# 正常終了も含め、主要プロセスが1つでも止まったらコンテナ全体を失敗にする。
if wait -n -p exited_pid "${child_pids[@]}"; then status=0; else status=$?; fi
fail "${child_names[${exited_pid:-0}]:-子プロセス} が終了しました（status=$status）。全体を停止します。"
