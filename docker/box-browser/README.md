# box-browser（手順1.1・ローカル検証限定）

WSL2・amd64での起動・表示・sandbox・終了処理の実測と残る仕様差分は[検証記録](../../docs/implementation/records/step-1.1-wsl2.md)を参照。noVNCクライアントの用意も同じ記録にある。

Xvfb → Openbox → Chromium → x11vnc → websockify を `browser`（uid/gid 10000）で起動する。box-agent・CDP・API・認証・egressはまだ作らない。**無認証のため実アカウントでは使わず、6080は必ずホストの127.0.0.1に限定する。** noVNCクライアントはこのイメージに含まない。

## ビルドと起動

リポジトリのルートで実行する。`docker/makase-browser-seccomp.json` が必要。

```sh
docker build -f docker/box-browser/Dockerfile -t makase-s1-box-browser .

docker run --rm --init --name makase-s1-browser \
  --read-only --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt seccomp=docker/makase-browser-seccomp.json \
  --shm-size 512m --memory 1.5g --cpus 1.5 --pids-limit 512 \
  --mount type=volume,src=makase-s1-browser-profile,dst=/home/browser \
  --mount type=volume,dst=/tmp \
  -p 127.0.0.1:6080:6080 \
  makase-s1-box-browser
```

- 初期画面は `file:///opt/box-browser/test-page.html`。画面寸法・日本語・クリック・入力を確認でき、ページ自身は外部通信しない。
- 別途ホスト側のnoVNCクライアントから `ws://127.0.0.1:6080/` へ接続する。6080はWebSocket専用で、HTMLは配信しない。x11vncの5900はコンテナ内のlocalhost限定、XのTCPは無効。
- 通常のbridgeネットワークでの使い捨て試験であり、1.4以降の外向き通信隔離ではない。Chromiumのバックグラウンド通信抑制フラグもネットワークの強制遮断ではない。同じネットワークの別コンテナから6080へ接続できる点にも注意する。
- `docker stop --timeout 10 makase-s1-browser` で停止する。`--rm` は匿名 `/tmp` volumeを削除し、名前つきプロフィールは残す。`/tmp` をtmpfsにしない。キャッシュは暫定で `/tmp/chromium-cache`・512MiBを指定するが、ディスク容量の厳密な上限ではない（1.7で実測予定）。
- 空のvolumeへのDockerのcopy-upで、`/home/browser` のuid/gid 10000と `/tmp` のmode 1777・root所有の `.X11-unix` を継承する。`volume-nocopy` やroot所有の既存volume・bind mountは使わない。起動時にrootへ昇格してchownする経路はない。
- プロフィールの同時共有は禁止。起動時に `SingletonLock`・`SingletonSocket`・`SingletonCookie` だけを除去する。初期プロフィールのページ倍率は100%、device scaleは1。既存プロフィールやユーザー操作によるページズームを固定するpolicyは入れていないので、画面の倍率表示でも確認する。
- 起動引数によるURLやChromiumフラグの上書きは受け付けない。`--no-sandbox` へのfallbackはしない。sandboxが起動できなければログを残して失敗する。`--disable-dev-shm-usage` も付けず、512MiBの `/dev/shm` を使う。

既定seccompとの比較は、停止後に**専用seccompの行だけを省略し**、別のコンテナ名・新しいプロフィール名で同じ起動を試す。既定のまま失敗するか、専用で成功するかはホスト依存のため、実機結果を記録する。sysctl・AppArmor・capabilityを緩めて成功扱いにしない。

## 固定したベースと依存

2026-10-26に `docker buildx imagetools inspect node:24.21.0-bookworm-slim` で実在を確認した。

| 対象 | digest |
|---|---|
| Dockerfileに固定したmulti-platform index | `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` |
| linux/amd64 manifest | `sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd` |
| linux/arm64/v8 manifest | `sha256:ba6b7d0ee561d9d49deb99e2b93c98632cc287b6cca1a6b18d66127054efa4dc` |

