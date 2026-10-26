# ステップ 6. 画面
- プロジェクト：Agent-Team-Open ／ 手順書の版：v1.1（2026-10-25） ／ 設計の版：v1.5 ／ インプット：[06 画面・UX設計](../design/06_ux_design.md)、[09 API設計](../design/09_api/README.md)（[resident](../design/09_api/resident.md)・[vm](../design/09_api/vm.md)）、[FR-017・093・089](../design/04_functional_spec/resident.md)、[FR-077・078・100・079](../design/04_functional_spec/vm.md)、[FR-073・083・085](../design/04_functional_spec/tools.md)、[ADR-067](../design/adr/ADR-067-web-push-first.md)

> **3行で**
> 1. スマホから頼む・見る・確認する・タップで交代するところまでが、`apps/web` だけでできるようになる。ステップ 3〜5 で curl が通った API（09 の画面向けの一覧）を、06 の 10 画面につなぐ。ステップ 7 で作る API（114〜116・133〜135・138）は、このステップでは画面の骨と `qa/` の架空データで作り、実 API での確かめはステップ 7。
> 2. 作るもの：依頼（asks）中心の今の画面を、チャット（SCR-020）・タスク（SCR-021）・確認（SCR-019）に作り直し、VM の画面（SCR-022、noVNC）・設定（SCR-023）・記憶（SCR-025）・きっかけ（SCR-026）を足し、PWA（Service Worker で Web Push を受ける）にする。
> 3. 終わる条件：06 の画面遷移どおりに動き、iOS Safari の PWA と Android Chrome と PC で、幅 360px から頼む・確認する・見る・タップで交代するができる。SSE の合図を落としても画面が追いつく。

## 前提（始める条件）
- 入力（前のステップの成果）：
  - ステップ 3（`apps/makase`：SSE・FR-073・FR-083・`apps/web` のビルドを配る形）・ステップ 4（`wakes`・`turns`・`tasks`・`send_to_owner`）・ステップ 5（Web Push の送り手と購読・きっかけの API）が終わり、09 の画面向けのエンドポイントが curl で通る。ステップ 7 で作る API（114〜116・133〜135・138）は、このステップでは画面の骨と `qa/` の架空データで作り、実 API での確かめはステップ 7。API が変わっていたら、先に 09 を直す
  - API-087・089・090・091・110 と `takeoverRequest`（API-088 の応答の欄）は、ステップ 4 で作った（交代と確認の口）
- 機械（置き先・実機）：
  - 置き先は段 1（手元の WSL2・amd64）。画面の確かめは、dev サーバーを `--port 5211 --strictPort` で立ててヘッドレスの Chromium でスクショを撮る（WSL2 では vite が `/mnt/c` の変更を拾わないので、コードを変えたら立て直す。日本語フォントと Chromium のライブラリが要る）。iOS・Android の実機は、Compose を立てたホストに tailnet から入って確かめる（Service Worker と Web Push は https が要るため）
  - 実機の iPhone（iOS 16.4 以上。ホーム画面に追加した PWA だけ通知が届く）と Android。`@novnc/novnc`（npm）
- 鍵とアカウント：VAPID の鍵（ステップ 5）。tailnet に入れるアカウント

## 作るもの
| 部品 | 置き場 | 移す元（あれば） | 設計の参照 |
|---|---|---|---|
| 土台：CSRF のヘッダー・合図で取り直す仕組み・06 の経路 | `apps/web/src/api.ts`・`workspace.tsx`・`lib/sse.ts`・`lib/router.ts` | 同じ場所（書き換える） | FR-073、D-196、06 全体図 |
| チャット SCR-020 | `screens/Chat.tsx`・`lib/chatView.ts`・`lib/uuidv7.ts`・`components/TaskBand.tsx` | `screens/Chat.tsx`・`lib/chat.ts`・`lib/draft.ts` | 06 SCR-020、FR-089・093、API-119・120・122 |
| タスク SCR-021 | `screens/Task.tsx`・`lib/steps.ts` | `screens/AskPage.tsx`（作り直す） | 06 SCR-021、API-123・124・016 |
| 確認 SCR-019 | `screens/Check.tsx`・`components/CheckRow.tsx`・`components/CheckSheet.tsx`・`lib/reasons.ts` | 同じ場所（種類を 4 つに作り直す） | 06 SCR-019、FR-077、API-087・019・110・142 |
| VM の画面 SCR-022 | `screens/Vm.tsx`・`components/VmScreen.tsx`（noVNC）・`lib/vmState.ts` | 新規 | 06 SCR-022、FR-078、API-088〜091・099 |
| 設定 SCR-023 | `screens/Settings.tsx`・`components/settings/*`（上限・こわい操作・通知・つながり・VM・ホスト） | `components/GithubLine.tsx`・`GoogleCalendarLine.tsx`（つながり欄へ） | 06 SCR-023、API-096・031・032・137・093・094・107・111・133〜135・138 |
| 記憶 SCR-025・きっかけ SCR-026 | `screens/Memory.tsx`・`screens/Triggers.tsx` | 新規 | 06 SCR-025・026、API-130・131・141、API-125〜128・136・139・140 |
| パック SCR-024・エージェント SCR-014・記録 SCR-010 | `screens/Packs.tsx`・`Agents.tsx`・`Audit.tsx` | 同じ場所（差分） | 06 の各「差分」、API-114〜116・041・080・081・023 |
| PWA：manifest・Service Worker・購読 | `apps/web/public/manifest.webmanifest`・`public/sw.js`・`lib/push.ts`・`lib/presence.ts` | 新規 | FR-017、ADR-067、API-121・137・031 |

`apps/web/src` の「今 → v1.4」（全ファイルを開いて確かめた。テストは対応するファイルと一緒に動かす）：

