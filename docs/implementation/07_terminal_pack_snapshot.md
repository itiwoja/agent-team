# ステップ 7. ターミナル・パック・VM の控え
- プロジェクト：Agent-Team-Open ／ 手順書の版：v1.3（2026-10-26） ／ 設計の版：v1.8 ／ インプット：[04 vm](../design/04_functional_spec/vm.md)（FR-079・086・100）、[04 tools](../design/04_functional_spec/tools.md)（FR-085・088・061）、[08 vm](../design/08_database/vm.md)、[08 resident](../design/08_database/resident.md)、[09 vm](../design/09_api/vm.md)、[10 sequences](../design/10_diagrams/sequences.md)、[10 states](../design/10_diagrams/states.md)、[11](../design/11_tech_spec.md)

> **3行で**
> 1. 振り分け先のエージェントが VM のターミナルでコマンドを動かしてファイルを出し入れでき、パックを入れて使え、VM のホームを毎日控えて戻す・作り直す・ブラウザのデータを消すことができるようになる。
> 2. 作るのは、shell-agent のコマンド実行（API-117）と tar（API-118）、本体の `sandbox_commands` とターミナルの道具、パックの JSON・検証・入れる／外す（API-114〜116）、標準パック `packs/announcement-page.json`、box-manager の控え・戻す・作り直す・ホームの測り・ブラウザのデータを消す（API-108・143・144・109）、本体の `vm_op` の直列・毎日の控え・5 秒の問い合わせ・戻すときに止めるタスク（API-133〜135・138）。
> 3. 終わる条件：UC-052・053・061 の基本フローが通り、告知ページ 1 件が GitHub の PR まで届く（VM まわりの段 1 の終わり。家の機能は次のステップ 8）。

## 前提（始める条件）
- **入力**：ステップ 1〜6 が終わっている
  - ステップ 1：`box-shell`（利用者 `agent`・`/home/agent`）と shell-agent（`healthz` だけ）、egress（送り元でコンテナを分ける・許可リストは起動時に環境変数かファイルから読む）、box-manager の最小（API-101・102・103・105・106・109 の「世代の一覧」まで）、`makase-browser-profile`・`makase-vm-home` の 2 つのボリューム
  - ステップ 3：`apps/makase` が Compose で動く（データのボリューム `/data`）。表（migration）は版 4・5 で全部作ってある（`sandbox_commands`・`vm_snapshots`・`takeovers` を含む）
  - ステップ 4：`boxes`・`vm_op` の `starting`・`stopping`、画面の番、`computer/`（box-manager のクライアント）、毎分のタイマーの登録口、再開の表の登録口、`report` と `read_skill`、メインの振り分け先の一覧、交代（API-089〜091・113・`takeovers`・道具 `request_takeover`）。ターミナルの道具と成果物の写し（`~/work/<taskId>` → `/data/files/<taskId>/`）は口だけある
  - ステップ 5：GitHub の gateway（PR の Intent・確認・`approval_done`）。ステップ 6：SCR-021 の「ターミナル」欄の枠、SCR-023 の VM の欄と SCR-024 `/packs`（どちらも骨まで。実 API につなぐのはここ）
  - `apps/app`・`apps/worker` はステップ 3 の 3.7 で消えている。「移す元」の `apps/app/src/packs/`・`apps/worker/src/db/repo/sandbox.ts` は、消したコミット（SHA は [05_triggers.md](05_triggers.md) の「前提」に書いてある）から `git show <sha>:<path>` で読む。`apps/sandbox`・`packages/sandbox` はステップ 1 から残っていて、7.2 の最後で消す
  - ステップ 3（v1.6・v1.7 の分）：`network.internal_hosts` と `closed` の許可リストを box-manager 経由で egress に渡す道（FR-102・FR-101）と、egress の記録を毎分取って台帳に入れる道（FR-103）がある。このステップの `terminal.allow_hosts` も同じ道で渡し、`closed` では `network.allow_hosts` と内部ホストの `terminal` 側に入っている先だけが効く（D-366）
  - 入れないもの：掃除のための起動（API-145・146。D-319）、書き出し・取り込み（D-316）、人がターミナルを直接打つ画面（次の版）
- **機械**：置き先は段 1（手元の WSL2、amd64）
- **鍵とアカウント**：`ANTHROPIC_API_KEY`（7.7 の通し）、GitHub をつないだ試験用のリポジトリ（PR の宛先。持ち主の本物のリポジトリは使わない）、`BOX_MANAGER_TOKEN`

