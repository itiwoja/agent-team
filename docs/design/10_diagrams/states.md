# 10. 図：状態遷移図
- プロジェクト：Agent-Team-Open ／ 版数：v1.2（2026-10-24） ／ 親：[10 図](README.md)

> **3行で**
> 1. v1.0 で足したのは `wakes.status`・`turns.status`・画面の番・`scheduled_wakes.status`・`routine_proposals.status` の 5 つ。
> 2. v0.6 の `boxes.status`・`boxes.control`・`takeovers.status`・`browser_checks.status`・`sandbox_commands.status` は、VM が眠って起きる形に直した。
> 3. 値の意味は [04 ステータス定義](../04_functional_spec/README.md#ステータス定義)。v1.2 で `workspace.vm_op` と `workspace.vm_home_state` を足した（D-294・D-295・D-301）。

---

### wakes.status
```mermaid
stateDiagram-v2
 [*] --> queued : 受付（source_key が重複なら行を作らない）
 [*] --> merged : 1 分の上限を超えた webhook（まとめに足す）
 queued --> attached : 動いているターンに結びつけた
 attached --> consumed : 次の歩みで渡した
 attached --> queued : ターンが halted・failed で閉じた・再起動
 queued --> consumed : ターン・タスクに渡した
 consumed --> queued : 失敗したターンから戻す（2 回まで）
 consumed --> dropped : 3 回目の失敗（retry_exceeded）
 queued --> dropped : 日次の上限（ルーチン・予約・webhook だけ）・行き先がない
 consumed --> [*]
 merged --> [*]
 dropped --> [*]
```

### turns.status
```mermaid
stateDiagram-v2
 [*] --> running : きっかけ
 running --> running : 歩む（持ち主のチャットは次の歩みの頭へ）
 running --> done : 道具を呼ばずに終わった・記憶を更新した
 running --> halted : $1・40 歩・10 分・日次
 running --> failed : LLM の失敗（3 回）
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
 starting --> running : box-agent が応答
 starting --> failed : 60秒応答なし・サンドボックスが使えない（sandbox_unavailable）・ホストへの入りが断られていない（isolation_missing）・本体の再起動（host_restart）
 running --> stopping : 10分使わない・持ち主・控えを取る（snapshot）・控えに戻す・作り直す・本体の再起動で違う世代
 running --> stopping : box-manager が止めた（disk_quota・disk_low）
 stopping --> stopped : 止まった（本体の再起動のあとも止め切る）
 running --> failed : 落ちた
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
 executing --> executed : 実行した（再起動のあと、同じ世代に問い合わせて分かったときも）
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
 queued --> running : box-agent が受けた
 queued --> expired : 世代が替わった・控えに戻す
 running --> done : 終わった（ok・exit_code。再起動のあと、同じ世代に問い合わせて分かったときも）
 running --> expired : タイムアウト・世代が止まった・問い合わせても分からない
 done --> [*]
 expired --> [*]
```

### workspace.vm_op
VM の操作は 1 つずつ（D-251）。失敗・打ち切りの道は D-294・D-295。時間の上限は `vm_op_started_at` から数える。
```mermaid
stateDiagram-v2
 [*] --> none
 none --> starting : タスクが VM の道具を使う・掃除のために起こす
 starting --> none : running になった・60 秒応答なし（failed）・2 分を超えた
 none --> stopping : 10 分使わない・持ち主が止めた
 stopping --> none : 止まった・2 分を超えた（世代を failed）
 none --> snapshotting : 毎日の控え・今すぐ（VM を止めてから）
 snapshotting --> none : 書き終えた（ready）・失敗（failed。古い控えは残す）・30 分を超えて打ち切った
 none --> restoring : API-134（VM を使ったタスクを halted）
 none --> rebuilding : API-135（同じ）
 restoring --> none : 終わった（vm_home_state = ok）
 rebuilding --> none : 終わった（vm_home_state = ok）
 restoring --> none : 失敗・30 分を超えて打ち切った（vm_home_state = broken）
 rebuilding --> none : 失敗・30 分を超えて打ち切った（vm_home_state = broken）
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
 ok --> over_quota : ホームが 4GB を超えた（box-manager が VM を止めた。disk_quota）
 over_quota --> ok : 掃除のための起動で消して 4GB を下回った・控えに戻した・作り直した
 ok --> broken : 戻し・作り直しに失敗した・打ち切った
 over_quota --> broken : 同じ
 broken --> ok : 戻し・作り直しが終わった
```
`over_quota` の間は掃除のための起動（`boxes.mode = 'cleanup'`。タスクは受けない）と戻す・作り直すだけ、`broken` の間は戻す・作り直すだけを受ける（FR-074・FR-100）。