| 今 | 区分 | v1.4 での扱い |
|---|---|---|
| `main.tsx` | 作り直す | 入口のトークン（`Entry`）・`SetupRequired`・`signed_out` を消す。`GET /session`（API-083）が 403 `NOT_OWNER` なら「このアカウントでは入れません」を出す（UC-043 E1）。経路を 06 に合わせる |
| `api.ts`（913 行） | 作り直す | 型とメソッドを 09 に合わせて入れ替える。`csrfToken`・`/entry`・`/logout`・`/workspaces/:id/stream`・依頼・`done`・スキル案・作業場のリセットを消し、`X-Makase-Request: 1` を足す |
| `workspace.tsx` | 作り直す | `me`・`csrfToken`・`workspaceId` を消す。SSE の購読と `reset` の配りは残し、件数は API-100 を合図で取り直す |
| `lib/router.ts`・`scrollMemory.ts`・`screen.ts`・`title.ts`・`viewport.ts` | 残す（経路だけ直す） | `/tasks/:taskId`・`/vm`・`/settings`・`/memory`・`/triggers` を足し、`/asks`・`/done`・`/packs/:packId` を消す。題と「戻る先」の表も同じに |
| `lib/sse.ts` | 残す（足す） | 再接続の論理はそのまま。通し番号の飛びを見つけたら `reset` を自分で出す（6.1） |
| `components/Markdown.tsx`・`lib/markdown.ts`・`Avatar.tsx`・`lib/avatar.ts`・`Skeleton.tsx`・`LoadError.tsx`・`ui/*`・`lib/format.ts`・`useCopy.ts`・`useRestoreFocus.ts`・`dayGroup.ts`・`text.ts`・`useElapsed.ts`・`requestKey.ts` | 残す | チャット・タスク・記録でそのまま使う。`Markdown` は太字・箇条書き・リンクだけ（FR-093） |
| `components/AppHeader.tsx`・`styles/shell.css` | 残す（メニューを直す） | メニューを「チャット・確認（件数）・エージェント・きっかけ・記憶・パック・記録・設定」に。つなぎ方のメニュー部分は設定へ移す |
| `components/CheckSheet.tsx`・`CheckRow.tsx`・`screens/Check.tsx`・`lib/useCheck.ts`・`lib/order.ts` | 作り直す | 報告・質問の種類を消し、ブラウザ・API の書き込み・交代の頼み・ルーチンの提案の 4 種類に。SSE の畳み込み（`applyCheckEvent`）は消し、合図で API-087 を取り直す |
| `components/Notices.tsx`・`lib/notice.ts`・`styles/notice.css` | 作り直す（骨は残す） | 「依頼の回答」のカードを、`chat.created`（チャット以外の画面にいるとき）と `check.created` の短い知らせに替える |
| `screens/Chat.tsx`・`lib/chat.ts`・`lib/draft.ts`・`lib/prefill.ts` | 作り直す | 依頼を並べる会話から、`chat_messages` を並べるメインとの 1 本のチャットへ。`draft.ts` は残す。`prefill.ts` は `/?text=` を使うなら残す |
| `screens/AskPage.tsx`・`lib/turns.ts`・`placement.ts`・`progress.ts`・`shape.ts`・`retry.ts` | 作り直す（→ `Task.tsx`） | 編成・段・形の考え方を捨て、歩み・ブラウザ・ターミナル・オートレビュー・報告に |
| `screens/Asks.tsx`・`screens/Done.tsx`・`lib/askList.ts`・`useAskGeneration.ts`・`generation.ts`・`styles/ask.css`・`asks.css` | 消す | API-072〜077・084 は無い（09）。「済んだもの」の画面も 06 に無い |
| `lib/teamActivity.ts`・`teamActivity.fixture.ts`・`teamActivity.test.ts`・`qa/team-activity.*` | 消す | 依頼の「担当の段」を架空データで見る確かめ用の画面（`AskPage` の `Stages` を描く）。AskPage と一緒に消える。同じ型の確かめ用の画面を SCR-019・021・022 で作る（6.3） |
| `components/AgentBirth.tsx`・`lib/birth.ts`・`GenStage.tsx`・`NewAgentSheet.tsx`・`PackInstallCeremony.tsx`・`lib/ceremony.ts` | 残す | エージェントの作成（API-080）とパックを入れる（API-115）のときの演出。`GenStage` が `generation.ts` に頼っていれば切り離す |
| `screens/Agents.tsx` | 作り直す（差分） | メインの行を先頭に（消せない）・`description` の編集・パック名／「メインが作成」の札。`AgentSkills.tsx`・スキル案・作業場のリセットは 09 に API が無いので消す |
| `screens/Packs.tsx`・`lib/packLabels.ts` | 作り直す（差分） | 「入っている」「入れられる」の 2 つの一覧（API-114）にする |
| `screens/PackWorkspace.tsx`・`lib/packWorkspace.ts`・`styles/pack-workspace.css` | 消す（おすすめ） | 06 の遷移図に `/packs/:packId` が無く、依頼の生成に頼っている。残すかは「実装で決めること」 |
| `screens/Audit.tsx`・`lib/audit.ts`・`styles/audit.css` | 残す（差分） | 種類の絞り込みに「きっかけ」「オートレビュー」「VM」を足す（API-023） |
| `components/GithubLine.tsx`・`GoogleCalendarLine.tsx`・`lib/argLabels.ts` | 移す | つなぎ方は設定のつながり欄へ。`argLabels` は API の書き込みのカードで使い続けられる分だけ残す |
| `lib/undo.ts` | 決める | ○ のあとの 5 秒の取り消し猶予。ブラウザの確認には合わない（「実装で決めること」） |
| `index.html`・`vite.config.ts`・`package.json` | 直す | manifest・apple-touch-icon・`theme-color` を足す。vite の中継に `ws: true`・身元ヘッダー・`X-Makase-Request` を足す。`@novnc/novnc` を入れる |
| 新規 | 足す | `screens/Task.tsx`・`Vm.tsx`・`Settings.tsx`・`Memory.tsx`・`Triggers.tsx`・`components/VmScreen.tsx`・`TaskBand.tsx`・`lib/uuidv7.ts`・`lib/push.ts`・`lib/presence.ts`・`lib/reasons.ts`・`public/sw.js`・`public/manifest.webmanifest` |

