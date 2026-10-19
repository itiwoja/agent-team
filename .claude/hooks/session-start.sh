#!/bin/bash
# Claude Code のクラウドセッション開始時に依存を入れる（型の検査・テスト・依存の境界の検査を流せるようにする）
set -euo pipefail

# ローカルの Claude Code では何もしない（クラウドのセッションだけ）
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# package.json の packageManager（pnpm@10.27.0）を使う
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable
fi

# CI と同じく lockfile のまま入れる。3日待ち・install スクリプトなしは pnpm-workspace.yaml の設定（D-50）
pnpm install --frozen-lockfile
