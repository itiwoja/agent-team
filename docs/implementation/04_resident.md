# ステップ 4. 常駐の仕組み
- プロジェクト：Agent-Team-Open ／ 手順書の版：v1（2026-10-24） ／ 設計の版：v1.4 ／ インプット：[常駐の機能仕様](../design/04_functional_spec/resident.md)・[道具の機能仕様](../design/04_functional_spec/tools.md)・[VM の機能仕様](../design/04_functional_spec/vm.md)・[常駐の表](../design/08_database/resident.md)・[VM の表](../design/08_database/vm.md)・[常駐の API](../design/09_api/resident.md)・[状態遷移](../design/10_diagrams/states.md)・[シーケンス](../design/10_diagrams/sequences.md)・[ユースケース](../design/03_use_cases.md)・[技術仕様 §7・§11](../design/11_tech_spec.md)

> **3行で**
> 1. チャットで頼むと、メインが答えるか `delegate` で振り分け、タスクが VM で仕事をして `report` し、メインが起きて `send_to_owner` で持ち主に伝えるところまで動く。確かめは curl と SSE（画面はステップ 6）。
> 2. 作るのは、受付とルーター（intake）・メインのターン（turn）・裏のタスク（task）・文脈とキャッシュと要約（context）・記憶 2 層（memory）・VM の窓口と交代（computer）・毎分のタイマーと再開（timer・recovery）。ループと状態は本体にあり、歩みの記録（`task_steps`）で続きから動く。
> 3. 終わる条件：UC-044・048・054・055・058・060 の基本フローが curl＋SSE＋ScriptedLlm で通り、きっかけがなければ LLM を呼ばず（NFR-082）、先頭の 9 割以上がキャッシュに当たる（NFR-083）。

## 前提（始める条件）
- 入力：
  - ステップ 1・2：VM（box-browser・box-shell）・box-manager・`judgeBrowserAction`・`browser_checks`・オートレビューが、本体なしの CLI で動く。ステップ 2 で作った「画面の番を取る関数」「確認を作る関数」「直前の確かめ」「○ の処理（API-110 の中身）」「取り消し・交代・世代の替わりで `pending` を `expired` にする関数」を、このステップは呼ぶだけで書き直さない。
  - ステップ 3：`apps/makase`（Node＋SQLite）が Compose で起動し、移した `edge/`（`web.ts`・`web-page.ts`・`web-seen.ts` を含む）・`db/`・SSE・API-100・FR-073・監査ログ・`timer.ts` が動く。表は版 4・5 で全部作ってある（`wakes`・`turns`・`chat_messages`・`task_steps`・`memory_facts`・`memory_search`・`context_snapshots`・`push_outbox`・`boxes`・`takeovers` など）。`apps/worker/src/asks/drive.ts`・`workflows/task-run.ts`・`db/repo/asks.ts` はステップ 3 で消えている。消したコミットの SHA は [05_triggers.md](05_triggers.md) の「前提」を見て、`git show <sha>:<path>` で読む。
  - 今のコードの形（実際に開いて確かめた）：`packages/runner/src/harness.ts` の `runTask(edge: EdgePort, token, opts)` は、`ChatMessage`（`role: "tool"` を持つ、提供元に依らない形）で会話を持ち、フェーズ（`templatePhases`）と `submit_report`・`finish` で終わる。`packages/llm/src/claude.ts`（ステップ 1 で移した）は思考のブロックを捨て、`system` を 1 本の文字列で送り、`usage` のキャッシュ項目を入力に混ぜている。`task_steps` の使い手は、消えた `workflows/task-run.ts` の `step.do` と同じ役を 4.3 の `steps.run` で作る。いずれも下の手順で直す。
- 機械：置き先は段 1（手元の WSL2、amd64）。交代の確かめ（4.7）は偽の box-manager で行い、実の VM の画面（noVNC）はステップ 6・段 2 の 8.3 で見る。
- 鍵とアカウント：`ANTHROPIC_API_KEY`（実 API での確かめ 4.4 の 6 だけ。それ以外は ScriptedLlm で足りる）。実 API を叩くときは `LLM_SESSION_BUDGET_MICRO_USD`（`packages/llm/src/session-budget.ts` の `SessionBudgetClient`）で上限をかける。

## 作るもの
| 部品 | 置き場 | 移す元（あれば） | 設計の参照 |
|---|---|---|---|
| 表と repo（ステップ 3 の版 4・5 の表を突き合わせ、足りない列・索引・制約だけ新しい版で足す。`wakes`・`turns`・`chat_messages`・`context_snapshots`・`memory_facts`・`memory_search`・`push_outbox` の repo） | `apps/makase/src/db/`（migration と `repo/`） | ステップ 3 の版 4・5 | TBL-041〜043・047・050・053・055 |
| 既存の表の変更の突き合わせ（`tasks`・`agents`・`usage_records`・`audit_logs`・`task_steps`。ステップ 3 でやったことを確かめ、足りないものだけ足す） | 同上 | ステップ 3 の版 4・5 | 08 README「変える表」・TBL-038 |
| 受付とルーター（intake） | `apps/makase/src/intake/` | なし（新規） | FR-090・API-119・120・124 |
| 歩みの記録の実行器（`steps.run`） | `apps/makase/src/steps/` | `workflows/task-run.ts` の `stepDo`（ステップ 3 で消えている。SHA は 05 の前提） | FR-084・TBL-038 |
| ターンの実行役（`runTurn`） | `packages/runner/src/turn.ts` | `packages/runner/src/harness.ts` の `runTask`（共通部分を括り出す） | FR-091・07 レベル3 |
| メインの道具 | `apps/makase/src/turn/tools/` | `apps/worker/src/edge/tools.ts`（`load_skill` → `read_skill`） | FR-091・093・088 |
| 費用の守り（2 本の日次・区分） | `apps/makase/src/edge/spend.ts`・`limits.ts` | `apps/worker/src/edge/spend.ts`・`limits.ts` | FR-013・D-322 |
| 文脈の組み立て・キャッシュ・要約（context） | `apps/makase/src/context/` | `apps/worker/src/edge/context.ts`・`llm-call.ts`・`llm/claude.ts` | FR-098・ADR-066 |
| 裏のタスク（task） | `apps/makase/src/task/` | `asks/drive.ts`（`takeStartableTasks`）・`workflows/task-run.ts`（どちらもステップ 3 で消えている。SHA は 05 の前提） | FR-092・089 |
| VM の窓口（computer） | `apps/makase/src/computer/` | ステップ 1 の box-manager クライアント・ステップ 2 の判定とオートレビュー・番を取る関数 | FR-074〜077・099・D-217・D-258 |
| 交代と確認の口（box-manager 側） | `apps/box-manager`（API-113。VNC の `control` の口） | ステップ 1 の box-manager | FR-078・API-113・106 |
| 交代と確認の口（本体側） | `apps/makase/src/computer/takeover.ts`・`routes/vm.ts`（API-089・090・091）・`routes/check.ts`（API-087・110） | ステップ 2 の確認の関数 | FR-078・API-087・089〜091・110 |
| 記憶（memory） | `apps/makase/src/memory/` | なし（新規） | FR-097・ADR-070 |
| タイマーと再開 | `apps/makase/src/timer/`・`recovery/` | ステップ 3 の `timer.ts`（`timer/` に昇格） | FR-084・NFR-071・082 |
| ScriptedLlm の拡張（キャッシュ項目・`raw` の応答） | `packages/llm/src/scripted.ts`・`types.ts` | 同左 | NFR-083 |

