# 手順書を書いて見つけた設計の直しどころ
- プロジェクト：Agent-Team-Open ／ 手順書の版：v1（2026-10-25） ／ 設計の版：v1.4

実装手順書（[README](README.md)）を書くときに、設計書 v1.4 と今のコードを読み比べて見つけたもの。手順書の本文には書かず、ここに集めた。設計書を直すときの材料にする。各ステップの「設計に戻すこと」も合わせて見る。直したら、この一覧から消すか「済」を書く。

## 設計書の中の食い違い・不足
- **コマンド名**：11 §11・D-199 の `npm run eval:capture` はこのリポジトリでは `pnpm run`（[2](02_risky_actions.md)）
- **API-103・104**：`content_hash` を box-agent と本体のどちらが作るかが TBL-039 と API-103 で食い違う。API-104（inspect）と API-103 の `dryRun` の役割が重なる。API-103 の例の `screenshot: "<path>"` は、box-manager がデータのボリュームをつながない（D-309）のと合わない（[1](01_vm_vertical.md)・[2](02_risky_actions.md)）
- **egress**：07 は「CONNECT を受け」だけだが `http://` の絶対 URI の要求も中継が要る。Chromium は proxy の名前も引くので「外の名前を引かない」と両立させる手が要る。`terminal.allow_hosts` を egress に渡す道が設計にない（API-096 に `terminal` 欄はあるが、変えたあと egress にどう届くかが書かれていない）（[1](01_vm_vertical.md)・[7](07_terminal_pack_snapshot.md)）
- **11 §11 VM の行**に「JS で送るフォーム」の試験ページがない（R-76 は eval (3) に入れると書く）（[2](02_risky_actions.md)）
- **FR-061・092**：`tasks.delegate_reason` に理由を残すとあるが、`delegate` の引数に理由がない。`wakes.budget_class` は NOT NULL だが受付の時点の決め方が書かれていない（[4](04_resident.md)）
- **UC-054 基本フロー 6**の「閉じると決め」は D-280 の `closing_at` の名残り（D-324 で消えた）（[4](04_resident.md)）
- **09 に無い API**：監査ログの鎖の検証（UC-051。今の画面は `POST .../audit-logs/verify`）、GitHub の保護ブランチへの書き込み許可（今の画面は `PUT /connect/github/protected-write`）、エージェント作成の SSE の合図（US-051 の生成画面）（[6](06_web.md)）
- **09 の応答の形が未定**：API-120 の `system` の形と設定へのリンクの印、API-100 の件数、API-123 の `report`・`artifacts`、API-088 の `takeoverRequest`、API の書き込みカードの形（D-198）。T-1〜T-7 を画面の文に直す表がない（[6](06_web.md)）
- **ブラウザの制約**：API-121 の心拍を `sendBeacon` で送ると `X-Makase-Request` を付けられず 403 になる（`fetch` の `keepalive` を使う）。SSE の再接続で `Last-Event-ID` ヘッダーは `EventSource` では付けられない（クエリで渡す）（[6](06_web.md)）
- **API-031** の `?test=1`（購読の API で試し送り）はやや不自然で、本文の扱いが未記載（[5](05_triggers.md)・[6](06_web.md)）
- **ADR-065** の本文に v1.1 の「まとめ」・1 時間 600 件・本文のハッシュによる重複が残っている（D-318 で消した）（[5](05_triggers.md)）
- **API-144** の `:boxId` は VM が眠っているときの世代の指し方が書かれていない。「次に起こす」の意味も曖昧（[7](07_terminal_pack_snapshot.md)）
- **パック**：外すとき「`browser` の追加分を戻す」とあるが `pack_installs` に追加分を持つ列がない。旧 `TRUSTED_SKILLS` に当たるスキルの信頼の決まりが新設計にない（[7](07_terminal_pack_snapshot.md)）
- **控えの世代数**：FR-100 の図「4 つ目より古いものを `deleted`」と TBL-052「`ready` は 3 つまで」は、書きかけの 1 つを含む意味なら矛盾しない（[7](07_terminal_pack_snapshot.md)）
- **Docker の版**：NFR-075 は Docker Engine 24 以上だが、`isolated` モードが使える版はもっと新しい。07 の WSL2 の行（Docker Desktop も可）と D-314 の「WSL の中の Docker Engine が正」の言い方が、D-326 で置き換えたあとも 07・NFR-075・UC-042 に残っている（[8](08_release.md)）
- **11 §11 実機の行**は NFR-067〜069・082〜084・086 で、05 の測り方の表にある NFR-081 が入っていない（[8](08_release.md)）
- **`--proxy-bypass-list` の `shell`**：07 と FR-075 はホスト単位の `shell` を書く（`shell` の全ポートが egress を通らない）が、NFR-066 は「`shell:8000`〜`8099` だけ」と書く。仕組みと文章がずれている（[1](01_vm_vertical.md)・[8](08_release.md)）
- **`steer` の区分**：FR-090 は `chat`・`approval_done` だけを `chat` の区分とするが、FR-013・TBL-042・ADR-069 は `steer`（持ち主から）も含める（[4](04_resident.md)）
- **API-096 の欄**：09 の表は `budget`・`browser`・`terminal` 欄・同時数とあるが、PATCH の本文の例に `terminal` と、SCR-023 の「上限」欄にある歩数・操作・時間が無い（[3](03_core_port.md)・[6](06_web.md)）
- **Tailscale をホストに入れるか**：D-189・NFR-081 は「Docker と Tailscale が入った機械」、UC-042 は「Tailscale のアカウントがある」。07 は `tailscale` コンテナが tailnet に入る。手順書はコンテナ側だけで足りる前提にした（[8](08_release.md)）
- **UC-042・07・NFR-075 の WSL2 の行**：「WSL の中の Docker Engine を推奨・Docker Desktop も可」のまま。D-314 は D-326 で置き換わったので、「確かめた構成」と「動くはずの構成」を分けて書き直す（[8](08_release.md)）
- **置き換え済みの決定の残り**：D-247（`attached`）は D-324 で、D-311・312 は D-323・322 で置き換え済み。手順書には入れていない