## 作るもの
| 部品 | 置き場 | 移す元（あれば） | 設計の参照 |
|---|---|---|---|
| shell-agent のコマンド実行（API-117 の受け手） | `apps/shell-agent/src/commands.ts` | `packages/sandbox/src/executor.ts` の `executeCommand`（6 つの道具）・`runShell`・`commandEnv`・`clipTail`。作り替え：コマンドを取りに行く形（`claim`・`next`・`result`）をやめ、受ける側の HTTP にする。出力は 20,000 字を 64KB に、時間は既定 120 秒・最大 300 秒を 120 秒に、`timeout_sec` を `timeoutSec` に | FR-086・API-117 |
| shell-agent の起動・トークン | `apps/shell-agent/src/main.ts` | 旧 `apps/sandbox/src/main.ts` は参考だけ。旧資格共有/root降格を移植せず、SHELL_TOKEN専用・非root起動・子環境から資格を除外する。環境変数削除を隔離境界にしない | 07 shell-agent の行、IMP-001 |
| shell-agent の tar（API-118） | `apps/shell-agent/src/files.ts` | `packages/sandbox/src/tar.ts` の `safeRelativePath`・`createTarGz`・`readTarGz` と `executor.ts` の `resolveInRoot`・`collectFiles`・`extractArchive` | FR-086 4a・D-306 |
| 本体の tar を広げる側（リンク・絶対パス・`..` を捨てる） | `apps/makase/src/terminal/untar.ts` | `packages/sandbox/src/tar.ts` の `readTarGz`（通常ファイルだけ返し、リンク・装置・`..`・絶対パスを捨てる作りがそのまま D-306 に当たる） | D-306 |
| box-manager の API-117・118 の中継 | `apps/box-manager/src/shell.ts` | 新規 | 09 内部 API |
| `sandbox_commands` の repo（表はステップ 3 の版 4・5 で作成済み。無い列・索引だけ新しい版で足す） | `apps/makase/src/db/`（`repo/sandbox-commands.ts`・足す migration） | `apps/worker/src/db/schema.ts` の `sandbox_commands`（`session_id` → `box_id`、`output` 上限を 65536 に。列の突き合わせに使う）と `db/repo/sandbox.ts` の `enqueueSandboxCommand`・`claimNextSandboxCommand`・`completeSandboxCommand`・`expireSandboxCommand` | TBL-040 |
| ターミナルの道具 6 つ・200 回・同時 2 本待ち | `apps/makase/src/terminal/` | `apps/worker/src/edge/sandbox-command.ts` は**使わない**（`run_shell` を拒否する旧い判定。BR-08 で判定しない） | FR-086・NFR-080 |
| パックの JSON の検証・読み込み・入れる／外す | `apps/makase/src/packs/`（`schema.ts`・`load.ts`・`install.ts`・`routes.ts`） | `apps/app/src/packs/install.ts`（エージェントを作る・スキルを付ける・`pack_installs` に記録する流れ）、`contract.ts`（zod の応答の形）、`types.ts`（`PackSkill`）。`catalog.ts` の定数の棚と `TRUSTED_SKILLS` は使わない | FR-085・API-114〜116 |
| 標準パック | `packs/announcement-page.json` | `apps/app/src/packs/library/designer.ts`（スキルの `name`・`description`・`body` の書き方。`description` は 200 字まで）。旧 9 パックは移さない | FR-085 の表・D-186 |
| box-manager の控え（API-143） | `apps/box-manager/src/snapshot.ts` | なし（新規） | FR-100・NFR-084 |
| box-manager の戻す・作り直す・印ファイル（API-108） | `apps/box-manager/src/home.ts` | なし | FR-100・D-294 |
| box-manager のホームの測り・自分で止める（API-109） | `apps/box-manager/src/measure.ts` | なし | FR-074 の容量・D-309 |
| box-manager のブラウザのデータを消す（API-144） | `apps/box-manager/src/browser-data.ts` | なし | FR-079 |
| 本体の VM の操作（`vm_op` の直列・控え・戻す・作り直す・消す） | `apps/makase/src/computer/vm-op.ts`・`snapshots.ts`・`routes/vm.ts` | ステップ 4 の `computer/`（`starting`・`stopping`）に足す | FR-100・API-133〜135・138 |
| 再開の表の行（`vm_op` の `snapshotting`・`restoring`・`rebuilding`、`vm_snapshots` の `creating`、`sandbox_commands` の `running`。持ち主は 7） | `apps/makase/src/recovery/` | ステップ 4 の `registerRecovery` に足す | FR-084・D-295 |
| `vm_snapshots` の repo（表はステップ 3 の版 4・5 で作成済み。無い列・索引だけ新しい版で足す） | `apps/makase/src/db/` | なし | TBL-052 |
| 消すもの | `apps/sandbox`・`packages/sandbox` | 7.2 の最後で消す | — |
| eval (4) の台帳 | `evals/cases/<日付>-announcement-*/` | ステップ 2 の `evals/cases/` の `kind` の欄 | 11 §11 |

## 手順
### 7.1 shell-agent のコマンド実行（API-117）
1. `apps/shell-agent` に `POST /commands` を足す（boxネットワークのアドレスにだけ結び、SHELL_TOKENで認証。BROWSER_TOKENは受け付けない）。受け取る：`{ actionId, tool, args, timeoutSec }`。`tool` は6つ（`run_command`・`list_files`・`read_file`・`search`・`write_file`・`delete_file`）。ほかは400
2. `executor.ts` の `executeCommand` の中身を移す。ファイルの道具の根は `/home/agent`（`SANDBOX_ROOT` の既定 `/workspace` をやめる）。`run_command` の `cwd` の既定は `~/work/<taskId>`（強制しない）。`commandEnv` の `HOME` は `/home/agent`、`PIP_USER`・`npm_config_cache`・`PATH` の `~/.local/bin` はそのまま（入れたツールをホームに残す：D-272）
3. 上限：1 コマンド 120 秒（`timeoutSec` が超えたら 120 に切る）。出力は `clipTail` で 64KB（バイト）に切り、`truncated: true` を返す。時間切れは `ok: false`・出力に打ち切りの文を足して返す（`COMMAND_TIMEOUT`）。プロセスのグループごと止める（`runShell` の `detached` と `kill(-pid)`）
4. 同時 2 本：3 本目は 409 `COMMANDS_FULL`。`actionId` が実行済みなら前の結果を返す（メモリに最近の分を持つ。shell-agent が再起動したら世代が替わるので足りる）
5. 利用者 `agent` で動かす（コンテナ自体がagent。rootから落とす分岐なし）。コマンド/tar等の子プロセスには明示的な環境を渡し、SHELL_TOKEN・BROWSER_TOKENを含めない。BROWSER_TOKENはshellコンテナ自体にも渡さない。環境変数削除だけで管理プロセスの初期環境を秘匿できるとは扱わず、SHELL_TOKENが読まれてもブラウザ権限にはならない分離を試験する
6. `terminal.allow_hosts`：API-096 に `terminal` 欄はある（09 の表）が、egress への届け方だけが設計にない。v1.7 では、ステップ 3 で `network.internal_hosts`・`closed` の許可リストを box-manager 経由で egress に渡す道ができているので、`terminal.allow_hosts` もそこに載せる（「実装で決めること」）。まず `HTTP_PROXY`・`HTTPS_PROXY` を egress に向け、`docker exec -u agent` で `curl` が許可リスト内だけ通ることを確かめる
確かめ：shell-agent に直に `curl` で `run_command` を送ると出力と `exitCode` が返る。121 秒の `sleep` は打ち切られる。出力 100KB のコマンドが 64KB に切られ `truncated`。3 本同時に送ると 3 本目が 409。同じ `actionId` の 2 回目は実行されず前の結果が返る。`ls /home/browser`・`ls /tmp/.X11-unix` に何もない。