Debian bookwormの `chromium`・`xvfb`・`x11vnc`・`websockify`・`xdotool`・`openbox`・`fonts-noto-cjk` を使う。`x11-utils` は準備確認、`util-linux` の `setsid` はプロセスグループごとの終了に使う。Debianパッケージの版は固定していないため、ベースdigestだけでビルド全体の同一性は保証しない。実機検証では `chromium --version` と `dpkg-query` の版を記録する。

## 制限と残る範囲

`policies/managed.json` をroot所有・読取り専用の `/etc/chromium/policies/managed/box-browser.json` に置く。架空の `--disable-webrtc` や `--disable-devtools` は使わない。

| 対象 | 設定・効く範囲 |
|---|---|
| QUIC | `QuicAllowed: false` と `--disable-quic` |
| WebRTC | `WebRtcIPHandling: disable_non_proxied_udp` と同名の強制フラグ。非プロキシUDPを制限するが、**WebRTC API・TCP経路・データチャネルの全面禁止ではない**。完全な通信隔離は未実装。 |
| 音声・映像・画面 | `AudioCaptureAllowed`・`VideoCaptureAllowed`・`ScreenCaptureAllowed: false`。許可先リストは入れない。 |
| DevTools | `DeveloperToolsAvailability: 2`。CDPの起動フラグも入れない。現行のpolicy定義ではCDPも制限対象なので、1.2のpipe実装時にはこの組合せを再検討する必要がある。 |
| ダウンロード | `DownloadRestrictions: 3`。このpolicy単独では表示ページの保存・PDF印刷を禁止しないため、`AllowFileSelectionDialogs: false` と `PrintingEnabled: false` を併用する。全ファイル書込みをOSで禁止するものではなく、プロフィールは書込み可能。 |
| 権限要求 | 位置・通知・Bluetooth・USB・HID・Serial・File Systemの各既定policyを拒否値 `2` にする。加えて実在する `--deny-permission-prompts`（要求時に表示せず拒否）を付ける。すべてのWeb APIやブラウザのダイアログの無効化を保証するものではない。 |
| その他 | サインイン・同期・パスワード保存・バックグラウンド常駐・予測通信をpolicyで停止する。 |

根拠（2026-10-26に上流定義を確認。導入したDebian版での適用は `chrome://policy` 等で別途検証する）：

- [Chromium policy定義](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/)（`Miscellaneous`・`ContentSettings`・`ScreenCapture`・`WebRtc`・`Printing`・`PasswordManager`）
- [WebRtcIPHandling](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/WebRtc/WebRtcIPHandling.yaml)
- [DownloadRestrictions](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/Miscellaneous/DownloadRestrictions.yaml)
- [DeveloperToolsAvailability](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/Miscellaneous/DeveloperToolsAvailability.yaml)
- [deny-permission-prompts](https://chromium.googlesource.com/chromium/src/+/main/components/permissions/switches.cc)
- [force-webrtc-ip-handling-policy](https://chromium.googlesource.com/chromium/src/+/main/content/public/common/content_switches.cc)

## 起動・終了の確認事項

- 各段階は準備待ちに上限を設ける（X/WM/VNC/WS各10秒、Chromiumは30秒。1回のプローブにもtimeout）。Chromiumの準備確認は可視ウィンドウの出現であり、sandboxやpolicyが実際に適用された証明ではない。
- 主要な子が正常・異常を問わず終了したら全体を失敗終了する。TERM/INT/HUPでは全グループへTERM、最大約5秒後にKILLを送り、直接の子を回収する。孫の回収はDocker `--init` を併用する。
- 最低限の静的検査：`bash -n docker/box-browser/start.sh`、`python3 -m json.tool docker/box-browser/policies/managed.json >/dev/null`。
- ビルド、既定／専用seccomp比較、sandboxの有効性、noVNC表示、volumeの継承、シグナル終了、子プロセス異常時の終了は実機検証で確認する。