## 手順
### 4.1 表と repo
1. ステップ 3 の版 4・5 で作った表の列・索引・制約を、設計（TBL-032・034・038〜043・047・050〜055）と突き合わせ、足りないものだけ新しい版（ステップ 3 の方式）で足す。確かめるのは `wakes`（`source_key` UNIQUE、索引 `(status, target_kind, created_at)`・`(hook_id, created_at)`）・`turns`（`running` は部分 UNIQUE）・`chat_messages`（`tool_call_id` UNIQUE）・`context_snapshots`・`memory_facts`・`push_outbox`・`takeovers`（動いている交代は VM の世代ごとに 1 つ）。
2. ステップ 3 でやったことを確かめる（足りなければ足す）：`tasks`（`turn_id`・`tool_call_id` UNIQUE・`title`・`brief`・`delegate_reason`・`budget_class`・`paused_ms`、`job_id` が NULL 可、`trigger_type` に `delegate`）・`agents`（`kind`・`description`・`created_by`・`instruction_addendum`、`kind = 'main'` は部分 UNIQUE）・`task_events` の種類・`audit_logs` の種類（`wake.received`・`wake.dropped`・`turn.halted`・`cache.miss`・`memory.changed` と、交代で使うもの）。
3. `usage_records`：ステップ 3 の版 4 で作り直したことを確かめる（`turn_id`・`budget_class`・`cache_read_tokens`・`cache_write_5m_tokens`・`cache_write_1h_tokens`・`cache_expected`、`phase` に `turn`・`task`・`review`・`memory`・`summary`）。作り直しはここではしない。
4. `task_steps`（TBL-038）がステップ 3 の版 5 にあることを確かめる。`owner_kind` は `task`・`turn`、主キーは `(owner_kind, owner_id, step_key)`。`memory_search`（FTS5）も版 5 にあり、`tokenize = 'trigram'` で作られていることを確かめる（なければここで足す）。
5. `CODECS`（`db/codecs.ts`）に足りない表を足し、repo を 1 表 1 ファイルで書く。書く関数は「1 トランザクションで終わる単位」にし、トランザクションの中で LLM・box-manager を呼ばない。
6. 起動時に `agents.kind = 'main'` の行がなければ作る（FR-091。最初の先頭は 4.4 で作る）。
確かめ：空の DB に migration を流して表・索引・CHECK が揃い、ステップ 3 で作ったものと二重に作っていない（`sqlite_master` に同名が 2 つない）。`source_key` の重複 INSERT と、`running` の `turns` の 2 行目が UNIQUE で落ちる（単体）。

### 4.2 受付とルーター
1. `intake/receive.ts`：`receiveWake({ origin, sourceKey, targetKind, payload, tainted, hookId? })`。`wakes` に `queued` で入れ、`source_key` が重複なら何も書かず捨てる。`wakes.origin` の 7 種類（`chat`・`routine`・`scheduled`・`webhook`・`task_done`・`approval_done`・`steer`）をすべて受けられる形にする。汚染の付け方は FR-090 の表のとおり。ルーチン・予約・webhook・`approval_done` の作り手はステップ 5 なので、ここでは単体の試験から呼ぶ。
2. API-119：`Idempotency-Key` を `chat_messages.id` にし、`role = 'owner'` の行と `chat:<messageId>` のきっかけを同じトランザクションで入れる。202 を返す。同じ鍵の 2 回目は 1 回目の応答を返す。4,000 字を超えたら 422。API-120 は `mainState`（`sleeping`・`running`）つき。SSE は `chat.created`・`turn.updated`。
3. API-124：`steer:<Idempotency-Key>` のきっかけを `target_kind = 'task'` で入れる（タスクが動いていなければ 409 `TASK_NOT_ACTIVE`）。
4. `intake/router.ts`：`kick()`。呼ばれるのは、受付の直後・ターンが終わった直後・毎分のタイマー（4.9）。メイン宛ての始め方は FR-090 の順に、動いているターンがあれば何もしない → 最後の `chat` から 3 秒待つ → `queued` を古い順に 20 件・3 万トークンまで束ねる → 区分を決める → 日次の上限を見る → 履歴が 6 万トークン超なら要約（4.4。4.4 が済むまでは飛ばす）→ `turns` を作る。3 秒待ちはプロセス内のタイマーで行い、取りこぼしは毎分のタイマーが拾う。
5. 日次の上限（D-322）：`spend.ts` を `daily_usd`・`daily_auto_usd` の 2 本にし、区分は `usage_records.budget_class` で合計する。1 日の区切りは `Asia/Tokyo` の固定をやめ、環境変数 `TZ` にする。`auto` は `dropped`（`budget`）、`chat` は `queued` のまま待つ。どちらも `role = 'system'` のメッセージは 1 日 1 回だけ。
6. 束ねたきっかけの頭書きと汚染の枠は、描いた文を `input:<n>` の `result` に書き、`wakes` を `consumed`（`consumed_step_key = input:<n>`）にするまでを 1 つのトランザクションにする（D-277）。
確かめ：ターンの代わりに「1 秒眠るだけの実行役」を差して、curl で `POST /api/v1/messages` を続けて 2 回送ると 1 つの `turns` にまとまる。眠っている間に 3 回目を送ると `queued` のまま残り、終わった直後に次の `turns` が始まる。同じ `Idempotency-Key` の再送で `wakes` が増えない。

