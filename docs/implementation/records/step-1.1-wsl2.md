# ステップ1.1：WSL2でのブラウザ起動確認

- 対象：[手順1.1](../01_vm_vertical.md#11-box-browser-のイメージを単独で起こして-vnc-で見える)
- 検証日：2026-10-26

## 環境

| 項目 | 値 |
|---|---|
| OS | WSL2・amd64、Linux 6.18.33.2-microsoft-standard-WSL2 |
| Node / pnpm | 24.21.0 / 10.27.0 |
| Docker Engine / API | 29.8.1 / 1.56（WSL内のEngine） |
| Compose / buildx | 5.5.1 / 0.37.1 |
| DockerのSecurityOptions | `seccomp,profile=builtin`、`cgroupns` |

## 画面確認の方法

noVNCの[公式README](https://github.com/novnc/noVNC/blob/63107bd06d9e1f6136ff21aeda8cd62cbf0d433e/README.md)には公式Dockerイメージの案内がないため、公式リリース **v1.7.0**（commit `63107bd06d9e1f6136ff21aeda8cd62cbf0d433e`）の静的ファイルをホストで一時配信する。

```bash
git clone --depth 1 --branch v1.7.0 https://github.com/novnc/noVNC.git /tmp/opencode/makase-s1-novnc
git -C /tmp/opencode/makase-s1-novnc rev-parse HEAD
python3 -m http.server 6081 --bind 127.0.0.1 --directory /tmp/opencode/makase-s1-novnc
```

ブラウザで `http://127.0.0.1:6081/vnc_lite.html?host=127.0.0.1&port=6080&scale=false` を開く。クライアントはコンテナのWebSocket（localhost公開の6080）に接続する。noVNCはbox-browserイメージに含めない。確認後はHTTPサーバーを終了する。

## 結果

**起動基盤と表示の実機検証は成功。仕様差分2件があるため、1.1全体の完了とはしない。**

| 確認 | 実測結果 |
|---|---|
| `docker build --check -f docker/box-browser/Dockerfile .` | 警告なし |
| `docker build -f docker/box-browser/Dockerfile -t makase-s1-box-browser .` | 成功 |
| Docker既定seccomp | Chromiumが`No usable sandbox!`で終了。起動役が全体を終了1にした。OOMなし |
| 専用seccomp | sandbox無効化フラグなしでChromiumとVNCが起動 |
| `docker inspect`・`/proc/1/status` | uid/gid 10000、`CapDrop=[ALL]`、read-only root、`NoNewPrivs=1`、`Seccomp=2`。メモリ1610612736、shm536870912 bytes、CPU1.5、pids512、initあり |
| 書込み先 | `/`は書込不可、`/home/browser`と`/tmp`はvolumeで書込可。初回の所有権・modeも正常 |
| noVNC | 1280×800の全画面。日本語が欠けず、ページ内の画面・ページ寸法1280×800、倍率1。クリック回数が0→1になる |
| rendererのsandbox | 通常のキオスク起動で`NSpid`が3段、`CapEff=0`、`NoNewPrivs=1`、`Seccomp_filters=2`。browser本体はフィルタ1枚 |
| `chrome://sandbox` | 診断起動でNamespace、PID/NET namespaces、Seccomp-BPF、TSYNCが有効。画面の判定は`You are adequately sandboxed.`。Yama非broker保護はNoであり、すべての項目がYesとは扱わない |
| `chrome://policy` | プラットフォームのMandatory policyとして認識。DevTools=2、DownloadRestrictions=3等がOK。WebRtcIPHandling=`disable_non_proxied_udp`もOK |
| 子の異常終了 | `openbox`にSIGKILL→全体が終了1 |
| 強制停止後の再作成 | プロフィールにマーカーを置き、コンテナをSIGKILL→削除→同じ名前つきvolumeで再作成。再起動でき、マーカーが残る。匿名`/tmp`は毎回新しくする |
| シグナル | TERM/INT/HUPで全体が143/130/129で終了。Dockerによる強制KILLに達せず停止 |
| CIのdigest検査 | `docker/*/Dockerfile`を追加。実プロジェクト5箇所成功、固定なしを拒否するfixtureを含む6ケース成功 |
| 静的確認 | Bash構文、JSON、seccomp上流ハッシュ・既定規則維持・許可/拒否条件、`git diff --check`成功 |
| 型・依存 | `pnpm typecheck`成功。`pnpm lint:deps`は初回120秒で時間切れ、時間制限を外した再実行で655 modules・2532 dependenciesの違反なし |
| 全体テスト | `pnpm test`は300秒で中断。未完了分を並列数1で再実行し、完了済み合計13パッケージ・2255テスト成功、2パッケージはテストなし。`apps/worker`は長時間化のためSIGTERMで中断し、後続`apps/app`は未実行。全体成功とは扱わない |

`chrome://sandbox`・`chrome://policy`の診断では、起動スクリプトの一時コピーで初期URLを変更し、`--kiosk`だけを外して画面内で移動した。イメージ、seccomp、ユーザー、資源制限、managed policyは同一。通常起動のsandboxは別途`/proc`でも確認した。診断用コピーは本体に取り込まない。

画面の確認はヘッドレスChromiumからnoVNCを開いて撮影し、画像を目視した。noVNCの`vnc_lite.html`が要求する`favicon.ico`だけは静的配信元に無く404。JavaScript例外・VNC接続エラーはない。接続直後はフレーム未描画の場合があるため、接続表示だけでなく描画完了も待つ。

スクリーンショット（ローカルの`.output/`、Git管理外）：
- `box-browser-s1.1.png`：通常の日本語ページ。
- `box-browser-click-s1.1.png`：クリック回数1。
- `box-browser-sandbox-s1.1.png`：診断用のsandbox状態。
- `box-browser-policy-s1.1.png`・`box-browser-policy-middle-s1.1.png`・`box-browser-policy-webrtc-s1.1.png`：policyの適用状態。

## 再現する際の補足

ビルド・起動は[box-browserのREADME](../../../docker/box-browser/README.md#ビルドと起動)を使う。既定seccompの比較は専用seccompの指定だけを外し、別のコンテナ・プロフィール名で試す。ログを残すときは`--rm`を外し、`docker wait`で終了コード、`docker logs`で原因を見る。確認後はそのコンテナを`docker rm -v`で消す。

子の異常終了は、コンテナ内の`/proc/*/comm`から`openbox`のPIDを見つけてSIGKILLする。TERMは`docker stop --timeout 10 <name>`、INT/HUPは`docker kill --signal INT <name>`等で試す。強制停止後の検査は同じコンテナの`docker start`ではなく、削除・再作成で行う。

確認用の`makase-s1-*`コンテナ・名前つきプロフィール・匿名volumeとnoVNC配信用サーバーは片付けた。ビルドした`makase-s1-box-browser`イメージは残す。

全体テストの再実行は次のコマンド。`apps/worker`で秘密設定の不足とsourcemapの警告が繰り返されたが、時間がかかった原因は断定していない。停止したのはこの再実行のプロセスツリーだけ。テスト用の`ot-db-test`も停止した。

```bash
pnpm --workspace-concurrency=1 -r \
  --filter @open-team/db --filter @open-team/gateway --filter @open-team/gcal \
  --filter @open-team/github --filter @open-team/llm --filter @open-team/edge \
  --filter @open-team/worker --filter @open-team/app run test --maxWorkers=1
```

## ビルド時のDebianパッケージ

| パッケージ | 版 |
|---|---|
| chromium | 156.0.8078.47-1~deb12u1 |
| xvfb | 2:21.1.7-3+deb12u13 |
| x11vnc | 0.9.16-9 |
| websockify | 0.10.0+dfsg1-4+b1 |
| openbox | 3.6.1-10 |
| fonts-noto-cjk | 1:20220127+repack1-1 |

## 残る仕様差分と次の確認

独立レビューでも次の2件を確認した。要求を満たしたものとして扱わず、設計側で対象範囲を明確化する。

1. **WebRTCの全面停止は未達**：非プロキシUDPと音声・映像・画面取得を制限しているが、WebRTCのAPIやTCP・データチャネルは全面停止していない。1.4のegressを作る際も、通信隔離とWebRTC機能の無効化を混同しない。
2. **ページズームの恒久的な100%固定は未達**：新規プロフィールでは実測倍率1。`--force-device-scale-factor=1`は既存プロフィールのページズームや操作後のズームを強制する設定ではない。

1.2ではDevTools禁止policyとCDP pipeの両立、認証・管理口を実装する。arm64実機、1.7の速度・費用・キャッシュ容量、1.4以降のネットワーク隔離は今回の実測に含めない。
