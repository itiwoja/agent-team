#!/usr/bin/env bash
# Windows 側の Android エミュレーターを起動し、WSL の Vite（5173）を見られるようにする。
# GPU を既定（auto→lavapipe）のままにすると起動が止まるので、swiftshader を使う。
# EMU_FLAGS=-no-window で画面なし起動（Orca のペインに映すとき）。
set -eu
SDK=/mnt/c/Users/1kkim/AppData/Local/Android/Sdk
ADB=$SDK/platform-tools/adb.exe
cd /mnt/c
# 固まって offline のまま残ったエミュレーターがあると二重起動になって永遠に待つので、先に落とす
if "$ADB" devices | grep -q 'emulator-.*offline'; then
  echo "killing hung (offline) emulator"
  taskkill.exe /F /IM qemu-system-x86_64-headless.exe >/dev/null 2>&1 || true
  taskkill.exe /F /IM qemu-system-x86_64.exe >/dev/null 2>&1 || true
  taskkill.exe /F /IM emulator.exe >/dev/null 2>&1 || true
  sleep 3
fi
if ! "$ADB" devices | grep -q 'emulator-.*device.\?$'; then
  powershell.exe -NoProfile -Command 'Start-Process -FilePath "$env:LOCALAPPDATA\Android\Sdk\emulator\emulator.exe" -ArgumentList "-avd","Pixel_7_API_36","-gpu","swiftshader","-no-metrics"'"${EMU_FLAGS:+,\"$EMU_FLAGS\"}"
  "$ADB" wait-for-device
  until [ "$("$ADB" shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
fi
"$ADB" reverse tcp:5173 tcp:5173 >/dev/null
"$ADB" shell am start -a android.intent.action.VIEW -d "'http://localhost:5173/#${1:-/agents}'" >/dev/null
echo "opened http://localhost:5173/#${1:-/agents}"
