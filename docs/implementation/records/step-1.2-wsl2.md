# ステップ1.2：box-agentとCDP pipeの確認

- 対象：[手順1.2](../01_vm_vertical.md#12-box-agentスクショxdotoolcdp-のパイプread_pageopen_url)
- 検証日：2026-10-26、WSL2・amd64
- 開始時HEAD：`57bcb7b`

## CDPとDevToolsの方針（D-406）

持ち主に確認し、**CDP pipeを優先**する方針を採用した。`DeveloperToolsAvailability: 2`はUIだけでなく、CDPのページへの接続も拒否する。値を`1`に変更し、固定の`--kiosk`を維持する。TCPデバッグポートは開かない。

既存イメージ`makase-s1-box-browser`のChromium `156.0.8078.47`（Debian `156.0.8078.47-1~deb12u1`）、Node `24.21.0`で比較した。read-only root・uid/gid 10000・cap-drop ALL・no-new-privileges・専用seccomp・init・shm512MiB・メモリ1.5GiB・CPU1.5・pids512を維持し、ネットワークは`none`、プロフィールと`/tmp`はケースごとに新しい匿名volumeを使った。

| 検査 | policy2＋kiosk | policy1＋kiosk |
|---|---|---|
| `Browser.getVersion`・`Target.getTargets` | 成功 | 成功 |
| `Target.attachToTarget` | `-32000: Not allowed` | 成功 |
| `Page.enable`・`Runtime.evaluate` | ページsession未成立のため実行不能 | 成功 |
| `Accessibility.getFullAXTree` | 同上 | 35ノード取得 |

**readinessはブラウザの版を取得できるだけでは不十分**。操作対象のpageへattachし、必要なdomainが使えることを確認する。

### DevTools画面の抑止

- policy1＋kiosk：`Target.openDevTools`は`Failed to create DevTools window`。F12・Ctrl+Shift+I/J/CでもDevTools targetなし。その後もCDPの`Runtime.evaluate`が成功。
- policy1からkioskだけ外した対照：同じ呼出しでDevTools画面が起動。
- 親担当もpolicy1＋kioskのケースを再実行し、同じ結果・CDPのTCP待受けなしを確認した。
- 導入版の[上流コード](https://github.com/chromium/chromium/blob/156.0.8078.47/chrome/browser/devtools/devtools_window.cc#L1337-L1385)には、kiosk時のUI作成を拒否する分岐がある。[policy定義](https://github.com/chromium/chromium/blob/156.0.8078.47/components/policy/resources/templates/policy_definitions/Miscellaneous/DeveloperToolsAvailability.yaml)の値1自体はUI禁止を意味しない。

したがって**この版の固定kioskではUI起動抑止とCDP利用の両立を確認した**。policyによるDevTools全面禁止を維持したとは扱わず、Chromium更新時には上記の対照試験を繰り返す。調査4回と親再検証1回のコンテナ・計10個の匿名volumeは削除済み。

再現用スクリプトと詳細な応答は当初`/tmp/opencode/agent-team-s1.2/cdp-probe/`へ保存したが、作業再開時に`/tmp/opencode`が空になっており、この対照試験は本記録だけが残る。下の統合検証は再ビルドしたイメージで改めて実行した。

## 実装の統合確認

**手順1.2の実装・実機検証は完了。** 親担当が以下を実行し、画像と終了証跡も確認した。

| 検査 | 結果 |
|---|---|
| `pnpm --filter @open-team/box-agent test --maxWorkers=1` | 7ファイル・297件成功。OSのプロフィール排他・入力中断と解放の競合を含む |
| `pnpm typecheck` | 全workspace成功。最後のbrowser修正後もbox-agentの型検査を再実行して成功 |
| `pnpm lint:deps` | 違反なし（677 modules / 2611 dependencies） |
| Dockerビルド | 成功。本番Node依存は`ws`だけ、uid/gid 10000 |
| `vm-check.mjs` | 19項目成功。一時的なaction/CDP診断preloadを除去した通常構成 |
| `lifecycle-check.mjs` | 7ケース成功。全件OOM・資格ログ漏出なし |

最終イメージ：`makase-s1.2-box-browser`、image ID `sha256:2df9597cb3e896957c2cdbc9738305d9f7766ee978cd5ccf36aed9223331ee58`。

### 再ビルド後の環境

| 対象 | 実測値 |
|---|---|
| Docker Engine | 29.8.1・x86_64 |
| Node / ws / uid:gid | 24.21.0 / 8.22.0 / 10000:10000 |
| Chromium | 156.0.8078.47-1~deb12u1 |
| xdotool | 1:3.20160805.1-5 |
| Xvfb / x11vnc | 2:21.1.7-3+deb12u13 / 0.9.16-9 |
| Python / libX11 / libXtst | 3.11.2-1+b1 / 2:1.8.4-2+deb12u2 / 2:1.2.3-1.1 |

### API・画面の実測

- HTTP全口とVNCで無資格・別資格・旧資格を拒否。正資格のVNCではRFB greetingまで確認。Docker制限・CDP pipe限定・Chromiumへの資格非継承も検査した。
- 不正入力を副作用なく拒否。同時の同IDクリックは購入回数1回、完了・失敗の再送も再実行なし。異なるpayloadと古いepochを拒否した。
- `open_url`→PNG→クリック→`type`→`read_page`を実行。ASCII・日本語の短文と、各16,000bytesの長文はページ側の実値を全文照合。秘密6欄の値は`read_page`のJSONに出ない。
- 新タブの前面化通知と、`read_page`の座標でX入力する対象の一致を確認。alert/confirmと新タブの再開直後のalertを通知して勝手に閉じず、検査側から明示的に閉じた後の結果も照合した。
- SIGKILL後にコンテナを削除し同じprofileで再作成。Singleton回復・marker維持・旧資格拒否を確認。TERMはagent自身の`stopped OK`まで確認した。
- 親が1280×800の購入回数1回・日本語入力全文・alert/confirmのPNGを目視した。秘密欄はダミー値であり、撮影前マスクの試験ではない。

### 終了とsandboxの実測

| ケース | 結果 | 停止時間 | exit |
|---|---|---:|---:|
| 既定seccomp | `NO_USABLE_SANDBOX`の自然終了後に1回だけ再試行、`sandboxEnabled: false`、TERM正常停止 | 877ms | 143 |
| Chromium親をSIGKILL | 全体が失敗終了 | 700ms | 1 |
| agentをSIGKILL | 全体が失敗終了 | 661ms | 1 |
| OpenboxをSIGKILL | 全体が失敗終了 | 829ms | 1 |
| マウス押下保持中のTERM | agent正常停止 | 759ms | 143 |
| INT | agent正常停止 | 783ms | 130 |
| HUP | agent正常停止 | 794ms | 129 |

専用seccompの6ケースはすべて`sandboxEnabled: true`。通常シグナルはagentの`stopped OK`と失敗ログなしを必須とした。既定seccompケースだけは、再試行回数・自然終了診断を記録する読み取り専用preloadを使用する。起動引数・戻り値・再試行判断は変更しない。API検査の2コンテナと専用volume、終了検査の7コンテナ・14匿名volumeは回収済み。

### 統合で再現し修正した問題

- 認証拒否時の半開きVNC接続、画像結果キャッシュの容量無制限、排他前のSingleton削除を修正。キャッシュは1000件または32MiBで新規実行を止め、既存結果は保持する。
- `xdotool type --delay 0`は実Xのイベント数が正しくてもChromiumで日本語が欠落した。一時CLIPBOARD＋固定Ctrl+Vへ変更（D-408）。既存CLIPBOARDは復元せず、paste禁止ページとの互換性差を契約に明記した。
- 入力子の終了前にキーを解放する競合、前面確認中のtarget変更の取りこぼし、操作間のマウス押下残留を修正。子のclose・解放完了を後続操作が待つ。
- `Page.navigate`成功後の旧document破棄を操作失敗にしないよう修正。成功は遷移開始の受理であり、ロード完了は後続の`read_page`で確認する。
- 新タブがdebugger待機中に`Page.enable`でtimeoutすることを実測。先に再開するだけでは即時alert通知を取りこぼし、Page.enableだけ先に送っても再開後の`Runtime.enable`がdialogで停止した。最終的に全domain・監視の登録を固定順で送信→最後にresume→全応答待ちとし、即時alertの実機試験も成功。初期化完了前のX入力は禁止し、新タブ前面化中のdialogも実行済みクリックの結果として通知する。
- lifecycleのプロセス特定probeは、Chromium子のprocess title書換えを考慮して親の固定argvとagentとの親子関係で特定するよう修正した。
- 押下保持中のTERMではXが先に落ちて`BACKEND_STOP_FAILED`になったため、Xを維持したままagentの後始末を先に待つ順序に修正。途中のINT検査用execが一度timeoutしたが、最終の直列実行では同じ期限のまま7件すべて成功した。

### 証跡と再現

- API・画像：`/tmp/opencode/box-agent-vm-check-nd9w76/`（即時alertも描画を待って目視済み）
- 終了・sandbox：`/tmp/opencode/box-agent-lifecycle-check-dbxuay/results.json`
- ビルド・単体・型・依存：`/tmp/opencode/agent-team-s1.2/`の`docker-final-build.log`・`tests-final.log`・`typecheck-final.log`・`package-typecheck-final.log`・`deps-final.log`

再現コマンド（Node 24、workspace依存のインストール済み環境）：

```sh
docker build -f docker/box-browser/Dockerfile -t makase-s1.2-box-browser .
node apps/box-agent/test/vm-check.mjs makase-s1.2-box-browser
node apps/box-agent/test/lifecycle-check.mjs makase-s1.2-box-browser
```

検査は自分専用のコンテナ・volumeを終了時に回収する。証跡は`/tmp/opencode/box-agent-vm-check-*`と`/tmp/opencode/box-agent-lifecycle-check-*`。途中で失敗した検査を成功に読み替えない。

## 後続の範囲

次は1.3のbox-shell・shell-agent。`read_page`は主frameのみで、iframe対応・秘密領域の撮影前マスク・inspect/dryRun/expect・交代・egress・zoomは後続の手順で実装する。1.1のWebRTC全面停止と恒久的なページ倍率100%固定も未達のまま。1.2の完了はステップ1全体や本番利用要件の完了ではない。

## 着手前のCI

run `40277789495`は既存の`apps/app/src/routes/agents.test.ts:99`で失敗。整理済みスキルの一覧が期待1件に対し2件で、同パッケージの残り390テストは成功していた。box-agent追加前の失敗として区別する。
