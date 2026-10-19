#!/usr/bin/env bash
# docs/submission/architecture.md の Mermaid 図を PNG / SVG にして docs/submission/img/ に出力する。
#
# 使い方:
#   docs/submission/render-diagrams.sh [Chrome のパス] [日本語フォントのディレクトリ]
#
# 既定値:
#   Chrome  : ~/.cache/ms-playwright 配下の chrome-headless-shell（無ければ ~/.cache/puppeteer 配下）
#   フォント: /mnt/c/Windows/Fonts（WSL に日本語フォントが無いので Windows 側を fontconfig で読ませる）
#
# 補足:
#   - 図の本文は外に送らない（ローカルの Chrome で描画する）。npx による mermaid-cli の取得のみ通信する。
#   - Chrome の共有ライブラリが足りないときは、LD_LIBRARY_PATH を環境変数で渡す。
#   - 出力: img/architecture-1.{png,svg}, img/architecture-2.{png,svg}（冪等。毎回上書きする）
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/architecture.md"
out="$here/img"

chrome="${1:-}"
fonts="${2:-/mnt/c/Windows/Fonts}"

if [ -z "$chrome" ]; then
  for c in "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell \
           "$HOME"/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell; do
    if [ -x "$c" ]; then chrome="$c"; break; fi
  done
fi
[ -n "$chrome" ] && [ -x "$chrome" ] || { echo "Chrome (chrome-headless-shell) が見つかりません。第1引数で指定してください" >&2; exit 1; }
[ -d "$fonts" ] || { echo "フォントのディレクトリが見つかりません: $fonts" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>$fonts</dir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>
EOF
cat > "$work/puppeteer.json" <<EOF
{"executablePath": "$chrome", "args": ["--no-sandbox"]}
EOF
# htmlLabels=false: foreignObject を使わず、どのビューアでも崩れない SVG にする
cat > "$work/mermaid.json" <<'EOF'
{"theme": "neutral", "themeVariables": {"fontFamily": "Noto Sans JP, Yu Gothic, Meiryo"}, "flowchart": {"htmlLabels": false, "wrappingWidth": 360}}
EOF

export FONTCONFIG_FILE="$work/fonts.conf"
mkdir -p "$out"

for ext in png svg; do
  npx -y @mermaid-js/mermaid-cli@12 \
    -i "$src" -o "$work/architecture.md" -e "$ext" \
    -s 2 -b white -p "$work/puppeteer.json" -c "$work/mermaid.json"
done

for n in 1 2; do
  for ext in png svg; do
    cp "$work/architecture-$n.$ext" "$out/architecture-$n.$ext"
  done
done
echo "出力: $out"
