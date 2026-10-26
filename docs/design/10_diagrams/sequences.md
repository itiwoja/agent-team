# 10. 図：シーケンス図
- プロジェクト：Agent-Team-Open ／ 版数：v1.5（2026-10-25） ／ 親：[10 図](README.md)

> **3行で**
> 1. きっかけからターン・振り分け・報告まで（UC-054・055）・webhook（UC-057）・ルーチンの提案（UC-056）・オートレビュー（UC-059）・要約（UC-060：ターンを始めるときの 1 経路）・VM が起きて眠る（UC-061：`box-browser` と `box-shell` の 2 コンテナ）の 6 本を描いた。
> 2. VM の 1 歩・確認・交代・ターミナル・再開は、画面の番と VM が残る形で描いた。再開（FR-084）は必ず新しい世代で起こし直す。控え（FR-100）は 2 つのボリュームを 1 つの tar にまとめる。
> 3. どの図も「SSE は合図だけで、中身は REST」の決まり（D-196）は省いて描いた。

---

### UC-054・055：きっかけからターン・振り分け・報告まで
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant W as 画面
 participant IN as 受付・ルーター
 participant T as メインのターン
 participant C as Claude API
 participant TK as タスク（振り分け先）
 participant P as Push
 O->>W: 「木曜 19 時の店を 3 つ探して」
 W->>IN: API-119（Idempotency-Key = messageId）
 IN->>IN: wakes（chat）・3 秒待ってまとめる
 IN->>T: ターンを始める
 T->>C: 先頭（キャッシュ）＋要約＋履歴＋きっかけ
 C-->>T: delegate(店探し係, brief)・send_to_owner「頼みました」
 T->>TK: tasks（queued → running）
 T-->>W: chat_messages（main）
 T->>T: 記憶の更新の歩み → done（眠る）
 Note over IN,T: ターンが動いている間に来た chat は queued のまま。ターンが終わったらすぐ次のターンを始める
 Note over TK: 新しい文脈で歩む（VM・Web）
 TK->>IN: report → wakes（task_done）
 IN->>T: ターンを始める
 T->>C: 報告（2,000 字）
 C-->>T: send_to_owner（choices・notify）
 T->>P: PWA が前に出ていなければ Web Push
 P-->>O: 「3 件見つかりました」
```

### UC-054 4a：メインの書き込みと承認
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant T as メインのターン
 participant G as gateway・Kernel
 participant IN as 受付
 T->>G: create_event（Intent：turn_id）
 G-->>T: 確認待ち（決まったら知らせる）
 T->>T: ターンを閉じて眠る
 G->>O: 確認カード・Web Push
 O->>G: ○（API-019）
 G->>G: 書く（予定の ID）
 G->>IN: wakes（approval_done・汚染しない）
 IN->>T: ターン
 T->>O: send_to_owner「木曜に入れました」
```

### UC-057：webhook で起きる
```mermaid
sequenceDiagram
 participant GH as GitHub
 participant TS as tailscale（Funnel）
 participant H as 本体 :8081
 participant IN as 受付・ルーター
 participant T as メインのターン
 GH->>TS: POST :8443/hooks/k3q7...（X-Hub-Signature-256。Funnel は 8443 番だけ）
 TS->>H: 8443 番は / ごと流す（:8081 は POST /hooks/:hookId 以外を 404。D-305）
 H->>H: 大きさ → 受け口 → HMAC → 1 分 60 件 → 重複（source_key の UNIQUE）
 alt 署名が合わない
  H-->>GH: 401（何も残さない）
 else 1 分 60 件を超えた
  H-->>GH: 429（何も残さない）
 else 通った
  H->>IN: wakes（webhook・source_key = webhook:hookId:X-GitHub-Delivery・tainted）
  H-->>GH: 202
  IN->>T: ターン（汚染から始まる）
  T->>T: 決まった欄の要約を読む → 必要なら delegate
 end
```

### UC-056：ルーチンの提案と承認
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant T as メインのターン
 participant W as 画面
 participant API as 本体（API）
 participant TM as タイマー
 participant IN as 受付
 T->>T: propose_routine（週次の PR のまとめ）
 T->>W: routine_proposals（pending・7 日）・Web Push
 O->>W: ○
 W->>API: API-142 approve
 API->>API: routines（created_by = main・next_run_at）（メインは起こさない）
 Note over TM: 毎分
 TM->>IN: next_run_at を過ぎた → wakes（routine）
 TM->>TM: next_run_at を計算し直す
