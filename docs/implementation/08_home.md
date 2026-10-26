# ステップ 8. 家の機能
- プロジェクト：Agent-Team-Open ／ 手順書の版：v1.2（2026-10-26） ／ 設計の版：v1.7 ／ インプット：[04 vm](../design/04_functional_spec/vm.md)（FR-110・111・113）、[04 resident](../design/04_functional_spec/resident.md)（FR-112・114・115）、[04 tools](../design/04_functional_spec/tools.md)（保管庫と Home Assistant の道具）、[03 UC-068〜072・BR-15・16](../design/03_use_cases.md)、[08 vm](../design/08_database/vm.md)（TBL-060・062）、[08 resident](../design/08_database/resident.md)（TBL-061・063）、[09 vm](../design/09_api/vm.md)（API-153・155）、[09 resident](../design/09_api/resident.md)（API-154・156）、[06](../design/06_ux_design.md)（SCR-030〜032）、[05](../design/05_non_functional.md)（NFR-095・097）、[ADR-080](../design/adr/ADR-080-home-vault.md)〜[083](../design/adr/ADR-083-classify-and-local-on-pi.md)、[変更レポート v1.7](../design/changes/2026-10-26-home-agent.md)

> **3行で**
> 1. チャットに写真を添付でき、エージェントが家の保管庫（写真・書類）を整理し、レシートの写真から家計簿をつけ、Home Assistant 経由で家電を動かせるようになる。鍵・暖房などのこわい機器と、ゴミ箱を空にする操作は必ず人に回る。
> 2. 作るのは、添付（API-156・TBL-063）、保管庫のマウントと `vault_*` の道具と画面（API-153・TBL-060・SCR-030）、写真の整理（FR-111）、Home Assistant のコネクタと `home_*` の道具と機器の区分（API-155・TBL-062・SCR-032・BR-15）、家計簿（API-154・TBL-061・SCR-031）、仕分けの役割 `classify`（FR-115・BR-16）。
> 3. 終わる条件：UC-068〜072 の基本フローが通り、変更レポート v1.7 の受入条件のうち段 1 で確かめられるもの（FR-110・112・113・115、NFR-095・097）が満たされる。ラズパイでの速さ（NFR-096）とキットの初回設定（FR-109）はステップ 9。

## 前提（始める条件）
- **入力**：ステップ 1〜7 が終わっている
  - ステップ 2・3：Kernel の判定は規則の版（FR-104・`policy_versions`）に乗り、判定の入力が保存されて再実行できる（FR-105）。監査ログは鎖になっている（FR-106）。ここで足す保管庫・機器の区分の規則も同じ版に入れる
  - ステップ 3：表は版 6 で TBL-056〜063 まで作ってある（`vault_files`・`ledger_entries`・`home_devices`・`chat_attachments` を含む。無い列・索引だけ新しい版で足す）。本体の外向きは窓口 `net` を通り台帳（`egress_events`）に残る。役割ごとのモデル（`llm_models`・API-152）があり、能力 `vision`・`decision` を宣言できる
  - ステップ 4：メインのターン・振り分け・`send_to_owner` の `choices`（FR-093）・道具の渡し方（FR-088）・確認の一覧（API-087）・汚染の印（BR-06）
  - ステップ 5：カレンダーの gateway（家計簿の照らし合わせに読むだけ使う）
  - ステップ 6：SCR-020 チャット・SCR-019 確認のカード・SCR-029 モデルの画面（`classify` の欄はここで実につなぐ）
  - 入れないもの：キットの初回設定 SCR-033・API-157（ステップ 9）、ラズパイでの判断モデル・4B の計測（ステップ 9）、顔で人を見分けること（Won't）、保管庫の毎週の控え（NFR-095 の任意。8.3 の口だけ）
- **機械**：置き先は段 1（手元の WSL2、amd64）。保管庫は USB の SSD の代わりにホストのディレクトリ（例 `~/makase-vault`）を bind でつなぐ。NAS（SMB）は 8.3 の確かめで 1 回だけ試す（家に NAS がなければ Samba のコンテナで代える）
- **鍵とアカウント**：`ANTHROPIC_API_KEY`（画像を読む役割と、`classify` の下限より低いときの LLM）。Home Assistant は Compose の任意のサービスで立て、demo の連携（`demo:`）で鍵・空調・シャッター・照明の偽の機器を出す（実機は要らない）。判断モデルは段 1 では偽のサーバー（決まった確率を返す）で足り、実モデルは 8.7 で 1 つ試す

