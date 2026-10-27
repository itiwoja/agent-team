# box-browser（手順1.2・ローカル検証限定）

手順1.2のビルド・起動・CDP・APIをWSL2・amd64で検証済み。単体297件、API通し19項目、終了・異常停止7ケースが成功した（[実測記録](../../docs/implementation/records/step-1.2-wsl2.md)）。手順1.1の実測は[当時の記録](../../docs/implementation/records/step-1.1-wsl2.md)として残すが、その無認証noVNC接続手順は現在の構成には使えない。

Xvfb → Openbox → x11vnc → box-agentを `browser`（uid/gid 10000）で起動する。Chromiumの起動とCDPのfd 3・4のpipeはNodeのbox-agentが所有し、bashからは起動しない。websockifyを撤去し、同じ6080でAPIと認証付きVNC中継を受ける。CDPのTCPデバッグポートは開かない。

**実アカウント・実パスワード・実カード情報では使わず、ローカルのダミー試験ページだけを操作する。** 認証はあっても、秘密領域の撮影前マスク・操作判定・交代はステップ2以降であり、1.2のスクショは秘密を隠さない。6080は必ずホストの127.0.0.1に限定する。

## ビルドと起動

リポジトリのルートで実行する。`docker/makase-browser-seccomp.json` が必要。

```sh
docker build -f docker/box-browser/Dockerfile -t makase-s1-box-browser .

# 世代ごとに新しく生成する。値を表示・ファイル保存せず、set -xも使わない。
export BROWSER_TOKEN="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("hex"))')"

docker run --detach --rm --init --name makase-s1-browser \
  --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp=docker/makase-browser-seccomp.json \
  --shm-size 512m --memory 1.5g --cpus 1.5 --pids-limit 512 \
  --mount type=volume,src=makase-s1-browser-profile,dst=/home/browser \
  --mount type=volume,dst=/tmp \
  -p 127.0.0.1:6080:6080 \
  -e BROWSER_TOKEN -e CONTROL_EPOCH=0 \
  makase-s1-box-browser
```

- `BROWSER_TOKEN` は空を拒否する。`CONTROL_EPOCH` は既定0で、非負のsafe integer（上限9007199254740991、10進・先頭0なし）だけを受ける。`SHELL_TOKEN` は不要であり、渡さない。
- 起動スクリプトは外部コマンドの前に資格を非export変数へ退避し、環境から `BROWSER_TOKEN`・`SHELL_TOKEN` を除く。固定の子shellが匿名pipeを読み、Nodeへexecするときだけ `BROWSER_TOKEN` を環境で渡す。Xvfb・WM・VNC・setsidの環境やargvへは渡さず、NodeもChromium等の子から資格を除く。Dockerの設定やプロセスの初期環境を読める管理者から資格を隠す保証ではない。
- `BROWSER_PROXY_URL` は未設定・空なら1.2〜1.3の試験用にproxyフラグを外す。設定時はbackendが `http://egress:3128` の固定egressを検証し、shellだけをbypassする。任意の外部proxyを選ぶ設定ではない。
- 通常のbridgeネットワークでの使い捨て試験であり、1.4以降の外向き通信隔離ではない。proxyやバックグラウンド通信抑制フラグだけでネットワークの強制遮断にはならない。同じネットワークの別コンテナから6080へ届くが、全口でブラウザ資格が必要。
- `docker stop --timeout 10 makase-s1-browser` で停止する。`--rm` は匿名 `/tmp` volumeを削除し、名前つきプロフィールは残す。`/tmp` をtmpfsにしない。キャッシュは暫定で `/tmp/chromium-cache`・512MiBを指定するが、ディスク容量の厳密な上限ではない（1.7で実測予定）。
- 空のvolumeへのDockerのcopy-upで、`/home/browser` のuid/gid 10000と `/tmp` のmode 1777・root所有の `.X11-unix` を継承する。`volume-nocopy` やroot所有の既存volume・bind mountは使わない。起動時にrootへ昇格してchownする経路はない。
- プロフィールの同時共有は禁止。box-agentが `flock` の排他を取得してから `SingletonLock`・`SingletonSocket`・`SingletonCookie` だけを除去する。初期プロフィールのページ倍率は100%、device scaleは1。既存プロフィールやユーザー操作によるページズームを固定するpolicyは入れていないので、実際の倍率は別途確認する。
- 起動引数によるコマンド・URL・Chromiumフラグの上書きは受け付けない。sandboxの判定と再起動はbackendの責務で、**sandboxが本当に利用不能な場合だけ** `--no-sandbox` で1回retryし、状態を応答に載せる。policy拒否・CDP準備失敗・一般の起動失敗ではsandboxを落とさない。`--disable-dev-shm-usage` も付けず、512MiBの `/dev/shm` を使う。