```

### UC-059：オートレビュー
```mermaid
sequenceDiagram
 participant CU as computer（本体）
 participant K as Kernel
 participant AR as オートレビュー（Claude）
 participant BM as box-manager
 participant W as 画面
 CU->>K: judgeBrowserAction（name「次へ」）
 K-->>CU: approve（T-3 の confirm_words → オートレビュー）
 CU->>CU: browser_actions（reviewed）・auto_reviews
 CU->>AR: brief・操作・確かめた中身・印つきスクショ（会話は渡さない）
 alt pass
  AR-->>CU: pass「検索条件の確定。外に出ない」
  CU->>CU: 直前の確かめ（D-307。外れたら実行せず Claude に返す）
  CU->>BM: API-103 実行（expect: contentHash）
 else stop・20 秒
  AR-->>CU: stop「人数の欄が空のまま」
  CU->>W: browser_checks（pending・review_reason）→ UC-047
 end
```

### UC-060：ターンを始めるときに要約する
```mermaid
sequenceDiagram
 participant IN as 受付・ルーター
 participant CTX as context
 participant C as Claude API
 participant DB as SQLite
 Note over IN: ターンを始めるとき（turns の行を作る前）。メインの履歴（⑥）が 6 万トークン超
 IN->>CTX: 要約して
 CTX->>C: 同じ先頭と履歴＋「ここまでを要約して」（外から来た内容の枠の中の指示は写さない）
 alt 要約できた
  C-->>CTX: 要約
  CTX->>DB: context_snapshots（新しい先頭：①〜④＋要約・parts_hash）、usage_records（phase = summary・turn_id = NULL）
  Note over CTX: 履歴は持ち越さない（思考のブロックを残すと 400）
  IN->>IN: 新しい先頭でターンを始める（要約の間に来たきっかけも同じターンに入れる）
 else 失敗した
  IN->>IN: 要約せずにそのままターンを始める。次の機会にやり直す
 end
```

### UC-061：VM が起きて眠る
```mermaid
sequenceDiagram
 participant TK as タスク
 participant CU as computer（本体）
 participant BM as box-manager
 participant BR as box-browser（box-agent）
 participant SH as box-shell（shell-agent）
 participant TM as タイマー
 TK->>CU: read_page（VM が止まっている）
 CU->>CU: vm_op が none・vm_home_state が ok・空き 3GB 以上を確かめる
 CU->>CU: 1 つのトランザクションで vm_op = starting・boxes（starting・新しい世代）。ほかのタスクは waiting_vm
 CU->>BM: API-101（boxId）
 BM->>BR: box-browser を起こす（makase-browser-profile をつなぐ。Chromium 用の seccomp を付ける。使えないホストは --no-sandbox）
 BM->>SH: box-shell を起こす（makase-vm-home をつなぐ）
 BR-->>CU: 2 つとも応答 → running、vm_op = none
 CU->>CU: 画面の番を取る（screen_epoch +1）
 loop 毎分
  BM->>BM: ホームの大きさ・ホストの空きを測る（D-309）
  TM->>BM: API-109 で読む（4GB 超え・3GB 未満なら box-manager が止めている）
 end
 Note over TM: 毎分。10 分使わず、番・交代・コマンドがない
 TM->>CU: vm_op = stopping（stop_reason = idle）
 TM->>BM: API-102 止める（ホームは残す）
 TM->>CU: boxes（stopped）、vm_op = none
 Note over TM: 毎日 4:00（止まっていれば）→ FR-100 の図
```

### UC-046：VM で操作する1歩
1 歩＝1 つの返事の操作の列（D-255）。実行の前に毎回、本体が直前の確かめをする（D-307）。
```mermaid
sequenceDiagram
 participant R as 実行役（本体）
 participant C as Claude API
 participant CU as computer（本体）
 participant K as Kernel
 participant BM as box-manager
 participant B as box-agent（box-browser）
 R->>R: 画面の番を取る（boxes.screen_task_id。取れなければ waiting_screen。取ったら screen_epoch +1）
 R->>R: task_steps に started（費用を予約）。今の screen_epoch を覚える
 R->>C: messages（スクショつき）
 C-->>R: tool_use の列：left_click(812,604)・type("2名")・key(Enter)
  R->>R: 保存前秘密検査。安全なcontentのみdone保存（拒否時はFR-075で会話終了）
 loop 列の操作を並んだ順に
  R->>CU: 実行して
  CU->>CU: 直前の確かめ（タスク・世代・番・screen_epoch が覚えた値と同じ・control = agent・vm_op）
  alt 外れた
   CU-->>R: 実行しない（残りも実行しない）。番を取り直して新しいスクショだけを返す
  else 見るだけの操作
   CU->>BM: API-103 実行
  else 変える操作
   CU->>BM: API-103 dryRun（actionId・controlEpoch）
   BM->>B: 確かめ
   B-->>CU: inspect（button「次へ」・form.method・editable・contentHash）
   CU->>K: judgeBrowserAction
   alt allow
    K-->>CU: allow
    CU->>BM: API-103 実行（expect: contentHash）
    BM->>B: 同じなら xdotool
    B-->>CU: executed・スクショ
   else approve
    K-->>CU: approve（行き先：人 → UC-047・オートレビュー → UC-059）
    CU-->>R: 列はここで止める。残りは「前の操作の確認を待っているので実行していない」
   end
  end
 end
 CU-->>R: 列のすべての操作に tool_result（browser_actions に記録）
 R->>C: 次の 1 つの user のメッセージで返す