### 7.2 tar の出し入れ（API-118）と box-manager の中継
1. shell-agent に `PUT /files?path=`・`GET /files?path=`。`path` は `/home/agent` の下だけ（それ以外は 400）。PUT は tar を受けて広げる（`agent` として）、GET は tar を作って返す。どちらもリンクはたどらない（`tar` のコマンドなら `--no-dereference` が既定。Node で作るなら `lstat` で見て、リンクはリンクのまま入れるか除く：「実装で決めること」）
2. `apps/box-manager` にAPI-117・118の中継（`/internal/v1/boxes/:boxId/commands`・`/files`）。世代が違えば409 `STALE_CONTROL`、SHELL_TOKENでshell-agentに転送する。BROWSER_TOKENをこの経路に渡さない。tarは本文を流しメモリに溜めない
3. 本体の `terminal/untar.ts`：受け取った tar を広げるときに、シンボリックリンク・ハードリンク・装置ファイル・絶対パス・`..` を捨て、捨てた件数をログに残す（D-306）。展開後の合計の上限を持つ（`readTarGz` の `maxBytes` の考え方）
4. 成果物の写し（D-244）：`report` を閉じるとき、`~/work/<taskId>` の下だけを API-118 の GET で取り、`untar.ts` で広げて `/data/files/<taskId>/` に写す（合わせて 20MB まで）。ステップ 4 の口をここで埋める。VM が眠っていれば写しの前に起こす
5. リポジトリの入れ：gateway が GitHub から取った tar を API-118 の PUT で `~/work/<taskId>` に入れる。変更の取り出し：GET の tar と入れた時点の tar を並べて差分にし、PR の Intent に乗せる（ステップ 5 の gateway の口へ。確認つき）
6. shell-agent に移し終えたら `apps/sandbox`・`packages/sandbox` を消し、`pnpm typecheck / test / lint:deps` を通す。それらを参照する設定（`pnpm-workspace.yaml`・各 `package.json`・Compose・CI）も直す
確かめ：`~/work/t1` に Cookie の絶対パスを指すシンボリックリンクと `../x` を含む tar を作らせて GET → 本体で広げると、通常ファイルだけが `/data/files/t1/` に残り、リンクは残らない。`/home/agent` の外への PUT は 400。差分が元の tar と変更後の tar の違いだけになる。`git ls-files apps/sandbox packages/sandbox` が空で、`pnpm typecheck / test / lint:deps` が通る。

### 7.3 `sandbox_commands`・ターミナルの道具・200 回
1. 表はステップ 3 の版 4・5 で作成済み。`sandbox_commands`（TBL-040。`id` は `actionId` を兼ねる、`box_id`・`task_id`・`tool`・`args`・`status`・`ok`・`output`・`exit_code`、`status = 'done'` ⇔ `ok IS NOT NULL`、索引 `(box_id, created_at)`）に無い列・索引だけを新しい版で足す。旧 `sandbox_sessions` は作らない
2. ターンの道具（`terminal/tools.ts`）：振り分け先のエージェントだけが持つ 6 つ。メインには渡さない（D-236。一覧の単体で固定）。呼ばれたら、`queued` の行を書き、`running` にして API-117 を呼び、`done`（`ok`・`output`・`exit_code`）か `expired` にする。判定（`judgeBrowserAction`）は通さない（BR-08）。画面の番も `control` も `control_epoch` も見ない（D-296）
3. VM の前処理：VM が止まっていれば起こす（ステップ 4 の `computer/` の `starting`。`vm_home_state` が `broken`、ホームが 4GB 超え、ホストの空きが 3GB 未満なら起こさず、エラーを道具の結果に返す：FR-074 1a・1b）
4. 同時 2 本は VM 全体で数える。2 本動いているとき 3 本目は `running_command` の前で待つ（API-117 の 409 `COMMANDS_FULL` を受けたら待って出し直す）。タスクの中は 1 つずつ
5. 1 タスク 200 回（`terminal.max_commands`）：`sandbox_commands` の行数で数え、201 回目は実行せずタスクを `halted`（`budget_exceeded`）にしてメインに報告する。回数は `policy` の `terminal` 欄から読む
6. 出力と読んだファイルは外の内容として汚染する（BR-06）。以降のカレンダー・GitHub への書き込みは確認に回る（ステップ 2・5 の汚染の扱いをそのまま使う）
7. `started`（`running`）のまま本体が再起動したら `expired`。やり直さず、Claude に「前のコマンドが実行されたか分からない」を渡す（この行の持ち主は 7。再開の表の行をステップ 4 の登録口に足す）
8. SCR-021 の「ターミナル」欄に出す一覧の読み出し（`sandbox_commands` を `task_id` で）と SSE の合図を足す
確かめ：台本の LLM で `run_command`→`write_file`→`read_file` を通すと `sandbox_commands` に 3 行が `done` で入る。201 回目でタスクが `halted`。交代中（`control = human`）でもコマンドが動く。本体を `running` の最中に落として再起動すると `expired` になり、台本に「実行されたか分からない」が渡る。