既定seccompとの比較は、停止後に**専用seccompの行だけを省略し**、別のコンテナ名・新しいプロフィール名・新しいトークンで同じ起動を試す。専用で `sandbox: true`、既定で本当に利用不能な場合だけ `sandbox: false` となることを実機で確かめる。結果はホスト依存であり、sysctl・AppArmor・capabilityを緩めて成功扱いにしない。

## 内部APIと試験ページ

全口に `Authorization: Bearer <BROWSER_TOKEN>` が必須。HTMLは配信しない。

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/healthz` | XとCDPの準備中は503、準備完了後だけ200 |
| POST | `/actions` | `{ actionId, controlEpoch, action: { kind, ... } }` で1操作 |
| GET | `/screenshot` | 1280×800の `image/png` |
| WebSocket | `/vnc` | 認証後にコンテナ内 `127.0.0.1:5900` のRFBを中継 |

`dryRun`・`expect`・inspectは未対応。`dryRun: false`・`expect: null` も送らず、指定した場合は拒否される。同じ世代の同じ `actionId`・同じ内容は再実行せず結果を再利用し、内容が違えば409 `ACTION_CONFLICT`。古い `controlEpoch` はキャッシュより先に409 `STALE_CONTROL`。`open_url` はhttp/httpsだけを受け、file/javascript/chrome等は拒否する。

`action`の`kind`と追加フィールド：

| 操作 | 追加フィールド |
|---|---|
| `screenshot`・`read_page`・`cursor_position` | なし |
| `mouse_move`・`left_click`・`right_click`・`middle_click`・`double_click`・`triple_click` | `x`, `y`（1280×800内の整数座標） |
| `left_mouse_down`・`left_mouse_up` | なし。現在のカーソル位置を使う |
| `left_click_drag` | `startX`, `startY`, `x`, `y` |
| `type` | `text`（UTF-8で最大16,000bytes） |
| `key` | `text`（例：`ctrl+a`, `Return`） |
| `hold_key` | `text`, `duration`（0〜10秒） |
| `scroll` | `direction`（up/down/left/right）, `amount`（1〜100）。任意の`x`, `y`はペアで指定 |
| `wait` | `duration`（0〜10秒） |
| `open_url` | `url`（http/https、最大4096文字） |

`read_page`は主frameの要素を最大200件・応答JSON全体16KiBで返す。名前は最大512文字、通常入力の値は最大1024文字。passwordと秘密のautocomplete属性（current-password/new-password/cc-number/cc-csc/cc-exp）は値を省略する。iframe内部や可視領域を確認できない複雑な変形・clipは後続対応。操作結果は世代中1000件または32MiBに達すると新規IDを503 `ACTION_CAPACITY`で止め、既存IDの結果は保持する。

`type`は日本語の欠落を避けるため、一時CLIPBOARD＋固定Ctrl+Vを使う（D-408）。本文は固定Python補助のstdinだけへ渡し、転送後に補助と所有権を解放する。既存CLIPBOARDは上書きして復元しないため、paste禁止ページとの互換性には差がある。空文字では変更しない。`open_url`の成功は遷移開始までで、ロード完了は`read_page`等で確認する。

同じ環境変数を持つホストのshellから呼ぶ例（起動コマンドを別端末で実行する場合、資格をログ・履歴へ貼り付けない）：

```sh
# ヘッダーをstdinで渡し、curlのargvへ資格を載せない。
auth_curl() {
  printf 'Authorization: Bearer %s\n' "$BROWSER_TOKEN" |
    curl --fail-with-body --silent --show-error --header @- "$@"
}
auth_curl http://127.0.0.1:6080/healthz
auth_curl -H 'Content-Type: application/json' \
  --data '{"actionId":"fixture-open-1","controlEpoch":0,"action":{"kind":"open_url","url":"http://shell:8000/"}}' \
  http://127.0.0.1:6080/actions