### 4.3 メインのターン
1. `steps.run(owner, key, { repeatable }, fn)`：`done` があれば結果を返し、なければ `started` を書いて（LLM の歩みは見積もりの費用 `reserved_micro_usd` も同じトランザクションで）`fn` を実行し、結果つきで `done` を書く。`task-run.ts` の `stepDo`（呼んだ順の番号で名前を付け、やり直しで同じ名前になる）と同じ考え方で、保存先を Workflows から `task_steps` に替える。
2. `packages/runner/src/turn.ts`：`runTurn(port, opts)`。1 歩は「LLM を呼ぶ → 道具を実行する」。`harness.ts` の `asEdgeError`・`stopOf`・`rateLimitWaitMs`・`abortableSleep` を共通ファイルに出して、`runTask` と `runTurn` の両方から使う。フェーズ・`finish`・`submit_report` の促しは持たない。道具を呼ばずに終わったら地の文は捨てて閉じる。
3. 上限（D-230）：歩みごとに、1 ターン $1・40 歩・10 分と日次を `steps.run` の前に確かめる。超えたら `halted`（`budget_exceeded`・`steps_exceeded`・`timeout`・`daily_budget_exceeded`）にして、本体が「上限で止まりました（○○の途中）」を `role = 'system'` で出す。
4. 道具（`turn/tools/`）：`send_to_owner`・`delegate`（4.5.a）・`list_tasks`・`steer_task`・`cancel_task`（4.5.c）・`search_memory`（4.8。中身は 4.8 が済むまでは空の結果を返す）・`read_skill`・`web_search`・`web_fetch`（ステップ 3 で `apps/makase/src/edge/` に移したものを渡す。`web_fetch` は egress と同じアドレスの判定とリダイレクト先の再判定を通る：D-164）。VM の道具は渡さない（D-236）。`schedule_wake`・`propose_routine`・コネクタの道具はステップ 5 で足す。道具の一覧はターンの始めに決めて途中で変えない（D-238）。使えないときはエラーを返し、文に次にやることを書く。
5. 作るものを持つ道具（`send_to_owner`・`delegate`・`steer_task`）は、`tool_use` の ID を UNIQUE の列に入れ、作ると `tool:<callId>` の `done` を同じトランザクションで書く。`repeatable = 0`。
6. `send_to_owner`（FR-093）：`text`・`file`（`/data/files/<taskId>/` の下だけ）・`choices`（2〜4）。`chat_messages`（`role = 'main'`・`notify`）と、`notify` なら購読ごとの `push_outbox` の行、SSE の合図を同じトランザクションで書く。送り手はステップ 5。
7. 閉じる：記憶の更新（4.8。4.8 が済むまでは何もしない空の関数）を回し、`turns` を `done` にして `kick()`。LLM の失敗が 3 回続いたら `failed` にし、同じトランザクションで、このターンで `consumed` にしたきっかけをすべて `queued` に戻して `retries` を増やす。3 回目は `dropped`（`retry_exceeded`）と `system` の知らせ（D-276）。汚染は `taintFromInputs`・`addTaintSource`（`packages/kernel/src/taint.ts`）で引き継ぐ。
確かめ：ScriptedLlm の台本「`send_to_owner` を呼ぶ → 道具なしで終わる」で、`chat_messages` の `main` の行と `push_outbox`（購読があれば）と SSE の `chat.created` が出る。地の文だけの台本ではチャットに何も出ない。`web_search`・`web_fetch` がメインの道具の一覧にある。41 歩目を呼ぼうとすると `halted`（`steps_exceeded`）と `system` の行が出る。

### 4.4 文脈の組み方・キャッシュ・要約
1. `context/build.ts`：①共通の指示 ②道具の定義 ③エージェントの指示・スキルの一覧・振り分け先の一覧 ④プロフィールの写し ⑤要約 ⑥履歴 ⑦最新、の順に組む。①〜⑤の部分ごとの sha256（`@open-team/kernel` の `canonicalJson`・`sha256Hex`）を `context_snapshots.parts_hash` に入れて固定する。作るのは、メインは起動時・要約のとき、タスクは始めるとき（`owner_kind = 'task'`）。
2. ⑥は `task_steps` の `llm:<n>`（返った assistant の content をそのまま）・`tool:<callId>`・`input:<n>` を並べて作る。組み直しは表から描き直さずこの記録だけを使う。記憶・一覧・持ち主の記憶の直しが変わったときは、次の `user` メッセージの中に「（本体から：…）」の text ブロックで足し、その文を `input:<n>` に書く（D-286）。
3. `claude.ts`（ステップ 1 で `packages/llm/src/claude.ts` に移したもの）を直す。(a) 思考のブロックを捨てず、返った content を `raw` として返し、`ChatMessage` に `raw` つきの assistant を足して素通しで送る。(b) `system` を text ブロックの配列にして、⑤の終わりと⑥の最後のブロックに `cache_control`（1 時間）を付ける。(c) 要約のとき以外は ①〜⑤ を 1 バイトも変えない。(d) `usage` の `cache_read_input_tokens`・`cache_creation` の 5 分・1 時間を `LlmUsage` に分けて持ち、`usage_records` に書く。
4. `context_management`（`clear_tool_uses_20250919`、beta `context-management-2025-06-27`）を、スクショを持つタスクの呼び出しに付ける。残す回数は `browser.keep_screenshots`（既定 3）。
5. 外れの記録：前の呼び出しから 1 時間以内で、①〜⑤のハッシュが前と同じなのに `cache_read_tokens` が先頭の長さの 9 割に届かなければ `cache.miss` を `audit_logs` に書く（部分ごとのハッシュつき）。呼び出しの前の入力が 20 万トークンを超えるなら呼ばず `halted`（`context_exceeded`）。
6. 要約（UC-060）：ターンを始める処理が、⑥が 6 万トークン超なら `turns` の前に「ここまでを要約して」を同じ先頭で呼ぶ。返った要約と作り直した①〜④で新しい `context_snapshots` を作り、履歴は持ち越さない。歩みの記録には書かず、`usage_records` に `phase = 'summary'`・`turn_id = NULL`・始めるターンの区分で残す。失敗したら要約せずに始める。
確かめ：ScriptedLlm で 3 ターン回し、2 回目以降の `requests[n].messages` が前の呼び出しの `messages` の先頭と JSON のバイトで一致する。`usage` にキャッシュ項目を与えた台本で、当たり率の計算と `cache.miss` の出る・出ないが決まる。再起動して `input:<n>` から組み直した `messages` が再起動前と同じバイトになる。実 API で 1 日分の短い会話を回して `cache_read_tokens` を見る（任意・有料）。

