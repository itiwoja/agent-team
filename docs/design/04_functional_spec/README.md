# 04. 機能仕様
- プロジェクト：Agent-Team-Open ／ 版数：v1.8（2026-10-26） ／ インプット：[03_use_cases](../03_use_cases.md)

> **3行で**
> 1. v1.0 で足したのは常駐の仕組み：受付とルーター（FR-090）・メインのターン（FR-091）・振り分けと報告（FR-092）・`send_to_owner`（FR-093）・ルーチン（FR-094）・予約した確認（FR-095）・webhook（FR-096）・記憶（FR-097。プロフィールと検索の 2 層）・文脈の組み方（FR-098）・Web Push（FR-017）。詳細は [resident.md](resident.md)。
> 2. VM は持ち主に 1 台で眠って起き（FR-074）、合図に当たった操作は人（FR-077）に回る。オートレビュー（FR-099）は入れたときだけ（既定は切る：D-351）。控えと作り直し（FR-100）を足した。詳細は [vm.md](vm.md)。
> 3. v1.6 で差別化 A・B・C の FR-101〜108 を足した（閉域・内部ホスト・台帳・規則の版と試験・再実行・監査ログの鎖・役割ごとのモデル・画面操作の道具の直し）。上限・振り分け先の選び方・パック・道具の渡し方などは [tools.md](tools.md)。
> 4. v1.7 で、ChatGPT でサインイン（FR-116。API キーなしで始める道：D-385〜390）も足した。v1.7 で家に置く FR-109〜115 も足した（キットの初回設定・家の保管庫と道具・写真の整理・家計簿・Home Assistant と機器の区分・チャットの画像の添付・仕分けの役割 `classify`）。保管庫と Home Assistant の道具の宣言は [tools.md](tools.md#保管庫と-home-assistant-の道具v17)。

## 成長機構（v1.8）
[FR-117〜122：実行履歴からの学習と局所推論](learning.md)。自然言語スキルと異なる検証済みIRを自動採用する。外部操作は既存Kernel規約を継承する。

## 🧭 判断してほしいこと
| # | 種類 | 論点 | 選択肢 | おすすめ（理由） | 決まらないと止まるもの |
|---|---|---|---|---|---|
| R-76 | リスク | ページに仕込まれた指示（プロンプトインジェクション）で、ログイン済みのブラウザを悪用される | — | 合図・確認するドメイン・汚染の扱い（BR-06）・操作の記録・オートレビューに会話を渡さない（FR-099）で抑える。残る危険は受け入れる（[11 §12](../11_tech_spec.md#12-リスクと対策)） | — |
| R-90 | リスク | オートレビューがだまされる・見逃す | — | 既定で切る（`review.auto.enabled = false`：D-351）。入れたときは、外に出す・支払う・消す・秘密・POST の送信・別オリジンの iframe は必ず人（BR-14・D-242）。会話を渡さず、ページの文は信用しない材料として枠に入れる。迷ったら stop。記録で後から確かめる | — |
| R-101 | リスク | ローカル LLM の画面操作が下手（`generic` は試し扱い） | — | 成功率の目標は持たない（NFR-093・D-354）。`llm.experimental_generic_computer = true` のときだけ選べる。能力の照合で、メイン・振り分け先は道具の呼び出しができるモデルに限る（[FR-107](resident.md#fr-107役割ごとのモデルと能力の照合)・[FR-108](vm.md#fr-108画面操作の道具を同じ作動の形に直す)） | — |
| R-104 | リスク | 接続先ごとの computer use の違いで、確かめた先と実行した先がずれる | — | 本体の中で同じ作動の形に直してから確かめ・Kernel に渡す。Kernel・box-agent・確かめは接続先を知らない。接続先ごとに同じ試験ページで確かめる（[FR-108](vm.md#fr-108画面操作の道具を同じ作動の形に直す)） | — |
| R-106 | リスク | 内部ホストの許可が広すぎる | — | 既定は空。本体・box-manager・tailnet・ホスト自身・クラウドのメタデータは固定で断る。ブラウザの作動は既定で `confirm`。外に出す・支払う・消す・秘密は必ず人（[FR-102](vm.md#fr-102内部ホストの許可)・D-343・365） | — |
| R-107 | リスク | 家電の誤操作で物理的な害が出る（鍵が開く・暖房がつきっぱなし・バルブが開くなど） | — | 機器の区分（BR-15）は Kernel の規則で決め、判断モデルや LLM は区分に使わない（BR-16）。こわい機器と、それに触る自動化は必ず人の確認。自動化を作る・変える・消すのは既定で人の確認（[FR-113](vm.md#fr-113home-assistant-のコネクタと機器の区分)。D-378） | — |
| R-108 | リスク | 写真・レシートがクラウドの LLM に出る | — | 画像を読む役割の既定はクラウドで、送った枚数を台帳に残す。中身での分類は件数と費用を先に見積もって持ち主に見せ、上限の中で行う。GPU の PC があればローカルに切り替えられる（[FR-111](vm.md#fr-111写真の整理)・[FR-112](resident.md#fr-112家計簿)。D-374・375） | — |
| R-113 | リスク | ChatGPT の枠・利用規約が変わる、無料の枠が小さくて止まる（`openai_chatgpt`） | — | 429 はほかの支払いに切り替えず止めて知らせる。自動のきっかけでは既定で使わない（`llm.chatgpt_allow_auto = false`）。能力は `tools` だけ宣言し、利用規約・無料の枠・画像・computer use は確かめてから広げる。家の中のモデルと API キーの道を残す（[FR-116](resident.md#fr-116chatgpt-でサインイン)。D-388〜390） | — |
| R-110 | リスク | 保管庫のファイルを消す・壊す | — | 消す＝ゴミ箱へ移す（30 日）。上書きは前の版を `.versions` に 30 日残す。空にする・30 日より前に消すのは必ず人。保管庫の控えは毎週、別のディスクか NAS へ（任意：NFR-095。[FR-110](vm.md#fr-110家の保管庫と道具)。D-373） | — |
| R-91 | リスク | 記憶が汚染される・作り話が入る | — | 材料を持ち主のメッセージに限る（BR-12・D-246）。情報として渡す。画面で直せる | — |

## 全体図
```mermaid
flowchart LR
 subgraph RES["resident.md：常駐"]
  F90["FR-090 受付・ルーター"] --> F91["FR-091 メインのターン"]
  F91 --> F92["FR-092 振り分け"]
  F91 --> F93["FR-093 send_to_owner"]
  F94["FR-094・095・096<br/>ルーチン・予約・webhook"] --> F90
  F91 --> F97["FR-097 記憶・FR-098 文脈"]
 end
 subgraph VM["vm.md：VM と確認"]
  F74["FR-074 VM・画面の番"] --> F76["FR-076 合図"]
  F76 -.->|"入れたときだけ"| F99["FR-099 オートレビュー"]
  F76 --> F77["FR-077 人の確認"]
  F74 --> F75["FR-075 画面の操作"]
  F102["FR-102 内部ホスト"] --> F76
  F104["FR-104 規則の版と試験"] --> F76
  F105["FR-105 再実行"] --> F104
  F106["FR-106 監査ログの鎖"] --- F105
  F108["FR-108 道具の形を直す"] --> F75
  F110["FR-110 家の保管庫と道具"] --> F111["FR-111 写真の整理"]
  F113["FR-113 Home Assistant と<br/>機器の区分"] --> F76
 end
 subgraph DIFF["resident.md：差別化 A・B・C（v1.6）"]
  F101["FR-101 閉域モード"] --> F103["FR-103 台帳"]
  F107["FR-107 役割ごとのモデル"] --> F91
 end
 subgraph HOME["resident.md：家に置く（v1.7）"]
  F109["FR-109 キットの初回設定"]
  F114["FR-114 画像の添付"] --> F112["FR-112 家計簿"]
  F115["FR-115 仕分け classify"] -.-> F112
  F116["FR-116 ChatGPT でサインイン"] --> F107
  F115 -.-> F91
 end
 F92 --> F74
 F92 -.->|"task_done"| F90
 F101 -.-> F102
 F108 -.-> F107
 F112 -.->|"レシートの保管"| F110
 F114 -.->|"元の画像"| F110
 F91 -.->|"保管庫・家電の道具"| F110
 F91 -.-> F113
```
見てほしいところ：常駐の仕組み（左）が回り、重い仕事だけが VM（右）に行く。終わったタスクはきっかけとして受付に戻る。v1.6 の FR-101〜108 は、外向きを絞って台帳に残し（FR-101・103）、判定を版つきで確かめ（FR-104〜106）、モデルを役割ごとに選ぶ（FR-107・108）。v1.7 の FR-109〜115 は、キットで始め（FR-109）、家の保管庫・写真・家計簿・家電を道具で扱い（FR-110〜114）、文章の仕分けを家の中の判断モデルで行う（FR-115）。

## 要点
- きっかけはすべて `wakes` を通る。動いているターンの間に届いた持ち主のチャットは `queued` のまま待ち、ターンが終わったらすぐ次のターンで始まる（[FR-090](resident.md#fr-090受付とルーター)）
- メインは VM を使わない。振り分け先は 1 段だけで、報告は 2,000 字まで（[FR-091](resident.md#fr-091メインのターン)・[FR-092](resident.md#fr-092振り分けと報告)）
- 地の文はチャットに出ない。話すのは `send_to_owner` だけ（[FR-093](resident.md#fr-093send_to_owner)）
- プロフィールを書く材料は持ち主のメッセージだけ（D-246。[FR-097](resident.md#fr-097記憶)）
- 先頭は次の要約まで変えず、外れは記録する。要約はターンを始める処理が 1 経路でする（[FR-098](resident.md#fr-098文脈の組み方)）
- 合図の行き先は決定論。外に出す・支払う・消す・秘密・POST の送信は人。オートレビューは入れたときだけ（[FR-076](vm.md#fr-076こわい操作の見分け)・[FR-099](vm.md#fr-099オートレビュー)・D-351）
- 閉域では外向きが許可リストの先だけ。社内のホストは `internal_hosts` に書いた先だけ。外に出た通信は台帳に全部残る（[FR-101](resident.md#fr-101閉域モード)・[FR-102](vm.md#fr-102内部ホストの許可)・[FR-103](resident.md#fr-103外に出た通信の台帳)。ADR-074）
- 判定の規則は版つきで試験が通らないと変えられず、再実行で同じ結果になり、監査ログは鎖で改ざんが分かる（[FR-104](vm.md#fr-104判定の規則の版と試験)〜[FR-106](vm.md#fr-106監査ログの鎖と検査)。ADR-076）
- モデルは役割ごとに選び、能力が足りなければ選べない。画面操作の道具は本体の中で同じ形に直す（[FR-107](resident.md#fr-107役割ごとのモデルと能力の照合)・[FR-108](vm.md#fr-108画面操作の道具を同じ作動の形に直す)。ADR-078）
- キットは QR とスマホだけで始め、「ChatGPT でサインイン」を先に出し、API キーを貼るのは別の道にする（[FR-109](resident.md#fr-109キットの初回設定)・[FR-116](resident.md#fr-116chatgpt-でサインイン)。D-387。v1.7 の追加）。API キーの道の説明（[FR-109](resident.md#fr-109キットの初回設定)。D-372・384。ADR-079）
- 家の保管庫は道具 `vault_*` で扱い、Kernel が判定する。消すのはゴミ箱へ（30 日）、空にするのは必ず人。写真の並べ替えと重複の検出は LLM なし（[FR-110](vm.md#fr-110家の保管庫と道具)・[FR-111](vm.md#fr-111写真の整理)。D-373・374。ADR-080）
- レシートの写真は読み取り → `classify` → `ledger_entries`。自信が低ければ持ち主が直す。チャットの画像は縮めて、元を保管庫に置く（[FR-112](resident.md#fr-112家計簿)・[FR-114](resident.md#fr-114チャットの画像の添付)。D-375・376。ADR-081）
- 家電は Home Assistant 経由。鍵・空調・バルブ・警報・シャッター・「こわい」に印を付けた家電は必ず人。区分は Kernel の規則で決め、判断モデルは使わない（[FR-113](vm.md#fr-113home-assistant-のコネクタと機器の区分)。D-377・378。ADR-082）
- 判断モデルの `classify` は間違えても困らない仕分けにだけ使い、自信が低ければ LLM に回す。道具ではなく本体の中で使う（[FR-115](resident.md#fr-115仕分けの役割-classify)。D-379・380。ADR-083）
- 費用は全体（`daily_usd`）と自動のきっかけ用（`daily_auto_usd`）の 2 つの日次上限で守る（[FR-013](tools.md#fr-013上限)）
- 画面の番は 1 つ。VM は 10 分で眠り、控えから戻せる（[FR-074](vm.md#fr-074vm-の起動と眠り)・[FR-100](vm.md#fr-100vm-の控えと作り直し)）

---

## 詳細

### 機能一覧
| ID | 機能名 | 概要 | 関連UC | 優先度 | 詳細 |
|---|---|---|---|---|---|
| FR-013 | 上限 | タスク・メインのターン・日次の費用（全体と自動のきっかけ用）・歩数・操作の回数・時間で止める | UC-046, UC-054 | Must | [tools](tools.md#fr-013上限) |
| FR-016 | 監査ログ | ハッシュの鎖（`prev_hash`・`row_hash`）つきの追記だけのログ。鎖の検査は FR-106 | UC-051, UC-065 | Must | [tools](tools.md#fr-016監査ログ) |
| FR-017 | Web Push 通知 | `send_to_owner`・人の確認・交代の頼みを通知（v1.0 で Must：D-207）。`closed` では切り、画面の中の通知と任意の社内 ntfy（FR-101。D-342） | UC-054, UC-047, UC-048, UC-062 | Must | [resident](resident.md#fr-017web-push-通知) |
| FR-018 | 進捗の配信 | SSE で画面に変化の合図を流す（引き継ぎ） | UC-044 | Must | [tools](tools.md#fr-018進捗の配信) |
| FR-061 | 振り分け先の選び方 | 振り分け先の一覧をメインに渡す。パックの用途を添える | UC-055 | Must | [tools](tools.md#fr-061振り分け先の選び方) |
| FR-063 | 回答を返す | 使わない（FR-093 に統合） | — | — | — |
| FR-072 | エージェントの作成・削除 | 持ち主かメインが作る・論理削除。メインは消せない | UC-045, UC-055 | Must | [tools](tools.md#fr-072エージェントの作成削除) |
| FR-073 | 持ち主の確かめ | Tailscale・Headscale のログイン名と CSRF の確かめ。社内 LAN の直結は本体のパスキー（D-358）。webhook の口は別 | UC-043, UC-062 | Must | [tools](tools.md#fr-073持ち主の確かめ) |
| FR-074 | VM の起動と眠り | 道具を使うときに起こし、10 分で眠る。画面の番 | UC-046, UC-061 | Must | [vm](vm.md#fr-074vm-の起動と眠り) |
| FR-075 | コンピューターユースの操作 | スクショと操作の繰り返し | UC-046 | Must | [vm](vm.md#fr-075コンピューターユースの操作) |
| FR-076 | こわい操作の見分け | 申告と合図で判定し、行き先（人。入れたときはオートレビュー）を決める。内部ホストの扱い（FR-102）。判定は純粋な関数（D-349） | UC-046, UC-047, UC-059, UC-063 | Must | [vm](vm.md#fr-076こわい操作の見分け) |
| FR-077 | こわい操作の確認 | 人の ○ / × を待ち、承認された1操作を1回だけ実行する | UC-047 | Must | [vm](vm.md#fr-077こわい操作の確認) |
| FR-078 | 画面の共有と交代 | 見るだけ・交代・返す | UC-048 | Must | [vm](vm.md#fr-078画面の共有と交代) |
| FR-079 | ブラウザのデータ | VM に 1 つ。全員で共通。消せる | UC-048 | Must | [vm](vm.md#fr-079ブラウザのデータ) |
| FR-080 | Web 検索・取得 | `web_search`・`web_fetch` | UC-044 | Must | [tools](tools.md#fr-080web-検索取得) |
| FR-081 | カレンダー・GitHub の書き込み | Intent・Kernel・gateway の流れ（引き継ぎ） | UC-049 | Must | [tools](tools.md#fr-081カレンダーgithub-のつなぎ方差分) |
| FR-082 | 書き出し・取り込み | 使わない（v1.4：D-316） | — | — | — |
| FR-083 | 起動と状態 | 起動の確かめ・ホストの状態を返す | UC-042 | Must | [tools](tools.md#fr-083起動と状態) |
| FR-084 | 再起動から続ける | 歩みの記録で、動いていたターンとタスクを続ける | UC-042, UC-054 | Must | [vm](vm.md#fr-084再起動から続ける) |
| FR-085 | パック | 用途ごとのエージェント集を入れる・更新・外す。メインの振り分け先になる | UC-052, UC-055 | Must | [tools](tools.md#fr-085パック) |
| FR-086 | VM のターミナル | VM の中でコマンドを実行し、リポジトリを動かして直す | UC-053 | Must | [vm](vm.md#fr-086vm-のターミナル) |
| FR-087 | LLM の接続先と道具の宣言 | 接続先（`anthropic`・`openai`・`openai_compatible`・`openai_chatgpt`）ごとに、使える道具・単価を宣言する（v1.4：D-315 を v1.6：D-352 で置き換え）。モデルの選び方は FR-107 | UC-054, UC-066 | Must | [tools](tools.md#fr-087llm-の接続先) |
| FR-088 | 道具とスキルの渡し方 | 安い順に試す。スキル・コネクタの詳細は要るときだけ。道具の約束事 | UC-054, UC-055 | Must | [tools](tools.md#fr-088道具とスキルの渡し方) |
| FR-089 | 動いているタスクへの持ち主のメッセージ | タスクの次の歩みの頭に入れる | UC-054, UC-055 | Must | [resident](resident.md#fr-089動いているタスクへの持ち主のメッセージ) |
| FR-090 | 受付とルーター | きっかけを受け、重複を捨て、行き先を決めてまとめる | UC-054 | Must | [resident](resident.md#fr-090受付とルーター) |
| FR-091 | メインのターン | 起きる → 歩む → 記憶を更新 → 眠る | UC-054 | Must | [resident](resident.md#fr-091メインのターン) |
| FR-092 | 振り分けと報告 | `delegate` でタスクを作り、報告を `task_done` で返す | UC-055 | Must | [resident](resident.md#fr-092振り分けと報告) |
| FR-093 | `send_to_owner` | 持ち主に話す唯一の道具（文・ファイル・選択肢） | UC-054 | Must | [resident](resident.md#fr-093send_to_owner) |
| FR-094 | ルーチン | プロンプトと時刻の組でメインを起こす | UC-056 | Must | [resident](resident.md#fr-094ルーチン) |
| FR-095 | 予約した確認 | メインが次に起きる時刻を予約する | UC-056 | Must | [resident](resident.md#fr-095予約した確認) |
| FR-096 | webhook | 署名を確かめて外の出来事をきっかけにする | UC-057 | Must | [resident](resident.md#fr-096webhook) |
| FR-097 | 記憶 | 2 層（プロフィール・検索）。記憶の更新の歩み | UC-058 | Must | [resident](resident.md#fr-097記憶) |
| FR-098 | 文脈の組み方 | 並べ方の固定・キャッシュの外れの記録・要約 | UC-060 | Must | [resident](resident.md#fr-098文脈の組み方) |
| FR-099 | オートレビュー（入れたときだけ） | 入れたとき（`review.auto.enabled = true`。既定は切る：D-351）だけ、合図に当たった操作を別のモデルが確かめる。判定ごとに `decided_by` | UC-059 | Should | [vm](vm.md#fr-099オートレビュー) |
| FR-100 | VM の控えと作り直し | 毎日の控え・戻す・空から作り直す | UC-061 | Must | [vm](vm.md#fr-100vm-の控えと作り直し) |
| FR-101 | 閉域モード | `network.mode = closed` で本体と VM の外向きを許可リストの先だけにする。入口の選択・通知・webhook（D-340〜342・358〜360） | UC-062 | Should | [resident](resident.md#fr-101閉域モード) |
| FR-102 | 内部ホストの許可 | `network.internal_hosts`（`browser`・`terminal` 別）にだけ届く。ホストごとに `confirm`／`auto`（D-343・365・366） | UC-063 | Should | [vm](vm.md#fr-102内部ホストの許可) |
| FR-103 | 外に出た通信の台帳 | `egress_events`・`egress_daily` に全部残す。画面と CSV（D-344・359・360・368） | UC-064 | Must | [resident](resident.md#fr-103外に出た通信の台帳) |
| FR-104 | 判定の規則の版と試験 | 規則を版つきの JSON で持ち、試験が全部通らないと保存できない。過去 30 日への試し当て（D-347・348・369） | UC-065 | Must | [vm](vm.md#fr-104判定の規則の版と試験) |
| FR-105 | 判定の再実行 | 保存した入力と版で判定をやり直し、同じ結果になる（D-349） | UC-065 | Must | [vm](vm.md#fr-105判定の再実行) |
| FR-106 | 監査ログの鎖と検査 | `prev_hash`・`row_hash`、毎日の末尾の控え、検査（D-350） | UC-065 | Must | [vm](vm.md#fr-106監査ログの鎖と検査) |
| FR-107 | 役割ごとのモデルと能力の照合 | 役割ごとに接続先（4 つ目に `openai_chatgpt`）とモデルを選び、能力が足りなければ選べない（D-352・353・355・361〜364・385・389・390） | UC-066 | Must | [resident](resident.md#fr-107役割ごとのモデルと能力の照合) |
| FR-108 | 画面操作の道具を同じ作動の形に直す | 接続先ごとの computer use を本体の中で同じ形に直してから確かめ・Kernel へ（D-354） | UC-066 | Must | [vm](vm.md#fr-108画面操作の道具を同じ作動の形に直す) |
| FR-109 | キットの初回設定 | 電源と LAN → Tailscale の招待 → QR でパスキー → ChatGPT でサインイン（API キーは別の道）→ 最初のお願い。15 分以内（D-372・384・387） | UC-067 | Must | [resident](resident.md#fr-109キットの初回設定) |
| FR-110 | 家の保管庫と道具 | `makase-vault` と道具 `vault_list`・`vault_read`・`vault_write`・`vault_move`・`vault_trash`。消すのはゴミ箱へ（30 日）・上書きは前の版（D-373） | UC-068 | Must | [vm](vm.md#fr-110家の保管庫と道具) |
| FR-111 | 写真の整理 | 撮影日・場所・重複・縮小版は本体のプログラム。中身での分類は見積もりを見せてから（D-374） | UC-068 | Must | [vm](vm.md#fr-111写真の整理) |
| FR-112 | 家計簿 | レシートの写真 → 読み取り → `classify` → `ledger_entries` → カレンダーと照らす。月ごとの画面と CSV（D-375） | UC-069 | Should | [resident](resident.md#fr-112家計簿) |
| FR-113 | Home Assistant のコネクタと機器の区分 | HA の API を長期トークンで呼ぶ。状態・操作・自動化。区分は Kernel の規則で必ず人（D-377・378） | UC-070 | Must | [vm](vm.md#fr-113home-assistant-のコネクタと機器の区分) |
| FR-114 | チャットの画像の添付 | 1 回 10 枚・1 枚 20MB まで。縮めて、元を保管庫へ。汚染の印（D-376） | UC-071 | Must | [resident](resident.md#fr-114チャットの画像の添付) |
| FR-116 | ChatGPT でサインイン | 接続先 `openai_chatgpt`。デバイスコードで承認し、API キーなしで持ち主の枠を使う。403・429・切れたときの扱い。自動のきっかけでは既定で使わない（D-385〜390） | UC-066, UC-067 | Must | [resident](resident.md#fr-116chatgpt-でサインイン) |
| FR-115 | 仕分けの役割 `classify` | 判断モデル（`decision`）で仕分け。自信が低ければ LLM。ローカル生成モデルの扱い（D-379・380） | UC-072 | Should | [resident](resident.md#fr-115仕分けの役割-classify) |

### 権限マトリクス
持ち主1人なので、ロールの表は持たない。持ち主はすべての API を使える。持ち主以外は何も使えない（FR-073）。webhook の口（API-129）は署名を持つ送り手だけが使える。

エージェントの道具の範囲は役で分ける：

| 道具 | メイン | 振り分け先 |
|---|---|---|
| `send_to_owner`・`delegate`・`schedule_wake`・`propose_routine`・`list_tasks`・`steer_task`・`cancel_task` | ○ | — |
| VM（computer use・`open_url`・`read_page`・`confirm_action`・`request_takeover`・ターミナル） | — | ○ |
| `report` | — | ○ |
| `web_search`・`web_fetch`・コネクタ（書き込みは確認つき）・`read_skill`・`search_memory` | ○ | ○ |
| `vault_list`・`vault_read`・`vault_write`・`vault_move`・`vault_trash`・`home_state`・`home_call`・`home_automation_put`・`home_automation_delete`（Kernel が判定：[tools](tools.md#保管庫と-home-assistant-の道具v17)） | ○ | ○ |

### ステータス定義
| 対象 | 値 | 意味 | 遷移先 |
|---|---|---|---|
| `wakes.status` | `queued` | 受けて並んでいる | consumed, dropped |
| | `consumed` | ターン・タスクに渡した | 副作用未発生を証明できる失敗のみqueued/dropped。確定済み/不明ならconsumed維持（D-337） |
| | `dropped` | 日次の上限・行き先がない・戻した回数を超えた・webhook が 1 分 60 件を超えた（終わり。重複は `source_key` の UNIQUE で行を作らない） | — |
| `turns.status` | `running` | メインが歩んでいる | done, halted, failed |
| | `done`・`halted`・`failed` | 終わり（`halted` は上限、`failed` は LLM の失敗） | — |
| `turns.halt_reason` | `budget_exceeded`・`daily_budget_exceeded`・`steps_exceeded`・`timeout`・`context_exceeded` | 1 ターンの $1・日次の上限・40 歩・10 分（D-289）・呼び出し前の入力が 20 万トークンを超えた（次のターンの開始で要約する：D-323） | — |
| `tasks.status` | 今の値のまま（`schema.ts` の CHECK：`queued`・`provisioning`・`running`・`awaiting_approval`・`executing`・`succeeded`・`completed`・`rejected`・`failed`・`cancelled`・`halted`）。振り分けのタスクの終わりは `completed`（報告の `done`・`blocked`）・`failed`・`halted`・`cancelled` を使う（D-254・D-257） | 今のまま | 今のまま |
| `tasks.halt_reason`（足す値） | `vm_replaced`（控えに戻した・作り直した：D-268） | — | — |
| `tasks.status_detail`（足す値） | `waiting_vm`・`waiting_screen`・`taken_over`・`waiting_takeover`・`running_command`・`auto_review` | VM の起動待ち・画面の番待ち・交代中・交代の頼み・コマンドを実行中・オートレビュー中（v0.6 の `waiting_box` は `waiting_vm` に） | — |
| `boxes.status` | `starting` | 起こしている | running, failed |
| | `running` | 使っている（操作する人は `boxes.control`） | stopping, failed |
| | `stopping` | 止めている | stopped |
| | `stopped` | 止まった（眠った。終わり） | — |
| | `failed` | 起動・動作に失敗した（終わり） | — |
| `boxes.control` | `agent` | エージェント（画面の番を持つタスク）が操作する | handing_over |
| | `handing_over` | 人に渡す準備中 | human |
| | `human` | 人が操作する | agent |
| `takeovers.status` | `requested` | エージェントが頼んだ | active, expired |
| | `active` | 人が操作している | ended, expired |
| | `ended` | 人が返した（終わり） | — |
| | `expired` | 頼みのまま30分・交代中に15分操作がない・再起動（終わり。放置のときはタスクを報告の `blocked` で閉じる：D-257） | — |
| `browser_checks.status` | `pending` | 確認待ち | executing, rejected, expired |
| | `executing` | 承認され、実行を頼んだ | executed, expired, unknown_outcome |
| | `executed`・`rejected`・`expired`・`unknown_outcome` | 終わり | — |
| `browser_checks.expire_reason` | `approval_timeout`・`page_changed`・`taken_over`・`box_restarted`・`task_cancelled`・`screen_lost`・`vm_replaced`（控えに戻した・作り直した：D-308） | 期限切れの理由 | — |
| `auto_reviews.verdict` | `pass`・`stop`・`error`（時間切れ・形が違う） | `stop`・`error` は人の確認に回る | — |
| `sandbox_commands.status` | `queued` | 受け付けた | running |
| | `running` | VM で実行中（再開時にこのままなら、やり直さず Claude に伝える） | done, expired |
| | `done` | 終わった（終わり） | — |
| | `expired` | 世代が替わるなどで実行されなかった（終わり） | — |
| `routines.enabled` | 1・0 | 動かす・止めた | — |
| `scheduled_wakes.status` | `pending`・`fired`・`cancelled` | 待っている・起こした・消した | — |
| `workspace.vm_op` | `none`・`starting`・`stopping`・`snapshotting`・`restoring`・`rebuilding`・`clearing_browser` | 排他。復元/作り直し/消去は結果DB確定とACK後だけnone。応答不明は維持（D-333・334） | [10 states](../10_diagrams/states.md#workspacevm_op) |
| `workspace.vm_home_state` | `ok`・`broken` | VM のホームの状態。`broken` は戻す・作り直すだけ受ける（D-294） | [10 states](../10_diagrams/states.md#workspacevm_home_state) |
| `push_outbox.status` | `pending`・`sent`・`failed`・`expired`・`skipped` | Web Push の送り待ち。購読ごとの行（D-267・D-288）。`skipped` は見えている端末があって送らなかった | — |

`action_intents` の値は今のまま（[08](../08_database/README.md#変える表)）。`asks.status` は使わない（D-235）。

### 知らせ
知らせるのは伝える価値があるものだけ（D-197・D-229）。画面を開いていれば SSE、閉じていれば Web Push。中身は [FR-017](resident.md#fr-017web-push-通知)。

## このドキュメントで決まったこと
- [ADR-047](../adr/ADR-047-risky-action-check.md)：こわい操作は申告＋合図
- [ADR-052](../adr/ADR-052-browser-checks-table.md)：ブラウザの確認は別の表
- [ADR-053](../adr/ADR-053-pack-by-purpose.md)：パックは「用途」の単位
- [ADR-054](../adr/ADR-054-terminal-in-vm.md)・[ADR-061](../adr/ADR-061-vm-no-judge-restore.md)：ターミナルは VM の中。確認は VM の外に効くものだけ
- [ADR-058](../adr/ADR-058-resident-agent.md)〜[ADR-067](../adr/ADR-067-web-push-first.md)：常駐型の仕組み
- ADR-068：ブラウザとターミナルを別のコンテナにする。ADR-069：費用は自動のきっかけ用の別上限で守る。ADR-070：記憶は 2 層（プロフィールと検索）
- v1.6：[ADR-074](../adr/ADR-074-closed-network.md)（閉域）・ADR-075（チームで 1 台。v1.7 で不採用）・ADR-076（判定を確かめられる）・ADR-077（オートレビューは既定で切る）・ADR-078（役割ごとのモデル）、D-340〜D-370
- v1.7：ADR-079〜083（家に置く常駐エージェント）、D-371〜D-384
- D-141〜D-144、D-150〜D-153、D-157〜D-163、D-165〜D-167、D-171、D-173・D-174・D-176・D-178・D-180・D-181・D-186・D-187・D-191〜D-198、D-201〜D-238、D-275〜D-289（[00 決定事項ログ](../00_overview.md#決定事項ログ)）、D-315〜D-328