### 7.4 パックの JSON・検証・入れる・更新・外す（API-114〜116）・`read_skill`・振り分け先の一覧
1. `packs/schema.ts`（zod）：FR-085 の表のとおり。`formatVersion`（知っている版より新しければ `PACK_INVALID`）、`id`（kebab-case 2〜40 字）、`version`（整数）、`name`、`purpose`、`examples`（3〜10 個）、`agents[]`、`skills[]`（`name` 60 字・`description` 1〜200 字・`body` 20,000 字まで。旧 `agent_skills` の CHECK と同じ値）、`browser`（確認するドメイン・`human_words`・`confirm_words` の追加分）。`agents[].skills` が `skills[]` の名前を指すことも確かめる。`agents[]` の各項目のキーは「実装で決めること」
2. `packs/load.ts`：`/opt/makase/packs/*.json` と `/data/packs/*.json` を読む。同じ `id` が両方にあれば `/data/packs/` を優先せず、起動時に警告を出して `/opt/makase/packs/` を使う（おすすめ。「実装で決めること」）。壊れた JSON は一覧に出さず、理由をログに残す
3. API-114：置き場のパックと `pack_installs` を突き合わせて `installed`・`available` を返す。API-115：検証→トランザクションで `pack_installs` に記録→`agents[]` からエージェントを作る（ステップ 4 の `delegate` の `newAgent` と同じ検証・作り方を使う）→`skills[]` を `agent_skills`（`origin = 'pack'`・`pack_id`）に入れる→`browser` の追加分をポリシーの新しい版に足す。同じ版が入っていれば 409 `PACK_ALREADY_INSTALLED`
4. 更新：`version` が上がっていれば、パックのエージェントの設定とスキルを作り直す。手で変えた設定が失われることは、画面（SCR-024）が先に知らせる。API は確かめなしで受けるので、画面側のダイアログで止める
5. API-116：パックのエージェントが動いていれば 409 `AGENT_BUSY`。なければエージェントを論理削除し、`agent_skills`・`pack_installs` の行を消し、`browser` の追加分をポリシーから戻す（戻し方は「実装で決めること」）。VM のログインは消さない（BR-07）
6. `read_skill`（ステップ 4 で作った道具）が `agent_skills` を引けること、渡す最初の一覧が名前と `description` だけで本文は読んだときだけ会話に入ること、読むと `last_used_at` が更新されることを、パックのスキルで確かめる。旧 `TRUSTED_SKILLS`（`apps/app/src/packs/catalog.ts`）は使わない。`/data/packs/` のスキルを信頼するかは「実装で決めること」
7. メインの振り分け先の一覧（FR-061）にpurpose・examplesを添える。入れる・外す・更新のあとも保存済み③を作り直さない。次ターンには変更通知だけをuserメッセージとして追記し、描いた文をinput歩みに保存する（FR-098）。固定部分を更新するのは次の要約で新しいcontext_snapshotsを作るときだけ。パック更新→要約しない次ターン→本体再起動で、fixed_parts_json/parts_hashが更新前と同一、変更通知も同一バイトで再構成されることを試験する
8. ステップ 6 で骨だけ作った SCR-023 の VM の欄と SCR-024 を、ここで実 API につないで確かめる。この手順では SCR-024 を API-114〜116 につなぐ（SCR-023 の VM の欄は 7.7 の 11）。パック由来のエージェントにパック名のラベルが付くことを SCR-014 で確かめる
確かめ：試験用の最小のパック（エージェント 1・スキル 1）で、入れる→`agents`・`agent_skills`・`pack_installs` の行ができ、メインの一覧に `purpose` が載る。同じ版の再入れは 409。`version` を上げて更新、`description` 201 字・`formatVersion` が新しすぎる・`id` が kebab-case でないものはすべて 422 `PACK_INVALID`。動いているタスクのあるパックの外しは 409 `AGENT_BUSY`。外したあと `browser` の追加分が消える。

### 7.5 標準パック `announcement-page` を書く
1. `packs/announcement-page.json` を FR-085 の標準パックの表どおりに書く。`id: announcement-page`、`name: 告知ページ制作`、`purpose`・`examples`（表の 3 件）。`agents[]` は 1 人（告知ページ制作係）、使う道具はターミナル・VM のブラウザ・GitHub
2. `skills[]` は 4 本：設計（日時・会場・料金・対象・申込先を聞き切って構成を決める）・制作（HTML と CSS を 1 ファイルで書く）・点検・仕上げ。各 `description` は「〜のときに使う」の形で 200 字まで。各 `body` は次の雛形で書く
   - 見出しの型：`# <題>`、`## 目的`、`## いつ使うか`、`## 手順`（番号つきで 5〜8 行）、`## 出力物`、`## やらないこと`
   - 設計の骨：聞き切る項目の一覧（日時・会場・料金・対象・申込先）を先に出し、足りない項目は持ち主に聞き返す。揃ったら構成（見出しの順・載せる項目）を決めて、制作に渡す
   - 制作の骨：HTML と CSS を 1 ファイルにして `~/work/<taskId>` に書く。申込フォームは作らず、申込先はリンクか連絡先の文にする
   - 点検の骨：`~/work/<taskId>` で簡易サーバーを立て、`shell:8000` を 1280×800 と 360px 幅の 2 つの幅で開く。必須項目の抜け・誤字・リンクを見る
   - 仕上げの骨：HTML を `~/work/<taskId>` に置いて `report` で渡し、PR の Intent を GitHub の道具で出す。公開はしない
   - 評価の基準：7.8 と eval (4) の 3 件が通ること
3. 点検の手順書：`~/work/<taskId>` で簡易サーバーを立て（`python3 -m http.server 8000` を背景で）、VM のブラウザで `http://shell:8000/` を 1280×800 と 360px 幅で開き、必須項目の抜け・誤字・リンク・スマホ表示を確かめる（D-266）。確認するドメインはなし。サーバーを使い終えたら止める手順を書く
4. 申込フォームは作らず、申込先はリンクか連絡先の文にする。公開はしない：成果物は PR にして、公開は PR の先で人がする（BR-10）。点検は承認の代わりにならない（D-187）
5. `browser` の `human_words` の追加分に「公開」「Publish」を入れる
6. 成果物の届け方を手順書の最後に書く：HTML を `~/work/<taskId>` に置いて `report` で渡し（本体が `/data/files/<taskId>/` に写す：D-244）、PR の Intent を GitHub の道具で出す。持ち主への連絡はメインが `send_to_owner` の `file` で渡す
7. イメージに入れる：本体の Dockerfile で `packs/` を `/opt/makase/packs/` に写す
8. 書き方の参考は「実装で決めること」。評価の基準は 7.8 と eval (4) の 3 件が通ること。書いたら 7.4 の検証に通す（単体）
確かめ：`announcement-page.json` が検証に通り、API-114 の `available` に出る。API-115 で入れると 1 人と 4 本のスキルができ、`read_skill` で 4 本を読める。