### 4.5 振り分けと報告
#### 4.5.a `delegate` とタスクの開始
1. `delegate`：`agentId`（既存）か `newAgent`（`apps/makase/src/agents/create.ts` の検証。ステップ 3 で移してある）、`brief`（4,000 字）、`title`（40 字）。1 つのトランザクションで `agent_snapshots` を作り、`tasks` を `queued` で作り（`turn_id`・`tool_call_id`・`trigger_type = 'delegate'`・`job_id = NULL`・`requester_id` はメイン・`budget_class` はターンのもの・ターンが汚染していれば `tainted = 1`）、`tool:<callId>` を `done` にする。そのターンの区分の今日の残りが $3 に届かなければエラー「今日の上限が近いので始められない」。
2. 始める役（`task/start.ts`）：消えた `asks/drive.ts` の `takeStartableTasks`・`claimQueuedTask`（`git show <sha>:<path>`）から `ask_run_id` の条件を外した形で書き、`workspace.max_tasks`（既定 3）の空きがあるぶんだけ `queued` → `provisioning` にする。タスクが終わるたびと毎分のタイマーで呼ぶ。
確かめ：ScriptedLlm のメインの台本で `delegate` を呼ぶと `tasks` が `queued` で 1 行でき、`tool:<callId>` の再実行で 2 行目ができない。`max_tasks = 1` で 2 つ目が `queued` で待ち、1 つ目が終わると `provisioning` になる。残りが $3 未満ならエラーが返る。

#### 4.5.b 裏のタスクの実行役と言い直し
1. 裏のタスクの実行役（`task/run.ts`）：消えた `workflows/task-run.ts` の Node 版。`runTask` を `steps.run`（`task_steps`、`owner_kind = 'task'`）の上で回す。違いは次の 3 つ。(a) 文脈は FR-092 の①〜⑤で、`context_snapshots` を動いている間に変えない。(b) 道具は、VM の道具（computer use・`open_url`・`read_page`・`confirm_action`・`request_takeover` と、ターミナルの 6 つ `run_command`・`list_files`・`read_file`・`search`・`write_file`・`delete_file`）・コネクタ・`web_search`・`web_fetch`・`read_skill`・`search_memory`・`report`。`send_to_owner`・`delegate`・`schedule_wake` は渡さない。`request_takeover`・`confirm_action` の中身は 4.7 が書く。(c) `report` を `TOOL_SPECS` に足す（`callTool` が `report_accepted` を返せば `harness.ts` は終える作りなので、ループは変えない）。`finish`・`notify`・`submit_report` はこの役には渡さない。
2. 動いている LLM の呼び出しの `AbortController` をタスクごとに持ち、4.7 の交代だけが中止できる口を作る（言い直しでは使わない）。
3. 言い直し（FR-089）：各 LLM 呼び出しの前に、`EdgePort` に足す `takePendingInputs` で、このタスク宛ての `steer` と、確認の結果・オートレビュー・交代の返却・コマンドの終わりをまとめて 1 つの `user` メッセージにして足す。LLM の呼び出しは中止しない。メインが出したものは、そのターンの汚染を引き継ぐ。
確かめ：タスクの台本で、道具の一覧に `web_search`・`web_fetch`・`request_takeover`・`confirm_action` があり、`send_to_owner`・`delegate`・`schedule_wake` がない。`steer` が次の LLM 呼び出しの先頭の `user` メッセージに入り、動いている呼び出しは中止されない。再起動して `task_steps` から続きが通る。

#### 4.5.c `report` を閉じる・`list_tasks`・`steer_task`・`cancel_task`
1. `report` を閉じる（`task/close.ts`）：1 つのトランザクションで、タスクを閉じ（`done`・`blocked` → `completed`、`failed` → `failed`（`agent_unable`）、`report_meta`、`report_kind = 'normal'`、2,000 字）、`task_done` のきっかけ（`task:<id>`、タスクの汚染を引き継ぐ）を入れ、報告を `memory_search` に入れ（4.8 が済むまでは空の関数）、SSE `task.updated` を出す。`halted`・`failed`・`cancelled` も同じ関数で理由を報告に入れて閉じる。成果物の VM のファイルは `/data/files/<taskId>/` に写す（口だけ作り、写しの実体の API-118 はステップ 7 の shell-agent。それまでは「写せなかった」と報告に書く）。
2. `list_tasks`・`steer_task`（`steer:<toolCallId>`）・`cancel_task`（API-016 と同じ関数）。API-122・123。API-100 は、ステップ 3 で作った API-100 に `wakes`・`tasks` の件数の元を足す。
確かめ：ScriptedLlm（メインの台本とタスクの台本）で、curl で頼む → `delegate` → タスクが `report` → `task_done` → 2 つ目のターンが `send_to_owner` を呼ぶ、までが SSE に流れる。`blocked` の報告もタスクは `completed` で閉じる。`cancel_task` と API-016 が同じ結果になる。API-100 に `wakes`・`tasks` の件数が出る。

### 4.6 本体の `computer` モジュール
1. ステップ 1 の box-manager クライアント（API-101・102・103・109）と、ステップ 2 の `judgeBrowserAction`・`browser_checks`・オートレビューを、`computer/` から呼ぶ層で包む。判定と行き先のコードはここで書き直さない。
2. VM を起こす：`workspace.vm_op` が `none` のときだけ、同じトランザクションで `starting` にして新しい世代の `boxes` を入れる（D-251）。待つ間のタスクは `status_detail = 'waiting_vm'`。
3. 画面の番：ステップ 2 で作った番を取る関数と、取り消しで `pending` を `expired` にする関数を `computer/` から呼ぶ（書き直さない。`screen_epoch` を増やすのはその関数の 1 か所だけ：D-258・D-299）。取れなければ（0 行）`waiting_screen` で待った順に渡す。返すのは、タスクの終わり・取り消し・3 分の無操作（4.9 のタイマー。LLM の呼び出し中・確認待ち・オートレビュー中・交代中は数えない）。
4. 1 歩（FR-075）：返事の操作の列を順に、見るだけ／変えるに分け、変えるものは `dryRun` → 判定 → 行き先 → 実行の直前の確かめ（D-307、1 トランザクション）→ 実行 → `browser_actions` の記録 → 次の 1 つの `user` メッセージに結果を並べる。確認待ちの間は `awaiting_approval` にして `paused_ms` に足す。
5. メインの道具の一覧に VM の道具が入っていないことを、一覧のテストで固定する。
確かめ：偽の box-manager で、タスク 3 つが画面の番を取り合って順に進む。番を持つタスクが取り消されると次のタスクに渡り、`screen_epoch` が 1 つだけ増える。3 分操作がないと番が空く。