## 手順
P1の画面契約：T-1は通常の承認でなく交代カード。API-087のeffectiveActionを確認カードに表示する。画像不明は画像なしの対応要求、FR-091のsystem通知は確定済み/未完了/結果不明を分けて表示する。受入は[IMP-002〜004・009](../design/changes/2026-10-25-p1-review-fixes.md)（SCR-019・020・022）。
### 6.1 土台（API の呼び方・合図で取り直す・経路）
1. `api.ts` の `request` を直す。GET 以外に `X-Makase-Request: 1` を付ける。`Origin` はブラウザが付ける。`csrfToken`・`CSRF_TOKEN_INVALID` の再試行・`/entry`・`/logout` を消す。`describeError` は 09 のエラーコード表（`BOX_RUNNING`・`SCREEN_IN_USE`・`MAIN_AGENT`・`TASK_NOT_ACTIVE`・`ROUTINE_LIMIT`・`SCHEDULE_INVALID`・`MEMORY_FULL`・`VM_BUSY`・`DISK_LOW`・`CHECK_NOT_PENDING`・`PACK_*`・`CONTROL_IN_USE` ほか）に合わせて決まった文に入れ替える
2. 型は 09 の応答の例から手で写す（今と同じ。zod の契約は出ていない）。依頼・チェックの旧い型（`AskDetail`・`StageView`・`CheckItem` の報告と質問・`DoneItem` ほか）を消す
3. `lib/sse.ts` の URL を `GET /api/v1/events`（API-085）にし、受ける種類は「ステップ 3 の表のとおり」にする。URL に `?lastEventId=`（再接続のとき）と `?deviceId=`（心拍 API-121 と結ぶ）を付ける（ステップ 3 の本体が両方を受ける）。`id:` が前の番号の次でなければ（飛んだ）その場で `reset` を出す
4. `workspace.tsx` に「合図で取り直す」フック `useSignal(types, refetch)` を足す。合図・`reset`・つなぎ直し（`onOpen`）・画面が前に出たとき（`visibilitychange`）に `refetch` を呼ぶ。合図は中身を持たないので、畳み込みはしない。取り直しは通し番号を持ち、古い応答が新しい応答を上書きしない（`useCheck` の今の作りを写す）
5. `lib/router.ts` の `Route` と `parseLocation` を 06 の画面一覧に合わせる。`/` `/tasks/:taskId` `/check` `/vm` `/agents` `/triggers` `/memory` `/packs` `/audit` `/settings`。`lib/screen.ts` の題と戻る先（タスク → チャット、VM → タスク、記憶・設定 → チャット）も同じに。`router.test.ts`・`screen.test.ts` を直す
6. asks の画面と lib（上の表の「消す」）を消し、`main.tsx` の `Screens` を新しい経路に。入口のトークンの画面を消し、403 の画面を足す。ビルドと型検査が通る状態にしてから先へ進む
7. `vite.config.ts` の中継に `ws: true`（API-089 の WebSocket）を足し、中継先は本体の :8080。開発時の身元ヘッダーはステップ 3 の決めに従う
確かめ：`pnpm --filter @open-team/web typecheck && pnpm --filter @open-team/web test` が緑。dev サーバーで開くと空のチャットの骨が出て、`Network` に `GET /api/v1/session`・`/events` が並ぶ。本体を止めて 8 秒待つと「つながっていません」が出て、起こすと消える。`curl` で `POST /api/v1/messages` を打つと、画面の取り直しの要求が 1 回走る

### 6.2 チャット（SCR-020）
1. `lib/uuidv7.ts` を足す（API-119 の `Idempotency-Key` はメッセージの ID。UUIDv7）。`requestKey.ts` は v4 のままで、ほかの POST に使う
2. `Chat.tsx`：`GET /messages?limit=50`（API-120）で読み、`mainState`（`sleeping`・`running`）を取る。`chat.created`・`turn.updated` の合図で取り直す。上に引くと `before=<nextBefore>` で 50 件ずつ足す。持ち主・メイン・`system` の 3 種類、`text`（Markdown）・`file`・`choices` を描く。`reaction` は無い
3. 送る：画面が ID を作って薄い色ですぐ出し（送信中の一覧は画面の状態）、API-119 の 202 で普通の色に、失敗なら「送れませんでした」と [ 再送 ]（同じ ID で出し直す。冪等）。4,000 字を超えたら送る前に止める。書きかけは `draft.ts`
4. 選択肢：押すと `kind: "text"`・`replyTo`・`choice` で送り（API-119）、押したボタン以外を薄くする（`chosen` が入った応答でも同じに）。ファイル：[ 保存 ] は `/api/v1/files/...` への `download` つきのリンク、[ プレビュー ] は `?preview=1` を新しいタブで（`rel="noopener"`。画面側でスクリプトを動かす処理は書かない：D-243）
5. `TaskBand.tsx`：`GET /tasks?status=active`（API-122）で動いている数と先頭 2 つのタイトルを出し、0 なら出さない。押すと下から一覧を出し、行で `/tasks/:taskId`。確認の件数は API-100（0 なら出さない）。`task.updated`・`check.*` の合図で取り直す
6. 状態：読み込み中（`Skeleton`）・空（「メインに話しかけてください」と例を 3 つ）・メインが起きている（入力欄の上に「考えています…」だけ。中身は出さない）・`system`（上限で止まった。日次の上限で待っているときは設定の上限の欄 `/settings#limits` へのリンク：D-322）・つながらない。メインが動いている間も入力欄は使える
7. 前に出ている間の心拍（`lib/presence.ts`）はここで入れる：初回に `deviceId`（UUID）を `localStorage` に作り、`visible` の間 30 秒ごとに API-121 を打つ。隠れたら `visible: false`（6.6 で詰める）
確かめ：curl でメインの `send_to_owner`（`text`・`choices`・`file`）を作らせるか、ScriptedLlm のケースを流して、チャットに出る。送ると薄い色 → 普通の色。本体を止めて送ると「送れませんでした」→ 起こして [ 再送 ] で 1 件だけ入る（二重にならない）。幅 360px と 1280px のスクショを撮って自分の目で見る