### 7.6 box-manager の控え・戻す・作り直す・ホームの測り・ブラウザのデータを消す
1. ホームの測り（API-109 に足す）：VM が動いている間、毎分、`makase-browser-profile` と `makase-vm-home` の合計の大きさと、ボリュームのあるファイルシステムの空きを測り、`homeBytes`・`hostFreeBytes`・`measuredAt` を返す。ホームが 4GB 超えなら動いているコマンドを止めて VM を止める（`disk_quota`）。空きが 3GB 未満でも止める（`disk_low`）。止めた世代と理由を API-109 に載せる。測り方は「実装で決めること」
2. 控え（API-143）：POST `{ snapshotId }` は VM が動いていれば 409、空きが「ホームの大きさ＋3GB」未満なら 507 `DISK_LOW`、それ以外は印を書いて 202 を返し、裏で書く。2 つのボリュームを読み取りだけでつなぎ、`browser/` と `home/` を 1 つの tar にして zstd にし、`makase-vm-snapshots` の `/snapshots/<id>.tar.zst` に書く（書きかけは別名で書き、終わったら名前を変える）。GET は `running`・`done`（`path`・`sizeBytes`）・`failed`・`unknown`（知らない `snapshotId`）。DELETE は止めて書きかけを消す
3. 復元・作り直しはAPI-108のoperationId契約を実装する。ID/引数を永続化して202、done/failedはACKまで保持。GETでnoneなら未受付、同じID/引数で再送可。同じIDで引数違いは409。PATCH ACKは冪等、DELETE打ち切りは停止確認後failed。成功の印を完了直後に消してはならない（IMP-005）
4. 起こすの側（API-101）に足す：戻し・作り直しの印ファイル（`failed` を含む）がある、または控えを書いている間は 409 `VM_BUSY`。ホストの空きが 3GB 未満なら 507 `DISK_LOW`
5. box-manager の起動時：印ファイルが `running` のまま残っていれば（box-manager が落ちていた）最初からやり直す（D-251）。控えの書きかけは消し、GET は `unknown` を返す
6. 消去API-144も同じ操作ID・結果保持・ACK契約。managerは起動/控え/復元/消去の共通排他で競合を拒否。再起動はrunningの同じ消去を停止確認後にやり直し、完了結果は保持（IMP-006）
7. 新しい控えを書き終えて確かめる（tar を最後まで読めること・大きさ）までは、古い控えを消さない。失敗したら古い控えは消さない（本体が 3 世代の整理をする）
確かめ：box-manager 単体の試験。2GB のホームで API-143 を叩いて `done`、5 分以内（NFR-084）。控えを戻すと 2 つのボリュームが一緒に戻る（Cookie と `~/work` の両方）。戻しの途中で `docker kill` した box-manager を起こし直すと、印ファイルから最初からやり直す。わざと壊れた控えを戻させると `failed` が印ファイルに残り、API-101 が `VM_BUSY`。ホームを 4GB 超えにすると、1 分以内に動いているコマンドが止まり VM が止まる（`disk_quota`）。