### 4.7 交代と確認の口
1. box-manager（`apps/box-manager`）：API-113 `PATCH /internal/v1/boxes/:boxId/control`（`{ control: "agent"｜"handing_over"｜"human", controlEpoch }`）を box-agent に渡す。box-agent が違う `controlEpoch` の画面の操作（API-103）を 409 `STALE_CONTROL` で断ることを確かめる（なければ足す）。コマンド（API-117）には効かせない（D-296）。API-106 の VNC の中継に `control` の口を足す（入力を通す。`view` のときに入力を捨てるのは本体）。
2. `computer/takeover.ts`：`takeovers` の状態遷移を 1 トランザクション 1 関数で書く。`requested`（`request_takeover`）→ `active`（API-090）→ `ended`（API-091）、持ち主が自分から代わるときは `active` から始まる（`requested_at` は NULL）、期限で `expired`。動いている交代は VM の世代ごとに 1 つ（部分 UNIQUE で守る）。
3. 道具 `request_takeover(reason)`（200 字まで）：`takeovers` を `requested` で作り、タスクを `status_detail = 'waiting_takeover'` にして待ち、待ちの時間を `paused_ms` に足す（D-174）。同じトランザクションで SSE `check.created` と、購読ごとの `push_outbox` の行（文は「手を貸してください：<理由>」、`tag = takeover:<id>`）を書く。送り手はステップ 5。道具 `confirm_action(target, summary, category)`（申告）は、次の変える操作を指すしるしとしてステップ 2 の判定に渡す（`category` は `publish`・`pay`・`delete`・`send`・`account`・`other`：D-228）。この 2 つを 4.5.b の振り分け先の道具の一覧に足す。
4. API-090 `POST /api/v1/vm/takeover`（`routes/vm.ts`）：`boxes.control` を `agent` → `handing_over` にして `control_epoch` を 1 増やし、API-113 で box-manager に伝える。画面の番を持つタスクがあれば、動いている Claude の呼び出しを中止し（4.5.b の手順 2）、その `llm:<n>` の歩みを `done`（結果 `aborted`）で閉じて予約した費用を精算する（実際の請求額が取れなければ見積もりのまま確定。`started` のまま残さない：D-163）。**動いている操作の列は止める**（返った操作は捨てる）。その VM の `pending` の `browser_checks` を、ステップ 2 の関数で `expired`（`taken_over`）にする。box-agent の動いている操作が終わるのを待ち、`control = human`・`takeovers` を `active`（頼みがあればそれを、なければ新しく）・番を持つタスクの `status_detail = 'taken_over'` にして 200。番を持つタスクがなければ交代は VM だけに結びつく。409 `ALREADY_TAKEN_OVER`・`BOX_NOT_RUNNING`。
5. API-091 `POST /api/v1/vm/handback`（`{ note? }`、200 字まで）：`control` の接続を閉じ、`control = agent`・`control_epoch` を 1 増やし、API-113 で伝え、交代を `ended` にし、スクショを撮って残す（`end_screenshot_path`）。番を持つタスクがあれば、`note` を次の歩みに「人が操作した」と新しいスクショとともに渡して続ける。409 `NOT_TAKEN_OVER`。
6. API-089 `WebSocket /api/v1/vm/screen`（`routes/vm.ts`）：開始のとき `Origin` を確かめ、本体が box-manager の API-106 に RFB（VNC）をそのまま中継する。`mode=view` は VM が動いていればいつでも（眠っていれば 409 `BOX_NOT_RUNNING`）で、入力のメッセージは捨てる。`mode=control` は `boxes.control = 'human'` のときだけ、同時に 1 本だけ（409 `NOT_TAKEN_OVER`・`CONTROL_IN_USE`）。`control` が `human` でなくなったら本体が閉じる。
7. 期限（タイマーに登録する仕事。4.9）：頼み（`requested`）のまま 30 分、交代中（`active`）に 15 分操作がない（`boxes.last_activity_at`）→ `takeovers` を `expired` にし、`control = agent`・`control_epoch` を 1 増やして API-113 で伝え、タスクを報告の `blocked` で閉じて `task_done` を入れる（4.5.c の関数。D-257）。VM は止めない（D-237）。再起動のときの `requested`・`active` → `expired` は 4.9 の再開の表。
8. 交代中もターミナルのコマンド（API-117）は動く（世代と `actionId` だけを確かめる：D-296）。人の操作は合図で止めない。
9. `routes/check.ts`：API-087 `GET /api/v1/check` は、API の書き込みの承認・`kind: "browser"`（`taskId`・`taskTitle`・`reviewReason` つき）・`kind: "takeover"` の 3 種類を返す。`kind: "routine"`（ルーチンの提案：API-142）の枠はステップ 5 が足す。API-110 `POST /api/v1/browser-checks/:checkId/decision` は HTTP の口だけを書き、中身はステップ 2 の ○・× の処理を呼ぶ（`CHECK_NOT_PENDING`・`expired` の理由も同じ）。
10. SSE：`check.created`（確認・交代の頼みが増えたとき）・`check.updated`（決まった・期限が切れたとき）・`vm.updated`（`control`・`status` が変わったとき）を、3 のイベントの表（ステップ 3）に従って出す。
確かめ：偽の box-manager（API-113・105・106 を受ける）と ScriptedLlm で UC-048 の基本フロー。(1) タスクの台本が `request_takeover` を呼ぶと、`takeovers` が `requested`・SSE の `check.created`・`push_outbox` の `tag = takeover:<id>` の行ができる。(2) API-089 `mode=view` で入力が捨てられる。(3) API-090 で `control` が `handing_over` → `human`、`control_epoch` が 1 増え、API-113 が呼ばれ、動いていた `llm:<n>` が `done`（`aborted`）で閉じ、`pending` の `browser_checks` が `expired`（`taken_over`）になる。(4) `mode=control` が 1 本だけつながり、2 本目は 409 `CONTROL_IN_USE`。(5) API-091 で `agent` に戻り、`note` が次の歩みの入力に入る。放置：偽の時計で `requested` のまま 30 分、`active` で 15 分操作なしにすると `expired`・タスクが `blocked` の報告で閉じて `task_done` が入り、VM は止まらない。