### 6.3 タスク（SCR-021）と確認（SCR-019）
1. `Task.tsx`：`GET /tasks/:taskId`（API-123）。タイトル・状態・エージェント・`delegateReason`・`origin`・`brief`、歩み（`steps`。パックの手順書ごとの区切りは API の並びのまま）、ブラウザの欄（画面の番を持つか・`lastShotUrl`・操作 `actions` / `maxActions`・[ 画面を見る ] → `/vm`）、ターミナルの欄（コマンドと出力。64KB まで）、オートレビュー（通した・止めた・理由）、報告と成果物。`task.updated` の合図で取り直す
2. 言い直す（API-124：2,000 字まで、`Idempotency-Key` つき。「次の歩みで伝えます」を小さく出す。409 `TASK_NOT_ACTIVE` は入力欄を畳んで「終わっています」）。止める（確かめのダイアログのあと API-016）
3. `Check.tsx` / `CheckRow.tsx`：`GET /check`（API-087）の 4 種類。ブラウザ（スクショ・押す場所の赤い印・「押すもの」・理由・あと N 分・[ 画面を見る ][ × ][ ○ ]）、交代の頼み（理由・[ 手を貸す ] = `/vm` を開いて API-090）、API の書き込み（PR は差分の要約とファイルの一覧、カレンダーは題・日時・場所・招く人：D-198）、ルーチンの提案（名前・読める時刻・プロンプト・[ × ][ ○ ]）
4. 理由の文：`lib/reasons.ts` に `reasons`（T-1〜T-7）と `declared`・`reviewReason` を日本語にする表（秘密の欄・確認するドメイン・必ず人の言葉・決まった言葉・キーでの作動・修飾キー・押す先が分からない・POST の送信、エージェントの申告の種類）。オートレビューが止めたものはその理由も出す
5. ○ / ×：ブラウザは API-110、API の書き込みは API-019、ルーチンの提案は API-142。応答の `result` を文にする：`executed`（消える）・`page_changed`（「画面が変わったので実行しませんでした。エージェントが決め直します」）・`unknown_outcome`（「実行されたか分かりません。画面を見て確かめてください」）・`expired`（`expireReason` を添えて「状況が変わったので実行しませんでした」：D-307）。409 `CHECK_NOT_PENDING` は「もう決まっています」と出して取り直す。二重押しは押した時点でボタンを無効にする。交代を始めたら（`check.updated`）その VM のブラウザの確認は一覧から消える
6. `CheckSheet.tsx`（ヘッダーの件数から開く）は同じ `CheckRow` を使う。通知のタップ先 `/check?item=` の強調は今の `rowDomId` を残す
7. 確かめ用の画面 `apps/web/qa/`（今の team-activity と同じ型。「架空データです」の帯つき）に、SCR-019 の 4 種類と全部の結果、SCR-021 の状態（動いている・確認待ち・報告済み・取り消し済み）を架空データで並べる。本物の API でできない状態（期限切れ・`unknown_outcome`）はこちらで見る
確かめ：本体（ScriptedLlm と偽の box-manager）でタスクを 1 つ作り、歩みが増えるのが画面に出る。ブラウザの確認を 1 件作り、○ で `executed` → カードが消え、タスクが進む。同じカードで × → 消える。もう一度 ○ の API を curl で打つと 409 `CHECK_NOT_PENDING`。言い直し（US-068）で `task_steps` に入る

### 6.4 VM の画面（SCR-022、noVNC）
1. `npm` で `@novnc/novnc` を `apps/web` に入れる（版を固定）。`VmScreen.tsx` は `RFB` を `wss://<自分のホスト>/api/v1/vm/screen?mode=view|control`（API-089）につなぐ。`mode=view` は `viewOnly` を真にし、`mode=control` は偽にする。`scaleViewport` で幅に合わせ、PC では原寸（原寸のとき `clipViewport` と `dragViewport`）。接続が切れたら 2 秒・4 秒… と再接続し、409 `BOX_NOT_RUNNING`（眠っている）では再接続せず「最後のスクショ」に切り替える
2. `Vm.tsx`：`GET /vm`（API-088）で状態を出す。動作中・渡す準備中（`handing_over`）・交代中・確認待ち・眠っている（最後のスクショと「次に使うときに起きます」）・つながらない。画面の番を持つタスクとタイトル、待っているタスクの数、`lastActionSummary` を「エージェント：『…』」で、`takeoverRequest` があれば上に帯で理由を出す。`vm.updated` の合図で取り直す
3. [ 代わる ] → API-090（成功したら `mode=control` につなぎ直す）。[ 返す ] → API-091（`note` を任意で書ける。成功したら `mode=view` に戻し、タスクがあれば `/tasks/:taskId`）。[ VM を止める ] → 確かめのダイアログのあと API-099。409 `ALREADY_TAKEN_OVER`・`CONTROL_IN_USE`・`NOT_TAKEN_OVER` は状態を取り直して文にする
4. 交代の頼みの入口：確認のカードの [ 手を貸す ] とタスクの [ 画面を見る ]。通知のタップ（`/vm`）で開いたとき、VM が `status: stopped` や頼みの取り下げ済みなら、その状態を文で出す
5. PC：キーボードをそのまま渡す（`RFB` の既定）。交代中の文字入力はこの端末の種類が PC のときだけ。スマホ（`pointer: coarse`）では文字入力の欄を出さず、下に [Tab] [Enter] [Esc] [⌫] のボタン（`rfb.sendKey`）だけを出す（D-181）。ピンチでの拡大は `view` で使える
6. スマホのタップ：交代中のタップを VNC のクリックに写す方法を決める（「実装で決めること」）。決めたら、画面の座標が合っているか（スクロール位置・拡大・`devicePixelRatio`）を、試験ページ（ステップ 1 の `evals/pages/`）のクリックの座標を読む欄で確かめる
7. 横向き：SCR-022 だけ縦横の両方を許す（06）。ほかの画面は縦のまま
確かめ：`mode=view` でエージェントの操作がライブで見え、画面に触れても何も送られない。[ 代わる ] のあとタップ・ボタンの Tab/Enter が試験ページに届く（クリックの座標を試験ページが表示する）。PC で文字を打つと画面に出る。[ 返す ] のあと `view` に戻る。別の端末から `control` をつなぐと `CONTROL_IN_USE`。VM を止めると「次に使うときに起きます」と最後のスクショが出る