```

### UC-047：こわい操作の確認
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant W as 画面
 participant CU as computer（本体）
 participant K as Kernel
 participant BM as box-manager
 participant C as Claude API
 CU->>K: judgeBrowserAction（name「購入する」）
 K-->>CU: approve（T-3 の human_words → 行き先は人）
 CU->>CU: browser_checks（pending・30分・contentHash）、tasks は awaiting_approval
 CU-->>W: SSE の合図・Web Push
 O->>W: ○
 W->>CU: API-110 approve
 CU->>CU: 1 つのトランザクションで直前の確かめ（タスクが awaiting_approval・世代・番・確認の screen_epoch・control・vm_op。D-307）
 alt 直前の確かめに外れた
  CU->>CU: pending → expired（task_cancelled・box_restarted・screen_lost・taken_over・vm_replaced）
  CU-->>W: expired（理由）
  CU->>C: タスクが動いていれば、理由と新しいスクショ
 else 通った
  CU->>CU: pending → executing（条件つきの更新。取れなければ 409）
  CU->>BM: API-103 実行（actionId・expect: contentHash）
  alt 中身が同じ
   BM-->>CU: executed
   CU-->>W: executed
  else 中身が違う
   BM-->>CU: 409 CONTENT_CHANGED
   CU->>CU: 確認を expired（page_changed）。新しい確認は作らない
   CU->>C: 新しいスクショで「画面が変わったので実行しなかった」
   CU-->>W: page_changed
  else 答えがない
   CU->>CU: unknown_outcome、Claude に「分からない」
   CU-->>W: unknown_outcome
  end
 end
```

### UC-048：交代
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant W as 画面（noVNC）
 participant CORE as 本体
 participant BM as box-manager
 participant C as Claude API
 C-->>CORE: request_takeover「ログインしてください」
 CORE-->>W: 交代の頼み（SSE の知らせ）
 O->>W: 手を貸す
 W->>CORE: API-090 takeover
 CORE->>CORE: control = handing_over、epoch +1
 CORE->>BM: API-113 control=handing_over（epoch）
 CORE->>C: 動いている呼び出しを中止（返った操作は捨てる）
 CORE->>CORE: llm の歩みを done（aborted）、費用を精算
 CORE->>CORE: この VM の pending の確認を expired（taken_over）
 CORE->>BM: 動いている操作の終わりを待つ
 CORE->>CORE: control = human
 CORE->>BM: API-113 control=human（epoch）
 CORE-->>W: 200
 W->>CORE: API-089 screen?mode=control
 CORE->>BM: API-106 vnc
 O->>W: ログインする
 O->>W: 返す
 W->>CORE: API-091 handback
 CORE->>CORE: control = agent、epoch +1
 CORE->>BM: API-113 control=agent（epoch）
 CORE->>BM: API-105 screenshot
 CORE->>C: 「人が操作した」＋スクショ
```

### UC-053：VM のターミナル
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant R as 実行役（本体）
 participant G as gateway
 participant BM as box-manager
 participant B as shell-agent（box-shell）
 participant C as Claude API
 participant K as Kernel
 participant W as 画面
 R->>G: リポジトリを頼む
 G->>G: GitHub から tar を取る
 G->>BM: API-118 PUT files（tar）
 BM->>B: VM に展開
 C-->>R: tool_use run_command(npm test)
 R->>BM: API-117 commands（actionId・timeoutSec。世代だけを確かめ、交代中も動く：D-296）
 BM->>B: 実行（VM の中なので判定しない）
 Note over B: box-shell から外への通信は、egress が送り元のコンテナで見分けて terminal.allow_hosts の許可リストだけを通す
 B-->>R: ok・exitCode・output（64KB まで・汚染）
 R->>C: 出力を渡す（外の内容として扱う）
 Note over C,R: run_command・write_file を繰り返す（最大 200 回）
 R->>BM: API-118 GET files（tar）
 BM-->>R: 変更後の tar（利用者 agent が作る。リンクはたどらない）
 R->>R: 広げるときにリンク・絶対パス・.. を捨てる（D-306）
 R->>R: 差分にして Intent に乗せる
 R->>K: 判定（書き込みなので確認）
 K-->>R: approve
 R-->>W: 確認カード
 O->>W: ○
 W->>R: API-019 decision
 R->>G: PR を作る
 G-->>R: PR の URL
```