### 4.8 記憶（プロフィールと検索）
1. `memory_facts`：1 つ 200 字、`deleted_at IS NULL` が 100 個・4,000 字まで（書くときに数える）。API-130（`?q=` で検索）・131・141 と `memory.changed`・SSE `memory.updated`。
2. 記憶の更新の歩み `memory:<n>`：ターンを閉じるとき、`chat` のきっかけの文（持ち主のメッセージ）があれば 1 回だけ回す。渡すのは、そのメッセージと関係のありそうな事実（最大 30 個）だけで、`send_to_owner` の文・道具の結果・webhook の本文・報告は渡さない（D-246）。`output_config.format` で `{ add, replace[{id, text}], remove[id] }` を受け、`id` は渡したものだけ通す。`refusal` なら何も書かない。数を超えたら `rank` の低いものから `deleted_at` を入れる。
3. `memory_search`：FTS5 の仮想表（`tokenize = 'trigram'`）。`kind`・`ref`・`day`・`text`・`tainted`（UNINDEXED）。`chat_messages`（`text` だけ）と `tasks.report` を書くときに同じトランザクションで入れ、元の行が消えたら消す。起動時に SQLite が FTS5 の `trigram` を持つか確かめ、なければ起動を止める。
4. `search_memory(query, kind?, since?)`：`bm25` の順で上位 10 件。汚染した報告から入った行には「外の内容」の印を付け、返したら呼んだターン・タスクを汚染する。
確かめ：curl で事実を足す・直す・消す。101 個目と 4,000 字超が `409 MEMORY_FULL`。台本で「好みを言う」メッセージの後に `memory:<n>` が走り、`memory_facts` が増え、次のターンの入力に「（本体から：記憶を更新した：…）」が入る。10 万行で `search_memory` が 500ms 以内。

### 4.9 タイマーと再開
1. ステップ 3 の `timer.ts` を `timer/` に昇格し、3 の毎時・毎日の仕事（`idempotency_keys`・`workspace_events` の掃除、バックアップ）も登録口に載せ替える。`timer/tick.ts`：毎分 1 回（起動時にも 1 回）。仕事を `registerTimerJob(name, fn)` で登録する形にする。ここで登録するのは、`kick()`（日次の上限で待つ `chat` の再評価を含む）・`task/start.ts`・画面の番の 3 分・VM の眠り（10 分）・box-manager の測った値の読み取り（API-109）・`vm_op` の時間の上限（D-294）・交代の期限（4.7 の 7）・毎時の掃除（`wakes` 30 日・`task_steps` 7 日など）。ルーチン・予約・送り待ちの再送はステップ 5 が同じ口に足す。タイマーは SQLite を読むだけで LLM を呼ばない。
2. `recovery/run.ts`：起動時、HTTP を受ける前に FR-084 の表を上から戻す。行ごとに `registerRecovery(row, fn)` で登録し、1 行 1 関数・1 トランザクションにする。このステップで書く行：`wakes` の `queued`（そのまま）・`turns` の `running`（歩みの記録をなぞる）・道具の歩みが `started` のまま（`tool_call_id` で探し、`steer_task` は `steer:<toolCallId>`、`cancel_task` はタスクの状態で確かめる）・LLM の歩みが `started` のまま（見積もりで精算してやり直す）・`tasks` の `queued`／`provisioning`（→ `queued`）／`running`・`awaiting_approval`（API の書き込みは待ち続ける、ブラウザは `box_restarted` で期限切れ）・`executing` と `browser_checks` の `executing`（`unknown_outcome`）・`auto_reviews` の空の `verdict`・`takeovers`（`requested`・`active` → `expired`。`control` の接続はもうない。タスクは `blocked` で閉じる：D-257）・`vm_op` の `starting`・`stopping`・止まっていない VM の世代（box-manager に止めさせ `failed`（`host_restart`）、画面の番を空にする。必ず新しい世代で起こし直す：D-327）。`vm_op` の `snapshotting`・`restoring`・`rebuilding`、`vm_snapshots` の `creating`、`sandbox_commands` の `running` の行はステップ 7 が足す。`routines`・`scheduled_wakes`・`push_outbox` の送り直しの行はステップ 5 が同じ口に足す。
3. 失敗したターンのきっかけの戻しは 4.3 の 7（D-276）と同じ関数を使い、再開では `turns.status = 'running'` のまま残った行を続きから動かす。
確かめ：24 時間ぶんの tick を偽の時計で回しても、ScriptedLlm の `requests` が 0 件のまま（NFR-082）。DB を途中の状態で作って `recover()` を呼ぶ単体の試験を、このステップの行ごとに 1 本（後のステップの行は登録の口があることだけ）。実プロセスの結合は、`started` の直後と `done` の直前で本体を落とし、再起動して続きから通る（60 秒以内：NFR-071）。