### 6.5 設定・記憶・きっかけ・パック・エージェント・記録
#### 6.5.a 設定 SCR-023（上限・こわい操作・つながり・ホスト。VM の欄は骨）
1. 設定（`Settings.tsx`。欄ごとに折りたたみ）：上限（`GET/PATCH /settings`：API-096 の `budget.daily_usd`・`daily_auto_usd`・歩数・操作・時間・同時数。変えると「次のタスクから効きます」。日次の上限を上げると待っているターンが 1 分以内に再開すると書く）／こわい操作（4 つの語の一覧の足す・外す）／通知（6.6）／つながり（`GET /connectors`、つなぐ = `GET /connect/:kind/start` への画面遷移、外す = `DELETE`）／VM／ホスト
2. 設定の VM の欄（API-133〜135・138 はステップ 7 で作る。ここでは骨と `qa/` の架空データで作り、実 API での確かめはステップ 7）：`GET /vm`・`GET /vm/snapshots` で状態（動いているか・ホームの大きさ / 上限 4GB・プロフィールの大きさ・`vmHomeState`）と控えの一覧（日付・大きさ）。[ 今すぐ控えを取る ]（API-133）、[ この控えに戻す ]（ダイアログに「動いているタスク N 件が止まります」：API-134）、[ 空から作り直す ]（API-135）、[ ブラウザのデータを消す ]（API-138。`SCREEN_IN_USE` は文にする）。`vm_op` が `none` でない間は 4 つとも無効で、`vm.updated` で進みを取り直す。`vmHomeState: "broken"` は「ホームが壊れています。控えに戻すか作り直してください」を出し、戻す・作り直す以外を無効に。4GB 超は「ホームが 4GB を超えたので VM を止めました」を出す。507 `DISK_LOW`・409 `VM_BUSY` も文にする
3. ホストの欄：`GET /host`（API-111）。版・空きメモリ・空きディスク・モデル（オートレビューのも）・今日の費用・キャッシュの当たり率と外れの件数・Funnel の状態。`vm.browserSandbox: false` は「ブラウザのサンドボックスなし」を出す
確かめ（幅 360px と 1280px で撮って目で見る）：上限の欄で日次の上限を上げて保存でき、チャットの `system` の知らせから `/settings#limits` に来られる。こわい操作の語を足す・外すが `GET /settings` に反映される。つながり欄で `GET /connectors` の一覧が出て、つなぐ（画面遷移）・外すが動く。ホストの欄に版・空きメモリ・空きディスク・モデル・今日の費用・Funnel の状態が出る。VM の欄は `qa/` の架空データで、4 つのボタン・`vm_op` 中の無効化・`broken`・4GB 超の文・ダイアログを撮って見る（実 API ではステップ 7）。

#### 6.5.b 記憶 SCR-025
4. 記憶（`Memory.tsx`）：`GET /memory?q=`（API-130）で、数と字数（`count / maxCount`・`chars / maxChars`）・事実の一覧（`rank` の順・足した人・日付）。直す・消す（API-131）、足す（API-141。200 字まで。409 `MEMORY_FULL` は「いっぱいです。何かを消してください」）。検索欄。`memory.updated` で取り直す。ログとメモの欄は無い（D-325）
確かめ（360px と 1280px）：数と字数（`count / maxCount`・`chars / maxChars`）・事実の一覧・検索欄が出る。足す → 消すが API に反映され、`memory.updated` で別のタブにも出る。200 字を超えると足せず、`MEMORY_FULL` の文が出る。

#### 6.5.c きっかけ SCR-026
5. きっかけ（`Triggers.tsx`、3 つのタブ）：ルーチン（API-125・126・136。時刻は「毎日・平日・毎週○曜・毎月○日」と時刻から選び、「詳しく」で cron の 5 欄。15 分未満は選べない。409 `ROUTINE_LIMIT`・422 `SCHEDULE_INVALID` を文に）／予約（API-127・139）／受け口（API-128・140。作った直後だけ URL と秘密を出し、コピーのボタンを付ける。画面を離れたら二度と出ない。`funnel: "off"` のときは tailnet の設定の案内：FR-083）。`trigger.updated` で取り直す
確かめ（360px と 1280px）：3 つのタブ（ルーチン・予約・受け口）が出る。ルーチンを作ると一覧に出て、15 分未満は選べず、cron の `*/10` は 422 の文になる。受け口を作ると URL と秘密が 1 度だけ出て、画面を離れて戻ると出ない。`funnel: "off"` のときは案内が出る。