## 今のコードと設計の差（移すときに直すもの）
- `task_steps` はまだ無い（`workflows/task-run.ts` の `step.do` が同じ役）。`workspace_meta` は DROP 済み（[3](03_core_port.md)・[4](04_resident.md)）
- 1 日の区切りが `Asia/Tokyo` 固定（設計は `TZ`）（[4](04_resident.md)）
- `claude.ts` は思考のブロックを捨て、`system` を 1 本の文字列で送り、`usage` のキャッシュ項目を入力に混ぜている（D-256・ADR-066 に反する）（[4](04_resident.md)）
- `policy.ts` の `budget` は `per_day_usd`（設計は `daily_usd`・`daily_auto_usd`）。`browser` 欄がない。`judgeBrowserAction` はまだない（[2](02_risky_actions.md)・[3](03_core_port.md)）
- `workspace.max_concurrent_tasks` と 08 の `max_tasks` が別名。`newId()` は UUIDv7 でない（[3](03_core_port.md)）
- Node の版は 07 が 24、`apps/sandbox/Dockerfile` と CI は 22（[1](01_vm_vertical.md)・[8](08_release.md)）
- `packages/llm` は Gemini が中心で、`LlmRequest` に画像と構造化出力がない。`ClaudeClient` は `apps/worker/src/llm/claude.ts` にある（[1](01_vm_vertical.md)・[2](02_risky_actions.md)）
- 旧 sandbox の executor は「コマンドを取りに行く」形で、出力 20,000 字・最大 300 秒・`timeout_sec`。設計は受ける側の HTTP・64KB・120 秒・`timeoutSec`（[7](07_terminal_pack_snapshot.md)）