## 終わる条件
| ID | 確かめること | 方法（コマンド・操作） | 設計の参照 |
|---|---|---|---|
| S4-01 | UC-044：チャットで頼むと `wakes`（`chat`）が入り、202 が返る。`choices` のボタンの返事が `text`＋`reply_to` で入る | `curl -X POST /api/v1/messages`（`Idempotency-Key`・`Origin`・`X-Makase-Request: 1`・`Tailscale-User-Login` を付ける）と `curl -N /api/v1/events` | UC-044・API-119 |
| S4-02 | UC-054：ターンが回り、`send_to_owner` だけがチャットに出る。道具を呼ばない終わりでは何も出ない | ScriptedLlm の台本 2 本（呼ぶ・呼ばない）＋ SSE | UC-054・FR-091・093 |
| S4-03 | UC-055：`delegate` → タスク → `report` → `task_done` → メインが `send_to_owner`。`blocked` は新しいタスクで続ける | メインとタスクの台本を通す結合 | UC-055・FR-092 |
| S4-04 | UC-058：記憶の更新が持ち主のメッセージだけを材料にし、100 個・4,000 字を守り、渡した事実だけ消す | 単体＋台本。`id` の偽りを混ぜた応答で弾かれること | UC-058・FR-097・BR-12 |
| S4-05 | UC-060：⑥が 6 万トークン超で `turns` の前に要約、履歴は持ち越さない。失敗したら要約せずに始める。20 万トークン超で `context_exceeded` | 台本の `usage` で大きさを与える単体 | UC-060・FR-098・D-323 |
| S4-06 | 受付：`source_key` の重複・3 秒のまとめ・動いている間の `chat` が `queued` のままで、終わりに次のターンが始まる | 単体と結合（4.2 の確かめ） | FR-090・D-324 |
| S4-07 | タスクの完了が同時に 2 つ届くと 1 ターンにまとまる。実行の途中の再起動でもきっかけを落とさない | 結合（台本 2 本を同時に閉じる・`kill` を入れる） | UC-054・FR-090 |
| S4-08 | 費用：1 ターン $1・40 歩・10 分、`daily_usd`・`daily_auto_usd` の判定、`auto` は `dropped`、`chat` は待って毎分のタイマーで始まる。見積もりの予約と精算 | 単体 | FR-013・D-322 |
| S4-09 | 失敗したターンのきっかけの戻し（2 回まで、3 回目は `retry_exceeded`）。`input:<n>` からの組み直しが同じバイト | 単体 | D-276・D-277 |
| S4-10 | `tool_call_id` での再開：タスク・メッセージ・`steer_task`・`cancel_task` を重ねて作らない | 単体（`started` のまま再開） | D-249・D-287 |
| S4-11 | 再開の表：このステップの行すべて（`takeovers` を含む）。後のステップの表の行は登録の口があること | 単体（行ごと）＋ `kill` を入れた結合 | FR-084・D-327・NFR-071 |
| S4-12 | 先頭のハッシュとキャッシュの外れの判定。`cache_control` の位置 | 単体（`requests` の中身を見る） | FR-098・NFR-083 |
| S4-13 | 記憶のプロフィールの数・字数、`search_memory` の汚染の引き継ぎ、10 万行で 500ms | 単体＋計測 | NFR-087・FR-097 |
| S4-14 | 画面の番：タスク 3 つの取り合い、`screen_epoch`、3 分で返す（ステップ 2 の関数を呼ぶ） | 偽の box-manager の結合 | D-217・D-258・D-299 |
| S4-15 | 購読ごとの `push_outbox` の行（送り手はステップ 5）。`skipped` は送り手の側で | 単体（行ができること） | D-288・NFR-086 |
| S4-16 | NFR-082：きっかけがなければ LLM を呼ばない | 偽の時計で 24 時間分の tick を回し、`requests.length === 0`。実機では置いたまま 24 時間の `usage_records` の合計を見る（段 2 の 8.3） | NFR-082 |
| S4-17 | NFR-083：2 回目以降で先頭（①〜⑤）の 9 割以上がキャッシュに当たる率が 95% 以上 | ScriptedLlm では判定の式だけを確かめる。当たり率は実 API で `usage_records` の `cache_read_tokens` ÷ 先頭の長さを 1 日ごとに出す | NFR-083・ADR-066 |
| S4-18 | メインに VM の道具が渡っていない。メインと振り分け先の両方に `web_search`・`web_fetch` がある | 一覧の単体 | D-236・FR-091・092 |
| S4-19 | `web_fetch` が内側のアドレス（`127.0.0.1`・`10.0.0.0/8` など）とそこへのリダイレクトを断る | 単体（リダイレクト先が内側のアドレスの偽サーバーを立てる） | D-164 |
| S4-20 | UC-048 の基本フロー：見る（`mode=view`）・代わる（API-090）・返す（API-091）。`control` の遷移、`control_epoch`、API-113、`pending` の `expired`（`taken_over`）、`llm:<n>` の `aborted` | 偽の box-manager と ScriptedLlm の結合（4.7 の確かめ） | UC-048・FR-078・D-163 |
| S4-21 | 交代の放置：`requested` のまま 30 分・`active` で 15 分操作なし → `expired`、タスクは `blocked` で閉じて `task_done`、VM は止まらない。再起動で `expired` | 偽の時計と `kill` を入れた結合 | UC-048 の 3a・D-257・D-237 |
| S4-22 | `request_takeover` の通知：`takeovers` の `requested`・SSE の `check.created`・`push_outbox` の `tag = takeover:<id>`（同じ tag の `pending` は置き換え） | 単体（行ができること。送り手はステップ 5） | FR-078・FR-017・TBL-055 |
| S4-23 | 確認の口：API-087 が 3 種類（API の書き込み・ブラウザ・交代の頼み）を返し、API-110 が `CHECK_NOT_PENDING` と `expired` を返す | curl＋偽の box-agent | API-087・API-110 |
| S4-24 | `pnpm typecheck`・`pnpm test`・`pnpm lint:deps` が通る（`packages/runner` が `llm` を import しない：`.dependency-cruiser.cjs` の規則） | ルートで実行 | — |