#### 6.5.d パック・エージェント・記録
6. パック（`Packs.tsx`。API-114〜116 はステップ 7 で作る。ここでは骨と `qa/` の架空データで作り、実 API での確かめはステップ 7）：入っている / 入れられるの 2 つの一覧（API-114）、入れる（API-115。`PackInstallCeremony` を出す）・外す（API-116。409 `AGENT_BUSY` は「動いているので外せない」）・更新（「手で変えた設定は失われます」の確かめのあと API-115）。状態：読み込み中・空・入れられるものなし・失敗
7. エージェント（`Agents.tsx`）：`GET /agents`（API-041）でメインを先頭に（消すメニューなし。「指示の手直し」だけ）。`description`（いつ使うか）の編集、`kind` / `createdBy` からパック名の札か「メインが作成」の札。作る（API-080。`AgentBirth`）・消す（API-081。409 `AGENT_BUSY`・`MAIN_AGENT`）。ブラウザのデータを消すボタンは置かない（設定へ移った）
8. 記録（`Audit.tsx`）：種類の絞り込みに「きっかけ」「オートレビュー」「VM」を足し、`audit.ts` の要約の文を、きっかけ（起こされた理由・受け口・重複で捨てたもの）・オートレビュー（通した・止めた・理由）・VM（起きた・眠った・控え・戻した）で足す
確かめ（360px と 1280px）：エージェントの一覧でメインの行が先頭にあり消すメニューがなく、`description` を直せて、パック名の札と「メインが作成」の札が出る。作る（`AgentBirth`）・消す（`AGENT_BUSY`・`MAIN_AGENT` の文）が動く。記録の絞り込みに「きっかけ」「オートレビュー」「VM」が並び、要約の文が出る。パックの 2 つの一覧・入れる（`PackInstallCeremony`）・外す・更新の確かめは `qa/` の架空データで撮って見る（実 API ではステップ 7）。

### 6.6 PWA（Web Push を受ける・ホーム画面に追加）
1. `public/manifest.webmanifest`：`name`・`short_name`・`start_url: "/"`・`scope: "/"`・`display: "standalone"`・`theme_color`・`background_color`・アイコン（192・512 と maskable）。`index.html` に `<link rel="manifest">`・`apple-touch-icon`。アイコンの絵は今の `index.html` の丸いマークに合わせる
2. `public/sw.js`（手書き。キャッシュはしない）：`push` で通知を出す（`title`・`body`・`tag` で置き換え・`data.url`）、`notificationclick` で開いている窓があれば `focus` してその経路へ移し、なければ `clients.openWindow`。移り先は `data.url`（無いときは `tag` の先頭で決める：`chat` → `/`、`check:*` → `/check`、`takeover:*` → `/vm`）。`install` で `skipWaiting`、`activate` で `clients.claim`
3. 登録：`main.tsx` の描画後に `navigator.serviceWorker.register("/sw.js")`。ページ側は `navigator.serviceWorker` の `message` を受けて `navigate()` する（開いている窓を移すため）
4. 購読（`lib/push.ts`、設定の通知の欄）：状態を 6 つに分ける：未対応・iOS でホーム画面に追加していない（`navigator.standalone` が偽で iOS）・未許可・許可済みで購読あり・拒否済み・購読の失敗。[ この端末で通知を受ける ] は押した操作の中で `Notification.requestPermission()` → `GET /push/key`（API-137）→ `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` → `POST /push-subscriptions`（API-031）。[ 外す ] は `unsubscribe` と `DELETE /push-subscriptions/:id`（API-032）。購読の ID は `localStorage` に覚える。[ 試しに送る ] は API-031 の `?test=1`
5. 心拍（`lib/presence.ts`）：`visibilityState === "visible"` の間 30 秒ごとに `POST /presence { deviceId, visible: true }`、`visibilitychange` で隠れたら `visible: false`。タブを閉じるとき（`pagehide`）は `fetch(..., { keepalive: true })` で送る（`sendBeacon` はヘッダーを付けられないので使わない）。SSE がつながっていない間は心拍を送らない（本体は「SSE がつながっている」ことも見る：API-121）
6. iOS の案内：設定の通知の欄に、Safari の共有ボタン → 「ホーム画面に追加」→ そこから開く、の 3 行（iOS 16.4 以上）。Android・PC はそのまま許可できる
確かめ：実機の iPhone でホーム画面に追加して開き、通知を許可する → 「試しに送る」が届く（NFR-086 を 10 回測る）。画面を閉じたまま curl で `send_to_owner`（`notify = true`）を作らせると通知が届き、タップでチャットが開く。確認を作ると `/check?item=…` が、交代の頼みを作ると `/vm` が開く。PWA を前に出している間は通知が来ず、SSE の画面更新だけ。同じタスクの確認を続けて 3 つ作ると通知は 1 つにまとまる（`tag`）。購読を外すと届かない

### 6.7 スマホと幅 360px・本体が配るビルド
1. 幅 360px・44px 以上のボタン・○ と × は色だけでなく文字でも分ける（06）。`viewport.ts`（キーボードで入力欄が隠れない）を新しい `Chat.tsx` で効かせる。VM の画面の横向き。ダークモード（`color-scheme`）は今のまま
2. 端末の確かめ：iOS Safari（PWA）・Android Chrome・PC の Chrome / Edge / Firefox / Safari の最新 2 版（NFR-074）。ヘッドレスの Chromium で 360×780・390×844・1280×800 を撮る
3. ビルド：`pnpm --filter @open-team/web build` の出力を本体が配る（ステップ 3 の決めに従う。おすすめは `apps/web/dist` をイメージの `WEB_DIST`（ステップ 3 の既定 `/app/web`）にコピー）。配り方の決めはこのステップの「実装で決めること」に書いた
4. 本体を Compose で立て、tailnet の URL をスマホで開く → ブラウザの `Application` で manifest・Service Worker が有効。`/api/*` が 404 のときは JSON のエラーを返す（`index.html` を返さない）
5. 6.2〜6.6 の確かめを、Compose の本物の構成（ScriptedLlm と偽の box-manager、または実の VM）で通しで 1 回やる。06 の画面ごとの要素を下の「終わる条件」の表で潰す
確かめ：Compose の本体をスマホで開き、頼む → 確認 → 画面を見て → タップで交代 → 返す、まで 1 回通る。PWA を更新したあと（`sw.js` の変更）古い画面が残らない