auth_curl -H 'Content-Type: application/json' \
  --data '{"actionId":"fixture-read-1","controlEpoch":0,"action":{"kind":"read_page"}}' \
  http://127.0.0.1:6080/actions
auth_curl --output /tmp/box-agent.png http://127.0.0.1:6080/screenshot
# 無資格は拒否されることを確認する（この呼び出しは401）。
curl --silent --output /dev/null --write-out '%{http_code}\n' http://127.0.0.1:6080/healthz
```

上の `shell:8000` は試験HTTPサーバーが起動済みで、コンテナから名前が引けることが前提。試験ページは [`evals/pages/`](../../evals/pages/) の8枚で、1.6の一覧に対応する。index・秘密入力のダミー値・購入回数・Cookie保存・同一origin iframe・alert/confirm・新規タブ・canvasを用意し、外部送信しない。`password.html` の秘密欄は `read_page` の返却値除外を調べるためのダミーで、撮影マスクの保証ではない。

1.2の単独試験では手元の試験コンテナ等で `python3 -m http.server 8000 --directory <evals/pagesの配置先>` を起動し、Chromiumから届くHTTP URLを指定する。試験サーバーを公開ネットワークに公開しない。1.6では[定めた配り方](../../docs/implementation/01_vm_vertical.md#16-cli-から-computer-use-のループを回して試験ページを操作する)に従ってbox-shellへコピーする。`docker/box-browser/test-page.html` は1.1の表示試験用として保持する。

通し検査はNode 24とインストール済みのworkspace依存を使い、ビルド後に次を直列実行する。各検査は自分専用のコンテナ・volumeを作り、終了時に回収する。画像・ログ・結果は `/tmp/opencode/box-agent-*-check-*` に残る。

```sh
node apps/box-agent/test/vm-check.mjs makase-s1-box-browser
node apps/box-agent/test/lifecycle-check.mjs makase-s1-box-browser
```

前者は認証・操作・ASCII/日本語・上限16000bytesの入力・秘密値除外・冪等性・新タブ・dialog・同profile再作成、後者はsandbox fallback・主要子の異常終了・押下保持中のTERM・INT/HUPを検査する。既定seccompでもsandboxが利用できるホストでは、後者はfallback未検証として終了コード2を返す。

**noVNCの直結は不可**。ブラウザのWebSocket APIではこのAuthorizationヘッダーを付けられず、URLクエリ・subprotocol・Cookieを資格の代わりにしない。1.5のbox-manager（API-106）が内部Bearerを付けて中継するまで、noVNC接続は待つ。x11vncの5900はコンテナ内loopback限定でホストへ公開せず、XのTCPも無効。noVNCクライアントはイメージに含まない。

## 固定したベースと依存

2026-10-26に `docker buildx imagetools inspect node:24.21.0-bookworm-slim` で実在を確認した。

| 対象 | digest |
|---|---|
| Dockerfileに固定したmulti-platform index | `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` |
| linux/amd64 manifest | `sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd` |
| linux/arm64/v8 manifest | `sha256:ba6b7d0ee561d9d49deb99e2b93c98632cc287b6cca1a6b18d66127054efa4dc` |

pnpmはrootの `packageManager` とlockfileに従い、複数stageでbox-agentの本番依存 `ws` だけを最終イメージへ入れる。Node 24が `/srv/apps/box-agent/src/main.ts` を直接実行し、TypeScriptのコンパイル・テスト・開発依存は最終イメージに含めない。

Debian bookwormの `chromium`・`xvfb`・`x11vnc`・`xdotool`・`openbox`・`fonts-noto-cjk` を使う。`imagemagick` の `import -window root` でダイアログを含むX画面を撮る。`x11-utils` は準備確認、`util-linux` の `setsid` はプロセスグループごとの終了に使う。websockifyは入れない。Debianパッケージの版は固定していないため、ベースdigestだけでビルド全体の同一性は保証しない。実機検証では `chromium --version` と `dpkg-query` の版を記録する。

## 制限と残る範囲

`policies/managed.json` をroot所有・読取り専用の `/etc/chromium/policies/managed/box-browser.json` に置く。架空の `--disable-webrtc` や `--disable-devtools` は使わない。

| 対象 | 設定・効く範囲 |
|---|---|
| QUIC | `QuicAllowed: false` と `--disable-quic` |
| WebRTC | `WebRtcIPHandling: disable_non_proxied_udp` と同名の強制フラグ。非プロキシUDPを制限するが、**WebRTC API・TCP経路・データチャネルの全面禁止ではない**。完全な通信隔離は未実装。 |
| 音声・映像・画面 | `AudioCaptureAllowed`・`VideoCaptureAllowed`・`ScreenCaptureAllowed: false`。許可先リストは入れない。 |
| DevTools | **D-406：ユーザーがCDP pipeを優先する方針を選択**し、`DeveloperToolsAvailability: 1` に変更。`2` はCDPも拒否するため併用しない。導入版では固定 `--kiosk` がDevTools画面の作成を拒否することを[実測](../../docs/implementation/records/step-1.2-wsl2.md#devtools画面の抑止)。policyによる全面禁止とは区別し、Chromium更新時に再検証する。TCPのデバッグ口は開かない。 |
| ダウンロード | `DownloadRestrictions: 3`。このpolicy単独では表示ページの保存・PDF印刷を禁止しないため、`AllowFileSelectionDialogs: false` と `PrintingEnabled: false` を併用する。全ファイル書込みをOSで禁止するものではなく、プロフィールは書込み可能。 |
| 権限要求 | 位置・通知・Bluetooth・USB・HID・Serial・File Systemの各既定policyを拒否値 `2` にする。加えて実在する `--deny-permission-prompts`（要求時に表示せず拒否）を付ける。すべてのWeb APIやブラウザのダイアログの無効化を保証するものではない。 |
| ページズーム | 初期プロフィールの100%とdevice scale 1まで。ユーザー操作や既存プロフィールを含む**恒久的な100%固定は未達**。 |
| その他 | サインイン・同期・パスワード保存・バックグラウンド常駐・予測通信をpolicyで停止する。 |

根拠（2026-10-26に上流定義を確認。導入したDebian版での適用は `chrome://policy` 等で別途検証する）：

