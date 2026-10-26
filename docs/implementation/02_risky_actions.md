# ステップ 2. こわい操作
- プロジェクト：Agent-Team-Open ／ 手順書の版：v1.2（2026-10-26） ／ 設計の版：v1.7 ／ インプット：[FR-076・077・099](../design/04_functional_spec/vm.md)、v1.6 の [FR-102](../design/04_functional_spec/vm.md#fr-102内部ホストの許可)（判定の側）・[FR-104](../design/04_functional_spec/vm.md#fr-104判定の規則の版と試験)・[FR-105](../design/04_functional_spec/vm.md#fr-105判定の再実行)・[FR-108](../design/04_functional_spec/vm.md#fr-108画面操作の道具を同じ作動の形に直す)、[UC-046・047・059 と BR-06・10・11・14](../design/03_use_cases.md)、[VM の DB（TBL-033・035・039・057）](../design/08_database/vm.md)、[常駐の DB（TBL-051）](../design/08_database/resident.md)、[VM の API（API-103・104・110）](../design/09_api/vm.md)、[シーケンス図](../design/10_diagrams/sequences.md)、[状態遷移図](../design/10_diagrams/states.md)、[11 技術仕様 §8・11・12](../design/11_tech_spec.md)、[ADR-047](../design/adr/ADR-047-risky-action-check.md)・[ADR-052](../design/adr/ADR-052-browser-checks-table.md)・[ADR-064](../design/adr/ADR-064-auto-review.md)・[ADR-076](../design/adr/ADR-076-verifiable-decisions.md)・[ADR-077](../design/adr/ADR-077-auto-review-off-by-default.md)・[ADR-078](../design/adr/ADR-078-llm-by-role.md)

> **3行で**
> 1. ステップ 1 の CLI が、Claude の操作を同じ作動の形に直し、変える操作の前に合図を判定し、人の ○/×（オートレビューは入れたときだけ。既定は切）を通ってから 1 回だけ実行するようになる。判定の規則は版つきで、試験・試し当て・再実行で外から確かめられる。
> 2. `judgeBrowserAction`（Kernel の純粋関数）・規則の版と試験と再実行・`browser_checks` と承認の状態機械・直前の確かめ・オートレビュー・作動の形への変換・試験ページ・`eval:capture` を作る。
> 3. 終わる条件：11 §11 の判定・ハッシュ・1 回だけ・`screen_epoch`・D-242・D-297・D-298・D-307・D-250 の単体と、規則の試験・再実行の 100% 一致が緑で、実の VM の試験ページで「確かめた先と実行した先が同じ」になり、eval (1)(3) が動く。

## 前提（始める条件）
- 入力：ステップ 1（[01_vm_vertical.md](01_vm_vertical.md)）が終わっている：`box-browser`・`box-shell` が起き、box-agent が API-103 の操作・スクショ・`open_url`・`read_page` を受け、box-manager の最小と本体なしの CLI のループで computer use が回る。API-103 の `dryRun`・`expect` と API-104 の `inspect` はステップ 1 では作っていないので、このステップ（2.5.a）で box-agent に足す
  - 本体（SQLite・ターン・タスク）はまだない（ステップ 3・4）。このステップでは Kernel の純粋関数と、CLI のループに判定・確認を差し込む形で作る
- 機械：置き先は段 1（手元の WSL2・amd64）。実の VM の試験（2.5.d）は Docker が動くこの PC で行う。道具：pnpm（このリポジトリは pnpm。設計書の `npm run` は `pnpm run` と読み替える）・vitest・Docker
- 鍵とアカウント：`ANTHROPIC_API_KEY`（CLI のループと、オートレビューの試験に使う）。`CLAUDE_REVIEW_MODEL` は省けば `claude-sonnet-5-5`（このステップだけの仮の値。ステップ 3 で役割 `review` の割り当て（FR-107・D-362）に置き換える）。OpenAI の computer use はステップ 3・4 で足すので、ここでは要らない

## 作るもの
| 部品 | 置き場 | 移す元（あれば） | 設計の参照 |
|---|---|---|---|
| `judgeBrowserAction`・行き先の表・`BrowserPolicy`（`human_words` など）・`BrowserInspect` の型 | `packages/kernel/src/browser.ts`（新規。`index.ts` に `export *` を足す） | 同じ純粋関数の作り：`decide.ts`、`wrapUntrusted`（`untrusted.ts`）、`hashCanonical`・`canonicalJson`（`canonical.ts`） | FR-076、BR-14、D-242・D-297・D-298 |
| 規則の本文の正規化・ハッシュ・試験・試し当て・再実行の関数 | `packages/kernel/src/rules.ts`（新規。`index.ts` に `export *`） | `canonicalJson`・`hashCanonical`（`canonical.ts`） | FR-104・105、ADR-076、D-347〜349 |
| 確認の中身のハッシュ（`content_hash`）と秘密の欄の置き換え | `packages/kernel/src/browser.ts`（同上） | `hashCanonical`（`canonical.ts`） | FR-077、TBL-039、D-162 |
| `policy_versions`（TBL-057）の表と、判定ごとの `verdict_input`・`policy_sha256`・`decided_by`（TBL-033・039） | `packages/browser-guard`（同下） | — | FR-104・105、TBL-057、D-347・349・351 |
| `browser_actions`・`browser_checks`・`auto_reviews` の表と承認の状態機械（`pending → executing`）、直前の確かめ、`screen_epoch` | `packages/browser-guard`（新規。SQLite は `better-sqlite3` の小さな DB） | `approvals.ts` の 24 時間の期限は旧コードの値で、ここは 30 分（FR-077）なので写さない（期限の判定の書き方だけ参考） | FR-075 の 3a、FR-077、ADR-052、D-250・D-299・D-307 |
| オートレビューの呼び出し | `packages/llm/src/claude.ts`（ステップ 1 で移したもの）に画像と構造化出力を足す。呼ぶ側は `packages/browser-guard` | `packages/llm/src/claude.ts`（ステップ 1 の 1.6.a） | FR-099、ADR-064、D-226・D-273 |
| 作動の形への変換（Anthropic の toolset の呼び出し → 作動の形。OpenAI の分はステップ 3） | `packages/llm/src/computer/anthropic.ts`（新規）。作動の形の型は `packages/kernel/src/browser.ts` に置き、接続先の名前を持たせない | — | FR-108、ADR-078、D-354 |
| box-agent の `inspect`（API-104）と `dryRun`・`expect`（API-103） | `apps/box-agent`（ステップ 1 のものに足す） | — | API-103・104、FR-075 の 3a、D-159・D-298 |
| CLI のループへの差し込み（dryRun → 判定 → 行き先 → 実行） | ステップ 1 の CLI（`apps/box-manager/src/cli/`） | — | UC-046、シーケンス「UC-046 VM の 1 歩」 |
| 試験ページ | `evals/pages/`（ステップ 1 の 1.6 の表で「ステップ 2 で足す」とあるページを足す） | — | 11 §11 の VM の行 |
| `eval:capture`・判定の eval・オートレビューの eval | `evals/`（`capture.ts`・`cases/`）とルート `package.json` の scripts | `packages/runner/src/__golden__/` と `prompts.test.ts` の `toMatchFileSnapshot` の形 | 11 §11 の eval の行、D-199 |

## 手順
### 2.1 判定の純粋関数と行き先の表（いちばん分からないものから）
1. `packages/kernel/src/browser.ts` を作り、`index.ts` に足す。`decide.ts` と同じく LLM・DB・ネットワークを使わない（Kernel の約束）
2. 入力の型を決める：操作（種類・引数）・`BrowserInspect`（API-103 の `inspect`。`target`・`form`・`unresolvedKind`・`contentHash`）・申告（`confirm_action` の `category` か null）・`BrowserPolicy`。出力は `allow` か `approve`（当たった合図の配列と行き先 `human`／`auto_review`）
3. `BrowserPolicy` を TBL-035 の `browser` 欄のとおりに作る（`confirm_domains`・`skip_unresolved_domains`・`human_words`・`confirm_words`・`approval_minutes`・`keep_screenshots`）。判定の入力には、ほかに `review.auto.enabled`（**既定は `false`**。D-351）と `network.internal_hosts.browser`（FR-102。既定は空）も渡す。初期値は FR-076 の表の言葉。zod で検査する（`policy.ts` と同じ流儀）。今の `policy.ts` には `browser` 欄がないので、ここでは `browser.ts` に型を置き、`policy.ts` への合流はステップ 3
4. 合図を 1 つずつ関数にする：申告・T-1〜T-7。どれか 1 つでも当たれば `approve`。言葉の照合は、ラテン文字の語は単語の境界・日本語は部分一致（D-165）。見えている名前は `target.name` と、`clickable` の祖先の名前の両方で照合する（D-173）
5. `type` の改行（`\n`・`\r`）は T-4 と同じ判定にする（D-157）。`open_url` は `http`・`https` 以外を断り（D-158。ここは判定ではなく入力の検査）、確認するドメインへのときだけ T-2。`network.internal_hosts.browser` の `confirm` のホストへの変える操作（`open_url` を含む）も T-2 と同じく人。`auto` のホストは T-2 に当たらない（FR-102 の 3）。T-4 は修飾キーつきの Enter も含み Shift+Enter だけ当たらない（D-297）。T-7 は `submitsForm` が true で `formMethod` が `get`・`dialog` 以外（D-298）
6. `left_mouse_up`・`left_click_drag` の離す点は、押した点の判定を呼び出し側が覚えて引き継ぐ（関数は押した点の結果を入力に受ける）
7. 行き先の表（BR-14）は 1 つの表にして、合図の組み合わせから引く。表は規則の本文の一部（FR-104。版のハッシュに入る）なので、定数に埋め込まずデータとして受け、既定の値だけを定数で持つ。1 つでも人の行があれば人。`review.auto.enabled = false`（既定）なら行き先がオートレビューのものも人にする（ADR-077）
8. 純粋な関数にする（FR-105 の 1）：時刻・乱数・LLM・ネットワークを使わず、時刻が要るものは入力に入れる。判定の入力（正規化した作動・`inspect`・申告・規則の版のハッシュ）を、そのまま `verdict_input` として残せる形で返す（秘密の欄は FR-077 と同じく `***`）
9. T-1は交代専用。秘密をAIへ要求せず、秘密入力応答は保存前に全体を拒否し `secret_rejected` で会話を閉じる（FR-075）。署名つき原本の部分マスク再送は禁止。秘密なしのT-1操作も通常承認でなく交代要求にする（IMP-002）
確かめ：`pnpm --filter @open-team/kernel test` で `browser.test.ts` の最初の数件（T-1・T-3）が通り、`pnpm --filter @open-team/kernel typecheck` が通る。`allow` の操作が 1 つも `approve` にならない見るだけの操作の例もある

### 2.2 単体テストを 11 §11 から全部並べる
1. 「終わる条件」の S2-01〜S2-18 と S2-33 のうち Kernel に属するものを `packages/kernel/src/browser.test.ts` に書く。1 観点 1 つ以上の `it` にして、名前に S2 の番号を入れる
2. 合図は表のテスト（`it.each`）で書き、行き先の表（FR-076。人の 4 行・オートレビューの 1 行）の中身を 1 件ずつ押さえる。オートレビューは T-3 の `confirm_words`・ほかの T-4・Enter なしの T-5・申告の `other` の 4 件。人は T-1・T-2・T-3 の `human_words`・T-7・申告の `publish`・`pay`・`delete`・`send`・`account`・T-6 の 4 種・T-4 の名前が取れない／書ける欄・T-5 の Enter つき
3. `fast-check`（`kernel` に入っている）で「どの入力でも `human` の合図が 1 つ当たれば行き先が `human`」を性質として 1 つ書く
4. ハッシュと置き換えは「同じ入力で同じ」「`box_id` が違えば違う」「フォームの値が 1 つ違えば違う」「秘密の欄の値が出力のどこにも残らない」を書く
確かめ：`pnpm --filter @open-team/kernel test` が緑。S2-01〜S2-16 の `it` が名前で検索できる（`pnpm --filter @open-team/kernel test -- -t S2-`）

### 2.3 `browser_checks` と承認、直前の確かめ、`screen_epoch`
この DB は試験用で、ステップ 3 で `apps/makase/src/guard/` に取り込んで消す。DDL と状態機械の関数は `WsDb` を受ける形で書く。
1. `packages/browser-guard` を作る（`better-sqlite3` を足す。`pnpm-workspace.yaml` の `onlyBuiltDependencies` に足す必要があるか確かめる。公開から 3 日未満の版は入らない）。旧 `approvals.ts` の 24 時間の期限は旧コードの値で、ここでは使わない（確認の期限は 30 分）。DB は 1 ファイル（例 `./data/guard.sqlite`）。`foreign_keys=ON`
2. 表を TBL-033・039・051 の列どおりに作る。外部キーの先（`tasks`・`boxes`）はまだ本体にないので、最小の `boxes`（`id`・`screen_task_id`・`screen_epoch`・`control`・`vm_op`・世代）と仮の `tasks`（`id`・`status`）をこの DB に置く。名前と列は本体と同じにして、ステップ 3 で本体の DB に合流できる形にする
3. TBL-039の順序を厳守：同一トランザクションでallowed・参照NULLの仮行 → 確認/レビュー → verdictと参照IDの同時UPDATE。commit前は実行/通知禁止。CHECK・外部キーを緩めない。人への回し直しも一括commitし、各段階の故障注入で全体rollbackを試験（IMP-007）
4. 確認を作る関数：中身（操作の引数・世代・タブとフレーム・先・フォームの値の要約・URL）から `content_hash` を作り、`screen_epoch` を `boxes` から写し（D-299）、期限を 30 分にし、タスクを `awaiting_approval` にする。スクショは DB の外のファイルに置く（`screenshot_path`）。秘密の欄の文字は `browser_actions`・`browser_checks` のどちらにも `***` で入れる
5. 直前の確かめを 1 つの関数にする（FR-075 の 3a）：タスクの状態・世代・画面の番と `screen_epoch`・`control = agent`・`vm_op = none` を 1 つのトランザクションで読み、外れた理由（`task_cancelled`・`box_restarted`・`screen_lost`・`taken_over`・`vm_replaced`）を返す。見るだけでない操作の実行・列の残り・`pass`・○ のすべてがこの関数を通る形にする
6. ○ の処理（API-110 の中身）：直前の確かめと `pending → executing` を 1 つのトランザクションで行う（`WHERE status = 'pending'` の条件つき UPDATE。0 行なら `CHECK_NOT_PENDING`）。外れたら `expired`（その理由）。その外で box-agent に `expect: contentHash` と `actionId` つきで頼み、答えで `executed`・`expired`（`page_changed`）・`unknown_outcome` に変える。× は `rejected`、30 分は `expired`（`approval_timeout`）
7. 取り消し・交代・世代の替わり・控えの戻しを模す関数：そのタスク・世代の `pending` を `expired`（`task_cancelled`・`taken_over`・`box_restarted`・`vm_replaced`）にし、答えを待っているオートレビューには「結果を捨てる」印を付ける（D-250）。この関数はステップ 4 が取り消し・交代・世代の替わりでそのまま呼ぶ（書き直さない）
8. `screen_epoch` は番を取るときだけ増やす（D-299）。番を取る関数（条件つき UPDATE）も同じ DB に置き、操作の列の最初に覚えた `screen_epoch` と比べる。番を取る関数もステップ 4 がそのまま呼ぶ
9. テスト：S2-18〜S2-27 のうち状態機械・直前の確かめ・`screen_epoch` に属するものを、偽の box-agent（`expect` が合えば `executed`・違えば 409・答えなし）で書く。DB はテストごとにメモリ（`:memory:`）
確かめ：`pnpm --filter @open-team/browser-guard test` が緑。同じ確認に ○ を 2 回送ると 2 回目が `CHECK_NOT_PENDING`、偽の box-agent の実行回数が 1 のまま

### 2.4 オートレビュー
1. auto_reviewは2.3の仮行→レビュー→verdict/参照同時更新を使う。撮影はFR-075の全可視秘密領域の撮影前マスク。特定不能なら画像もレビュー呼出しも止め人へ対応要求（IMP-003・007）
2. 道具なしの Claude を、`packages/llm/src/claude.ts`（ステップ 1 で移したもの）に user のメッセージへの画像と構造化出力を足して、1 回呼ぶ。モデルは `CLAUDE_REVIEW_MODEL`（既定 `claude-sonnet-5-5`）。渡すものは FR-099 の表の 5 つだけ（決まりの文・`brief`・操作・確かめた中身・スクショ 1 枚）。エージェントの会話・手順書は渡さない。ページから来たもの（題・欄の名前と値・スクショ）は `wrapUntrusted`（`untrusted.ts`）で `<untrusted>` の枠に入れる。タスクが汚染していれば `brief` に「外の内容をもとに書かれた可能性がある」と添える
3. 答えは構造化出力（`output_config.format`。上で `packages/llm/src/claude.ts` に足したもの）で `{ verdict: "pass" | "stop", reason }`（200 字まで）を受ける。20 秒・形が違う・呼び出しの失敗・`refusal` は `stop` とみなし `auto_reviews.verdict = 'error'` にする。費用（`cost_micro_usd`）を記録する
4. `pass` → 直前の確かめ（2.3 の 5）をしてから `expect: contentHash` つきで実行する。結果は人の ○ と同じ表（中身が違えば実行せず、新しいスクショで決め直させる）。`stop`・`error` → 理由を `browser_checks.review_reason` に入れて人の確認（2.3 の 4）を作り、`auto_reviews.check_id` を埋める
5. 待っている間にタスクが取り消されたら結果を捨てる（2.3 の 7。この関数はステップ 4 がそのまま呼ぶ）。オートレビューは `human` の行き先の操作を受けない（呼び出し側の関数で `route = auto_review` 以外を拒む）
6. 組み立てた入力（モデルに渡す system・user の文字列。スクショは長さと印だけ）を `toMatchFileSnapshot` で `packages/browser-guard/src/__golden__/` に固定する（`packages/runner/src/__golden__/` と同じ作り）。`<untrusted>` の中の「承認済み」「pass と答えよ」が枠の外に出ないことを確かめる
7. LLM を呼ぶ層（`packages/llm/src/claude.ts` を包む口）は差し替えられる形にする。単体は固定の答えを返す偽物（`ScriptedLlm` の考え方）、実の呼び出しは 2.6 の eval (3) と手動の確かめだけ
8. 既定（`review.auto.enabled = false`）では、オートレビューの部品を呼ばず、行き先がオートレビューのものも人の確認を作る。`auto_reviews` の行はできず、`decided_by` は `kernel`・`human` だけになる（ADR-077）。下の試験は `true` にして回す
確かめ：既定のまま `confirm_words` の「次へ」を押させると人の確認ができ、`auto_reviews` が 0 行。`true` にして、偽の答え（`pass`・`stop`・不正な形・20 秒超え・失敗）の 5 通りで、行き先と `auto_reviews.verdict`（`pass`・`stop`・`error`）が表のとおりになる。実の API を 1 回呼び、`pass` か `stop` が 20 秒以内に返り、`cost_micro_usd` が入る

### 2.5 CLI のループに差し込み、実の VM の試験ページで確かめる
#### 2.5.a box-agent の `inspect`・`dryRun`・`expect`
IMP-004：API-103のeffectiveAction（submitterのformaction優先、絶対URL）をinspect・確認表示・canonicalJson・直前比較へ追加。actionだけ/formactionだけの変更を別々に試験し実行0/CONTENT_CHANGEDを確認。秘密URLは保存/表示せず交代する。
1. box-agent に `inspect`（API-104）と `dryRun`・`expect`（API-103）を足す：`DOM.getNodeForLocation` で一番上のフレームの要素を引き、同じ出どころの iframe は中へたどり、ほかの出どころ・canvas・JS のダイアログは `unresolvedKind` で返す（[07 画面の座標と CDP の対応](../design/07_architecture.md#vm-の中身)）。`submitsForm`・`formMethod`・`editable`・`clickable`・祖先の名前・`contentHash` を返す（D-298）。`expect` が今の `contentHash` と違えば実行せず 409 `CONTENT_CHANGED`（D-159）。`actionId` の冪等はステップ 1 のまま
確かめ：ステップ 1 の試験ページ（購入ボタン・同じ出どころの iframe・canvas・JS のダイアログ）に `curl` で box-agent を直に叩く。`dryRun` が実行せず `inspect` を返す。同じ出どころの iframe の中の要素が引け、canvas・ダイアログは `unresolvedKind` で返る。`expect` に違う `contentHash` を付けると 409 `CONTENT_CHANGED` で何も実行されない。

#### 2.5.b 試験ページ
1. ステップ 1 の 1.6 の表で「ステップ 2 で足す」とあるページを `evals/pages/` に作る（ファイルごとに 1 つの狙い。名前・狙いは表のとおり）。配り方（`docker cp`・8000 と 8001 の 2 ポート）も 1.6 の表のとおりで、ここでは繰り返さない
2. Chromium は `--proxy-bypass-list=shell` なので `shell` の全ポートが egress を通らない（ステップ 1 の設定）
確かめ：表の「ステップ 2 で足す」の全ページが Chromium で開く。`iframe-cross.html` の中身が別のポート（8001）から来て、ほかの出どころとして `inspect` に返る（2.5.a）。egress のログに `shell` が出ない。

#### 2.5.c CLI への差し込みと ○/×
1. Claude が返した toolset の呼び出しを、まず `packages/llm/src/computer/anthropic.ts` で作動の形に直す（FR-108）。直せない呼び出し・未対応の種類は実行せず、理由を Claude に返す。以降の確かめ・判定・**実行**はすべてこの作動の形から行い、元の呼び出しは使わない（FR-108 の 2）
2. CLI のループに差し込む：変える操作ごとに、API-103 の `dryRun`（または API-104）で `inspect` を取る → `judgeBrowserAction` → `allow` なら `expect: contentHash` つきで実行／`approve` なら列をここで止め、残りの操作には「前の操作の確認を待っているので実行していない」を返す。見るだけの操作はそのまま実行する。`confirm_action` を道具として CLI に足し、直前の道具が `confirm_action` なら申告として渡す
3. 確認は CLI の端末で ○/× を受ける（画面はステップ 6）。待つ間は `awaiting_approval` にし、30 分の期限・`paused_ms` 相当の時間は数えない。オートレビューは `review.auto.enabled = true` にしたときだけ実の API を呼ぶ
4. 全画像経路をFR-075の撮影前マスクに統一する。操作対象rectでなく全可視秘密領域を列挙し、iframe・zoom・交代終了・撮影だけでも適用。不完全なら撮影/保存/送信を停止して人へ要求。context editingは安全に保存された履歴だけに適用し `keep_screenshots` を読む（IMP-003）
5. S2-27 のテスト：偽の Claude で要求の本文を捕まえ、`context_management` があり残す数が `keep_screenshots` と同じこと、送った画像と保存した画像の秘密の欄の位置が塗られていること（パスワード欄の試験ページ）を確かめる
確かめ：偽の Claude を使った CLI のループのテストが緑（S2-27・S2-38 を含む）。偽の Claude が未対応の種類を返すと、実行されず理由が返る。端末で ○ を押すと 1 回だけ実行され、× では実行されない。`keep_screenshots` を 5 にすると要求の値も 5 になる。

#### 2.5.d 実の VM での通し
1. 試験ページごとに「期待する合図と行き先」と「確かめた先 = 実行した先」を確かめる。新しいタブは、`inspect` の `tab` が押した先のタブで、実行も同じタブになること。ほかの出どころの iframe・canvas・ダイアログは T-6 で人に回ること
2. 実行の途中で CLI を落とし（`executing` のまま）、再起動すると `unknown_outcome` で Claude に「実行されたか分からない」と新しいスクショで返ること
確かめ：`pnpm --filter @open-team/browser-guard run vm-check`（名前は実装で決める）が、試験ページの全件を実の VM で通し、表（ページ → 合図 → 行き先 → 実行したか）を出して全件が期待どおり。購入ボタンは ○ を押すまで実行されず、○ のあと 1 回だけ押される

### 2.6 eval の土台
1. `evals/capture.ts` を作り、ルート `package.json` に `eval:capture` を足す。`pnpm run eval:capture <taskId|turnId>` で、その歩みの記録・操作・確かめの結果（秘密は `***`）を `evals/cases/<日付>-<短い名前>/` に JSON で書き出す。このステップでは本体の `tasks` がないので、CLI が付ける実行の ID を受ける（ステップ 4 で `taskId`・`turnId` に広げる）
2. ケースの形：`inspect` の結果・操作・申告・その時のポリシー・`expected`（期待する `allow`/`approve`・合図・行き先）。`expected` は取り込んだあとに手で足す
3. 種類 (1) 判定と行き先：`evals/cases/` の全件を `judgeBrowserAction` に通して `expected` と比べるテストを作る（LLM なし。`pnpm run eval:judge`。ふだんのテストにも入れて毎回通す）。2.5.d の試験ページ全件を最初のケースとして取り込む
4. 種類 (3) オートレビュー：通すべき・止めるべき操作の組をケースにし、実の LLM に通して「止めるべきものを通さない」ことを数える（`pnpm run eval:review`。LLM あり・ハーネスを変えたときだけ）。組に必ず入れる：ページ本文に承認を促す文がある組（R-90）、JS で送るページの組（R-76）、外に出る操作が混じった `confirm_words` の組
5. 種類 (2) 振り分け・(4) パックの通しは後のステップ（`04_resident.md`・`07_terminal_pack_snapshot.md`）。ここでは `evals/cases/` の置き場と `kind` の欄だけ用意する
確かめ：`pnpm run eval:capture <実行の ID>` で `evals/cases/<日付>-<名前>/` ができ、`expected` を足して `pnpm run eval:judge` が緑。わざと `human_words` から「購入」を消すと赤になる。`pnpm run eval:review` が、止めるべき組を 1 件も通さずに終わる

### 2.7 規則の版・試験・試し当て・再実行（FR-104・105）
API（API-149・150）と画面（SCR-028）はステップ 3・6。ここでは Kernel の関数と、`browser-guard` の小さな DB での版の表まで作る。
1. `packages/kernel/src/rules.ts`：規則の本文（`browser`・`terminal`・`network`・`review.auto.enabled`・行き先の表。v1.7 の `home` の 2 欄はステップ 8 で足す）を `canonicalJson` で正規化し、SHA-256 を版のハッシュにする（[TBL-057](../design/08_database/vm.md#tbl-057policy_versions判定の規則の版)）。`budget`・`llm`・`vault`・`classify` は入れない（D-369）
2. 試験：`testRules(body, tests)` が試験の例（作動の入力と期待する行き先）を全部当て、外れた例と実際の行き先を返す。1 件でも外れたら保存しない
3. `browser-guard` の DB に `policy_versions` を TBL-057 の列どおりに作る。追記だけ（UPDATE・DELETE をトリガーで断る）。同じハッシュは新しい版を作らない。最初の版は `changed_by = 'system'` で既定の値から作る
4. 判定のたびに `browser_actions.verdict_input`・`policy_sha256`・`decided_by`、`browser_checks.policy_sha256`・`verdict_input` を埋める（TBL-033・039。制約 `verdict_input IS NOT NULL ⇒ policy_sha256 IS NOT NULL` を緩めない）
5. 再実行：`replayVerdict(verdictInput, body)` が保存した入力と版の `body` で判定をやり直し、「同じ」「違う」と元・今の行き先を返す。実行・通知・確認の作成はしない。`human`・`llm_review` で決まったものは「Kernel がその行き先に回した」ところまで比べる（FR-105 の 5）
6. 試し当て：新しい本文を、`verdict_input` のある過去 30 日の行に当て、行き先が変わる件数と例を返す（保存しない）
7. 速さ：判定 1 回の p95 を測る（NFR-090 の 5ms 以内）
確かめ：`pnpm --filter @open-team/kernel test -- -t S2-3` と `pnpm --filter @open-team/browser-guard test` が緑。2.5.d の通しで溜まった判定を全件 `replayVerdict` に通すと 100% 「同じ」。`human_words` から「購入」を消した本文で試し当てすると、購入ボタンの件が `human` → `allow` に変わる件数として出る。

## 終わる条件
| # | 確かめること | 方法（コマンド・操作） | 設計の参照 |
|---|---|---|---|
| S2-01 | T-1：`password` と `autocomplete` の 5 値（`current-password`・`new-password`・`cc-number`・`cc-csc`・`cc-exp`）の先への `type`・`key` が `approve`・人 | `browser.test.ts` | FR-076 |
| S2-02 | T-2：確認するドメインでの変える操作すべて（`open_url` を含む）が `approve`・人。ほかのドメインへの `open_url` は判定しない | 同上 | FR-075・076、D-158 |
| S2-03 | T-3：名前に `human_words` を含めば人、`confirm_words` だけならオートレビュー。「Postal code」「Confirmation number」で空振りせず、日本語は部分一致 | 同上 | FR-076、D-165・D-227 |
| S2-04 | `clickable` の `div` など擬似ボタンの名前も T-3 の対象。確かめないドメインでは `skip_unresolved_domains` が効く（T-6 のみ） | 同上 | D-173 |
| S2-05 | `type` の文字列の改行（`\n`・`\r`）が Enter と同じ判定になる | 同上 | D-157 |
| S2-06 | `open_url` が `http`・`https` 以外（`javascript:`・`file:`・`chrome:`）を断る | 同上 | D-158、API-103 |
| S2-07 | T-4：Enter・Space が、先がボタン・リンク・フォームの中なら当たる。作動する要素（フォームなら送信ボタン）の名前で T-3 を確かめる | 同上 | FR-076 |
| S2-08 | T-4：修飾キーつきの Enter が当たり、Shift+Enter だけ当たらない | 同上 | D-297 |
| S2-09 | T-4 の行き先：作動先の名前が取れない（空・画像だけ）、または `textarea`・`contenteditable` の Enter は人 | 同上 | D-242 |
| S2-10 | T-5：Ctrl・Alt・Meta で、安全な 4 つ（Ctrl+C・A・F・Z）以外が当たる。Enter を含むものは人、含まないものはオートレビュー | 同上 | D-297 |
| S2-11 | T-6：`canvas`・`cross_origin_iframe`・`dialog`・`outside` がすべて人。canvas も人 | 同上 | D-242・D-297 |
| S2-12 | T-7：`submitsForm` が true で `formMethod` が POST・不明なら人。`get`・`dialog`・`formmethod` が GET の送信ボタンは当たらない。名前によらない | 同上 | D-242・D-298 |
| S2-13 | 同じ出どころの iframe の中の要素は通常の要素として判定され、ほかの出どころは T-6 | 同上 | D-242 |
| S2-14 | 申告：`publish`・`pay`・`delete`・`send`・`account` は人、`other` はオートレビュー | 同上 | FR-076、BR-14 |
| S2-15 | 行き先の表の全行：1 つでも人の行があれば人。`review.auto.enabled = false`（既定）なら全部人 | 同上（`it.each` と性質テスト） | BR-14、TBL-035 |
| S2-16 | `left_mouse_up`・`left_click_drag` の離す点が押した点の判定を引き継ぐ | 同上 | FR-076 |
| S2-17 | 中身のハッシュ：同じ入力で同じ。`box_id`・フォームの値・操作の引数が違えば違う | `browser.test.ts` | FR-077、ADR-052 |
| S2-18 | 秘密の欄の文字が `browser_actions`・`browser_checks`・ハッシュの材料のどこにも残らず `***` になる（フォームの値は秘密の欄のハッシュだけ） | 同上と `browser-guard` のテスト | FR-075 の 4、D-162 |
| S2-19 | `pending → executing` が 1 回だけ：二重の ○・再送で 2 回目は `CHECK_NOT_PENDING`、box-agent への実行依頼は 1 回 | `browser-guard` のテスト | FR-077、API-110 |
| S2-20 | 直前の確かめ（D-307）：○・オートレビューの `pass`・列の残り・判定の要らない操作のすべてが、`task_cancelled`・`box_restarted`・`screen_lost`・`taken_over`・`vm_replaced` の各理由で実行されない | 同上 | FR-075 の 3a、D-307 |
| S2-21 | `screen_epoch`：番を取るときだけ増える。確認に写され、○ のときに今の値と違えば `screen_lost` | 同上 | D-258・D-299 |
| S2-22 | 取り消しのときの確認の期限切れ：そのタスクの `pending` が `expired`（`task_cancelled`）、答えを待つオートレビューの結果は捨てられる | 同上 | D-250、FR-077 の 7 |
| S2-23 | 中身が違う（409 `CONTENT_CHANGED`）→ `expired`（`page_changed`）、新しい確認は作らない（`action_id` の UNIQUE）。Claude に新しいスクショを返す | 同上 | D-159、UC-047 の 4a |
| S2-24 | 答えがない・再起動 → `unknown_outcome`。× → `rejected`。30 分 → `expired`（`approval_timeout`） | 同上 | UC-047 の 3a・3b・4b |
| S2-25 | オートレビュー（`review.auto.enabled = true` のとき）：`pass` は実行、`stop`・20 秒超え・形の違い・失敗・`refusal` は人の確認（`review_reason` つき、`auto_reviews.verdict = 'error'` を含む）。会話を渡さず、`<untrusted>` の枠が入力の golden のとおり | `browser-guard` のテスト（偽の LLM） | FR-099、UC-059、D-273 |
| S2-26 | 結合（偽の box-agent）：二重の ○、承認のあとの画面の変化、実行の途中の再起動、オートレビューの時間切れ | 同上 | 11 §11 の結合の行 |
| S2-27 | 渡すスクショの枚数：要求に `keep_screenshots`（既定 3）の context editing の設定が入る。保存と Claude に送るスクショの両方で秘密の欄が塗られる | CLI のループのテスト（2.5.c） | FR-075 の 4・6、D-162・D-256 |
| S2-28 | 実の VM で試験ページ全件（パスワード欄・購入ボタン・同じ出どころとほかの出どころの iframe・canvas・JS のダイアログ・新しいタブ・JS で送るフォーム）が表のとおりに判定され、確かめた先と実行した先が同じ | 2.5.d のコマンド | 11 §11 の VM の行、UC-046 |
| S2-29 | 購入ボタンは ○ の前に実行されず、○ のあと 1 回だけ押される。オートレビューを入れたときだけ、`pass` の操作は人に聞かずに 1 回押される | 2.5.d の手動の確かめ | UC-047・059 |
| S2-30 | eval (1)：録った確かめの結果を `judgeBrowserAction` に通す（LLM なし・毎回）が緑 | `pnpm run eval:judge` | 11 §11 の eval の行、D-199 |
| S2-31 | eval (3)：止めるべき組（承認を促す文のあるページ・JS で送るページを含む）を 1 件も通さない | `pnpm run eval:review` | R-76・R-90 |
| S2-32 | `pnpm run eval:capture` が実行の ID からケースを書き出し、秘密が `***` になっている | 2.6 の確かめ | D-199 |
| S2-33 | 内部ホスト：`confirm` のホストへの変える操作（`open_url` を含む）は人、`auto` のホストは T-2 に当たらずほかの合図だけで決まる。見るだけの操作は判定しない | `browser.test.ts` | FR-102 の 3、D-365 |
| S2-34 | 既定（`review.auto.enabled = false`）では、オートレビューの行き先も人に回り、`auto_reviews` の行ができない。判定ごとに `decided_by`（`kernel`・`human`・`llm_review`）が残る | `browser-guard` のテスト | ADR-077、D-351、TBL-033 |
| S2-35 | 規則の版：同じ中身は同じハッシュ・同じ版。試験の例が 1 件でも落ちる本文は保存されない。`policy_versions` の UPDATE・DELETE は断られる | `rules.test.ts`・`browser-guard` のテスト | FR-104、TBL-057、D-347・348 |
| S2-36 | 試し当て：新しい本文で行き先が変わる件数と例が出て、何も保存されない | 2.7 の確かめ | FR-104 の 3 |
| S2-37 | 再実行：保存した判定を全件やり直して 100% 同じ。実行・通知・確認を作らない。判定 1 回 p95 5ms 以内 | 2.7 の確かめ | FR-105、NFR-090、D-349 |
| S2-38 | 作動の形：Claude の toolset の呼び出しが作動の形に直り、確かめと実行が同じ形から行われる。直せない呼び出し・未対応の種類は実行されない | CLI のループのテスト（偽の Claude）と 2.5.d | FR-108 の 1・2、D-354 |

## 実装で決めること
| 論点 | 設計の言い分 | おすすめ | 決めたら書く先 |
|---|---|---|---|
| `inspect` に足す判定の材料の形（`submitsForm`・`formMethod`・`editable`・`unresolvedKind`・`clickable`・`rect`） | D-298 で欄の名前は決まったが、型の細部（`formMethod` の値、祖先の名前の持たせ方、`rect` の座標系）は書いていない | `BrowserInspect` を `browser.ts` に zod で置き、box-agent の出力を本体の境界で検査する。検査に落ちたら `unresolvedKind = outside` として人に回す。`formMethod` は `get`・`post`・`dialog`・null。祖先の名前は `ancestorNames` の配列 | 09 の API-103 の inspect の例、D-xxx |
| `content_hash` を誰が作るか | TBL-039 は `action`・`content`・`box_id` から sha256、API-103 は box-agent の `contentHash` と比べる | 材料の正規化（`canonicalJson`）を Kernel に置き、box-agent も同じ関数を import する。本体は box-agent の `contentHash` をそのまま `content_hash` に保存 | TBL-039、D-xxx |
| オートレビュー画像 | 1280×800のPNG。全可視秘密領域を撮影前マスク | FR-075の完全性検査を通った同じ画像を保存/送信。対象rectだけのマスクは禁止。失敗なら撮影しない | D-331 |
| 試験ページをどこに置き、どう配るか | 11 §11 は「決まった試験ページ」 | ステップ 1 の 1.6 の表が正（一覧と配り方）。ステップ 2 は「ステップ 2 で足す」の行を足すだけで、置き場は `evals/pages/` | 11 §11 の VM の行、`01_vm_vertical.md` の 1.6 |
| `browser_checks`・`auto_reviews` の表をこのステップで SQLite に作るか | 本体の DB はステップ 3 | 作る。`packages/browser-guard` に `better-sqlite3` の小さな DB を置き、列名・制約を TBL-033・039・051 と同じにしてステップ 3 で本体の DB に合流 | 08 の vm.md の TBL-039 の横、`03_core_port.md` |
| `browser-guard` を新しい部品として作るか | 置き場の表（親のおすすめ）に無い | 作る（純粋でない部分を Kernel に混ぜないため）。ステップ 3 で `apps/makase` に取り込むか、パッケージのまま使う | README の置き場の表 |
| `BrowserPolicy` を `policy.ts` に入れる時期 | TBL-035 は「Kernel の型も合わせて足す」。今の `policy.ts` の `budget` は `per_day_usd` で、設計の `daily_usd`・`daily_auto_usd` と違う | このステップは `browser.ts` に独立して置き、`policy.ts` の `budget` の直しと合わせてステップ 3 で合流 | `03_core_port.md`、TBL-035 |
| `eval:capture` の引数 | `<taskId\|turnId>` | このステップは CLI の実行 ID。ステップ 4 で `taskId`・`turnId` に広げる | `evals/README.md`（置くなら）、11 §11 |
| オートレビューの eval (3) の合格の線 | 「止めるべきものを通さない」 | 止めるべき組は 0 件通過を必須、通すべき組は通過率を記録するだけ（下げない） | 11 §11、D-xxx |
| 規則の本文の形（行き先の表をどう持つか） | FR-104・TBL-057：本文に「T-1〜T-7 の行き先の表」が入る。表の形は書いていない | 合図の組み合わせ → 行き先の行の配列を JSON で持ち、既定の値を `rules.ts` の定数にする。本文の正規化は `canonicalJson` | TBL-057 の `body` の説明、D-xxx |
| 試験の例の `expect` と、オートレビューの行き先 | TBL-057：`expect` は `allow`・`human`・`deny` の 3 つ。`review.auto.enabled = true` のときの行き先 `auto_review` がない | `expect` に `auto_review` を足す（`true` の本文の試験で要る）。設計に戻す | TBL-057・FR-104、D-xxx |
| 判定の時刻の扱い | FR-105：時刻が要るものは入力に入れる | 今の合図は時刻を使わないので入れない。使う合図を足すときに入力に足す | 00 に D-xxx |
| 作動の形の型の置き場 | ADR-078：`llm/` を接続先ごとのクライアントと作動の形への変換に分ける。Kernel は接続先を知らない | 型は `packages/kernel/src/browser.ts`（判定の入力と同じ型）、変換は `packages/llm/src/computer/<接続先>.ts` | README の置き場の表 |
| CLI での ○/× の受け方 | 画面は SCR-019（ステップ 6） | 端末の y/n。30 分の期限は設定で短くできるようにして試験する | `06_web.md` |

## 設計に戻すこと
- inspect の形・`content_hash` の作り方を決めたら、09 の API-103 の例と 08 の TBL-039 の説明に 1 行ずつ足す
- 試験ページの一覧を決めたら、11 §11 の VM の行に「JS で送るフォーム」を足す（R-76 の eval (3) と合わせる）
- 11 §11 と 00 の D-199 の `npm run` を `pnpm run` に直す（このリポジトリは pnpm）
- TBL-057 の `tests` の `expect` に `auto_review` を足すか決めて、FR-104・TBL-057 を直す。行き先の表の JSON の形を TBL-057 の `body` の説明に足す

## 参照
- 設計：[FR-075](../design/04_functional_spec/vm.md#fr-075コンピューターユースの操作)・[FR-076](../design/04_functional_spec/vm.md#fr-076こわい操作の見分け)・[FR-077](../design/04_functional_spec/vm.md#fr-077こわい操作の確認)・[FR-099](../design/04_functional_spec/vm.md#fr-099オートレビュー)・[FR-102](../design/04_functional_spec/vm.md#fr-102内部ホストの許可)・[FR-104](../design/04_functional_spec/vm.md#fr-104判定の規則の版と試験)・[FR-105](../design/04_functional_spec/vm.md#fr-105判定の再実行)・[FR-108](../design/04_functional_spec/vm.md#fr-108画面操作の道具を同じ作動の形に直す)、[TBL-057](../design/08_database/vm.md#tbl-057policy_versions判定の規則の版)、[NFR-090](../design/05_non_functional.md)、[00 決定事項ログ](../design/00_overview.md#決定事項ログ)（D-157・158・159・162・165・173・199・226・227・242・250・255・258・273・297・298・299・307・347〜349・351・354・365）
- ADR・リスク：[ADR-047](../design/adr/ADR-047-risky-action-check.md)・[ADR-052](../design/adr/ADR-052-browser-checks-table.md)・[ADR-064](../design/adr/ADR-064-auto-review.md)・[ADR-076](../design/adr/ADR-076-verifiable-decisions.md)・[ADR-077](../design/adr/ADR-077-auto-review-off-by-default.md)・[ADR-078](../design/adr/ADR-078-llm-by-role.md)、[リスク R-76・R-90（11 §12）](../design/11_tech_spec.md)
- 移す元・参考のコード：`packages/kernel/src/index.ts`・`decide.ts`・`canonical.ts`・`untrusted.ts`・`taint.ts`（汚染の判定）・`approvals.ts`（期限の書き方のみ）、`packages/runner/src/__golden__/` と `prompts.test.ts`（`toMatchFileSnapshot`）、`packages/llm/src/http-provider.ts`
- 前後のステップ：`01_vm_vertical.md`（VM・box-agent・CLI）、`03_core_port.md`（本体の DB に合流）、`04_resident.md`（`taskId`・`turnId` の eval）