## 実装で決めること
| 論点 | 設計の言い分 | おすすめ | 決めたら書く先 |
|---|---|---|---|
| runner のどこにターンの実行役を足すか | メインとタスクは同じ runner の上で、道具と文脈だけが違う（07 レベル3）。今の `runTask` はフェーズと `finish`・`submit_report` で終わる | `packages/runner/src/turn.ts` に `runTurn` を足し、エラーの扱いと待ちを共通ファイルに出す。タスクは `runTask` を使い、`report` を道具に足す | 00 の決定事項ログに D-xxx |
| `ChatMessage` に生の content を持たせる形 | LLM の返事は content をそのまま（思考のブロックと署名を含む）残す（D-256） | assistant に `raw`、user に複数ブロック（`tool_result` と本体の知らせ）を足し、`claude.ts` は `raw` を素通しにする | 同上 |
| 歩みの記録と `tool_call_id` の対応 | `tool:<callId>` の `callId` と `tool_call_id` の UNIQUE の列が同じ値（D-249） | Claude の `tool_use` の ID をそのまま使い、`edge` の作り直し（`runtime.newId`）は使わない。重なりや空はエラーで返す | TBL-038 の説明 |
| `cache_control` の付け方 | ⑤と⑥の終わりに 1 時間（D-263）。API の連結は tools → system → messages の順 | ①③④⑤を `system` の text ブロックにして最後に付け、⑥は最後のメッセージの最後のブロックに付ける。ブレークポイントは 2 つ | ADR-066 の影響 |
| `usage` のキャッシュ項目と単価 | `cache_read_tokens`・5 分・1 時間の書き込みを分けて残す | `LlmUsage` に 3 項目を足し、`pricing.ts` に読み取り・書き込みの倍率を入れて費用を出す。今は入力に混ぜているので見積もりと実費がずれる | `packages/llm` の注記・NFR-083 の横に実測 |
| context editing の API の形 | `clear_tool_uses_20250919`・beta `context-management-2025-06-27`・残す回数は `keep_screenshots`（D-256） | `edits` に `trigger`・`keep`・`clear_at_least` を渡す。値は実 API で確かめ、消すとキャッシュが外れる点を `clear_at_least` で抑える | 決定事項ログ |
| 入力の大きさの測り方 | ⑥が 6 万・全体が 20 万トークン（D-264・D-323） | 直前の呼び出しの `usage` の入力の合計を使い、最初の 1 回だけ `count_tokens` で数える。`inputTokensUpperBound` は Gemini の形に変換してバイト数を数えるので使わない | 決定事項ログ |
| 先頭の長さ（`context_snapshots.tokens`）の測り方 | ①〜⑤の大きさ。当たり率の分母 | 先頭を作ったあとの最初の呼び出しの `usage`（書き込み＋読み取り）で埋める | TBL-053 の説明 |
| FTS5 の trigram の索引の張り方 | 列は `kind`・`ref`・`day`・`text`・`tainted`（UNINDEXED）（TBL-050） | `fts5(kind UNINDEXED, ref UNINDEXED, day UNINDEXED, text, tainted UNINDEXED, tokenize = 'trigram')`。3 文字未満の語は `LIKE` に落とす。`kind`・`since` は結合で絞る | TBL-050 |
| 要約のプロンプトの置き場 | 持ち越すもの（約束・進んでいるタスク・持ち主の言い直し）と、外の内容の指示を写さないことを書く（FR-098） | `apps/makase/src/context/prompts/summary.ts` に固定の文字列で置き、変えたら `parts_hash` の対象に入れない（要約の呼び出しは先頭の後ろに足す user メッセージだから） | 決定事項ログ |
| 記憶の更新の指示・`rank` の式 | 足すと 0、使われると上がり、日がたつと下がる（TBL-047） | 使われた（`search_memory` が返した・④に入っている）とき +1、1 日ごとに ×0.98。値は使いながら直す | 決定事項ログ |
| `wakes.budget_class` を受付の時点でどう決めるか | 列は NOT NULL。ターンの区分は束ねたあとに決める（FR-090） | `chat`・`approval_done`・`steer`（持ち主から）は `chat`、それ以外は `auto` で入れる。ターンはこの列から決める | TBL-041 の説明 |
| `delegate_reason` の出どころ | `tasks.delegate_reason`（100 字）に選んだ理由を残す（FR-061）が、`delegate` の引数に理由がない | `delegate` に任意の `reason`（100 字）を足す | FR-092・FR-061 の引数 |
| 「1 日 1 回の知らせ」の印の置き場 | 日次の上限で待つ・捨てるの知らせは 1 日 1 回（FR-090） | 列は足さず、その日に同じ種類の `role = 'system'` の行（`body` に種類の印を持たせる）があるかで見る | 決定事項ログ |
| 3 秒のまとめの実装 | 最後の `chat` から 3 秒待つ（FR-090）。タイマーは毎分 | プロセス内の `setTimeout` を 1 本持ち、毎分のタイマーを保険にする | 決定事項ログ |
| 承認の期限と拾い直しの間隔 | 確認の期限は 30 分（FR-077）。旧コードに別の値がある | 旧コードの値は引き継がず、設計の値を使う。拾い直しの間隔は毎分のタイマーに合わせる | 決定事項ログ |
| 動いている Claude の呼び出しの中止の持ち方 | 交代のときだけ中止し、`aborted` で閉じて精算する（D-163） | タスクごとの `AbortController` をプロセス内の表に持つ。再起動すれば呼び出し自体がないので、`started` のまま残った歩みは 4.9 の再開で精算する | 決定事項ログ |
| 交代中の「無操作」の測り方 | 交代中に 15 分操作がない（FR-078） | `boxes.last_activity_at`（人・エージェントの最後の操作）を使い、VNC の入力のメッセージが来たら本体が更新する | TBL-032 の説明 |
| `isolated` モードが古い Docker でエラーになるか | `box` ネットワークの既定（07）。ステップ 3 の Compose に書いてある | 起動の確かめで Docker の版を見て、エラーなら 3.6 に戻って版を決める | 07 の注記 |
| ScriptedLlm の拡張 | 同じ入力なら同じ出力。試験・CI 用 | `ScriptedReply` に `usage` のキャッシュ項目と `raw` を足す。dev 用に `LLM_MODE=scripted` と台本ファイルで本体に差せる口を作る | `packages/llm` の注記 |

## 設計に戻すこと
- `delegate` の `reason` を足したら、FR-092 の引数と FR-061 の `delegate_reason` の出どころを直す。
- ステップ 4 で決めた値（`rank` の式・context editing の値・要約のプロンプト）は、00 の決定事項ログに D-xxx として足す。NFR-083 の当たり率と NFR-087 の実測は NFR の横に書く。
- UC-054 の基本フロー 6 に「閉じると決め」とあるのは D-280 の `closing_at` の名残り。D-324 で消えた分を直す。

## 参照
- 設計：[FR 常駐](../design/04_functional_spec/resident.md)（FR-089〜098・FR-017）・[FR 道具](../design/04_functional_spec/tools.md)（FR-013・061・088）・[FR VM](../design/04_functional_spec/vm.md)（FR-074・075・084）・[権限マトリクスとステータス定義](../design/04_functional_spec/README.md)・[DB 常駐](../design/08_database/resident.md)・[DB VM](../design/08_database/vm.md)・[DB 一覧](../design/08_database/README.md)・[API 常駐](../design/09_api/resident.md)・[API 一覧](../design/09_api/README.md)・[シーケンス](../design/10_diagrams/sequences.md)・[状態遷移](../design/10_diagrams/states.md)・[ユースケース](../design/03_use_cases.md)・[非機能](../design/05_non_functional.md)・[アーキテクチャ](../design/07_architecture.md)・[技術仕様](../design/11_tech_spec.md)・[決定事項ログ](../design/00_overview.md)
- ADR：[ADR-058](../design/adr/ADR-058-resident-agent.md)・[ADR-059](../design/adr/ADR-059-main-agent-delegates.md)・[ADR-062](../design/adr/ADR-062-send-to-owner.md)・[ADR-066](../design/adr/ADR-066-prompt-cache-layout.md)・[ADR-069](../design/adr/ADR-069-daily-auto-budget.md)・[ADR-070](../design/adr/ADR-070-memory-two-layers.md)
- 移す元のコード：`packages/runner/src/harness.ts`・`tools.ts`・`prompts.ts`・`types.ts`、`apps/worker/src/edge/`（`runtime.ts`・`limits.ts`・`spend.ts`・`llm-call.ts`・`context.ts`・`tools.ts`）、`apps/worker/src/workflows/task-run.ts`、`apps/worker/src/asks/drive.ts`・`run.ts`、`apps/worker/src/llm/claude.ts`、`apps/worker/src/agents/create.ts`、`packages/llm/src/`（`session-budget.ts`・`pricing.ts`・`scripted.ts`）、`packages/kernel/src/taint.ts`