## 終わる条件
| ID | 確かめること | 方法（コマンド・操作） | 設計の参照 |
|---|---|---|---|
| S6-01 | SCR-020：メッセージ（持ち主・メイン・`system`）・`text`/`file`/`choices`・タスクの帯・確認の件数・「考えています…」・空の例 3 つ・再送・上限で止まったときの設定へのリンクが出る | 6.2 の確かめ。360px と 1280px のスクショ | 06 SCR-020、FR-093、D-322 |
| S6-02 | SCR-021：タイトル・状態・`brief`・歩み・ブラウザの欄・ターミナルの欄・オートレビュー・報告が出て、言い直す・止める・画面を見るが動く | 6.3 の確かめ | 06 SCR-021、FR-089、API-123・124・016 |
| S6-03 | SCR-019：ブラウザの確認（スクショ＋印＋押すもの＋理由）・交代の頼み・API の書き込み・ルーチンの提案の 4 種類。○ / × と `page_changed`・`expired`・`unknown_outcome` の文 | 6.3 と `qa/` の架空データ | 06 SCR-019、FR-077、D-307 |
| S6-04 | SCR-022：見る・代わる・返す・VM を止める・5 つの状態・交代の頼みの帯・スマホはタップとボタンまで | 6.4 の確かめ。実機で | 06 SCR-022、FR-078、D-181 |
| S6-05 | SCR-014：メインの行が先頭で消せない。`description` を直せる。パック名とメインが作成の札 | 画面とエージェントの作成・削除 | 06 SCR-014、US-052 |
| S6-06 | SCR-010：「きっかけ」「オートレビュー」「VM」で絞れる | 画面の絞り込み | 06 SCR-010、UC-051 |
| S6-07 | SCR-023：上限・こわい操作・通知・つながり・VM・ホストの 6 つの欄。VM の欄の確かめのダイアログ・`broken`・4GB 超・無効化（VM の欄は骨と `qa/` の架空データで見る。API-133〜135・138 の実 API での確かめはステップ 7） | 6.5 の確かめ | 06 SCR-023、US-056・071 |
| S6-08 | SCR-024：入っている / 入れられる・入れる・外す・更新の確かめ（API-114〜116 はステップ 7。ここは骨と `qa/` の架空データで見て、実 API での確かめはステップ 7） | `qa/` の画面（実 API での標準パックの入れ外しはステップ 7） | 06 SCR-024、US-060 |
| S6-09 | SCR-025：プロフィール・数と字数・検索・直す・消す・足す | 記憶の画面と API | 06 SCR-025、US-067 |
| S6-10 | SCR-026：ルーチン・予約・受け口の 3 つのタブ。受け口の URL と秘密は 1 度だけ。Funnel が使えないときの案内 | 6.5 の確かめ | 06 SCR-026、US-064〜066 |
| S6-11 | 受け入れ条件（画面で確かめるもの）：US-050（403 の画面。443 番はつながらない）、US-051（頼む・チャットに途中経過が流れない）、US-054・055（確認の ○ × と見る・代わる・返す）、US-068（言い直し）、US-070（許可 → 試しの通知 → タップで開く → 前に出ている間は来ない → まとまる）、US-071（控えの一覧・戻す・作り直す） | 各 US の Given/When/Then を順に | [02](../design/02_user_stories.md) |
| S6-12 | 合図を落としても追いつく：SSE を切る（本体を止める・`reset` を流す・開発者ツールで接続を切る）と、つなぎ直しで全画面が取り直されて最新になる。通し番号が飛んだら全部取り直す | 本体を再起動し、その間にメッセージとタスクを増やして画面が追いつくのを見る | D-196、API-085 |
| S6-13 | CSRF：GET 以外のすべての要求に `X-Makase-Request: 1` が付く。付けない要求は 403 `CSRF_REJECTED` | 開発者ツールで POST を見る。`curl` で付けずに打つと 403 | FR-073、NFR-065 |
| S6-14 | NFR-069：交代中に文字を打ち、画面に出るまで 1 秒以内 | PC で交代し、文字を 10 回打って目で測る（画面録画のコマ数で測ってもよい） | NFR-069、[05 の測り方](../design/05_non_functional.md) |
| S6-15 | NFR-074：iOS Safari（PWA）・Android Chrome・PC の最新 2 版で、360px から頼む・見る・確認する・タップできる | 実機とスクショ。結果を 05 の NFR-074 の横に書く | NFR-074 |
| S6-16 | NFR-086：`send_to_owner`・確認・交代の頼みから Web Push の送信まで 5 秒以内。端末に届くまでを目安として測る | 設定の「試しに送る」を 10 回、端末に届くまで目で測る | NFR-086、FR-017 |
| S6-17 | `pnpm --filter @open-team/web typecheck / test / build` が緑。消した画面への参照が残っていない | コマンド | — |

