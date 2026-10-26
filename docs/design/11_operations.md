# 運用契約：停止・移行・VMイメージ（P1）
- 版数：v1.5（2026-10-25）／親：[技術仕様](11_tech_spec.md)

> **3行で**
> 動的VMはComposeだけでは止まらない。
> コピーは書き手を止めてボリュームが非使用になってから行う。
> Compose外の2イメージも公開リリースのdigestで明示取得する。

## 🧭 判断してほしいこと
なし。IMP-010・011の承認済み改善案に沿う。

## 全体の順序
受付/自動起動停止 → 対象VM停止/削除 → ボリューム非使用確認 → コピー/削除または新digestで起動。

## 要点
- 新規基盤は追加しない。Docker labelと既存の停止APIを使う。
- 具体的なイメージdigestはリリース成果物として固定し、架空値を書かない。

## 停止とコピー（IMP-010）
1. 本体の新規受付・タイマー・VM自動起動を止める。本体を停止し再起動させない。managerが利用可能な間にAPI-102で対象世代を止め、続いてmanagerを停止して自動再作成を防ぐ。
2. managerが作る全VMには `io.makase.managed=vm`・`io.makase.installation=<導入固有ID>`・`io.makase.generation=<boxId>` を付ける。導入IDはホストの運用設定で固定し、世代とは別。停止済みを含む当該導入のコンテナだけを列挙し、停止・削除する。managerが落ちた場合もこのlabelから回収する。無関係なコンテナは触らない。
3. 稼働中コマンド・Chromiumが終了し、対象の動的コンテナが0、対象ボリュームを利用する他コンテナも0であることをDocker inspectで確認する。不明/利用中ならコピーしない。Composeサービスもdownして本体DBの書き手をなくす。
4. 通常停止はボリュームを残してここで終了。移行は停止済み `makase-data`・`makase-browser-profile`・`makase-vm-home` と、`makase-vm-snapshots/.operations/` を同じ停止時点の組として読み取り専用でコピーする。`.operations/`（未ACK結果・broken印・ACK済み墓標）は控え本体を引き継がない場合も必須。未完了の復元が参照する控え本体も必須で、それ以外の控え本体だけ省略できる。移行先の起動前にコピー元との記録・ファイルの一致を確認し、欠落/不一致なら起動せず人へ復旧要求する。空の記録を未受付のnoneと解釈して再送してはならない。
   Tailscale状態は旧ホストを再起動しない前提で移すか、新規認証し直すかを明記し同時利用しない。`.env` の暗号鍵は安全な別経路で移す。
5. 完全削除は対象データを消す明示確認後だけ。動的VMを片付けた後、当該導入の名前付きボリュームを列挙して削除する。`compose down -v` だけで全データが消えると説明しない。

移行の受入：復元/消去のdoneまたはfailedが未ACKの状態、およびDB結果確定後ACK応答消失の状態で移行する。新ホストが同じoperationIdの結果/墓標を照合してACKだけを完了し、破壊的操作を再実行しないこと、brokenが維持されることを確認する。`.operations/` を意図的に欠落させた移行は起動前検査で停止し、POST/消去DELETEが0回であることも確認する。

## 初回・更新のイメージ（IMP-011）
- リリースはComposeサービス群とmanagerが使う `BOX_BROWSER_IMAGE`・`BOX_SHELL_IMAGE` の不変digest対応を一組で公開する。2変数はAPI入力にせずmanagerの固定設定だけで使用する。
- 初回は `docker compose pull` に加え、公開された2値で `docker pull "$BOX_BROWSER_IMAGE"`・`docker pull "$BOX_SHELL_IMAGE"` を実行し、両方の取得成功/対象CPUの解決を確認してからupする。build運用も同じ参照へタグ/IDを揃え、存在確認する。
- 更新は新リリースの一組を先に取得し、取得失敗なら旧版を維持。上の停止契約で旧世代を片付け、Composeとmanagerの2参照を同じリリースへ切り替え、次の新世代が指定digestを使うことをAPI-109/111とDocker inspectで確認する。
- amd64・arm64のイメージなしホストで公開手順だけから起動することを受入条件にする。manifest digestと各CPUの解決後digestを記録し、Compose pull成功だけで合格としない。

## このドキュメントで決まったこと
[D-338・339](00_overview.md#決定事項ログ)。受入条件は[変更レポート](changes/2026-10-25-p1-review-fixes.md)。