### 7.7 本体の `vm_op`・毎日の控え・5 秒の問い合わせ・戻すときに止めるタスク
1. `vm_op` の直列（D-251）：`computer/vm-op.ts` に 1 つの関数 `beginVmOp(op)` を置き、`vm_op = 'none'` のときだけ同じトランザクションで値と `vm_op_started_at` を書く。0 行なら呼び元は `VM_BUSY`（API）または `waiting_vm`（タスク）。終わる関数 `endVmOp()` は `none` と NULL に戻す。遷移の表は [10 states](../design/10_diagrams/states.md#workspacevm_op) と同じにし、表にない遷移を単体で落とす
2. `vm_snapshots`（TBL-052）の repo：表はステップ 3 の版 4・5 で作成済み（無い列・索引だけ新しい版で足す）。`creating` は 1 つまで。`ready` は 3 つまで（新しいものを `ready` にしたあと、古い順に `deleted` にして box-manager のファイルを消す）
3. 毎日の控え（タイマー）：`snapshot_hour`（既定 4）に、VM が止まっていて `vm_op` が `none` のとき、`snapshotting` と `creating` を 1 トランザクションで入れて API-143 の POST。動いていれば、止まるまでその日のうちに待つ。API-133 の POST（今すぐ）は VM を止めてから取り（使っているタスクは `waiting_vm`）、空きが足りなければ 507 `DISK_LOW`（D-300）
4. 5秒ごとにGET。控えは従来どおりready/failed。復元・作り直し・消去はFR-100に従いDB結果/監査/ACK待ちを一括確定→ACK→排他解放。ACK待ちの再起動はACKだけ再送。成功はok、失敗はbroken（managerにも残す）。POST前停止/応答消失/5秒未満の完了/完了直後再起動を試験しnoneとdoneを区別する（IMP-005）
5. 時間の上限（D-294）：タイマーが毎分 `vm_op_started_at` を見て、`starting`・`stopping` 2 分、`snapshotting`・`restoring`・`rebuilding` 30 分を超えたら API-108・143 の DELETE を頼む。止めたと答えたら失敗の道へ（`starting`・`stopping` は世代を `failed` にして `none`）。答えなければ `vm_op` はそのままにして持ち主に知らせる
6. 戻す・作り直す（API-134・135）：1 つのトランザクションで `vm_op` を `restoring`（`rebuilding`）にし、VM を使っているタスク（終わっていないタスクのうち、`browser_actions` か `sandbox_commands` に行がある、または画面の番を持つもの：D-308）を `halted`（`vm_replaced`）で閉じてメインに報告する。その `pending` の確認を `expired`（`vm_replaced`）、答えを待つオートレビューの結果を捨て、`queued` のコマンドを `expired`、画面の番を空にする。まだ VM を使っていない `waiting_vm` のタスクは止めない。そのあと API-102、API-108 の順。`vm_op` が `none` でなければ 409 `VM_BUSY`、控えがなければ 404 `SNAPSHOT_NOT_FOUND`、交代中は 409 `ALREADY_TAKEN_OVER`（`takeovers` はステップ 4 で作ってある）。`broken` でも受ける
7. API-138はFR-079に従い、画面の番/交代なし・home_state=ok・vm_op=noneを同一トランザクションで検証しclearing_browserと操作ID/引数を保存してAPI-144。再開・30分打切り・ACK解放は復元と同じ。復元/控えとの同時要求は一方だけ開始し、通信不明では解放しない（IMP-006）
8. ホームの測り：毎分のタイマーで API-109 を読み、`homeBytes`・`hostFreeBytes`・box-manager が自分で止めた世代と理由を `workspace`/`boxes` に反映して `stop_reason`（`disk_quota`・`disk_low`）で世代を閉じる。API-088 の `homeBytes`・`homeLimitBytes`・`vmHomeState`・`lastSnapshot` を返す
9. 起こす前の確かめ（FR-074 1a・1b）：`vm_home_state` が `broken`、ホームが 4GB 超え、ホストの空きが 3GB 未満のとき、タスクのために起こさない。道具の結果に「VM のホームが容量を超えている・壊れている」と次にやることを書く
10. 再開の表の行（持ち主は 7）：`restoring`・`rebuilding`（API-108 の GET で聞く。動いていれば待つ）、`snapshotting`（API-143 の GET。終わっていれば `ready`、知らない・失敗なら `failed`）、`vm_snapshots` の `creating`（`vm_op` が `snapshotting` でないとき `failed`）、`sandbox_commands` の `running`（`expired`。7.3 の 7）。ステップ 4 の登録口に足す。`starting`・`stopping`・止まっていない世代はステップ 4 が持つのでここでは書かない。終わるまで VM を起こさない
11. ステップ 6 で骨だけ作った SCR-023 の VM の欄と SCR-024 を、ここで実 API につないで確かめる。この手順では SCR-023 の VM の欄を API-088・133〜135・138 につなぐ（SCR-024 は 7.4 の 8）。ホームが 4GB 超えのときの 3 つの操作、`broken` のとき他のボタンが使えないこと
確かめ：偽の box-manager で `vm_op` の遷移を一通り（`snapshotting` の完了・失敗・30 分超過、`restoring` の失敗で `broken`）。タスク 3 つ（VM を使った 1・画面の番を持つ 1・まだ使っていない `waiting_vm` 1）で API-134 を叩くと、前の 2 つだけ `halted`（`vm_replaced`）。実の box-manager で、控えの途中で本体を `kill` し、再起動後に `ready` か `failed` に決まる。

### 7.8 通し：告知ページ 1 件を PR まで（VM まわりの段 1 の終わる条件）
1. 準備：`announcement-page` を入れる（SCR-024 または API-115）。試験用のリポジトリに GitHub をつなぐ。VM は眠った状態から始める
2. チャットで eval (4) の 3 件の 1 つ目「11/15 の文化祭の告知ページを作って」（日時・場所・申込先を添える）を送る。メインが `announcement-page` のエージェントに `delegate` し、`delegate_reason` に理由が残ることを見る
3. 見る：VM が起きる→ターミナルで HTML を書く→簡易サーバー→ブラウザで 1280×800 と 360px 幅の点検→仕上げ→`report`（成果物が `/data/files/<taskId>/` に写る）→メインが `send_to_owner` の `file` で渡す→PR の確認カード→○→PR の URL
4. 残りの 2 件（「サークルの新歓のページ。日時・場所・申込先はこれ」「この告知のスマホ表示を直して」）を同様に通す。PR の中身を持ち主が見る。公開（Pages など）は人が PR の先で行い、パックは公開しない
5. `eval:capture` で 3 件を `evals/cases/<日付>-announcement-*/` に録る（`kind` は (4)）。期待する結果は手で足す（PR ができる・必須項目が抜けない・申込フォームがない）。リリースの前に 3 件を実の VM で通す方法を `pnpm run eval:pack`（名前はおすすめ）にまとめる
確かめ：告知ページ 1 件が PR の URL まで届く。途中で本体を `kill` して再起動しても続きから進む。使った費用・歩数・コマンド回数を記録する。

## 終わる条件
| ID | 確かめること | 方法（コマンド・操作） | 設計の参照 |
|---|---|---|---|
| S7-01 | UC-053 基本フロー：起こす→リポジトリを入れる→コマンドを繰り返す→tar で取り出す→差分を PR の Intent→確認 | 7.2・7.3 の確かめ＋7.8 | [UC-053](../design/03_use_cases.md)・FR-086 |
| S7-02 | UC-053 例外：120 秒（E1）・64KB（E2）・200 回で halted（E3）・同時 2 本待ち（E4）・VM が落ちて起こし直しホームは残る、`started` はやり直さない（E5） | 7.1・7.3 の確かめ | NFR-080・UC-053 |
| S7-03 | UC-052 基本フロー：入れる→エージェントと手順書と `browser` の追加分が入る→メインの振り分け先に載る。外す→全部消える | 7.4 の確かめ | [UC-052](../design/03_use_cases.md)・FR-085 |
| S7-04 | UC-052 代替・例外：版が上がれば更新（手直しが消えると知らせる）・`AGENT_BUSY`・形が正しくない／形式の版が新しすぎる | 単体＋API | UC-052・R-85 |
| S7-05 | UC-061 基本フロー（戻す）：控えを選ぶ→`restoring`→タスクを `halted`（`vm_replaced`）→ボリュームを入れ替え→次に使うとき新しい世代 | 7.7 の確かめ（実の box-manager） | [UC-061](../design/03_use_cases.md)・FR-100 |
| S7-06 | UC-061 基本フロー（起こす・眠らせる）と毎日の控え（3 世代） | 偽の時計で `snapshot_hour`、控えを 4 回取って 3 つだけ `ready` | UC-061・D-215 |
| S7-07 | 単体：`vm_op` の直列（`none` のときだけ開始、他の値の間は `VM_BUSY` か `waiting_vm`）と各値の遷移・失敗・打ち切り・再起動の戻し | 偽の box-manager で全遷移 | D-251・D-294・D-295・11 §11 単体 |
| S7-08 | 単体：`vm_home_state` の `ok` ⇔ `broken`、`broken` の間は戻す・作り直すだけを受け、起こすのを断る（API-101 も印ファイルで断る） | 単体＋実 | D-294・FR-074 1b |
| S7-09 | 単体：戻す・作り直すで止めるタスクの選び方（VM の道具を一度でも使った・画面の番を持つ・眠っている間に古い世代で `~/work` を作った）と `vm_replaced`、`waiting_vm` は止めない | 3 つのタスクの単体 | D-308 |
| S7-10 | 単体：tar を広げるときにリンク・装置ファイル・絶対パス・`..` を捨てる。`~/work/<taskId>` に置いたリンクが成果物にも差分にも写らない | `untar.ts` の単体＋隔離の試験の 1 件 | D-306 |
| S7-11 | 単体：パックの JSON の検証（`id`・`examples` 3〜10・`description` 200 字・`formatVersion`・存在しないスキル名） | 7.4 | FR-085・FR-088 3 |
| S7-12 | VM：控えの途中で本体を落としても、再開で `ready` か `failed` に決まる | `kill` を入れた結合（実の box-manager） | D-295・FR-084 |
| S7-13 | VM：戻しを途中で失敗させたとき `broken`、戻す・作り直すだけを受ける | 壊れた控えで試す | D-294 |
| S7-14 | VM：ホームを 4GB 超えにすると止まり、タスクのために起こされず、3 つの操作（ブラウザのデータを消す・控えに戻す・作り直す）で戻れる。ホストの空き 3GB 未満で `disk_low` | 4GB 超えのファイルを作る。空きは小さなファイルシステムで再現 | D-319・D-300・R-98 |
| S7-15 | NFR-084：2GB のホームで控え 5 分以内・戻し 5 分以内（PC）、4GB でも 30 分の打ち切りより前 | 実測を記録 | NFR-084 |
| S7-16 | NFR-080：コマンドの打ち切り（120 秒・64KB・200 回） | 7.1・7.3 | NFR-080 |
| S7-17 | ブラウザのデータを消す：画面の番があれば 409 `SCREEN_IN_USE`。なければ Cookie が消え、`~/work` は残る | 試験ページで Cookie を置いて消す | FR-079・API-138 |
| S7-18 | 交代中でもコマンドが動く。メインに VM の道具が渡っていない | 結合＋一覧の単体 | D-296・D-236 |
| S7-19 | eval (4)：告知ページパックの頼みの例 3 件を実の VM で通し、1 件目は GitHub の PR まで届く | 7.8 | 11 §11 eval・D-199・D-186 |
| S7-20 | SCR-023 の VM の欄・SCR-024 が実 API で動く（06 の S6-07・S6-08 のうち、ステップ 6 で骨だけだった行をここで満たす） | 7.4 の 8・7.7 の 11。実 API（API-088・114〜116・133〜135・138）につないで画面から操作 | 06 SCR-023・024、[06_web.md](06_web.md) の S6-07・S6-08 |
| S7-21 | `apps/sandbox`・`packages/sandbox` を消した | `git ls-files apps/sandbox packages/sandbox` が空。`pnpm typecheck / test / lint:deps` が通る | 7.2 |

## 実装で決めること
| 論点 | 設計の言い分 | おすすめ | 決めたら書く先 |
|---|---|---|---|
| zstd の呼び方 | 控えは「1 つの tar（zstd）」（NFR-084）。呼び方は書いていない | 一時コンテナ（box-manager のイメージ）の `tar --zstd` を使う。Node のライブラリは足さない。本体の API-118 の tar とは別の経路 | 00 に D-xxx、11 §7 NFR-084 |
| ボリュームを空にして展開する手順 | 「2 つのボリュームを空にしてから展開」（FR-100）。手順は書いていない | VM のコンテナが止まっていることを確かめ、`makase-browser-profile`・`makase-vm-home`・`makase-vm-snapshots` をつないだ一時コンテナを Docker API で起こして、中のファイルを消してから tar を広げ、所有者（`browser`・`agent` の uid）を戻す。消す前に展開できるか tar の中身を一度読んで確かめる | 00 に D-xxx |
| 作り直しの「イメージの既定のホーム」 | `makase-vm-home` にイメージの既定のホームを入れる（FR-100） | `box-shell` のイメージの `/home/agent` を雛形として一時コンテナにコピーさせる。ブラウザ側は空 | 00 に D-xxx |
| ホームの測り方と間隔 | 毎分 `du`。ラズパイで重ければ延ばす（R-97） | 段 1 は毎分の `du -sx`（一時コンテナではなく、box-manager に 2 つのボリュームを読み取りでつないで測る）。実測が重ければ間隔を延ばすか Docker の `system df -v` を使う。実測を R-97 の横に書く | 00 に D-xxx、R-97 |
| 動いているコマンドを止めて VM を止める手順 | 自分で止める（`disk_quota`・`disk_low`）。コマンドを止める手順は書いていない | 先に世代ごと API-102 と同じ停止をする（コンテナを止めればコマンドも止まる）。動いていたコマンドの行は本体が `expired` にする | 00 に D-xxx |
| `/data/packs/` の読み込みのタイミング | 置き場は 2 か所。いつ読むかは書いていない | API-114 を叩いたときに毎回読む（ファイルは数個。再起動を要らなくする）。入れるときも読み直して検証する | 04 tools FR-085 |
| `/opt` と `/data` で同じ `id` | 書いていない | `/opt/makase/packs/` を優先し、`/data/packs/` 側は警告を出して無視する（標準パックを置き換えさせない） | 00 に D-xxx |
| `agents[]` の項目名 | 「名前・役割・指示・使う道具・上限」(FR-085) | `name`・`role`・`instructions`・`tools`（`terminal`・`vm_browser`・`github`・`calendar`）・`limits`・`skills`（使える手順書の名前）。旧 `PackAgent` の `template` は持たない。zod で検証し、`formatVersion` は 1 から | 00 に D-xxx、04 tools FR-085 の表 |
| パックの `browser` の追加分を外すとき戻す方法 | `pack_installs` に追加分を持つ列がない | 外すときは、そのパックの今のファイルの `browser` を、今のポリシーから引く。ファイルが変わった・消えた場合の食い違いを避けるなら `pack_installs` に追加分の列を足す（おすすめは列を足す） | 08 README の `pack_installs`、00 に D-xxx |
| `announcement-page` の 4 本の手順書の書き方の参考 | 手順書 4 本の題と役割だけを書く | 旧 `apps/app/src/packs/library/designer.ts` などは書き方（`description` の形・長さ）の参考にとどめ、本文は 7.5 の雛形と骨で新しく書く。評価の基準は 7.8 と eval (4) の 3 件が通ること | 00 に D-xxx |
| パックのスキルの信頼 | 旧 Node 版は `TRUSTED_SKILLS`（本文の SHA-256）で信頼を分けた。新設計は書いていない | `/opt/makase/packs/` のスキルは信頼、`/data/packs/` のスキルは外の内容として包み、読んだタスクを汚染する。本文の SHA-256 を入れた時点の値と比べる | 00 に D-xxx、04 tools FR-088 |
| `terminal.allow_hosts` を本体から egress へ渡す道 | ステップ 1 は環境変数かファイル。本体から変える道はあとで決める。API-096 に `terminal` 欄はある（09 の表）。egress への届け方だけが設計にない | ポリシー（`workspace_policies.terminal`）を正とし、ステップ 3 で作った `network` の設定を egress に渡す道に相乗りする。本体が起動時とポリシーが変わったときに box-manager 経由で egress に送る（egress は ctl に居ないので box-manager が中継）。`closed` では `network.allow_hosts` と内部ホストの `terminal` 側との重なりだけが効く（D-366）。egress が再起動したら box-manager が送り直す。送れていない間は egress の既定の許可リストを使う | 00 に D-xxx、07 egress の行、09 に API を足すなら |
| API-144 のパスの `:boxId` | 世代を止めて空にして次に起こす。VM が眠っているときの世代の指し方は書いていない | 眠っていれば最後の世代の `boxId` を使う（box-manager は世代の値が古くても止まっていれば受ける）。「次に起こす」は、持ち主が次にタスクを頼むときに起きる形にして、その場では起こさない | 09 API-144・138 |
| tar の形式（tar か tar.gz）とリンクの扱い | シンボリックリンクはたどらず、リンクのまま入れる（D-306）。本体の側で捨てる | API-118 は無圧縮 tar。shell-agent は `tar` コマンドで作る（リンクのまま）。本体は旧 `readTarGz` の gzip 部分を外して使う | 00 に D-xxx |
| 道具の引数名 | 旧 `sandbox` の `timeout_sec` と API-117 の `timeoutSec` | `timeoutSec` にそろえ、旧道具の引数（`path`・`content`・`pattern` など）はそのまま | 09 API-117 |
| 出力の上限の数え方 | 64KB。`sandbox_commands.output` は `length() <= 65536` | バイトで切ってから UTF-8 の途中で切れないよう直す。SQLite の `length()` は字数なので、字数でも 65536 以下になる | 08 TBL-040 |
| `sandbox_commands` の `box_id` と眠っている間の古い世代 | `box_id` は世代 | 世代ごとに書く。D-308 の「古い世代で作ったタスク」は `task_id` で拾えるので、世代をまたいで探す | — |
| `/tmp` の扱い | ステップ 1 でキャッシュの置き場を決める | ブラウザのデータを消すときは、ボリュームの空にした中身だけを対象にし、`/tmp` は世代を止めると消える前提 | ステップ 1 の決定 |

## 設計に戻すこと
- 決めたことを 00 の決定事項ログに D-xxx で足す。NFR-084・NFR-080 の横に実測を書く。R-97 の横にホームの測りの実測を書く
- API-144 の `:boxId`（眠っている間）、`terminal.allow_hosts` を egress に渡す口、API-117 の引数名を 09 に書く。egress の内部 API を作るなら 09 の表に行を足す
- `pack_installs` に `browser` の追加分の列を足すなら 08 README に書く。パックの `agents[]` の項目を FR-085 の表に足す
- 告知ページ 1 件の実績（費用・歩数）を 01 の §2 か NFR の横に書く

## 参照
- 設計：[04 vm](../design/04_functional_spec/vm.md)（FR-074・079・084・086・100）、[04 tools](../design/04_functional_spec/tools.md)（FR-061・085・088）、[08 vm](../design/08_database/vm.md)（TBL-031・035・040）、[08 resident](../design/08_database/resident.md)（TBL-052）、[08 README](../design/08_database/README.md)、[09 vm](../design/09_api/vm.md)（API-088・107・108・109・114〜118・133〜135・138・143・144）、[10 sequences](../design/10_diagrams/sequences.md)（UC-053・FR-100）、[10 states](../design/10_diagrams/states.md)、[03 ユースケース](../design/03_use_cases.md)（UC-052・053・061・BR-07・BR-10）、[05](../design/05_non_functional.md)（NFR-062・080・084）、[07](../design/07_architecture.md)、[06 画面](../design/06_ux_design.md)（SCR-023・024）、[11](../design/11_tech_spec.md)（§7・§11・§12 の R-84〜86・97・98）、[00 決定事項ログ](../design/00_overview.md#決定事項ログ)
- 前後のステップ：[06_web.md](06_web.md)（SCR-021・023・024 の骨）、[08_home.md](08_home.md)（家の機能。このステップの後に段 1 で行う）、[09_release.md](09_release.md)（隔離の試験・段 2・3）
- ADR：[053](../design/adr/ADR-053-pack-by-purpose.md)・[054](../design/adr/ADR-054-terminal-in-vm.md)・[061](../design/adr/ADR-061-vm-no-judge-restore.md)・[068](../design/adr/ADR-068-browser-shell-split.md)
- 移す元のコード（`apps/sandbox`・`packages/sandbox` は 7.2 の最後で消す）：`apps/sandbox/src/main.ts`、`packages/sandbox/src/`（`executor.ts`・`tar.ts`・`protocol.ts`・`http-transport.ts`・`index.ts`）、`apps/worker/src/edge/sandbox-command.ts`（使わない）、`apps/worker/src/db/schema.ts`（`sandbox_commands`・`pack_installs`・`agent_skills`）、`apps/app/src/packs/`（`install.ts`・`contract.ts`・`types.ts`・`library/designer.ts`）