## 実装で決めること
| 論点 | 設計の言い分 | おすすめ | 決めたら書く先 |
|---|---|---|---|
| noVNC の入れ方 | 画面の配信は noVNC（画面の側）＋x11vnc（07）。入れ方は書いていない | npm の `@novnc/novnc` を版固定で入れて `RFB` を使う（同梱はしない）。ビルドの `target` が合うか（トップレベルの `await`）を最初に 1 回確かめる | 00 の決定事項ログ（D-xxx）、`package.json` |
| Service Worker のビルド | PWA・Service Worker（07・11） | 手書きの `public/sw.js` をそのまま配る（キャッシュしないので vite のプラグインは要らない）。`sw.js` を TypeScript にしたくなったら `vite-plugin-pwa` を検討 | 06 §SW、`apps/web/public` |
| 通知のタップで開く経路 | タップで開く画面はチャット・確認・VM の画面（FR-017） | 通知の `data.url` を第一にし、無いときは `tag` の先頭で決める。開いている窓があれば `focus` と `postMessage` で `navigate()`。ステップ 5 の送り手が `data.url` を載せるかを揃える | FR-017 の表、ステップ 5 |
| スマホのタップ操作を VNC のクリックに写す方法 | スマホはタップ＝クリック。文字入力は PC だけ（D-181） | まず noVNC のタッチの扱い（1 本指のタップを左クリックにする）をそのまま使い、座標のずれが出たら画面の座標を自分で変換して `RFB` に送る。拡大中のタップの座標が合うか、横向きで合うかを実機で見る | D-181 の横に実測 |
| 状態管理 | 画面は REST で取り直す（D-196）。ライブラリの指定は無い | 今の作りを続ける：ライブラリは足さず、`WorkspaceProvider` の `subscribe` と `useSignal(types, refetch)` だけ。畳み込みは無し | `workspace.tsx` の先頭コメント |
| ビルドの配り方（本体の静的配信のパスとキャッシュ） | 本体が `apps/web` のビルドを配る（07） | `index.html` と `sw.js` と `manifest.webmanifest` は `Cache-Control: no-cache`、`/assets/*`（ハッシュつき）は `immutable` の 1 年。`/api/*` 以外で見つからない経路は `index.html`（SPA）。`/api/*` は JSON の 404。`sw.js` は `Service-Worker-Allowed: /` | ステップ 3、11 の配り方 |
| 画面の CSP | 設計には書いていない（今の `index.html` は `style-src 'self'` を前提にしている） | `default-src 'self'`・`connect-src 'self'`（WebSocket と SSE は同じ出どころ）・`worker-src 'self'`・`img-src 'self' data:`・`style-src 'self'`（`style` 属性を使わない）。成果物のプレビューは API-112 の CSP のまま | ステップ 3 の配信、07 |
| SSE の再接続で `Last-Event-ID` を送る | つなぎ直すときは `Last-Event-ID`（09）。標準の `EventSource` は新しく作るとヘッダーを付けられない | 今の `lastEventId` のクエリを残し、本体は両方を受ける（ステップ 3 の SSE に頼む） | 09 §API-085 |
| 開発時の身元ヘッダー | 認証は Tailscale の身元（FR-073） | ステップ 3 の dev の決めに従う。おすすめは vite の中継が `Tailscale-User-Login: <OWNER_LOGIN>` を付ける（開発だけ） | `vite.config.ts`、docs/development.md |
| ○ のあとの取り消しの猶予（`lib/undo.ts`） | 06 に無い。ブラウザの確認は ○ で実行直前の確かめに入る | ブラウザの確認・交代には付けない。API の書き込み・ルーチンの提案にも付けず、押したらすぐ送る | 06 SCR-019 |
| `PackWorkspace`（`/packs/:packId`）を残すか | 06 の遷移図に無い。SCR-024 は「今のまま」 | 消す。パックの中身を見る画面が欲しくなったら一覧の行を開く形で足す | 06 SCR-024 |
| 心拍を送る条件 | 前に出ている間 30 秒ごと・隠れたら送る（API-121） | `visible` かつ SSE がつながっている間。`pagehide` では `keepalive` の `fetch` | API-121 |
| 確かめ用の画面（`qa/`）の残し方 | 今の `qa/team-activity` と同じ型 | `qa/` に SCR-019・021・022 の状態を架空データで並べる画面を置く。本番のビルドには入れない | `apps/web/qa` |
| 画面の確かめに使う本体のデータの作り方 | — | ScriptedLlm のケース（ステップ 4）と curl。足りない状態（期限切れなど）は `qa/` の架空データ | `apps/web/qa` |

## 設計に戻すこと
- 画面を足した・経路を変えたら、06 の画面一覧と全体図の表に行を足す。`/settings#limits` のようなアンカーを使ったら 06 SCR-023 に書く
- 通知のタップ先（`data.url` の形）を決めたら、FR-017 の「タップで開く画面」の表に書く
- 設定の VM の欄・ホストの欄で API-088・111 の欄が足りなければ、09 の応答の例に足す
- 実測（NFR-069・074・086）は 05 の各 NFR の横に「実測」として書く。noVNC の入れ方・Service Worker・配り方は 00 の決定事項ログに D-xxx

## 参照
- 設計：[06](../design/06_ux_design.md)、[09](../design/09_api/README.md)・[resident](../design/09_api/resident.md)・[vm](../design/09_api/vm.md)、[FR-017・093・089](../design/04_functional_spec/resident.md)、[FR-077・078・100・079](../design/04_functional_spec/vm.md)、[FR-073・083・085](../design/04_functional_spec/tools.md)、[03 の UC-043・044・047・048・051・058](../design/03_use_cases.md)、[02 の US](../design/02_user_stories.md)、[05 の NFR-065・069・074・086](../design/05_non_functional.md)、[00 決定事項ログ](../design/00_overview.md#決定事項ログ)（D-181・196・197・229・243・307・322）、[ADR-067](../design/adr/ADR-067-web-push-first.md)
- 移す元（実際に開いた）：`apps/web/src/main.tsx`・`api.ts`・`workspace.tsx`・`lib/router.ts`・`lib/sse.ts`・`screens/Chat.tsx`・`AskPage.tsx`・`Check.tsx`・`components/CheckSheet.tsx`・`CheckRow.tsx`・`Notices.tsx`、`apps/web/vite.config.ts`・`index.html`・`qa/team-activity.tsx`、[docs/ui-design.md](../ui-design.md)、[docs/development.md](../development.md)
- 前後のステップ：[ステップ 3](03_core_port.md)・[4](04_resident.md)・[5](05_triggers.md)・[7](07_terminal_pack_snapshot.md)
