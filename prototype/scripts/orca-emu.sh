#!/usr/bin/env bash
# Orca のエミュレーターペインで open-team を開く（Orca のクイックコマンドから押す用）。
# 1. Vite（5173）が止まっていればバックグラウンドで起動
# 2. emu.sh でエミュレーターを画面なし起動 → adb reverse → URL を開く
# 3. Orca にデバイスを attach して、エミュレーターペインに映す
# AVD の config.ini は hw.gpu.mode=swiftshader + fastboot.forceColdBoot=yes にしてある（Orca が自分で起動しても固まらないように）。
# 注意: config.ini に swiftshader_indirect と書くと無効値として無視され、固まる lavapipe になる。
set -eu
cd "$(dirname "$0")/.."
ORCA=/mnt/c/Users/1kkim/AppData/Local/Programs/orca/resources/bin/orca.exe
ADB=/mnt/c/Users/1kkim/AppData/Local/Android/Sdk/platform-tools/adb.exe
LOG=/tmp/open-team-vite.log

if ! ss -ltn | grep -q ':5173 '; then
  echo "starting vite (log: $LOG)"
  nohup npm run dev >"$LOG" 2>&1 &
  until ss -ltn | grep -q ':5173 '; do sleep 1; done
fi

echo "booting emulator..."
EMU_FLAGS=-no-window bash scripts/emu.sh "${1:-/agents}"

SERIAL=$(cd /mnt/c && "$ADB" devices | awk '/^emulator-.*device\r?$/ {print $1; exit}')
(cd /mnt/c/Users/1kkim/project/dev/open-team && "$ORCA" emulator attach "$SERIAL" --json) >/dev/null \
  && echo "attached $SERIAL to Orca — open the emulator pane" \
  || echo "Orca attach failed; open the emulator pane in Orca and pick $SERIAL"