## 作るもの
| 部品 | 置き場 | 移す元（あれば） | 設計の参照 |
|---|---|---|---|
| 画像の受け取り・HEIC の変換・縮小（長辺 1568px・縮小版 512px） | `apps/makase/src/images/` | なし（新規） | FR-114・API-156 |
| 添付の API と repo、24 時間で消す掃除 | `apps/makase/src/chat/attachments.ts`・`db/repo/chat-attachments.ts` | ステップ 4 の `chat/`（メッセージに添付の ID を足す） | TBL-063・API-156 |
| 保管庫のマウントの確かめ・パスの正規化（`..`・リンクで外へ出るものを断る）・索引 | `apps/makase/src/vault/`（`fs.ts`・`index.ts`・`trash.ts`・`versions.ts`） | なし | FR-110・TBL-060・NFR-095 |
| 保管庫の道具 `vault_list`・`vault_read`・`vault_write`・`vault_move`・`vault_trash` | `apps/makase/src/vault/tools.ts` | ステップ 4 の道具の登録口 | [04 tools](../design/04_functional_spec/tools.md#保管庫と-home-assistant-の道具v17) |
| 保管庫の判定（パス・20 件・空にする・外へ出す） | `packages/kernel/src/vault.ts`（新規。`index.ts` に `export *`） | ステップ 2 の `browser.ts` と同じ純粋関数の作り | FR-110 2・D-373 |
| 保管庫の API と画面 | `apps/makase/src/routes/vault.ts`、`apps/web` の `/vault` | ステップ 6 の画面の骨 | API-153・SCR-030 |
| 写真の整理（EXIF・重複・見た目の近さ・中身の分類の見積もり） | `apps/makase/src/vault/photos.ts` | なし | FR-111・D-374 |
| Home Assistant のコネクタ（REST と状態の購読）・トークンの暗号化 | `apps/makase/src/home/`（`client.ts`・`sync.ts`・`routes.ts`） | ステップ 5 のコネクタの作り（gateway の資格の置き方） | FR-113・API-155 |
| 道具 `home_state`・`home_call`・`home_automation_put`・`home_automation_delete` | `apps/makase/src/home/tools.ts` | ステップ 4 の道具の登録口 | 04 tools |
| 機器の区分と自動化の判定（BR-15） | `packages/kernel/src/home.ts`（新規） | `browser.ts` と同じ作り | FR-113 3〜7・BR-15 |
| 自動化の中身から触る機器を数える（LLM なし） | `apps/makase/src/home/automation-targets.ts` | なし | 04 tools・D-378 |
| HA の Compose のサービス（任意のプロファイル `home`） | `compose.yaml`（`profiles: [home]`）・`docker/homeassistant/configuration.yaml`（試験用の demo） | なし | [07 コンテナ](../design/07_architecture.md) |
| 家計簿（読み取り・`classify`・カレンダーとの照らし・確認のカード・CSV） | `apps/makase/src/ledger/` | なし | FR-112・API-154 |
| 家計簿の画面 | `apps/web` の `/ledger` | なし | SCR-031 |
| 家電の画面 | `apps/web` の `/home` | なし | SCR-032 |
| `classify`（判断モデルの接続先 `decision`・下限・LLM への回し・BR-16 の見張り） | `packages/llm/src/decision.ts`・`apps/makase/src/classify/` | ステップ 3 の `packages/llm` の接続先の作り | FR-115・ADR-083 |
| 判断モデルの偽のサーバー（試験用） | `evals/fakes/decision-server.ts` | なし | — |
| 試しのレシート 50 枚と正解 | `evals/receipts/`（画像と `answers.json`） | なし | NFR-097 |

## 手順
### 8.1 チャットの画像の添付（FR-114・API-156）
1. `POST /api/v1/chat/attachments`（`multipart/form-data`・`Idempotency-Key`）。1 回 10 枚・1 枚 20MB・JPEG/PNG/HEIC を確かめ、外れた枚だけ `error` を持たせて 201 で返す（エラーの名前は API-156 のとおり）
2. HEIC を JPEG に直し、長辺 1568px の LLM 用と長辺 512px の縮小版を作る。元の画像は保管庫の `写真` に置く（保管庫がまだなければ 8.2 の後でつなぐ。それまでは API-156 の代わりの置き場 `/data/attachments/`）
3. `chat_attachments` に入れ、`tainted = 1`。メッセージに添付の ID を付ける。ターンに汚染の印が付き、外向きの作動は汚染のときの決まり（BR-06）に寄る
4. 画像を読めるモデル（`llm_models` の能力 `vision`）にだけ渡す。役割のモデルが `vision` を持たなければ「画像を読めない」と返す（FR-107）。文脈には縮小版だけ載せ、古い画像は送るときの投影で外す（FR-098）
5. メッセージに付かないまま 24 時間たった添付を、毎分のタイマーで実体ごと消す
6. SCR-020 に添付のボタンと縮小版の並びを足す（スマホのカメラ・写真から選ぶ）
確かめ：11 枚で 422 `ATTACHMENT_TOO_MANY`、21MB で 413、GIF で 415、壊れた JPEG で 422 `ATTACHMENT_UNREADABLE`。iPhone の HEIC が JPEG の縮小版になる。添付つきのターンで `web_fetch` 以外の外向きが人の確認に回る。台帳に `purpose = 'llm'` の行が残る。

### 8.2 保管庫の土台（FR-110・TBL-060・NFR-095）
1. `vault.path` をマウント先として本体のコンテナにだけつなぐ（`makase-vault`）。box-manager・VM にはつながない。起動時に決まったフォルダ（`写真`・`書類`・`レシート`・`書き出し`・`ゴミ箱`）と `.versions` を作る
2. パスの正規化を 1 か所に置く：保管庫の中の相対パスだけを受け、`..`・絶対パス・保管庫の外を指すシンボリックリンクを断る（`realpath` で確かめる）。名前の付け替えで外へ出る手も実行のたびに確かめる
3. 索引：起動時と変更のたびに `vault_files` を更新する。保管庫に直接置かれたファイルも拾う（`created_by = 'import'`）。SHA-256・種類・撮影日・場所・縮小版のパス（縮小版は `/data/thumbs/` に置き、保管庫には置かない）
4. ゴミ箱：`vault_trash` は `ゴミ箱` へ移して `trashed_at`・`trashed_from`・`purge_at`（30 日後）を書く。戻す先に同名があれば `名前 (1)`。上書きは前の版を `.versions` に移して `versions` に足す（30 日）
5. 毎日の掃除：`purge_at` を過ぎたゴミ箱の中身と `.versions` を消し、消した件数を監査ログに残す
6. 保管庫が見えない（SSD が外れた・NAS が落ちた）を状態として持ち、道具は失敗を返し、API は 503 `VAULT_NOT_MOUNTED`（一覧と縮小版は索引から返す）
7. 毎週の控え（任意）は口だけ作る（`vault.backup` の設定を読み、空なら何もしない）
確かめ：保管庫のディレクトリをいったん外すと状態が `connected: false` になり、戻すと索引が追いつく。外を指すリンクを置いても読めない。同じ名前に 2 回書くと `.versions` に 1 つ残る。偽の時計で 31 日進めるとゴミ箱が空になり、監査ログに件数が残る。

### 8.3 保管庫の道具・判定・API・画面（API-153・SCR-030）
1. `packages/kernel/src/vault.ts`：道具の呼び出し（道具の名前・正規化したパス・1 回の頼みでゴミ箱へ移した件数・外へ出すか）を受けて行き先を返す純粋関数。表は [FR-110 2](../design/04_functional_spec/vm.md#fr-110家の保管庫と道具) のとおり。20 件目からは人（FR-077）、外へ出すのは外向きの決まり（FR-101・103）のまま。規則は規則の版（FR-104）に入れ、試験の例を足す
2. 道具 5 つを登録する。`vault_read` の結果は汚染として包む（BR-06）。ゴミ箱を空にする・30 日より前に消す・戻すは道具にしない（呼ばれたら Kernel が `deny`）
3. VM での作業が要るとき：本体が要るファイルを API-118 の PUT で VM の `~/work/<taskId>` にコピーし、書き戻しは `vault_write` で行う（ステップ 7 の tar の口を使う。VM に保管庫はつながない）
4. API-153 を作る。パスは受けず `id` だけ。`content` は `attachment`・`nosniff`・`CSP: sandbox`。空にするは `{ confirm: "empty", count }` で、見せた件数と違えば 409 `VAULT_TRASH_CHANGED`
5. SCR-030 `/vault`：フォルダ・撮影日・場所・重複・タグで見る、ゴミ箱、戻す、前の版。空にするは件数を見せて [ やめる ] [ 空にする ]（[06 SCR-030](../design/06_ux_design.md#scr-030写真とファイル)）
6. NAS（SMB）を 1 回試す：ホストで SMB を `/mnt/nas/makase-vault` にマウントして `vault.path` に向ける（コンテナの中で SMB をマウントしない）
確かめ：エージェントに「古いスクショを 25 枚消して」と頼むと人の確認に回る。19 枚なら通り、ゴミ箱から戻せる。エージェントにゴミ箱を空にさせようとしても道具がなく、API を直に叩いても `confirm` なしで 422。VM のコンテナから `/mnt` やボリュームの一覧に保管庫が見えない。SMB でも同じ確かめが通る。

### 8.4 写真の整理（FR-111・UC-068）
1. 本体のプログラム（LLM なし）：EXIF の撮影日・場所で並べ替え、同じ SHA-256 を重複の候補にし（`duplicate_of`）、見た目の近さ（縮小版の dHash など）で近いものを候補に足す。縮小版を作る
2. 中身での分類：対象の枚数とモデルの単価から費用を見積もり、`send_to_owner` の `choices` で ○ をもらってから、上限の中で `vision` のモデルに送る。見積もりを超えそうなら途中で止めて聞く。○ がなければ 1 だけ行う
3. 結果はタグ（`tags`・`tag_source`）として残し、移すのは `vault_move`、消すのは `vault_trash` だけ。重複を消すかどうかは人が決める
4. HEIC が読めなければ飛ばして、件数を知らせる
確かめ：撮影日がばらばらの写真 30 枚（うち同じもの 3 枚・少し縮めたもの 2 枚）で、撮影日のフォルダに移り、重複の候補が 5 件出る。分類の見積もりで × を押すと LLM に 1 枚も送らない（台帳に `llm` の行が増えない）。

### 8.5 Home Assistant のコネクタと機器の区分（FR-113・BR-15・UC-070）
1. Compose に `homeassistant` を任意のプロファイル `home` で足す（イメージは版を固定。arm64 もある公式のもの）。試験用の `configuration.yaml` で demo の機器を出す。本体からだけ届くネットワークに置く（VM の box ネットワークには入れない）
2. API-155 の `PUT /connection`：URL と長期トークンを受け、HA を 1 回呼んで確かめてから、トークンを暗号化して置く（VM には置かない）。URL のホストを本体のコネクタ用の内部ホストとして自動で登録する（VM の `browser`・`terminal` 側には入れない：FR-102 6）。呼び出しは窓口 `net` を通す
3. 同期：HA の状態の変化を購読し、`home_devices` に写す。新しい機器は区分の印なし（＝こわいものとして扱う：FR-113 7）
4. `packages/kernel/src/home.ts`：機器の区分（`lock`・`climate`・`water_heater`・`valve`・`alarm_control_panel`・`cover` と `human_device_classes`）を規則の版から引き、`home_call` と自動化の作る・直す・消すの行き先を返す純粋関数。区分の分からない機器・数えられない自動化はこわいもの。「こわくない機器だけなら自動化を通す」の設定も規則の版に入れる
5. `automation-targets.ts`：自動化の JSON から触る機器を数える（`entity_id` の直書き・`target`・`device_id`・`area_id` を機器に開く。テンプレートで決まらないものは「数えられない」）
6. 道具 4 つを登録する。人に回すときの確認のカードに、機器の名前・動かす内容・自動化なら「いつ・何が起きたら・何をする」を日本語で出す。承認は中身のハッシュに結び、1 回だけ実行する（FR-077。ステップ 2 の作り）
7. 判定は判断モデル・LLM を使わない（BR-16）。`classify` が機器と操作を選んだあとでも、行き先は 4 の関数だけで決まる
8. SCR-032 `/home`：機器の一覧・こわいの印の付け外し（`device_class = 'human'` は外せない）・自動化の一覧（こわい機器に触るものに赤い印）・つなぐ／外す（[06 SCR-032](../design/06_ux_design.md#scr-032家電)）
確かめ：「電気消して」は確認なしで demo の照明が消える。「玄関の鍵を開けて」「鍵が開いたら暖房をつける自動化を作って」「さっきの自動化を消して」は、頼み方を変えても全部人の確認に回る。テンプレートで対象が決まる自動化も人に回る。トークンを無効にすると 422 `HA_TOKEN_INVALID` で状態欄につなぎ直しが出る。VM のブラウザから HA の URL に届かない。

### 8.6 家計簿（FR-112・UC-069・NFR-097）
1. 添付（8.1）を受けたターンで、レシートと分かれば `vision` のモデルが店・日付・品目・金額・支払い方法と、項目ごとの自信を読む。読めなければ撮り直しを頼み、行は作らない
2. 費目は `classify`（8.7）で決め、下限より低ければ LLM に回す（`category_source` に決めた者を残す）
3. `ledger_entries` に 1 行入れ、画像は保管庫の `レシート` に移す。同じ画像の SHA-256 が既にあれば重複として知らせる
4. カレンダーの同じ日の予定を読んで、一致すればメモに付ける。`closed`（FR-101）でカレンダーを使えないときは照らさない
5. 金額・日付の自信が低い行は確認待ち（`needs_check`）にし、`send_to_owner` の `choices` で確認のカードを出す（SCR-019 の [ これでよい ] は API-154 の `confirm`）
6. API-154（一覧・集計・直す・確かめた・消す・CSV。CSV は BOM つき UTF-8、`=`・`+`・`-`・`@` で始まるセルに `'`）と SCR-031 `/ledger`（[06 SCR-031](../design/06_ux_design.md#scr-031家計簿)）
7. 試しのレシート 50 枚（印字と手書きの混じり）と正解を `evals/receipts/` に置き、正解率を数えるスクリプト（`pnpm run eval:receipts`）を作る
確かめ：レシート 1 枚を送ると SCR-031 に 1 行入り、同じ写真をもう一度送ると重複と知らされる。ぼけた写真は行ができない。CSV が Excel で文字化けせず、`=SUM(` で始まる店名が式にならない。50 枚で金額・日付 95% 以上、費目 90% 以上（届かなければ記録して、どこで外れたかを eval のケースにする）。

### 8.7 仕分けの役割 `classify`（FR-115・BR-16・UC-072）
1. `packages/llm/src/decision.ts`：接続先 `decision`（Kev の `/v1/systemone` 互換、または OpenAI 互換で選択肢の確率を返すもの）に、題と選択肢を送って `{ answer, confidence }` を受ける。呼び出しは窓口 `net` を通す
2. `apps/makase/src/classify/`：最も高い確率が下限（既定 0.8）以上ならその答え、低ければ上の役割（LLM）に同じ題を回す。決めた者（`decision`／`llm`）と自信を残し、LLM に回した件数を数える。つながらない・1 秒を超えたら LLM へ、LLM も使えなければ確認のカード
3. 使う場面を 4 つに限る：費目（8.6）・知らせる価値（`send_to_owner` の前）・振り分けの下ごしらえ（FR-092）・家電への短い指示で機器と操作を選ぶ（8.5 の 7）。呼び出し口に「場面」の引数を持たせ、BR-16 の場面（Kernel の判定・こわい操作・機器の区分）で呼ばれたら実行せず異常として記録する
4. `classify` を LLM の道具の一覧に出さない（道具ではない）
5. SCR-029 の `classify` の欄（接続先・下限・試しに 1 件仕分け）を API-152 につなぐ
6. 実モデルを 1 つ試す：ADR-083 の候補（Laya の多言語版を先に）を手元で立て、試しのレシート 50 枚の費目で精度と速さを記録する（ラズパイでの p95 はステップ 9）
確かめ：偽のサーバーで自信 0.9 → `decision` が決め、0.5 → LLM に回る。偽のサーバーを止めると LLM に回る。こわい機器の判定と保管庫の判定に `classify` の結果を混ぜた試験で、入力の自信を変えても行き先が変わらない（FR-115・BR-16 の受入）。

### 8.8 通し：家の 1 日（UC-068〜071）
1. 本体＋VM＋HA（demo）＋偽の判断モデルを Compose で上げ、スマホ（tailnet）から次を順に頼む：写真 10 枚を添付して「旅行の写真をまとめて」→ レシート 3 枚を送る → 「リビングの電気を消して」→「鍵が開いたら知らせる自動化を作って」→「重複している写真を消して」
2. 各頼みで、確認に回ったもの・確認なしで通ったもの・台帳の行・監査ログの行を表にして `docs/implementation/records/` に残す
3. 失敗したターンは直す前に eval のケースにする（`pnpm run eval:capture`）
確かめ：確認に回るのが鍵の自動化と（20 件以上なら）まとめて消すだけで、ほかは通る。監査ログの検査（API-151）が通る。家計簿・保管庫・機器の判定を再実行（API-150）して 100% 一致する。

## 終わる条件
| ID | 確かめること | 方法（コマンド・操作） | 設計の参照 |
|---|---|---|---|
| S8-01 | UC-071 基本フロー：写真を添付して頼める。10 枚・20MB・形式の外れは受けない。HEIC が読める | 8.1 の確かめ | [UC-071](../design/03_use_cases.md)・FR-114・API-156 |
| S8-02 | 添付に汚染の印が付き、そのターンの外向きが人に寄る。24 時間付かない添付が消える | 単体＋結合 | BR-06・D-376 |
| S8-03 | `vision` を持たないモデルの役割では画像を読めないと返す | 単体（`llm_models` を差し替え） | FR-107・FR-114 |
| S8-04 | FR-110・NFR-095：道具で消したファイルはゴミ箱に入り、30 日以内なら戻せる。上書きは前の版が残る | 8.2 の確かめ（偽の時計） | [変更レポート v1.7 の受入条件](../design/changes/2026-10-26-home-agent.md#受入条件実装のときの合否) |
| S8-05 | FR-110・NFR-095：ゴミ箱を空にする操作は人の ○ なしでは実行されない。1 回の頼みで 20 件以上をゴミ箱へ移すのは人に回る | 8.3 の確かめ | D-373 |
| S8-06 | FR-110：VM から保管庫に届かない。保管庫の外のパス・`..`・外を指すリンクは断る | 8.2・8.3 の確かめ＋隔離の試験の 1 件 | ADR-061・ADR-080 |
| S8-07 | API-153 の空にするは見せた件数と違えば 409、`confirm` なしは 422。保管庫が外れたら 503 | API の結合 | API-153 |
| S8-08 | UC-068 基本フロー：撮影日で並べ替え・重複の候補・中身の分類は見積もりの ○ のあと | 8.4 の確かめ | [UC-068](../design/03_use_cases.md)・FR-111 |
| S8-09 | FR-113・BR-15：鍵を動かす・鍵に触る自動化を作るのは、どんな頼み方でも人の確認に回る。「電気消して」は確認なしで動く | 8.5 の確かめ（頼み方 10 通りを eval に） | [UC-070](../design/03_use_cases.md)・BR-15 |
| S8-10 | 区分の分からない機器・数えられない自動化・自動化を消すのは既定で人に回る | 単体（`home.ts`・`automation-targets.ts`） | FR-113 5・7 |
| S8-11 | HA のトークンは本体に暗号化して置かれ、VM・画面に出ない。HA の URL は本体のコネクタ用の内部ホストだけに入り、VM から届かない | DB を直に読む・VM から `curl` | FR-102 6・D-377 |
| S8-12 | UC-069 基本フロー：レシートの写真 → 家計簿の 1 行。重複・読めない・自信が低いときの確認のカード | 8.6 の確かめ | [UC-069](../design/03_use_cases.md)・FR-112 |
| S8-13 | FR-112・NFR-097：試しのレシート 50 枚で、金額・日付 95% 以上、費目 90% 以上 | `pnpm run eval:receipts` の結果を記録 | NFR-097 |
| S8-14 | API-154 の CSV が BOM つきで、式に見えるセルに `'` が付く | 単体 | API-154 |
| S8-15 | FR-115・BR-16：`classify` の結果が Kernel の判定・機器の区分に使われない（試験で入力を変えても行き先が変わらない）。BR-16 の場面で呼ぶと異常として記録される | 8.7 の確かめ | BR-16・FR-115 |
| S8-16 | `classify` の下限より低い・つながらない・時間切れで LLM に回り、決めた者と自信が残る | 偽のサーバーの単体 | FR-115 2・D-379 |
| S8-17 | UC-072 基本フロー：SCR-029 で `classify` の接続先と下限を変え、試しに 1 件仕分けできる | 画面を操作 | [UC-072](../design/03_use_cases.md) |
| S8-18 | 保管庫・機器の規則が規則の版に入り、試験の例が落ちる変更は保存できない。8.8 の判定を全件再実行して 100% 一致 | API-149・150 | FR-104・105・D-369 |
| S8-19 | SCR-030〜032 が 06 の画面遷移どおりに動く（スマホの幅で） | 画面を操作・スクショ | [06](../design/06_ux_design.md) |
| S8-20 | 家の 1 日の通し（8.8）が通り、記録が残る | 8.8 | UC-068〜071 |

## 実装で決めること
| 論点 | 設計の言い分 | おすすめ | 決めたら書く先 |
|---|---|---|---|
| HEIC の変換の手段 | 「HEIC は JPEG に直す」（FR-114）。手段は書いていない | 画像の縮小は `sharp`（arm64 の prebuilt あり）。`sharp` の prebuilt は HEIC（HEVC）を読めないので、HEIC だけ wasm の libheif（`heic-convert` など）で JPEG にしてから `sharp` に渡す。ネイティブの libheif を足さない（arm64 の約束） | 00 に D-xxx・11 の技術の表 |
| EXIF と見た目の近さ | 撮影日・場所・重複・見た目の近さ（FR-111）。方法は書いていない | EXIF は `exifr`。見た目の近さは縮小版の dHash（64 ビット）で、ハミング距離 6 以下を候補に。しきい値は 8.4 の写真で決める | 00 に D-xxx |
| 「1 回の頼みで 20 件」の数え方 | 「1 回の頼みで 20 件以上」（D-373） | タスク（メインが自分で扱うならターン）ごとに `vault_trash` の件数を数え、20 件目で人に回す。1 回の確認で、その頼みの残りをまとめて見せる | 00 に D-xxx・FR-110 |
| 画像を読むのはどの役割か | 「画像を読める役割（`vision`）」（FR-112・114）。役割の一覧（`main`・`worker`・`computer`・`review`・`summary`・`classify`）に `vision` はない | `vision` は役割ではなく能力とし、そのターン・タスクの役割（`main` か `worker`）のモデルが `vision` を持てば使う。持たなければ「画像を読めない」と返す | 00 に D-xxx・FR-107 |
| HA の自動化を作る API | 「HA の設定に入れる」（04 tools）。どの API かは書いていない | HA の画面が使う `/api/config/automation/config/<id>`（REST）で書き、`automation.reload` を呼ぶ。公式の文書に載っていない口なので、HA の版を固定し、版を上げるときに 8.5 の確かめを回す | 00 に D-xxx・R-107 の横 |
| HA の状態の写し方 | 「状態の変化を受ける」（API-155） | HA の WebSocket API の `subscribe_events`（`state_changed`）。切れたら 30 秒ごとにつなぎ直し、つないだときに REST の `/api/states` で全部写す | 09 API-155 |
| HA の置き方（Compose） | 任意のサービス。キットでは入れる（07） | `profiles: [home]`。家の LAN の機器を見つけるために `network_mode: host` が要る連携がある（mDNS など）。段 1 は bridge で demo だけ試し、host にするかはステップ 9 のキットで決める | 07 の表 |
| 判断モデルの立て方 | 接続先 `decision`。候補は Von・Laya・Rizzo Flow（ADR-083） | Compose の任意のサービス（`profiles: [decision]`）として立て、本体は `llm.roles.classify` の URL に `net` 経由で呼ぶ。段 1 は偽のサーバーで試験し、実モデルは 8.7 の 6 で 1 つ | 00 に D-xxx |
| 判断モデルの日本語の精度 | 実機で確かめてから既定にする（R-109） | 8.7 の 6 で費目の精度を測り、下限 0.8 で LLM に回る割合も記録する。日本語で使えなければ既定を「LLM だけ」にする | R-109 の横・05 |
| 試しのレシート 50 枚の集め方 | 「試しのレシート 50 枚」（NFR-097）。どこから取るかは書いていない | 持ち主の実のレシートを撮り、店名・金額以外の個人の情報（カードの下 4 桁・会員番号）を塗ってから `evals/receipts/` に置く。公開のリポジトリに入れるかは持ち主が決める（**持ち主の確認が要る**） | — |
| 保管庫の控え（毎週・任意） | NFR-095 の任意 | 8.2 では口だけ。中身（別のディスクか NAS へ `rsync`）はステップ 9 のキットで決める | NFR-095 |

## 設計に戻すこと
- 決めたことを 00 の決定事項ログに D-xxx で足す。NFR-097 の横に 50 枚の実測、R-109 の横に判断モデルの日本語の精度を書く
- 下の食い違いを設計書で直す（[design-feedback.md](design-feedback.md) に足す）：
  - FR-110・113・114 本文の API のパスが `/api/vault/...`・`/api/home/...`・`/api/chat/attachments` で、09 の `/api/v1/...` と違う
  - FR-113 の入力の道具が 3 つ（`home_state`・`home_call`・`home_automation_put`）で、04 tools は `home_automation_delete` を足した 4 つ
  - FR-112・114 の「画像を読める役割（`vision`）」が、役割の一覧（07 レベル3 の `llm`・11 の `llm.roles`）にない
  - API-156 で保管庫がつながっていないときの置き場（`/data/attachments/`）が、TBL-063 と FR-114 の「保管庫に置けない → 添付を断る」と食い違う
- HA の自動化の API・状態の写し方を 09 の API-155 の注に書く

## 参照
- 設計：[04 vm](../design/04_functional_spec/vm.md)（FR-102・110・111・113）、[04 resident](../design/04_functional_spec/resident.md)（FR-093・098・107・112・114・115）、[04 tools](../design/04_functional_spec/tools.md)（保管庫と Home Assistant の道具・FR-088）、[03](../design/03_use_cases.md)（UC-068〜072・BR-06・15・16）、[08 vm](../design/08_database/vm.md)（TBL-060・062）、[08 resident](../design/08_database/resident.md)（TBL-061・063）、[09 vm](../design/09_api/vm.md)（API-153・155）、[09 resident](../design/09_api/resident.md)（API-154・156）、[06](../design/06_ux_design.md)（SCR-019・020・029〜032）、[05](../design/05_non_functional.md)（NFR-095〜097）、[07](../design/07_architecture.md)（`homeassistant`・`makase-vault`・本体の `vault`・`home`・`ledger`）、[11](../design/11_tech_spec.md)（`vault.path`・`home.*`・`human_device_classes`・`llm.roles.classify`）
- ADR：[080](../design/adr/ADR-080-home-vault.md)・[081](../design/adr/ADR-081-home-assistant.md)・[082](../design/adr/ADR-082-household-ledger.md)・[083](../design/adr/ADR-083-classify-and-local-on-pi.md)・[061](../design/adr/ADR-061-vm-no-judge-restore.md)
- 変更レポート：[2026-10-26 家に置く常駐エージェント](../design/changes/2026-10-26-home-agent.md)
- 次のステップ：[9 隔離の試験・導入手順書・段 2 と 3](09_release.md)（キットの初回設定・ラズパイでの `classify` の p95）
