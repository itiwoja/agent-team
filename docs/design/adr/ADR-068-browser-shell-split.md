# ADR-068：ブラウザとターミナルを別のコンテナにする。VM は 2 つのコンテナの組
- 状態：承認（v1.4） ／ 日付：2026-10-24 ／ 決定者：ユーザー（D-326）
- 影響する ID：REQ-094, REQ-104, FR-074, FR-079, FR-086, FR-100, NFR-062, NFR-066, NFR-075, API-111, API-117, API-118, SCR-023, R-100
- 置き換えるもの：[ADR-043](ADR-043-box-container.md)・[ADR-045](ADR-045-egress.md)・[ADR-054](ADR-054-terminal-in-vm.md)・[ADR-060](ADR-060-one-persistent-vm.md)・[ADR-061](ADR-061-vm-no-judge-restore.md) の一部（利用者の分け方・egress の資格・サンドボックス・ホスト前提の検査）

## 状況
v1.3 の VM は 1 つのコンテナ `box` に Chromium とコマンドの実行を同居させ、利用者 `browser` と `agent` で分けていた。同じコンテナの中で分けるには、起動役（`box-init`）に `CAP_SETUID`・`CAP_SETGID` を持たせて手放す、トークンや鍵を fd で渡す、`hidepid` を使う、X の抽象名前空間のソケットを閉じて鍵で確かめる、egress の資格を 2 種類持たせる、専用の AppArmor とホストの sysctl の確かめ、ホストへの入りを断る規則の検査、が要った。R-95（ホスト前提）・R-96（起動役の capability）・R-99（Docker が別の VM）はこの仕掛け自身が生んだもので、持ち主 1 人・ホスト 1 台の前提には重かった。

## 決定
VM は引き続き「持ち主に 1 台」と呼び、画面でも「VM」1 つとして見せる。中身は 2 つのコンテナの組にする。

| コンテナ | 中身 | 利用者 | ボリューム | 資源 |
|---|---|---|---|---|
| `box-browser` | Xvfb（1280×800、`-nolisten tcp`）・軽いウィンドウマネージャ・Chromium（キオスク）・x11vnc＋websockify・box-agent | 権限なしの `browser` | `makase-browser-profile`（`/home/browser`） | メモリ 1.5GB・CPU 1.5・プロセス 512 |
| `box-shell` | bash・git・Node・Python・よく使う CLI・shell-agent（コマンドの実行・tar の出し入れ） | 権限なしの `agent` | `makase-vm-home`（`/home/agent`） | メモリ 1GB・CPU 1・プロセス 256 |

- 共通：capability なし・`no-new-privileges`・ルートは読み取りだけ（ホームと `/tmp` だけ書ける）・box ネットワーク（`internal: true`）だけ・外の名前は引かない（名前は egress が引く。コンテナ名 `shell` だけは Docker の内蔵 DNS で引ける。両立は実装のときに確かめる）・Docker の既定の seccomp。2 つは 1 つの世代（`boxes` の 1 行）として box-manager が一緒に起こし、一緒に止める。どちらかが落ちたら世代ごと `failed`
- egress の許可リストは資格ではなく送り元のコンテナで分ける。`box-browser` からはアドレスの判定だけ、`box-shell` からは `terminal.allow_hosts`。知らない送り元は断る
- VM の中で作ったページの点検：簡易サーバーは `box-shell` で立て、Chromium は `http://shell:8000`〜`8099` を開く。`--proxy-bypass-list` に `shell` を書き、このホストだけ egress を通さない
- Chromium のサンドボックス：`box-browser` に `makase-browser-seccomp.json`（`CLONE_NEWUSER` を許すもの）を付ける。専用の AppArmor・ホストの sysctl の確かめ・`sandbox_unavailable` での起動拒否はやめる。使えないホストでは `--no-sandbox` で起こし、API-111 とホストの状態欄（SCR-023）に「ブラウザのサンドボックスなし」を出す。境界はコンテナの隔離
- ホストへの入りを断る規則：box-manager の確かめ・`isolated` モードの判定・503 `HOST_ISOLATION_MISSING` をやめる。手順書に「`isolated` モードが使える版なら Compose に書く。使えない版では、ブリッジからホストへの入りを捨てる規則を 1 行入れることを勧める（任意）」と書くだけにする。WSL2 は WSL の中の Docker Engine を推奨し、Docker Desktop も可
- 控え（FR-100）は `makase-browser-profile` と `makase-vm-home` を 1 つの tar（zstd。中は `browser/` と `home/`）にする。4GB の上限は 2 つの合計
- 要らなくなるもの：起動役・`CAP_SETUID`/`CAP_SETGID`・fd 渡し・`hidepid`・X の抽象ソケットと Xauthority の鍵・egress の資格 2 種（`EGRESS_SECRET`・`Fetch.authRequired`）・`127.0.0.1` の 100 個並べと `<-loopback>`

## 代替案
| 案 | 良い点 | 悪い点 | 不採用の理由 |
|---|---|---|---|
| 1 コンテナのまま、重い検査だけ落とす | 作りが今のまま | 利用者を分ける仕掛け（起動役・capability・鍵・資格）が残り、落とした検査の分だけ守りが抜ける | 仕掛けが要る理由（同居）を無くすほうが小さい |
| 今のまま（v1.3） | 守りが厚い | R-95・R-96・R-99 を生み、置き先ごとに VM が起きない | 持ち主 1 人・ホスト 1 台に対して重い |

## 影響
- ADR-043・045・061 は「承認」のまま、末尾に v1.4 の追記を入れた。ADR-060 は「一部置き換え済み」、ADR-054 は「一部置き換え済み（→ 061・068）」
- 07 のコンテナ図は Docker Compose で 7 種類（Tailscale・本体・box-manager・Docker の中継・egress・box-browser・box-shell）になる
- R-95・R-96・R-99 を消し、R-100（サンドボックスなしの Chromium）を足す
- 隔離の試験（11 §11）は、消した仕掛けの試験を消し、`box-shell` から `box-browser` に届かないこと・`box-shell` の通信が許可リスト外に出られないこと・`shell:8000` だけが egress を通さず開けること・`box-browser` から shell-agent にトークンなしで何もできないことを入れる
- 実装のときに確かめる：box-manager が egress に 2 つのアドレスを伝える方法（内部 API か固定アドレス）、Docker の既定の seccomp で Chromium のサンドボックスが動くかどうか

## ステップ1.1の実測（2026-10-26）

WSL2・amd64、Docker 29.8.1、Debian Chromium 156.0.8078.47で、既定seccompは`No usable sandbox!`で終了1、[専用seccomp](../../../docker/makase-browser-seccomp.md)は同じ非root・cap-drop ALL・read-only条件で起動した。rendererの入れ子のPID namespaceと追加seccompフィルタ、診断起動時の`chrome://sandbox`のPID/NET・Seccomp-BPF有効を確認した。[記録](../../implementation/records/step-1.1-wsl2.md)参照。arm64とegressの送り元識別は未検証。