- [Chromium policy定義](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/)（`Miscellaneous`・`ContentSettings`・`ScreenCapture`・`WebRtc`・`Printing`・`PasswordManager`）
- [WebRtcIPHandling](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/WebRtc/WebRtcIPHandling.yaml)
- [DownloadRestrictions](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/Miscellaneous/DownloadRestrictions.yaml)
- [DeveloperToolsAvailability](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/Miscellaneous/DeveloperToolsAvailability.yaml)
- [deny-permission-prompts](https://chromium.googlesource.com/chromium/src/+/main/components/permissions/switches.cc)
- [force-webrtc-ip-handling-policy](https://chromium.googlesource.com/chromium/src/+/main/content/public/common/content_switches.cc)

## 起動・終了の確認事項

- 各段階は準備待ちに上限を設ける（X/WM/VNC各10秒、box-agentは約30秒。1回のプローブにもtimeout）。box-agentは資格付き `/healthz` の200だけを準備完了とし、XとCDPが成立する前の503では進めない。healthzだけでsandboxやpolicyの有効性がすべて証明されるわけではない。
- 主要な子が正常・異常を問わず終了したら全体を失敗終了する。TERM/INT/HUPでは先にagentへTERMを送り、X/WM/VNCを維持して押下状態の解放を待つ。その後ほかのグループも停止し、全体で最大約5秒後にKILLして直接の子を回収する。孫の回収はDocker `--init` を併用する。
- 最低限の静的検査：`bash -n docker/box-browser/start.sh`、`python3 -m json.tool docker/box-browser/policies/managed.json >/dev/null`。
- 上の通し検査で、既定／専用seccomp比較、API/VNCの資格拒否、子の環境/argv/ログへの資格非露出、日本語入力、秘密欄のread_page除外、冪等性、volume継承、強制停止後の再作成、シグナル終了、Chromium/agent/WM死亡時の失敗を確認済み。Chromium・イメージの更新時も同じ検査を行う。
