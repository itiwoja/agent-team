# 10. 図：シーケンス図
- プロジェクト：Agent-Team-Open ／ 版数：v1.1（2026-10-24） ／ 親：[10 図](README.md)

> **3行で**
> 1. v1.0 で足したのは 6 本：きっかけからターン・振り分け・報告まで（UC-054・055）・webhook（UC-057）・ルーチンの提案（UC-056）・オートレビュー（UC-059）・要約（UC-060）・VM が起きて眠る（UC-061）。
> 2. v0.6 の 5 本（VM の 1 歩・確認・交代・ターミナル・再開）は、画面の番と VM が残る形に直した。
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
 TS->>H: /hooks/ だけを流す
 H->>H: 大きさ → 受け口 → HMAC → 重複（配達 ID・本文） → 1 分 60 件（超えたらまとめに足す）
 alt 署名が合わない
  H-->>GH: 401（何も残さない）
 else 合う
  H->>IN: wakes（webhook・source_key = X-GitHub-Delivery・tainted）
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
 participant TM as タイマー
 participant IN as 受付
 T->>T: propose_routine（週次の PR のまとめ）
 T->>W: routine_proposals（pending・7 日）・Web Push
 O->>W: ○
 W->>T: API-142 approve
 T->>T: routines（created_by = main・next_run_at）
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
  CU->>BM: API-103 実行（expect: contentHash）
 else stop・20 秒
  AR-->>CU: stop「人数の欄が空のまま」
  CU->>W: browser_checks（pending・review_reason）→ UC-047
 end
```

### UC-060：留守の間に要約する
```mermaid
sequenceDiagram
 participant TM as タイマー
 participant CTX as context
 participant C as Claude API
 participant DB as SQLite
 Note over TM: 毎分。最後のターンから 10 分・⑥が 6 万トークン超
 TM->>CTX: 要約して
 CTX->>C: 同じ先頭と履歴（1 時間のキャッシュが温かい）＋「ここまでを要約して」
 C-->>CTX: 要約
 CTX->>DB: context_snapshots（新しい先頭：①〜④＋要約・parts_hash）
 Note over CTX: 次のターンから新しい先頭。履歴は持ち越さない（思考のブロックを残すと 400）
```

### UC-061：VM が起きて眠る
```mermaid
sequenceDiagram
 participant TK as タスク
 participant CU as computer（本体）
 participant BM as box-manager
 participant B as box-agent
 participant TM as タイマー
 TK->>CU: read_page（VM が止まっている）
 CU->>CU: boxes（starting・新しい世代）。ほかのタスクは waiting_vm
 CU->>BM: API-101（boxId）
 BM->>B: ホームのボリュームをつないで起こす
 B-->>CU: 応答 → running
 CU->>CU: 画面の番を取る
 Note over TM: 毎分。10 分使わず、番・交代・コマンドがない
 TM->>BM: API-102 止める（ホームは残す）
 TM->>CU: boxes（stopped・idle）
 Note over TM: 毎日 4:00（止まっていれば）
 TM->>BM: API-143 控えを取る（3 世代）
```

### UC-046：VM で操作する1歩
```mermaid
sequenceDiagram
 participant R as 実行役（本体）
 participant C as Claude API
 participant CU as computer（本体）
 participant K as Kernel
 participant BM as box-manager
 participant B as box-agent
 R->>R: 画面の番を取る（boxes.screen_task_id。取れなければ waiting_screen）
 R->>R: task_steps に started（費用を予約）
 R->>C: messages（スクショつき）
 C-->>R: tool_use left_click(812,604)
 R->>CU: 実行して
 CU->>BM: API-103 dryRun（actionId・controlEpoch）
 BM->>B: 確かめ
 B-->>CU: button「次へ」 example.jp・contentHash
 CU->>K: judgeBrowserAction
 K-->>CU: allow
 CU->>BM: API-103 実行（expect: contentHash）
 BM->>B: 同じなら xdotool
 B-->>CU: executed・スクショ
 CU-->>R: スクショ（browser_actions に allowed・executed）
 R->>R: task_steps に done（費用を精算）
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
 participant B as box-agent
 participant C as Claude API
 participant K as Kernel
 participant W as 画面
 R->>G: リポジトリを頼む
 G->>G: GitHub から tar を取る
 G->>BM: API-118 PUT files（tar）
 BM->>B: VM に展開
 C-->>R: tool_use run_command(npm test)
 R->>BM: API-117 commands（actionId・controlEpoch・timeoutSec）
 BM->>B: 実行（VM の中なので判定しない）
 B-->>R: ok・exitCode・output（64KB まで・汚染）
 R->>C: 出力を渡す（外の内容として扱う）
 Note over C,R: run_command・write_file を繰り返す（最大 200 回）
 R->>BM: API-118 GET files（tar）
 BM-->>R: 変更後の tar
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
```mermaid
sequenceDiagram
 participant CORE as 本体（起動）
 participant DB as SQLite
 participant BM as box-manager
 CORE->>DB: 終わっていないきっかけ・ターン・タスク・確認・交代・オートレビュー
 CORE->>DB: 表のとおりに戻す（FR-084）
 CORE->>BM: API-109 一覧
 CORE->>BM: 残っている VM の世代を止める（host_restart）。画面の番を空に
 CORE->>CORE: 過ぎたルーチンは 1 回だけ・過ぎた予約は動かす
 CORE->>CORE: running のターン・タスクを歩みの記録から続ける
 Note over CORE: VM は次に使うときに新しい世代で起きる（ホームは残っている）
```