### FR-084：再起動からの再開
本体の再起動では、止まっていない世代を必ず止め、次に使うときに新しい世代で起こし直す。
```mermaid
sequenceDiagram
 participant CORE as 本体（起動）
 participant DB as SQLite
 participant BM as box-manager
 CORE->>DB: 終わっていないきっかけ・ターン・タスク・確認・交代・オートレビュー
 alt vm_op が restoring・rebuilding・snapshotting
  CORE->>BM: API-108・143 の GET
  BM-->>CORE: running（待つ）・done（片付ける）・failed（失敗の道）
 end
 CORE->>BM: 止まっていない世代を止めさせる（host_restart）
 CORE->>DB: boxes を failed（host_restart）、vm_op が starting・stopping なら none
 CORE->>DB: 画面の番を空に。pending の確認は expired（box_restarted）、executing は unknown_outcome
 CORE->>DB: 交代は expired、コマンドは expired、started のままの VM の操作は「実行されたか分からない」として Claude に伝える
 CORE->>DB: 表のほかの行を戻す（FR-084）
 CORE->>CORE: 過ぎたルーチンは 1 回だけ・過ぎた予約は動かす
 CORE->>CORE: running のターン・タスクを歩みの記録から続ける
 Note over CORE: 次に VM の道具を使うタスクが新しい世代で起こす。ホームは残っているのでファイルは入れ直さない。Claude には「VM を起こし直した。開いていたページは閉じた」と新しいスクショ
```

### FR-100：控えを取る・戻す
控えも戻しも box-manager が裏で動かし、本体は終わりを問い合わせる（D-294・D-295）。控えは控え専用のボリュームに書く（D-309）。
```mermaid
sequenceDiagram
 actor O as 持ち主
 participant W as 画面
 participant CORE as 本体
 participant TM as タイマー
 participant BM as box-manager
 Note over TM: 毎日 4:00。VM が止まっていて vm_op が none
 TM->>CORE: vm_op = snapshotting、vm_snapshots（creating）
 CORE->>BM: API-143 POST（snapshotId）
 BM->>BM: 空きが「2 つのボリュームの合計＋3GB」あるか（なければ 507 DISK_LOW）
 BM-->>CORE: 202
 BM->>BM: makase-browser-profile と makase-vm-home を 1 つの tar.zst（browser/ と home/）にして /snapshots に書く
 loop 5 秒ごと
  CORE->>BM: API-143 GET
 end
 BM-->>CORE: done（path・sizeBytes）
 CORE->>CORE: ready にして、4 つ目より古いものを deleted（ファイルも消す）、vm_op = none
 O->>W: この控えに戻す（ダイアログ「動いているタスク N 件が止まります」）
 W->>CORE: API-134（snapshotId）
 CORE->>CORE: 1 つのトランザクションで vm_op = restoring。VM を使ったタスクを halted（vm_replaced）、その確認を expired（vm_replaced）
 CORE->>BM: API-102 止める
 CORE->>BM: API-108 POST restore
 BM->>BM: 印ファイル（running）→ 2 つのボリュームを空にして控えを広げる
 BM-->>CORE: 202
 loop 5 秒ごと（30 分まで）
  CORE->>BM: API-108 GET
 end
 alt 終わった
   BM->>BM: 操作IDつきdoneを永続保持（ACKまで）
  BM-->>CORE: done
   CORE->>CORE: vm_home_state = ok・監査 vm.restored・ACK待ちを一括確定
   CORE->>BM: API-108 PATCH ACK（operationId）
   BM-->>CORE: 204（成功の印を削除。再送可）
   CORE->>CORE: vm_op = none・操作ID/ACK待ちを解放
 else 失敗した・打ち切った
  BM->>BM: 印ファイルを failed で残す
  BM-->>CORE: failed
   CORE->>CORE: broken・失敗監査・ACK待ちを一括確定
   CORE->>BM: API-108 PATCH ACK（brokenの印は保持）
   BM-->>CORE: 204
   CORE->>CORE: vm_op = none・操作ID/ACK待ちを解放
  CORE-->>O: 「ホームが壊れています。控えに戻すか作り直してください」
 end
 CORE-->>W: SSE vm.updated
```
