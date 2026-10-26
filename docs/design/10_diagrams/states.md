# 10. 図：状態遷移図
- プロジェクト：Agent-Team-Open ／ 版数：v1.5（2026-10-25） ／ 親：[10 図](README.md)

> **3行で**
> 1. `wakes.status` は `queued`・`consumed`・`dropped` の 3 つ。`turns.status` の `halted` には `context_exceeded`（入力が 20 万トークン超）がある。
> 2. `boxes.status`・`boxes.control`・`takeovers.status`・`browser_checks.status`・`sandbox_commands.status` は、VM（`box-browser` と `box-shell` の 2 コンテナの組）が眠って起きる形で描いた。
> 3. 値の意味は [04 ステータス定義](../04_functional_spec/README.md#ステータス定義)。`workspace.vm_op` と `workspace.vm_home_state`（`ok`・`broken` の 2 状態）も描いた。

---

### wakes.status
```mermaid
stateDiagram-v2
 [*] --> queued : 受付（source_key が重複なら行を作らない。webhook が 1 分 60 件を超えたら 429 で行を作らない）
 queued --> consumed : ターン・タスクに渡した
 consumed --> queued : 副作用未発生を証明できる失敗だけ（2 回まで）
 consumed --> dropped : 副作用なしの3回目の失敗（retry_exceeded）
 queued --> dropped : 日次の上限（ルーチン・予約・webhook だけ）・行き先がない
 consumed --> [*]
 dropped --> [*]
```

### turns.status
```mermaid
stateDiagram-v2
 [*] --> running : きっかけ
 running --> running : 歩む（動いている間に来たきっかけは queued のまま）
 running --> done : 道具を呼ばずに終わった・記憶を更新した
 running --> halted : $1・40 歩・10 分・日次（daily_budget_exceeded）・入力が 20 万トークン超（context_exceeded）
  running --> failed : LLM の失敗（3 回）。副作用確定/不明なら元wakeはconsumed維持・停止通知
 done --> [*] : 眠る
 halted --> [*]
 failed --> [*]
```

### 画面の番（boxes.screen_task_id）
```mermaid
stateDiagram-v2
 [*] --> 空き
 空き --> 使用中 : タスクが画面の道具を使う（条件つきの UPDATE。screen_epoch +1）
 使用中 --> 空き : タスクの終わり・取り消し・通常の実行中に 3 分使わない
 使用中 --> 空き : VM が止まった・控えに戻す・作り直す・本体の再起動
 使用中 --> 使用中 : 交代（control が human の間も番はそのまま）
```

### scheduled_wakes.status
```mermaid
stateDiagram-v2
 [*] --> pending : schedule_wake
 pending --> fired : 時刻になった（wakes に scheduled）
 pending --> cancelled : 持ち主が消した
 fired --> [*]
 cancelled --> [*]
```

### routine_proposals.status
```mermaid
stateDiagram-v2
 [*] --> pending : propose_routine
 pending --> approved : ○（API-142）→ routines に行
 pending --> rejected : ×
 pending --> expired : 7 日
 approved --> [*]
 rejected --> [*]
 expired --> [*]
```

### boxes.status
```mermaid
stateDiagram-v2
 [*] --> starting
 starting --> running : box-browser と box-shell が応答
 starting --> failed : 60秒応答なし・どちらかのコンテナが落ちた・本体の再起動（host_restart）
 running --> stopping : 10分使わない・持ち主・控えを取る（snapshot）・控えに戻す・作り直す・本体の再起動で違う世代
 running --> stopping : box-manager が止めた（disk_quota・disk_low）
 stopping --> stopped : 止まった（本体の再起動のあとも止め切る）
 running --> failed : どちらかのコンテナが落ちた
 stopped --> [*] : 眠った（次に使うときは新しい世代）
 failed --> [*]
```

### boxes.control
```mermaid
stateDiagram-v2
 [*] --> agent
 agent --> handing_over : API-090
 handing_over --> human : 動いている操作が終わった
 human --> agent : API-091
```

### takeovers.status
```mermaid
stateDiagram-v2
 [*] --> requested : request_takeover
 [*] --> active : 持ち主が自分から代わる
 requested --> active : API-090
 requested --> expired : 30分（タスクは blocked で閉じる）・再起動
 active --> ended : API-091
 active --> expired : 15分操作なし（タスクは blocked で閉じる。VM は止めない）・再起動
 ended --> [*]
 expired --> [*]
```

### browser_checks.status
```mermaid
stateDiagram-v2
 [*] --> pending
 pending --> executing : ○（API-110）
 pending --> rejected : ×
 pending --> expired : 30分・交代・VM の起こし直し・本体の再起動・取り消し（task_cancelled）・画面の番を失った・控えに戻す（vm_replaced）・○ の直前の確かめに外れた
 executing --> executed : 実行した
 executing --> expired : 中身が違う（page_changed）
 executing --> unknown_outcome : 答えがない・再起動
 executed --> [*]
 rejected --> [*]
 expired --> [*]
 unknown_outcome --> [*]
```

### sandbox_commands.status
```mermaid
stateDiagram-v2
 [*] --> queued
 queued --> running : shell-agent が受けた
 queued --> expired : 世代が替わった・控えに戻す
 running --> done : 終わった（ok・exit_code）
 running --> expired : タイムアウト・世代が止まった・本体の再起動
 done --> [*]
 expired --> [*]
```

### workspace.vm_op
VM の操作は 1 つずつ（D-251）。失敗・打ち切りの道は D-294・D-295。時間の上限は `vm_op_started_at` から数える。
```mermaid
stateDiagram-v2
 [*] --> none
 none --> starting : タスクが VM の道具を使う
 starting --> none : running になった・60 秒応答なし（failed）・2 分を超えた
 none --> stopping : 10 分使わない・持ち主が止めた
 stopping --> none : 止まった・2 分を超えた（世代を failed）
 none --> snapshotting : 毎日の控え・今すぐ（VM を止めてから）
 snapshotting --> none : 書き終えた（ready）・失敗（failed。古い控えは残す）・30 分を超えて打ち切った
 none --> restoring : API-134（VM を使ったタスクを halted）
  none --> rebuilding : API-135（同じ）
  none --> clearing_browser : API-138（番/交代なし・ok・条件付き取得）
  clearing_browser --> none : 結果DB確定とACK完了（失敗/30分打切りはbroken）
  restoring --> none : 結果DB確定とACK完了（vm_home_state = ok）
  rebuilding --> none : 結果DB確定とACK完了（vm_home_state = ok）
  restoring --> none : 失敗/打切りのDB確定とACK完了（broken）
  rebuilding --> none : 失敗/打切りのDB確定とACK完了（broken）
 note right of restoring
  本体の再起動では box-manager に聞く（API-108 の GET）。
  動いていれば待ち、box-manager も落ちていれば印ファイルから最初からやり直す。
  打ち切りに答えがなければ vm_op はそのまま（持ち主に知らせる）
 end note
 note right of snapshotting
  本体の再起動では API-143 の GET で聞き直す。
  starting は世代を止めて none、stopping は止め切って none
 end note
```

### workspace.vm_home_state
```mermaid
stateDiagram-v2
 [*] --> ok
  ok --> broken : 戻し・作り直し・消去に失敗した・打ち切った
 broken --> ok : 戻し・作り直しが終わった
```
`broken` の間は戻す・作り直すだけを受ける（FR-100）。ホームが 4GB を超えたときは box-manager が VM を止め（`stop_reason = 'disk_quota'`）、超えている間はタスクのために VM を起こさない。持ち主はブラウザのデータを消す（FR-079）・控えに戻す・作り直す（FR-100）のどれかで戻す。
