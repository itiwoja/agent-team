#!/bin/bash
# 手順1.2の起動役。ChromiumとCDPはbox-agentが所有する。
# Dockerの--initと併用し、root・任意引数では起動しない。
set +x
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

# 外部コマンドを1つでも起こす前に、資格を非export変数へ退避する。
# unsetは初期環境の/proc上での秘匿まで保証するものではない。
browser_token=${BROWSER_TOKEN-}
export -n browser_token
unset BROWSER_TOKEN SHELL_TOKEN
[[ -n "$browser_token" ]] || fail 'BROWSER_TOKENは空でない値が必要です。'
export CONTROL_EPOCH=${CONTROL_EPOCH-0}
[[ $CONTROL_EPOCH =~ ^(0|[1-9][0-9]*)$ ]] || fail 'CONTROL_EPOCHは非負のsafe integerが必要です。'
[[ ${#CONTROL_EPOCH} -lt 16 || (${#CONTROL_EPOCH} -eq 16 && "$CONTROL_EPOCH" < 9007199254740992) ]] \
  || fail 'CONTROL_EPOCHは非負のsafe integerが必要です。'
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
  deadline=$((SECONDS + 5))
  # 押下キー・ボタンの解放にはXが要る。agentの4秒deadlineを先に待ち、
  # その間はX/WM/VNCを維持する。全体の停止猶予は従来どおり約5秒。
  for pid in "${child_pids[@]}"; do
    if [[ ${child_names[$pid]} == box-agent ]]; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      while ((SECONDS < deadline)); do
        if ! kill -0 -- "-$pid" 2>/dev/null && ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 0.05
      done
      break
    fi
  done
  # setsidで分けたプロセスグループを逆順に止め、Chromiumの孫も対象にする。
  for ((index=${#child_pids[@]}-1; index>=0; index--)); do
    pid=${child_pids[index]}
    # setsidがまだ実行前なら、グループでなく直接の子へ送る。
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  done
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
  # 明示的にstdinを継承し、box-agentだけは下の匿名pipeから資格を受け取る。
  setsid "$@" <&0 &
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
  fail "$name が${seconds}秒以内に準備できませんでした。全体を停止します。"
}

x_ready() {
  timeout --kill-after=1s 1s xdpyinfo -display "$DISPLAY"
}

wm_ready() {
  timeout --kill-after=1s 1s xprop -root _NET_SUPPORTING_WM_CHECK | grep -q 'window id # 0x[1-9a-fA-F]'
}

vnc_ready() {
  timeout --kill-after=1s 2s python3 -c '
import socket
with socket.create_connection(("127.0.0.1", 5900), timeout=0.5) as sock:
    assert sock.recv(12).startswith(b"RFB ")
'
}

agent_ready() {
  # 資格はargvにもtimeoutの環境にも置かず、Nodeのstdinへ渡す。
  # 200以外（X/CDPの準備中の503を含む）はまだ準備完了としない。
  printf '%s' "$browser_token" | timeout --kill-after=1s 2s node --input-type=module -e '
import { readFileSync } from "node:fs";
import { get } from "node:http";
const token = readFileSync(0, "utf8");
const request = get("http://127.0.0.1:6080/healthz", {
  headers: { Authorization: `Bearer ${token}` },
}, (response) => process.exit(response.statusCode === 200 ? 0 : 1));
request.on("error", () => process.exit(1));
request.setTimeout(1000, () => request.destroy());
'
}

# Singletonの除去はbox-agentがプロフィールの排他を取ったあとに行う。
# ここで先に消すと、誤って同じvolumeで起こした別コンテナのロックを壊してしまう。

start_child Xvfb Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -noreset
wait_ready Xvfb 10 x_ready

# openbox-sessionは使わず、autostartや追加のデスクトップサービスを起動しない。
start_child Openbox openbox --sm-disable
wait_ready Openbox 10 wm_ready

# 生のRFBはコンテナ内loopbackだけ。外からはbox-agentの認証付き/vncを使う。
start_child x11vnc x11vnc -display "$DISPLAY" -rfbport 5900 \
  -localhost -noipv6 -forever -shared -nopw -noxdamage -nolookup
wait_ready x11vnc 10 vnc_ready

# setsidにも資格を渡さない。固定の子shellがpipeを読み、Nodeへのexec時だけ
# BROWSER_TOKENをexportする。Chromium等への環境の除去はNode側でも行う。
start_child box-agent /bin/bash -c '
  IFS= read -r -d "" BROWSER_TOKEN || exit 1
  export BROWSER_TOKEN
  exec node /srv/apps/box-agent/src/main.ts
' < <(printf '%s\0' "$browser_token")
wait_ready box-agent 30 agent_ready
unset browser_token

log '準備完了。6080のAPIと/vncはBearer認証が必須です。実アカウントでは使わないでください。'
# 正常終了も含め、主要プロセスが1つでも止まったらコンテナ全体を失敗にする。
if wait -n -p exited_pid "${child_pids[@]}"; then status=0; else status=$?; fi
fail "${child_names[${exited_pid:-0}]:-子プロセス} が終了しました（status=$status）。全体を停止します。"
